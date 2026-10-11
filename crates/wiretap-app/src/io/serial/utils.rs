// ui/crates/wiretap-app/src/io/serial/utils.rs
//
// Shared utilities for serial port readers.

use wiretap_catalog::serial_framing::{DelimiterOptions, FrameIdConfig, FramingEncoding};
use wiretap_catalog::{FramingMode, RtuSettings};
use wiretap_io::serial::LineSettings;

use crate::io::device_kinds::{conn_bool, conn_i64, conn_str, conn_u8_list};
use crate::io::SerialOverrides;
use crate::io::error::DevicePresence;
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
    LineSettings::parse(
        conn_i64(profile, "baud_rate").unwrap_or_default() as u32,
        bits("data_bits"),
        bits("stop_bits"),
        conn_str(profile, "parity").as_deref(),
    )
    .map_err(|e| e.to_string())
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
        FramingMode::ModbusRtu => FramingEncoding::ModbusRtu(RtuSettings {
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
        framing_encoding: framing_encoding.checked().map_err(|e| e.to_string())?,
        frame_id_config,
        source_address_config,
        min_frame_length,
        emit_raw_bytes,
    })
}
