// ui/src-tauri/src/io/serial/utils.rs
//
// Shared utilities for serial port readers.
// Provides common types and conversion functions for the serialport crate.

use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity as SpParity, StopBits};
use tokio::sync::mpsc;

use super::framer::{FrameIdConfig, FramingEncoding};
use crate::io::types::ModbusRtuOptions;
use crate::io::device_kinds::{conn_bool, conn_i64, conn_str, conn_u8_list};
use crate::io::SerialOverrides;
use crate::io::error::{DevicePresence, IoError};
use crate::io::types::SourceMessage;
use crate::settings::IOProfile;

// ============================================================================
// Device error reporting (shared by the serial-family read loops)
// ============================================================================

/// Probe whether a serial port still enumerates on the host, so an access-denied
/// failure can be told apart as "in use" (still present) vs "disconnected/reset"
/// (gone).
fn probe_serial_presence(port_name: &str) -> DevicePresence {
    match serialport::available_ports() {
        Ok(ports) if ports.iter().any(|p| p.port_name == port_name) => DevicePresence::Present,
        Ok(_) => DevicePresence::Absent,
        Err(_) => DevicePresence::Unknown,
    }
}

/// Classify a serial read failure (probing the port's presence to distinguish
/// "in use" from "disconnected") and send it as a `SourceMessage::Error`. Call
/// from the terminal error arm of a serial-family blocking read loop — probing
/// and classifying together is the only correct usage, so it lives in one place.
pub(crate) fn send_serial_read_error(
    tx: &mpsc::Sender<SourceMessage>,
    source_idx: usize,
    port_name: &str,
    err: &std::io::Error,
) {
    let presence = probe_serial_presence(port_name);
    let msg = IoError::device_stream_error_message(port_name, err, presence);
    let _ = tx.blocking_send(SourceMessage::Error(source_idx, msg));
}

// ============================================================================
// Types
// ============================================================================

/// Parity setting for serial port configuration
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Parity {
    None,
    Odd,
    Even,
}

impl Default for Parity {
    fn default() -> Self {
        Parity::None
    }
}

// ============================================================================
// Conversion Functions
// ============================================================================

/// Convert our Parity enum to serialport crate's Parity type
pub fn to_serialport_parity(p: &Parity) -> SpParity {
    match p {
        Parity::None => SpParity::None,
        Parity::Odd => SpParity::Odd,
        Parity::Even => SpParity::Even,
    }
}

/// Convert a parity string ("none", "odd", "even") to serialport crate's Parity type
pub fn parity_str_to_serialport(s: &str) -> SpParity {
    match s.to_lowercase().as_str() {
        "odd" => SpParity::Odd,
        "even" => SpParity::Even,
        _ => SpParity::None,
    }
}

/// Convert data bits count to serialport crate's DataBits type
pub fn to_serialport_data_bits(bits: u8) -> DataBits {
    match bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    }
}

/// Convert stop bits count to serialport crate's StopBits type
pub fn to_serialport_stop_bits(bits: u8) -> StopBits {
    match bits {
        2 => StopBits::Two,
        _ => StopBits::One,
    }
}

// ============================================================================
// Profile Parsing for Multi-Source
// ============================================================================

/// Configuration for a serial source in multi-source mode.
/// Parsed from an IOProfile with optional overrides from session options.
#[derive(Clone, Debug)]
pub struct SerialSourceConfig {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: Parity,
    pub framing_encoding: FramingEncoding,
    pub frame_id_config: Option<FrameIdConfig>,
    pub source_address_config: Option<FrameIdConfig>,
    pub min_frame_length: usize,
    pub emit_raw_bytes: bool,
}

/// Build a [`FramingEncoding`] from an encoding name using defaults, for live
/// framing changes that carry no profile context. Mirrors the `match` in
/// [`parse_profile_for_source`] (anything that isn't a real framer → `Raw`).
pub fn framing_from_str(encoding: &str, modbus: Option<&ModbusRtuOptions>) -> FramingEncoding {
    match encoding {
        "slip" => FramingEncoding::Slip,
        "modbus_rtu" => FramingEncoding::ModbusRtu(modbus.cloned().unwrap_or_default()),
        "delimiter" => FramingEncoding::Delimiter {
            delimiter: vec![0x0A],
            max_length: 1024,
            include_delimiter: false,
        },
        _ => FramingEncoding::Raw,
    }
}

/// Where a frame id or source address is read from within a framed message: the
/// session's override if it names a start byte, else the profile's own triple,
/// else nothing.
///
/// One function for both, keyed on the field prefix — they were two byte-identical
/// blocks here *and* a third copy applying the override in the broker's spawner,
/// so a session override reached the reader only because a caller remembered to
/// re-apply it after this function had already answered.
fn extraction(
    profile: &IOProfile,
    prefix: &str,
    start: Option<i32>,
    bytes: Option<u8>,
    big_endian: Option<bool>,
) -> Option<FrameIdConfig> {
    let field = |suffix: &str| format!("{prefix}_{suffix}");
    let start_byte = start.or_else(|| conn_i64(profile, &field("start_byte")).map(|n| n as i32))?;
    Some(FrameIdConfig {
        start_byte,
        num_bytes: bytes
            .or_else(|| conn_i64(profile, &field("bytes")).map(|n| n as u8))
            .unwrap_or(1),
        big_endian: big_endian
            .or_else(|| conn_bool(profile, &field("big_endian")))
            .unwrap_or(true),
    })
}

