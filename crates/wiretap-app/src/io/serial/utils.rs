// ui/crates/wiretap-app/src/io/serial/utils.rs
//
// Shared utilities for serial port readers.

use wiretap_io::serial::{LineSettings, Parity, SerialError};

use super::framer::{DelimiterOptions, FrameIdConfig, FramingEncoding};
use crate::io::types::{FramingMode, ModbusRtuOptions};
use crate::io::device_kinds::{conn_bool, conn_i64, conn_str, conn_u8_list};
use crate::io::SerialOverrides;
use crate::io::error::{DevicePresence, IoError};
use crate::settings::IOProfile;

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

/// How a port was lost mid-session, whichever reader lost it.
pub(crate) enum PortLoss {
    Closed,
    Read(std::io::Error),
    Other(String),
}

impl From<SerialError> for PortLoss {
    fn from(error: SerialError) -> Self {
        match error {
            SerialError::Closed => Self::Closed,
            SerialError::Read(e) => Self::Read(e),
            other => Self::Other(other.to_string()),
        }
    }
}

/// A zero-byte read is the device going away; any other read error is told
/// apart as "in use" or "gone" by whether the port still enumerates.
pub(crate) fn outage_message(
    port: &str,
    loss: PortLoss,
    presence: impl FnOnce(&str) -> DevicePresence,
) -> String {
    let why = match loss {
        PortLoss::Closed => "device disconnected".to_string(),
        PortLoss::Read(e) => match IoError::from_device_error(port, &e, presence(port)) {
            IoError::DeviceDisconnected { .. } => "device disconnected".to_string(),
            IoError::DeviceBusy { .. } => {
                "device unavailable, it may be in use by another application".to_string()
            }
            _ => format!("read failed: {e}"),
        },
        PortLoss::Other(why) => why,
    };
    format!("{port}: {why}, waiting for it to return")
}

// ============================================================================
// Profile Parsing for Multi-Source
// ============================================================================

/// Configuration for a serial source in multi-source mode.
/// Parsed from an IOProfile with optional overrides from session options.
#[derive(Clone, Debug)]
pub struct SerialSourceConfig {
    pub port: String,
    pub line: LineSettings,
    pub framing_encoding: FramingEncoding,
    pub frame_id_config: Option<FrameIdConfig>,
    pub source_address_config: Option<FrameIdConfig>,
    pub min_frame_length: usize,
    pub emit_raw_bytes: bool,
}

/// A [`FramingEncoding`] with default options, for live framing changes that
/// carry no profile context.
pub fn framing_from_mode(mode: FramingMode, modbus: Option<&ModbusRtuOptions>) -> FramingEncoding {
    match mode {
        FramingMode::Slip => FramingEncoding::default(),
        FramingMode::ModbusRtu => FramingEncoding::ModbusRtu(modbus.cloned().unwrap_or_default()),
        FramingMode::Delimiter => FramingEncoding::Delimiter(DelimiterOptions {
            delimiter: vec![0x0A],
            max_length: 1024,
            include_delimiter: false,
        }),
        FramingMode::Raw => FramingEncoding::Raw,
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

/// A profile's line, from `io::device_kinds`, the one declaration the form also
/// seeds from.
pub(crate) fn line_settings(profile: &IOProfile) -> Result<LineSettings, String> {
    let bits = |key| conn_i64(profile, key).map(|n| u8::try_from(n).unwrap_or(u8::MAX));
    parse_line(
        conn_i64(profile, "baud_rate").unwrap_or_default() as u32,
        bits("data_bits"),
        bits("stop_bits"),
        conn_str(profile, "parity").as_deref(),
    )
}

/// An absent field reads as 8N1's; a present one must be valid.
pub(crate) fn parse_line(
    baud: u32,
    data_bits: Option<u8>,
    stop_bits: Option<u8>,
    parity: Option<&str>,
) -> Result<LineSettings, String> {
    let parity = parity
        .filter(|p| !p.is_empty())
        .map_or(Ok(Parity::None), str::parse)
        .map_err(|e| e.to_string())?;
    let line = LineSettings {
        baud,
        data_bits: data_bits.unwrap_or(8),
        parity,
        stop_bits: stop_bits.unwrap_or(1),
    };
    line.validate().map_err(|e| e.to_string())?;
    Ok(line)
}

/// Parse an IOProfile into a SerialSourceConfig, applying session-level overrides.
pub fn parse_profile_for_source(
    profile: &IOProfile,
    overrides: &SerialOverrides,
) -> Result<SerialSourceConfig, String> {
    let port = conn_str(profile, "port").ok_or("Serial port is required")?;
    let line = line_settings(profile)?;

    // Session override, then profile, then the kind default — resolved by the
    // same function the broker uses to decide which captures to create, so the
    // port and the session cannot disagree about what is on the wire.
    let (framing_mode, emit_raw_bytes) = crate::io::device_kinds::resolve_serial_framing(
        profile,
        overrides.framing_encoding,
        overrides.emit_raw_bytes,
    );

    let max_frame_len = overrides
        .max_frame_length
        .or_else(|| conn_i64(profile, "max_frame_length").map(|n| n as usize))
        .unwrap_or(1024);
    let framing_encoding = match framing_mode {
        FramingMode::Slip => FramingEncoding::Slip { max_frame_len },
        // Session override first, then the profile, then the default — the
        // picker's "Validate CRC" tick had no way through before and did nothing.
        FramingMode::ModbusRtu => FramingEncoding::ModbusRtu(ModbusRtuOptions {
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
        FramingMode::Delimiter => {
            let delimiter = overrides
                .delimiter
                .clone()
                .or_else(|| conn_u8_list(profile, "delimiter"))
                .unwrap_or_else(|| vec![0x0A]); // Default to newline
            let include_delimiter = conn_bool(profile, "include_delimiter").unwrap_or(false);
            FramingEncoding::Delimiter(DelimiterOptions {
                delimiter,
                max_length: max_frame_len,
                include_delimiter,
            })
        }
        FramingMode::Raw => FramingEncoding::Raw,
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

    Ok(SerialSourceConfig {
        port,
        line,
        framing_encoding: framing_encoding.checked()?,
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
    use super::super::framer::SerialFramer;
    use super::*;

    #[test]
    fn an_absent_line_field_reads_as_8n1() {
        assert_eq!(parse_line(9600, None, None, None).unwrap().to_string(), "9600 8N1");
        assert_eq!(parse_line(9600, None, None, Some("")).unwrap().to_string(), "9600 8N1");
        assert_eq!(
            parse_line(19200, Some(7), Some(2), Some("Even")).unwrap().to_string(),
            "19200 7E2"
        );
    }

    #[test]
    fn a_slip_line_without_end_stops_growing_at_the_frame_cap() {
        let mut framer = SerialFramer::new(framing_from_mode(FramingMode::Slip, None)).unwrap();
        framer.feed(&[0x55; 4096]);
        let released = framer.feed(&[wiretap_protocol::slip::END]);
        let longest = released.iter().map(|f| f.bytes.len()).max();
        assert!(longest.is_none_or(|len| len <= 1024), "released a {longest:?}-byte frame");
    }

    #[test]
    fn a_present_but_invalid_line_field_is_refused() {
        assert!(parse_line(9600, Some(9), None, None).is_err());
        assert!(parse_line(9600, None, Some(0), None).is_err());
        assert!(parse_line(9600, None, None, Some("mark")).is_err());
    }
}
