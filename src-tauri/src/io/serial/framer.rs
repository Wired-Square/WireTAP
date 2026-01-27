// ui/src-tauri/src/io/serial/framer.rs
//
// Serial framing implementations for SLIP, Modbus RTU, and delimiter-based framing.
// Ported from ui/src/utils/serialFramer.ts

use serde::{Deserialize, Serialize};

use crate::checksums::crc16_modbus_checksum;

// =============================================================================
// SLIP Constants (RFC 1055)
// =============================================================================

const SLIP_END: u8 = 0xC0;
const SLIP_ESC: u8 = 0xDB;
const SLIP_ESC_END: u8 = 0xDC;
const SLIP_ESC_ESC: u8 = 0xDD;

// =============================================================================
// Types
// =============================================================================

/// Framing encoding types
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FramingEncoding {
    /// Delimiter-based framing
    Delimiter {
        /// Delimiter byte sequence (e.g., [0x0D, 0x0A] for CRLF)
        delimiter: Vec<u8>,
        /// Max frame length before forced split
        max_length: usize,
        /// Whether to include delimiter in output frames
        include_delimiter: bool,
    },
    /// SLIP framing (RFC 1055)
    Slip,
    /// Modbus RTU framing
    ModbusRtu {
        /// Optional device address filter (1-247)
        device_address: Option<u8>,
        /// Whether to validate CRC
        validate_crc: bool,
    },
    /// Raw mode - no framing, emit bytes as read
    Raw,
}

impl Default for FramingEncoding {
    fn default() -> Self {
        FramingEncoding::Slip
    }
}

/// A complete frame extracted from the serial stream
#[derive(Debug, Clone)]
pub struct SerialFrame {
    /// Frame data bytes
    pub bytes: Vec<u8>,
    /// Whether this frame came from flush() and may be incomplete
    pub incomplete: bool,
    /// For Modbus RTU: whether CRC validation passed (None if validation disabled)
    pub crc_valid: Option<bool>,
}

/// Configuration for extracting frame ID from frame bytes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameIdConfig {
    /// Start byte index (negative = from end)
    pub start_byte: i32,
    /// Number of bytes for frame ID (1 or 2)
    pub num_bytes: u8,
    /// Whether to interpret as big-endian
    pub big_endian: bool,
}

impl Default for FrameIdConfig {
    fn default() -> Self {
        FrameIdConfig {
            start_byte: 0,
            num_bytes: 1,
            big_endian: false,
        }
    }
}

/// Extract frame ID from frame bytes
pub fn extract_frame_id(frame: &[u8], config: &FrameIdConfig) -> Option<u32> {
    let len = frame.len();
    if len == 0 {
        return None;
    }

    // Resolve negative index
    let start = if config.start_byte >= 0 {
        config.start_byte as usize
    } else {
        len.saturating_sub((-config.start_byte) as usize)
    };

    let num_bytes = config.num_bytes as usize;
    if start + num_bytes > len {
        return None;
    }

    match num_bytes {
        1 => Some(frame[start] as u32),
        2 => {
            if config.big_endian {
                Some(((frame[start] as u32) << 8) | (frame[start + 1] as u32))
            } else {
                Some((frame[start] as u32) | ((frame[start + 1] as u32) << 8))
            }
        }
        _ => None,
    }
}

// =============================================================================
// Internal Framer Trait
// =============================================================================

trait FramerImpl {
    fn feed(&mut self, data: &[u8]) -> Vec<FrameResult>;
    fn flush(&mut self) -> Option<FrameResult>;
}

/// Result from internal framers (before frame_index assignment)
struct FrameResult {
    bytes: Vec<u8>,
    incomplete: bool,
    crc_valid: Option<bool>,
}

// =============================================================================
// Delimiter-Based Framer
// =============================================================================

struct DelimiterFramer {
    buffer: Vec<u8>,
    delimiter: Vec<u8>,
    max_length: usize,
    include_delimiter: bool,
}

impl DelimiterFramer {
    fn new(delimiter: Vec<u8>, max_length: usize, include_delimiter: bool) -> Self {
        DelimiterFramer {
            buffer: Vec::new(),
            delimiter,
            max_length,
            include_delimiter,
        }
    }
}

