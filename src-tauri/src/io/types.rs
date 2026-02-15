// ui/src-tauri/src/io/source_types.rs
//
// Shared types for multi-source streaming.
// Used by interface implementations to communicate with the merge task.

use std::sync::mpsc as std_mpsc;

use crate::buffer_store::TimestampedByte;
use serde::Serialize;
use super::FrameMessage;

// ============================================================================
// Source Messages
// ============================================================================

/// Timestamped byte entry for raw byte streams (serial, SPI, etc.)
#[derive(Clone, Debug)]
pub struct ByteEntry {
    pub byte: u8,
    pub timestamp_us: u64,
    /// Bus/interface number (from bus mapping)
    pub bus: u8,
}

/// Internal message from sub-readers to the merge task
pub enum SourceMessage {
    /// Frames from a source (source_index, frames)
    Frames(usize, Vec<FrameMessage>),
    /// Raw bytes from a source (source_index, bytes with timestamps)
    /// Only constructed by serial reader which is not available on iOS
    #[cfg_attr(target_os = "ios", allow(dead_code))]
    Bytes(usize, Vec<ByteEntry>),
    /// Source ended (source_index, reason)
    Ended(usize, String),
    /// Source error (source_index, error)
    Error(usize, String),
    /// Transmit channel is ready (source_index, transmit_sender)
    TransmitReady(usize, TransmitSender),
    /// Source connected successfully (source_index, device_type, address, bus_number)
    Connected(usize, String, String, Option<u8>),
}

// ============================================================================
// Transmit Types
// ============================================================================

/// Transmit request sent through the channel
pub struct TransmitRequest {
    /// Encoded frame bytes ready to send
    pub data: Vec<u8>,
    /// Sync oneshot channel to send the result back
    pub result_tx: std_mpsc::SyncSender<Result<(), String>>,
}

/// Sender type for transmit requests (sync-safe)
pub type TransmitSender = std_mpsc::SyncSender<TransmitRequest>;

// ============================================================================
// Byte Payload Types
// ============================================================================

/// Payload for raw bytes event - emitted in batches for performance.
/// Each byte has its own timestamp for precise timing analysis.
/// This is a shared type that can be used across all platforms (unlike SerialRawBytesPayload).
#[derive(Clone, Serialize)]
pub struct RawBytesPayload {
    /// Bytes with individual timestamps
    pub bytes: Vec<TimestampedByte>,
    /// Source identifier (e.g., port name, "multi-source")
    pub source: String,
}
