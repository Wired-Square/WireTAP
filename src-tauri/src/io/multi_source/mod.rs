// io/multi_source/mod.rs
//
// Multi-source reader that combines frames from multiple IO devices.
// Used for multi-bus capture where frames from diverse sources are merged.

mod merge;
mod spawner;
mod types;

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use tauri::AppHandle;
use tokio::sync::mpsc;

/// Capacity for the async frame/bytes channel between source readers and the merge task.
const SOURCE_CHANNEL_CAPACITY: usize = 1024;

use super::framelink::{encode_framelink_can_tx, encode_framelink_serial_tx};
use super::gvret::{encode_gvret_frame, validate_gvret_frame, BusMapping};
#[cfg(not(target_os = "ios"))]
use super::slcan::encode_transmit_frame as encode_slcan_frame;
#[cfg(target_os = "linux")]
use super::socketcan::{encode_frame as encode_socketcan_frame, EncodedFrame};
use super::traits::{get_traits_for_profile_kind, validate_session_traits};
use super::types::{SourceMessage, TransmitRequest};
use super::{
    CanTransmitFrame, IOCapabilities, IODevice, IOState, InterfaceTraits, SessionDataStreams,
    TransmitPayload, TransmitResult, VirtualBusState, emit_buffer_changed,
};
use crate::buffer_store::{self, BufferType};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use super::gs_usb::encode_frame as encode_gs_usb_frame;

use merge::run_merge_task;
pub use types::{ModbusRole, SourceConfig};
use types::{TransmitChannels, TransmitRoute};

// ============================================================================
// Virtual Bus Control (shared with generator tasks)
// ============================================================================

/// Shared runtime controls for a single virtual bus generator task
pub struct VirtualBusControl {
    /// Whether the signal generator is enabled for this bus
    pub traffic_enabled: Arc<AtomicBool>,
    /// Generator interval in microseconds (1_000_000 / frame_rate_hz)
    pub interval_us: Arc<AtomicU64>,
    /// Per-bus stop flag — set to true to stop this bus generator without stopping the session
    pub bus_stop: Arc<AtomicBool>,
}

/// Shared map of bus -> control, populated by the virtual source spawner
pub type VirtualBusControls = Arc<Mutex<HashMap<u8, VirtualBusControl>>>;

// ============================================================================
// Command Channels (for hot add/remove of sources and virtual buses)
// ============================================================================

/// Command sent to the merge task for dynamic source/bus management
pub enum MergeCommand {
    /// Add a new source reader to the running session
    AddSource(SourceConfig),
    /// Remove a source reader by profile ID
    RemoveSource(String),
}

/// Command sent to a virtual reader task for dynamic bus management
pub enum VirtualBusCommand {
    /// Add a new bus generator
    AddBus { bus: u8, traffic_type: String, frame_rate_hz: f64 },
    /// Remove a bus generator
    RemoveBus { bus: u8 },
}

/// Sender type for merge commands
pub type MergeCmdTx = Arc<Mutex<Option<mpsc::UnboundedSender<MergeCommand>>>>;

/// Sender type for virtual bus commands (one per virtual source)
pub type VirtualCmdTx = mpsc::UnboundedSender<VirtualBusCommand>;

// ============================================================================
// Multi-Source Reader
// ============================================================================

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
    /// Per-bus signal generator controls for virtual sources (populated on start)
    virtual_bus_controls: VirtualBusControls,
    /// Command channel to the merge task for hot source add/remove
    merge_cmd_tx: MergeCmdTx,
    /// Command channels to virtual reader tasks for hot bus add/remove (source_idx -> sender)
    virtual_cmd_txs: Arc<Mutex<HashMap<usize, VirtualCmdTx>>>,
}

impl MultiSourceReader {
    /// Create a multi-source reader with exactly one source.
    /// This is the preferred way to create sessions for real-time devices,
    /// as it uses the same code path as multi-device sessions.
    pub fn single_source(
        app: AppHandle,
        session_id: String,
        source: SourceConfig,
    ) -> Result<Self, String> {
        Self::new(app, session_id, vec![source])
    }

