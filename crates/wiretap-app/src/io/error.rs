// crates/wiretap-app/src/io/error.rs
//
// Structured error types for the IO module.
// Provides typed errors with device context for better diagnostics and handling.

use std::fmt;

use serde::Serialize;
use wiretap_io::can::{CanError, TransportError};
use wiretap_io::net::ResolveError;
#[cfg(not(target_os = "ios"))]
use wiretap_io::serial::SerialError;

/// Structured IO error with device context.
///
/// These error variants capture common failure modes in CAN device communication,
/// providing consistent error messages and enabling pattern matching for specific
/// error handling.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IoError {
    /// Connection failure (TCP connect, serial open, USB claim)
    Connection { device: String, details: String },

    /// Hostname could not be resolved — no such name, or the resolver itself was
    /// unreachable. Kept distinct from [`Connection`]/[`Timeout`] because the fix
    /// is a network/VPN one, not a device one.
    ///
    /// [`Connection`]: IoError::Connection
    /// [`Timeout`]: IoError::Timeout
    DnsResolution { host: String, details: String },

    /// Operation timed out
    Timeout { device: String, operation: String },

    /// Protocol-level error (invalid response, parse failure, framing error)
    Protocol { device: String, details: String },

    /// Transmission failure (write error, channel closed)
    Transmission { device: String, details: String },

    /// Configuration error (invalid bitrate, unsupported option)
    Configuration { details: String },

    /// Device not found (USB enumeration, serial port not present)
    DeviceNotFound { device: String },

    /// Device is busy or locked by another process
    DeviceBusy { device: String },

    /// Device stopped responding mid-session (unplugged, reset, handle invalidated)
    DeviceDisconnected { device: String },

    /// Read error during streaming
    Read { device: String, details: String },

    /// No session under the id
    SessionNotFound { session_id: String },

    /// Generic IO error for cases that don't fit other variants
    Other { device: Option<String>, details: String },
}

/// Which [`IoError`] a failure is: one per variant, so the frontend branches on
/// this rather than on the message. The discriminant is its byte on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[repr(u8)]
pub enum IoErrorKind {
    Connection,
    DnsResolution,
    Timeout,
    Protocol,
    Transmission,
    Configuration,
    DeviceNotFound,
    DeviceBusy,
    DeviceDisconnected,
    Read,
    SessionNotFound,
    Other,
}

impl IoErrorKind {
    pub const ALL: [Self; 12] = [
        Self::Connection,
        Self::DnsResolution,
        Self::Timeout,
        Self::Protocol,
        Self::Transmission,
        Self::Configuration,
        Self::DeviceNotFound,
        Self::DeviceBusy,
        Self::DeviceDisconnected,
        Self::Read,
        Self::SessionNotFound,
        Self::Other,
    ];

    pub fn code(self) -> u8 {
        self as u8
    }
}

/// A failure as it reaches the frontend: its kind, in the words it is shown in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct IoFailure {
    pub kind: IoErrorKind,
    pub message: String,
}

