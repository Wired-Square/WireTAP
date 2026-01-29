// io/multi_source/mod.rs
//
// Multi-source reader that combines frames from multiple IO devices.
// Used for multi-bus capture where frames from diverse sources are merged.

mod merge;
mod spawner;
mod types;

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use tauri::AppHandle;
use tokio::sync::mpsc;

use super::gvret::{encode_gvret_frame, validate_gvret_frame};
use super::slcan::encode_transmit_frame as encode_slcan_frame;
#[cfg(target_os = "linux")]
use super::socketcan::{encode_frame as encode_socketcan_frame, EncodedFrame};
use super::traits::{get_traits_for_profile_kind, validate_session_traits};
use super::types::{SourceMessage, TransmitRequest};
use super::{
    CanTransmitFrame, IOCapabilities, IODevice, IOState, InterfaceTraits, Protocol, TemporalMode,
    TransmitPayload, TransmitResult,
};
use crate::buffer_store::{self, BufferType};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use super::gs_usb::encode_frame as encode_gs_usb_frame;

use merge::run_merge_task;
pub use types::SourceConfig;
use types::{TransmitChannels, TransmitRoute};

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
            supports_reverse: false,
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
                buses
            },
            emits_raw_bytes: false, // Set via builder below
            // Include the formal session traits
            traits: Some(self.session_traits.clone()),
            data_streams: None, // Set via builder below
        }
        .with_emits_raw_bytes(self.emits_raw_bytes)
        .with_data_streams(
            // Emits frames if any source is non-serial, or if any serial source has framing
            self.sources.iter().any(|s| {
                s.profile_kind != "serial"
                    || s.framing_encoding.as_deref().map_or(false, |f| f != "raw")
            }),
            self.emits_raw_bytes,
        )
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
            "slcan" => encode_slcan_frame(&routed_frame),
            #[cfg(target_os = "linux")]
            "socketcan" => {
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

        let (result_tx, result_rx) = std_mpsc::sync_channel(1);
        tx.try_send(TransmitRequest { data, result_tx })
            .map_err(|e| format!("Failed to queue transmit request: {}", e))?;
        let result = result_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .map_err(|e| format!("Transmit timeout or channel closed: {}", e))?;
        result?;
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
            .find(|route| route.profile_kind == "serial")
            .ok_or_else(|| "No serial source configured in this session".to_string())?;

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

        let (result_tx, result_rx) = std_mpsc::sync_channel(1);
        tx.try_send(TransmitRequest {
            data: bytes.to_vec(),
            result_tx,
        })
        .map_err(|e| format!("Failed to queue serial transmit request: {}", e))?;
        let result = result_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .map_err(|e| format!("Serial transmit timeout or channel closed: {}", e))?;
        result?;
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

    fn multi_source_configs(&self) -> Option<Vec<SourceConfig>> {
        Some(self.sources.clone())
    }
}
