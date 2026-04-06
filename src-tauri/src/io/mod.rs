// ui/src-tauri/src/io/mod.rs
//
// IO device abstraction for CAN data sources.
// Provides a common interface for different device types (GVRET, PostgreSQL, etc.)
// with session-based isolation for multiple concurrent connections.

// Core modules
pub mod codec; // Frame codec trait and implementations
mod error;
mod signal_throttle;
pub use signal_throttle::SignalThrottle;
pub mod post_session;
pub mod traits; // InterfaceTraits validation
mod types;

// Recorded sources (capture, csv, postgres)
mod recorded;

// Real-time drivers
pub mod gs_usb; // pub for Tauri command access
pub mod gvret; // GVRET TCP/USB driver
pub mod modbus_tcp; // pub for scanner command access
pub mod modbus_rtu; // Modbus RTU master over serial
mod mqtt;
mod broker;
mod virtual_device;
#[cfg(not(target_os = "ios"))]
pub mod serial; // pub for Tauri command access (list_serial_ports)
#[cfg(not(target_os = "ios"))]
pub mod slcan; // pub for slcan transmit_frame access
pub mod framelink;
mod socketcan;

// Re-export recorded sources
pub use recorded::{step_frame, CaptureSource, StepResult};
pub use recorded::{
    parse_csv_file, parse_csv_with_mapping, preview_csv_file, CsvColumnMapping, CsvPreview,
    Delimiter, SequenceGap, TimestampUnit,
};
pub use recorded::{PostgresConfig, PostgresSource, PostgresSourceOptions, PostgresSourceType};

// Re-export codec types (platform-specific codecs are conditionally exported from codec.rs)
#[allow(unused_imports)]
pub use codec::FrameCodec;
#[allow(unused_imports)]
pub use gvret::GvretCodec;
#[cfg(not(target_os = "ios"))]
#[allow(unused_imports)]
pub use codec::SlcanCodec;
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[allow(unused_imports)]
pub use codec::GsUsbCodec;
#[cfg(target_os = "linux")]
#[allow(unused_imports)]
pub use codec::{SocketCanCodec, SocketCanEncodedFrame};

// Re-export driver types
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[allow(unused_imports)]
pub use gs_usb::GsUsbConfig;
pub use gvret::{BusMapping, GvretDeviceInfo, probe_gvret_tcp};
pub use modbus_tcp::{
    ModbusTcpConfig, ModbusTcpSource, PollGroup,
    ModbusScanConfig, ScanCompletePayload, UnitIdScanConfig,
};
#[cfg(not(target_os = "ios"))]
pub use gvret::probe_gvret_usb;
pub use broker::{ModbusRole, IOBroker, SourceConfig};
pub use mqtt::{MqttConfig, MqttSource};
pub use virtual_device::{VirtualDeviceConfig, VirtualSource, VirtualInterfaceConfig, VirtualTrafficType};
#[cfg(not(target_os = "ios"))]
#[allow(unused_imports)]
pub use serial::Parity;

// Error types
#[allow(unused_imports)]
pub use error::IoError;

// Note: SlcanConfig, SlcanReader, SocketCanConfig, SocketIOSource are used internally
// by IOBroker but not exported from mod.rs since all real-time devices now
// go through IOBroker

use async_trait::async_trait;
#[cfg(not(target_os = "ios"))]
use keepawake::{Builder as KeepAwakeBuilder, KeepAwake};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use crate::{capture_store, sessions};

// ============================================================================
// Shared Types (used by multiple readers)
// ============================================================================

/// Parsed frame message - the main data structure emitted by all readers
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrameMessage {
    pub protocol: String, // e.g., "can", "modbus", "serial"
    /// Host UNIX timestamp in microseconds.
    pub timestamp_us: u64,
    pub frame_id: u32,
    pub bus: u8,
    pub dlc: u8,
    pub bytes: Vec<u8>,
    // CAN-specific flags (ignored by other protocols)
    pub is_extended: bool,
    pub is_fd: bool,
    /// Source address (for protocols like J1939, TWC that embed sender ID in frame)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_address: Option<u16>,
    /// Indicates incomplete frame (e.g., no delimiter found at end of stream)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub incomplete: Option<bool>,
    /// Direction: "rx" for received, "tx" for transmitted
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub direction: Option<String>,
}

/// Playback position - stored and signalled via playback-position events during capture streaming
#[derive(Clone, Serialize)]
pub struct PlaybackPosition {
    /// Current timestamp in microseconds
    pub timestamp_us: i64,
    /// Current frame index (0-based)
    pub frame_index: usize,
    /// Total frame count in capture (optional, for recorded sources)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_count: Option<usize>,
}

/// Per-bus signal generator state (returned to frontend for virtual devices)
#[derive(Clone, Serialize)]
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

/// CAN frame for transmission
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CanTransmitFrame {
    /// CAN frame ID (11-bit standard or 29-bit extended)
    pub frame_id: u32,
    /// Frame data (up to 8 bytes for classic CAN, up to 64 for CAN FD)
    pub data: Vec<u8>,
    /// Bus number (0 for single-bus adapters, 0-4 for multi-bus like GVRET)
    pub bus: u8,
    /// Extended (29-bit) frame ID
    pub is_extended: bool,
    /// CAN FD frame
    pub is_fd: bool,
    /// Bit Rate Switch (CAN FD only)
    pub is_brs: bool,
    /// Remote Transmission Request
    pub is_rtr: bool,
}

/// Result of a transmit operation
#[derive(Clone, Debug, Serialize, Deserialize)]
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
pub enum TemporalMode {
    /// Real-time streaming from live devices (GVRET, slcan, gs_usb, SocketCAN, MQTT)
    Realtime,
    /// Playback from recorded sources (PostgreSQL, CSV)
    Recorded,
    /// Buffer replay from in-memory captured data
    Buffer,
}

/// Protocol family for frame-based communication
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    /// CAN 2.0A/2.0B (standard/extended)
    Can,
    /// CAN FD (flexible data rate) - compatible with Can
    #[serde(rename = "canfd")]
    CanFd,
    /// Modbus RTU/TCP
    Modbus,
    /// Raw serial bytes
    Serial,
}

/// Combined interface traits for formal session/interface characterization
#[derive(Clone, Debug, Serialize, Deserialize)]
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
pub struct SessionDataStreams {
    /// Whether this session emits framed messages (`frame-message` events)
    pub rx_frames: bool,
    /// Whether this session emits raw byte streams (`bytes-ready` signal)
    pub rx_bytes: bool,
}

/// IO device capabilities - what this device type supports
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IOCapabilities {
    /// Supports pause/resume (PostgreSQL: true, GVRET: false)
    pub can_pause: bool,
    /// Supports time range filtering (PostgreSQL: true, GVRET: false)
    pub supports_time_range: bool,
    /// Supports speed control (PostgreSQL: true, GVRET: false)
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
        }
    }

    /// Create capabilities for a recorded/replay CAN source (capture, csv, postgres).
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
pub enum IOState {
    Stopped,
    Starting,
    Running,
    Paused,
    Error(String),
}

/// Options for replacing a session's device in-place.
pub struct ReplaceSourceOptions {
    /// Human-readable transition name ("buffer", "live", "reinitialize")
    pub transition: String,
    /// Whether to auto-start the new device after swapping
    pub auto_start: bool,
    /// New source_names to set on the session (None = keep existing)
    pub source_names: Option<Vec<String>>,
    /// New source_configs to set on the session (None = keep existing)
    pub source_configs: Option<Vec<SourceConfig>>,
}