impl FramerImpl for DelimiterFramer {
    fn feed(&mut self, data: &[u8]) -> Vec<FrameResult> {
        let mut frames = Vec::new();

        for &byte in data {
            self.buffer.push(byte);

            // Check for delimiter match at end of buffer
            if self.buffer.len() >= self.delimiter.len() {
                let start = self.buffer.len() - self.delimiter.len();
                let tail = &self.buffer[start..];

                if tail == self.delimiter.as_slice() {
                    let frame: Vec<u8>;
                    if self.include_delimiter {
                        frame = self.buffer.drain(..).collect();
                    } else {
                        frame = self.buffer.drain(..start).collect();
                        self.buffer.clear(); // Clear delimiter
                    }
                    if !frame.is_empty() {
                        frames.push(FrameResult {
                            bytes: frame,
                            incomplete: false,
                            crc_valid: None,
                        });
                    }
                }
            }

            // Force split on max length
            if self.buffer.len() >= self.max_length {
                let frame: Vec<u8> = self.buffer.drain(..).collect();
                frames.push(FrameResult {
                    bytes: frame,
                    incomplete: false,
                    crc_valid: None,
                });
            }
        }

        frames
    }

    fn flush(&mut self) -> Option<FrameResult> {
        if !self.buffer.is_empty() {
            let frame: Vec<u8> = self.buffer.drain(..).collect();
            Some(FrameResult {
                bytes: frame,
                incomplete: true,
                crc_valid: None,
            })
        } else {
            None
        }
    }
}

// =============================================================================
// SLIP Framer (RFC 1055)
// =============================================================================

struct SlipFramer {
    buffer: Vec<u8>,
    in_escape: bool,
}

impl SlipFramer {
    fn new() -> Self {
        SlipFramer {
            buffer: Vec::new(),
            in_escape: false,
        }
    }
}

impl FramerImpl for SlipFramer {
    fn feed(&mut self, data: &[u8]) -> Vec<FrameResult> {
        let mut frames = Vec::new();

        for &byte in data {
            match byte {
                SLIP_END => {
                    if !self.buffer.is_empty() {
                        let frame: Vec<u8> = self.buffer.drain(..).collect();
                        frames.push(FrameResult {
                            bytes: frame,
                            incomplete: false,
                            crc_valid: None,
                        });
                    }
                    self.in_escape = false;
                }
                SLIP_ESC => {
                    self.in_escape = true;
                }
                SLIP_ESC_END => {
                    if self.in_escape {
                        self.buffer.push(SLIP_END);
                        self.in_escape = false;
                    } else {
                        self.buffer.push(byte);
                    }
                }
                SLIP_ESC_ESC => {
                    if self.in_escape {
                        self.buffer.push(SLIP_ESC);
                        self.in_escape = false;
                    } else {
                        self.buffer.push(byte);
                    }
                }
                _ => {
                    if self.in_escape {
                        // Protocol error - push both bytes
                        self.buffer.push(SLIP_ESC);
                    }
                    self.buffer.push(byte);
                    self.in_escape = false;
                }
            }
        }

        frames
    }

    fn flush(&mut self) -> Option<FrameResult> {
        if !self.buffer.is_empty() {
            let frame: Vec<u8> = self.buffer.drain(..).collect();
            Some(FrameResult {
                bytes: frame,
                incomplete: true,
                crc_valid: None,
            })
        } else {
            None
        }
    }
}

// =============================================================================
// Modbus RTU Framer
// =============================================================================

struct ModbusRtuFramer {
    buffer: Vec<u8>,
    device_address: Option<u8>,
    validate_crc: bool,
}

impl ModbusRtuFramer {
    fn new(device_address: Option<u8>, validate_crc: bool) -> Self {
        ModbusRtuFramer {
            buffer: Vec::new(),
            device_address,
            validate_crc,
        }
    }

