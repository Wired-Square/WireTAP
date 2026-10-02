// ui/crates/wiretap-app/src/io/mod.rs
//
// IO device abstraction for CAN data sources.
// Provides a common interface for different device types (GVRET, the WireTAP backend, etc.)
// with session-based isolation for multiple concurrent connections.

// Core modules
pub mod device_kinds; // Per-kind connection defaults and required fields — one declaration
pub mod ephemeral; // Ad-hoc devices, overlaid onto settings.io_profiles for this run
pub mod profiles; // Profile lifecycle: reconfigure a device and reconnect it
mod error;
pub mod lifecycle; // Terminal state left behind by a detached source task
pub mod net; // Shared host/port resolution for TCP transports
pub(crate) mod periodic; // Shared cadence primitive for interval-driven loops
mod signal_throttle;
pub use signal_throttle::SignalThrottle;
pub mod post_session;
pub use post_session::StreamEndReason;
pub mod traits; // InterfaceTraits validation
pub(crate) mod types;

// Recorded sources (capture, csv, WireTAP backend)
mod recorded;

// Real-time drivers
pub mod gs_usb; // pub for Tauri command access
pub mod bus_mapping; // Device bus -> session bus, shared by every multi-bus driver
mod can_task; // Frames in and transmits out of a wiretap-io CAN task
pub mod gvret; // GVRET TCP/USB driver
pub mod modbus_tcp; // pub for scanner command access
mod mqtt;
mod broker;
mod virtual_device;
#[cfg(not(target_os = "ios"))]
pub mod serial; // pub for Tauri command access (list_serial_ports)
#[cfg(not(target_os = "ios"))]
pub mod slcan; // pub for slcan transmit_frame access
pub mod framelink;
#[cfg(target_os = "linux")]
mod socketcan;

// Re-export recorded sources
pub use recorded::{step_frame, CaptureSource, StepResult, CAPTURE_SOURCE_TYPE};
pub use recorded::{
    is_candump_file, parse_candump_files, parse_csv_with_mapping, preview_csv_file, CsvColumnMapping, CsvPreview,
    CandumpImport, Delimiter, SequenceGap, SkippedLine, TimestampUnit,
};
pub use recorded::{BackendApiConfig, BackendApiSource, BackendApiSourceOptions};

// Re-export driver types
pub use bus_mapping::BusMapping;
pub use gvret::{probe_gvret_tcp, GvretDeviceInfo};
pub use modbus_tcp::{
    build_polls_from_catalog, build_polls_from_ranges, modbus_endpoint,
    ModbusRange, ModbusRangeSpec,
    PollGroup, RegisterType,
    ModbusScanConfig, ScanCompletePayload, UnitIdScanConfig,
    FcProbeConfig, FcProbeEntry, ModbusScanSource, ScanJob,
};
#[cfg(not(target_os = "ios"))]
pub use gvret::probe_gvret_usb;
pub use broker::{IOBroker, ProfileLoader, SerialOverrides, SourceConfig};
pub use types::{FramingMode, ModbusRtuOptions};
pub use mqtt::{MqttConfig, MqttSource};

// Error types
#[allow(unused_imports)]
pub use error::IoError;

mod roster;
mod session;
#[cfg(test)]
pub(crate) mod test_source;
mod wake;
mod webview_health;
pub use roster::*;
pub use session::*;
pub use wake::*;
pub use webview_health::*;

// Note: SlcanConfig, SlcanSource, SocketCanConfig, SocketIOSource are used internally
// by IOBroker but not exported from mod.rs since all real-time devices now
// go through IOBroker

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use wslib_ai_mcp::rmcp::schemars::{self, JsonSchema};

// ============================================================================
// Shared Types (used by multiple readers)
// ============================================================================

