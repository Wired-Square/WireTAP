// ui/src-tauri/src/checksums.rs
//
// Checksum calculation algorithms for frame validation.
// Exposed to the frontend via Tauri commands.

use serde::{Deserialize, Serialize};

// ============================================================================
// Types
// ============================================================================

/// Supported checksum algorithms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChecksumAlgorithm {
    /// XOR of all bytes
    Xor,
    /// sum(bytes) & 0xFF
    Sum8,
    /// CRC-8 polynomial 0x07 (ITU/SMBUS)
    Crc8,
    /// CRC-8 SAE-J1850 polynomial 0x1D (automotive OBD-II)
    Crc8SaeJ1850,
    /// CRC-8 AUTOSAR polynomial 0x2F (AUTOSAR E2E)
    Crc8Autosar,
    /// CRC-8 Maxim polynomial 0x31 (1-Wire devices)
    Crc8Maxim,
    /// CRC-8 CDMA2000 polynomial 0x9B (telecom)
    Crc8Cdma2000,
    /// CRC-8 DVB-S2 polynomial 0xD5 (satellite)
    Crc8DvbS2,
    /// CRC-8 Nissan polynomial 0x85 (Nissan CAN)
    Crc8Nissan,
    /// CRC-16 Modbus polynomial (0xA001)
    Crc16Modbus,
    /// CRC-16 CCITT polynomial (0x1021)
    Crc16Ccitt,
}

impl ChecksumAlgorithm {
    /// Get the output size in bytes for this algorithm.
    #[allow(dead_code)]
    pub fn output_bytes(&self) -> usize {
        match self {
            ChecksumAlgorithm::Xor => 1,
            ChecksumAlgorithm::Sum8 => 1,
            ChecksumAlgorithm::Crc8 => 1,
            ChecksumAlgorithm::Crc8SaeJ1850 => 1,
            ChecksumAlgorithm::Crc8Autosar => 1,
            ChecksumAlgorithm::Crc8Maxim => 1,
            ChecksumAlgorithm::Crc8Cdma2000 => 1,
            ChecksumAlgorithm::Crc8DvbS2 => 1,
            ChecksumAlgorithm::Crc8Nissan => 1,
            ChecksumAlgorithm::Crc16Modbus => 2,
            ChecksumAlgorithm::Crc16Ccitt => 2,
        }
    }

    /// Parse algorithm from string (for Tauri command).
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "xor" => Ok(ChecksumAlgorithm::Xor),
            "sum8" => Ok(ChecksumAlgorithm::Sum8),
            "crc8" => Ok(ChecksumAlgorithm::Crc8),
            "crc8_sae_j1850" => Ok(ChecksumAlgorithm::Crc8SaeJ1850),
            "crc8_autosar" => Ok(ChecksumAlgorithm::Crc8Autosar),
            "crc8_maxim" => Ok(ChecksumAlgorithm::Crc8Maxim),
            "crc8_cdma2000" => Ok(ChecksumAlgorithm::Crc8Cdma2000),
            "crc8_dvb_s2" => Ok(ChecksumAlgorithm::Crc8DvbS2),
            "crc8_nissan" => Ok(ChecksumAlgorithm::Crc8Nissan),
            "crc16_modbus" => Ok(ChecksumAlgorithm::Crc16Modbus),
            "crc16_ccitt" => Ok(ChecksumAlgorithm::Crc16Ccitt),
            _ => Err(format!("Unknown checksum algorithm: {}", s)),
        }
    }
}

/// Result of checksum validation (for Tauri command response).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecksumValidationResult {
    /// The checksum value extracted from the frame
    pub extracted: u16,
    /// The calculated checksum value
    pub calculated: u16,
    /// Whether the checksum is valid (extracted == calculated)
    pub valid: bool,
}

/// Result of batch checksum discovery (for Tauri command response).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchDiscoveryResult {
    /// Number of frames that matched
    pub match_count: usize,
    /// Total number of frames tested
    pub total_count: usize,
}

// ============================================================================
// Byte Index Resolution (Negative Indexing Support)
// ============================================================================

/// Resolve a byte index, supporting Python-style negative indexing.
/// Negative indices count from the end: -1 = last byte, -2 = second-to-last, etc.
///
/// # Arguments
/// * `index` - The byte index (can be negative)
/// * `frame_length` - Total frame length in bytes
///
/// # Returns
/// The resolved absolute byte index
pub fn resolve_byte_index(index: i32, frame_length: usize) -> usize {
    if index >= 0 {
        index as usize
    } else {
        // Negative: count from end
        // -1 -> frame_length - 1 (last byte)
        // -2 -> frame_length - 2 (second-to-last)
        let abs_index = (-index) as usize;
        frame_length.saturating_sub(abs_index)
    }
}

// ============================================================================
// Reflection Helpers
// ============================================================================

/// Reflect (reverse) the bits of a byte.
fn reflect8(mut value: u8) -> u8 {
    let mut result: u8 = 0;
    for _ in 0..8 {
        result = (result << 1) | (value & 1);
        value >>= 1;
    }
    result
}