    /// Create a new multi-source reader
    ///
    /// Validates that all interfaces have compatible traits:
    /// - All interfaces must have the same temporal mode
    /// - Timeline sessions are limited to 1 interface
    /// - Protocols must be compatible (CAN + CAN-FD OK, but not CAN + Serial)
    pub fn new(
        app: AppHandle,
        session_id: String,
        sources: Vec<SourceConfig>,
    ) -> Result<Self, String> {
        // Collect traits from all enabled interfaces across all sources
        let interface_traits: Vec<InterfaceTraits> = sources
            .iter()
            .flat_map(|source| {
                source
                    .bus_mappings
                    .iter()
                    .filter(|m| m.enabled)
                    .filter_map(|m| {
                        // Use interface-level traits if available, fall back to profile-level
                        m.traits
                            .clone()
                            .or_else(|| Some(get_traits_for_profile_kind(&source.profile_kind)))
                    })
            })
            .collect();

        let validation = validate_session_traits(&interface_traits);
        if !validation.valid {
            return Err(validation
                .error
                .unwrap_or_else(|| "Unknown validation error".to_string()));
        }

        let session_traits = validation.session_traits.unwrap();

        let (tx, rx) = mpsc::channel(SOURCE_CHANNEL_CAPACITY);

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
            virtual_bus_controls: Arc::new(Mutex::new(HashMap::new())),
            merge_cmd_tx: Arc::new(Mutex::new(None)),
            virtual_cmd_txs: Arc::new(Mutex::new(HashMap::new())),
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
                "gvret_tcp" | "gvret_usb" | "slcan" | "gs_usb" | "socketcan" | "virtual" | "framelink"
            )
        });

        // Collect all output bus numbers from all source mappings (sorted)
        let mut buses: Vec<u8> = self
            .sources
            .iter()
            .flat_map(|s| {
                s.bus_mappings
                    .iter()
                    .filter(|m| m.enabled)
                    .map(|m| m.output_bus)
            })
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        buses.sort();

        // Emits frames if any source is non-serial, or if any serial source has framing
        let rx_frames = self.sources.iter().any(|s| {
            s.profile_kind != "serial"
                || s.framing_encoding.as_deref().map_or(false, |f| f != "raw")
        });

        IOCapabilities {
            can_pause: false,
            supports_time_range: false,
            supports_speed_control: false,
            supports_seek: false,
            supports_reverse: false,
            supports_extended_id: true,
            supports_rtr: true,
            available_buses: buses,
            traits: InterfaceTraits {
                tx_frames: self.session_traits.tx_frames && has_can_transmit_routes,
                tx_bytes: self.session_traits.tx_bytes,
                ..self.session_traits.clone()
            },
            data_streams: SessionDataStreams {
                rx_frames,
                rx_bytes: self.emits_raw_bytes,
            },
        }
    }

    /// Route a CAN frame transmit to the appropriate source based on bus number
    fn transmit_can_frame(&self, frame: &CanTransmitFrame) -> Result<TransmitResult, String> {
        let route = self.transmit_routes.get(&frame.bus).ok_or_else(|| {
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
        let channels = self
            .transmit_channels
            .lock()
            .map_err(|e| format!("Failed to lock transmit channels: {}", e))?;

        let tx = channels
            .get(&route.source_idx)
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
                if let Err(result) = validate_gvret_frame(&routed_frame) {
                    return Ok(result);
                }
                encode_gvret_frame(&routed_frame)
            }
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            "gs_usb" => encode_gs_usb_frame(&routed_frame, 0).to_vec(),
            #[cfg(not(target_os = "ios"))]
            "slcan" => encode_slcan_frame(&routed_frame),
            #[cfg(target_os = "linux")]
            "socketcan" => {
                match encode_socketcan_frame(&routed_frame) {
                    EncodedFrame::Classic(buf) => buf.to_vec(),
                    EncodedFrame::Fd(buf) => buf.to_vec(),
                }
            }
            "framelink" => encode_framelink_can_tx(&routed_frame),
            "virtual" => {
                // Simple binary loopback encoding: frame_id(4 LE) + bus(1) + is_extended(1) + is_fd(1) + dlc(1) + data
                let mut buf = Vec::with_capacity(8 + routed_frame.data.len());
                buf.extend_from_slice(&routed_frame.frame_id.to_le_bytes());
                buf.push(routed_frame.bus);
                buf.push(routed_frame.is_extended as u8);
                buf.push(routed_frame.is_fd as u8);
                buf.push(routed_frame.data.len() as u8);
                buf.extend_from_slice(&routed_frame.data);
                buf
            }
            _ => {
                return Err(format!(
                    "Unsupported profile kind '{}' for transmission",
                    route.profile_kind
                ));
            }
        };

        // Fire-and-forget: queue the frame into the device's transmit channel
        // (capacity 32) and return immediately. The device write task handles
        // the actual hardware write asynchronously. If the channel is full,
        // that's backpressure — report it as an error.
        //
        // We still create a result channel so the device task can report errors,
        // but we don't block waiting for it. Device write errors are logged by
        // the device task.
        let (result_tx, _result_rx) = std_mpsc::sync_channel(1);
        tx.try_send(TransmitRequest { data, result_tx })
            .map_err(|e| format!("Transmit buffer full ({})", e))?;
        Ok(TransmitResult::success())
    }

    /// Route raw bytes to the first serial source
    fn transmit_raw_bytes(&self, bytes: &[u8]) -> Result<TransmitResult, String> {
        if bytes.is_empty() {
            return Ok(TransmitResult::error("No bytes to transmit".to_string()));
        }

        let serial_route = self
            .transmit_routes
            .values()
            .find(|route| route.profile_kind == "serial" || route.profile_kind == "framelink")
            .ok_or_else(|| "No serial or FrameLink source configured in this session".to_string())?;

        let channels = self
            .transmit_channels
            .lock()
            .map_err(|e| format!("Failed to lock transmit channels: {}", e))?;

        let tx = channels
            .get(&serial_route.source_idx)
            .ok_or_else(|| {
                format!(
                    "No transmit channel for serial source {} (profile '{}') - source may not be connected",
                    serial_route.source_idx, serial_route.profile_id
                )
            })?
            .clone();
        drop(channels); // Release lock before blocking

        let data = if serial_route.profile_kind == "framelink" {
            encode_framelink_serial_tx(bytes, serial_route.device_bus)
        } else {
            bytes.to_vec()
        };

        let (result_tx, _result_rx) = std_mpsc::sync_channel(1);
        tx.try_send(TransmitRequest {
            data,
            result_tx,
        })
        .map_err(|e| format!("Serial transmit buffer full ({})", e))?;
        Ok(TransmitResult::success())
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
            tlog!(
                "[MultiSourceReader] Receiver was consumed, recreating channel for session '{}'",
                self.session_id
            );
            let (tx, rx) = mpsc::channel(SOURCE_CHANNEL_CAPACITY);
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

        // Orphan any existing buffer owned by this session (e.g., from a previous bookmark jump)
        // This makes the old buffer selectable in "Orphaned Buffers" while creating a fresh one
        let _orphaned = buffer_store::orphan_buffers_for_session(&self.session_id);

        // Create appropriate buffer(s) for this multi-source session
        // We may need both a Frames buffer (for CAN, framed serial) and a Bytes buffer (for raw serial)
        // Buffer names use session ID (UI prefixes with "Frames:" or "Bytes:" based on type)
        let mut bytes_buffer_id: Option<String> = None;

        if has_framing {
            // Create a frames buffer as active (for frame operations)
            let buffer_id = buffer_store::create_buffer(BufferType::Frames, self.session_id.clone());
            // Assign buffer ownership to this session
            let _ = buffer_store::set_buffer_owner(&buffer_id, &self.session_id);
        }

        if self.emits_raw_bytes {
            if has_framing {
                // Create a bytes buffer in addition to frames buffer (not as active)
                let bytes_id = buffer_store::create_buffer_inactive(
                    BufferType::Bytes,
                    self.session_id.clone(),
                );
                // Assign buffer ownership to this session
                let _ = buffer_store::set_buffer_owner(&bytes_id, &self.session_id);
                bytes_buffer_id = Some(bytes_id);
            } else {
                // Only raw bytes - create a bytes buffer as active
                let buffer_id = buffer_store::create_buffer(BufferType::Bytes, self.session_id.clone());
                // Assign buffer ownership to this session
                let _ = buffer_store::set_buffer_owner(&buffer_id, &self.session_id);
            }
        }

        // Emit buffer-changed after all buffer operations are complete
        emit_buffer_changed(&self.session_id);

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

        // Clear any previous virtual bus controls from last run
        if let Ok(mut controls) = self.virtual_bus_controls.lock() {
            controls.clear();
        }
        let virtual_bus_controls = self.virtual_bus_controls.clone();

        // Clear previous virtual command channels
        if let Ok(mut vtxs) = self.virtual_cmd_txs.lock() {
            vtxs.clear();
        }
        let virtual_cmd_txs = self.virtual_cmd_txs.clone();

        // Create command channel for hot source add/remove
        let (merge_cmd_tx, merge_cmd_rx) = mpsc::unbounded_channel::<MergeCommand>();
        if let Ok(mut tx_slot) = self.merge_cmd_tx.lock() {
            *tx_slot = Some(merge_cmd_tx);
        }

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
                virtual_bus_controls,
                merge_cmd_rx,
                virtual_cmd_txs,
            )
            .await;
        });

        self.task_handles.push(merge_handle);
        self.state = IOState::Running;

        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        tlog!(
            "[MultiSourceReader] Stopping session '{}'",
            self.session_id
        );

        self.stop_flag.store(true, Ordering::SeqCst);

        // Drop the merge command channel so the merge task sees it as closed
        if let Ok(mut tx_slot) = self.merge_cmd_tx.lock() {
            *tx_slot = None;
        }

        // Wait for all tasks to finish
        for handle in self.task_handles.drain(..) {
            if let Err(e) = handle.await {
                tlog!("[MultiSource] Task panicked during stop: {:?}", e);
            }
        }

        // Recreate the channel so the session can be started again
        let (tx, rx) = mpsc::channel(SOURCE_CHANNEL_CAPACITY);
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

    fn set_time_range(&mut self, _start: Option<String>, _end: Option<String>) -> Result<(), String> {
        Err("Multi-source sessions do not support time range".to_string())
    }

    fn transmit(&self, payload: &TransmitPayload) -> Result<TransmitResult, String> {
        match payload {
            TransmitPayload::CanFrame(frame) => self.transmit_can_frame(frame),
            TransmitPayload::RawBytes(bytes) => self.transmit_raw_bytes(bytes),
        }
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

    fn set_traffic_enabled(&mut self, enabled: bool) -> Result<(), String> {
        let controls = self.virtual_bus_controls.lock()
            .map_err(|e| format!("Failed to lock virtual bus controls: {}", e))?;
        if controls.is_empty() {
            return Err("No virtual bus controls available (no virtual sources)".to_string());
        }
        for ctrl in controls.values() {
            ctrl.traffic_enabled.store(enabled, Ordering::Relaxed);
        }
        let state = if enabled { "ON" } else { "OFF" };
        tlog!("[MultiSource:{}] Signal generator {} (all buses)", self.session_id, state);
        Ok(())
    }

    fn set_bus_traffic_enabled(&mut self, bus: u8, enabled: bool) -> Result<(), String> {
        let controls = self.virtual_bus_controls.lock()
            .map_err(|e| format!("Failed to lock virtual bus controls: {}", e))?;
        let ctrl = controls.get(&bus)
            .ok_or_else(|| format!("No virtual bus control for bus {}", bus))?;
        ctrl.traffic_enabled.store(enabled, Ordering::Relaxed);
        let state = if enabled { "ON" } else { "OFF" };
        tlog!("[MultiSource:{}] Signal generator {} (bus {})", self.session_id, state, bus);
        Ok(())
    }

    fn set_bus_cadence(&mut self, bus: u8, frame_rate_hz: f64) -> Result<(), String> {
        let hz = frame_rate_hz.clamp(0.1, 1000.0);
        let interval_us = (1_000_000.0 / hz) as u64;
        let controls = self.virtual_bus_controls.lock()
            .map_err(|e| format!("Failed to lock virtual bus controls: {}", e))?;
        let ctrl = controls.get(&bus)
            .ok_or_else(|| format!("No virtual bus control for bus {}", bus))?;
        ctrl.interval_us.store(interval_us, Ordering::Relaxed);
        tlog!("[MultiSource:{}] Cadence set to {:.1} Hz (bus {})", self.session_id, hz, bus);
        Ok(())
    }

    fn virtual_bus_states(&self) -> Result<Vec<VirtualBusState>, String> {
        let controls = self.virtual_bus_controls.lock()
            .map_err(|e| format!("Failed to lock virtual bus controls: {}", e))?;
        if controls.is_empty() {
            return Err("No virtual bus controls available (no virtual sources)".to_string());
        }
        let mut states: Vec<VirtualBusState> = controls.iter().map(|(&bus, ctrl)| {
            let interval_us = ctrl.interval_us.load(Ordering::Relaxed) as f64;
            let frame_rate_hz = if interval_us > 0.0 { 1_000_000.0 / interval_us } else { 0.0 };
            VirtualBusState {
                bus,
                enabled: ctrl.traffic_enabled.load(Ordering::Relaxed),
                frame_rate_hz,
            }
        }).collect();
        states.sort_by_key(|s| s.bus);
        Ok(states)
    }

    fn add_source_hot(&mut self, source: SourceConfig) -> Result<(), String> {
        let cmd_tx = self.merge_cmd_tx.lock()
            .map_err(|e| format!("Failed to lock merge command channel: {}", e))?;
        let tx = cmd_tx.as_ref()
            .ok_or_else(|| "Session not running — cannot hot-add source".to_string())?;
        tx.send(MergeCommand::AddSource(source.clone()))
            .map_err(|e| format!("Failed to send add-source command: {}", e))?;
        // Update local configs so multi_source_configs() reflects the change
        self.sources.push(source);
        Ok(())
    }

    fn remove_source_hot(&mut self, profile_id: &str) -> Result<(), String> {
        let cmd_tx = self.merge_cmd_tx.lock()
            .map_err(|e| format!("Failed to lock merge command channel: {}", e))?;
        let tx = cmd_tx.as_ref()
            .ok_or_else(|| "Session not running — cannot hot-remove source".to_string())?;
        tx.send(MergeCommand::RemoveSource(profile_id.to_string()))
            .map_err(|e| format!("Failed to send remove-source command: {}", e))?;
        // Update local configs
        self.sources.retain(|c| c.profile_id != profile_id);
        Ok(())
    }

    fn update_source_bus_mappings(&mut self, profile_id: &str, bus_mappings: Vec<BusMapping>) -> Result<(), String> {
        // Find the existing source config for this profile
        let existing = self.sources.iter()
            .find(|c| c.profile_id == profile_id)
            .ok_or_else(|| format!("Profile '{}' is not a source in this session", profile_id))?
            .clone();

        let has_enabled = bus_mappings.iter().any(|m| m.enabled);

        if !has_enabled {
            // No enabled mappings — remove the source entirely
            if self.sources.len() <= 1 {
                return Err("Cannot disable all buses on the last source — destroy the session instead".to_string());
            }
            self.remove_source_hot(profile_id)?;
            return Ok(());
        }

        // Build updated config with new bus mappings
        let mut updated = existing;
        updated.bus_mappings = bus_mappings;

        // Hot-swap: remove then re-add with updated mappings
        self.remove_source_hot(profile_id)?;
        self.add_source_hot(updated)?;

        Ok(())
    }

    fn add_virtual_bus(&mut self, bus: u8, traffic_type: String, frame_rate_hz: f64) -> Result<(), String> {
        // Send to all virtual source command channels
        let vtxs = self.virtual_cmd_txs.lock()
            .map_err(|e| format!("Failed to lock virtual command channels: {}", e))?;
        if vtxs.is_empty() {
            return Err("No virtual sources in this session".to_string());
        }
        for tx in vtxs.values() {
            let _ = tx.send(VirtualBusCommand::AddBus {
                bus,
                traffic_type: traffic_type.clone(),
                frame_rate_hz,
            });
        }
        Ok(())
    }

    fn remove_virtual_bus(&mut self, bus: u8) -> Result<(), String> {
        // Send to all virtual source command channels
        let vtxs = self.virtual_cmd_txs.lock()
            .map_err(|e| format!("Failed to lock virtual command channels: {}", e))?;
        if vtxs.is_empty() {
            return Err("No virtual sources in this session".to_string());
        }
        for tx in vtxs.values() {
            let _ = tx.send(VirtualBusCommand::RemoveBus { bus });
        }
        // Also remove from bus controls so virtual_bus_states() reflects the change
        if let Ok(mut controls) = self.virtual_bus_controls.lock() {
            if let Some(ctrl) = controls.get(&bus) {
                ctrl.bus_stop.store(true, Ordering::Relaxed);
            }
            controls.remove(&bus);
        }
        Ok(())
    }

    fn multi_source_configs(&self) -> Option<Vec<SourceConfig>> {
        Some(self.sources.clone())
    }
}
