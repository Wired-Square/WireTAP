// ui/src-tauri/src/io/socketcan/codec.rs
//
// SocketCAN frame codec for Linux kernel CAN interface.
//
// Supports both classic CAN (16-byte struct can_frame) and
// CAN FD (72-byte struct canfd_frame).

use crate::io::codec::FrameCodec;
use crate::io::error::IoError;
use crate::io::{now_us, CanTransmitFrame, FrameMessage};

// ============================================================================
// SocketCAN Codec
// ============================================================================

/// SocketCAN frame codec (Linux kernel CAN interface).
///
/// Supports both classic CAN (16-byte struct can_frame) and
/// CAN FD (72-byte struct canfd_frame).
pub struct SocketCanCodec;

/// SocketCAN protocol constants
pub mod consts {
    /// Size of classic CAN frame (struct can_frame)
    pub const CLASSIC_FRAME_SIZE: usize = 16;
    /// Size of CAN FD frame (struct canfd_frame)
    pub const FD_FRAME_SIZE: usize = 72;
    /// Extended ID flag in can_id
    pub const CAN_EFF_FLAG: u32 = 0x8000_0000;
    /// RTR flag in can_id
    pub const CAN_RTR_FLAG: u32 = 0x4000_0000;
    /// Mask for 29-bit extended ID
    pub const CAN_EFF_MASK: u32 = 0x1FFF_FFFF;
    /// BRS flag for CAN FD
    pub const CANFD_BRS: u8 = 0x01;
}

/// Encoded SocketCAN frame - either classic (16 bytes) or FD (72 bytes)
#[derive(Clone, Debug)]
pub enum SocketCanEncodedFrame {
    Classic([u8; consts::CLASSIC_FRAME_SIZE]),
    Fd([u8; consts::FD_FRAME_SIZE]),
}

impl FrameCodec for SocketCanCodec {
    /// Raw frame is a byte slice (16 or 72 bytes)
    type RawFrame = [u8];
    /// Encoded frame can be either classic or FD
    type EncodedFrame = SocketCanEncodedFrame;

    /// Decode a SocketCAN frame (16 bytes classic or 72 bytes FD).
    ///
    /// Classic layout: can_id(4) + dlc(1) + pad(3) + data(8)
    /// FD layout: can_id(4) + len(1) + flags(1) + pad(2) + data(64)
    fn decode(raw: &[u8]) -> Result<FrameMessage, IoError> {
        let is_fd = raw.len() >= consts::FD_FRAME_SIZE;

        if !is_fd && raw.len() < consts::CLASSIC_FRAME_SIZE {
            return Err(IoError::protocol(
                "socketcan",
                format!(
                    "frame too short: {} bytes, need at least {}",
                    raw.len(),
                    consts::CLASSIC_FRAME_SIZE
                ),
            ));
        }

        // Parse can_id
        let can_id = u32::from_ne_bytes(raw[0..4].try_into().unwrap());
        let is_extended = (can_id & consts::CAN_EFF_FLAG) != 0;
        let frame_id = can_id & consts::CAN_EFF_MASK;

        // Parse length
        let data_len = raw[4] as usize;
        let max_len = if is_fd { 64 } else { 8 };
        let actual_len = data_len.min(max_len);

        // Extract data
        let data = raw[8..8 + actual_len].to_vec();

        Ok(FrameMessage {
            protocol: "can".to_string(),
            timestamp_us: now_us(),
            frame_id,
            bus: 0, // SocketCAN doesn't embed bus in frame
            dlc: data_len as u8,
            bytes: data,
            is_extended,
            is_fd,
            source_address: None,
            incomplete: None,
            direction: None,
        })
    }