/// Reflect (reverse) the bits of a 16-bit value.
fn reflect16(mut value: u16) -> u16 {
    let mut result: u16 = 0;
    for _ in 0..16 {
        result = (result << 1) | (value & 1);
        value >>= 1;
    }
    result
}

// ============================================================================
// Parameterised CRC Functions (Canonical Implementations)
// ============================================================================

/// CRC-8 with arbitrary parameters.
///
/// # Arguments
/// * `data` - The data to calculate CRC over
/// * `polynomial` - The CRC polynomial (e.g., 0x07 for standard CRC-8)
/// * `init` - Initial CRC value (e.g., 0x00 or 0xFF)
/// * `xor_out` - Final XOR value (e.g., 0x00 or 0xFF)
/// * `reflect` - Whether to use reflected (LSB-first) mode
pub fn crc8_parameterised(
    data: &[u8],
    polynomial: u8,
    init: u8,
    xor_out: u8,
    reflect: bool,
) -> u8 {
    let mut crc = init;

    if reflect {
        // Reflected mode (LSB-first processing)
        let reflected_poly = reflect8(polynomial);
        for &byte in data {
            crc ^= byte;
            for _ in 0..8 {
                if crc & 0x01 != 0 {
                    crc = (crc >> 1) ^ reflected_poly;
                } else {
                    crc >>= 1;
                }
            }
        }
    } else {
        // Normal mode (MSB-first processing)
        for &byte in data {
            crc ^= byte;
            for _ in 0..8 {
                if crc & 0x80 != 0 {
                    crc = (crc << 1) ^ polynomial;
                } else {
                    crc <<= 1;
                }
            }
        }
    }

    crc ^ xor_out
}

/// CRC-16 with arbitrary parameters.
///
/// # Arguments
/// * `data` - The data to calculate CRC over
/// * `polynomial` - The CRC polynomial (e.g., 0x8005 for CRC-16)
/// * `init` - Initial CRC value (e.g., 0x0000 or 0xFFFF)
/// * `xor_out` - Final XOR value (e.g., 0x0000 or 0xFFFF)
/// * `reflect_in` - Whether to reflect input bytes
/// * `reflect_out` - Whether to reflect the final CRC output
pub fn crc16_parameterised(
    data: &[u8],
    polynomial: u16,
    init: u16,
    xor_out: u16,
    reflect_in: bool,
    reflect_out: bool,
) -> u16 {
    let mut crc = init;

    if reflect_in {
        // Reflected input mode (LSB-first)
        let reflected_poly = reflect16(polynomial);
        for &byte in data {
            crc ^= byte as u16;
            for _ in 0..8 {
                if crc & 0x0001 != 0 {
                    crc = (crc >> 1) ^ reflected_poly;
                } else {
                    crc >>= 1;
                }
            }
        }
    } else {
        // Normal input mode (MSB-first)
        for &byte in data {
            crc ^= (byte as u16) << 8;
            for _ in 0..8 {
                if crc & 0x8000 != 0 {
                    crc = (crc << 1) ^ polynomial;
                } else {
                    crc <<= 1;
                }
            }
        }
    }

    let final_crc = if reflect_out && !reflect_in {
        // Only reflect output if not already reflected via input processing
        reflect16(crc)
    } else if !reflect_out && reflect_in {
        // Need to un-reflect if input was reflected but output shouldn't be
        reflect16(crc)
    } else {
        crc
    };

    final_crc ^ xor_out
}

// ============================================================================
// Named Checksum Functions
// ============================================================================

/// XOR of all bytes.
/// Simple but effective for detecting single-bit errors.
pub fn xor_checksum(data: &[u8]) -> u8 {
    let mut result: u8 = 0;
    for &byte in data {
        result ^= byte;
    }
    result
}

/// Simple modulo-256 sum of bytes (8-bit sum).
pub fn sum8_checksum(data: &[u8]) -> u8 {
    let mut sum: u8 = 0;
    for &byte in data {
        sum = sum.wrapping_add(byte);
    }
    sum
}

/// CRC-8 with polynomial 0x07 (ITU/SMBUS).
/// Common in many embedded protocols.
pub fn crc8_checksum(data: &[u8]) -> u8 {
    crc8_parameterised(data, 0x07, 0x00, 0x00, false)
}

/// CRC-8 SAE-J1850 with polynomial 0x1D.
/// Used in automotive OBD-II and CAN protocols.
/// Init: 0xFF, XOR out: 0xFF, Not reflected
pub fn crc8_sae_j1850_checksum(data: &[u8]) -> u8 {
    crc8_parameterised(data, 0x1D, 0xFF, 0xFF, false)
}

/// CRC-8 AUTOSAR with polynomial 0x2F.
/// Used in AUTOSAR E2E protection.
/// Init: 0xFF, XOR out: 0xFF, Not reflected
pub fn crc8_autosar_checksum(data: &[u8]) -> u8 {
    crc8_parameterised(data, 0x2F, 0xFF, 0xFF, false)
}