/// Payload emitted when a session's device is replaced in-place.
#[derive(Clone, Debug, Serialize)]
pub struct SourceReplacedPayload {
    /// Previous device type (e.g., "realtime", "capture")
    pub previous_source_type: String,
    /// New device type
    pub new_source_type: String,
    /// New capabilities after the swap
    pub capabilities: IOCapabilities,
    /// New IO state after the swap
    pub state: String,
    /// Context hint for the frontend ("buffer", "live", "reinitialize")
    pub transition: String,
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
    fn update_source_bus_mappings(&mut self, _profile_id: &str, _bus_mappings: Vec<gvret::BusMapping>) -> Result<(), String> {
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

// ============================================================================
// Session Management
// ============================================================================

/// Heartbeat timeout - listeners that haven't sent a heartbeat in this time are considered stale.
/// Set to 30s (up from 10s) to tolerate WKWebView timer throttling during display sleep.
const HEARTBEAT_TIMEOUT_SECS: u64 = 30;
/// How often to check for stale listeners
const HEARTBEAT_CHECK_INTERVAL_SECS: u64 = 5;
/// Grace period before destroying a session after all listeners go stale.
/// During this window the reader is paused (no frame emission) but the session
/// stays alive so it can resume if heartbeats return (e.g., after display wake).
const SUSPENSION_GRACE_PERIOD_SECS: u64 = 300; // 5 minutes

/// A registered listener for an IO session
#[derive(Clone, Debug)]
pub struct SessionSubscriber {
    /// Unique ID for this listener instance (e.g., "discovery_1", "decoder_2")
    pub subscriber_id: String,
    /// Human-readable app name (e.g., "discovery", "decoder")
    pub app_name: String,
    /// When this listener was registered
    pub registered_at: std::time::Instant,
    /// Last heartbeat from this listener
    pub last_heartbeat: std::time::Instant,
    /// Whether this listener is active (receiving frames). Set to false when detaching.
    pub is_active: bool,
}

/// Active IO session
pub struct IOSession {
    pub source: Box<dyn IOSource>,
    pub app: AppHandle,
    /// Number of apps connected to this session (legacy counter, for backwards compatibility)
    pub joiner_count: usize,
    /// Map of listener IDs to their listener info (replaces joiner_heartbeats)
    pub subscribers: HashMap<String, SessionSubscriber>,
    /// Display names of the sources in this session (for logging)
    pub source_names: Vec<String>,
    /// Original source configs for rebuilding the live reader on resume.
    /// Empty for non-multi-source sessions (recorded, buffer).
    pub source_configs: Vec<SourceConfig>,
    /// When all listeners went stale. During this grace period the reader is paused
    /// but the session stays alive, allowing recovery after display sleep / App Nap.
    pub suspended_at: Option<std::time::Instant>,
}

/// Convert IOState to a simple string for TypeScript
fn state_to_string(state: &IOState) -> String {
    match state {
        IOState::Stopped => "stopped".to_string(),
        IOState::Starting => "starting".to_string(),
        IOState::Running => "running".to_string(),
        IOState::Paused => "paused".to_string(),
        IOState::Error(msg) => format!("error:{}", msg),
    }
}

/// Emit a state change event for a session
fn emit_state_change(session_id: &str, _previous: &IOState, current: &IOState) {
    crate::ws::dispatch::send_session_state(session_id, current);
}

/// Emit a joiner count change event for a session.
/// Sends speed = -1.0 as a sentinel meaning "no speed update".
fn emit_joiner_count_change(
    session_id: &str,
    joiner_count: usize,
    _subscriber_id: Option<&str>,
    _app_name: Option<&str>,
    _change: Option<&str>,
) {
    crate::ws::dispatch::send_session_info(session_id, -1.0, joiner_count as u16);
}

/// Emit a speed change event for a session.
/// Sends subscriber_count = 0xFFFF as a sentinel meaning "no listener count update".
fn emit_speed_change(session_id: &str, speed: f64) {
    crate::ws::dispatch::send_session_info(session_id, speed, 0xFFFF);
}

/// Global session manager
static IO_SESSIONS: Lazy<Mutex<HashMap<String, IOSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Playback position cache — updated during capture/recorded streaming, polled by frontend
static PLAYBACK_POSITIONS: Lazy<RwLock<HashMap<String, PlaybackPosition>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub fn store_playback_position(session_id: &str, position: PlaybackPosition) {
    if let Ok(mut positions) = PLAYBACK_POSITIONS.write() {
        positions.insert(session_id.to_string(), position);
    }
}

pub fn get_playback_position(session_id: &str) -> Option<PlaybackPosition> {
    PLAYBACK_POSITIONS.read().ok().and_then(|p| p.get(session_id).cloned())
}

pub fn clear_playback_position(session_id: &str) {
    if let Ok(mut positions) = PLAYBACK_POSITIONS.write() {
        positions.remove(session_id);
    }
}

/// Sessions that are currently closing (window close in progress)
/// Uses RwLock (not async Mutex) so it can be checked synchronously
static CLOSING_SESSIONS: Lazy<RwLock<HashSet<String>>> = Lazy::new(|| RwLock::new(HashSet::new()));

// ============================================================================
// Wake Lock Management (prevents system sleep during active sessions)
// ============================================================================

/// Settings for wake lock behaviour
#[derive(Clone, Debug)]
pub struct WakeSettings {
    pub prevent_idle_sleep: bool,
    pub keep_display_awake: bool,
}

impl Default for WakeSettings {
    fn default() -> Self {
        Self {
            prevent_idle_sleep: true,
            keep_display_awake: false,
        }
    }
}

/// Cached wake settings (updated by frontend when settings change)
static WAKE_SETTINGS: Lazy<RwLock<WakeSettings>> = Lazy::new(|| RwLock::new(WakeSettings::default()));

/// Active wake lock guard (holds system awake while Some)
#[cfg(not(target_os = "ios"))]
static WAKE_LOCK: Lazy<std::sync::Mutex<Option<KeepAwake>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

/// Update the cached wake settings (called by Tauri command when settings change)
pub fn set_wake_settings(prevent_idle_sleep: bool, keep_display_awake: bool) {
    if let Ok(mut settings) = WAKE_SETTINGS.write() {
        settings.prevent_idle_sleep = prevent_idle_sleep;
        settings.keep_display_awake = keep_display_awake;
        tlog!(
            "[wake] Settings updated: prevent_idle_sleep={}, keep_display_awake={}",
            prevent_idle_sleep, keep_display_awake
        );
    }
}

/// Update the wake lock based on current session state and settings.
/// Called periodically by the heartbeat watchdog.
#[cfg(not(target_os = "ios"))]
async fn update_wake_lock() {
    // Read current settings
    let settings = match WAKE_SETTINGS.read() {
        Ok(s) => s.clone(),
        Err(_) => return,
    };

    // If both settings are disabled, ensure no wake lock is held
    if !settings.prevent_idle_sleep && !settings.keep_display_awake {
        if let Ok(mut guard) = WAKE_LOCK.lock() {
            if guard.is_some() {
                *guard = None;
                tlog!("[wake] Released wake lock (settings disabled)");
            }
        }
        return;
    }

    // Check if any session is actively running with listeners
    let sessions = IO_SESSIONS.lock().await;
    let any_active = sessions.values().any(|session| {
        matches!(session.source.state(), IOState::Running) && !session.subscribers.is_empty()
    });
    drop(sessions);

    // Update wake lock based on session state
    if let Ok(mut guard) = WAKE_LOCK.lock() {
        match (any_active, guard.is_some()) {
            (true, false) => {
                // Need to acquire wake lock
                match KeepAwakeBuilder::default()
                    .idle(settings.prevent_idle_sleep)
                    .display(settings.keep_display_awake)
                    .reason("WireTAP session active")
                    .app_name("WireTAP")
                    .app_reverse_domain("com.wiredsquare.wiretap")
                    .create()
                {
                    Ok(lock) => {
                        *guard = Some(lock);
                        tlog!(
                            "[wake] Acquired wake lock (idle={}, display={})",
                            settings.prevent_idle_sleep, settings.keep_display_awake
                        );
                    }
                    Err(e) => {
                        tlog!("[wake] Failed to acquire wake lock: {:?}", e);
                    }
                }
            }
            (false, true) => {
                // Release wake lock
                *guard = None;
                tlog!("[wake] Released wake lock (no active sessions)");
            }
            _ => {
                // No change needed
            }
        }
    }
}

/// iOS stub - wake lock not supported
#[cfg(target_os = "ios")]
async fn update_wake_lock() {
    // No-op on iOS - system handles power management differently
}

// ============================================================================
// WebView Health Monitoring (detects WKWebView content process jettison)
// ============================================================================

/// How long after suspension before we start probing the WebView (seconds).
/// Gives time for normal display-sleep recovery via visibilitychange heartbeats.
const PROBE_START_DELAY_SECS: u64 = 15;

/// Number of consecutive pings with no pong before triggering recovery.
/// At one ping per watchdog tick (5s), this is 30s of probing.
const PROBE_MAX_MISSES: u64 = 6;

/// App handle for the watchdog to access WebView windows.
static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// WebView health probing state.
struct WebViewHealthState {
    probing: bool,
    probe_started_at: Option<std::time::Instant>,
    probe_counter: u64,
    last_pong_counter: u64,
    reload_in_progress: bool,
    /// Set on recovery, cleared when frontend reads it.
    recovery_occurred: bool,
}

static WEBVIEW_HEALTH: Lazy<std::sync::Mutex<WebViewHealthState>> = Lazy::new(|| {
    std::sync::Mutex::new(WebViewHealthState {
        probing: false,
        probe_started_at: None,
        probe_counter: 0,
        last_pong_counter: 0,
        reload_in_progress: false,
        recovery_occurred: false,
    })
});

/// Called by the frontend in response to a health ping from the watchdog.
#[tauri::command]
pub fn webview_health_pong(counter: u64) {
    if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
        state.last_pong_counter = counter;
    }
}

/// Check whether a recovery occurred (one-shot: cleared after reading).
#[tauri::command]
pub fn check_recovery_occurred() -> bool {
    WEBVIEW_HEALTH
        .lock()
        .map(|mut s| {
            let occurred = s.recovery_occurred;
            s.recovery_occurred = false;
            occurred
        })
        .unwrap_or(false)
}

/// Probe the WebView to determine if the content process is still alive.
/// Called every watchdog tick while any session is suspended.
async fn check_webview_health() {
    let app = match APP_HANDLE.get() {
        Some(a) => a,
        None => return,
    };

    // Check if any session is in the suspension grace period
    let any_suspended_long_enough = {
        let sessions = IO_SESSIONS.lock().await;
        let now = std::time::Instant::now();
        let delay = std::time::Duration::from_secs(PROBE_START_DELAY_SECS);
        sessions.values().any(|s| {
            s.suspended_at
                .map(|at| now.duration_since(at) > delay)
                .unwrap_or(false)
        })
    };

    if !any_suspended_long_enough {
        // No sessions have been suspended long enough — reset probing
        if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
            if state.probing {
                tlog!("[webview health] No suspended sessions — stopping probes");
                state.probing = false;
                state.probe_started_at = None;
                state.probe_counter = 0;
                state.last_pong_counter = 0;
            }
        }
        return;
    }

    let mut should_recover = false;

    if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
        if state.reload_in_progress {
            return; // Recovery already in progress
        }

        if !state.probing {
            // Start probing
            tlog!("[webview health] Starting content process probes");
            state.probing = true;
            state.probe_started_at = Some(std::time::Instant::now());
            state.probe_counter = 0;
            state.last_pong_counter = 0;
        }

        // Send a ping via eval()
        state.probe_counter += 1;
        let counter = state.probe_counter;
        let misses = counter.saturating_sub(state.last_pong_counter);

        if misses > PROBE_MAX_MISSES {
            let rss = get_rss_mb().map(|m| format!("{:.1} MB", m)).unwrap_or_else(|| "unknown".to_string());
            tlog!(
                "[webview health] {} pings with no pong — content process appears dead (RSS: {})",
                misses, rss
            );
            should_recover = true;
        } else {
            // Send ping to the dashboard WebView
            let js = format!(
                "if(window.__TAURI_INTERNALS__){{window.__TAURI_INTERNALS__.invoke('webview_health_pong',{{counter:{}}})}}",
                counter
            );
            if let Some(window) = app.get_webview_window("dashboard") {
                let _ = window.eval(&js);
                tlog!(
                    "[webview health] Sent ping #{}, last pong={}, misses={}",
                    counter, state.last_pong_counter, misses
                );
            }
        }
    }

    if should_recover {
        trigger_webview_recovery(app).await;
    }
}

/// Reload the WebView page to recover from a content process jettison.
async fn trigger_webview_recovery(app: &AppHandle) {
    // Set flags
    if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
        if state.reload_in_progress {
            return;
        }
        state.reload_in_progress = true;
        state.recovery_occurred = true;
    }

    tlog!("[webview recovery] Content process appears dead — triggering reload");

    // Small delay to let any in-flight IPC settle
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Navigate to the app root (fresh navigation, safer than reload())
    // Wrap in catch_unwind because wry can panic with unwrap() on None
    // when the WKWebView content process has been jettisoned by macOS.
    if let Some(window) = app.get_webview_window("dashboard") {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match window.url() {
                Ok(current_url) => {
                    let mut root_url = current_url.clone();
                    root_url.set_path("/");
                    root_url.set_query(None);
                    root_url.set_fragment(None);
                    match window.navigate(root_url) {
                        Ok(()) => tlog!("[webview recovery] navigate() succeeded"),
                        Err(e) => tlog!("[webview recovery] navigate() failed: {}", e),
                    }
                }
                Err(e) => {
                    tlog!("[webview recovery] Failed to get current URL: {} — trying tauri://localhost", e);
                    if let Ok(fallback) = "tauri://localhost/".parse() {
                        let _ = window.navigate(fallback);
                    }
                }
            }
        }));
        if result.is_err() {
            tlog!("[webview recovery] WebView navigate panicked (content process gone) — recovery not possible");
        }
    } else {
        tlog!("[webview recovery] No dashboard window found");
    }

    // Wait for the page to load, then reset probing state
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
        state.reload_in_progress = false;
        state.probing = false;
        state.probe_started_at = None;
        state.probe_counter = 0;
        state.last_pong_counter = 0;
    }
    tlog!("[webview recovery] Recovery complete — probing state reset");
}