/// Parsed frame message - the main data structure emitted by all readers
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FrameMessage {
    pub protocol: String, // e.g., "can", "modbus", "serial"
    /// Host UNIX timestamp in microseconds.
    pub timestamp_us: u64,
    pub frame_id: u32,
    pub bus: u8,
    pub dlc: u16,
    pub bytes: Vec<u8>,
    // CAN-specific flags (ignored by other protocols)
    #[serde(default)]
    pub is_extended: bool,
    #[serde(default)]
    pub is_fd: bool,
    /// Source address (for protocols like J1939, TWC that embed sender ID in frame)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[cfg_attr(test, ts(optional))]
    pub source_address: Option<u16>,
    /// Indicates incomplete frame (e.g., no delimiter found at end of stream)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[cfg_attr(test, ts(optional))]
    pub incomplete: Option<bool>,
    /// Direction: "rx" for received, "tx" for transmitted
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[cfg_attr(test, ts(type = r#""rx" | "tx""#))]
    pub direction: Option<String>,
}

/// Playback position - stored and signalled via playback-position events during capture streaming
#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PlaybackPosition {
    /// Current timestamp in microseconds
    pub timestamp_us: i64,
    /// Current frame index (0-based)
    pub frame_index: usize,
    /// Total frame count in capture (optional, for recorded sources)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub frame_count: Option<usize>,
}

/// Per-bus signal generator state (returned to frontend for virtual devices)
#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct VirtualBusState {
    pub bus: u8,
    pub enabled: bool,
    pub frame_rate_hz: f64,
}

/// Get current time in microseconds since UNIX epoch
pub fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

/// CAN frame for transmission. Also the MCP transmit tools' frame parameters,
/// flattened, so the flags default when a caller leaves them out.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CanTransmitFrame {
    /// CAN frame ID (11-bit standard or 29-bit extended)
    pub frame_id: u32,
    /// Frame data (up to 8 bytes for classic CAN, up to 64 for CAN FD)
    pub data: Vec<u8>,
    /// Bus number (0 for single-bus adapters, 0-4 for multi-bus like GVRET)
    #[serde(default)]
    pub bus: u8,
    /// Extended (29-bit) frame ID
    #[serde(default)]
    pub is_extended: bool,
    /// CAN FD frame
    #[serde(default)]
    pub is_fd: bool,
    /// Bit Rate Switch (CAN FD only)
    #[serde(default)]
    pub is_brs: bool,
    /// Remote Transmission Request
    #[serde(default)]
    pub is_rtr: bool,
}

/// Result of a transmit operation
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TransmitResult {
    /// Whether the transmission was successful
    pub success: bool,
    /// Timestamp when the frame was sent (microseconds since UNIX epoch)
    pub timestamp_us: u64,
    /// Error message if transmission failed
    pub error: Option<String>,
}

impl TransmitResult {
    /// Create a successful transmit result with current timestamp
    pub fn success() -> Self {
        Self {
            success: true,
            timestamp_us: now_us(),
            error: None,
        }
    }

    /// Create a "queued" result — frame was accepted into the transmit buffer
    /// but the hardware write hasn't completed yet. Reports success to the caller
    /// since the frame will be sent asynchronously.
    pub fn queued() -> Self {
        Self {
            success: true,
            timestamp_us: now_us(),
            error: None,
        }
    }

    /// Create a failed transmit result with an error message
    pub fn error(message: String) -> Self {
        Self {
            success: false,
            timestamp_us: now_us(),
            error: Some(message),
        }
    }
}

/// Unified transmit payload — devices match on the variant they support.
#[derive(Clone, Debug)]
pub enum TransmitPayload {
    /// Transmit a CAN frame (classic or FD)
    CanFrame(CanTransmitFrame),
    /// Transmit raw bytes (serial, SPI, etc.)
    RawBytes(Vec<u8>),
}

// ============================================================================
// IO Device Trait and Capabilities
// ============================================================================

/// Temporal mode of an interface/session
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum TemporalMode {
    /// Real-time streaming from live devices (GVRET, slcan, gs_usb, SocketCAN, MQTT)
    Realtime,
    /// Playback from recorded sources (WireTAP backend, CSV)
    Recorded,
    /// Capture replay from previously captured data
    Capture,
}