impl IoFailure {
    pub fn new(kind: IoErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl fmt::Display for IoFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<IoError> for IoFailure {
    fn from(err: IoError) -> Self {
        Self::new(err.kind(), err.to_string())
    }
}

/// An untyped error string, which carries no kind.
impl From<String> for IoFailure {
    fn from(message: String) -> Self {
        Self::new(IoErrorKind::Other, message)
    }
}

impl From<IoFailure> for String {
    fn from(failure: IoFailure) -> String {
        failure.message
    }
}

impl IoError {
    /// Create a connection error
    pub fn connection(device: impl Into<String>, details: impl Into<String>) -> Self {
        Self::Connection {
            device: device.into(),
            details: details.into(),
        }
    }

    /// Create a timeout error
    pub fn timeout(device: impl Into<String>, operation: impl Into<String>) -> Self {
        Self::Timeout {
            device: device.into(),
            operation: operation.into(),
        }
    }

    /// Create a hostname resolution error
    pub fn dns_resolution(host: impl Into<String>, details: impl Into<String>) -> Self {
        Self::DnsResolution {
            host: host.into(),
            details: details.into(),
        }
    }

    /// Create a protocol error
    pub fn protocol(device: impl Into<String>, details: impl Into<String>) -> Self {
        Self::Protocol {
            device: device.into(),
            details: details.into(),
        }
    }

    /// Create a transmission error
    pub fn transmission(device: impl Into<String>, details: impl Into<String>) -> Self {
        Self::Transmission {
            device: device.into(),
            details: details.into(),
        }
    }

    /// Create a configuration error
    pub fn configuration(details: impl Into<String>) -> Self {
        Self::Configuration {
            details: details.into(),
        }
    }

    /// Create a device not found error
    pub fn not_found(device: impl Into<String>) -> Self {
        Self::DeviceNotFound {
            device: device.into(),
        }
    }

    /// Create a device busy error
    pub fn busy(device: impl Into<String>) -> Self {
        Self::DeviceBusy {
            device: device.into(),
        }
    }

    /// Create a read error
    pub fn read(device: impl Into<String>, details: impl Into<String>) -> Self {
        Self::Read {
            device: device.into(),
            details: details.into(),
        }
    }

    /// Create a generic error with device context
    pub fn other(device: impl Into<String>, details: impl Into<String>) -> Self {
        Self::Other {
            device: Some(device.into()),
            details: details.into(),
        }
    }

    /// Create a generic error without device context
    pub fn other_no_device(details: impl Into<String>) -> Self {
        Self::Other {
            device: None,
            details: details.into(),
        }
    }

    /// Get the device name if present
    pub fn device(&self) -> Option<&str> {
        match self {
            Self::Connection { device, .. } => Some(device),
            Self::Timeout { device, .. } => Some(device),
            Self::DnsResolution { host, .. } => Some(host),
            Self::Protocol { device, .. } => Some(device),
            Self::Transmission { device, .. } => Some(device),
            Self::Configuration { .. } => None,
            Self::DeviceNotFound { device } => Some(device),
            Self::DeviceBusy { device } => Some(device),
            Self::DeviceDisconnected { device } => Some(device),
            Self::Read { device, .. } => Some(device),
            Self::SessionNotFound { .. } => None,
            Self::Other { device, .. } => device.as_deref(),
        }
    }

    pub fn kind(&self) -> IoErrorKind {
        match self {
            Self::Connection { .. } => IoErrorKind::Connection,
            Self::DnsResolution { .. } => IoErrorKind::DnsResolution,
            Self::Timeout { .. } => IoErrorKind::Timeout,
            Self::Protocol { .. } => IoErrorKind::Protocol,
            Self::Transmission { .. } => IoErrorKind::Transmission,
            Self::Configuration { .. } => IoErrorKind::Configuration,
            Self::DeviceNotFound { .. } => IoErrorKind::DeviceNotFound,
            Self::DeviceBusy { .. } => IoErrorKind::DeviceBusy,
            Self::DeviceDisconnected { .. } => IoErrorKind::DeviceDisconnected,
            Self::Read { .. } => IoErrorKind::Read,
            Self::SessionNotFound { .. } => IoErrorKind::SessionNotFound,
            Self::Other { .. } => IoErrorKind::Other,
        }
    }

    /// The failure in [`user_message`](Self::user_message)'s words.
    pub(crate) fn for_user(self) -> IoFailure {
        IoFailure::new(self.kind(), self.user_message())
    }
}

impl fmt::Display for IoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connection { device, details } => {
                write!(f, "[{}] connection failed: {}", device, details)
            }
            Self::Timeout { device, operation } => {
                write!(f, "[{}] {} timed out", device, operation)
            }
            Self::DnsResolution { host, details } => {
                write!(f, "[{}] cannot resolve hostname: {}", host, details)
            }
            Self::Protocol { device, details } => {
                write!(f, "[{}] protocol error: {}", device, details)
            }
            Self::Transmission { device, details } => {
                write!(f, "[{}] transmission failed: {}", device, details)
            }
            Self::Configuration { details } => {
                write!(f, "configuration error: {}", details)
            }
            Self::DeviceNotFound { device } => {
                write!(f, "[{}] device not found", device)
            }
            Self::DeviceBusy { device } => {
                write!(f, "[{}] device is busy", device)
            }
            Self::DeviceDisconnected { device } => {
                write!(f, "[{}] device disconnected", device)
            }
            Self::Read { device, details } => {
                write!(f, "[{}] read error: {}", device, details)
            }
            Self::SessionNotFound { session_id } => {
                write!(f, "Session '{}' not found", session_id)
            }
            Self::Other { device: Some(d), details } => {
                write!(f, "[{}] {}", d, details)
            }
            Self::Other { device: None, details } => {
                write!(f, "{}", details)
            }
        }
    }
}

