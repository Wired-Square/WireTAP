// ui/src-tauri/src/io/gvret/codec.rs
//
// GVRET binary protocol codec.
//
// Protocol reference: https://github.com/collin80/GVRET
//
// Receive frame format:
//   [0xF1][0x00][Timestamp-4bytes-LE][FrameID-4bytes-LE][Bus+DLC-1byte][Data...]
//
// Transmit frame format:
//   [0xF1][0x00][FrameID-4bytes-LE][Bus-1byte][Length-1byte][Data...]

#![allow(dead_code)]

use crate::io::error::IoError;
use crate::io::{now_us, CanTransmitFrame, FrameMessage};
use crate::io::codec::FrameCodec;

/// GVRET protocol constants
pub mod constants {
    /// GVRET sync byte
    pub const SYNC: u8 = 0xF1;
    /// GVRET command: CAN frame data
    pub const CMD_FRAME: u8 = 0x00;
    /// Extended frame flag (bit 31 of frame ID)
    pub const CAN_EFF_FLAG: u32 = 0x8000_0000;
    /// Mask for standard (11-bit) CAN ID
    pub const CAN_SFF_MASK: u32 = 0x0000_07FF;
    /// Mask for extended (29-bit) CAN ID
    pub const CAN_EFF_MASK: u32 = 0x1FFF_FFFF;
    /// DLC to payload length mapping (CAN FD DLC codes)
    pub const DLC_LEN: [usize; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
    /// Minimum header length for receive frames
    pub const RX_HEADER_LEN: usize = 2 + 4 + 4 + 1; // sync + cmd + ts + id + bus_dlc
    /// Minimum frame length for transmit (header only)
    pub const TX_HEADER_LEN: usize = 2 + 4 + 1 + 1; // sync + cmd + id + bus + len
}

/// GVRET binary protocol codec.
pub struct GvretCodec;

impl FrameCodec for GvretCodec {
    /// Raw frame is a byte slice (minimum 11 bytes for header)
    type RawFrame = [u8];
    /// Encoded frame is a Vec<u8>
    type EncodedFrame = Vec<u8>;

    /// Decode a single GVRET receive frame from bytes.
    ///
    /// Expects a complete frame starting with `[0xF1][0x00]`.
    /// The frame must include the full header (11 bytes) plus data.
    fn decode(raw: &[u8]) -> Result<FrameMessage, IoError> {
        use constants::*;

        if raw.len() < RX_HEADER_LEN {
            return Err(IoError::protocol(
                "gvret",
                format!(
                    "frame too short: {} bytes, need at least {}",
                    raw.len(),
                    RX_HEADER_LEN
                ),
            ));
        }

        // Verify sync and command bytes
        if raw[0] != SYNC || raw[1] != CMD_FRAME {
            return Err(IoError::protocol(
                "gvret",
                format!("invalid header: {:02X} {:02X}", raw[0], raw[1]),
            ));
        }

        // Parse bus+dlc byte
        let bus_dlc = raw[10];
        let dlc_nibble = (bus_dlc & 0x0F) as usize;
        if dlc_nibble > 0x0F {
            return Err(IoError::protocol(
                "gvret",
                format!("invalid DLC nibble: {}", dlc_nibble),
            ));
        }

        let payload_len = DLC_LEN[dlc_nibble];
        let total_len = RX_HEADER_LEN + payload_len;

        if raw.len() < total_len {
            return Err(IoError::protocol(
                "gvret",
                format!(
                    "incomplete frame: {} bytes, need {}",
                    raw.len(),
                    total_len
                ),
            ));
        }

        // Parse frame ID (little-endian, bytes 6-10)
        let can_id = u32::from_le_bytes(raw[6..10].try_into().unwrap_or([0; 4]));
        let data = if payload_len > 0 {
            raw[11..11 + payload_len].to_vec()
        } else {
            Vec::new()
        };

        let is_ext = (can_id & CAN_EFF_FLAG) != 0;
        let arb_id = can_id
            & if is_ext {
                CAN_EFF_MASK
            } else {
                CAN_SFF_MASK
            };
        let is_fd = payload_len > 8;
        let bus = (bus_dlc >> 4) & 0x0F;

        Ok(FrameMessage {
            protocol: "can".to_string(),
            timestamp_us: now_us(),
            frame_id: arb_id,
            bus,
            dlc: payload_len as u8,
            bytes: data,
            is_extended: is_ext,
            is_fd,
            source_address: None,
            incomplete: None,
            direction: None,
        })
    }