/// CRC-8 Maxim with polynomial 0x31.
/// Used in Dallas/Maxim 1-Wire devices.
/// Init: 0x00, XOR out: 0x00, Reflected (LSB-first)
pub fn crc8_maxim_checksum(data: &[u8]) -> u8 {
    crc8_parameterised(data, 0x31, 0x00, 0x00, true)
}

/// CRC-8 CDMA2000 with polynomial 0x9B.
/// Used in telecom protocols.
/// Init: 0xFF, XOR out: 0x00, Not reflected
pub fn crc8_cdma2000_checksum(data: &[u8]) -> u8 {
    crc8_parameterised(data, 0x9B, 0xFF, 0x00, false)
}

/// CRC-8 DVB-S2 with polynomial 0xD5.
/// Used in satellite communications.
/// Init: 0x00, XOR out: 0x00, Not reflected
pub fn crc8_dvb_s2_checksum(data: &[u8]) -> u8 {
    crc8_parameterised(data, 0xD5, 0x00, 0x00, false)
}

/// CRC-8 Nissan with polynomial 0x85.
/// Used in Nissan LEAF CAN bus.
/// Init: 0x00, XOR out: 0x00, Not reflected
pub fn crc8_nissan_checksum(data: &[u8]) -> u8 {
    crc8_parameterised(data, 0x85, 0x00, 0x00, false)
}

/// CRC-16 Modbus polynomial (0x8005, reflected).
/// Used by Modbus RTU protocol.
pub fn crc16_modbus_checksum(data: &[u8]) -> u16 {
    crc16_parameterised(data, 0x8005, 0xFFFF, 0x0000, true, true)
}

/// CRC-16 CCITT polynomial (0x1021, non-reflected).
/// Common in telecommunications and some industrial protocols.
pub fn crc16_ccitt_checksum(data: &[u8]) -> u16 {
    crc16_parameterised(data, 0x1021, 0xFFFF, 0x0000, false, false)
}

// ============================================================================
// High-Level Functions
// ============================================================================

/// Calculate checksum using the specified algorithm.
///
/// # Arguments
/// * `algorithm` - The checksum algorithm to use
/// * `data` - The data to calculate checksum over
///
/// # Returns
/// The calculated checksum value as u16 (may be 8-bit for some algorithms)
pub fn calculate_checksum_simple(algorithm: ChecksumAlgorithm, data: &[u8]) -> u16 {
    match algorithm {
        ChecksumAlgorithm::Xor => xor_checksum(data) as u16,
        ChecksumAlgorithm::Sum8 => sum8_checksum(data) as u16,
        ChecksumAlgorithm::Crc8 => crc8_checksum(data) as u16,
        ChecksumAlgorithm::Crc8SaeJ1850 => crc8_sae_j1850_checksum(data) as u16,
        ChecksumAlgorithm::Crc8Autosar => crc8_autosar_checksum(data) as u16,
        ChecksumAlgorithm::Crc8Maxim => crc8_maxim_checksum(data) as u16,
        ChecksumAlgorithm::Crc8Cdma2000 => crc8_cdma2000_checksum(data) as u16,
        ChecksumAlgorithm::Crc8DvbS2 => crc8_dvb_s2_checksum(data) as u16,
        ChecksumAlgorithm::Crc8Nissan => crc8_nissan_checksum(data) as u16,
        ChecksumAlgorithm::Crc16Modbus => crc16_modbus_checksum(data),
        ChecksumAlgorithm::Crc16Ccitt => crc16_ccitt_checksum(data),
    }
}

/// Calculate checksum using the specified algorithm with byte range.
///
/// # Arguments
/// * `algorithm` - The checksum algorithm to use
/// * `data` - The complete frame data
/// * `calc_start_byte` - First byte index to include in calculation (supports negative indexing)
/// * `calc_end_byte` - Last byte index (exclusive) to include in calculation (supports negative indexing)
///
/// # Returns
/// The calculated checksum value
pub fn calculate_checksum(
    algorithm: ChecksumAlgorithm,
    data: &[u8],
    calc_start_byte: i32,
    calc_end_byte: i32,
) -> u16 {
    let length = data.len();

    // Resolve negative indices (e.g., -1 = last byte)
    let resolved_start = resolve_byte_index(calc_start_byte, length);
    let resolved_end = resolve_byte_index(calc_end_byte, length);

    // Ensure valid bounds
    let start = resolved_start.min(length);
    let end = resolved_end.min(length);

    if start >= end {
        return 0;
    }

    calculate_checksum_simple(algorithm, &data[start..end])
}

