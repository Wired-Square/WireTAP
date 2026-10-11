// ui/crates/wiretap-app/src/io/serial/utils.rs
//
// Shared utilities for serial port readers.

use crate::io::error::DevicePresence;

// ============================================================================
// Device error reporting (shared by the serial-family read loops)
// ============================================================================

/// Probe whether a serial port still enumerates on the host, so an access-denied
/// failure can be told apart as "in use" (still present) vs "disconnected/reset"
/// (gone).
pub(crate) fn probe_serial_presence(port_name: &str) -> DevicePresence {
    match wiretap_io::serial::ports() {
        Ok(ports) if ports.iter().any(|p| p.path == port_name) => DevicePresence::Present,
        Ok(_) => DevicePresence::Absent,
        Err(_) => DevicePresence::Unknown,
    }
}
