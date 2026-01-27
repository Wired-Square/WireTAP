// ui/src-tauri/src/io/serial/utils.rs
//
// Shared utilities for serial port readers.
// Provides common types and conversion functions for the serialport crate.

use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity as SpParity, StopBits};

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
