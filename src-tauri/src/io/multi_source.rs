// ui/src-tauri/src/io/multi_source.rs
//
// Multi-source reader that combines frames from multiple IO devices.
// Used for multi-bus capture where frames from diverse sources are merged.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use tauri::AppHandle;
use tokio::sync::mpsc;

use super::gvret_common::{emit_stream_ended, encode_gvret_frame, validate_gvret_frame, BusMapping};
use super::slcan::encode_transmit_frame as encode_slcan_frame;
#[cfg(target_os = "linux")]
use super::socketcan::{encode_frame as encode_socketcan_frame, EncodedFrame};
use super::traits::{get_traits_for_profile_kind, validate_session_traits};
use super::types::{SourceMessage, TransmitRequest, TransmitSender};
use super::{
    emit_frames, emit_to_session, CanTransmitFrame, FrameMessage, IOCapabilities, IODevice,
    IOState, InterfaceTraits, Protocol, TemporalMode, TransmitResult,
};
use crate::buffer_store::{self, BufferType, TimestampedByte};
use crate::serial_framer::{FrameIdConfig, FramingEncoding};

// Import interface-specific source runners
use super::gvret_tcp::run_source as run_gvret_tcp_source;
use super::gvret_usb::run_source as run_gvret_usb_source;
use super::serial::{run_source as run_serial_source, SerialRawBytesPayload};
use super::slcan::run_source as run_slcan_source;
#[cfg(target_os = "linux")]
use super::socketcan::run_source as run_socketcan_source;

#[cfg(any(target_os = "windows", target_os = "macos"))]
use super::gs_usb::{encode_frame as encode_gs_usb_frame, run_source as run_gs_usb_source};

// ============================================================================
// Types
// ============================================================================

/// Configuration for a single source in a multi-source session
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SourceConfig {
    /// Profile ID for this source
    pub profile_id: String,
    /// Profile kind (gvret_tcp, gvret_usb, gs_usb, socketcan, slcan, serial)
    pub profile_kind: String,
    /// Display name for this source
    pub display_name: String,
    /// Bus mappings for this source (device bus -> output bus)
    pub bus_mappings: Vec<BusMapping>,
    /// Framing encoding for serial sources (overrides profile settings if provided)
    #[serde(default)]
    pub framing_encoding: Option<String>,
    /// Delimiter bytes for delimiter-based framing
    #[serde(default)]
    pub delimiter: Option<Vec<u8>>,
    /// Maximum frame length for delimiter-based framing
    #[serde(default)]
    pub max_frame_length: Option<usize>,
    /// Minimum frame length - frames shorter than this are discarded
    #[serde(default)]
    pub min_frame_length: Option<usize>,
    /// Whether to emit raw bytes in addition to framed data
    #[serde(default)]
    pub emit_raw_bytes: Option<bool>,
}

// ============================================================================
// Multi-Source Reader
// ============================================================================

/// Transmit routing info: maps output bus to source and device bus
#[derive(Clone, Debug)]
struct TransmitRoute {
    /// Source index in the sources array
    source_idx: usize,
    /// Profile ID for logging
    profile_id: String,
    /// Profile kind for frame encoding (gvret_tcp, gvret_usb, gs_usb, socketcan, slcan)
    profile_kind: String,
    /// Device bus number to use when transmitting
    device_bus: u8,
}

/// Shared transmit channels by source index
type TransmitChannels = Arc<Mutex<HashMap<usize, TransmitSender>>>;

/// Reader that combines frames from multiple IO devices
pub struct MultiSourceReader {
    app: AppHandle,
    session_id: String,
    sources: Vec<SourceConfig>,
    state: IOState,
    stop_flag: Arc<AtomicBool>,
    /// Handles to sub-reader tasks
    task_handles: Vec<tokio::task::JoinHandle<()>>,
    /// Channel to receive messages from sub-readers
    rx: Option<mpsc::Receiver<SourceMessage>>,
    /// Sender for sub-readers to send messages (kept for cloning)
    tx: mpsc::Sender<SourceMessage>,
    /// Mapping from output bus number to transmit route (source_idx, device_bus)
    transmit_routes: HashMap<u8, TransmitRoute>,
    /// Transmit channels by source index (populated when sources connect)
    transmit_channels: TransmitChannels,
    /// Derived session traits from all interfaces
    session_traits: InterfaceTraits,
    /// Whether this session emits raw bytes (for serial sources without framing)
    emits_raw_bytes: bool,
}

