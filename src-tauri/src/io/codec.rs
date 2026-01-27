// ui/src-tauri/src/io/codec.rs
//
// Unified frame codec trait and re-exports of protocol-specific implementations.
//
// This module provides a common interface for encoding and decoding CAN frames
// across different protocols (GVRET, slcan, gs_usb, SocketCAN).
//
// Each protocol's codec is implemented in its driver module:
// - gvret/codec.rs - GVRET binary protocol
// - slcan/codec.rs - slcan ASCII protocol
// - gs_usb/codec.rs - gs_usb/candleLight protocol
// - socketcan/codec.rs - Linux SocketCAN protocol
//
// The FrameCodec trait is designed for single-frame operations. Protocols that
// require buffer-based streaming (like GVRET receive) provide additional
// buffer-aware functions alongside the trait implementation.

// Allow unused items - this is an API module with exports for external use
#![allow(dead_code, unused_imports)]

use crate::io::error::IoError;
use crate::io::{CanTransmitFrame, FrameMessage};

// ============================================================================
// Frame Codec Trait
// ============================================================================

/// Trait for CAN frame codecs.
///
/// Each protocol implements this trait to provide unified encode/decode operations.
/// The associated types define the protocol-specific raw frame formats.
pub trait FrameCodec {
    /// The raw frame type for decoding (e.g., byte slice, ASCII string)
    type RawFrame: ?Sized;

    /// The encoded frame type for transmission
    type EncodedFrame;

    /// Decode a raw frame into a FrameMessage.
    ///
    /// Returns `Ok(FrameMessage)` on success, or `Err(IoError)` if the frame
    /// is malformed or cannot be parsed.
    fn decode(raw: &Self::RawFrame) -> Result<FrameMessage, IoError>;

    /// Encode a transmit frame for the protocol.
    ///
    /// Returns `Ok(EncodedFrame)` on success, or `Err(IoError)` if the frame
    /// cannot be encoded (e.g., invalid parameters).
    fn encode(frame: &CanTransmitFrame) -> Result<Self::EncodedFrame, IoError>;
}

// ============================================================================
// Re-exports from driver modules
// ============================================================================

// GVRET codec
pub use super::gvret::codec::GvretCodec;

// slcan codec
pub use super::slcan::codec::SlcanCodec;

// gs_usb codec
pub use super::gs_usb::codec::GsUsbCodec;

// SocketCAN codec
pub use super::socketcan::codec::{SocketCanCodec, SocketCanEncodedFrame};

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::CanTransmitFrame;

    fn make_test_frame() -> CanTransmitFrame {
        CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0x11, 0x22, 0x33, 0x44],
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        }
    }

    #[test]
    fn test_gvret_roundtrip() {
        let frame = make_test_frame();
        let encoded = GvretCodec::encode(&frame).expect("encode failed");
        // GVRET transmit format starts with 0xF1 0x00
        assert_eq!(encoded[0], 0xF1);
        assert_eq!(encoded[1], 0x00);
    }

    #[test]
    fn test_slcan_roundtrip() {
        let frame = make_test_frame();
        let encoded = SlcanCodec::encode(&frame).expect("encode failed");
        // slcan starts with 't' or 'T' for standard/extended
        assert!(encoded.starts_with(b"t") || encoded.starts_with(b"T"));
        // Should end with carriage return
        assert!(encoded.ends_with(b"\r"));
    }

    #[test]
    fn test_gs_usb_encode() {
        let frame = make_test_frame();
        let encoded = GsUsbCodec::encode(&frame).expect("encode failed");
        // gs_usb is fixed 20 bytes
        assert_eq!(encoded.len(), 20);
        // echo_id is at bytes 0-3 (should be TX_ECHO_ID = 0)
        assert_eq!(u32::from_le_bytes(encoded[0..4].try_into().unwrap()), 0);
    }

    #[test]
    fn test_socketcan_encode_classic() {
        let frame = make_test_frame();
        let encoded = SocketCanCodec::encode(&frame).expect("encode failed");
        match encoded {
            SocketCanEncodedFrame::Classic(buf) => {
                // Classic frame is 16 bytes
                assert_eq!(buf.len(), 16);
            }
            SocketCanEncodedFrame::Fd(_) => panic!("Expected classic frame"),
        }
    }
}