/// Protocol family for frame-based communication
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum Protocol {
    /// CAN 2.0A/2.0B (standard/extended)
    #[default]
    Can,
    /// CAN FD (flexible data rate) - compatible with Can
    #[serde(rename = "canfd")]
    CanFd,
    /// Modbus register polls: one frame per register, `frame_id` the register
    Modbus,
    /// Whole Modbus RTU messages off a line, `frame_id` = unit << 8 | function
    /// and the CRC still on the end — what a passive tap archives
    #[serde(rename = "modbus_rtu")]
    ModbusRtu,
    /// Raw serial bytes
    Serial,
}

/// Combined interface traits for formal session/interface characterization
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct InterfaceTraits {
    /// Temporal mode of the interface
    pub temporal_mode: TemporalMode,
    /// Protocols supported by the interface
    pub protocols: Vec<Protocol>,
    /// Whether the interface can transmit frames (CAN, Modbus, framed serial)
    pub tx_frames: bool,
    /// Whether the interface can transmit raw bytes (serial)
    pub tx_bytes: bool,
    /// Whether this source can be combined with others in a multi-source session
    pub multi_source: bool,
}

/// Declares the data streams a session produces.
///
/// This replaces ad-hoc checks like `emits_raw_bytes` with a structured
/// declaration of what a session will emit. Used by the frontend to decide
/// which event listeners and views to set up.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SessionDataStreams {
    /// Whether this session emits framed messages (`frame-message` events)
    pub rx_frames: bool,
    /// Whether this session emits raw byte streams (`bytes-ready` signal)
    pub rx_bytes: bool,
}

/// IO device capabilities - what this device type supports
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct IOCapabilities {
    /// Supports pause/resume (WireTAP backend: true, GVRET: false)
    pub can_pause: bool,
    /// Supports time range filtering (WireTAP backend: true, GVRET: false)
    pub supports_time_range: bool,
    /// Supports speed control (WireTAP backend: true, GVRET: false)
    pub supports_speed_control: bool,
    /// Supports seeking to a specific timestamp (Buffer: true, others: false)
    #[serde(default)]
    pub supports_seek: bool,
    /// Supports reverse playback (Buffer: true, others: false)
    #[serde(default)]
    pub supports_reverse: bool,
    /// Supports extended (29-bit) CAN IDs
    #[serde(default)]
    pub supports_extended_id: bool,
    /// Supports Remote Transmission Request frames
    #[serde(default)]
    pub supports_rtr: bool,
    /// Available bus numbers (empty = single bus, [0,1,2] = multi-bus like GVRET)
    #[serde(default)]
    pub available_buses: Vec<u8>,
    /// Interface traits (temporal mode, protocols, transmit capability)
    pub traits: InterfaceTraits,
    /// Declares which data streams this session produces (frames, bytes, or both)
    pub data_streams: SessionDataStreams,
    /// Whether the session's transport is a serial link — a byte stream the user
    /// can look at and frame for themselves.
    ///
    /// Deliberately not the same question as `data_streams.rx_bytes`, which says
    /// whether raw bytes are actually on the wire *right now*. A framed serial
    /// link is a serial link with no raw bytes, and the two answers were one
    /// field until it had to mean both: Discovery used `rx_bytes` to decide
    /// whether to show the serial view at all, so making that field truthful
    /// would have hidden the Raw Bytes and Framed tabs from every framed-serial
    /// source. A FrameLink RS-485 interface is *not* one of these — it puts
    /// `Protocol::Serial` in the trait union but delivers framed messages, and
    /// its kind is `framelink`.
    #[serde(default)]
    pub serial_link: bool,
}