impl MultiSourceReader {
    /// Create a multi-source reader with exactly one source.
    /// This is the preferred way to create sessions for real-time devices,
    /// as it uses the same code path as multi-device sessions.
    pub fn single_source(app: AppHandle, session_id: String, source: SourceConfig) -> Result<Self, String> {
        Self::new(app, session_id, vec![source])
    }

    /// Create a new multi-source reader
    ///
    /// Validates that all interfaces have compatible traits:
    /// - All interfaces must have the same temporal mode
    /// - Timeline sessions are limited to 1 interface
    /// - Protocols must be compatible (CAN + CAN-FD OK, but not CAN + Serial)
    pub fn new(app: AppHandle, session_id: String, sources: Vec<SourceConfig>) -> Result<Self, String> {
        // Collect traits from all enabled interfaces across all sources
        let interface_traits: Vec<InterfaceTraits> = sources
            .iter()
            .flat_map(|source| {
                source.bus_mappings.iter()
                    .filter(|m| m.enabled)
                    .filter_map(|m| {
                        // Use interface-level traits if available, fall back to profile-level
                        m.traits.clone().or_else(|| Some(get_traits_for_profile_kind(&source.profile_kind)))
                    })
            })
            .collect();

        let validation = validate_session_traits(&interface_traits);
        if !validation.valid {
            return Err(validation.error.unwrap_or_else(|| "Unknown validation error".to_string()));
        }

        let session_traits = validation.session_traits.unwrap();

        let (tx, rx) = mpsc::channel(1024);

        // Build transmit routing table: output_bus -> (source_idx, device_bus, kind)
        let mut transmit_routes = HashMap::new();
        for (source_idx, source) in sources.iter().enumerate() {
            for mapping in &source.bus_mappings {
                if mapping.enabled {
                    transmit_routes.insert(
                        mapping.output_bus,
                        TransmitRoute {
                            source_idx,
                            profile_id: source.profile_id.clone(),
                            profile_kind: source.profile_kind.clone(),
                            device_bus: mapping.device_bus,
                        },
                    );
                }
            }
        }

        // Determine if this session emits raw bytes
        // Raw bytes are emitted if any serial source either:
        // 1. Has no framing (raw mode), or
        // 2. Has framing but emit_raw_bytes is explicitly true
        let emits_raw_bytes = sources.iter().any(|source| {
            if source.profile_kind != "serial" {
                return false;
            }
            let framing = source.framing_encoding.as_deref().unwrap_or("raw");
            if framing == "raw" {
                // No framing means raw bytes are emitted
                true
            } else {
                // Has framing - only emit raw bytes if explicitly requested
                source.emit_raw_bytes.unwrap_or(false)
            }
        });

        Ok(Self {
            app,
            session_id,
            sources,
            state: IOState::Stopped,
            stop_flag: Arc::new(AtomicBool::new(false)),
            task_handles: Vec::new(),
            rx: Some(rx),
            tx,
            transmit_routes,
            transmit_channels: Arc::new(Mutex::new(HashMap::new())),
            session_traits,
            emits_raw_bytes,
        })
    }

    /// Get the source configurations for this multi-source session
    #[allow(dead_code)]
    pub fn sources(&self) -> &[SourceConfig] {
        &self.sources
    }