impl std::error::Error for IoError {}

/// Backwards compatibility: convert IoError to String for existing code.
/// This allows gradual migration - functions can return Result<T, IoError>
/// and callers expecting Result<T, String> will still work.
impl From<IoError> for String {
    fn from(err: IoError) -> String {
        err.to_string()
    }
}

/// Whether a device still enumerates on the host at error time. Lets an
/// access-denied failure be distinguished as "in use" (still present) vs
/// "disconnected/reset" (gone).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DevicePresence {
    Present,
    Absent,
    Unknown,
}

/// Convert std::io::Error to IoError with device context
impl IoError {
    /// Classify a device open/read failure, using an enumeration probe to tell
    /// "in use" from "disconnected". Access-denied — Windows `ERROR_ACCESS_DENIED`
    /// (os error 5, mapped to `PermissionDenied`), Unix `EACCES`/`EBUSY`, or the
    /// `AddrInUse`/`AlreadyExists` kinds — becomes [`DeviceBusy`] when the device
    /// is still `Present` (or `Unknown`) and [`DeviceDisconnected`] when `Absent`.
    ///
    /// [`DeviceBusy`]: IoError::DeviceBusy
    /// [`DeviceDisconnected`]: IoError::DeviceDisconnected
    pub(crate) fn from_device_error(
        device: impl Into<String>,
        err: &std::io::Error,
        presence: DevicePresence,
    ) -> Self {
        let device = device.into();
        // EACCES=13, EBUSY=16 (Unix); ERROR_ACCESS_DENIED=5 (Windows) also maps
        // to PermissionDenied, but match the raw code too as belt-and-braces.
        let access_denied = matches!(
            err.kind(),
            std::io::ErrorKind::PermissionDenied
                | std::io::ErrorKind::AddrInUse
                | std::io::ErrorKind::AlreadyExists
        ) || matches!(err.raw_os_error(), Some(5) | Some(13) | Some(16));
        let not_found = err.kind() == std::io::ErrorKind::NotFound;

        // A device that no longer enumerates is disconnected, whichever failure
        // it surfaced as.
        if presence == DevicePresence::Absent && (access_denied || not_found) {
            Self::DeviceDisconnected { device }
        } else if access_denied {
            Self::DeviceBusy { device }
        } else if not_found {
            Self::DeviceNotFound { device }
        } else {
            Self::Read {
                device,
                details: err.to_string(),
            }
        }
    }

    /// A user-facing, actionable message for the device-state variants (names the
    /// device and states the fix). Other variants fall back to [`Display`]. This
    /// is kept separate from `Display` so the terse machine strings other callers
    /// rely on are unchanged.
    ///
    /// [`Display`]: std::fmt::Display
    pub(crate) fn user_message(&self) -> String {
        match self {
            Self::DeviceBusy { device } => format!(
                "{device} is unavailable — it may be in use by another application \
                 (including another WireTAP window) or you may not have permission to \
                 access it. Close any program using it, then try again."
            ),
            Self::DeviceDisconnected { device } => format!(
                "{device} stopped responding — it may have been unplugged or reset. \
                 Reconnect the device, then try again."
            ),
            Self::DeviceNotFound { device } => format!(
                "{device} could not be found — check that it is connected, then try again."
            ),
            // Deliberately avoids the substring "not found". sessionStore's
            // expected-error filter used to drop any message containing it, which is
            // how faults like SocketCAN's "pkexec not found" reached the error state
            // with no dialog. The filter reads the kind now; the wording stays defensive.
            Self::DnsResolution { host, details } => format!(
                "Cannot resolve the hostname {host} — {details}. Check the name is spelled \
                 correctly, and that you are connected to the network or VPN that serves it."
            ),
            other => other.to_string(),
        }
    }