impl IOCapabilities {
    /// Create capabilities for a realtime CAN source (slcan, socketcan, gvret, gs_usb).
    ///
    /// Defaults:
    /// - No pause/resume (would lose data)
    /// - No time range or speed control
    /// - Supports extended IDs and RTR
    /// - Single bus (override with `with_buses`)
    /// - No transmit (override with `with_tx`)
    pub fn realtime_can() -> Self {
        Self {
            can_pause: false,
            supports_time_range: false,
            supports_speed_control: false,
            supports_seek: false,
            supports_reverse: false,
            supports_extended_id: true,
            supports_rtr: true,
            available_buses: vec![0],
            traits: InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Can],
                tx_frames: false,
                tx_bytes: false,
                multi_source: true,
            },
            data_streams: SessionDataStreams {
                rx_frames: true,
                rx_bytes: false,
            },
            serial_link: false,
        }
    }

    /// Create capabilities for a recorded/replay CAN source (capture, csv, WireTAP backend).
    ///
    /// Defaults:
    /// - Supports pause/resume and speed control
    /// - No transmit (replay source)
    /// - No seek (override with `with_seek`)
    pub fn recorded_can() -> Self {
        Self {
            can_pause: true,
            supports_time_range: false,
            supports_speed_control: true,
            supports_seek: false,
            supports_reverse: false,
            supports_extended_id: true,
            supports_rtr: false,
            available_buses: vec![],
            traits: InterfaceTraits {
                temporal_mode: TemporalMode::Recorded,
                protocols: vec![Protocol::Can],
                tx_frames: false,
                tx_bytes: false,
                multi_source: false,
            },
            data_streams: SessionDataStreams {
                rx_frames: true,
                rx_bytes: false,
            },
            serial_link: false,
        }
    }

    /// Set transmit capabilities (frames and/or bytes)
    pub fn with_tx(mut self, tx_frames: bool, tx_bytes: bool) -> Self {
        self.traits.tx_frames = tx_frames;
        self.traits.tx_bytes = tx_bytes;
        self
    }

    /// Set available buses
    pub fn with_buses(mut self, buses: Vec<u8>) -> Self {
        self.available_buses = buses;
        self
    }

    /// Set protocols
    pub fn with_protocols(mut self, protocols: Vec<Protocol>) -> Self {
        self.traits.protocols = protocols;
        self
    }

    /// Set seek support (for recorded sources)
    pub fn with_seek(mut self, supports_seek: bool) -> Self {
        self.supports_seek = supports_seek;
        self
    }

    /// Set reverse playback support (for recorded sources)
    pub fn with_reverse(mut self, supports_reverse: bool) -> Self {
        self.supports_reverse = supports_reverse;
        self
    }

    /// Set temporal mode (e.g., capture replay overrides recorded_can's default)
    pub fn with_temporal_mode(mut self, mode: TemporalMode) -> Self {
        self.traits.temporal_mode = mode;
        self
    }

    /// Set time range filter support (for recorded sources)
    pub fn with_time_range(mut self, supports_time_range: bool) -> Self {
        self.supports_time_range = supports_time_range;
        self
    }

    /// Set data streams explicitly
    pub fn with_data_streams(mut self, rx_frames: bool, rx_bytes: bool) -> Self {
        self.data_streams = SessionDataStreams {
            rx_frames,
            rx_bytes,
        };
        self
    }
}

/// Current state of an IO session
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "message")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum IOState {
    Stopped,
    Starting,
    Running,
    Paused,
    Error(String),
}

impl IOState {
    /// This state's byte in [`SESSION_STATES`](crate::ws::protocol::SESSION_STATES).
    pub fn code(&self) -> u8 {
        match self {
            IOState::Stopped => 0,
            IOState::Starting => 1,
            IOState::Running => 2,
            IOState::Paused => 3,
            IOState::Error(_) => 4,
        }
    }

    pub fn name(&self) -> &'static str {
        crate::ws::protocol::SESSION_STATES[usize::from(self.code())]
    }
}