/// Parse an IOProfile into a SerialSourceConfig, applying session-level overrides.
///
/// Returns `None` if the port is not specified in the profile.
pub fn parse_profile_for_source(
    profile: &IOProfile,
    overrides: &SerialOverrides,
) -> Option<SerialSourceConfig> {
    let port = conn_str(profile, "port")?;

    // Line settings come from `io::device_kinds`, the one declaration the form
    // also seeds from.
    let baud_rate = conn_i64(profile, "baud_rate").unwrap_or_default() as u32;
    let data_bits = conn_i64(profile, "data_bits").unwrap_or_default() as u8;
    let stop_bits = conn_i64(profile, "stop_bits").unwrap_or_default() as u8;
    let parity = match conn_str(profile, "parity").unwrap_or_default().as_str() {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    };

    // Session override, then profile, then the kind default — resolved by the
    // same function the broker uses to decide which captures to create, so the
    // port and the session cannot disagree about what is on the wire.
    let (framing_encoding_str, emit_raw_bytes) = crate::io::device_kinds::resolve_serial_framing(
        profile,
        overrides.framing_encoding.as_deref(),
        overrides.emit_raw_bytes,
    );

    let framing_encoding = match framing_encoding_str.as_str() {
        "slip" => FramingEncoding::Slip,
        // Session override first, then the profile, then the default — the
        // picker's "Validate CRC" tick had no way through before and did nothing.
        "modbus_rtu" => FramingEncoding::ModbusRtu(ModbusRtuOptions {
            device_address: overrides
                .modbus_device_address
                .or_else(|| conn_i64(profile, "modbus_device_address").map(|n| n as u8)),
            validate_crc: overrides
                .modbus_validate_crc
                .or_else(|| conn_bool(profile, "modbus_validate_crc"))
                .unwrap_or(true),
            vendor_functions: overrides
                .modbus_vendor_functions
                .clone()
                .or_else(|| conn_u8_list(profile, "modbus_vendor_functions"))
                .unwrap_or_default(),
            allow_broadcast: overrides
                .modbus_allow_broadcast
                .or_else(|| conn_bool(profile, "modbus_allow_broadcast"))
                .unwrap_or(false),
            any_function: overrides
                .modbus_any_function
                .or_else(|| conn_bool(profile, "modbus_any_function"))
                .unwrap_or(false),
        }),
        "delimiter" => {
            let delimiter = overrides
                .delimiter
                .clone()
                .or_else(|| conn_u8_list(profile, "delimiter"))
                .unwrap_or_else(|| vec![0x0A]); // Default to newline
            let max_length = overrides
                .max_frame_length
                .or_else(|| conn_i64(profile, "max_frame_length").map(|n| n as usize))
                .unwrap_or(1024);
            let include_delimiter = conn_bool(profile, "include_delimiter").unwrap_or(false);
            FramingEncoding::Delimiter {
                delimiter,
                max_length,
                include_delimiter,
            }
        }
        "raw" | _ => FramingEncoding::Raw,
    };

    let frame_id_config = extraction(
        profile,
        "frame_id",
        overrides.frame_id_start_byte,
        overrides.frame_id_bytes,
        overrides.frame_id_big_endian,
    );
    let source_address_config = extraction(
        profile,
        "source_address",
        overrides.source_address_start_byte,
        overrides.source_address_bytes,
        overrides.source_address_big_endian,
    );

    let min_frame_length = overrides
        .min_frame_length
        .or_else(|| conn_i64(profile, "min_frame_length").map(|n| n as usize))
        .unwrap_or(0);

    Some(SerialSourceConfig {
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
    })
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parity_default() {
        assert_eq!(Parity::default(), Parity::None);
    }

    #[test]
    fn test_to_serialport_parity() {
        assert!(matches!(to_serialport_parity(&Parity::None), SpParity::None));
        assert!(matches!(to_serialport_parity(&Parity::Odd), SpParity::Odd));
        assert!(matches!(to_serialport_parity(&Parity::Even), SpParity::Even));
    }

    #[test]
    fn test_to_serialport_data_bits() {
        assert!(matches!(to_serialport_data_bits(5), DataBits::Five));
        assert!(matches!(to_serialport_data_bits(6), DataBits::Six));
        assert!(matches!(to_serialport_data_bits(7), DataBits::Seven));
        assert!(matches!(to_serialport_data_bits(8), DataBits::Eight));
        assert!(matches!(to_serialport_data_bits(9), DataBits::Eight)); // default
    }

    #[test]
    fn test_to_serialport_stop_bits() {
        assert!(matches!(to_serialport_stop_bits(1), StopBits::One));
        assert!(matches!(to_serialport_stop_bits(2), StopBits::Two));
        assert!(matches!(to_serialport_stop_bits(0), StopBits::One)); // default
    }
}