    /// Try to extract a valid frame from the beginning of the buffer
    fn try_extract_frame(&mut self) -> Option<FrameResult> {
        // Check device address filter
        if let Some(addr) = self.device_address {
            if !self.buffer.is_empty() && self.buffer[0] != addr {
                return None;
            }
        }

        // Try different frame lengths (4 to min(256, buffer.length))
        let max_len = std::cmp::min(256, self.buffer.len());
        for len in 4..=max_len {
            let candidate = &self.buffer[..len];

            if self.validate_crc {
                if len < 4 {
                    continue;
                }
                let data_without_crc = &candidate[..len - 2];
                let crc = crc16_modbus_checksum(data_without_crc);
                let received_crc =
                    (candidate[len - 2] as u16) | ((candidate[len - 1] as u16) << 8);

                if crc == received_crc {
                    // Valid frame found
                    let frame: Vec<u8> = self.buffer.drain(..len).collect();
                    return Some(FrameResult {
                        bytes: frame,
                        incomplete: false,
                        crc_valid: Some(true),
                    });
                }
            } else {
                // Without CRC validation, we can't determine frame boundaries
                // Just return the minimum valid frame
                if len == 4 {
                    let frame: Vec<u8> = self.buffer.drain(..len).collect();
                    return Some(FrameResult {
                        bytes: frame,
                        incomplete: false,
                        crc_valid: None,
                    });
                }
            }
        }

        None
    }
}

impl FramerImpl for ModbusRtuFramer {
    fn feed(&mut self, data: &[u8]) -> Vec<FrameResult> {
        let mut frames = Vec::new();
        self.buffer.extend_from_slice(data);

        // Try to extract valid frames from buffer
        while self.buffer.len() >= 4 {
            if let Some(frame) = self.try_extract_frame() {
                frames.push(frame);
            } else {
                // No valid frame found at current position, shift buffer
                self.buffer.remove(0);
            }
        }

        frames
    }

    fn flush(&mut self) -> Option<FrameResult> {
        if self.buffer.len() >= 4 {
            // Try to validate remaining buffer as a frame
            if self.validate_crc {
                let len = self.buffer.len();
                let data_without_crc = &self.buffer[..len - 2];
                let crc = crc16_modbus_checksum(data_without_crc);
                let received_crc =
                    (self.buffer[len - 2] as u16) | ((self.buffer[len - 1] as u16) << 8);

                if crc == received_crc {
                    let frame: Vec<u8> = self.buffer.drain(..).collect();
                    return Some(FrameResult {
                        bytes: frame,
                        incomplete: true,
                        crc_valid: Some(true),
                    });
                }
            } else {
                let frame: Vec<u8> = self.buffer.drain(..).collect();
                return Some(FrameResult {
                    bytes: frame,
                    incomplete: true,
                    crc_valid: None,
                });
            }
        }
        self.buffer.clear();
        None
    }
}

// =============================================================================
// Raw Framer (Pass-through)
// =============================================================================

/// Raw framer that passes through bytes as-is, batched by read chunks
struct RawFramer {
    buffer: Vec<u8>,
    /// Maximum bytes before emitting a frame
    max_length: usize,
}

impl RawFramer {
    fn new() -> Self {
        RawFramer {
            buffer: Vec::new(),
            max_length: 256, // Emit chunks of up to 256 bytes
        }
    }
}

impl FramerImpl for RawFramer {
    fn feed(&mut self, data: &[u8]) -> Vec<FrameResult> {
        let mut frames = Vec::new();

        for &byte in data {
            self.buffer.push(byte);

            // Emit frame when buffer reaches max length
            if self.buffer.len() >= self.max_length {
                let frame: Vec<u8> = self.buffer.drain(..).collect();
                frames.push(FrameResult {
                    bytes: frame,
                    incomplete: false,
                    crc_valid: None,
                });
            }
        }

        // Also emit any remaining data as a frame (for real-time display)
        if !self.buffer.is_empty() {
            let frame: Vec<u8> = self.buffer.drain(..).collect();
            frames.push(FrameResult {
                bytes: frame,
                incomplete: false,
                crc_valid: None,
            });
        }

        frames
    }

    fn flush(&mut self) -> Option<FrameResult> {
        if self.buffer.is_empty() {
            None
        } else {
            let frame: Vec<u8> = self.buffer.drain(..).collect();
            Some(FrameResult {
                bytes: frame,
                incomplete: true,
                crc_valid: None,
            })
        }
    }
}