    /// Encode a CAN frame to GVRET binary format for transmission.
    ///
    /// Format: `[0xF1][0x00][FrameID-4bytes-LE][Bus-1byte][Length-1byte][Data...]`
    fn encode(frame: &CanTransmitFrame) -> Result<Vec<u8>, IoError> {
        use constants::*;

        // Validate data length
        if !frame.is_fd && frame.data.len() > 8 {
            return Err(IoError::protocol(
                "gvret",
                format!(
                    "classic CAN frame data too long: {} bytes (max 8)",
                    frame.data.len()
                ),
            ));
        }

        if frame.is_fd && frame.data.len() > 64 {
            return Err(IoError::protocol(
                "gvret",
                format!(
                    "CAN FD frame data too long: {} bytes (max 64)",
                    frame.data.len()
                ),
            ));
        }

        // Validate bus number (GVRET supports buses 0-4)
        if frame.bus > 4 {
            return Err(IoError::protocol(
                "gvret",
                format!("invalid bus number: {} (valid: 0-4)", frame.bus),
            ));
        }

        let mut buf = Vec::with_capacity(TX_HEADER_LEN + frame.data.len());

        // Sync byte and command
        buf.push(SYNC);
        buf.push(CMD_FRAME);

        // Frame ID (4 bytes, little-endian)
        // Set bit 31 for extended ID
        let frame_id = if frame.is_extended {
            frame.frame_id | CAN_EFF_FLAG
        } else {
            frame.frame_id & CAN_SFF_MASK
        };
        buf.extend_from_slice(&frame_id.to_le_bytes());

        // Bus number
        buf.push(frame.bus);

        // Data length
        buf.push(frame.data.len() as u8);

        // Data bytes
        buf.extend_from_slice(&frame.data);

        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gvret_decode_standard_frame() {
        // F1 00 <ts:4> <id:4> <bus_dlc:1> <data:4>
        // ID: 0x123 (standard), Bus 0, DLC 4, Data: AA BB CC DD
        let raw = [
            0xF1, 0x00, // Sync + command
            0x00, 0x00, 0x00, 0x00, // Timestamp (ignored)
            0x23, 0x01, 0x00, 0x00, // ID 0x123 LE
            0x04, // Bus 0, DLC 4
            0xAA, 0xBB, 0xCC, 0xDD, // Data
        ];

        let frame = GvretCodec::decode(&raw).unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 4);
        assert_eq!(frame.bytes, vec![0xAA, 0xBB, 0xCC, 0xDD]);
        assert!(!frame.is_extended);
        assert!(!frame.is_fd);
    }

    #[test]
    fn test_gvret_decode_extended_frame() {
        // Extended frame with ID 0x12345678
        let raw = [
            0xF1, 0x00, // Sync + command
            0x00, 0x00, 0x00, 0x00, // Timestamp
            0x78, 0x56, 0x34, 0x92, // ID 0x12345678 | 0x80000000 LE
            0x02, // Bus 0, DLC 2
            0x11, 0x22, // Data
        ];

        let frame = GvretCodec::decode(&raw).unwrap();
        assert_eq!(frame.frame_id, 0x12345678);
        assert!(frame.is_extended);
        assert_eq!(frame.bytes, vec![0x11, 0x22]);
    }

    #[test]
    fn test_gvret_encode_standard_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0x11, 0x22, 0x33, 0x44],
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = GvretCodec::encode(&frame).unwrap();

        assert_eq!(encoded[0], 0xF1); // Sync
        assert_eq!(encoded[1], 0x00); // Command
        assert_eq!(encoded[2], 0x23); // ID byte 0
        assert_eq!(encoded[3], 0x01); // ID byte 1
        assert_eq!(encoded[4], 0x00); // ID byte 2
        assert_eq!(encoded[5], 0x00); // ID byte 3
        assert_eq!(encoded[6], 0x00); // Bus
        assert_eq!(encoded[7], 0x04); // Length
        assert_eq!(&encoded[8..], &[0x11, 0x22, 0x33, 0x44]);
    }

    #[test]
    fn test_gvret_encode_extended_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x12345678,
            data: vec![0xAA, 0xBB],
            bus: 1,
            is_extended: true,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = GvretCodec::encode(&frame).unwrap();

        // ID with extended flag: 0x12345678 | 0x80000000 = 0x92345678
        // Little-endian: [0x78, 0x56, 0x34, 0x92]
        assert_eq!(encoded[2], 0x78);
        assert_eq!(encoded[3], 0x56);
        assert_eq!(encoded[4], 0x34);
        assert_eq!(encoded[5], 0x92);
        assert_eq!(encoded[6], 0x01); // Bus
    }

    #[test]
    fn test_gvret_roundtrip() {
        let original = CanTransmitFrame {
            frame_id: 0x7FF,
            data: vec![0xDE, 0xAD, 0xBE, 0xEF],
            bus: 2,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = GvretCodec::encode(&original).unwrap();

        // Build a receive frame from the encoded data
        // TX format: [sync][cmd][id:4][bus][len][data...]
        // RX format: [sync][cmd][ts:4][id:4][bus_dlc][data...]
        let mut rx_frame = vec![0xF1, 0x00, 0, 0, 0, 0]; // sync + cmd + timestamp
        rx_frame.extend_from_slice(&encoded[2..6]); // id
        rx_frame.push((original.bus << 4) | (original.data.len() as u8)); // bus_dlc
        rx_frame.extend_from_slice(&original.data);

        let decoded = GvretCodec::decode(&rx_frame).unwrap();
        assert_eq!(decoded.frame_id, original.frame_id);
        assert_eq!(decoded.bytes, original.data);
        assert_eq!(decoded.bus, original.bus);
    }
}