    pub fn from_io_error(device: impl Into<String>, operation: &str, err: std::io::Error) -> Self {
        let device = device.into();
        match err.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                Self::Timeout {
                    device,
                    operation: operation.to_string(),
                }
            }
            std::io::ErrorKind::NotFound => Self::DeviceNotFound { device },
            std::io::ErrorKind::PermissionDenied
            | std::io::ErrorKind::AddrInUse
            | std::io::ErrorKind::AlreadyExists => Self::DeviceBusy { device },
            std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::NotConnected => Self::Connection {
                device,
                details: err.to_string(),
            },
            _ => Self::Other {
                device: Some(device),
                details: format!("{}: {}", operation, err),
            },
        }
    }
}

// ============================================================================
// From `wiretap_io`'s CAN, serial and TCP errors: the kind from the app's
// taxonomy, the words as each was shown before.
// ============================================================================

impl IoError {
    pub(crate) fn from_resolve(host: &str, reason: &ResolveError) -> Self {
        Self::dns_resolution(
            host,
            match reason {
                ResolveError::NoAddresses => "the name resolved to no addresses".to_string(),
                ResolveError::TimedOut => "the DNS resolver did not respond".to_string(),
                ResolveError::Io(e) => e.to_string(),
            },
        )
    }

    pub(crate) fn from_transport(device: &str, error: &TransportError) -> Self {
        match error {
            TransportError::Resolve { endpoint, reason } => Self::from_resolve(
                endpoint
                    .rsplit_once(':')
                    .map_or(endpoint.as_str(), |(host, _)| host),
                reason,
            ),
            TransportError::ConnectTimeout { .. } | TransportError::Timeout { .. } => {
                Self::timeout(device, "connect")
            }
            other => Self::connection(device, other.to_string()),
        }
    }
}

impl IoFailure {
    /// A CAN task's failure to open, or the loss that ended it, on `device`.
    pub(crate) fn from_can(device: &str, error: CanError) -> Self {
        let kind = match &error {
            CanError::Open { source, .. } => {
                return IoError::connection(device, source.to_string()).into()
            }
            CanError::Connect(e) => return IoError::from_transport(device, e).for_user(),
            CanError::Handshake(_) => IoErrorKind::Protocol,
            CanError::Config(_) => IoErrorKind::Configuration,
            CanError::Closed | CanError::Unresponsive => IoErrorKind::DeviceDisconnected,
            CanError::Read(_) => IoErrorKind::Read,
            _ => IoErrorKind::Other,
        };
        Self::new(kind, format!("{device}: {error}"))
    }

    /// A serial port that would not open.
    #[cfg(not(target_os = "ios"))]
    pub(crate) fn from_serial_open(port: &str, error: SerialError) -> Self {
        let (kind, reason) = match error {
            SerialError::Open { source, .. } => {
                let reason = source.to_string();
                (IoError::from_io_error(port, "open", source).kind(), reason)
            }
            other => (IoErrorKind::Configuration, other.to_string()),
        };
        Self::new(kind, format!("Failed to open {port}: {reason}"))
    }
}

/// How a port was lost mid-session, whichever reader lost it.
#[cfg(not(target_os = "ios"))]
pub(crate) enum PortLoss {
    Closed,
    Read(std::io::Error),
    Other(String),
}

#[cfg(not(target_os = "ios"))]
impl From<SerialError> for PortLoss {
    fn from(error: SerialError) -> Self {
        match error {
            SerialError::Closed => Self::Closed,
            SerialError::Read(e) => Self::Read(e),
            other => Self::Other(other.to_string()),
        }
    }
}

#[cfg(not(target_os = "ios"))]
impl From<CanError> for PortLoss {
    fn from(error: CanError) -> Self {
        match error {
            CanError::Closed => Self::Closed,
            CanError::Read(e) => Self::Read(e),
            other => Self::Other(other.to_string()),
        }
    }
}