// ============================================================================
// Startup Errors
// ============================================================================

/// Startup errors for sessions (errors that occurred before any listener registered).
/// Uses RwLock (not async Mutex) so it can be set synchronously.
/// The error is retrieved and cleared when the first listener registers.
static STARTUP_ERRORS: Lazy<RwLock<HashMap<String, String>>> = Lazy::new(|| RwLock::new(HashMap::new()));

/// Store a startup error for a session (called when error occurs with no listeners)
pub fn store_startup_error(session_id: &str, error: String) {
    if let Ok(mut errors) = STARTUP_ERRORS.write() {
        tlog!("[reader] Storing startup error for session '{}': {}", session_id, error);
        errors.insert(session_id.to_string(), error);
    }
}

/// Take (retrieve and remove) the startup error for a session
pub fn take_startup_error(session_id: &str) -> Option<String> {
    if let Ok(mut errors) = STARTUP_ERRORS.write() {
        errors.remove(session_id)
    } else {
        None
    }
}

/// Read the startup error without removing it (for signal-then-fetch polling)
pub fn get_startup_error(session_id: &str) -> Option<String> {
    STARTUP_ERRORS.read().ok().and_then(|e| e.get(session_id).cloned())
}

/// Clear any startup error for a session (called on session destroy)
fn clear_startup_error(session_id: &str) {
    if let Ok(mut errors) = STARTUP_ERRORS.write() {
        errors.remove(session_id);
    }
}

/// Mark a session as closing (sync version for use in window event handler)
/// This prevents further events from being emitted to the closing window.
/// Returns true if this is the first time marking as closing, false if already closing.
/// Only used by window close handler which is desktop-only.
#[cfg(not(target_os = "ios"))]
pub fn mark_session_closing_sync(session_id: &str) -> bool {
    if let Ok(mut closing) = CLOSING_SESSIONS.write() {
        let is_new = closing.insert(session_id.to_string());
        if is_new {
            tlog!("[reader] Marked session '{}' as closing", session_id);
        }
        is_new
    } else {
        false
    }
}

/// Clear the closing flag for a session (called after destroy)
fn clear_session_closing(session_id: &str) {
    if let Ok(mut closing) = CLOSING_SESSIONS.write() {
        closing.remove(session_id);
    }
}


/// Payload for global session lifecycle events (emitted to all windows)
#[derive(Clone, Debug, Serialize)]
pub struct SessionLifecyclePayload {
    /// The session ID
    pub session_id: String,
    /// Event type: "created" or "destroyed"
    pub event_type: String,
    /// Device type (e.g., "gvret_tcp", "realtime") - only for "created"
    pub source_type: Option<String>,
    /// Current state - only for "created"
    pub state: Option<String>,
    /// Number of listeners
    pub subscriber_count: usize,
    /// Source profile IDs
    pub source_profile_ids: Vec<String>,
    /// The listener ID that created the session (only for "created")
    pub creator_subscriber_id: Option<String>,
}

/// Emit a global session lifecycle event to all windows.
/// This event is NOT scoped to a session ID - it broadcasts to all windows.
pub fn emit_session_lifecycle(app: &AppHandle, payload: SessionLifecyclePayload) {
    tlog!(
        "[lifecycle_event] Emitting '{}' for session '{}' (profiles: {:?})",
        payload.event_type, payload.session_id, payload.source_profile_ids
    );
    let _ = app.emit("session-lifecycle", &payload);
    crate::ws::dispatch::send_session_lifecycle(&payload);
}