/// What happened to a session, as its scoped `SessionLifecycle` message says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum SessionTransition {
    Suspended,
    SwitchedToCapture,
    /// Restarting with a fresh capture; sent before the source starts.
    Resuming,
    ReturnedToLive,
    CapabilitiesChanged,
}

impl SessionTransition {
    /// This transition's byte in [`SESSION_TRANSITIONS`](crate::ws::protocol::SESSION_TRANSITIONS).
    pub fn code(self) -> u8 {
        self as u8
    }
}

/// A session's scoped `SessionLifecycle` message.
pub struct SessionTransitionPayload {
    pub transition: SessionTransition,
    pub state: IOState,
    pub capabilities: IOCapabilities,
    pub mode: SessionMode,
    /// The capture the session finished with, for a suspend or a switch to capture.
    pub capture_id: Option<String>,
    pub capture_count: usize,
}

/// Trait for all IO devices (CAN adapters, serial ports, replay sources, etc.)
#[async_trait]
pub trait IOSource: Send + Sync {
    /// Get device capabilities
    fn capabilities(&self) -> IOCapabilities;

    /// Start streaming
    async fn start(&mut self) -> Result<(), String>;

    /// Stop streaming (cleanup resources)
    async fn stop(&mut self) -> Result<(), String>;

    /// Pause streaming (if supported)
    async fn pause(&mut self) -> Result<(), String>;

    /// Resume from pause (if supported)
    async fn resume(&mut self) -> Result<(), String>;

    /// Update playback speed (if supported)
    fn set_speed(&mut self, speed: f64) -> Result<(), String>;

    /// Update time range (only before starting, if supported)
    fn set_time_range(&mut self, start: Option<String>, end: Option<String>) -> Result<(), String>;

    /// Seek to a specific timestamp in microseconds (if supported)
    /// Default implementation returns an error.
    fn seek(&mut self, _timestamp_us: i64) -> Result<(), String> {
        Err("This device does not support seeking".to_string())
    }

    /// Seek to a specific frame index (if supported).
    /// This is the preferred method for capture playback as it avoids floating-point issues.
    /// Default implementation returns an error.
    fn seek_by_frame(&mut self, _frame_index: i64) -> Result<(), String> {
        Err("This device does not support frame-based seeking".to_string())
    }

    /// Set playback direction (forward or reverse).
    /// Default implementation returns an error.
    fn set_direction(&mut self, _reverse: bool) -> Result<(), String> {
        Err("This device does not support reverse playback".to_string())
    }

    /// Transmit data through the device.
    /// Devices match on the `TransmitPayload` variant they support and return
    /// an error for unsupported variants.
    fn transmit(&self, _payload: &TransmitPayload) -> Result<TransmitResult, String> {
        Err("This device does not support transmission".to_string())
    }

    /// A CAN frame routed to its source, to be queued once the session lock is released.
    fn pending_can_transmit(&self, _frame: &CanTransmitFrame) -> Result<types::PendingTransmit, String> {
        Err("This device does not support transmission".to_string())
    }

    /// Change serial framing on a running session in place (serial broker only).
    /// Default implementation returns an error.
    fn set_framing(&self, _req: types::SetFramingRequest) -> Result<(), String> {
        Err("This session does not support changing framing".to_string())
    }

    /// Get current state
    fn state(&self) -> IOState;

    /// Get session ID (useful for debugging)
    #[allow(dead_code)]
    fn session_id(&self) -> &str;

