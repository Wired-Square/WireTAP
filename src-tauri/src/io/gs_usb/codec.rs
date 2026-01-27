// ui/src-tauri/src/io/gs_usb/codec.rs
//
// gs_usb (candleLight/CANable) USB protocol codec.
//
// Uses a 20-byte GsHostFrame structure for both TX and RX.

use crate::io::codec::FrameCodec;
use crate::io::error::IoError;
use crate::io::{now_us, CanTransmitFrame, FrameMessage};

// ============================================================================
// gs_usb Codec
// ============================================================================

/// gs_usb (candleLight/CANable) USB protocol codec.
///
/// Uses a 20-byte GsHostFrame structure for both TX and RX.
pub struct GsUsbCodec;

/// gs_usb protocol constants
pub mod consts {
    /// Size of GsHostFrame structure
    pub const HOST_FRAME_SIZE: usize = 20;
    /// Extended ID flag in can_id
    pub const CAN_EFF_FLAG: u32 = 0x8000_0000;
    /// RTR flag in can_id
    pub const CAN_RTR_FLAG: u32 = 0x4000_0000;
    /// Mask for 29-bit extended ID
    pub const CAN_EFF_MASK: u32 = 0x1FFF_FFFF;
    /// Echo ID value for TX frames (non-0xFFFFFFFF)
    pub const TX_ECHO_ID: u32 = 0;
    /// Echo ID value indicating RX frame
    pub const RX_ECHO_ID: u32 = 0xFFFF_FFFF;
}

impl FrameCodec for GsUsbCodec {
    /// Raw frame is a byte slice (exactly 20 bytes)
    type RawFrame = [u8];
    /// Encoded frame is a fixed-size array
    type EncodedFrame = [u8; consts::HOST_FRAME_SIZE];

    /// Decode a gs_usb host frame (20 bytes).
    ///
    /// Layout: echo_id(4) + can_id(4) + can_dlc(1) + channel(1) + flags(1) + reserved(1) + data(8)
    fn decode(raw: &[u8]) -> Result<FrameMessage, IoError> {
        if raw.len() < consts::HOST_FRAME_SIZE {
            return Err(IoError::protocol(
                "gs_usb",
                format!(
                    "frame too short: {} bytes, need {}",
                    raw.len(),
                    consts::HOST_FRAME_SIZE
                ),
            ));
        }

        // Parse echo_id to check if this is RX or TX echo
        let echo_id = u32::from_le_bytes(raw[0..4].try_into().unwrap());
        if echo_id != consts::RX_ECHO_ID {
            return Err(IoError::protocol(
                "gs_usb",
                "TX echo frame, not RX".to_string(),
            ));
        }

        // Parse can_id
        let can_id = u32::from_le_bytes(raw[4..8].try_into().unwrap());
        let is_extended = (can_id & consts::CAN_EFF_FLAG) != 0;
        let frame_id = can_id & consts::CAN_EFF_MASK;

        // Parse DLC and channel
        let dlc = raw[8];
        let channel = raw[9];

        // Extract data (up to 8 bytes)
        let data_len = (dlc as usize).min(8);
        let data = raw[12..12 + data_len].to_vec();

        Ok(FrameMessage {
            protocol: "can".to_string(),
            timestamp_us: now_us(),
            frame_id,
            bus: channel,
            dlc,
            bytes: data,
            is_extended,
            is_fd: false, // gs_usb classic doesn't support FD
            source_address: None,
            incomplete: None,
            direction: None,
        })
    }

    /// Encode a CAN frame to gs_usb format (20 bytes).
    ///
    /// Layout: echo_id(4) + can_id(4) + can_dlc(1) + channel(1) + flags(1) + reserved(1) + data(8)
    fn encode(frame: &CanTransmitFrame) -> Result<[u8; consts::HOST_FRAME_SIZE], IoError> {
        // Validate data length (gs_usb classic only supports 8 bytes)
        if frame.data.len() > 8 {
            return Err(IoError::protocol(
                "gs_usb",
                format!(
                    "data too long for gs_usb: {} bytes (max 8)",
                    frame.data.len()
                ),
            ));
        }

        let mut buf = [0u8; consts::HOST_FRAME_SIZE];

        // echo_id: non-0xFFFFFFFF for TX
        buf[0..4].copy_from_slice(&consts::TX_ECHO_ID.to_le_bytes());

        // can_id with flags
        let mut can_id = frame.frame_id;
        if frame.is_extended {
            can_id |= consts::CAN_EFF_FLAG;
        }
        if frame.is_rtr {
            can_id |= consts::CAN_RTR_FLAG;
        }
        buf[4..8].copy_from_slice(&can_id.to_le_bytes());

        // can_dlc
        buf[8] = frame.data.len() as u8;

        // channel (use bus from frame)
        buf[9] = frame.bus;

        // flags (0 for standard CAN)
        buf[10] = 0;

        // reserved
        buf[11] = 0;

        // data (up to 8 bytes)
        let len = frame.data.len().min(8);
        buf[12..12 + len].copy_from_slice(&frame.data[..len]);

        Ok(buf)
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gs_usb_decode_rx_frame() {
        let mut raw = [0u8; 20];
        // echo_id = 0xFFFFFFFF (RX)
        raw[0..4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        // can_id = 0x123
        raw[4..8].copy_from_slice(&0x123u32.to_le_bytes());
        // dlc = 4
        raw[8] = 4;
        // channel = 0
        raw[9] = 0;
        // data
        raw[12..16].copy_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]);

        let frame = GsUsbCodec::decode(&raw).unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 4);
        assert_eq!(frame.bytes, vec![0xAA, 0xBB, 0xCC, 0xDD]);
    }

    #[test]
    fn test_gs_usb_decode_tx_echo_rejected() {
        let mut raw = [0u8; 20];
        // echo_id = 0 (TX echo)
        raw[0..4].copy_from_slice(&0u32.to_le_bytes());
        raw[4..8].copy_from_slice(&0x123u32.to_le_bytes());

        assert!(GsUsbCodec::decode(&raw).is_err());
    }

    #[test]
    fn test_gs_usb_encode_standard_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0x11, 0x22],
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = GsUsbCodec::encode(&frame).unwrap();

        // echo_id = 0
        assert_eq!(u32::from_le_bytes(encoded[0..4].try_into().unwrap()), 0);
        // can_id = 0x123
        assert_eq!(
            u32::from_le_bytes(encoded[4..8].try_into().unwrap()),
            0x123
        );
        // dlc = 2
        assert_eq!(encoded[8], 2);
        // channel = 0
        assert_eq!(encoded[9], 0);
        // data
        assert_eq!(&encoded[12..14], &[0x11, 0x22]);
    }

    #[test]
    fn test_gs_usb_encode_extended_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x12345678,
            data: vec![0xAA],
            bus: 1,
            is_extended: true,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = GsUsbCodec::encode(&frame).unwrap();

        // can_id should have extended flag set
        let can_id = u32::from_le_bytes(encoded[4..8].try_into().unwrap());
        assert_eq!(can_id, 0x12345678 | consts::CAN_EFF_FLAG);
        // channel = 1
        assert_eq!(encoded[9], 1);
    }

    #[test]
    fn test_gs_usb_encode_data_too_long() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0; 9], // Too long for gs_usb
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        assert!(GsUsbCodec::encode(&frame).is_err());
    }
}