/// Extract checksum value from frame data.
///
/// # Arguments
/// * `data` - The complete frame data
/// * `start_byte` - Byte offset where checksum is stored (supports negative indexing)
/// * `byte_length` - Length of checksum (1 or 2 bytes)
/// * `big_endian` - true for big-endian, false for little-endian
///
/// # Returns
/// The extracted checksum value
pub fn extract_checksum(
    data: &[u8],
    start_byte: i32,
    byte_length: usize,
    big_endian: bool,
) -> u16 {
    let length = data.len();

    // Resolve negative index (e.g., -1 = last byte)
    let resolved_start = resolve_byte_index(start_byte, length);

    if resolved_start + byte_length > length {
        return 0;
    }

    match byte_length {
        1 => data[resolved_start] as u16,
        2 => {
            if big_endian {
                ((data[resolved_start] as u16) << 8) | (data[resolved_start + 1] as u16)
            } else {
                (data[resolved_start] as u16) | ((data[resolved_start + 1] as u16) << 8)
            }
        }
        _ => {
            // For lengths > 2, read based on endianness
            let mut value: u16 = 0;
            for i in 0..byte_length.min(2) {
                if big_endian {
                    value = (value << 8) | (data[resolved_start + i] as u16);
                } else {
                    value |= (data[resolved_start + i] as u16) << (i * 8);
                }
            }
            value
        }
    }
}