// =============================================================================
// Public SerialFramer
// =============================================================================

/// Stateful serial framer for streaming data.
/// Creates frames from raw bytes based on the specified framing configuration.
pub struct SerialFramer {
    framer: Box<dyn FramerImpl + Send>,
}

impl SerialFramer {
    /// Create a new framer with the specified encoding
    pub fn new(encoding: FramingEncoding) -> Self {
        let framer: Box<dyn FramerImpl + Send> = match &encoding {
            FramingEncoding::Delimiter {
                delimiter,
                max_length,
                include_delimiter,
            } => Box::new(DelimiterFramer::new(
                delimiter.clone(),
                *max_length,
                *include_delimiter,
            )),
            FramingEncoding::Slip => Box::new(SlipFramer::new()),
            FramingEncoding::ModbusRtu {
                device_address,
                validate_crc,
            } => Box::new(ModbusRtuFramer::new(*device_address, *validate_crc)),
            FramingEncoding::Raw => Box::new(RawFramer::new()),
        };

        SerialFramer { framer }
    }

    /// Feed raw bytes into the framer.
    /// Returns any complete frames that were parsed.
    pub fn feed(&mut self, data: &[u8]) -> Vec<SerialFrame> {
        self.framer
            .feed(data)
            .into_iter()
            .map(|r| SerialFrame {
                bytes: r.bytes,
                incomplete: r.incomplete,
                crc_valid: r.crc_valid,
            })
            .collect()
    }

    /// Flush any remaining buffered data as a frame.
    /// Call when stream ends.
    /// Returns a frame marked as incomplete since no delimiter was found.
    pub fn flush(&mut self) -> Option<SerialFrame> {
        self.framer.flush().map(|r| SerialFrame {
            bytes: r.bytes,
            incomplete: r.incomplete,
            crc_valid: r.crc_valid,
        })
    }
}

// =============================================================================
// Convenience Functions (for future transmission support)
// =============================================================================

/// SLIP encode data (for transmission)
#[allow(dead_code)]
pub fn slip_encode(data: &[u8]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(data.len() + 2);
    encoded.push(SLIP_END); // Start with END to flush any line noise

    for &byte in data {
        match byte {
            SLIP_END => {
                encoded.push(SLIP_ESC);
                encoded.push(SLIP_ESC_END);
            }
            SLIP_ESC => {
                encoded.push(SLIP_ESC);
                encoded.push(SLIP_ESC_ESC);
            }
            _ => {
                encoded.push(byte);
            }
        }
    }

    encoded.push(SLIP_END);
    encoded
}

/// Calculate and append CRC-16 Modbus to data
#[allow(dead_code)]
pub fn append_modbus_crc(data: &[u8]) -> Vec<u8> {
    let crc = crc16_modbus_checksum(data);
    let mut result = Vec::with_capacity(data.len() + 2);
    result.extend_from_slice(data);
    result.push((crc & 0xFF) as u8); // Low byte first (little-endian)
    result.push(((crc >> 8) & 0xFF) as u8);
    result
}

