// ui/src-tauri/src/io/mod.rs
//
// IO device abstraction for CAN data sources.
// Provides a common interface for different device types (GVRET, PostgreSQL, etc.)
// with session-based isolation for multiple concurrent connections.

// Core modules
pub mod codec; // Frame codec trait and implementations
mod error;
pub mod traits; // InterfaceTraits validation
mod types;

// Timeline readers (buffer, csv, postgres)
mod timeline;

// Real-time drivers
pub mod gs_usb; // pub for Tauri command access
pub mod gvret; // GVRET TCP/USB driver
mod mqtt;
mod multi_source;
pub mod serial; // pub for Tauri command access (list_serial_ports)
pub mod slcan; // pub for slcan transmit_frame access
mod socketcan;

// Re-export timeline readers
pub use timeline::{step_frame, BufferReader, StepResult};
pub use timeline::{parse_csv_file, CsvReader, CsvReaderOptions};
pub use timeline::{PostgresConfig, PostgresReader, PostgresReaderOptions, PostgresSourceType};

// Re-export codec types
#[allow(unused_imports)]
pub use codec::{FrameCodec, GsUsbCodec, SlcanCodec, SocketCanCodec, SocketCanEncodedFrame};
#[allow(unused_imports)]
pub use gvret::GvretCodec;

// Re-export driver types
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[allow(unused_imports)]
pub use gs_usb::GsUsbConfig;
pub use gvret::{BusMapping, GvretDeviceInfo, probe_gvret_tcp, probe_gvret_usb};
pub use multi_source::{MultiSourceReader, SourceConfig};
pub use mqtt::{MqttConfig, MqttReader};
pub use serial::Parity;

// Error types
#[allow(unused_imports)]
pub use error::IoError;

// Note: SlcanConfig, SlcanReader, SocketCanConfig, SocketIODevice are used internally
// by MultiSourceReader but not exported from mod.rs since all real-time devices now
// go through MultiSourceReader

use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use crate::{buffer_store, sessions};

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

/// Frame batch payload - includes frames and the list of active listeners
/// Frontend should only invoke callbacks for listeners in the active_listeners list
#[derive(Clone, Serialize)]
pub struct FrameBatchPayload {
    /// The frames in this batch
    pub frames: Vec<FrameMessage>,
    /// List of listener IDs that should receive these frames
    /// Empty list means all listeners should receive (fallback behavior)
    pub active_listeners: Vec<String>,
}

/// Playback position - emitted with playback-time events during buffer streaming
#[derive(Clone, Serialize)]
pub struct PlaybackPosition {
    /// Current timestamp in microseconds
    pub timestamp_us: i64,
    /// Current frame index (0-based)
    pub frame_index: usize,
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
    /// Timeline/playback from recorded sources (PostgreSQL, CSV, Buffer)
    Timeline,
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
    /// Whether the interface can transmit frames
    pub can_transmit: bool,
}

/// Declares the data streams a session produces.
///
/// This replaces ad-hoc checks like `emits_raw_bytes` with a structured
/// declaration of what a session will emit. Used by the frontend to decide
/// which event listeners and views to set up.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionDataStreams {
    /// Whether this session emits framed messages (`frame-message` events)
    pub emits_frames: bool,
    /// Whether this session emits raw byte streams (`serial-raw-bytes` events)
    pub emits_bytes: bool,
}

/// IO device capabilities - what this device type supports
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IOCapabilities {
    /// Supports pause/resume (PostgreSQL: true, GVRET: false)
    pub can_pause: bool,
    /// Supports time range filtering (PostgreSQL: true, GVRET: false)
    pub supports_time_range: bool,
    /// Is realtime data (GVRET: true, PostgreSQL: false)
    pub is_realtime: bool,
    /// Supports speed control (PostgreSQL: true, GVRET: false)
    pub supports_speed_control: bool,
    /// Supports seeking to a specific timestamp (Buffer: true, others: false)
    #[serde(default)]
    pub supports_seek: bool,
    /// Supports reverse playback (Buffer: true, others: false)
    #[serde(default)]
    pub supports_reverse: bool,
    /// Can transmit CAN frames (slcan in normal mode, GVRET: true)
    #[serde(default)]
    pub can_transmit: bool,
    /// Can transmit serial bytes (serial port devices)
    #[serde(default)]
    pub can_transmit_serial: bool,
    /// Supports CAN FD (64 bytes, BRS)
    #[serde(default)]
    pub supports_canfd: bool,
    /// Supports extended (29-bit) CAN IDs
    #[serde(default)]
    pub supports_extended_id: bool,
    /// Supports Remote Transmission Request frames
    #[serde(default)]
    pub supports_rtr: bool,
    /// Available bus numbers (empty = single bus, [0,1,2] = multi-bus like GVRET)
    #[serde(default)]
    pub available_buses: Vec<u8>,
    /// Emits raw bytes (serial sessions without server-side framing, or with emit_raw_bytes=true)
    #[serde(default)]
    pub emits_raw_bytes: bool,
    /// Formal interface traits (temporal mode, protocols, transmit capability)
    /// If None, traits are derived from legacy fields for backward compatibility
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traits: Option<InterfaceTraits>,
    /// Declares which data streams this session produces (frames, bytes, or both).
    /// If None, derived from `emits_raw_bytes` for backward compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_streams: Option<SessionDataStreams>,
}

impl IOCapabilities {
    /// Create capabilities for a realtime CAN source (slcan, socketcan, gvret, gs_usb).
    ///
    /// Defaults:
    /// - No pause/resume (would lose data)
    /// - No time range or speed control
    /// - Supports extended IDs and RTR
    /// - Single bus (override with `with_buses`)
    /// - No transmit (override with `with_transmit`)
    pub fn realtime_can() -> Self {
        Self {
            can_pause: false,
            supports_time_range: false,
            is_realtime: true,
            supports_speed_control: false,
            supports_seek: false,
            supports_reverse: false,
            can_transmit: false,
            can_transmit_serial: false,
            supports_canfd: false,
            supports_extended_id: true,
            supports_rtr: true,
            available_buses: vec![0],
            emits_raw_bytes: false,
            traits: None,
            data_streams: Some(SessionDataStreams {
                emits_frames: true,
                emits_bytes: false,
            }),
        }
    }

    /// Create capabilities for a timeline/replay CAN source (buffer, csv, postgres).
    ///
    /// Defaults:
    /// - Supports pause/resume and speed control
    /// - No transmit (replay source)
    /// - No seek (override with `with_seek`)
    pub fn timeline_can() -> Self {
        Self {
            can_pause: true,
            supports_time_range: false,
            is_realtime: false,
            supports_speed_control: true,
            supports_seek: false,
            supports_reverse: false,
            can_transmit: false,
            can_transmit_serial: false,
            supports_canfd: false,
            supports_extended_id: true,
            supports_rtr: false,
            available_buses: vec![],
            emits_raw_bytes: false,
            traits: None,
            data_streams: Some(SessionDataStreams {
                emits_frames: true,
                emits_bytes: false,
            }),
        }
    }

    /// Create capabilities for a real-time serial source.
    ///
    /// Defaults:
    /// - Real-time streaming with pause support
    /// - Serial transmit enabled
    /// - Emits raw bytes (client-side framing)
    pub fn realtime_serial() -> Self {
        Self {
            can_pause: true,
            supports_time_range: false,
            is_realtime: true,
            supports_speed_control: false,
            supports_seek: false,
            supports_reverse: false,
            can_transmit: false,
            can_transmit_serial: true,
            supports_canfd: false,
            supports_extended_id: false,
            supports_rtr: false,
            available_buses: vec![],
            emits_raw_bytes: false, // Set via with_emits_raw_bytes()
            traits: None,
            data_streams: None, // Derived from emits_raw_bytes via get_data_streams()
        }
    }

