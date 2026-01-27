// ui/src-tauri/src/io/slcan/codec.rs
//
// slcan (Serial Line CAN) ASCII protocol codec.
//
// Protocol reference: http://www.can232.com/docs/can232_v3.pdf
//
// Frame formats:
//   Standard: t<ID:3hex><DLC:1hex><DATA:2hex*DLC>\r
//   Extended: T<ID:8hex><DLC:1hex><DATA:2hex*DLC>\r
//   RTR:      r<ID:3hex><DLC:1hex>\r / R<ID:8hex><DLC:1hex>\r

#![allow(dead_code)]

use crate::io::error::IoError;
use crate::io::{now_us, CanTransmitFrame, FrameMessage};
use crate::io::codec::FrameCodec;

/// slcan (Serial Line CAN) ASCII protocol codec.
pub struct SlcanCodec;

impl FrameCodec for SlcanCodec {
    /// Raw frame is an ASCII string (without trailing \r)
    type RawFrame = str;
    /// Encoded frame is a Vec<u8> (ASCII bytes with trailing \r)
    type EncodedFrame = Vec<u8>;

    /// Decode an slcan ASCII frame line.
    ///
    /// Examples:
    ///   `t1234AABBCCDD` -> Standard frame, ID=0x123, DLC=4, data=AA BB CC DD
    ///   `T123456788AABBCCDD112233445566` -> Extended frame, ID=0x12345678, DLC=8
    ///   `r1230` -> Standard RTR, ID=0x123, DLC=0
    fn decode(line: &str) -> Result<FrameMessage, IoError> {
        let bytes = line.as_bytes();
        if bytes.is_empty() {
            return Err(IoError::protocol("slcan", "empty frame"));
        }

        // Determine frame type from first character
        let (is_extended, is_rtr) = match bytes[0] {
            b't' => (false, false), // Standard data frame
            b'T' => (true, false),  // Extended data frame
            b'r' => (false, true),  // Standard RTR
            b'R' => (true, true),   // Extended RTR
            c => {
                return Err(IoError::protocol(
                    "slcan",
                    format!("invalid frame prefix: '{}'", c as char),
                ))
            }
        };

        let id_len = if is_extended { 8 } else { 3 };
        let min_len = 1 + id_len + 1; // prefix + ID + DLC

        if bytes.len() < min_len {
            return Err(IoError::protocol(
                "slcan",
                format!(
                    "frame too short: {} bytes, need at least {}",
                    bytes.len(),
                    min_len
                ),
            ));
        }

        // Parse frame ID (hex ASCII)
        let id_str = std::str::from_utf8(&bytes[1..1 + id_len])
            .map_err(|_| IoError::protocol("slcan", "invalid UTF-8 in frame ID"))?;
        let frame_id = u32::from_str_radix(id_str, 16)
            .map_err(|_| IoError::protocol("slcan", format!("invalid hex ID: {}", id_str)))?;

        // Parse DLC (single hex digit)
        let dlc_char = bytes[1 + id_len] as char;
        let dlc = dlc_char.to_digit(16).ok_or_else(|| {
            IoError::protocol("slcan", format!("invalid DLC character: '{}'", dlc_char))
        })? as u8;

        // Validate DLC (max 8 for classic CAN)
        if dlc > 8 {
            return Err(IoError::protocol(
                "slcan",
                format!("invalid DLC: {} (max 8)", dlc),
            ));
        }

        // Parse data bytes (pairs of hex characters)
        let mut data = Vec::with_capacity(dlc as usize);
        if !is_rtr && dlc > 0 {
            let data_start = 1 + id_len + 1;
            let expected_len = data_start + (dlc as usize * 2);

            if bytes.len() < expected_len {
                return Err(IoError::protocol(
                    "slcan",
                    format!(
                        "incomplete data: {} bytes, need {}",
                        bytes.len(),
                        expected_len
                    ),
                ));
            }

            for i in 0..dlc as usize {
                let byte_str = std::str::from_utf8(&bytes[data_start + i * 2..data_start + i * 2 + 2])
                    .map_err(|_| IoError::protocol("slcan", "invalid UTF-8 in data bytes"))?;
                let byte = u8::from_str_radix(byte_str, 16).map_err(|_| {
                    IoError::protocol("slcan", format!("invalid hex byte: {}", byte_str))
                })?;
                data.push(byte);
            }
        }

        Ok(FrameMessage {
            protocol: "can".to_string(),
            timestamp_us: now_us(),
            frame_id,
            bus: 0,
            dlc,
            bytes: data,
            is_extended,
            is_fd: false,
            source_address: None,
            incomplete: None,
            direction: None,
        })
    }