    /// Encode a CAN frame for SocketCAN.
    ///
    /// Returns Classic (16 bytes) for standard CAN or Fd (72 bytes) for CAN FD.
    fn encode(frame: &CanTransmitFrame) -> Result<SocketCanEncodedFrame, IoError> {
        if frame.is_fd {
            // Validate FD data length
            if frame.data.len() > 64 {
                return Err(IoError::protocol(
                    "socketcan",
                    format!(
                        "FD data too long: {} bytes (max 64)",
                        frame.data.len()
                    ),
                ));
            }

            let mut buf = [0u8; consts::FD_FRAME_SIZE];

            // can_id with flags
            let mut can_id = frame.frame_id;
            if frame.is_extended {
                can_id |= consts::CAN_EFF_FLAG;
            }
            buf[0..4].copy_from_slice(&can_id.to_ne_bytes());

            // len
            buf[4] = frame.data.len().min(64) as u8;

            // flags (BRS if requested)
            if frame.is_brs {
                buf[5] |= consts::CANFD_BRS;
            }

            // data
            let len = frame.data.len().min(64);
            buf[8..8 + len].copy_from_slice(&frame.data[..len]);

            Ok(SocketCanEncodedFrame::Fd(buf))
        } else {
            // Validate classic data length
            if frame.data.len() > 8 {
                return Err(IoError::protocol(
                    "socketcan",
                    format!(
                        "classic data too long: {} bytes (max 8)",
                        frame.data.len()
                    ),
                ));
            }

            let mut buf = [0u8; consts::CLASSIC_FRAME_SIZE];

            // can_id with flags
            let mut can_id = frame.frame_id;
            if frame.is_extended {
                can_id |= consts::CAN_EFF_FLAG;
            }
            if frame.is_rtr {
                can_id |= consts::CAN_RTR_FLAG;
            }
            buf[0..4].copy_from_slice(&can_id.to_ne_bytes());

            // dlc
            buf[4] = frame.data.len().min(8) as u8;

            // data
            let len = frame.data.len().min(8);
            buf[8..8 + len].copy_from_slice(&frame.data[..len]);

            Ok(SocketCanEncodedFrame::Classic(buf))
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_socketcan_decode_classic_frame() {
        let mut raw = [0u8; 16];
        // can_id = 0x123
        raw[0..4].copy_from_slice(&0x123u32.to_ne_bytes());
        // dlc = 4
        raw[4] = 4;
        // data
        raw[8..12].copy_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]);

        let frame = SocketCanCodec::decode(&raw).unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 4);
        assert_eq!(frame.bytes, vec![0xAA, 0xBB, 0xCC, 0xDD]);
        assert!(!frame.is_fd);
    }

    #[test]
    fn test_socketcan_decode_fd_frame() {
        let mut raw = [0u8; 72];
        // can_id = 0x456 with extended flag
        raw[0..4].copy_from_slice(&(0x456u32 | consts::CAN_EFF_FLAG).to_ne_bytes());
        // len = 12
        raw[4] = 12;
        // data
        for i in 0..12 {
            raw[8 + i] = i as u8;
        }

        let frame = SocketCanCodec::decode(&raw).unwrap();
        assert_eq!(frame.frame_id, 0x456);
        assert_eq!(frame.dlc, 12);
        assert!(frame.is_extended);
        assert!(frame.is_fd);
    }

    #[test]
    fn test_socketcan_encode_classic_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0x11, 0x22, 0x33],
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = SocketCanCodec::encode(&frame).unwrap();
        match encoded {
            SocketCanEncodedFrame::Classic(buf) => {
                assert_eq!(
                    u32::from_ne_bytes(buf[0..4].try_into().unwrap()),
                    0x123
                );
                assert_eq!(buf[4], 3);
                assert_eq!(&buf[8..11], &[0x11, 0x22, 0x33]);
            }
            SocketCanEncodedFrame::Fd(_) => panic!("Expected classic frame"),
        }
    }

    #[test]
    fn test_socketcan_encode_fd_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x456,
            data: vec![0; 16], // 16 bytes requires FD
            bus: 0,
            is_extended: true,
            is_fd: true,
            is_brs: true,
            is_rtr: false,
        };

        let encoded = SocketCanCodec::encode(&frame).unwrap();
        match encoded {
            SocketCanEncodedFrame::Fd(buf) => {
                let can_id = u32::from_ne_bytes(buf[0..4].try_into().unwrap());
                assert_eq!(can_id, 0x456 | consts::CAN_EFF_FLAG);
                assert_eq!(buf[4], 16);
                assert_eq!(buf[5] & consts::CANFD_BRS, consts::CANFD_BRS);
            }
            SocketCanEncodedFrame::Classic(_) => panic!("Expected FD frame"),
        }
    }

    #[test]
    fn test_socketcan_encode_data_too_long() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0; 9], // Too long for classic CAN
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        assert!(SocketCanCodec::encode(&frame).is_err());
    }
}