/// Emit a session error signal and store for later retrieval.
///
/// Stores the error in both the startup-error map (for listener registration)
/// and the post-session TTL cache (for late-arriving fetches after session
/// destruction), then emits an empty signal for the frontend to fetch.
pub fn emit_session_error(session_id: &str, error: String) {
    store_startup_error(session_id, error.clone());
    post_session::store_error(session_id, error.clone());
    crate::ws::dispatch::send_session_error(session_id, &error);
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
/// The frontend fetches bytes via get_capture_bytes_tail.
pub fn signal_bytes_ready(session_id: &str) {
    crate::ws::dispatch::send_capture_changed(session_id);
}

/// Emit stream-ended signal with capture info.
///
/// Finalises the capture, stores info in the post-session cache for late-arriving
/// fetches, then emits an empty signal for the frontend to fetch via command.
pub fn emit_stream_ended(
    session_id: &str,
    reason: &str,
    log_prefix: &str,
) {
    use crate::capture_store::{self, CaptureKind};

    let finalized = capture_store::finalize_session_captures(session_id);
    // Use the frame capture metadata (primary), fall back to first finalized
    let metadata = finalized.iter()
        .find(|m| m.kind == CaptureKind::Frames)
        .or(finalized.first());

    let (capture_id, capture_kind, count, time_range, capture_available) = match metadata {
        Some(m) => {
            let kind_str = match m.kind {
                CaptureKind::Frames => "frames",
                CaptureKind::Bytes => "bytes",
            };
            (
                Some(m.id.clone()),
                Some(kind_str.to_string()),
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
        reason: reason.to_string(),
        capture_available,
        capture_id: capture_id.clone(),
        capture_kind: capture_kind.clone(),
        count,
        time_range,
    };
    post_session::store_stream_ended(session_id, stream_ended_info.clone());

    crate::ws::dispatch::send_stream_ended(session_id, &stream_ended_info);
    tlog!(
        "[{}:{}] Stream ended (reason: {}, count: {})",
        log_prefix, session_id, reason, count
    );
}

/// Emit capture-changed signal when session captures are created or orphaned.
/// Frontend fetches current capture state via commands.
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

/// Result of creating or joining a session
#[derive(Clone, Debug, Serialize)]
pub struct CreateSessionResult {
    /// Session capabilities
    pub capabilities: IOCapabilities,
    /// Whether this was a new session (true) or joined existing (false)
    pub is_new: bool,
    /// Total listener count
    pub subscriber_count: usize,
}

/// Create a new IO session with an initial listener.
/// If a session with this ID already exists, joins the existing session instead.
/// This prevents race conditions when multiple apps start simultaneously.
pub async fn create_session(
    app: AppHandle,
    session_id: String,
    device: Box<dyn IOSource>,
    subscriber_id: Option<String>,
    app_name: Option<String>,
    source_names: Option<Vec<String>>,
    source_configs: Vec<SourceConfig>,
) -> CreateSessionResult {
    // Clear the closing flag in case this is a new session for a previously closed window
    clear_session_closing(&session_id);

    let mut sessions = IO_SESSIONS.lock().await;
    let now = std::time::Instant::now();

    // Check if session already exists - join it instead of overwriting
    if let Some(existing) = sessions.get_mut(&session_id) {
        let capabilities = existing.source.capabilities();
        let subscriber_count: usize;

        // Clear suspension if the session was in the grace period
        if existing.suspended_at.take().is_some() {
            tlog!(
                "[reader] Session '{}' clearing suspension (new listener joining)",
                session_id
            );
            // Resume will happen via register_subscriber or auto-start
        }

        if let Some(lid) = subscriber_id {
            // Check if already registered
            if let Some(listener) = existing.subscribers.get_mut(&lid) {
                // Already registered - update heartbeat
                listener.last_heartbeat = now;
            } else {
                // New listener joining existing session
                let resolved_name = app_name.clone().unwrap_or_else(|| lid.clone());
                existing.subscribers.insert(
                    lid.clone(),
                    SessionSubscriber {
                        subscriber_id: lid.clone(),
                        app_name: resolved_name.clone(),
                        registered_at: now,
                        last_heartbeat: now,
                        is_active: true, // New listeners are active by default
                    },
                );
                existing.joiner_count = existing.subscribers.len();

                tlog!(
                    "[reader] Session '{}' - listener '{}' joined existing session, total: {}",
                    session_id, lid, existing.subscribers.len()
                );

                // Emit joiner count change
                emit_joiner_count_change(&session_id, existing.subscribers.len(), Some(&lid), Some(&resolved_name), Some("joined"));
            }
            subscriber_count = existing.subscribers.len();
        } else {
            subscriber_count = existing.subscribers.len();
        }

        return CreateSessionResult {
            capabilities,
            is_new: false,
            subscriber_count,
        };
    }

    // No existing session - create new one
    let capabilities = device.capabilities();

    // Create initial listeners map
    let mut subscribers = HashMap::new();
    if let Some(lid) = subscriber_id.clone() {
        let resolved_name = app_name.unwrap_or_else(|| lid.clone());
        subscribers.insert(
            lid.clone(),
            SessionSubscriber {
                subscriber_id: lid.clone(),
                app_name: resolved_name,
                registered_at: now,
                last_heartbeat: now,
                is_active: true, // New listeners are active by default
            },
        );
        tlog!(
            "[reader] Session '{}' created with listener '{}', total: 1",
            session_id, lid
        );
    } else {
        tlog!("[reader] Session '{}' created with no initial listener", session_id);
    }

    let subscriber_count = subscribers.len().max(1);
    let source_type = device.source_type().to_string();
    let state = device.state();
    let app_for_event = app.clone();
    let session = IOSession {
        source: device,
        app,
        joiner_count: subscriber_count,
        subscribers,
        source_names: source_names.unwrap_or_default(),
        source_configs,
        suspended_at: None,
    };

    sessions.insert(session_id.clone(), session);

    // Emit global session lifecycle event (to all windows)
    // Use get_session_profile_ids() to get actual profile IDs (not display names)
    // Profile tracking is registered before create_session() is called
    let source_profile_ids = crate::sessions::get_session_profile_ids(&session_id);
    emit_session_lifecycle(&app_for_event, SessionLifecyclePayload {
        session_id: session_id.clone(),
        event_type: "created".to_string(),
        source_type: Some(source_type),
        state: Some(format!("{:?}", state)),
        subscriber_count,
        source_profile_ids,
        creator_subscriber_id: subscriber_id,
    });

    CreateSessionResult {
        capabilities,
        is_new: true,
        subscriber_count,
    }
}

/// Get the state of a reader session (None if session doesn't exist)
pub async fn get_session_state(session_id: &str) -> Option<IOState> {
    let sessions = IO_SESSIONS.lock().await;
    sessions.get(session_id).map(|s| s.source.state())
}

/// Get the capabilities of a session (None if session doesn't exist)
pub async fn get_session_capabilities(session_id: &str) -> Option<IOCapabilities> {
    let sessions = IO_SESSIONS.lock().await;
    sessions.get(session_id).map(|s| s.source.capabilities())
}

/// Get the joiner count for a session (0 if session doesn't exist)
pub async fn get_session_joiner_count(session_id: &str) -> usize {
    let sessions = IO_SESSIONS.lock().await;
    sessions.get(session_id).map(|s| s.joiner_count).unwrap_or(0)
}

/// Get the number of source configs in a multi-source session.
/// Returns 0 if the session doesn't exist or isn't a multi-source session.
pub async fn get_session_source_count(session_id: &str) -> usize {
    let sessions = IO_SESSIONS.lock().await;
    sessions
        .get(session_id)
        .and_then(|s| s.source.broker_configs())
        .map(|c| c.len())
        .unwrap_or(0)
}

/// Get the stored source configs for a session (used for resume-to-live).
/// Returns empty vec if session doesn't exist or has no stored configs.
pub async fn get_session_source_configs(session_id: &str) -> Vec<SourceConfig> {
    let sessions = IO_SESSIONS.lock().await;
    sessions
        .get(session_id)
        .map(|s| s.source_configs.clone())
        .unwrap_or_default()
}

/// Result of joining an existing session
#[derive(Clone, Debug, Serialize)]
pub struct JoinSessionResult {
    pub capabilities: IOCapabilities,
    pub state: IOState,
    pub capture_id: Option<String>,
    /// Kind of the active capture ("frames" or "bytes"), if any
    pub capture_kind: Option<String>,
    /// Number of apps connected to this session (including this one)
    pub joiner_count: usize,
}

/// Join an existing reader session (for session sharing between apps).
/// Returns session info if session exists, error if not.
/// The caller can then set up event listeners to receive frames and state changes.
/// Increments the joiner count.
pub async fn join_session(session_id: &str) -> Result<JoinSessionResult, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.joiner_count += 1;
    let joiner_count = session.joiner_count;

    // Emit joiner count change event to all listeners (legacy join - no listener ID)
    emit_joiner_count_change(session_id, joiner_count, None, None, Some("joined"));

    // Get session's frame capture
    let capture_ids = crate::capture_store::get_session_capture_ids(session_id);
    let (capture_id, capture_kind) = capture_ids.iter()
        .filter_map(|id| crate::capture_store::get_capture_metadata(id))
        .find(|m| m.kind == crate::capture_store::CaptureKind::Frames)
        .map(|m| (Some(m.id), Some("frames".to_string())))
        .unwrap_or((None, None));

    Ok(JoinSessionResult {
        capabilities: session.source.capabilities(),
        state: session.source.state(),
        capture_id,
        capture_kind,
        joiner_count,
    })
}

/// Leave a reader session without stopping it.
/// Decrements the joiner count. The frontend should stop listening to events after calling this.
/// Returns the new joiner count.
pub async fn leave_session(session_id: &str) -> Result<usize, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    if let Some(session) = sessions.get_mut(session_id) {
        session.joiner_count = session.joiner_count.saturating_sub(1);
        let joiner_count = session.joiner_count;

        // Emit joiner count change event to remaining listeners (legacy leave - no listener ID)
        emit_joiner_count_change(session_id, joiner_count, None, None, Some("left"));

        // If no joiners left, stop the session to prevent emitting to destroyed WebViews
        if joiner_count == 0 {
            let previous = session.source.state();
            if !matches!(previous, IOState::Stopped) {
                let _ = session.source.stop().await;
                let current = session.source.state();
                if previous != current {
                    emit_state_change(session_id, &previous, &current);
                }
            }
        }

        Ok(joiner_count)
    } else {
        // Session doesn't exist (may have been destroyed), that's fine
        Ok(0)
    }
}

/// Touch `last_heartbeat` for all listeners on the given sessions.
/// Called by the WS server when a client heartbeat arrives, bridging the WS
/// keepalive to the IO session watchdog so the frontend can skip per-listener
/// `register_session_listener` invoke polling.
pub async fn touch_subscriber_heartbeats(session_ids: &[String]) {
    let mut sessions = IO_SESSIONS.lock().await;
    let now = std::time::Instant::now();
    for sid in session_ids {
        if let Some(session) = sessions.get_mut(sid.as_str()) {
            for listener in session.subscribers.values_mut() {
                listener.last_heartbeat = now;
            }
        }
    }
}

// Legacy heartbeat_session and remove_listener functions removed
// Use register_subscriber and unregister_subscriber instead

/// Clean up stale listeners from all sessions.
/// Called periodically by the watchdog task.
///
/// When all listeners go stale, the session is NOT destroyed immediately.
/// Instead the reader is paused and a grace period starts. This tolerates
/// WKWebView timer throttling during display sleep / App Nap. If heartbeats
/// resume within the grace period, the session is resumed (see `register_subscriber`).
/// Only after `SUSPENSION_GRACE_PERIOD_SECS` does the watchdog destroy the session.
///
/// Returns a list of (session_id, removed_count, remaining_count) for sessions that had stale listeners.
pub async fn cleanup_stale_subscribers() -> Vec<(String, usize, usize)> {
    let mut results = Vec::new();
    let mut sessions_to_destroy: Vec<String> = Vec::new();
    let mut sessions_to_pause: Vec<String> = Vec::new();

    // Phase 1: Remove stale listeners while holding the lock
    {
        let mut sessions = IO_SESSIONS.lock().await;
        let now = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(HEARTBEAT_TIMEOUT_SECS);
        let grace = std::time::Duration::from_secs(SUSPENSION_GRACE_PERIOD_SECS);

        for (session_id, session) in sessions.iter_mut() {
            // Check if an already-suspended session has exceeded the grace period
            if let Some(suspended_at) = session.suspended_at {
                if now.duration_since(suspended_at) > grace {
                    // Don't destroy if a WebView health probe or recovery is in progress
                    let skip_destroy = WEBVIEW_HEALTH
                        .lock()
                        .map(|s| s.probing || s.reload_in_progress)
                        .unwrap_or(false);
                    if skip_destroy {
                        tlog!(
                            "[reader] Session '{}' exceeded grace period but WebView recovery in progress — skipping destroy",
                            session_id
                        );
                    } else {
                        tlog!(
                            "[reader] Session '{}' exceeded suspension grace period ({:?}), will destroy",
                            session_id,
                            now.duration_since(suspended_at)
                        );
                        sessions_to_destroy.push(session_id.clone());
                    }
                }
                // Skip listener cleanup for already-suspended sessions
                continue;
            }

            let before_count = session.subscribers.len();

            // Remove stale listeners
            session.subscribers.retain(|subscriber_id, listener| {
                let is_stale = now.duration_since(listener.last_heartbeat) > timeout;
                if is_stale {
                    tlog!(
                        "[reader] Session '{}' removing stale listener '{}' (no heartbeat for {:?})",
                        session_id,
                        subscriber_id,
                        now.duration_since(listener.last_heartbeat)
                    );
                }
                !is_stale
            });

            let after_count = session.subscribers.len();
            let removed_count = before_count - after_count;

            if removed_count > 0 {
                results.push((session_id.clone(), removed_count, after_count));

                // Sync the legacy joiner_count with listener count
                if session.joiner_count > after_count {
                    let old_count = session.joiner_count;
                    session.joiner_count = after_count;
                    tlog!(
                        "[reader] Session '{}' synced joiner_count {} -> {} after cleanup",
                        session_id, old_count, after_count
                    );

                    // Emit joiner count change (sync - no specific listener)
                    emit_joiner_count_change(session_id, after_count, None, None, None);

                    // If no listeners left, enter suspension grace period instead of destroying
                    if after_count == 0 {
                        tlog!(
                            "[reader] Session '{}' has no listeners left — entering suspension grace period ({}s)",
                            session_id, SUSPENSION_GRACE_PERIOD_SECS
                        );
                        session.suspended_at = Some(now);

                        // Pause the reader to stop frame emission (reduces IPC pressure
                        // while the WebView is throttled). Only pause if running.
                        if matches!(session.source.state(), IOState::Running) {
                            sessions_to_pause.push(session_id.clone());
                        }
                    }
                }
            }
        }
    } // Lock released here

    // Phase 2a: Pause suspended sessions (separate from lock to avoid holding it during async pause)
    for session_id in sessions_to_pause {
        tlog!("[reader watchdog] Pausing suspended session '{}'", session_id);
        if let Err(e) = pause_session(&session_id).await {
            tlog!("[reader watchdog] Failed to pause session '{}': {}", session_id, e);
        }
    }

    // Phase 2b: Destroy sessions that exceeded the grace period
    for session_id in sessions_to_destroy {
        tlog!("[reader watchdog] Destroying session '{}' (grace period expired)", session_id);
        if let Err(e) = destroy_session(&session_id).await {
            tlog!("[reader watchdog] Failed to destroy session '{}': {}", session_id, e);
        }
    }

    results
}

/// How often to log session status (seconds)
const STATUS_LOG_INTERVAL_SECS: u64 = 60;

/// Get process RSS (Resident Set Size) in MB using platform-specific APIs.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn get_rss_mb() -> Option<f64> {
    use std::mem;

    #[repr(C)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: [u32; 2],   // time_value_t
        system_time: [u32; 2], // time_value_t
        policy: i32,
        suspend_count: i32,
    }

    extern "C" {
        fn mach_task_self() -> u32;
        fn task_info(
            target_task: u32,
            flavor: u32,
            task_info_out: *mut MachTaskBasicInfo,
            task_info_out_count: *mut u32,
        ) -> i32;
    }

    const MACH_TASK_BASIC_INFO: u32 = 20;
    let mut info: MachTaskBasicInfo = unsafe { mem::zeroed() };
    let mut count = (mem::size_of::<MachTaskBasicInfo>() / mem::size_of::<u32>()) as u32;

    let kr = unsafe { task_info(mach_task_self(), MACH_TASK_BASIC_INFO, &mut info, &mut count) };
    if kr == 0 {
        Some(info.resident_size as f64 / (1024.0 * 1024.0))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn get_rss_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if line.starts_with("VmRSS:") {
            let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
            return Some(kb / 1024.0);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn get_rss_mb() -> Option<f64> {
    None // TODO: use GetProcessMemoryInfo if needed
}

/// Log current session status (for debugging)
async fn log_session_status() {
    let sessions = IO_SESSIONS.lock().await;
    let running_queries = crate::dbquery::get_running_queries().await;

    if sessions.is_empty() && running_queries.is_empty() {
        return; // Don't log if nothing active
    }

    tlog!("[session status] ========== Active Sessions ==========");
    for (session_id, session) in sessions.iter() {
        let state = match session.source.state() {
            IOState::Stopped => "stopped",
            IOState::Starting => "starting",
            IOState::Running => "running",
            IOState::Paused => "paused",
            IOState::Error(_) => "error",
        };
        let subscriber_ids: Vec<&str> = session.subscribers.keys().map(|s| s.as_str()).collect();
        let sources = if session.source_names.is_empty() {
            String::new()
        } else {
            format!(", sources={:?}", session.source_names)
        };
        let suspended = if let Some(at) = session.suspended_at {
            format!(", SUSPENDED for {:?}", std::time::Instant::now().duration_since(at))
        } else {
            String::new()
        };
        tlog!(
            "[session status]   '{}': state={}, listeners={} {:?}{}{}",
            session_id,
            state,
            session.subscribers.len(),
            subscriber_ids,
            sources,
            suspended
        );
    }
    if !running_queries.is_empty() {
        tlog!("[session status] ---------- Running Queries -----------");
        for (id, query) in running_queries {
            let elapsed = query.started_at.elapsed().as_secs();
            tlog!(
                "[session status]   '{}': type={}, profile={}, running for {}s",
                id, query.query_type, query.profile_id, elapsed
            );
        }
    }
    if let Some(rss_mb) = get_rss_mb() {
        tlog!("[session status]   Process RSS: {:.1} MB", rss_mb);
    }
    tlog!("[session status] =====================================");
}

/// Start the heartbeat watchdog task.
/// This runs in the background and periodically cleans up stale listeners,
/// probes WebView health, and logs session status.
pub fn start_heartbeat_watchdog(app: AppHandle) {
    APP_HANDLE.set(app).ok();
    tauri::async_runtime::spawn(async {
        let cleanup_interval = std::time::Duration::from_secs(HEARTBEAT_CHECK_INTERVAL_SECS);
        let status_interval = STATUS_LOG_INTERVAL_SECS / HEARTBEAT_CHECK_INTERVAL_SECS;
        let mut tick_count: u64 = 0;

        loop {
            tokio::time::sleep(cleanup_interval).await;
            tick_count += 1;

            // Cleanup stale listeners every tick
            let results = cleanup_stale_subscribers().await;
            for (session_id, removed, remaining) in results {
                tlog!(
                    "[reader watchdog] Session '{}': removed {} stale listeners, {} remaining",
                    session_id, removed, remaining
                );
            }

            // Probe WebView health (detects content process jettison)
            check_webview_health().await;

            // Update wake lock based on session state and settings
            update_wake_lock().await;

            // Log session status every STATUS_LOG_INTERVAL_SECS
            if tick_count % status_interval == 0 {
                log_session_status().await;
            }
        }
    });
}

/// Start a reader session
/// Returns the confirmed state after the operation.
pub async fn start_session(session_id: &str) -> Result<IOState, String> {
    tlog!("[reader] start_session('{}') called", session_id);
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| {
            tlog!("[reader] start_session('{}') - session not found!", session_id);
            format!("Session '{}' not found", session_id)
        })?;

    let previous = session.source.state();
    tlog!("[reader] start_session('{}') - previous state: {:?}", session_id, previous);

    // Idempotency: if already running, return success
    if matches!(previous, IOState::Running) {
        tlog!("[reader] start_session('{}') - already running, returning", session_id);
        return Ok(previous);
    }

    tlog!("[reader] start_session('{}') - calling device.start()...", session_id);
    session.source.start().await?;

    let current = session.source.state();
    tlog!("[reader] start_session('{}') - current state: {:?}", session_id, current);
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    Ok(current)
}

/// Stop a reader session
/// Returns the confirmed state after the operation.
pub async fn stop_session(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Idempotency: if already stopped, return success
    if matches!(previous, IOState::Stopped) {
        return Ok(previous);
    }

    session.source.stop().await?;

    let current = session.source.state();
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    Ok(current)
}

/// Suspend a reader session - stops streaming, finalizes capture, session stays alive.
/// The capture remains owned by the session and all joined apps can view it.
/// Use `resume_session_fresh` to start streaming again with a new capture.
/// Returns the confirmed state after the operation.
pub async fn suspend_session(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Idempotency: if already stopped, return success
    if matches!(previous, IOState::Stopped) {
        return Ok(previous);
    }

    // Stop the device (triggers emit_stream_ended which finalises the capture)
    session.source.stop().await?;

    // Emit session-lifecycle signal with inline state + capabilities
    let current = session.source.state();
    let caps = session.source.capabilities();
    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &current, &caps);

    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    tlog!(
        "[reader] suspend_session('{}') - capture finalized, session stays alive",
        session_id
    );

    Ok(current)
}