    /// Get combined capabilities from all sources
    fn combined_capabilities(&self) -> IOCapabilities {
        // Multi-source sessions have limited capabilities
        // - No pause (would need to coordinate all sources)
        // - No time range (real-time only for now)
        // - Real-time since we're combining live sources
        // - Transmit is supported by routing to the appropriate source

        // Check if we have any CAN-capable sources that can transmit
        // Serial sources don't count for CAN transmit capability
        let has_can_transmit_routes = self.transmit_routes.values().any(|route| {
            matches!(
                route.profile_kind.as_str(),
                "gvret_tcp" | "gvret_usb" | "slcan" | "gs_usb" | "socketcan"
            )
        });

        IOCapabilities {
            can_pause: false,
            supports_time_range: false,
            is_realtime: self.session_traits.temporal_mode == TemporalMode::Realtime,
            supports_speed_control: false,
            supports_seek: false,
            // Can transmit CAN frames if we have any CAN-capable transmit routes
            can_transmit: self.session_traits.can_transmit && has_can_transmit_routes,
            can_transmit_serial: self.session_traits.protocols.contains(&Protocol::Serial),
            supports_canfd: self.session_traits.protocols.contains(&Protocol::CanFd),
            supports_extended_id: true,
            supports_rtr: true,
            // Collect all output bus numbers from all source mappings (sorted)
            available_buses: {
                let mut buses: Vec<u8> = self
                    .sources
                    .iter()
                    .flat_map(|s| s.bus_mappings.iter().filter(|m| m.enabled).map(|m| m.output_bus))
                    .collect::<std::collections::HashSet<_>>()
                    .into_iter()
                    .collect();
                buses.sort();
                buses
            },
            emits_raw_bytes: false, // Set via builder below
            // Include the formal session traits
            traits: Some(self.session_traits.clone()),
        }
        // Whether raw bytes are emitted (serial sources without framing or with emit_raw_bytes=true)
        .with_emits_raw_bytes(self.emits_raw_bytes)
    }
}

#[async_trait]
impl IODevice for MultiSourceReader {
    fn capabilities(&self) -> IOCapabilities {
        self.combined_capabilities()
    }

    async fn start(&mut self) -> Result<(), String> {
        if matches!(self.state, IOState::Running | IOState::Starting) {
            return Err("Session already running".to_string());
        }

        // Check that we have a receiver before changing state
        // If rx was consumed and not recreated (e.g., after error), recreate it
        if self.rx.is_none() {
            eprintln!(
                "[MultiSourceReader] Receiver was consumed, recreating channel for session '{}'",
                self.session_id
            );
            let (tx, rx) = mpsc::channel(1024);
            self.tx = tx;
            self.rx = Some(rx);
        }

        self.state = IOState::Starting;
        self.stop_flag.store(false, Ordering::SeqCst);

        // Determine if any source produces actual frames (vs just raw bytes)
        let has_framing = self.sources.iter().any(|source| {
            if source.profile_kind != "serial" {
                return true; // Non-serial sources produce frames
            }
            let framing = source.framing_encoding.as_deref().unwrap_or("raw");
            framing != "raw" // Serial sources with non-raw framing produce frames
        });

        // Create appropriate buffer(s) for this multi-source session
        // We may need both a Frames buffer (for CAN, framed serial) and a Bytes buffer (for raw serial)
        let buffer_name = format!("Multi-Source {}", self.session_id);
        let mut bytes_buffer_id: Option<String> = None;

        if has_framing {
            // Create a frames buffer as active (for frame operations)
            buffer_store::create_buffer(BufferType::Frames, buffer_name.clone());
        }

        if self.emits_raw_bytes {
            if has_framing {
                // Create a bytes buffer in addition to frames buffer (not as active)
                bytes_buffer_id = Some(buffer_store::create_buffer_inactive(
                    BufferType::Bytes,
                    format!("{} (bytes)", buffer_name),
                ));
            } else {
                // Only raw bytes - create a bytes buffer as active
                buffer_store::create_buffer(BufferType::Bytes, buffer_name.clone());
            }
        }

        // Clear any stale transmit channels from previous run
        if let Ok(mut channels) = self.transmit_channels.lock() {
            channels.clear();
        }

        let app = self.app.clone();
        let session_id = self.session_id.clone();
        let sources = self.sources.clone();
        let stop_flag = self.stop_flag.clone();
        let tx = self.tx.clone();
        let transmit_channels = self.transmit_channels.clone();
        let emits_raw_bytes = self.emits_raw_bytes;

        // Take the receiver - we'll use it in the merge task
        // This should always succeed now since we checked/recreated above
        let rx = self.rx.take().ok_or("Receiver already taken")?;

        // Spawn the merge task that collects frames from all sources
        let merge_handle = tokio::spawn(async move {
            run_merge_task(
                app,
                session_id,
                sources,
                emits_raw_bytes,
                bytes_buffer_id,
                stop_flag,
                rx,
                tx,
                transmit_channels,
            )
            .await;
        });

        self.task_handles.push(merge_handle);
        self.state = IOState::Running;

        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        eprintln!(
            "[MultiSourceReader] Stopping session '{}'",
            self.session_id
        );

        self.stop_flag.store(true, Ordering::SeqCst);

        // Wait for all tasks to finish
        for handle in self.task_handles.drain(..) {
            let _ = handle.await;
        }

        // Recreate the channel so the session can be started again
        let (tx, rx) = mpsc::channel(1024);
        self.tx = tx;
        self.rx = Some(rx);

        self.state = IOState::Stopped;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        Err("Multi-source sessions do not support pause".to_string())
    }