    /// Get device type identifier (e.g., "gvret_tcp", "realtime")
    /// Default implementation returns "unknown"
    fn source_type(&self) -> &'static str {
        "unknown"
    }

    /// Enable or disable traffic generation (virtual device only).
    /// Default implementation returns an error.
    fn set_traffic_enabled(&mut self, _enabled: bool) -> Result<(), String> {
        Err("This device does not support traffic toggle".to_string())
    }

    /// Enable or disable signal generator for a specific bus (virtual device only).
    fn set_bus_traffic_enabled(&mut self, _bus: u8, _enabled: bool) -> Result<(), String> {
        Err("This device does not support per-bus traffic toggle".to_string())
    }

    /// Update signal generator cadence for a specific bus (virtual device only).
    fn set_bus_cadence(&mut self, _bus: u8, _frame_rate_hz: f64) -> Result<(), String> {
        Err("This device does not support per-bus cadence control".to_string())
    }

    /// Query current per-bus signal generator states (virtual device only).
    fn virtual_bus_states(&self) -> Result<Vec<VirtualBusState>, String> {
        Err("This device does not support virtual bus states".to_string())
    }

    /// Hot-add a source to a running multi-source session.
    fn add_source_hot(&mut self, _source: broker::SourceConfig) -> Result<(), String> {
        Err("This device does not support hot source add".to_string())
    }

    /// Hot-remove a source from a running multi-source session.
    fn remove_source_hot(&mut self, _profile_id: &str) -> Result<(), String> {
        Err("This device does not support hot source remove".to_string())
    }

    /// Update bus mappings for a source in a running multi-source session.
    /// Hot-swaps the source by removing and re-adding it with updated mappings.
    fn update_source_bus_mappings(&mut self, _profile_id: &str, _bus_mappings: Vec<BusMapping>) -> Result<(), String> {
        Err("This device does not support bus mapping updates".to_string())
    }

    /// Pause polling for a specific source within a multi-source session.
    /// The source stays connected but stops emitting frames.
    fn pause_source_polling(&self, _profile_id: &str) -> Result<(), String> {
        Err("This device does not support per-source pause".to_string())
    }

    /// Resume polling for a paused source within a multi-source session.
    fn resume_source_polling(&self, _profile_id: &str) -> Result<(), String> {
        Err("This device does not support per-source resume".to_string())
    }

    /// Profile IDs whose polling is currently paused.
    ///
    /// The counterpart to the two calls above, and the reason they can be
    /// trusted: without it, pause was write-only — the caller had to remember
    /// what it had asked for, so two panels on one session disagreed and a
    /// webview reload came back claiming a paused device was polling.
    fn paused_source_profile_ids(&self) -> Vec<String> {
        vec![]
    }

    /// Add a virtual bus generator to a running session.
    fn add_virtual_bus(&mut self, _bus: u8, _traffic_type: String, _frame_rate_hz: f64) -> Result<(), String> {
        Err("This device does not support virtual bus add".to_string())
    }

    /// Remove a virtual bus generator from a running session.
    fn remove_virtual_bus(&mut self, _bus: u8) -> Result<(), String> {
        Err("This device does not support virtual bus remove".to_string())
    }

    /// For multi-source sessions, return the source configurations.
    /// Default implementation returns None.
    fn broker_configs(&self) -> Option<Vec<broker::SourceConfig>> {
        None
    }

    /// Stop the current stream and update options in preparation for reconfigure.
    /// Called by `reconfigure_session` so it can emit events between stop and restart.
    /// Returns Ok(()) if the device supports reconfiguration.
    /// Default implementation returns an error.
    async fn prepare_reconfigure(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("This device does not support reconfiguration".to_string())
    }

    /// Complete a reconfigure by starting the new stream.
    /// Called after `prepare_reconfigure` and after events have been emitted.
    /// Default implementation returns an error.
    async fn complete_reconfigure(&mut self) -> Result<(), String> {
        Err("This device does not support reconfiguration".to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum LifecycleEvent {
    Created,
    Destroyed,
    /// A source paused or resumed.
    Updated,
}

impl LifecycleEvent {
    /// "updated" rides the "created" code: every global consumer re-fetches the
    /// roster on any lifecycle push and reads the answer from there, so a third
    /// code would be one nothing branches on.
    pub fn code(self) -> u8 {
        match self {
            LifecycleEvent::Created | LifecycleEvent::Updated => 0,
            LifecycleEvent::Destroyed => 1,
        }
    }
}

/// Payload for global session lifecycle events (emitted to all windows)
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SessionLifecyclePayload {
    /// The session ID
    pub session_id: String,
    pub event_type: LifecycleEvent,
    /// Device type (e.g., "gvret_tcp", "realtime") - only for "created"
    pub source_type: Option<String>,
    /// Current state - only for "created"
    pub state: Option<IOState>,
    /// Number of listeners
    pub subscriber_count: usize,
    /// Source profile IDs
    pub source_profile_ids: Vec<String>,
    /// The subscriber whose call caused the event: a created session's creator, or
    /// the caller of a teardown, which ignores the `destroyed` it hears.
    pub subscriber_id: Option<String>,
    /// True when a "destroyed" event was a deliberate user destroy (the app should
    /// reset to "No source" rather than fall back to the orphaned capture).
    #[serde(default)]
    pub reset: bool,
}

/// Set once at startup. Without it the Tauri events go nowhere, as in a unit test.
pub(super) static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn set_app_handle(app: AppHandle) {
    APP_HANDLE.set(app).ok();
}

/// Emit a Tauri event to every window.
pub(crate) fn emit_to_windows<S: Serialize + Clone>(event: &str, payload: S) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(event, payload);
    }
}