/// Replace a session's device in-place, keeping the session ID and all listeners.
///
/// This is the low-level primitive for device swaps. Callers handle domain-specific
/// logic (capture orchestration, profile tracking) before/after calling this.
///
/// Steps: stop old device → swap device → optionally update metadata → optionally
/// auto-start → emit `session-lifecycle` signal → emit state change.
///
/// Takes `&mut HashMap` so callers can hold the IO_SESSIONS lock across the
/// full operation (preventing double-lock).
pub async fn replace_session_source(
    sessions: &mut HashMap<String, IOSession>,
    session_id: &str,
    new_device: Box<dyn IOSource>,
    opts: ReplaceSourceOptions,
) -> Result<SourceReplacedPayload, String> {
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // 1. Stop old device (idempotent)
    let previous_state = session.source.state();
    if !matches!(previous_state, IOState::Stopped) {
        let _ = session.source.stop().await;
    }

    // 2. Record old device info
    let previous_source_type = session.source.source_type().to_string();

    // 3. Get new device info before swap
    let capabilities = new_device.capabilities();
    let new_source_type = new_device.source_type().to_string();

    // 4. Swap the device
    session.source = new_device;

    // 5. Update metadata if provided
    if let Some(names) = opts.source_names {
        session.source_names = names;
    }
    if let Some(configs) = opts.source_configs {
        session.source_configs = configs;
    }

    // 6. Clear suspension state
    session.suspended_at = None;

    // 7. Optionally auto-start
    if opts.auto_start {
        session.source.start().await?;
    }

    let current_state = session.source.state();
    let state_str = state_to_string(&current_state);

    // 8. Build result payload (still returned to callers, just not emitted as event)
    let payload = SourceReplacedPayload {
        previous_source_type: previous_source_type.clone(),
        new_source_type: new_source_type.clone(),
        capabilities: capabilities.clone(),
        state: state_str.clone(),
        transition: opts.transition.clone(),
    };

    // 9. Emit session-lifecycle signal with inline state + capabilities
    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &current_state, &capabilities);

    // 10. Emit state change if different
    if previous_state != current_state {
        emit_state_change(session_id, &previous_state, &current_state);
    }

    tlog!(
        "[io] replace_session_source('{}') {} → {} (transition: {}, state: {})",
        session_id, previous_source_type, new_source_type, opts.transition, state_str
    );

    Ok(payload)
}

/// Stop a realtime session and switch to capture replay atomically.
///
/// This combines suspend + switch_to_capture_replay in a single lock acquisition
/// and emits a `session-lifecycle:{sessionId}` signal so ALL listeners
/// on the session refresh their state.
///
/// If no capture exists (e.g. stopped before any frames), falls back to a normal
/// suspend.
pub async fn stop_and_switch_to_capture(app: &AppHandle, session_id: &str, speed: f64) -> Result<IOCapabilities, String> {
    let mut sessions = IO_SESSIONS.lock().await;

    // Stop the device first — stop() triggers emit_stream_ended which calls
    // finalize_capture(), so we must stop before looking up the capture.
    // Scoped to release the mutable borrow before calling replace_session_source.
    {
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;
        if !matches!(session.source.state(), IOState::Stopped) {
            session.source.stop().await?;
        }
    }

    // Look up the capture by session ownership (finalized during stop())
    let capture_ids = capture_store::get_session_capture_ids(session_id);
    let capture_id = capture_ids.iter()
        .filter_map(|id| capture_store::get_capture_metadata(id))
        .find(|m| m.kind == capture_store::CaptureKind::Frames)
        .map(|m| m.id.clone());

    // Try to switch to capture replay
    if let Some(ref bid) = capture_id {
        let _ = crate::capture_store::mark_capture_active(bid);

        // Domain-specific housekeeping before the swap
        capture_store::orphan_captures_for_session(session_id);
        let profile_ids = sessions::get_session_profile_ids(session_id);
        for profile_id in &profile_ids {
            crate::profile_tracker::unregister_usage_by_session(profile_id, session_id);
        }
        sessions::replace_session_profiles(session_id, &[bid.clone()]);

        let new_reader = CaptureSource::new(
            app.clone(),
            session_id.to_string(),
            bid.clone(),
            speed,
        );

        // Device is already stopped, so replace_session_source's stop is a no-op
        // replace_session_source emits session-lifecycle internally
        let result = replace_session_source(
            &mut sessions,
            session_id,
            Box::new(new_reader),
            ReplaceSourceOptions {
                transition: "buffer".to_string(),
                auto_start: false,
                source_names: None,
                source_configs: None,
            },
        ).await?;

        tlog!(
            "[reader] stop_and_switch_to_capture('{}') - switched to capture '{}'",
            session_id, bid
        );

        Ok(result.capabilities)
    } else {
        // No capture — fall back to normal suspend
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;

        let state = session.source.state();
        let caps = session.source.capabilities();
        crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &state, &caps);

        tlog!(
            "[reader] stop_and_switch_to_capture('{}') - no capture, fell back to suspend",
            session_id
        );

        Ok(caps)
    }
}