    /// Set CAN transmit capability
    pub fn with_transmit(mut self, can_transmit: bool) -> Self {
        self.can_transmit = can_transmit;
        self
    }

    /// Set available buses
    pub fn with_buses(mut self, buses: Vec<u8>) -> Self {
        self.available_buses = buses;
        self
    }

    /// Set CAN FD support
    pub fn with_canfd(mut self, supports_canfd: bool) -> Self {
        self.supports_canfd = supports_canfd;
        self
    }

    /// Set seek support (for timeline sources)
    pub fn with_seek(mut self, supports_seek: bool) -> Self {
        self.supports_seek = supports_seek;
        self
    }

    /// Set reverse playback support (for timeline sources)
    pub fn with_reverse(mut self, supports_reverse: bool) -> Self {
        self.supports_reverse = supports_reverse;
        self
    }

    /// Set time range filter support (for timeline sources)
    pub fn with_time_range(mut self, supports_time_range: bool) -> Self {
        self.supports_time_range = supports_time_range;
        self
    }

    /// Set raw bytes emission (for serial sources).
    /// Also updates `data_streams` to reflect the change.
    pub fn with_emits_raw_bytes(mut self, emits_raw_bytes: bool) -> Self {
        self.emits_raw_bytes = emits_raw_bytes;
        // Sync data_streams: serial with raw bytes emits bytes;
        // framing determines whether it also emits frames (handled at session creation)
        if let Some(ref mut ds) = self.data_streams {
            ds.emits_bytes = emits_raw_bytes;
        }
        self
    }

    /// Set data streams explicitly
    pub fn with_data_streams(mut self, emits_frames: bool, emits_bytes: bool) -> Self {
        self.data_streams = Some(SessionDataStreams {
            emits_frames,
            emits_bytes,
        });
        // Keep legacy field in sync
        self.emits_raw_bytes = emits_bytes;
        self
    }

    /// Set interface traits explicitly
    #[allow(dead_code)]
    pub fn with_traits(mut self, traits: InterfaceTraits) -> Self {
        self.traits = Some(traits);
        self
    }

    /// Get the interface traits, deriving from legacy fields if not explicitly set
    #[allow(dead_code)]
    pub fn get_traits(&self) -> InterfaceTraits {
        if let Some(ref traits) = self.traits {
            traits.clone()
        } else {
            // Derive from legacy fields
            let protocols = if self.can_transmit_serial {
                vec![Protocol::Serial]
            } else if self.supports_canfd {
                vec![Protocol::Can, Protocol::CanFd]
            } else {
                vec![Protocol::Can]
            };

            InterfaceTraits {
                temporal_mode: if self.is_realtime {
                    TemporalMode::Realtime
                } else {
                    TemporalMode::Timeline
                },
                protocols,
                can_transmit: self.can_transmit || self.can_transmit_serial,
            }
        }
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

/// Payload emitted when a stream ends (naturally, by disconnect, or by error)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StreamEndedPayload {
    /// Why the stream ended: "complete", "disconnected", "error", "stopped"
    pub reason: String,
    /// Whether buffer data is available for replay
    pub buffer_available: bool,
    /// ID of the buffer that was created (if any)
    pub buffer_id: Option<String>,
    /// Type of buffer: "frames" or "bytes"
    pub buffer_type: Option<String>,
    /// Number of items in the buffer (frames or bytes depending on type)
    pub count: usize,
    /// Time range of buffered data (first_us, last_us)
    pub time_range: Option<(u64, u64)>,
    /// Session ID that owns this buffer (for detecting ingest/cross-app buffers)
    pub owning_session_id: String,
}

/// Payload emitted when a session is suspended (stopped with buffer available)
#[derive(Clone, Debug, Serialize)]
pub struct SessionSuspendedPayload {
    /// ID of the session's buffer
    pub buffer_id: Option<String>,
    /// Number of items in the buffer
    pub buffer_count: usize,
    /// Buffer type: "frames" or "bytes"
    pub buffer_type: Option<String>,
    /// Time range of captured data [first_us, last_us] or null if empty
    pub time_range: Option<(u64, u64)>,
}

/// Payload emitted when a session is resuming with a new buffer
#[derive(Clone, Debug, Serialize)]
pub struct SessionResumingPayload {
    /// ID of the new buffer being created
    pub new_buffer_id: String,
    /// ID of the old buffer that was orphaned (available for standalone viewing)
    pub orphaned_buffer_id: Option<String>,
}

/// Payload emitted when session state changes
#[derive(Clone, Debug, Serialize)]
pub struct StateChangePayload {
    /// Previous state (serialized as string for simpler TypeScript handling)
    pub previous: String,
    /// Current state
    pub current: String,
    /// Active buffer ID if streaming to a buffer
    pub buffer_id: Option<String>,
}

/// Payload emitted when joiner count changes
#[derive(Clone, Debug, Serialize)]
pub struct JoinerCountChangedPayload {
    /// New total listener count
    pub count: usize,
    /// The listener that triggered the change (if known)
    pub listener_id: Option<String>,
    /// Whether the listener joined or left ("joined" | "left" | null for sync)
    pub change: Option<String>,
}

/// Trait for all IO devices (CAN adapters, serial ports, replay sources, etc.)
#[async_trait]
pub trait IODevice: Send + Sync {
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
    /// This is the preferred method for buffer playback as it avoids floating-point issues.
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

    /// Get device type identifier (e.g., "gvret_tcp", "multi_source")
    /// Default implementation returns "unknown"
    fn device_type(&self) -> &'static str {
        "unknown"
    }

    /// For multi-source sessions, return the source configurations.
    /// Default implementation returns None.
    fn multi_source_configs(&self) -> Option<Vec<multi_source::SourceConfig>> {
        None
    }

    /// Reconfigure a running session with new time range.
    /// This stops the current stream, orphans the old buffer, creates a new buffer,
    /// and starts streaming with the new time range - all while keeping the session alive.
    /// Other apps joined to this session remain connected.
    /// Default implementation returns an error.
    async fn reconfigure(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("This device does not support reconfiguration".to_string())
    }
}

// ============================================================================
// Session Management
// ============================================================================

/// Heartbeat timeout - listeners that haven't sent a heartbeat in this time are considered stale
const HEARTBEAT_TIMEOUT_SECS: u64 = 10;
/// How often to check for stale listeners
const HEARTBEAT_CHECK_INTERVAL_SECS: u64 = 5;

/// A registered listener for an IO session
#[derive(Clone, Debug)]
pub struct SessionListener {
    /// Unique ID for this listener (e.g., "discovery", "decoder")
    pub listener_id: String,
    /// When this listener was registered
    pub registered_at: std::time::Instant,
    /// Last heartbeat from this listener
    pub last_heartbeat: std::time::Instant,
    /// Whether this listener was the session owner (created the session)
    pub is_owner: bool,
    /// Whether this listener is active (receiving frames). Set to false when detaching.
    pub is_active: bool,
}

