use serde::{Deserialize, Serialize};
use wslib_wiretap_catalogue::serial_framing::DelimiterOptions;
use wslib_serial::{LineSettings, LineSettingsError};
use wslib_wiretap_catalogue::{DegenerateFraming, FrameIdConfig, FramingEncoding, FramingMode, RtuSettings};

use super::{resolve_serial_framing, IOProfile};

/// The serial settings a session may override on one source, as the picker sends
/// them. Every field is optional: absent means "whatever the device profile says".
///
/// One declaration, threaded whole, so a setting added here reaches the reader
/// without a list to forget it from.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct SerialOverrides {
    /// Framing encoding for serial sources (overrides profile settings if provided)
    pub framing_encoding: Option<FramingMode>,
    /// Delimiter bytes for delimiter-based framing
    pub delimiter: Option<Vec<u8>>,
    /// Maximum frame length for delimiter-based framing
    pub max_frame_length: Option<usize>,
    /// Minimum frame length - frames shorter than this are discarded
    pub min_frame_length: Option<usize>,
    /// Whether to emit raw bytes in addition to framed data
    pub emit_raw_bytes: Option<bool>,
    /// Whether to check the CRC-16 on Modbus RTU framing
    pub modbus_validate_crc: Option<bool>,
    /// Modbus RTU slave address to sync on; absent means any valid address
    pub modbus_device_address: Option<u8>,
    /// Function codes the RTU length rules do not model but this line carries
    pub modbus_vendor_functions: Option<Vec<u8>>,
    /// Whether address 0 may start a Modbus RTU message
    pub modbus_allow_broadcast: Option<bool>,
    /// Whether every Modbus function code frames, declared or not
    pub modbus_any_function: Option<bool>,
    /// Frame ID extraction: start byte position (0-indexed)
    pub frame_id_start_byte: Option<i32>,
    /// Frame ID extraction: number of bytes (1 or 2)
    pub frame_id_bytes: Option<u8>,
    /// Frame ID extraction: byte order (true = big endian)
    pub frame_id_big_endian: Option<bool>,
    /// Source address extraction: start byte position (0-indexed)
    pub source_address_start_byte: Option<i32>,
    /// Source address extraction: number of bytes (1 or 2)
    pub source_address_bytes: Option<u8>,
    /// Source address extraction: byte order (true = big endian)
    pub source_address_big_endian: Option<bool>,
}

/// A serial source's settings: its profile with the session's overrides on top.
#[derive(Clone, Debug, PartialEq)]
pub struct SerialSourceConfig {
    pub port: String,
    pub line: LineSettings,
    pub framing_encoding: FramingEncoding,
    pub frame_id_config: Option<FrameIdConfig>,
    pub source_address_config: Option<FrameIdConfig>,
    pub min_frame_length: usize,
    pub emit_raw_bytes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SerialSourceError {
    #[error("Serial port is required")]
    NoPort,
    #[error(transparent)]
    Line(#[from] LineSettingsError),
    #[error(transparent)]
    Framing(#[from] DegenerateFraming),
}

impl From<SerialSourceError> for String {
    fn from(e: SerialSourceError) -> Self {
        e.to_string()
    }
}

impl IOProfile {
    /// The profile's line, an absent field read as 8N1's.
    pub fn line_settings(&self) -> Result<LineSettings, LineSettingsError> {
        let bits = |key| {
            self.conn_i64(key)
                .map(|n| u8::try_from(n).unwrap_or(u8::MAX))
        };
        LineSettings::parse(
            self.conn_i64("baud_rate").unwrap_or_default() as u32,
            bits("data_bits"),
            bits("stop_bits"),
            self.conn_str("parity").as_deref(),
        )
    }

    /// Where a frame id or source address is read from in a framed message: the
    /// session's override if it names a start byte, else the profile's own
    /// `{prefix}_start_byte` triple, else nothing.
    fn extraction(
        &self,
        prefix: &str,
        start: Option<i32>,
        bytes: Option<u8>,
        big_endian: Option<bool>,
    ) -> Option<FrameIdConfig> {
        let field = |suffix: &str| format!("{prefix}_{suffix}");
        let start_byte = start.or_else(|| self.conn_i64(&field("start_byte")).map(|n| n as i32))?;
        Some(FrameIdConfig {
            start_byte,
            num_bytes: bytes
                .or_else(|| self.conn_i64(&field("bytes")).map(|n| n as u8))
                .unwrap_or(1),
            big_endian: big_endian
                .or_else(|| self.conn_bool(&field("big_endian")))
                .unwrap_or(true),
        })
    }
}

impl SerialSourceConfig {
    /// Each setting from the session's override, then the profile, then its
    /// default; the framing by [`resolve_serial_framing`], as the session's
    /// captures were.
    pub fn from_profile(
        profile: &IOProfile,
        overrides: &SerialOverrides,
    ) -> Result<Self, SerialSourceError> {
        let port = profile.conn_str("port").ok_or(SerialSourceError::NoPort)?;
        let line = profile.line_settings()?;
        let (framing_mode, emit_raw_bytes) = resolve_serial_framing(
            profile,
            overrides.framing_encoding,
            overrides.emit_raw_bytes,
        );

        let usize_field =
            |set: Option<usize>, key| set.or_else(|| profile.conn_i64(key).map(|n| n as usize));
        let bool_field = |set: Option<bool>, key| set.or_else(|| profile.conn_bool(key));
        let max_frame_len =
            usize_field(overrides.max_frame_length, "max_frame_length").unwrap_or(1024);
        let framing_encoding = match framing_mode {
            FramingMode::Slip => FramingEncoding::Slip { max_frame_len },
            FramingMode::ModbusRtu => FramingEncoding::ModbusRtu(RtuSettings {
                device_address: overrides
                    .modbus_device_address
                    .or_else(|| profile.conn_i64("modbus_device_address").map(|n| n as u8)),
                validate_crc: bool_field(overrides.modbus_validate_crc, "modbus_validate_crc")
                    .unwrap_or(true),
                vendor_functions: overrides
                    .modbus_vendor_functions
                    .clone()
                    .or_else(|| profile.conn_u8_list("modbus_vendor_functions"))
                    .unwrap_or_default(),
                allow_broadcast: bool_field(
                    overrides.modbus_allow_broadcast,
                    "modbus_allow_broadcast",
                )
                .unwrap_or(false),
                any_function: bool_field(overrides.modbus_any_function, "modbus_any_function")
                    .unwrap_or(false),
            }),
            FramingMode::Delimiter => FramingEncoding::Delimiter(DelimiterOptions {
                delimiter: overrides
                    .delimiter
                    .clone()
                    .or_else(|| profile.conn_u8_list("delimiter"))
                    .unwrap_or_else(|| vec![0x0A]),
                max_length: max_frame_len,
                include_delimiter: profile.conn_bool("include_delimiter").unwrap_or(false),
            }),
            FramingMode::Raw => FramingEncoding::Raw,
        };

        Ok(Self {
            port,
            line,
            framing_encoding: framing_encoding.checked()?,
            frame_id_config: profile.extraction(
                "frame_id",
                overrides.frame_id_start_byte,
                overrides.frame_id_bytes,
                overrides.frame_id_big_endian,
            ),
            source_address_config: profile.extraction(
                "source_address",
                overrides.source_address_start_byte,
                overrides.source_address_bytes,
                overrides.source_address_big_endian,
            ),
            min_frame_length: usize_field(overrides.min_frame_length, "min_frame_length")
                .unwrap_or(0),
            emit_raw_bytes,
        })
    }
}