/// Resume a suspended session with a fresh capture.
/// The old capture is orphaned (becomes available for standalone viewing).
/// A new capture is created by the device's start() method.
/// Returns the confirmed state after the operation.
pub async fn resume_session_fresh(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Must be stopped to resume with new capture
    if !matches!(previous, IOState::Stopped) {
        return Err(format!(
            "Session must be stopped to resume with new capture (current: {:?})",
            previous
        ));
    }

    // Emit session-lifecycle signal with current state + capabilities before restart
    let caps = session.source.capabilities();
    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &previous, &caps);

    // Start the device - this will orphan old capture and create new one
    // Recorded sources (PostgreSQL, CSV, Capture) handle capture creation in start()
    session.source.start().await?;

    let current = session.source.state();
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    tlog!(
        "[reader] resume_session_fresh('{}') - device started with fresh capture",
        session_id
    );

    Ok(current)
}

/// Pause a reader session
/// Returns the confirmed state after the operation.
pub async fn pause_session(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Idempotency: if already paused, return success
    if matches!(previous, IOState::Paused) {
        return Ok(previous);
    }

    session.source.pause().await?;

    let current = session.source.state();
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    Ok(current)
}

/// Resume a reader session
/// Returns the confirmed state after the operation.
pub async fn resume_session(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Idempotency: if already running, return success
    if matches!(previous, IOState::Running) {
        return Ok(previous);
    }

    session.source.resume().await?;

    let current = session.source.state();
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    Ok(current)
}

/// Enable or disable traffic generation for a virtual device session
pub async fn set_session_traffic_enabled(session_id: &str, enabled: bool) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_traffic_enabled(enabled)
}

/// Enable or disable signal generator for a specific bus
pub async fn set_session_bus_traffic_enabled(session_id: &str, bus: u8, enabled: bool) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_bus_traffic_enabled(bus, enabled)
}

/// Update signal generator cadence for a specific bus
pub async fn set_session_bus_cadence(session_id: &str, bus: u8, frame_rate_hz: f64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_bus_cadence(bus, frame_rate_hz)
}

/// Query per-bus signal generator states
pub async fn get_session_virtual_bus_states(session_id: &str) -> Result<Vec<VirtualBusState>, String> {
    let sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.virtual_bus_states()
}

/// Add a virtual bus generator to a running session
pub async fn add_session_virtual_bus(session_id: &str, bus: u8, traffic_type: String, frame_rate_hz: f64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.add_virtual_bus(bus, traffic_type, frame_rate_hz)
}

/// Remove a virtual bus generator from a running session
pub async fn remove_session_virtual_bus(session_id: &str, bus: u8) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.remove_virtual_bus(bus)
}

/// Update speed for a reader session
pub async fn update_session_speed(session_id: &str, speed: f64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_speed(speed)?;

    // Emit speed change event to all listeners
    emit_speed_change(session_id, speed);

    Ok(())
}