/// Validate a checksum in frame data.
///
/// # Arguments
/// * `algorithm` - The checksum algorithm to use
/// * `data` - The complete frame data
/// * `start_byte` - Byte offset where checksum is stored
/// * `byte_length` - Length of checksum (1 or 2 bytes)
/// * `big_endian` - true for big-endian, false for little-endian
/// * `calc_start_byte` - First byte to include in calculation
/// * `calc_end_byte` - Last byte (exclusive) to include in calculation
///
/// # Returns
/// ChecksumValidationResult with extracted value, calculated value, and validity
pub fn validate_checksum(
    algorithm: ChecksumAlgorithm,
    data: &[u8],
    start_byte: i32,
    byte_length: usize,
    big_endian: bool,
    calc_start_byte: i32,
    calc_end_byte: i32,
) -> ChecksumValidationResult {
    let extracted = extract_checksum(data, start_byte, byte_length, big_endian);
    let calculated = calculate_checksum(algorithm, data, calc_start_byte, calc_end_byte);

    ChecksumValidationResult {
        extracted,
        calculated,
        valid: extracted == calculated,
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Calculate checksum using the specified algorithm with byte range.
///
/// # Arguments
/// * `algorithm` - Algorithm name: "xor", "sum8", "crc8", "crc16_modbus", "crc16_ccitt"
/// * `data` - The complete frame data as bytes
/// * `calc_start_byte` - First byte index to include (supports negative indexing)
/// * `calc_end_byte` - Last byte index exclusive (supports negative indexing)
#[tauri::command]
pub fn calculate_checksum_cmd(
    algorithm: String,
    data: Vec<u8>,
    calc_start_byte: i32,
    calc_end_byte: i32,
) -> Result<u16, String> {
    let algo = ChecksumAlgorithm::from_str(&algorithm)?;
    Ok(calculate_checksum(algo, &data, calc_start_byte, calc_end_byte))
}

/// Validate a checksum in frame data.
///
/// # Arguments
/// * `algorithm` - Algorithm name: "xor", "sum8", "crc8", "crc16_modbus", "crc16_ccitt"
/// * `data` - The complete frame data as bytes
/// * `start_byte` - Byte offset where checksum is stored (supports negative indexing)
/// * `byte_length` - Length of checksum (1 or 2 bytes)
/// * `big_endian` - true for big-endian, false for little-endian
/// * `calc_start_byte` - First byte to include in calculation (supports negative indexing)
/// * `calc_end_byte` - Last byte (exclusive) to include (supports negative indexing)
#[tauri::command]
pub fn validate_checksum_cmd(
    algorithm: String,
    data: Vec<u8>,
    start_byte: i32,
    byte_length: usize,
    big_endian: bool,
    calc_start_byte: i32,
    calc_end_byte: i32,
) -> Result<ChecksumValidationResult, String> {
    let algo = ChecksumAlgorithm::from_str(&algorithm)?;
    Ok(validate_checksum(
        algo,
        &data,
        start_byte,
        byte_length,
        big_endian,
        calc_start_byte,
        calc_end_byte,
    ))
}

/// Resolve a byte index, supporting negative indexing.
///
/// # Arguments
/// * `index` - The byte index (can be negative, -1 = last byte)
/// * `frame_length` - Total frame length in bytes
#[tauri::command]
pub fn resolve_byte_index_cmd(index: i32, frame_length: usize) -> usize {
    resolve_byte_index(index, frame_length)
}

/// Calculate CRC-8 with arbitrary parameters.
///
/// # Arguments
/// * `data` - The data to calculate CRC over
/// * `polynomial` - The CRC polynomial (0x00-0xFF)
/// * `init` - Initial CRC value
/// * `xor_out` - Final XOR value
/// * `reflect` - Whether to use reflected (LSB-first) mode
#[tauri::command]
pub fn crc8_parameterised_cmd(
    data: Vec<u8>,
    polynomial: u8,
    init: u8,
    xor_out: u8,
    reflect: bool,
) -> u8 {
    crc8_parameterised(&data, polynomial, init, xor_out, reflect)
}

/// Calculate CRC-16 with arbitrary parameters.
///
/// # Arguments
/// * `data` - The data to calculate CRC over
/// * `polynomial` - The CRC polynomial (0x0000-0xFFFF)
/// * `init` - Initial CRC value
/// * `xor_out` - Final XOR value
/// * `reflect_in` - Whether to reflect input bytes
/// * `reflect_out` - Whether to reflect the final CRC output
#[tauri::command]
pub fn crc16_parameterised_cmd(
    data: Vec<u8>,
    polynomial: u16,
    init: u16,
    xor_out: u16,
    reflect_in: bool,
    reflect_out: bool,
) -> u16 {
    crc16_parameterised(&data, polynomial, init, xor_out, reflect_in, reflect_out)
}

/// Batch test a CRC configuration against multiple payloads.
/// This is optimised for checksum discovery - tests one polynomial/config
/// against many frames in a single IPC call.
///
/// # Arguments
/// * `payloads` - Array of frame payloads to test
/// * `expected_checksums` - Expected checksum values for each payload
/// * `checksum_bits` - 8 for CRC-8, 16 for CRC-16
/// * `polynomial` - The CRC polynomial to test
/// * `init` - Initial CRC value
/// * `xor_out` - Final XOR value
/// * `reflect` - Whether to use reflected mode
#[tauri::command]
pub fn batch_test_crc_cmd(
    payloads: Vec<Vec<u8>>,
    expected_checksums: Vec<u16>,
    checksum_bits: u8,
    polynomial: u16,
    init: u16,
    xor_out: u16,
    reflect: bool,
) -> BatchDiscoveryResult {
    let total_count = payloads.len().min(expected_checksums.len());
    let mut match_count = 0;

    for i in 0..total_count {
        let payload = &payloads[i];
        let expected = expected_checksums[i];

        let calculated = if checksum_bits == 8 {
            crc8_parameterised(payload, polynomial as u8, init as u8, xor_out as u8, reflect) as u16
        } else {
            crc16_parameterised(payload, polynomial, init, xor_out, reflect, reflect)
        };

        if calculated == expected {
            match_count += 1;
        }
    }

    BatchDiscoveryResult {
        match_count,
        total_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Byte Index Resolution Tests
    // ========================================================================

    #[test]
    fn test_resolve_byte_index_positive() {
        assert_eq!(resolve_byte_index(0, 10), 0);
        assert_eq!(resolve_byte_index(5, 10), 5);
        assert_eq!(resolve_byte_index(9, 10), 9);
    }

    #[test]
    fn test_resolve_byte_index_negative() {
        assert_eq!(resolve_byte_index(-1, 10), 9); // last byte
        assert_eq!(resolve_byte_index(-2, 10), 8); // second-to-last
        assert_eq!(resolve_byte_index(-10, 10), 0); // first byte
    }

    #[test]
    fn test_resolve_byte_index_clamps_overly_negative() {
        assert_eq!(resolve_byte_index(-11, 10), 0);
        assert_eq!(resolve_byte_index(-100, 10), 0);
    }

    // ========================================================================
    // XOR Checksum Tests
    // ========================================================================

    #[test]
    fn test_xor_checksum_basic() {
        // 0x01 ^ 0x02 ^ 0x03 ^ 0x04 ^ 0x05 = 0x01
        assert_eq!(xor_checksum(&[0x01, 0x02, 0x03, 0x04, 0x05]), 0x01);
    }

    #[test]
    fn test_xor_checksum_pairs() {
        assert_eq!(xor_checksum(&[0x01, 0x02, 0x03]), 0x00);
        assert_eq!(xor_checksum(&[0xFF, 0xFF]), 0x00);
        assert_eq!(xor_checksum(&[0xAA, 0x55]), 0xFF);
    }

    #[test]
    fn test_xor_checksum_empty() {
        assert_eq!(xor_checksum(&[]), 0);
    }

    #[test]
    fn test_xor_checksum_single_byte() {
        assert_eq!(xor_checksum(&[0x42]), 0x42);
    }

    // ========================================================================
    // Sum8 Checksum Tests
    // ========================================================================

    #[test]
    fn test_sum8_checksum_basic() {
        // 0x01 + 0x02 + 0x03 + 0x04 + 0x05 = 0x0F
        assert_eq!(sum8_checksum(&[0x01, 0x02, 0x03, 0x04, 0x05]), 0x0F);
    }

    #[test]
    fn test_sum8_checksum_simple() {
        assert_eq!(sum8_checksum(&[0x01, 0x02, 0x03]), 0x06);
    }

    #[test]
    fn test_sum8_checksum_wrapping() {
        // 0xFF + 0x02 = 0x101, wraps to 0x01
        assert_eq!(sum8_checksum(&[0xFF, 0x02]), 0x01);
        // 0x80 + 0x80 = 0x100, wraps to 0x00
        assert_eq!(sum8_checksum(&[0x80, 0x80]), 0x00);
    }

    #[test]
    fn test_sum8_checksum_empty() {
        assert_eq!(sum8_checksum(&[]), 0);
    }

    // ========================================================================
    // CRC-8 Tests
    // ========================================================================

    #[test]
    fn test_crc8_checksum_test_vector() {
        // Known test vector: "123456789" -> 0xF4
        let data = b"123456789";
        assert_eq!(crc8_checksum(data), 0xF4);
    }

    #[test]
    fn test_crc8_checksum_empty() {
        assert_eq!(crc8_checksum(&[]), 0);
    }

    // ========================================================================
    // CRC-8 SAE-J1850 Tests
    // ========================================================================

    #[test]
    fn test_crc8_sae_j1850_test_vector() {
        // Known test vector from CRC catalogue: "123456789" -> 0x4B
        let data = b"123456789";
        assert_eq!(crc8_sae_j1850_checksum(data), 0x4B);
    }

    #[test]
    fn test_crc8_sae_j1850_empty() {
        // Init 0xFF XOR xorout 0xFF = 0x00
        assert_eq!(crc8_sae_j1850_checksum(&[]), 0x00);
    }

    // ========================================================================
    // CRC-8 AUTOSAR Tests
    // ========================================================================

    #[test]
    fn test_crc8_autosar_test_vector() {
        // Known test vector from CRC catalogue: "123456789" -> 0xDF
        let data = b"123456789";
        assert_eq!(crc8_autosar_checksum(data), 0xDF);
    }

    #[test]
    fn test_crc8_autosar_empty() {
        // Init 0xFF XOR xorout 0xFF = 0x00
        assert_eq!(crc8_autosar_checksum(&[]), 0x00);
    }

    // ========================================================================
    // CRC-8 Maxim Tests
    // ========================================================================

    #[test]
    fn test_crc8_maxim_test_vector() {
        // Known test vector from CRC catalogue: "123456789" -> 0xA1
        let data = b"123456789";
        assert_eq!(crc8_maxim_checksum(data), 0xA1);
    }

    #[test]
    fn test_crc8_maxim_empty() {
        assert_eq!(crc8_maxim_checksum(&[]), 0x00);
    }

    // ========================================================================
    // CRC-8 CDMA2000 Tests
    // ========================================================================

    #[test]
    fn test_crc8_cdma2000_test_vector() {
        // Known test vector from CRC catalogue: "123456789" -> 0xDA
        let data = b"123456789";
        assert_eq!(crc8_cdma2000_checksum(data), 0xDA);
    }

    #[test]
    fn test_crc8_cdma2000_empty() {
        // Init 0xFF, no xorout
        assert_eq!(crc8_cdma2000_checksum(&[]), 0xFF);
    }

    // ========================================================================
    // CRC-8 DVB-S2 Tests
    // ========================================================================

    #[test]
    fn test_crc8_dvb_s2_test_vector() {
        // Known test vector from CRC catalogue: "123456789" -> 0xBC
        let data = b"123456789";
        assert_eq!(crc8_dvb_s2_checksum(data), 0xBC);
    }

    #[test]
    fn test_crc8_dvb_s2_empty() {
        assert_eq!(crc8_dvb_s2_checksum(&[]), 0x00);
    }

    // ========================================================================
    // CRC-8 Nissan Tests
    // ========================================================================

    #[test]
    fn test_crc8_nissan_sample_message() {
        // Sample from Nissan LEAF code: {0x6E, 0x0F, 0x0F, 0xFD, 0x08, 0xC0, 0xC3}
        // This produces a checksum that can be verified against actual Nissan CAN data
        let data = [0x6E, 0x0F, 0x0F, 0xFD, 0x08, 0xC0, 0xC3];
        assert_eq!(crc8_nissan_checksum(&data), 0x3E);
    }

    #[test]
    fn test_crc8_nissan_empty() {
        assert_eq!(crc8_nissan_checksum(&[]), 0x00);
    }

    #[test]
    fn test_crc8_nissan_basic() {
        assert_eq!(crc8_nissan_checksum(&[0x01, 0x02, 0x03]), 0x5A);
    }

    // ========================================================================
    // CRC-16 Modbus Tests
    // ========================================================================

    #[test]
    fn test_crc16_modbus_checksum_test_vector() {
        // Known Modbus test vector: device address 0x01, function 0x03, data
        // [0x01, 0x03, 0x00, 0x00, 0x00, 0x0A] -> 0xCDC5
        // (Wire format would be C5 CD in little-endian)
        let data = [0x01, 0x03, 0x00, 0x00, 0x00, 0x0A];
        assert_eq!(crc16_modbus_checksum(&data), 0xCDC5);
    }

    #[test]
    fn test_crc16_modbus_checksum_empty() {
        // Initial value for Modbus CRC is 0xFFFF
        assert_eq!(crc16_modbus_checksum(&[]), 0xFFFF);
    }

    // ========================================================================
    // CRC-16 CCITT Tests
    // ========================================================================

    #[test]
    fn test_crc16_ccitt_checksum_test_vector() {
        // Known CCITT test vector: "123456789" -> 0x29B1
        let data = b"123456789";
        assert_eq!(crc16_ccitt_checksum(data), 0x29B1);
    }

    #[test]
    fn test_crc16_ccitt_checksum_empty() {
        // Initial value for CCITT CRC is 0xFFFF
        assert_eq!(crc16_ccitt_checksum(&[]), 0xFFFF);
    }

    // ========================================================================
    // Calculate Checksum Simple Tests
    // ========================================================================

    #[test]
    fn test_calculate_checksum_simple_all_algorithms() {
        let data = [0x01, 0x02, 0x03];
        assert_eq!(calculate_checksum_simple(ChecksumAlgorithm::Xor, &data), 0x00);
        assert_eq!(calculate_checksum_simple(ChecksumAlgorithm::Sum8, &data), 0x06);
        assert_eq!(calculate_checksum_simple(ChecksumAlgorithm::Crc8, &data), 0x48);
        assert_eq!(calculate_checksum_simple(ChecksumAlgorithm::Crc16Modbus, &data), 0x6161);
        assert_eq!(calculate_checksum_simple(ChecksumAlgorithm::Crc16Ccitt, &data), 0xADAD);
    }

    // ========================================================================
    // Calculate Checksum with Range Tests
    // ========================================================================

    #[test]
    fn test_calculate_checksum_with_range() {
        // Frame: [header, data1, data2, data3, checksum_placeholder]
        let frame = [0x55u8, 0x01, 0x02, 0x03, 0x00];

        // Calculate over bytes 1-4 (data only, excluding header at 0)
        let checksum = calculate_checksum(ChecksumAlgorithm::Sum8, &frame, 1, 4);
        assert_eq!(checksum, 0x06); // 0x01 + 0x02 + 0x03
    }

    #[test]
    fn test_calculate_checksum_with_negative_indices() {
        // Frame: [header, data1, data2, data3, checksum_placeholder]
        let frame = [0x55u8, 0x01, 0x02, 0x03, 0x00];

        // Calculate from start to -1 (exclude last byte)
        let checksum = calculate_checksum(ChecksumAlgorithm::Sum8, &frame, 0, -1);
        assert_eq!(checksum, 0x5B); // 0x55 + 0x01 + 0x02 + 0x03
    }

    // ========================================================================
    // Extract Checksum Tests
    // ========================================================================

    #[test]
    fn test_extract_checksum_single_byte() {
        let data = [0x01, 0x02, 0x03, 0xAB];
        assert_eq!(extract_checksum(&data, 3, 1, true), 0xAB);
        assert_eq!(extract_checksum(&data, -1, 1, true), 0xAB); // negative index
    }

    #[test]
    fn test_extract_checksum_single_byte_negative_index() {
        let frame = [0x01, 0x02, 0x03, 0xAB, 0xCD];
        assert_eq!(extract_checksum(&frame, -2, 1, true), 0xAB);
    }

    #[test]
    fn test_extract_checksum_two_bytes_big_endian() {
        let data = [0x01, 0x02, 0xAB, 0xCD];
        // Big-endian: 0xABCD
        assert_eq!(extract_checksum(&data, 2, 2, true), 0xABCD);
        assert_eq!(extract_checksum(&data, -2, 2, true), 0xABCD);
    }

    #[test]
    fn test_extract_checksum_two_bytes_little_endian() {
        let data = [0x01, 0x02, 0xAB, 0xCD];
        // Little-endian: 0xCDAB
        assert_eq!(extract_checksum(&data, 2, 2, false), 0xCDAB);
        assert_eq!(extract_checksum(&data, -2, 2, false), 0xCDAB);
    }

    // ========================================================================
    // Validate Checksum Tests
    // ========================================================================

    #[test]
    fn test_validate_checksum_xor_valid() {
        // Create frame with XOR checksum at end
        // data = [0x01, 0x02], XOR = 0x03, so frame = [0x01, 0x02, 0x03]
        let data = [0x01, 0x02, 0x03];
        let result = validate_checksum(
            ChecksumAlgorithm::Xor,
            &data,
            2,     // checksum at byte 2
            1,     // 1 byte
            true,  // endianness (doesn't matter for 1 byte)
            0,     // calc from byte 0
            2,     // to byte 2 (exclusive)
        );
        assert_eq!(result.extracted, 0x03);
        assert_eq!(result.calculated, 0x03); // XOR of 0x01, 0x02
        assert!(result.valid);
    }

    #[test]
    fn test_validate_checksum_sum8_valid() {
        // Build frame with known checksum
        let data = [0x01u8, 0x02, 0x03];
        let checksum = sum8_checksum(&data); // 0x06
        let mut frame = Vec::from(data);
        frame.push(checksum);

        let result = validate_checksum(
            ChecksumAlgorithm::Sum8,
            &frame,
            -1,    // checksum at last byte
            1,     // 1 byte
            true,  // big-endian
            0,     // calc from byte 0
            -1,    // to last byte (exclusive of checksum)
        );
        assert!(result.valid);
        assert_eq!(result.extracted, 0x06);
        assert_eq!(result.calculated, 0x06);
    }

    #[test]
    fn test_validate_checksum_invalid() {
        let data = [0x01, 0x02, 0x03];
        let frame = [data[0], data[1], data[2], 0xFF]; // Wrong checksum

        let result = validate_checksum(
            ChecksumAlgorithm::Sum8,
            &frame,
            -1,    // checksum at last byte
            1,     // 1 byte
            true,  // big-endian
            0,     // calc from byte 0
            -1,    // to last byte (exclusive of checksum)
        );
        assert!(!result.valid);
        assert_eq!(result.extracted, 0xFF);
        assert_eq!(result.calculated, 0x06);
    }

    #[test]
    fn test_validate_checksum_crc16_modbus_valid() {
        // Known Modbus frame
        let data = [0x01u8, 0x03, 0x00, 0x00, 0x00, 0x0A];
        let crc = crc16_modbus_checksum(&data); // 0xCDC5
        // Append CRC in little-endian (Modbus wire format: low byte first)
        let mut frame = Vec::from(data);
        frame.push((crc & 0xFF) as u8);
        frame.push(((crc >> 8) & 0xFF) as u8);

        let result = validate_checksum(
            ChecksumAlgorithm::Crc16Modbus,
            &frame,
            -2,    // checksum at last 2 bytes
            2,     // 2 bytes
            false, // little-endian
            0,     // calc from byte 0
            -2,    // to -2 (exclusive of checksum)
        );
        assert!(result.valid);
        assert_eq!(result.extracted, 0xCDC5);
        assert_eq!(result.calculated, 0xCDC5);
    }

    // ========================================================================
    // Algorithm Parsing Tests
    // ========================================================================

    #[test]
    fn test_algorithm_from_str() {
        assert_eq!(ChecksumAlgorithm::from_str("xor").unwrap(), ChecksumAlgorithm::Xor);
        assert_eq!(ChecksumAlgorithm::from_str("sum8").unwrap(), ChecksumAlgorithm::Sum8);
        assert_eq!(ChecksumAlgorithm::from_str("crc8").unwrap(), ChecksumAlgorithm::Crc8);
        assert_eq!(
            ChecksumAlgorithm::from_str("crc8_sae_j1850").unwrap(),
            ChecksumAlgorithm::Crc8SaeJ1850
        );
        assert_eq!(
            ChecksumAlgorithm::from_str("crc8_autosar").unwrap(),
            ChecksumAlgorithm::Crc8Autosar
        );
        assert_eq!(
            ChecksumAlgorithm::from_str("crc8_maxim").unwrap(),
            ChecksumAlgorithm::Crc8Maxim
        );
        assert_eq!(
            ChecksumAlgorithm::from_str("crc8_cdma2000").unwrap(),
            ChecksumAlgorithm::Crc8Cdma2000
        );
        assert_eq!(
            ChecksumAlgorithm::from_str("crc8_dvb_s2").unwrap(),
            ChecksumAlgorithm::Crc8DvbS2
        );
        assert_eq!(
            ChecksumAlgorithm::from_str("crc8_nissan").unwrap(),
            ChecksumAlgorithm::Crc8Nissan
        );
        assert_eq!(
            ChecksumAlgorithm::from_str("crc16_modbus").unwrap(),
            ChecksumAlgorithm::Crc16Modbus
        );
        assert_eq!(
            ChecksumAlgorithm::from_str("crc16_ccitt").unwrap(),
            ChecksumAlgorithm::Crc16Ccitt
        );
    }

    #[test]
    fn test_algorithm_from_str_unknown() {
        assert!(ChecksumAlgorithm::from_str("unknown").is_err());
        assert!(ChecksumAlgorithm::from_str("").is_err());
    }

    // ========================================================================
    // Algorithm Output Bytes Tests
    // ========================================================================

    #[test]
    fn test_algorithm_output_bytes() {
        assert_eq!(ChecksumAlgorithm::Xor.output_bytes(), 1);
        assert_eq!(ChecksumAlgorithm::Sum8.output_bytes(), 1);
        assert_eq!(ChecksumAlgorithm::Crc8.output_bytes(), 1);
        assert_eq!(ChecksumAlgorithm::Crc8SaeJ1850.output_bytes(), 1);
        assert_eq!(ChecksumAlgorithm::Crc8Autosar.output_bytes(), 1);
        assert_eq!(ChecksumAlgorithm::Crc8Maxim.output_bytes(), 1);
        assert_eq!(ChecksumAlgorithm::Crc8Cdma2000.output_bytes(), 1);
        assert_eq!(ChecksumAlgorithm::Crc8DvbS2.output_bytes(), 1);
        assert_eq!(ChecksumAlgorithm::Crc8Nissan.output_bytes(), 1);
        assert_eq!(ChecksumAlgorithm::Crc16Modbus.output_bytes(), 2);
        assert_eq!(ChecksumAlgorithm::Crc16Ccitt.output_bytes(), 2);
    }
}
