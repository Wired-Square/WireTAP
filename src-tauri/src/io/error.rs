// src-tauri/src/io/error.rs
//
// Structured error types for the IO module.
// Provides typed errors with device context for better diagnostics and handling.

use std::fmt;

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

    /// Generic IO error for cases that don't fit other variants
    Other { device: Option<String>, details: String },
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
            Self::Other { device, .. } => device.as_deref(),
        }
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

    /// Classify a device read/open failure and render the full user-facing
    /// message, appending the raw OS error code (for support) to the device-state
    /// variants. This is the string a driver sends on `SourceMessage::Error`.
    pub(crate) fn device_stream_error_message(
        device: impl Into<String>,
        err: &std::io::Error,
        presence: DevicePresence,
    ) -> String {
        let classified = Self::from_device_error(device, err, presence);
        let message = classified.user_message();
        // Device-state variants are actionable prose with no embedded error text,
        // so append the raw OS code for support; other variants already carry it.
        match err.raw_os_error() {
            Some(code) if classified.is_device_state() => format!("{message} (os error {code})"),
            _ => message,
        }
    }

    /// Whether this is one of the presence/availability device-state variants
    /// whose `user_message` is actionable prose without an embedded OS error.
    fn is_device_state(&self) -> bool {
        matches!(
            self,
            Self::DeviceBusy { .. } | Self::DeviceDisconnected { .. } | Self::DeviceNotFound { .. }
        )
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
            // with no dialog. The filter is anchored now; the wording stays defensive.
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
}