/// Update time range for a reader session
pub async fn update_session_time_range(
    session_id: &str,
    start: Option<String>,
    end: Option<String>,
) -> Result<(), String> {
    tlog!(
        "[io] update_session_time_range called - session: {}, start: {:?}, end: {:?}",
        session_id,
        start,
        end
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions.get_mut(session_id).ok_or_else(|| {
        let err = format!("Session '{}' not found", session_id);
        tlog!("[io] update_session_time_range: {}", err);
        err
    })?;

    let result = session.source.set_time_range(start, end);
    if let Err(ref e) = result {
        tlog!("[io] update_session_time_range failed: {}", e);
    }
    result
}

/// Reconfigure a running session with new time range.
/// This stops the current stream, orphans the old capture, creates a new capture,
/// and starts streaming with the new time range - all while keeping the session alive.
/// Other apps joined to this session remain connected.
pub async fn reconfigure_session(
    session_id: &str,
    start: Option<String>,
    end: Option<String>,
) -> Result<(), String> {
    tlog!(
        "[io] reconfigure_session called - session: {}, start: {:?}, end: {:?}",
        session_id, start, end
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions.get_mut(session_id).ok_or_else(|| {
        let err = format!("Session '{}' not found", session_id);
        tlog!("[io] reconfigure_session: {}", err);
        err
    })?;

    // Phase 1: Stop the old stream and update options (no new frames after this)
    session.source.prepare_reconfigure(start.clone(), end.clone()).await?;

    // Emit session-reconfigured BETWEEN stop and start.
    // This ensures the event ordering in the frontend is:
    //   [stale frames from old stream] → [session-reconfigured] → [new frames]
    // The frontend clears stale frames when it receives this event.
    crate::ws::dispatch::send_reconfigured(session_id);

    // Phase 2: Start the new stream (orphans old capture, creates new one)
    let result = session.source.complete_reconfigure().await;
    if let Err(ref e) = result {
        tlog!("[io] reconfigure_session failed on restart: {}", e);
    } else {
        let state_after = session.source.state();
        tlog!(
            "[io] reconfigure_session completed successfully - final state: {:?}",
            state_after
        );
        // Force emit Stopped -> current to ensure UI updates to streaming state
        emit_state_change(session_id, &IOState::Stopped, &state_after);
    }
    result
}

/// Seek to a specific timestamp in microseconds
pub async fn seek_session(session_id: &str, timestamp_us: i64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.seek(timestamp_us)
}

/// Seek to a specific frame index (preferred for capture playback)
pub async fn seek_session_by_frame(session_id: &str, frame_index: i64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.seek_by_frame(frame_index)
}

/// Set playback direction (reverse = true for backwards playback)
pub async fn update_session_direction(session_id: &str, reverse: bool) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_direction(reverse)
}

/// Switch a session to capture replay mode.
/// This replaces the session's reader with a CaptureSource that reads from the session's
/// owned capture. The session stays alive and all listeners remain connected.
/// Use this after ingest completes to enable playback without destroying the session.
pub async fn switch_to_capture_replay(app: &AppHandle, session_id: &str, speed: f64) -> Result<IOCapabilities, String> {
    // Get the session's owned frame capture
    let capture_ids = crate::capture_store::get_session_capture_ids(session_id);
    let capture_id = capture_ids.iter()
        .filter_map(|id| crate::capture_store::get_capture_metadata(id).map(|m| (id.clone(), m)))
        .find(|(_id, m)| m.kind == crate::capture_store::CaptureKind::Frames)
        .map(|(id, _m)| id)
        .ok_or_else(|| {
            let captures = crate::capture_store::list_captures();
            tlog!(
                "[io] switch_to_capture_replay: No capture found for session '{}'. Available captures:",
                session_id
            );
            for cap in &captures {
                tlog!(
                    "  - {} (owner: {:?}, count: {})",
                    cap.id,
                    cap.owning_session_id,
                    cap.count
                );
            }
            format!("No capture found for session '{}'", session_id)
        })?;

    // Log capture details
    let capture_count = crate::capture_store::get_capture_count(&capture_id);
    tlog!(
        "[io] switch_to_capture_replay: session='{}', capture='{}', frames={}, speed={}",
        session_id, capture_id, capture_count, speed
    );

    let _ = crate::capture_store::mark_capture_active(&capture_id);

    // Create a new CaptureSource that reads from the session's capture
    let new_reader = CaptureSource::new(
        app.clone(),
        session_id.to_string(),
        capture_id,
        speed,
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let result = replace_session_source(
        &mut sessions,
        session_id,
        Box::new(new_reader),
        ReplaceSourceOptions {
            transition: "buffer".to_string(),
            auto_start: false,
            source_names: None,
            source_configs: None,
        },
    ).await?;

    Ok(result.capabilities)
}

/// Resume a session from capture playback back to live streaming.
/// This replaces the CaptureSource with a new live reader (passed in from the caller
/// who creates it from profile config). The session stays alive and all listeners
/// remain connected.
///
/// Steps:
/// 1. Replace device via `replace_session_source` (stops old, swaps, auto-starts)
/// 2. `replace_session_source` emits `session-lifecycle` signal so apps refresh state
pub async fn resume_to_live_session(
    session_id: &str,
    new_reader: Box<dyn IOSource>,
) -> Result<IOCapabilities, String> {
    tlog!(
        "[io] resume_to_live_session: session='{}' switching from capture to live",
        session_id
    );

    let mut sessions = IO_SESSIONS.lock().await;
    // replace_session_source emits session-lifecycle internally
    let result = replace_session_source(
        &mut sessions,
        session_id,
        new_reader,
        ReplaceSourceOptions {
            transition: "live".to_string(),
            auto_start: true,
            source_names: None,
            source_configs: None,
        },
    ).await?;

    Ok(result.capabilities)
}

/// Destroy a reader session
pub async fn destroy_session(session_id: &str) -> Result<(), String> {
    let removed = {
        let mut sessions = IO_SESSIONS.lock().await;
        sessions.remove(session_id)
    };
    // Lock released — perform slow operations outside the critical section
    if let Some(mut session) = removed {
        // Stop the reader first
        let _ = session.source.stop().await;
        // Orphan captures and store IDs in post-session cache before lifecycle event.
        // The frontend fetches orphaned capture IDs via command when it handles "destroyed".
        let orphaned = crate::capture_store::orphan_captures_for_session(session_id);
        emit_capture_orphaned_as_changed(session_id, orphaned);
        // Now emit lifecycle event
        let source_profile_ids = crate::sessions::get_session_profile_ids(session_id);
        emit_session_lifecycle(&session.app, SessionLifecyclePayload {
            session_id: session_id.to_string(),
            event_type: "destroyed".to_string(),
            source_type: None,
            state: None,
            subscriber_count: 0,
            source_profile_ids,
            creator_subscriber_id: None,
        });
    }
    // Clear the closing flag now that the session is fully destroyed
    clear_session_closing(session_id);
    // Clear any stored startup error
    clear_startup_error(session_id);
    clear_playback_position(session_id);
    // Don't sweep_expired here — the orphaned capture IDs were just stored
    // and need to survive long enough for the frontend to fetch them.
    Ok(())
}

/// Check if a session exists
#[allow(dead_code)]
pub async fn session_exists(session_id: &str) -> bool {
    let sessions = IO_SESSIONS.lock().await;
    sessions.contains_key(session_id)
}

/// Info about an active session (for listing)
#[derive(Clone, Debug, Serialize)]
pub struct ActiveSessionInfo {
    /// Session ID
    pub session_id: String,
    /// Device type (e.g., "gvret_tcp", "realtime")
    pub source_type: String,
    /// Current state
    pub state: IOState,
    /// Session capabilities
    pub capabilities: IOCapabilities,
    /// Number of listeners
    pub subscriber_count: usize,
    /// Individual listener details
    pub subscribers: Vec<SubscriberInfo>,
    /// For multi-source sessions: the source configurations
    pub broker_configs: Option<Vec<broker::SourceConfig>>,
    /// Profile IDs feeding this session (populated from SESSION_PROFILES in sessions.rs)
    #[serde(default)]
    pub source_profile_ids: Vec<String>,
    /// Capture ID owned by this session (if any)
    #[serde(default)]
    pub capture_id: Option<String>,
    /// Frame count in the owned capture
    #[serde(default)]
    pub capture_frame_count: Option<usize>,
    /// Whether the session is actively streaming data
    #[serde(default)]
    pub is_streaming: bool,
}

/// List all active sessions
pub async fn list_sessions() -> Vec<ActiveSessionInfo> {
    let sessions = IO_SESSIONS.lock().await;
    sessions
        .iter()
        .map(|(session_id, session)| {
            // Get source profile IDs from the session tracking
            let source_profile_ids = sessions::get_session_profile_ids(session_id);

            // Get capture info if this session owns a capture
            let capture_id = capture_store::get_session_capture_ids(session_id).into_iter().next();
            let capture_frame_count = capture_id
                .as_ref()
                .map(|id| capture_store::get_capture_count(id));

            // Check if session is actively streaming (running state)
            let is_streaming = matches!(session.source.state(), IOState::Running);

            // Build individual listener details
            let now = std::time::Instant::now();
            let subscribers: Vec<SubscriberInfo> = session
                .subscribers
                .values()
                .map(|l| SubscriberInfo {
                    subscriber_id: l.subscriber_id.clone(),
                    app_name: l.app_name.clone(),
                    registered_seconds_ago: now.duration_since(l.registered_at).as_secs(),
                    is_active: l.is_active,
                })
                .collect();

            ActiveSessionInfo {
                session_id: session_id.clone(),
                source_type: session.source.source_type().to_string(),
                state: session.source.state(),
                capabilities: session.source.capabilities(),
                subscriber_count: session.subscribers.len(),
                subscribers,
                broker_configs: session.source.broker_configs(),
                source_profile_ids,
                capture_id,
                capture_frame_count,
                is_streaming,
            }
        })
        .collect()
}

/// Transmit a payload through a session (unified)
pub async fn session_transmit(session_id: &str, payload: &TransmitPayload) -> Result<TransmitResult, String> {
    let sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let caps = session.source.capabilities();

    // Check if the reader supports the requested transmit type
    match payload {
        TransmitPayload::CanFrame(_) if !caps.traits.tx_frames => {
            return Err("This session does not support CAN transmission".to_string());
        }
        TransmitPayload::RawBytes(_) if !caps.traits.tx_bytes => {
            return Err("This session does not support serial transmission".to_string());
        }
        _ => {}
    }

    // Call device transmit — fire-and-forget for most devices.
    // Queues the frame into the device's transmit channel and returns
    // immediately. The lock is held only briefly for the channel send.
    session.source.transmit(payload)
}

/// Transmit a CAN frame through a session (convenience wrapper)
pub async fn transmit_frame(session_id: &str, frame: &CanTransmitFrame) -> Result<TransmitResult, String> {
    session_transmit(session_id, &TransmitPayload::CanFrame(frame.clone())).await
}

/// Transmit raw serial bytes through a session (convenience wrapper)
pub async fn transmit_serial(session_id: &str, bytes: &[u8]) -> Result<TransmitResult, String> {
    session_transmit(session_id, &TransmitPayload::RawBytes(bytes.to_vec())).await
}

// ============================================================================
// Listener Registration API
// ============================================================================

/// Info about a registered listener (for TypeScript)
#[derive(Clone, Debug, Serialize)]
pub struct SubscriberInfo {
    pub subscriber_id: String,
    /// Human-readable app name (e.g., "discovery", "decoder")
    pub app_name: String,
    /// Seconds since registration
    pub registered_seconds_ago: u64,
    /// Whether this listener is actively receiving frames
    pub is_active: bool,
}

/// Result of registering a listener
#[derive(Clone, Debug, Serialize)]
pub struct RegisterSubscriberResult {
    /// Session capabilities
    pub capabilities: IOCapabilities,
    /// Current session state
    pub state: IOState,
    /// Active capture ID (if any)
    pub capture_id: Option<String>,
    /// Capture kind ("frames" or "bytes")
    pub capture_kind: Option<String>,
    /// Total number of listeners
    pub subscriber_count: usize,
    /// Error that occurred before this listener registered (one-shot, cleared after return)
    pub startup_error: Option<String>,
}

/// Register a listener for a session.
/// This is the primary way for frontend components to join a session.
/// If the listener is already registered, this updates their heartbeat.
/// Returns session info for the registered listener.
pub async fn register_subscriber(session_id: &str, subscriber_id: &str, app_name: Option<&str>) -> Result<RegisterSubscriberResult, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let now = std::time::Instant::now();

    // Check if the session is in the suspension grace period. If a heartbeat
    // arrives while suspended, the WebView has recovered (e.g., display woke
    // up, App Nap ended). Clear the suspension and resume the reader.
    let needs_resume = if let Some(suspended_at) = session.suspended_at.take() {
        let suspended_for = now.duration_since(suspended_at);
        tlog!(
            "[reader] Session '{}' resuming from suspension (was suspended for {:?}, listener '{}' heartbeat)",
            session_id, suspended_for, subscriber_id
        );
        // Only resume if the device is paused (we paused it during suspension)
        matches!(session.source.state(), IOState::Paused)
    } else {
        false
    };

    if let Some(listener) = session.subscribers.get_mut(subscriber_id) {
        // Already registered - update heartbeat
        listener.last_heartbeat = now;
    } else {
        // New listener - register them
        let resolved_app_name = app_name.unwrap_or(subscriber_id).to_string();
        session.subscribers.insert(
            subscriber_id.to_string(),
            SessionSubscriber {
                subscriber_id: subscriber_id.to_string(),
                app_name: resolved_app_name.clone(),
                registered_at: now,
                last_heartbeat: now,
                is_active: true, // New listeners are active by default
            },
        );

        // Update legacy joiner_count
        session.joiner_count = session.subscribers.len();

        tlog!(
            "[reader] Session '{}' registered listener '{}', total: {}",
            session_id,
            subscriber_id,
            session.subscribers.len()
        );

        // Emit joiner count change
        emit_joiner_count_change(session_id, session.subscribers.len(), Some(subscriber_id), Some(&resolved_app_name), Some("joined"));
    }

    // Get session's frame capture
    let capture_ids = crate::capture_store::get_session_capture_ids(session_id);
    let (capture_id, capture_kind) = capture_ids.iter()
        .filter_map(|id| crate::capture_store::get_capture_metadata(id))
        .find(|m| m.kind == crate::capture_store::CaptureKind::Frames)
        .map(|m| (Some(m.id), Some("frames".to_string())))
        .unwrap_or((None, None));

    // Resume from suspension if needed (the reader was paused when listeners went stale)
    if needs_resume {
        let previous = session.source.state();
        match session.source.resume().await {
            Ok(()) => {
                let current = session.source.state();
                if previous != current {
                    emit_state_change(session_id, &previous, &current);
                }
                tlog!("[reader] Session '{}' reader resumed successfully", session_id);
            }
            Err(e) => {
                tlog!("[reader] Session '{}' failed to resume reader: {}", session_id, e);
            }
        }
    }

    // Retrieve any startup error (one-shot: cleared after retrieval)
    let startup_error = take_startup_error(session_id);
    if let Some(ref err) = startup_error {
        tlog!("[reader] Returning startup error for session '{}': {}", session_id, err);
    }

    Ok(RegisterSubscriberResult {
        capabilities: session.source.capabilities(),
        state: session.source.state(),
        capture_id,
        capture_kind,
        subscriber_count: session.subscribers.len(),
        startup_error,
    })
}

/// Unregister a listener from a session.
/// If this was the last listener, the session will be stopped and destroyed.
/// Returns the remaining listener count.
pub async fn unregister_subscriber(session_id: &str, subscriber_id: &str) -> Result<usize, String> {
    // Phase 1: Remove the listener under the lock, extract session if last listener left
    let (remaining, session_to_destroy) = {
        let mut sessions = IO_SESSIONS.lock().await;

        let Some(session) = sessions.get_mut(session_id) else {
            // Session doesn't exist - that's fine during cleanup
            return Ok(0);
        };

        let Some(removed) = session.subscribers.remove(subscriber_id) else {
            // Listener wasn't registered - that's fine
            return Ok(session.subscribers.len());
        };

        let removed_app_name = removed.app_name;
        session.joiner_count = session.subscribers.len();
        let remaining = session.subscribers.len();

        tlog!(
            "[reader] Session '{}' unregistered listener '{}', remaining: {}",
            session_id, subscriber_id, remaining
        );

        // Emit joiner count change
        emit_joiner_count_change(session_id, remaining, Some(subscriber_id), Some(&removed_app_name), Some("left"));

        if remaining == 0 {
            tlog!("[reader] Session '{}' has no listeners left, destroying", session_id);
            // Remove from map so we can release the lock before slow operations
            (remaining, sessions.remove(session_id))
        } else {
            (remaining, None)
        }
    };
    // Lock released here

    // Phase 2: Perform slow cleanup outside the critical section
    if let Some(mut session) = session_to_destroy {
        let _ = session.source.stop().await;
        // Orphan captures and store IDs in post-session cache before lifecycle event.
        let orphaned = crate::capture_store::orphan_captures_for_session(session_id);
        emit_capture_orphaned_as_changed(session_id, orphaned);
        // Now emit lifecycle event
        let source_profile_ids = crate::sessions::get_session_profile_ids(session_id);
        emit_session_lifecycle(&session.app, SessionLifecyclePayload {
            session_id: session_id.to_string(),
            event_type: "destroyed".to_string(),
            source_type: None,
            state: None,
            subscriber_count: 0,
            source_profile_ids,
            creator_subscriber_id: None,
        });
        // Clear any closing flag
        clear_session_closing(session_id);
        clear_playback_position(session_id);
        // Clean up profile tracking (release single-handle device locks)
        crate::sessions::cleanup_session_profiles(session_id);
        tlog!("[reader] Session '{}' destroyed", session_id);
    }

    Ok(remaining)
}

/// Evict a listener from a session, giving it a copy of the current capture.
/// This is used by the Session Manager to remove a listener without destroying the session.
/// The evicted listener receives a capture copy so it can continue viewing data standalone.
/// Returns the list of copied capture IDs.
pub async fn evict_session_subscriber(app: &AppHandle, session_id: &str, subscriber_id: &str) -> Result<Vec<String>, String> {
    // Copy the capture before unregistering (so the evicted listener gets a snapshot)
    let mut copied_capture_ids = Vec::new();
    if let Some(capture_id) = crate::capture_store::get_session_capture_ids(session_id).into_iter().next() {
        let copy_name = format!("{} (evicted)", subscriber_id);
        match crate::capture_store::copy_capture(&capture_id, copy_name) {
            Ok(copied_id) => {
                tlog!(
                    "[reader] Copied capture '{}' -> '{}' for evicted listener '{}'",
                    capture_id, copied_id, subscriber_id
                );
                copied_capture_ids.push(copied_id);
            }
            Err(e) => {
                tlog!(
                    "[reader] Failed to copy capture for evicted listener '{}': {}",
                    subscriber_id, e
                );
            }
        }
    }

    // Unregister the listener (this may destroy the session if it was the last one)
    let remaining = unregister_subscriber(session_id, subscriber_id).await?;

    // Emit listener-evicted event so the frontend can clean up the evicted app
    #[derive(Clone, Debug, Serialize)]
    struct ListenerEvictedPayload {
        session_id: String,
        subscriber_id: String,
        capture_ids: Vec<String>,
    }

    let payload = ListenerEvictedPayload {
        session_id: session_id.to_string(),
        subscriber_id: subscriber_id.to_string(),
        capture_ids: copied_capture_ids.clone(),
    };
    let _ = app.emit("subscriber-evicted", payload);

    tlog!(
        "[reader] Evicted listener '{}' from session '{}' (remaining: {}, capture copies: {:?})",
        subscriber_id, session_id, remaining, copied_capture_ids
    );

    Ok(copied_capture_ids)
}

/// Add a new source to an existing multi-source session.
/// Stops the current device, creates a new IOBroker with all sources (old + new),
/// swaps it into the session, and restarts. Keeps the same session ID and listeners.
pub async fn add_source_to_session(
    app: &AppHandle,
    session_id: &str,
    new_source: SourceConfig,
) -> Result<IOCapabilities, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // Get current source configs — only multi-source sessions support this
    let existing_configs = session.source.broker_configs()
        .ok_or_else(|| "Session does not support multi-source — cannot add a source".to_string())?;

    // Check for duplicate profile
    if existing_configs.iter().any(|c| c.profile_id == new_source.profile_id) {
        return Err(format!(
            "Profile '{}' is already a source in session '{}'",
            new_source.profile_id, session_id
        ));
    }

    let new_display_name = new_source.display_name.clone();

    // If the session is running, hot-add the source without stopping
    if matches!(session.source.state(), IOState::Running) {
        session.source.add_source_hot(new_source)?;
        session.source_names.push(new_display_name.clone());
        let capabilities = session.source.capabilities();
        tlog!(
            "[reader] Hot-added source '{}' to session '{}' (sources: {:?})",
            new_display_name, session_id, session.source_names
        );
        return Ok(capabilities);
    }

    // Cold path: session not running — rebuild the IOBroker
    let mut all_configs = existing_configs;
    all_configs.push(new_source);

    let source_display_names: Vec<String> = all_configs.iter()
        .map(|c| c.display_name.clone())
        .collect();

    let reader = IOBroker::new(app.clone(), session_id.to_string(), all_configs)?;
    let capabilities = reader.capabilities();

    session.source = Box::new(reader);
    session.source_names = source_display_names;

    tlog!(
        "[reader] Added source '{}' to session '{}' (sources: {:?})",
        new_display_name, session_id, session.source_names
    );

    Ok(capabilities)
}