    async fn resume(&mut self) -> Result<(), String> {
        Err("Multi-source sessions do not support resume".to_string())
    }

    fn set_speed(&mut self, _speed: f64) -> Result<(), String> {
        Err("Multi-source sessions do not support speed control".to_string())
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("Multi-source sessions do not support time range".to_string())
    }

    fn transmit_frame(&self, frame: &CanTransmitFrame) -> Result<TransmitResult, String> {
        // Route transmit to the appropriate source based on bus number
        let route = self
            .transmit_routes
            .get(&frame.bus)
            .ok_or_else(|| {
                format!(
                    "No source configured for bus {} (available: {:?})",
                    frame.bus,
                    self.transmit_routes.keys().collect::<Vec<_>>()
                )
            })?;

        // Create a modified frame with the device bus number (reverse the mapping)
        let mut routed_frame = frame.clone();
        routed_frame.bus = route.device_bus;

        // Get the transmit channel for this source
        let channels = self.transmit_channels.lock()
            .map_err(|e| format!("Failed to lock transmit channels: {}", e))?;

        let tx = channels.get(&route.source_idx)
            .ok_or_else(|| {
                format!(
                    "No transmit channel for source {} (profile '{}') - source may not support transmit or not yet connected",
                    route.source_idx, route.profile_id
                )
            })?
            .clone();
        drop(channels); // Release lock before blocking

        // Encode the frame based on the profile kind
        let data = match route.profile_kind.as_str() {
            "gvret_tcp" | "gvret_usb" => {
                // Validate and encode for GVRET protocol
                if let Err(result) = validate_gvret_frame(&routed_frame) {
                    return Ok(result);
                }
                encode_gvret_frame(&routed_frame)
            }
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            "gs_usb" => {
                // Encode for gs_usb protocol (20-byte host frame)
                // Use echo_id = 0, the transmit task will handle incrementing if needed
                encode_gs_usb_frame(&routed_frame, 0).to_vec()
            }
            "slcan" => {
                // Encode for slcan protocol
                encode_slcan_frame(&routed_frame)
            }
            #[cfg(target_os = "linux")]
            "socketcan" => {
                // Encode for SocketCAN - raw CAN frame bytes (classic or FD)
                match encode_socketcan_frame(&routed_frame) {
                    EncodedFrame::Classic(buf) => buf.to_vec(),
                    EncodedFrame::Fd(buf) => buf.to_vec(),
                }
            }
            _ => {
                return Err(format!(
                    "Unsupported profile kind '{}' for transmission",
                    route.profile_kind
                ));
            }
        };

        // Create a sync channel to receive the result
        let (result_tx, result_rx) = std_mpsc::sync_channel(1);

        // Send the transmit request
        tx.try_send(TransmitRequest { data, result_tx })
            .map_err(|e| format!("Failed to queue transmit request: {}", e))?;

        // Wait for the result with a timeout
        let result = result_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .map_err(|e| format!("Transmit timeout or channel closed: {}", e))?;

        result?;

        Ok(TransmitResult::success())
    }

    fn transmit_serial(&self, bytes: &[u8]) -> Result<TransmitResult, String> {
        if bytes.is_empty() {
            return Ok(TransmitResult::error("No bytes to transmit".to_string()));
        }

        // Find the first serial source in the transmit routes
        let serial_route = self
            .transmit_routes
            .values()
            .find(|route| route.profile_kind == "serial")
            .ok_or_else(|| {
                "No serial source configured in this session".to_string()
            })?;

        // Get the transmit channel for this source
        let channels = self.transmit_channels.lock()
            .map_err(|e| format!("Failed to lock transmit channels: {}", e))?;

        let tx = channels.get(&serial_route.source_idx)
            .ok_or_else(|| {
                format!(
                    "No transmit channel for serial source {} (profile '{}') - source may not be connected",
                    serial_route.source_idx, serial_route.profile_id
                )
            })?
            .clone();
        drop(channels); // Release lock before blocking

        // Create a sync channel to receive the result
        let (result_tx, result_rx) = std_mpsc::sync_channel(1);

        // Send the raw bytes directly (no encoding needed for serial)
        tx.try_send(TransmitRequest { data: bytes.to_vec(), result_tx })
            .map_err(|e| format!("Failed to queue serial transmit request: {}", e))?;

        // Wait for the result with a timeout
        let result = result_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .map_err(|e| format!("Serial transmit timeout or channel closed: {}", e))?;

        result?;

        Ok(TransmitResult::success())
    }

