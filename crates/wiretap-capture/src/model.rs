use serde::{Deserialize, Serialize};

/// What a capture holds: frames, or raw serial bytes not yet framed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum CaptureKind {
    Frames,
    Bytes,
}

impl CaptureKind {
    /// The stored name, which is also the serde one.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Frames => "frames",
            Self::Bytes => "bytes",
        }
    }

    /// Anything unrecognised reads as `Frames`, the column's historical default.
    pub fn from_stored(s: &str) -> Self {
        match s {
            "bytes" => Self::Bytes,
            _ => Self::Frames,
        }
    }
}

/// One raw serial byte.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct TimestampedByte {
    pub byte: u8,
    /// Microseconds since the epoch.
    pub timestamp_us: u64,
    #[serde(default)]
    pub bus: u8,
}

/// A capture's `capture_metadata` row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct CaptureMetadata {
    pub id: String,
    pub kind: CaptureKind,
    pub name: String,
    /// Frames or bytes, by `kind`.
    pub count: usize,
    pub start_time_us: Option<u64>,
    pub end_time_us: Option<u64>,
    /// Unix seconds.
    pub created_at: u64,
    /// The application's to set; not stored, so it loads as `false`.
    #[serde(default)]
    pub is_streaming: bool,
    /// `None` is orphaned, open to standalone use.
    #[serde(default)]
    pub owning_session_id: Option<String>,
    /// Survives a clear on start.
    #[serde(default)]
    pub persistent: bool,
    /// The distinct buses in the capture's data, sorted.
    #[serde(default)]
    pub buses: Vec<u8>,
}

/// One frame identity in a capture, `(protocol, frame_id)`, with its rollup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct CaptureFrameInfo {
    pub protocol: String,
    pub frame_id: u32,
    pub max_dlc: u16,
    pub bus: u8,
    pub is_extended: bool,
    pub has_dlc_mismatch: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Rx,
    /// Sent by this end, as the device or kernel handed it back.
    Tx,
}