/// Remove a source from an existing multi-source session.
/// Stops the current device, creates a new IOBroker with the remaining sources
/// (preserving their bus mappings), swaps it into the session, and restarts.
pub async fn remove_source_from_session(
    app: &AppHandle,
    session_id: &str,
    profile_id: &str,
) -> Result<IOCapabilities, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // Get current source configs — only multi-source sessions support this
    let existing_configs = session.source.broker_configs()
        .ok_or_else(|| "Session does not support multi-source — cannot remove a source".to_string())?;

    // Check the profile is actually a source
    if !existing_configs.iter().any(|c| c.profile_id == profile_id) {
        return Err(format!(
            "Profile '{}' is not a source in session '{}'",
            profile_id, session_id
        ));
    }

    // Must keep at least one source
    let remaining_count = existing_configs.iter().filter(|c| c.profile_id != profile_id).count();
    if remaining_count == 0 {
        return Err("Cannot remove the last source — destroy the session instead".to_string());
    }

    // If the session is running, hot-remove the source without stopping
    if matches!(session.source.state(), IOState::Running) {
        session.source.remove_source_hot(profile_id)?;
        // Rebuild source_names from current configs
        if let Some(configs) = session.source.broker_configs() {
            session.source_names = configs.iter().map(|c| c.display_name.clone()).collect();
        }
        let capabilities = session.source.capabilities();
        tlog!(
            "[reader] Hot-removed source '{}' from session '{}' (remaining: {:?})",
            profile_id, session_id, session.source_names
        );
        return Ok(capabilities);
    }

    // Cold path: session not running — rebuild the IOBroker
    let remaining_configs: Vec<_> = existing_configs
        .into_iter()
        .filter(|c| c.profile_id != profile_id)
        .collect();

    let source_display_names: Vec<String> = remaining_configs.iter()
        .map(|c| c.display_name.clone())
        .collect();

    let reader = IOBroker::new(app.clone(), session_id.to_string(), remaining_configs)?;
    let capabilities = reader.capabilities();

    session.source = Box::new(reader);
    session.source_names = source_display_names;

    tlog!(
        "[reader] Removed source '{}' from session '{}' (remaining sources: {:?})",
        profile_id, session_id, session.source_names
    );

    Ok(capabilities)
}

/// Pause polling for a specific source within a running session.
/// The session stays active and other sources continue normally.
pub async fn pause_source_in_session(
    session_id: &str,
    profile_id: &str,
) -> Result<(), String> {
    let sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.pause_source_polling(profile_id)
}

/// Resume polling for a paused source within a running session.
pub async fn resume_source_in_session(
    session_id: &str,
    profile_id: &str,
) -> Result<(), String> {
    let sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.resume_source_polling(profile_id)
}

/// Update bus mappings for a source in a multi-source session.
/// Hot-swaps the source by removing and re-adding it with updated mappings.
/// If no mappings are enabled, the source is removed entirely (unless it's the last source).
pub async fn update_source_bus_mappings(
    session_id: &str,
    profile_id: &str,
    bus_mappings: Vec<BusMapping>,
) -> Result<IOCapabilities, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // Only multi-source sessions support this
    session.source.broker_configs()
        .ok_or_else(|| "Session does not support multi-source — cannot update bus mappings".to_string())?;

    // Delegate to the device implementation (handles hot-swap internally)
    session.source.update_source_bus_mappings(profile_id, bus_mappings)?;

    // Rebuild source_names from current configs
    if let Some(configs) = session.source.broker_configs() {
        session.source_names = configs.iter().map(|c| c.display_name.clone()).collect();
    }

    let capabilities = session.source.capabilities();
    tlog!(
        "[reader] Updated bus mappings for source '{}' in session '{}' (sources: {:?})",
        profile_id, session_id, session.source_names
    );

    Ok(capabilities)
}

/// Get all listeners for a session.
/// Useful for debugging and for the frontend to understand session state.
pub async fn get_session_subscribers(session_id: &str) -> Result<Vec<SubscriberInfo>, String> {
    let sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let now = std::time::Instant::now();
    let subscribers: Vec<SubscriberInfo> = session
        .subscribers
        .values()
        .map(|l| SubscriberInfo {
            subscriber_id: l.subscriber_id.clone(),
            app_name: l.app_name.clone(),
            registered_seconds_ago: now.duration_since(l.registered_at).as_secs(),
            is_active: l.is_active,
        })
        .collect();

    Ok(subscribers)
}

/// Result of attempting a safe reinitialize
#[derive(Clone, Debug, Serialize)]
pub struct ReinitializeResult {
    /// Whether the reinitialize was successful
    pub success: bool,
    /// Reason for failure (if success is false)
    pub reason: Option<String>,
    /// List of other listeners preventing reinitialize (if any)
    pub other_subscribers: Vec<String>,
}

/// Check if it's safe to reinitialize a session.
/// Reinitialize is only safe if the requesting listener is the only listener.
/// This is an atomic check-and-act operation to prevent race conditions.
///
/// If safe, the session will be destroyed so a new one can be created.
/// The caller should create a new session after this returns success.
pub async fn reinitialize_session_if_safe(
    session_id: &str,
    subscriber_id: &str,
) -> Result<ReinitializeResult, String> {
    let mut sessions = IO_SESSIONS.lock().await;

    // Session doesn't exist - that's fine, caller can create a new one
    let Some(session) = sessions.get_mut(session_id) else {
        return Ok(ReinitializeResult {
            success: true,
            reason: None,
            other_subscribers: vec![],
        });
    };

    // Check if this listener is the only one
    let other_subscribers: Vec<String> = session
        .subscribers
        .keys()
        .filter(|id| *id != subscriber_id)
        .cloned()
        .collect();

    if !other_subscribers.is_empty() {
        return Ok(ReinitializeResult {
            success: false,
            reason: Some(format!(
                "Cannot reinitialize: {} other listener(s) connected",
                other_subscribers.len()
            )),
            other_subscribers,
        });
    }

    // Safe to reinitialize - destroy the session
    if let Some(mut session) = sessions.remove(session_id) {
        // Emit lifecycle event before stopping
        let source_profile_ids = crate::sessions::get_session_profile_ids(session_id);
        emit_session_lifecycle(&session.app, SessionLifecyclePayload {
            session_id: session_id.to_string(),
            event_type: "destroyed".to_string(),
            source_type: None,
            state: None,
            subscriber_count: 0,
            source_profile_ids,
            creator_subscriber_id: None,
        });
        let _ = session.source.stop().await;
    }
    clear_session_closing(session_id);

    tlog!(
        "[reader] Session '{}' reinitialized by listener '{}'",
        session_id, subscriber_id
    );

    Ok(ReinitializeResult {
        success: true,
        reason: None,
        other_subscribers: vec![],
    })
}

/// Set the active state of a listener.
/// When a listener detaches (stops receiving frames), set is_active to false.
/// When they rejoin, set is_active to true.
pub async fn set_subscriber_active(session_id: &str, subscriber_id: &str, is_active: bool) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    if let Some(listener) = session.subscribers.get_mut(subscriber_id) {
        let was_active = listener.is_active;
        listener.is_active = is_active;
        tlog!(
            "[reader] Session '{}' listener '{}' active: {} -> {}",
            session_id, subscriber_id, was_active, is_active
        );
        Ok(())
    } else {
        Err(format!("Listener '{}' not found in session '{}'", subscriber_id, session_id))
    }
}