    /// Encode a CAN frame to slcan ASCII format.
    ///
    /// Returns ASCII bytes including trailing `\r`.
    fn encode(frame: &CanTransmitFrame) -> Result<Vec<u8>, IoError> {
        // Validate data length (slcan only supports classic CAN)
        if frame.data.len() > 8 {
            return Err(IoError::protocol(
                "slcan",
                format!(
                    "data too long for slcan: {} bytes (max 8)",
                    frame.data.len()
                ),
            ));
        }

        let mut cmd = String::with_capacity(32);

        // Frame type prefix and ID
        if frame.is_extended {
            cmd.push('T');
            cmd.push_str(&format!("{:08X}", frame.frame_id));
        } else {
            cmd.push('t');
            cmd.push_str(&format!("{:03X}", frame.frame_id & 0x7FF));
        }

        // DLC
        cmd.push_str(&format!("{:X}", frame.data.len().min(8)));

        // Data bytes
        for byte in &frame.data {
            cmd.push_str(&format!("{:02X}", byte));
        }

        cmd.push('\r');
        Ok(cmd.into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slcan_decode_standard_frame() {
        let frame = SlcanCodec::decode("t1234AABBCCDD").unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 4);
        assert_eq!(frame.bytes, vec![0xAA, 0xBB, 0xCC, 0xDD]);
        assert!(!frame.is_extended);
    }

    #[test]
    fn test_slcan_decode_extended_frame() {
        let frame = SlcanCodec::decode("T123456782AABB").unwrap();
        assert_eq!(frame.frame_id, 0x12345678);
        assert_eq!(frame.dlc, 2);
        assert_eq!(frame.bytes, vec![0xAA, 0xBB]);
        assert!(frame.is_extended);
    }

    #[test]
    fn test_slcan_decode_zero_dlc() {
        let frame = SlcanCodec::decode("t1230").unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 0);
        assert!(frame.bytes.is_empty());
    }

    #[test]
    fn test_slcan_decode_rtr() {
        let frame = SlcanCodec::decode("r1234").unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 4);
        assert!(frame.bytes.is_empty()); // RTR has no data
    }

    #[test]
    fn test_slcan_decode_invalid_prefix() {
        assert!(SlcanCodec::decode("x1234AABB").is_err());
        assert!(SlcanCodec::decode("").is_err());
    }

    #[test]
    fn test_slcan_encode_standard_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0x01, 0x02, 0x03],
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = SlcanCodec::encode(&frame).unwrap();
        assert_eq!(encoded, b"t1233010203\r");
    }

    #[test]
    fn test_slcan_encode_extended_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x12345678,
            data: vec![0xAA, 0xBB],
            bus: 0,
            is_extended: true,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = SlcanCodec::encode(&frame).unwrap();
        assert_eq!(encoded, b"T123456782AABB\r");
    }

    #[test]
    fn test_slcan_roundtrip() {
        let original = CanTransmitFrame {
            frame_id: 0x7FF,
            data: vec![0xDE, 0xAD, 0xBE, 0xEF],
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = SlcanCodec::encode(&original).unwrap();
        // Remove trailing \r for parsing
        let encoded_str = std::str::from_utf8(&encoded[..encoded.len() - 1]).unwrap();
        let decoded = SlcanCodec::decode(encoded_str).unwrap();

        assert_eq!(decoded.frame_id, original.frame_id);
        assert_eq!(decoded.bytes, original.data);
    }
}
