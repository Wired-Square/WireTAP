// ui/crates/wiretap-app/src/io/serial/utils.rs
//
// Shared utilities for serial port readers.

use wslib_wiretap_protocol::ingest::{modbus_id, MODBUS_RTU_PROTOCOL};

use crate::io::error::DevicePresence;
use crate::io::FrameMessage;

// ============================================================================
// Device error reporting (shared by the serial-family read loops)
// ============================================================================

/// Probe whether a serial port still enumerates on the host, so an access-denied
/// failure can be told apart as "in use" (still present) vs "disconnected/reset"
/// (gone).
pub(crate) fn probe_serial_presence(port_name: &str) -> DevicePresence {
    match wslib_serial::ports() {
        Ok(ports) if ports.iter().any(|p| p.path == port_name) => DevicePresence::Present,
        Ok(_) => DevicePresence::Absent,
        Err(_) => DevicePresence::Unknown,
    }
}

/// A message framed off a serial line. A Modbus RTU message, the only kind with a
/// CRC verdict, is stored as the archive stores it: keyed by unit and function,
/// whatever id `serial_id` would give it.
pub(crate) fn framed_serial(
    bytes: Vec<u8>,
    crc_valid: Option<bool>,
    serial_id: impl FnOnce(&[u8]) -> u32,
) -> FrameMessage {
    let (protocol, frame_id) = match (crc_valid, bytes.as_slice()) {
        (Some(_), [unit, function, ..]) => (MODBUS_RTU_PROTOCOL, modbus_id(*unit, *function)),
        _ => ("serial", serial_id(&bytes)),
    };
    FrameMessage {
        protocol: protocol.to_string(),
        frame_id,
        dlc: bytes.len() as u16,
        bytes,
        crc_valid,
        ..Default::default()
    }
}