/// Emit a global session lifecycle event to all windows.
/// This event is NOT scoped to a session ID - it broadcasts to all windows.
pub fn emit_session_lifecycle(payload: SessionLifecyclePayload) {
    tlog!(
        "[lifecycle_event] Emitting '{:?}' for session '{}' (profiles: {:?})",
        payload.event_type, payload.session_id, payload.source_profile_ids
    );
    #[cfg(test)]
    EMITTED_LIFECYCLE.lock().unwrap().push(payload.clone());
    emit_to_windows("session-lifecycle", &payload);
    crate::ws::dispatch::send_session_lifecycle(&payload);
}

#[cfg(test)]
pub(crate) static EMITTED_LIFECYCLE: std::sync::Mutex<Vec<SessionLifecyclePayload>> = std::sync::Mutex::new(Vec::new());

/// Emit a session error signal and store for later retrieval.
///
/// Stores the error in both the startup-error map (for subscriber registration)
/// and the post-session TTL cache (for late-arriving fetches after session
/// destruction), then emits an empty signal for the frontend to fetch.
pub fn emit_session_error(session_id: &str, error: String) {
    store_startup_error(session_id, error.clone());
    post_session::store_error(session_id, error.clone());
    crate::ws::dispatch::send_session_error(session_id, ErrorSeverity::Fault, &error);
}

/// Report an error the source carries on through. Nothing is stored for a
/// joining window, and the frontend does not show it as a fault.
pub fn emit_routine_session_error(session_id: &str, error: &str) {
    crate::ws::dispatch::send_session_error(session_id, ErrorSeverity::Routine, error);
}

/// How the frontend treats a session error; the discriminant is its byte on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ErrorSeverity {
    /// Shown, and the session reads as errored.
    Fault,
    /// Logged only, such as one Modbus register group declining a read.
    Routine,
}

impl ErrorSeverity {
    pub fn code(self) -> u8 {
        self as u8
    }
}

/// Signal the frontend that the playback position has changed.
/// The frontend reads the stored position from PLAYBACK_POSITIONS.
pub fn signal_playback_position(session_id: &str) {
    if let Some(pos) = get_playback_position(session_id) {
        crate::ws::dispatch::send_playback_position(session_id, &pos);
    }
}

/// Signal the frontend that new frames are available for a session.
/// The frontend fetches frames via get_capture_frames_tail.
pub fn signal_frames_ready(session_id: &str) {
    crate::ws::dispatch::send_new_frames(session_id);
}

/// Signal the frontend that new bytes are available for a session.
/// Pushes the byte total and capture id (ByteCounts 0x19); the frontend fetches the rows
/// themselves from that capture via get_capture_bytes_tail.
pub fn signal_bytes_ready(session_id: &str) {
    crate::ws::dispatch::send_new_bytes(session_id);
}