    fn state(&self) -> IOState {
        self.state.clone()
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn device_type(&self) -> &'static str {
        "multi_source"
    }

    fn multi_source_configs(&self) -> Option<Vec<SourceConfig>> {
        Some(self.sources.clone())
    }
}

// ============================================================================
// Merge Task
// ============================================================================

/// Main merge task that spawns sub-readers and combines their frames/bytes
async fn run_merge_task(
    app: AppHandle,
    session_id: String,
    sources: Vec<SourceConfig>,
    _emits_raw_bytes: bool,
    bytes_buffer_id: Option<String>,
    stop_flag: Arc<AtomicBool>,
    mut rx: mpsc::Receiver<SourceMessage>,
    tx: mpsc::Sender<SourceMessage>,
    transmit_channels: TransmitChannels,
) {
    use crate::settings;

    // Load settings to get profile configurations
    let settings = match settings::load_settings(app.clone()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[MultiSourceReader] Failed to load settings: {}", e);
            emit_stream_ended(&app, &session_id, "error", "MultiSourceReader");
            return;
        }
    };

    // Spawn a sub-reader task for each source
    let mut source_handles = Vec::new();
    for (index, source_config) in sources.iter().enumerate() {
        let profile = match settings.io_profiles.iter().find(|p| p.id == source_config.profile_id) {
            Some(p) => p.clone(),
            None => {
                eprintln!(
                    "[MultiSourceReader] Profile '{}' not found",
                    source_config.profile_id
                );
                continue;
            }
        };

        let app_clone = app.clone();
        let session_id_clone = session_id.clone();
        let stop_flag_clone = stop_flag.clone();
        let tx_clone = tx.clone();
        let bus_mappings = source_config.bus_mappings.clone();
        let display_name = source_config.display_name.clone();
        let framing_encoding = source_config.framing_encoding.clone();
        let delimiter = source_config.delimiter.clone();
        let max_frame_length = source_config.max_frame_length;
        let min_frame_length = source_config.min_frame_length;
        let emit_raw_bytes = source_config.emit_raw_bytes;

        let handle = tokio::spawn(async move {
            run_source_reader(
                app_clone,
                session_id_clone,
                index,
                profile,
                bus_mappings,
                display_name,
                framing_encoding,
                delimiter,
                max_frame_length,
                min_frame_length,
                emit_raw_bytes,
                stop_flag_clone,
                tx_clone,
            )
            .await;
        });

        source_handles.push(handle);
    }

    // Track which sources are still active
    let mut active_sources = sources.len();
    let mut pending_frames: Vec<FrameMessage> = Vec::new();
    let mut pending_bytes: Vec<TimestampedByte> = Vec::new();
    let mut last_emit = std::time::Instant::now();

    // Track frames per bus for periodic logging
    let mut frames_per_bus: std::collections::HashMap<u8, usize> = std::collections::HashMap::new();
    let mut last_bus_log = std::time::Instant::now();

    // Main merge loop
    while !stop_flag.load(Ordering::SeqCst) && active_sources > 0 {
        // Use timeout to allow periodic emission even with slow sources
        match tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await {
            Ok(Some(msg)) => match msg {
                SourceMessage::Frames(_source_idx, frames) => {
                    // Track frames per bus
                    for frame in &frames {
                        *frames_per_bus.entry(frame.bus).or_insert(0) += 1;
                    }
                    pending_frames.extend(frames);
                }
                SourceMessage::RawBytes(_source_idx, raw_entries) => {
                    // Convert RawByteEntry (i64 timestamp) to TimestampedByte (u64 timestamp)
                    for entry in raw_entries {
                        pending_bytes.push(TimestampedByte {
                            byte: entry.byte,
                            timestamp_us: entry.timestamp_us as u64,
                            bus: entry.bus,
                        });
                    }
                }
                SourceMessage::Ended(source_idx, reason) => {
                    eprintln!(
                        "[MultiSourceReader] Source {} ended: {}",
                        source_idx, reason
                    );
                    // Remove transmit channel for this source
                    if let Ok(mut channels) = transmit_channels.lock() {
                        channels.remove(&source_idx);
                    }
                    active_sources = active_sources.saturating_sub(1);
                }
                SourceMessage::Error(source_idx, error) => {
                    eprintln!(
                        "[MultiSourceReader] Source {} error: {}",
                        source_idx, error
                    );
                    // Remove transmit channel for this source
                    if let Ok(mut channels) = transmit_channels.lock() {
                        channels.remove(&source_idx);
                    }
                    emit_to_session(&app, "can-bytes-error", &session_id, error);
                    active_sources = active_sources.saturating_sub(1);
                }
                SourceMessage::TransmitReady(source_idx, tx_sender) => {
                    eprintln!(
                        "[MultiSourceReader] Source {} transmit channel ready",
                        source_idx
                    );
                    if let Ok(mut channels) = transmit_channels.lock() {
                        channels.insert(source_idx, tx_sender);
                    }
                }
            },
            Ok(None) => {
                // Channel closed
                break;
            }
            Err(_) => {
                // Timeout - emit any pending frames
            }
        }

        // Periodically log frames per bus (every 5 seconds)
        if last_bus_log.elapsed().as_secs() >= 5 && !frames_per_bus.is_empty() {
            let mut bus_counts: Vec<_> = frames_per_bus.iter().collect();
            bus_counts.sort_by_key(|(bus, _)| *bus);
            let counts_str: Vec<String> = bus_counts
                .iter()
                .map(|(bus, count)| format!("bus {}: {}", bus, count))
                .collect();
            eprintln!(
                "[MultiSourceReader] Frame counts per bus: {}",
                counts_str.join(", ")
            );
            last_bus_log = std::time::Instant::now();
        }

        // Emit data if we have any and either:
        // - We have a decent batch (>= 100 items)
        // - It's been more than 50ms since last emit
        let should_emit = last_emit.elapsed().as_millis() >= 50
            || pending_frames.len() >= 100
            || pending_bytes.len() >= 256;

        if should_emit {
            // Emit frames if we have any
            if !pending_frames.is_empty() {
                // Sort by timestamp for proper ordering
                pending_frames.sort_by_key(|f| f.timestamp_us);

                // Append to buffer
                buffer_store::append_frames(pending_frames.clone());

                // Emit to frontend
                emit_frames(&app, &session_id, pending_frames);
                pending_frames = Vec::new();
            }

            // Emit raw bytes if we have any
            if !pending_bytes.is_empty() {
                // Sort by timestamp for proper ordering
                pending_bytes.sort_by_key(|b| b.timestamp_us);

                // Append to buffer (use specific bytes buffer if we have one)
                if let Some(ref buf_id) = bytes_buffer_id {
                    buffer_store::append_raw_bytes_to_buffer(buf_id, pending_bytes.clone());
                } else {
                    buffer_store::append_raw_bytes(pending_bytes.clone());
                }

                // Emit to frontend
                let payload = SerialRawBytesPayload {
                    bytes: pending_bytes,
                    port: "multi-source".to_string(),
                };
                emit_to_session(&app, "serial-raw-bytes", &session_id, payload);
                pending_bytes = Vec::new();
            }

            last_emit = std::time::Instant::now();
        }
    }

    // Emit any remaining frames
    if !pending_frames.is_empty() {
        pending_frames.sort_by_key(|f| f.timestamp_us);
        buffer_store::append_frames(pending_frames.clone());
        emit_frames(&app, &session_id, pending_frames);
    }

    // Emit any remaining bytes
    if !pending_bytes.is_empty() {
        pending_bytes.sort_by_key(|b| b.timestamp_us);
        // Append to buffer (use specific bytes buffer if we have one)
        if let Some(ref buf_id) = bytes_buffer_id {
            buffer_store::append_raw_bytes_to_buffer(buf_id, pending_bytes.clone());
        } else {
            buffer_store::append_raw_bytes(pending_bytes.clone());
        }
        let payload = SerialRawBytesPayload {
            bytes: pending_bytes,
            port: "multi-source".to_string(),
        };
        emit_to_session(&app, "serial-raw-bytes", &session_id, payload);
    }

    // Wait for all source tasks to finish
    for handle in source_handles {
        let _ = handle.await;
    }

    // Emit stream ended (uses helper from gvret_common which finalizes the buffer)
    let reason = if stop_flag.load(Ordering::SeqCst) {
        "stopped"
    } else {
        "complete"
    };
    emit_stream_ended(&app, &session_id, reason, "MultiSourceReader");

}