/// A zero-byte read is the device going away; any other read error is told
/// apart as "in use" or "gone" by whether the port still enumerates.
#[cfg(not(target_os = "ios"))]
pub(crate) fn outage(
    port: &str,
    loss: PortLoss,
    presence: impl FnOnce(&str) -> DevicePresence,
) -> IoFailure {
    let (kind, why) = match loss {
        PortLoss::Closed => (IoErrorKind::DeviceDisconnected, "device disconnected".to_string()),
        PortLoss::Read(e) => match IoError::from_device_error(port, &e, presence(port)) {
            IoError::DeviceDisconnected { .. } => {
                (IoErrorKind::DeviceDisconnected, "device disconnected".to_string())
            }
            IoError::DeviceBusy { .. } => (
                IoErrorKind::DeviceBusy,
                "device unavailable, it may be in use by another application".to_string(),
            ),
            _ => (IoErrorKind::Read, format!("read failed: {e}")),
        },
        PortLoss::Other(why) => (IoErrorKind::Other, why),
    };
    IoFailure::new(kind, format!("{port}: {why}, waiting for it to return"))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_connection_error_display() {
        let err = IoError::connection("gvret_tcp(192.168.1.1:23)", "connection refused");
        assert_eq!(
            err.to_string(),
            "[gvret_tcp(192.168.1.1:23)] connection failed: connection refused"
        );
    }

    #[test]
    fn test_timeout_error_display() {
        let err = IoError::timeout("slcan(/dev/ttyUSB0)", "read");
        assert_eq!(err.to_string(), "[slcan(/dev/ttyUSB0)] read timed out");
    }

    #[test]
    fn test_protocol_error_display() {
        let err = IoError::protocol("gvret_usb", "invalid frame format");
        assert_eq!(
            err.to_string(),
            "[gvret_usb] protocol error: invalid frame format"
        );
    }

    #[test]
    fn test_configuration_error_display() {
        let err = IoError::configuration("invalid bitrate 123456");
        assert_eq!(err.to_string(), "configuration error: invalid bitrate 123456");
    }

    #[test]
    fn test_device_not_found_display() {
        let err = IoError::not_found("gs_usb(1:5)");
        assert_eq!(err.to_string(), "[gs_usb(1:5)] device not found");
    }

    #[test]
    fn test_into_string_conversion() {
        let err = IoError::timeout("device", "connect");
        let s: String = err.into();
        assert_eq!(s, "[device] connect timed out");
    }

    #[test]
    fn test_device_accessor() {
        let err = IoError::connection("mydevice", "failed");
        assert_eq!(err.device(), Some("mydevice"));

        let err = IoError::configuration("invalid");
        assert_eq!(err.device(), None);
    }

    #[test]
    fn test_from_io_error_timeout() {
        let io_err = std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out");
        let err = IoError::from_io_error("device", "read", io_err);
        assert!(matches!(err, IoError::Timeout { .. }));
    }

    #[test]
    fn test_from_io_error_not_found() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "not found");
        let err = IoError::from_io_error("device", "open", io_err);
        assert!(matches!(err, IoError::DeviceNotFound { .. }));
    }

    #[test]
    fn test_from_io_error_connection() {
        let io_err = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused");
        let err = IoError::from_io_error("device", "connect", io_err);
        assert!(matches!(err, IoError::Connection { .. }));
    }

    #[test]
    fn test_dns_message_names_the_host_and_points_at_the_network() {
        // The VPN-down case. It used to surface as "[gvret_tcp(host:23)] connect timed
        // out", which pointed at the device instead of the network. The message must
        // also avoid "not found", which sessionStore's filter once dropped wholesale.
        let err = IoError::dns_resolution("pi4.example.com", "the DNS resolver did not respond");
        let msg = err.user_message();
        assert!(msg.contains("pi4.example.com"));
        assert!(msg.contains("the DNS resolver did not respond"));
        assert!(msg.contains("VPN"));
        assert!(!msg.contains("not found"));
        assert!(!err.to_string().contains("not found"));
    }

    #[test]
    fn test_dns_resolution_display_is_distinct_from_timeout() {
        // The whole point of the variant: these two must not read alike.
        let dns = IoError::dns_resolution("host.example.com", "the DNS resolver did not respond");
        let connect = IoError::timeout("gvret_tcp(host.example.com:23)", "connect");
        assert_eq!(
            dns.to_string(),
            "[host.example.com] cannot resolve hostname: the DNS resolver did not respond"
        );
        assert_eq!(
            connect.to_string(),
            "[gvret_tcp(host.example.com:23)] connect timed out"
        );
    }

    #[test]
    fn test_from_device_error_access_denied_present_is_busy() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Access is denied.");
        let err = IoError::from_device_error("COM5", &io_err, DevicePresence::Present);
        assert!(matches!(err, IoError::DeviceBusy { .. }));
        assert!(err.user_message().contains("COM5"));
        assert!(err.user_message().contains("in use"));
    }

    #[test]
    fn test_from_device_error_access_denied_absent_is_disconnected() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Access is denied.");
        let err = IoError::from_device_error("COM5", &io_err, DevicePresence::Absent);
        assert!(matches!(err, IoError::DeviceDisconnected { .. }));
        assert!(err.user_message().contains("unplugged or reset"));
    }

    #[test]
    fn test_from_device_error_unknown_presence_defaults_to_busy() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let err = IoError::from_device_error("COM5", &io_err, DevicePresence::Unknown);
        assert!(matches!(err, IoError::DeviceBusy { .. }));
    }

    #[test]
    fn test_from_device_error_ebusy_raw_code_is_busy() {
        // macOS/Linux EBUSY (16) — a serial port held by another app — should
        // classify as busy even though the kind may not be PermissionDenied.
        let io_err = std::io::Error::from_raw_os_error(16);
        let err = IoError::from_device_error("/dev/cu.usbserial", &io_err, DevicePresence::Present);
        assert!(matches!(err, IoError::DeviceBusy { .. }));
    }

    #[test]
    fn test_from_device_error_generic_falls_through_to_read() {
        let io_err = std::io::Error::new(std::io::ErrorKind::InvalidData, "garbage");
        let err = IoError::from_device_error("COM5", &io_err, DevicePresence::Present);
        assert!(matches!(err, IoError::Read { .. }));
    }

    #[test]
    fn test_user_message_falls_back_to_display_for_other_variants() {
        let err = IoError::protocol("gvret_usb", "bad frame");
        assert_eq!(err.user_message(), err.to_string());
    }

    #[test]
    fn every_kind_is_its_own_byte() {
        for (code, kind) in IoErrorKind::ALL.into_iter().enumerate() {
            assert_eq!(usize::from(kind.code()), code);
        }
    }

    #[test]
    fn a_failure_keeps_the_words_and_names_the_variant() {
        let failure = IoFailure::from(IoError::SessionNotFound { session_id: "f_1".into() });
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            serde_json::json!({ "kind": "sessionNotFound", "message": "Session 'f_1' not found" })
        );
        let busy = IoError::busy("COM5");
        assert_eq!(busy.clone().for_user(), IoFailure::new(IoErrorKind::DeviceBusy, busy.user_message()));
        assert_eq!(IoFailure::from("boom".to_string()).kind, IoErrorKind::Other);
    }

    #[cfg(not(target_os = "ios"))]
    #[test]
    fn a_port_that_will_not_open_says_why_in_the_words_it_always_has() {
        let missing = SerialError::Open {
            path: "/dev/x".into(),
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "no such port"),
        };
        assert_eq!(
            IoFailure::from_serial_open("/dev/x", missing),
            IoFailure::new(IoErrorKind::DeviceNotFound, "Failed to open /dev/x: no such port")
        );
        assert_eq!(
            IoFailure::from_serial_open("/dev/x", SerialError::UnsupportedBaud(7)),
            IoFailure::new(IoErrorKind::Configuration, "Failed to open /dev/x: 7 baud is not supported")
        );
    }
}