/// Validate Modbus RTU frame CRC
#[allow(dead_code)]
pub fn validate_modbus_crc(frame: &[u8]) -> bool {
    if frame.len() < 4 {
        return false;
    }
    let data_without_crc = &frame[..frame.len() - 2];
    let crc = crc16_modbus_checksum(data_without_crc);
    let received_crc =
        (frame[frame.len() - 2] as u16) | ((frame[frame.len() - 1] as u16) << 8);
    crc == received_crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slip_framing() {
        let mut framer = SerialFramer::new(FramingEncoding::Slip);

        // Feed SLIP-encoded data with END markers
        let data = [SLIP_END, 0x01, 0x02, 0x03, SLIP_END, 0x04, 0x05, SLIP_END];
        let frames = framer.feed(&data);

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].bytes, vec![0x01, 0x02, 0x03]);
        assert_eq!(frames[1].bytes, vec![0x04, 0x05]);
    }

    #[test]
    fn test_slip_escape_sequences() {
        let mut framer = SerialFramer::new(FramingEncoding::Slip);

        // Test escape sequences: ESC + ESC_END -> END, ESC + ESC_ESC -> ESC
        let data = [SLIP_ESC, SLIP_ESC_END, SLIP_ESC, SLIP_ESC_ESC, SLIP_END];
        let frames = framer.feed(&data);

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].bytes, vec![SLIP_END, SLIP_ESC]);
    }

    #[test]
    fn test_slip_encode_decode_roundtrip() {
        let original = vec![0x01, SLIP_END, 0x02, SLIP_ESC, 0x03];
        let encoded = slip_encode(&original);

        let mut framer = SerialFramer::new(FramingEncoding::Slip);
        let frames = framer.feed(&encoded);

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].bytes, original);
    }

    #[test]
    fn test_delimiter_framing() {
        let mut framer = SerialFramer::new(FramingEncoding::Delimiter {
            delimiter: vec![0x0D, 0x0A], // CRLF
            max_length: 256,
            include_delimiter: false,
        });

        let data = b"Hello\r\nWorld\r\n";
        let frames = framer.feed(data);

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].bytes, b"Hello".to_vec());
        assert_eq!(frames[1].bytes, b"World".to_vec());
    }

    #[test]
    fn test_delimiter_framing_include_delimiter() {
        let mut framer = SerialFramer::new(FramingEncoding::Delimiter {
            delimiter: vec![0x0D, 0x0A],
            max_length: 256,
            include_delimiter: true,
        });

        let data = b"Hello\r\n";
        let frames = framer.feed(data);

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].bytes, b"Hello\r\n".to_vec());
    }

    #[test]
    fn test_delimiter_max_length() {
        let mut framer = SerialFramer::new(FramingEncoding::Delimiter {
            delimiter: vec![0x0A],
            max_length: 5,
            include_delimiter: false,
        });

        let data = b"12345678"; // 8 bytes, no delimiter
        let frames = framer.feed(data);

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].bytes, b"12345".to_vec());

        // Remaining 3 bytes in buffer
        let flushed = framer.flush();
        assert!(flushed.is_some());
        assert_eq!(flushed.unwrap().bytes, b"678".to_vec());
    }

    #[test]
    fn test_modbus_crc_validation() {
        // Valid Modbus RTU frame: address 0x01, function 0x03, data, CRC
        let valid_frame = append_modbus_crc(&[0x01, 0x03, 0x00, 0x00, 0x00, 0x0A]);
        assert!(validate_modbus_crc(&valid_frame));

        // Corrupt the frame
        let mut invalid_frame = valid_frame.clone();
        invalid_frame[2] = 0xFF;
        assert!(!validate_modbus_crc(&invalid_frame));
    }

    #[test]
    fn test_frame_id_extraction() {
        let frame = vec![0x01, 0x02, 0x03, 0x04, 0x05];

        // Single byte at start
        let config = FrameIdConfig {
            start_byte: 0,
            num_bytes: 1,
            big_endian: false,
        };
        assert_eq!(extract_frame_id(&frame, &config), Some(0x01));

        // Two bytes, little-endian
        let config = FrameIdConfig {
            start_byte: 1,
            num_bytes: 2,
            big_endian: false,
        };
        assert_eq!(extract_frame_id(&frame, &config), Some(0x0302));

        // Two bytes, big-endian
        let config = FrameIdConfig {
            start_byte: 1,
            num_bytes: 2,
            big_endian: true,
        };
        assert_eq!(extract_frame_id(&frame, &config), Some(0x0203));

        // Negative index (from end)
        let config = FrameIdConfig {
            start_byte: -1,
            num_bytes: 1,
            big_endian: false,
        };
        assert_eq!(extract_frame_id(&frame, &config), Some(0x05));
    }

    #[test]
    fn test_flush_marks_incomplete() {
        let mut framer = SerialFramer::new(FramingEncoding::Slip);

        // Feed data without END marker
        let data = [0x01, 0x02, 0x03];
        let frames = framer.feed(&data);
        assert!(frames.is_empty());

        // Flush should return incomplete frame
        let flushed = framer.flush();
        assert!(flushed.is_some());
        let frame = flushed.unwrap();
        assert!(frame.incomplete);
        assert_eq!(frame.bytes, vec![0x01, 0x02, 0x03]);
    }
}