/// Active IO session
pub struct IOSession {
    pub device: Box<dyn IODevice>,
    pub app: AppHandle,
    /// Number of apps connected to this session (legacy counter, for backwards compatibility)
    pub joiner_count: usize,
    /// Map of listener IDs to their listener info (replaces joiner_heartbeats)
    pub listeners: HashMap<String, SessionListener>,
    /// Display names of the sources in this session (for logging)
    pub source_names: Vec<String>,
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
fn emit_state_change(app: &AppHandle, session_id: &str, previous: &IOState, current: &IOState) {
    use crate::buffer_store;

    let payload = StateChangePayload {
        previous: state_to_string(previous),
        current: state_to_string(current),
        buffer_id: buffer_store::get_active_buffer_id(),
    };

    emit_to_session(app, "session-state", session_id, payload);
}

/// Emit a joiner count change event for a session
fn emit_joiner_count_change(
    app: &AppHandle,
    session_id: &str,
    joiner_count: usize,
    listener_id: Option<&str>,
    change: Option<&str>,
) {
    let payload = JoinerCountChangedPayload {
        count: joiner_count,
        listener_id: listener_id.map(|s| s.to_string()),
        change: change.map(|s| s.to_string()),
    };
    emit_to_session(app, "joiner-count-changed", session_id, payload);
}

/// Emit a speed change event for a session
fn emit_speed_change(app: &AppHandle, session_id: &str, speed: f64) {
    emit_to_session(app, "speed-changed", session_id, speed);
}

/// Global session manager
static IO_SESSIONS: Lazy<Mutex<HashMap<String, IOSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Sessions that are currently closing (window close in progress)
/// Uses RwLock (not async Mutex) so it can be checked synchronously in emit_to_session
static CLOSING_SESSIONS: Lazy<RwLock<HashSet<String>>> = Lazy::new(|| RwLock::new(HashSet::new()));

/// Startup errors for sessions (errors that occurred before any listener registered).
/// Uses RwLock (not async Mutex) so it can be set synchronously from emit_to_session.
/// The error is retrieved and cleared when the first listener registers.
static STARTUP_ERRORS: Lazy<RwLock<HashMap<String, String>>> = Lazy::new(|| RwLock::new(HashMap::new()));

/// Store a startup error for a session (called when error occurs with no listeners)
pub fn store_startup_error(session_id: &str, error: String) {
    if let Ok(mut errors) = STARTUP_ERRORS.write() {
        eprintln!("[reader] Storing startup error for session '{}': {}", session_id, error);
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

/// Clear any startup error for a session (called on session destroy)
fn clear_startup_error(session_id: &str) {
    if let Ok(mut errors) = STARTUP_ERRORS.write() {
        errors.remove(session_id);
    }
}

/// Mark a session as closing (sync version for use in window event handler)
/// This prevents further events from being emitted to the closing window.
/// Returns true if this is the first time marking as closing, false if already closing.
pub fn mark_session_closing_sync(session_id: &str) -> bool {
    if let Ok(mut closing) = CLOSING_SESSIONS.write() {
        let is_new = closing.insert(session_id.to_string());
        if is_new {
            eprintln!("[reader] Marked session '{}' as closing", session_id);
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

/// Check if a session is currently closing
fn is_session_closing(session_id: &str) -> bool {
    CLOSING_SESSIONS
        .read()
        .map(|s| s.contains(session_id))
        .unwrap_or(false)
}

/// Emit an event scoped to a specific session
///
/// Checks if the session is closing and if the main window still exists
/// before emitting to prevent crashes when events are sent to a destroyed
/// WebView (macOS Tahoe issue).
pub fn emit_to_session<S: Serialize + Clone>(
    app: &AppHandle,
    event: &str,
    session_id: &str,
    payload: S,
) {
    // Check closing flag FIRST (prevents emit during window destruction)
    // This catches the race between window close and event emission
    if is_session_closing(session_id) {
        eprintln!("[emit_to_session] Blocked event '{}:{}' - session is closing", event, session_id);
        return;
    }

    // Check if any webview window exists.
    // On macOS 26.2+, emitting to a destroyed WebView can crash in
    // WebKit::WebPageProxy::dispatchSetObscuredContentInsets()
    // The app can run in multi-window mode (separate windows for discovery, decoder, etc.)
    // so we check if at least one window is open to receive events.
    let has_window = app.get_webview_window("dashboard").is_some()
        || app.get_webview_window("discovery").is_some()
        || app.get_webview_window("decoder").is_some()
        || app.get_webview_window("catalog-editor").is_some()
        || app.get_webview_window("settings").is_some()
        || app.get_webview_window("frame-calculator").is_some()
        || app.get_webview_window("transmit").is_some();
    if !has_window {
        eprintln!("[emit_to_session] Blocked event '{}:{}' - no window found", event, session_id);
        return;
    }

    let scoped_event = format!("{}:{}", event, session_id);
    let _ = app.emit(&scoped_event, payload);
}

/// Payload for global session lifecycle events (emitted to all windows)
#[derive(Clone, Debug, Serialize)]
pub struct SessionLifecyclePayload {
    /// The session ID
    pub session_id: String,
    /// Event type: "created" or "destroyed"
    pub event_type: String,
    /// Device type (e.g., "gvret_tcp", "multi_source") - only for "created"
    pub device_type: Option<String>,
    /// Current state - only for "created"
    pub state: Option<String>,
    /// Number of listeners
    pub listener_count: usize,
    /// Source profile IDs
    pub source_profile_ids: Vec<String>,
    /// The listener ID that created the session (only for "created")
    pub creator_listener_id: Option<String>,
}

/// Emit a global session lifecycle event to all windows.
/// This event is NOT scoped to a session ID - it broadcasts to all windows.
pub fn emit_session_lifecycle(app: &AppHandle, payload: SessionLifecyclePayload) {
    eprintln!(
        "[lifecycle_event] Emitting '{}' for session '{}' (profiles: {:?})",
        payload.event_type, payload.session_id, payload.source_profile_ids
    );
    let _ = app.emit("session-lifecycle", payload);
}

/// Emit a session error event and store it for later retrieval.
///
/// This is the preferred way to emit errors - it both:
/// 1. Emits the error as a Tauri event (for listeners that are already set up)
/// 2. Stores the error so it can be returned when a listener registers
///
/// This solves the race condition where errors occur before frontend listeners are set up.
pub fn emit_session_error(app: &AppHandle, session_id: &str, error: String) {
    // Store the error for later retrieval (in case no listeners are set up yet)
    store_startup_error(session_id, error.clone());
    // Also emit the event (in case listeners ARE set up)
    emit_to_session(app, "session-error", session_id, error);
}

/// Emit frames to a session with active listener filtering.
/// This is the preferred way to emit frames - it includes the active listeners
/// so the frontend can filter callbacks appropriately.
pub fn emit_frames(
    app: &AppHandle,
    session_id: &str,
    frames: Vec<FrameMessage>,
) {
    let active_listeners = get_active_listeners_sync(session_id);
    let payload = FrameBatchPayload {
        frames,
        active_listeners,
    };
    emit_to_session(app, "frame-message", session_id, payload);
}

/// Emit stream-ended event with buffer info.
///
/// Finalises the buffer and emits the stream-ended event with metadata.
/// This is the shared helper used by all IO drivers.
pub fn emit_stream_ended(
    app_handle: &AppHandle,
    session_id: &str,
    reason: &str,
    log_prefix: &str,
) {
    use crate::buffer_store::{self, BufferType};

    let metadata = buffer_store::finalize_buffer();

    let (buffer_id, buffer_type, count, time_range, buffer_available) = match metadata {
        Some(ref m) => {
            let type_str = match m.buffer_type {
                BufferType::Frames => "frames",
                BufferType::Bytes => "bytes",
            };
            (
                Some(m.id.clone()),
                Some(type_str.to_string()),
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

    emit_to_session(
        app_handle,
        "stream-ended",
        session_id,
        StreamEndedPayload {
            reason: reason.to_string(),
            buffer_available,
            buffer_id,
            buffer_type,
            count,
            time_range,
            owning_session_id: session_id.to_string(),
        },
    );
    eprintln!(
        "[{}:{}] Stream ended (reason: {}, count: {})",
        log_prefix, session_id, reason, count
    );
}

/// Payload for buffer-orphaned event
#[derive(Clone, Debug, Serialize)]
pub struct BufferOrphanedPayload {
    pub buffer_id: String,
    pub buffer_name: String,
    pub buffer_type: String,
    pub count: usize,
}

/// Emit buffer-orphaned event when buffers are made available for standalone use.
pub fn emit_buffer_orphaned(app: &AppHandle, session_id: &str, orphaned: Vec<crate::buffer_store::OrphanedBufferInfo>) {
    use crate::buffer_store::BufferType;

    for info in orphaned {
        let type_str = match info.buffer_type {
            BufferType::Frames => "frames",
            BufferType::Bytes => "bytes",
        };
        let payload = BufferOrphanedPayload {
            buffer_id: info.buffer_id.clone(),
            buffer_name: info.buffer_name,
            buffer_type: type_str.to_string(),
            count: info.count,
        };
        emit_to_session(app, "buffer-orphaned", session_id, payload);
    }
}

/// Payload for buffer-created event
#[derive(Clone, Debug, Serialize)]
pub struct BufferCreatedPayload {
    pub buffer_id: String,
    pub buffer_name: String,
    pub buffer_type: String,
}

/// Emit buffer-created event when a new buffer is created for a session.
pub fn emit_buffer_created(app: &AppHandle, session_id: &str, buffer_id: &str, buffer_name: &str, buffer_type: &str) {
    let payload = BufferCreatedPayload {
        buffer_id: buffer_id.to_string(),
        buffer_name: buffer_name.to_string(),
        buffer_type: buffer_type.to_string(),
    };
    emit_to_session(app, "buffer-created", session_id, payload);
}

/// Payload for device-connected event
#[derive(Clone, Debug, Serialize)]
pub struct DeviceConnectedPayload {
    pub device_type: String,
    pub address: String,
    pub bus_number: Option<u8>,
}

/// Emit device-connected event when a device successfully connects.
pub fn emit_device_connected(app: &AppHandle, session_id: &str, device_type: &str, address: &str, bus_number: Option<u8>) {
    let payload = DeviceConnectedPayload {
        device_type: device_type.to_string(),
        address: address.to_string(),
        bus_number,
    };
    emit_to_session(app, "device-connected", session_id, payload);
}

/// Payload for device-probe event (global, not session-scoped)
#[derive(Clone, Debug, Serialize)]
pub struct DeviceProbePayload {
    /// Profile ID that was probed
    pub profile_id: String,
    /// Device type (e.g., "gvret", "slcan", "gs_usb")
    pub device_type: String,
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
    /// Whether the listener is the session owner
    pub is_owner: bool,
    /// Total listener count
    pub listener_count: usize,
}

/// Create a new IO session with an initial listener.
/// If a session with this ID already exists, joins the existing session instead.
/// This prevents race conditions when multiple apps start simultaneously.
pub async fn create_session(
    app: AppHandle,
    session_id: String,
    device: Box<dyn IODevice>,
    listener_id: Option<String>,
    source_names: Option<Vec<String>>,
) -> CreateSessionResult {
    // Clear the closing flag in case this is a new session for a previously closed window
    clear_session_closing(&session_id);

    let mut sessions = IO_SESSIONS.lock().await;
    let now = std::time::Instant::now();

    // Check if session already exists - join it instead of overwriting
    if let Some(existing) = sessions.get_mut(&session_id) {
        let capabilities = existing.device.capabilities();
        let is_owner: bool;
        let listener_count: usize;

        if let Some(lid) = listener_id {
            // Check if already registered
            if let Some(listener) = existing.listeners.get_mut(&lid) {
                // Already registered - update heartbeat
                listener.last_heartbeat = now;
                is_owner = listener.is_owner;
            } else {
                // New listener joining existing session
                is_owner = false; // Joining listener is never owner
                existing.listeners.insert(
                    lid.clone(),
                    SessionListener {
                        listener_id: lid.clone(),
                        registered_at: now,
                        last_heartbeat: now,
                        is_owner,
                        is_active: true, // New listeners are active by default
                    },
                );
                existing.joiner_count = existing.listeners.len();

                eprintln!(
                    "[reader] Session '{}' - listener '{}' joined existing session (owner: {}), total: {}",
                    session_id, lid, is_owner, existing.listeners.len()
                );

                // Emit joiner count change
                emit_joiner_count_change(&existing.app, &session_id, existing.listeners.len(), Some(&lid), Some("joined"));
            }
            listener_count = existing.listeners.len();
        } else {
            is_owner = false;
            listener_count = existing.listeners.len();
        }

        return CreateSessionResult {
            capabilities,
            is_new: false,
            is_owner,
            listener_count,
        };
    }

    // No existing session - create new one
    let capabilities = device.capabilities();

    // Create initial listeners map
    let mut listeners = HashMap::new();
    let is_owner = listener_id.is_some();
    if let Some(lid) = listener_id.clone() {
        listeners.insert(
            lid.clone(),
            SessionListener {
                listener_id: lid.clone(),
                registered_at: now,
                last_heartbeat: now,
                is_owner: true, // First listener is the owner
                is_active: true, // New listeners are active by default
            },
        );
        eprintln!(
            "[reader] Session '{}' created with listener '{}' (owner: true), total: 1",
            session_id, lid
        );
    } else {
        eprintln!("[reader] Session '{}' created with no initial listener", session_id);
    }

    let listener_count = listeners.len().max(1);
    let device_type = device.device_type().to_string();
    let state = device.state();
    let app_for_event = app.clone();
    let session = IOSession {
        device,
        app,
        joiner_count: listener_count,
        listeners,
        source_names: source_names.unwrap_or_default(),
    };

    sessions.insert(session_id.clone(), session);

    // Emit global session lifecycle event (to all windows)
    // Use get_session_profile_ids() to get actual profile IDs (not display names)
    // Profile tracking is registered before create_session() is called
    let source_profile_ids = crate::sessions::get_session_profile_ids(&session_id);
    emit_session_lifecycle(&app_for_event, SessionLifecyclePayload {
        session_id: session_id.clone(),
        event_type: "created".to_string(),
        device_type: Some(device_type),
        state: Some(format!("{:?}", state)),
        listener_count,
        source_profile_ids,
        creator_listener_id: listener_id,
    });

    CreateSessionResult {
        capabilities,
        is_new: true,
        is_owner,
        listener_count,
    }
}

/// Get the state of a reader session (None if session doesn't exist)
pub async fn get_session_state(session_id: &str) -> Option<IOState> {
    let sessions = IO_SESSIONS.lock().await;
    sessions.get(session_id).map(|s| s.device.state())
}

/// Get the capabilities of a session (None if session doesn't exist)
pub async fn get_session_capabilities(session_id: &str) -> Option<IOCapabilities> {
    let sessions = IO_SESSIONS.lock().await;
    sessions.get(session_id).map(|s| s.device.capabilities())
}

/// Get the joiner count for a session (0 if session doesn't exist)
pub async fn get_session_joiner_count(session_id: &str) -> usize {
    let sessions = IO_SESSIONS.lock().await;
    sessions.get(session_id).map(|s| s.joiner_count).unwrap_or(0)
}

/// Result of joining an existing session
#[derive(Clone, Debug, Serialize)]
pub struct JoinSessionResult {
    pub capabilities: IOCapabilities,
    pub state: IOState,
    pub buffer_id: Option<String>,
    /// Type of the active buffer ("frames" or "bytes"), if any
    pub buffer_type: Option<String>,
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
    let app = session.app.clone();

    // Emit joiner count change event to all listeners (legacy join - no listener ID)
    emit_joiner_count_change(&app, session_id, joiner_count, None, Some("joined"));

    // Get active buffer info
    let (buffer_id, buffer_type) = match crate::buffer_store::get_active_buffer_id() {
        Some(id) => {
            let btype = crate::buffer_store::get_buffer_type(&id).map(|t| match t {
                crate::buffer_store::BufferType::Frames => "frames".to_string(),
                crate::buffer_store::BufferType::Bytes => "bytes".to_string(),
            });
            (Some(id), btype)
        }
        None => (None, None),
    };

    Ok(JoinSessionResult {
        capabilities: session.device.capabilities(),
        state: session.device.state(),
        buffer_id,
        buffer_type,
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
        let app = session.app.clone();

        // Emit joiner count change event to remaining listeners (legacy leave - no listener ID)
        emit_joiner_count_change(&app, session_id, joiner_count, None, Some("left"));

        // If no joiners left, stop the session to prevent emitting to destroyed WebViews
        if joiner_count == 0 {
            let previous = session.device.state();
            if !matches!(previous, IOState::Stopped) {
                let _ = session.device.stop().await;
                let current = session.device.state();
                if previous != current {
                    emit_state_change(&app, session_id, &previous, &current);
                }
            }
        }

        Ok(joiner_count)
    } else {
        // Session doesn't exist (may have been destroyed), that's fine
        Ok(0)
    }
}

// Legacy heartbeat_session and remove_listener functions removed
// Use register_listener and unregister_listener instead

/// Clean up stale listeners from all sessions.
/// Called periodically by the watchdog task.
/// Returns a list of (session_id, removed_count, remaining_count) for sessions that had stale listeners.
pub async fn cleanup_stale_listeners() -> Vec<(String, usize, usize)> {
    let mut sessions = IO_SESSIONS.lock().await;
    let now = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(HEARTBEAT_TIMEOUT_SECS);
    let mut results = Vec::new();

    for (session_id, session) in sessions.iter_mut() {
        let before_count = session.listeners.len();

        // Remove stale listeners
        session.listeners.retain(|listener_id, listener| {
            let is_stale = now.duration_since(listener.last_heartbeat) > timeout;
            if is_stale {
                eprintln!(
                    "[reader] Session '{}' removing stale listener '{}' (no heartbeat for {:?})",
                    session_id,
                    listener_id,
                    now.duration_since(listener.last_heartbeat)
                );
            }
            !is_stale
        });

        let after_count = session.listeners.len();
        let removed_count = before_count - after_count;

        if removed_count > 0 {
            results.push((session_id.clone(), removed_count, after_count));

            // Sync the legacy joiner_count with listener count
            // This ensures the UI shows the correct count after cleanup
            if session.joiner_count > after_count {
                let old_count = session.joiner_count;
                session.joiner_count = after_count;
                eprintln!(
                    "[reader] Session '{}' synced joiner_count {} -> {} after cleanup",
                    session_id, old_count, after_count
                );

                // Emit joiner count change (sync - no specific listener)
                emit_joiner_count_change(&session.app, session_id, after_count, None, None);

                // If no listeners left, stop the session
                if after_count == 0 {
                    eprintln!("[reader] Session '{}' has no listeners left after cleanup, stopping", session_id);
                    let previous = session.device.state();
                    if !matches!(previous, IOState::Stopped) {
                        // Note: Can't await here while holding the lock, so we just log
                        // The session will be stopped on next interaction or when destroyed
                        eprintln!("[reader] Session '{}' should be stopped (async stop not possible in cleanup)", session_id);
                    }
                }
            }
        }
    }

    results
}

/// How often to log session status (seconds)
const STATUS_LOG_INTERVAL_SECS: u64 = 60;

/// Log current session status (for debugging)
async fn log_session_status() {
    let sessions = IO_SESSIONS.lock().await;
    let running_queries = crate::dbquery::get_running_queries().await;

    if sessions.is_empty() && running_queries.is_empty() {
        return; // Don't log if nothing active
    }

    eprintln!("[session status] ========== Active Sessions ==========");
    for (session_id, session) in sessions.iter() {
        let state = match session.device.state() {
            IOState::Stopped => "stopped",
            IOState::Starting => "starting",
            IOState::Running => "running",
            IOState::Paused => "paused",
            IOState::Error(_) => "error",
        };
        let listener_ids: Vec<&str> = session.listeners.keys().map(|s| s.as_str()).collect();
        let sources = if session.source_names.is_empty() {
            String::new()
        } else {
            format!(", sources={:?}", session.source_names)
        };
        eprintln!(
            "[session status]   '{}': state={}, listeners={} {:?}{}",
            session_id,
            state,
            session.listeners.len(),
            listener_ids,
            sources
        );
    }
    if !running_queries.is_empty() {
        eprintln!("[session status] ---------- Running Queries -----------");
        for (id, query) in running_queries {
            let elapsed = query.started_at.elapsed().as_secs();
            eprintln!(
                "[session status]   '{}': type={}, profile={}, running for {}s",
                id, query.query_type, query.profile_id, elapsed
            );
        }
    }
    eprintln!("[session status] =====================================");
}

/// Start the heartbeat watchdog task.
/// This runs in the background and periodically cleans up stale listeners.
/// Also logs session status every 60 seconds for debugging.
pub fn start_heartbeat_watchdog() {
    tauri::async_runtime::spawn(async {
        let cleanup_interval = std::time::Duration::from_secs(HEARTBEAT_CHECK_INTERVAL_SECS);
        let status_interval = STATUS_LOG_INTERVAL_SECS / HEARTBEAT_CHECK_INTERVAL_SECS;
        let mut tick_count: u64 = 0;

        loop {
            tokio::time::sleep(cleanup_interval).await;
            tick_count += 1;

            // Cleanup stale listeners every tick
            let results = cleanup_stale_listeners().await;
            for (session_id, removed, remaining) in results {
                eprintln!(
                    "[reader watchdog] Session '{}': removed {} stale listeners, {} remaining",
                    session_id, removed, remaining
                );
            }

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
    eprintln!("[reader] start_session('{}') called", session_id);
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| {
            eprintln!("[reader] start_session('{}') - session not found!", session_id);
            format!("Session '{}' not found", session_id)
        })?;

    let previous = session.device.state();
    eprintln!("[reader] start_session('{}') - previous state: {:?}", session_id, previous);

    // Idempotency: if already running, return success
    if matches!(previous, IOState::Running) {
        eprintln!("[reader] start_session('{}') - already running, returning", session_id);
        return Ok(previous);
    }

    eprintln!("[reader] start_session('{}') - calling device.start()...", session_id);
    session.device.start().await?;

    let current = session.device.state();
    eprintln!("[reader] start_session('{}') - current state: {:?}", session_id, current);
    if previous != current {
        emit_state_change(&session.app, session_id, &previous, &current);
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

    let previous = session.device.state();

    // Idempotency: if already stopped, return success
    if matches!(previous, IOState::Stopped) {
        return Ok(previous);
    }

    session.device.stop().await?;

    let current = session.device.state();
    if previous != current {
        emit_state_change(&session.app, session_id, &previous, &current);
    }

    Ok(current)
}

/// Suspend a reader session - stops streaming, finalizes buffer, session stays alive.
/// The buffer remains owned by the session and all joined apps can view it.
/// Use `resume_session_fresh` to start streaming again with a new buffer.
/// Returns the confirmed state after the operation.
pub async fn suspend_session(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.device.state();

    // Idempotency: if already stopped, return success
    if matches!(previous, IOState::Stopped) {
        return Ok(previous);
    }

    // Stop the device
    session.device.stop().await?;

    // Finalize the buffer but DON'T orphan it - session still owns it
    let metadata = buffer_store::finalize_buffer();

    // Emit session-suspended event with buffer info
    let (buffer_id, buffer_count, buffer_type, time_range) = match metadata {
        Some(ref m) => {
            let type_str = match m.buffer_type {
                buffer_store::BufferType::Frames => "frames",
                buffer_store::BufferType::Bytes => "bytes",
            };
            let tr = match (m.start_time_us, m.end_time_us) {
                (Some(start), Some(end)) => Some((start, end)),
                _ => None,
            };
            (Some(m.id.clone()), m.count, Some(type_str.to_string()), tr)
        }
        None => (None, 0, None, None),
    };

    emit_to_session(
        &session.app,
        "session-suspended",
        session_id,
        SessionSuspendedPayload {
            buffer_id,
            buffer_count,
            buffer_type,
            time_range,
        },
    );

    let current = session.device.state();
    if previous != current {
        emit_state_change(&session.app, session_id, &previous, &current);
    }

    eprintln!(
        "[reader] suspend_session('{}') - buffer finalized, session stays alive",
        session_id
    );

    Ok(current)
}

/// Resume a suspended session with a fresh buffer.
/// The old buffer is orphaned (becomes available for standalone viewing).
/// A new buffer is created for the session and streaming starts.
/// Returns the confirmed state after the operation.
pub async fn resume_session_fresh(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.device.state();

    // Must be stopped to resume with new buffer
    if !matches!(previous, IOState::Stopped) {
        return Err(format!(
            "Session must be stopped to resume with new buffer (current: {:?})",
            previous
        ));
    }

    // Get the current buffer ID before orphaning
    let old_buffer_id = buffer_store::get_buffer_for_session(session_id);

    // Orphan the old buffer (makes it standalone, data preserved)
    let orphaned = buffer_store::orphan_buffers_for_session(session_id);
    emit_buffer_orphaned(&session.app, session_id, orphaned);

    // Create a new buffer for the session
    let timestamp = chrono::Local::now().format("%H%M%S").to_string();
    let buffer_name = format!("{}-{}", session_id, timestamp);
    let new_buffer_id = buffer_store::create_buffer(buffer_store::BufferType::Frames, buffer_name.clone());
    emit_buffer_created(&session.app, session_id, &new_buffer_id, &buffer_name, "frames");

    // Assign the new buffer to this session
    if let Err(e) = buffer_store::set_buffer_owner(&new_buffer_id, session_id) {
        eprintln!(
            "[reader] resume_session_fresh - failed to set buffer owner: {}",
            e
        );
    }

    // Emit session-resuming event so apps clear their frame lists
    emit_to_session(
        &session.app,
        "session-resuming",
        session_id,
        SessionResumingPayload {
            new_buffer_id: new_buffer_id.clone(),
            orphaned_buffer_id: old_buffer_id,
        },
    );

    // Start the device
    session.device.start().await?;

    let current = session.device.state();
    if previous != current {
        emit_state_change(&session.app, session_id, &previous, &current);
    }

    eprintln!(
        "[reader] resume_session_fresh('{}') - old buffer orphaned, new buffer '{}' created",
        session_id, new_buffer_id
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

    let previous = session.device.state();

    // Idempotency: if already paused, return success
    if matches!(previous, IOState::Paused) {
        return Ok(previous);
    }

    session.device.pause().await?;

    let current = session.device.state();
    if previous != current {
        emit_state_change(&session.app, session_id, &previous, &current);
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

    let previous = session.device.state();

    // Idempotency: if already running, return success
    if matches!(previous, IOState::Running) {
        return Ok(previous);
    }

    session.device.resume().await?;

    let current = session.device.state();
    if previous != current {
        emit_state_change(&session.app, session_id, &previous, &current);
    }

    Ok(current)
}

/// Update speed for a reader session
pub async fn update_session_speed(session_id: &str, speed: f64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.device.set_speed(speed)?;

    // Emit speed change event to all listeners
    emit_speed_change(&session.app, session_id, speed);

    Ok(())
}

/// Update time range for a reader session
pub async fn update_session_time_range(
    session_id: &str,
    start: Option<String>,
    end: Option<String>,
) -> Result<(), String> {
    eprintln!(
        "[io] update_session_time_range called - session: {}, start: {:?}, end: {:?}",
        session_id,
        start,
        end
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions.get_mut(session_id).ok_or_else(|| {
        let err = format!("Session '{}' not found", session_id);
        eprintln!("[io] update_session_time_range: {}", err);
        err
    })?;

    let result = session.device.set_time_range(start, end);
    if let Err(ref e) = result {
        eprintln!("[io] update_session_time_range failed: {}", e);
    }
    result
}

/// Reconfigure a running session with new time range.
/// This stops the current stream, orphans the old buffer, creates a new buffer,
/// and starts streaming with the new time range - all while keeping the session alive.
/// Other apps joined to this session remain connected.
pub async fn reconfigure_session(
    session_id: &str,
    start: Option<String>,
    end: Option<String>,
) -> Result<(), String> {
    eprintln!(
        "[io] reconfigure_session called - session: {}, start: {:?}, end: {:?}",
        session_id, start, end
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions.get_mut(session_id).ok_or_else(|| {
        let err = format!("Session '{}' not found", session_id);
        eprintln!("[io] reconfigure_session: {}", err);
        err
    })?;

    let result = session.device.reconfigure(start.clone(), end.clone()).await;
    if let Err(ref e) = result {
        eprintln!("[io] reconfigure_session failed: {}", e);
    } else {
        // Emit state change event so frontend updates
        // During reconfigure, session goes: Running -> Stopped -> Running internally
        // Emit Stopped -> Running to ensure frontend shows correct streaming state
        let state_after = session.device.state();
        eprintln!(
            "[io] reconfigure_session completed successfully - final state: {:?}",
            state_after
        );
        // Force emit Stopped -> current to ensure UI updates to streaming state
        emit_state_change(&session.app, session_id, &IOState::Stopped, &state_after);

        // Emit session-reconfigured event so apps know to clear their frame lists and reset state
        emit_to_session(
            &session.app,
            "session-reconfigured",
            session_id,
            serde_json::json!({
                "start": start,
                "end": end,
            }),
        );
    }
    result
}

/// Seek to a specific timestamp in microseconds
pub async fn seek_session(session_id: &str, timestamp_us: i64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.device.seek(timestamp_us)
}

/// Seek to a specific frame index (preferred for buffer playback)
pub async fn seek_session_by_frame(session_id: &str, frame_index: i64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.device.seek_by_frame(frame_index)
}

/// Set playback direction (reverse = true for backwards playback)
pub async fn update_session_direction(session_id: &str, reverse: bool) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.device.set_direction(reverse)
}

/// Switch a session to buffer replay mode.
/// This replaces the session's reader with a BufferReader that reads from the session's
/// owned buffer. The session stays alive and all listeners remain connected.
/// Use this after ingest completes to enable playback without destroying the session.
pub async fn switch_to_buffer_replay(app: &AppHandle, session_id: &str, speed: f64) -> Result<IOCapabilities, String> {
    // Get the session's owned buffer
    let buffer_id = crate::buffer_store::get_buffer_for_session(session_id)
        .ok_or_else(|| {
            // Log all buffers for debugging
            let buffers = crate::buffer_store::list_buffers();
            eprintln!(
                "[io] switch_to_buffer_replay: No buffer found for session '{}'. Available buffers:",
                session_id
            );
            for buf in &buffers {
                eprintln!(
                    "  - {} (owner: {:?}, count: {})",
                    buf.id,
                    buf.owning_session_id,
                    buf.count
                );
            }
            format!("No buffer found for session '{}'", session_id)
        })?;

    // Log buffer details
    let buffer_count = crate::buffer_store::get_buffer_count(&buffer_id);
    eprintln!(
        "[io] switch_to_buffer_replay: session='{}', buffer='{}', frames={}, speed={}",
        session_id, buffer_id, buffer_count, speed
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // Stop the current reader
    let _ = session.device.stop().await;

    // Set this buffer as the active buffer so getBufferMetadata() returns correct data
    let _ = crate::buffer_store::set_active_buffer(&buffer_id);

    // Create a new BufferReader that reads from the session's buffer
    let new_reader = BufferReader::new_with_buffer(
        app.clone(),
        session_id.to_string(),
        buffer_id,
        speed,
    );

    // Get capabilities before replacing
    let capabilities = new_reader.capabilities();

    // Replace the device
    session.device = Box::new(new_reader);

    eprintln!(
        "[io] switch_to_buffer_replay: session='{}' now in buffer replay mode",
        session_id
    );

    Ok(capabilities)
}

/// Resume a session from buffer playback back to live streaming.
/// This replaces the BufferReader with a new live reader (passed in from the caller
/// who creates it from profile config). The session stays alive and all listeners
/// remain connected.
///
/// Steps:
/// 1. Stop the current reader (BufferReader)
/// 2. Orphan the current buffer (data preserved for later viewing)
/// 3. Create a fresh buffer for the new live stream
/// 4. Replace session.device with the new live reader
/// 5. Start the new reader
pub async fn resume_to_live_session(
    session_id: &str,
    new_reader: Box<dyn IODevice>,
) -> Result<IOCapabilities, String> {
    eprintln!(
        "[io] resume_to_live_session: session='{}' switching from buffer to live",
        session_id
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // Stop the current reader (BufferReader)
    let _ = session.device.stop().await;

    // Get the current buffer ID before the reader orphans it
    let old_buffer_id = buffer_store::get_buffer_for_session(session_id);

    // Note: We don't create a buffer here - the reader's start() method handles
    // buffer creation (including orphaning old buffers). This avoids creating
    // an intermediary buffer that would immediately get orphaned.

    // Get capabilities before replacing
    let capabilities = new_reader.capabilities();

    // Replace the device with the new live reader
    session.device = new_reader;

    // Start the new reader
    session.device.start().await?;

    let state = session.device.state();
    emit_state_change(&session.app, session_id, &IOState::Stopped, &state);

    // Get the new buffer ID created by the reader's start() method
    let new_buffer_id = buffer_store::get_buffer_for_session(session_id);

    eprintln!(
        "[io] resume_to_live_session: session='{}' now back in live mode with buffer '{:?}'",
        session_id, new_buffer_id
    );

    // Emit session-resuming event so apps clear their frame lists
    if let Some(ref buffer_id) = new_buffer_id {
        emit_to_session(
            &session.app,
            "session-resuming",
            session_id,
            SessionResumingPayload {
                new_buffer_id: buffer_id.clone(),
                orphaned_buffer_id: old_buffer_id,
            },
        );
    }

    Ok(capabilities)
}

/// Destroy a reader session
pub async fn destroy_session(session_id: &str) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    if let Some(mut session) = sessions.remove(session_id) {
        // Emit lifecycle event before stopping
        let source_profile_ids = crate::sessions::get_session_profile_ids(session_id);
        emit_session_lifecycle(&session.app, SessionLifecyclePayload {
            session_id: session_id.to_string(),
            event_type: "destroyed".to_string(),
            device_type: None,
            state: None,
            listener_count: 0,
            source_profile_ids,
            creator_listener_id: None,
        });
        // Stop the reader before destroying
        let _ = session.device.stop().await;
        // Orphan any buffers owned by this session (emit event before losing app handle)
        let orphaned = crate::buffer_store::orphan_buffers_for_session(session_id);
        emit_buffer_orphaned(&session.app, session_id, orphaned);
    }
    // Clear the closing flag now that the session is fully destroyed
    clear_session_closing(session_id);
    // Clear any stored startup error
    clear_startup_error(session_id);
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
    /// Device type (e.g., "gvret_tcp", "multi_source")
    pub device_type: String,
    /// Current state
    pub state: IOState,
    /// Session capabilities
    pub capabilities: IOCapabilities,
    /// Number of listeners
    pub listener_count: usize,
    /// For multi-source sessions: the source configurations
    pub multi_source_configs: Option<Vec<multi_source::SourceConfig>>,
    /// Profile IDs feeding this session (populated from SESSION_PROFILES in sessions.rs)
    #[serde(default)]
    pub source_profile_ids: Vec<String>,
    /// Buffer ID owned by this session (if any)
    #[serde(default)]
    pub buffer_id: Option<String>,
    /// Frame count in the owned buffer
    #[serde(default)]
    pub buffer_frame_count: Option<usize>,
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

            // Get buffer info if this session owns a buffer
            let buffer_id = buffer_store::get_buffer_for_session(session_id);
            let buffer_frame_count = buffer_id
                .as_ref()
                .map(|id| buffer_store::get_buffer_count(id));

            // Check if session is actively streaming (running state)
            let is_streaming = matches!(session.device.state(), IOState::Running);

            ActiveSessionInfo {
                session_id: session_id.clone(),
                device_type: session.device.device_type().to_string(),
                state: session.device.state(),
                capabilities: session.device.capabilities(),
                listener_count: session.listeners.len(),
                multi_source_configs: session.device.multi_source_configs(),
                source_profile_ids,
                buffer_id,
                buffer_frame_count,
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

    let caps = session.device.capabilities();

    // Check if the reader supports the requested transmit type
    match payload {
        TransmitPayload::CanFrame(_) if !caps.can_transmit => {
            return Err("This session does not support CAN transmission".to_string());
        }
        TransmitPayload::RawBytes(_) if !caps.can_transmit_serial => {
            return Err("This session does not support serial transmission".to_string());
        }
        _ => {}
    }

    // Call device transmit - this is sync and may block waiting for result
    // For MultiSourceReader, this blocks on recv_timeout(500ms)
    // We call it while holding the lock, but the actual I/O happens in the
    // source reader tasks which don't need the IO_SESSIONS lock
    session.device.transmit(payload)
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
pub struct ListenerInfo {
    pub listener_id: String,
    pub is_owner: bool,
    /// Seconds since registration
    pub registered_seconds_ago: u64,
}

/// Result of registering a listener
#[derive(Clone, Debug, Serialize)]
pub struct RegisterListenerResult {
    /// Session capabilities
    pub capabilities: IOCapabilities,
    /// Current session state
    pub state: IOState,
    /// Active buffer ID (if any)
    pub buffer_id: Option<String>,
    /// Buffer type ("frames" or "bytes")
    pub buffer_type: Option<String>,
    /// Whether this listener is the session owner
    pub is_owner: bool,
    /// Total number of listeners
    pub listener_count: usize,
    /// Error that occurred before this listener registered (one-shot, cleared after return)
    pub startup_error: Option<String>,
}

/// Register a listener for a session.
/// This is the primary way for frontend components to join a session.
/// If the listener is already registered, this updates their heartbeat.
/// Returns session info including whether this listener is the owner.
pub async fn register_listener(session_id: &str, listener_id: &str) -> Result<RegisterListenerResult, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let now = std::time::Instant::now();
    let is_owner: bool;

    if let Some(listener) = session.listeners.get_mut(listener_id) {
        // Already registered - update heartbeat
        listener.last_heartbeat = now;
        is_owner = listener.is_owner;
    } else {
        // New listener - register them
        is_owner = session.listeners.is_empty(); // First listener is owner
        session.listeners.insert(
            listener_id.to_string(),
            SessionListener {
                listener_id: listener_id.to_string(),
                registered_at: now,
                last_heartbeat: now,
                is_owner,
                is_active: true, // New listeners are active by default
            },
        );

        // Update legacy joiner_count
        session.joiner_count = session.listeners.len();

        eprintln!(
            "[reader] Session '{}' registered listener '{}' (owner: {}), total: {}",
            session_id,
            listener_id,
            is_owner,
            session.listeners.len()
        );

        // Emit joiner count change
        emit_joiner_count_change(&session.app, session_id, session.listeners.len(), Some(listener_id), Some("joined"));
    }

    // Get buffer info
    let (buffer_id, buffer_type) = match crate::buffer_store::get_active_buffer_id() {
        Some(id) => {
            let btype = crate::buffer_store::get_buffer_type(&id).map(|t| match t {
                crate::buffer_store::BufferType::Frames => "frames".to_string(),
                crate::buffer_store::BufferType::Bytes => "bytes".to_string(),
            });
            (Some(id), btype)
        }
        None => (None, None),
    };

    // Retrieve any startup error (one-shot: cleared after retrieval)
    let startup_error = take_startup_error(session_id);
    if let Some(ref err) = startup_error {
        eprintln!("[reader] Returning startup error for session '{}': {}", session_id, err);
    }

    Ok(RegisterListenerResult {
        capabilities: session.device.capabilities(),
        state: session.device.state(),
        buffer_id,
        buffer_type,
        is_owner,
        listener_count: session.listeners.len(),
        startup_error,
    })
}

/// Unregister a listener from a session.
/// If this was the last listener, the session will be stopped and destroyed.
/// Returns the remaining listener count.
pub async fn unregister_listener(session_id: &str, listener_id: &str) -> Result<usize, String> {
    let mut sessions = IO_SESSIONS.lock().await;

    if let Some(session) = sessions.get_mut(session_id) {
        if session.listeners.remove(listener_id).is_some() {
            session.joiner_count = session.listeners.len();
            let remaining = session.listeners.len();
            let app = session.app.clone();

            eprintln!(
                "[reader] Session '{}' unregistered listener '{}', remaining: {}",
                session_id, listener_id, remaining
            );

            // Emit joiner count change
            emit_joiner_count_change(&app, session_id, remaining, Some(listener_id), Some("left"));

            // If no listeners left, stop and destroy the session
            if remaining == 0 {
                eprintln!("[reader] Session '{}' has no listeners left, destroying", session_id);
                let _ = session.device.stop().await;
                // Emit lifecycle event before removing
                let source_profile_ids = crate::sessions::get_session_profile_ids(session_id);
                emit_session_lifecycle(&app, SessionLifecyclePayload {
                    session_id: session_id.to_string(),
                    event_type: "destroyed".to_string(),
                    device_type: None,
                    state: None,
                    listener_count: 0,
                    source_profile_ids,
                    creator_listener_id: None,
                });
                // Remove from the session map (we already hold the lock)
                sessions.remove(session_id);
                // Clear any closing flag
                clear_session_closing(session_id);
                // Clean up profile tracking (release single-handle device locks)
                crate::sessions::cleanup_session_profiles(session_id);
                eprintln!("[reader] Session '{}' destroyed", session_id);
            }

            Ok(remaining)
        } else {
            // Listener wasn't registered - that's fine
            Ok(session.listeners.len())
        }
    } else {
        // Session doesn't exist - that's fine during cleanup
        Ok(0)
    }
}

/// Get all listeners for a session.
/// Useful for debugging and for the frontend to understand session state.
pub async fn get_session_listeners(session_id: &str) -> Result<Vec<ListenerInfo>, String> {
    let sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let now = std::time::Instant::now();
    let listeners: Vec<ListenerInfo> = session
        .listeners
        .values()
        .map(|l| ListenerInfo {
            listener_id: l.listener_id.clone(),
            is_owner: l.is_owner,
            registered_seconds_ago: now.duration_since(l.registered_at).as_secs(),
        })
        .collect();

    Ok(listeners)
}

/// Result of attempting a safe reinitialize
#[derive(Clone, Debug, Serialize)]
pub struct ReinitializeResult {
    /// Whether the reinitialize was successful
    pub success: bool,
    /// Reason for failure (if success is false)
    pub reason: Option<String>,
    /// List of other listeners preventing reinitialize (if any)
    pub other_listeners: Vec<String>,
}

/// Check if it's safe to reinitialize a session.
/// Reinitialize is only safe if the requesting listener is the only listener.
/// This is an atomic check-and-act operation to prevent race conditions.
///
/// If safe, the session will be destroyed so a new one can be created.
/// The caller should create a new session after this returns success.
pub async fn reinitialize_session_if_safe(
    session_id: &str,
    listener_id: &str,
) -> Result<ReinitializeResult, String> {
    let mut sessions = IO_SESSIONS.lock().await;

    // Session doesn't exist - that's fine, caller can create a new one
    let Some(session) = sessions.get_mut(session_id) else {
        return Ok(ReinitializeResult {
            success: true,
            reason: None,
            other_listeners: vec![],
        });
    };

    // Check if this listener is the only one
    let other_listeners: Vec<String> = session
        .listeners
        .keys()
        .filter(|id| *id != listener_id)
        .cloned()
        .collect();

    if !other_listeners.is_empty() {
        return Ok(ReinitializeResult {
            success: false,
            reason: Some(format!(
                "Cannot reinitialize: {} other listener(s) connected",
                other_listeners.len()
            )),
            other_listeners,
        });
    }

    // Safe to reinitialize - destroy the session
    if let Some(mut session) = sessions.remove(session_id) {
        // Emit lifecycle event before stopping
        let source_profile_ids = crate::sessions::get_session_profile_ids(session_id);
        emit_session_lifecycle(&session.app, SessionLifecyclePayload {
            session_id: session_id.to_string(),
            event_type: "destroyed".to_string(),
            device_type: None,
            state: None,
            listener_count: 0,
            source_profile_ids,
            creator_listener_id: None,
        });
        let _ = session.device.stop().await;
    }
    clear_session_closing(session_id);

    eprintln!(
        "[reader] Session '{}' reinitialized by listener '{}'",
        session_id, listener_id
    );

    Ok(ReinitializeResult {
        success: true,
        reason: None,
        other_listeners: vec![],
    })
}

/// Get the list of active listener IDs for a session.
/// Used by frame emitters to filter which listeners should receive frames.
#[tauri::command]
pub async fn get_active_listeners(session_id: String) -> Result<Vec<String>, String> {
    let sessions = IO_SESSIONS.lock().await;
    Ok(sessions
        .get(&session_id)
        .map(|session| {
            session
                .listeners
                .values()
                .filter(|l| l.is_active)
                .map(|l| l.listener_id.clone())
                .collect()
        })
        .unwrap_or_default())
}

/// Get the list of active listener IDs synchronously (non-async version).
/// Uses try_lock to avoid blocking; returns empty list if lock is held.
pub fn get_active_listeners_sync(session_id: &str) -> Vec<String> {
    if let Ok(sessions) = IO_SESSIONS.try_lock() {
        sessions
            .get(session_id)
            .map(|session| {
                session
                    .listeners
                    .values()
                    .filter(|l| l.is_active)
                    .map(|l| l.listener_id.clone())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        // Lock held by another task, return empty (rare case)
        vec![]
    }
}

/// Set the active state of a listener.
/// When a listener detaches (stops receiving frames), set is_active to false.
/// When they rejoin, set is_active to true.
pub async fn set_listener_active(session_id: &str, listener_id: &str, is_active: bool) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    if let Some(listener) = session.listeners.get_mut(listener_id) {
        let was_active = listener.is_active;
        listener.is_active = is_active;
        eprintln!(
            "[reader] Session '{}' listener '{}' active: {} -> {}",
            session_id, listener_id, was_active, is_active
        );
        Ok(())
    } else {
        Err(format!("Listener '{}' not found in session '{}'", listener_id, session_id))
    }
}