/// Emit stream-ended signal with capture info.
///
/// Finalises the capture, stores info in the post-session cache for late-arriving
/// fetches, then emits an empty signal for the frontend to fetch via command.
pub fn emit_stream_ended(
    session_id: &str,
    reason: StreamEndReason,
    log_prefix: &str,
) {
    use crate::capture_store::{self, CaptureKind};

    let finalized = capture_store::finalize_session_captures(session_id);
    // Frames first, same precedence as `get_session_capture` — but read off what was
    // just finalised rather than the registry, which no longer lists these as streaming.
    let metadata = finalized.iter()
        .find(|m| m.kind == CaptureKind::Frames)
        .or(finalized.first());

    let (capture_id, capture_kind, count, time_range, capture_available) = match metadata {
        Some(m) => {
            (
                Some(m.id.clone()),
                Some(m.kind.clone()),
                m.count,
                match (m.start_time_us, m.end_time_us) {
                    (Some(start), Some(end)) => Some((start, end)),
                    _ => None,
                },
                m.count > 0,
            )
        }
        None => (None, None, 0, None, false),
    };

    // Store in post-session cache for late-arriving fetches
    let stream_ended_info = post_session::StreamEndedInfo {
        reason,
        capture_available,
        capture_id,
        capture_kind,
        count,
        time_range,
    };
    post_session::store_stream_ended(session_id, stream_ended_info.clone());

    crate::ws::dispatch::send_stream_ended(session_id, &stream_ended_info);
    tlog!(
        "[{}:{}] Stream ended (reason: {}, count: {})",
        log_prefix, session_id, reason.as_str(), count
    );
}

/// Emit capture-changed when session captures are created or orphaned. The
/// message carries the session's frames capture id, so the frontend needs no
/// round trip.
pub fn emit_capture_changed(session_id: &str) {
    crate::ws::dispatch::send_capture_changed(session_id);
}

/// Orphan captures for a session and emit capture-changed.
/// Stores orphaned capture IDs in the post-session cache so the frontend
/// can fetch them (e.g., for the onDestroyed callback).
pub fn emit_capture_orphaned_as_changed(session_id: &str, orphaned: Vec<crate::capture_store::OrphanedCaptureInfo>) {
    if !orphaned.is_empty() {
        let ids: Vec<String> = orphaned.iter().map(|o| o.capture_id.clone()).collect();
        post_session::store_orphaned_capture_ids(session_id, ids);
        emit_capture_changed(session_id);
    }
}

/// Emit device-connected signal when a device successfully connects.
///
/// Stores source info in the post-session TTL cache for late-arriving fetches,
/// then emits an empty signal for the frontend to fetch via command.
pub fn emit_device_connected(session_id: &str, source_type: &str, address: &str, bus_number: Option<u8>) {
    post_session::store_source(session_id, post_session::SourceInfo {
        source_type: source_type.to_string(),
        address: address.to_string(),
        bus: bus_number,
    });
    crate::ws::dispatch::send_device_connected(session_id, source_type, address, bus_number);
}

/// Payload for device-probe event (global, not session-scoped)
#[derive(Clone, Debug, Serialize)]
pub struct DeviceProbePayload {
    /// Profile ID that was probed
    pub profile_id: String,
    /// Device type (e.g., "gvret", "slcan", "gs_usb")
    pub source_type: String,
    /// Device address (e.g., "192.168.1.1:23", "/dev/ttyUSB0")
    pub address: String,
    /// Whether the probe was successful
    pub success: bool,
    /// Whether this was a cached result
    pub cached: bool,
    /// Number of buses available (on success)
    pub bus_count: u8,
    /// Error message (on failure)
    pub error: Option<String>,
}

/// Emit device-probe event when a device probe completes (global event).
pub fn emit_device_probe(app: &AppHandle, payload: DeviceProbePayload) {
    let _ = app.emit("device-probe", payload);
}
