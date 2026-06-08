// ui/src-tauri/src/io/serial/utils.rs
//
// Shared utilities for serial port readers.
// Provides common types and conversion functions for the serialport crate.

use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity as SpParity, StopBits};

use super::framer::{FrameIdConfig, FramingEncoding};
use crate::settings::IOProfile;

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
pub fn framing_from_str(encoding: &str) -> FramingEncoding {
    match encoding {
        "slip" => FramingEncoding::Slip,
        "modbus_rtu" => FramingEncoding::ModbusRtu {
            device_address: None,
            validate_crc: true,
        },
        "delimiter" => FramingEncoding::Delimiter {
            delimiter: vec![0x0A],
            max_length: 1024,
            include_delimiter: false,
        },
        _ => FramingEncoding::Raw,
    }
}

/// Parse an IOProfile into a SerialSourceConfig, applying session-level overrides.
///
/// Returns `None` if the port is not specified in the profile.
pub fn parse_profile_for_source(
    profile: &IOProfile,
    framing_encoding_override: Option<&str>,
    delimiter_override: Option<Vec<u8>>,
    max_frame_length_override: Option<usize>,
    min_frame_length_override: Option<usize>,
    emit_raw_bytes_override: Option<bool>,
) -> Option<SerialSourceConfig> {
    let port = profile.connection.get("port").and_then(|v| v.as_str())?.to_string();

    let baud_rate = profile
        .connection
        .get("baud_rate")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(115200) as u32;

    let data_bits = profile
        .connection
        .get("data_bits")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(8) as u8;

    let stop_bits = profile
        .connection
        .get("stop_bits")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(1) as u8;

    let parity_str = profile
        .connection
        .get("parity")
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    let parity = match parity_str {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    };

    // Framing configuration - prefer session override, fall back to profile settings
    let framing_encoding_str = framing_encoding_override
        .or_else(|| {
            profile
                .connection
                .get("framing_encoding")
                .and_then(|v| v.as_str())
        })
        .unwrap_or("raw");

    let framing_encoding = match framing_encoding_str {
        "slip" => FramingEncoding::Slip,
        "modbus_rtu" => {
            let device_address = profile
                .connection
                .get("modbus_device_address")
                .and_then(|v| v.as_i64())
                .map(|n| n as u8);
            let validate_crc = profile
                .connection
                .get("modbus_validate_crc")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            FramingEncoding::ModbusRtu {
                device_address,
                validate_crc,
            }
        }
        "delimiter" => {
            let delimiter = delimiter_override.or_else(|| {
                profile
                    .connection
                    .get("delimiter")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_i64().map(|n| n as u8))
                            .collect()
                    })
            })
            .unwrap_or_else(|| vec![0x0A]); // Default to newline
            let max_length = max_frame_length_override
                .or_else(|| {
                    profile
                        .connection
                        .get("max_frame_length")
                        .and_then(|v| v.as_i64())
                        .map(|n| n as usize)
                })
                .unwrap_or(1024);
            let include_delimiter = profile
                .connection
                .get("include_delimiter")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            FramingEncoding::Delimiter {
                delimiter,
                max_length,
                include_delimiter,
            }
        }
        "raw" | _ => FramingEncoding::Raw,
    };

    // Frame ID extraction config
    let frame_id_config = profile.connection.get("frame_id_start_byte").and_then(|_| {
        Some(FrameIdConfig {
            start_byte: profile
                .connection
                .get("frame_id_start_byte")
                .and_then(|v| v.as_i64())
                .unwrap_or(0) as i32,
            num_bytes: profile
                .connection
                .get("frame_id_bytes")
                .and_then(|v| v.as_i64())
                .unwrap_or(1) as u8,
            big_endian: profile
                .connection
                .get("frame_id_big_endian")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        })
    });

    // Source address extraction config
    let source_address_config = profile.connection.get("source_address_start_byte").and_then(|_| {
        Some(FrameIdConfig {
            start_byte: profile
                .connection
                .get("source_address_start_byte")
                .and_then(|v| v.as_i64())
                .unwrap_or(0) as i32,
            num_bytes: profile
                .connection
                .get("source_address_bytes")
                .and_then(|v| v.as_i64())
                .unwrap_or(1) as u8,
            big_endian: profile
                .connection
                .get("source_address_big_endian")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        })
    });

    let min_frame_length = min_frame_length_override
        .or_else(|| {
            profile
                .connection
                .get("min_frame_length")
                .and_then(|v| v.as_i64())
                .map(|n| n as usize)
        })
        .unwrap_or(0);

    // Determine if we should emit raw bytes
    // For "raw" framing mode, raw bytes are the primary output
    // For other modes, only emit if explicitly requested
    let emit_raw_bytes = match framing_encoding_str {
        "raw" => true,
        _ => emit_raw_bytes_override.unwrap_or(false),
    };

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