/// Run a single source reader and send frames to the merge task
async fn run_source_reader(
    _app: AppHandle,
    _session_id: String,
    source_idx: usize,
    profile: crate::settings::IOProfile,
    bus_mappings: Vec<BusMapping>,
    _display_name: String,
    // Framing config from session options (overrides profile settings for serial)
    framing_encoding_override: Option<String>,
    delimiter_override: Option<Vec<u8>>,
    max_frame_length_override: Option<usize>,
    min_frame_length_override: Option<usize>,
    emit_raw_bytes_override: Option<bool>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    match profile.kind.as_str() {
        "gvret_tcp" | "gvret-tcp" => {
            let host = profile
                .connection
                .get("host")
                .and_then(|v| v.as_str())
                .unwrap_or("127.0.0.1")
                .to_string();
            let port = profile
                .connection
                .get("port")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(23) as u16;
            let timeout_sec = profile
                .connection
                .get("timeout")
                .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(5.0);

            run_gvret_tcp_source(source_idx, host, port, timeout_sec, bus_mappings, stop_flag, tx)
                .await;
        }
        "gvret_usb" | "gvret-usb" => {
            let port = match profile.connection.get("port").and_then(|v| v.as_str()) {
                Some(p) => p.to_string(),
                None => {
                    let _ = tx
                        .send(SourceMessage::Error(
                            source_idx,
                            "Serial port is required".to_string(),
                        ))
                        .await;
                    return;
                }
            };
            let baud_rate = profile
                .connection
                .get("baud_rate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(115200) as u32;

            run_gvret_usb_source(source_idx, port, baud_rate, bus_mappings, stop_flag, tx).await;
        }
        "slcan" => {
            let port = match profile.connection.get("port").and_then(|v| v.as_str()) {
                Some(p) => p.to_string(),
                None => {
                    let _ = tx
                        .send(SourceMessage::Error(
                            source_idx,
                            "Serial port is required".to_string(),
                        ))
                        .await;
                    return;
                }
            };
            let baud_rate = profile
                .connection
                .get("baud_rate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(115200) as u32;
            let bitrate = profile
                .connection
                .get("bitrate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(500_000) as u32;
            let silent_mode = profile
                .connection
                .get("silent_mode")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            run_slcan_source(
                source_idx,
                port,
                baud_rate,
                bitrate,
                silent_mode,
                bus_mappings,
                stop_flag,
                tx,
            )
            .await;
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        "gs_usb" => {
            let bus = profile
                .connection
                .get("bus")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0) as u8;
            let address = profile
                .connection
                .get("address")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0) as u8;
            let bitrate = profile
                .connection
                .get("bitrate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(500_000) as u32;
            let listen_only = profile
                .connection
                .get("listen_only")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let channel = profile
                .connection
                .get("channel")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0) as u8;

            run_gs_usb_source(
                source_idx,
                bus,
                address,
                bitrate,
                listen_only,
                channel,
                bus_mappings,
                stop_flag,
                tx,
            )
            .await;
        }
        #[cfg(target_os = "linux")]
        "socketcan" => {
            let interface = match profile.connection.get("interface").and_then(|v| v.as_str()) {
                Some(i) => i.to_string(),
                None => {
                    let _ = tx
                        .send(SourceMessage::Error(
                            source_idx,
                            "SocketCAN interface is required".to_string(),
                        ))
                        .await;
                    return;
                }
            };

            run_socketcan_source(source_idx, interface, bus_mappings, stop_flag, tx).await;
        }
        "serial" => {
            let port = match profile.connection.get("port").and_then(|v| v.as_str()) {
                Some(p) => p.to_string(),
                None => {
                    let _ = tx
                        .send(SourceMessage::Error(
                            source_idx,
                            "Serial port is required".to_string(),
                        ))
                        .await;
                    return;
                }
            };
            let baud_rate = profile
                .connection
                .get("baud_rate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(115200) as u32;
            let data_bits = profile
                .connection
                .get("data_bits")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(8) as u8;
            let stop_bits = profile
                .connection
                .get("stop_bits")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(1) as u8;
            let parity_str = profile
                .connection
                .get("parity")
                .and_then(|v| v.as_str())
                .unwrap_or("none");
            let parity = match parity_str {
                "odd" => super::serial::Parity::Odd,
                "even" => super::serial::Parity::Even,
                _ => super::serial::Parity::None,
            };

            // Framing configuration - prefer session override, fall back to profile settings
            let framing_encoding_str = framing_encoding_override
                .as_deref()
                .or_else(|| profile.connection.get("framing_encoding").and_then(|v| v.as_str()))
                .unwrap_or("raw"); // Default to raw if nothing configured

            let framing_encoding = match framing_encoding_str {
                "slip" => FramingEncoding::Slip,
                "modbus_rtu" => {
                    let device_address = profile
                        .connection
                        .get("modbus_device_address")
                        .and_then(|v| v.as_i64())
                        .map(|n| n as u8);
                    let validate_crc = profile
                        .connection
                        .get("modbus_validate_crc")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    FramingEncoding::ModbusRtu { device_address, validate_crc }
                }
                "delimiter" => {
                    // Use session override if provided, else profile settings
                    let delimiter = delimiter_override
                        .clone()
                        .or_else(|| {
                            profile.connection.get("delimiter")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().filter_map(|v| v.as_i64().map(|n| n as u8)).collect())
                        })
                        .unwrap_or_else(|| vec![0x0A]); // Default to newline
                    let max_length = max_frame_length_override
                        .or_else(|| profile.connection.get("max_frame_length").and_then(|v| v.as_i64()).map(|n| n as usize))
                        .unwrap_or(1024);
                    let include_delimiter = profile
                        .connection
                        .get("include_delimiter")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    FramingEncoding::Delimiter { delimiter, max_length, include_delimiter }
                }
                "raw" | _ => {
                    // Raw mode - emit bytes as individual "frames" with length as ID
                    FramingEncoding::Raw
                }
            };

            // Log framing config for debugging
            eprintln!(
                "[multi_source] Serial source {} using framing: {:?} (override: {:?})",
                source_idx, framing_encoding, framing_encoding_override
            );

            // Frame ID extraction config
            let frame_id_config = profile.connection.get("frame_id_start_byte").and_then(|_| {
                Some(FrameIdConfig {
                    start_byte: profile.connection.get("frame_id_start_byte")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0) as i32,
                    num_bytes: profile.connection.get("frame_id_bytes")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(1) as u8,
                    big_endian: profile.connection.get("frame_id_big_endian")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                })
            });

            // Source address extraction config
            let source_address_config = profile.connection.get("source_address_start_byte").and_then(|_| {
                Some(FrameIdConfig {
                    start_byte: profile.connection.get("source_address_start_byte")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0) as i32,
                    num_bytes: profile.connection.get("source_address_bytes")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(1) as u8,
                    big_endian: profile.connection.get("source_address_big_endian")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true),
                })
            });

            let min_frame_length = min_frame_length_override
                .or_else(|| profile.connection.get("min_frame_length").and_then(|v| v.as_i64()).map(|n| n as usize))
                .unwrap_or(0);

            // Determine if we should emit raw bytes
            // For "raw" framing mode, raw bytes are the primary output
            // For other modes, only emit if explicitly requested
            let emit_raw_bytes = match framing_encoding_str {
                "raw" => true,
                _ => emit_raw_bytes_override.unwrap_or(false),
            };

            run_serial_source(
                source_idx,
                port,
                baud_rate,
                data_bits,
                stop_bits,
                parity,
                framing_encoding,
                frame_id_config,
                source_address_config,
                min_frame_length,
                emit_raw_bytes,
                bus_mappings,
                stop_flag,
                tx,
            )
            .await;
        }
        kind => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Unsupported source type for multi-bus: {}", kind),
                ))
                .await;
        }
    }
}
