//! A capture store in one SQLite file: frames or raw bytes per capture, with
//! their metadata and events.

mod events;
mod filter;
mod frames;
mod inventory;
mod model;
mod store;

pub use events::{CaptureEvent, CaptureEventPatch, NewCaptureEvent};
pub use filter::{CaptureProtocol, FrameRowFilter, Sql, SqlValue};
pub use frames::{FrameRecord, StoredFrame, STORED_LENGTH};
pub use inventory::inventory_statement;
pub use model::{CaptureFrameInfo, CaptureKind, CaptureMetadata, Direction, TimestampedByte};
pub use store::{
    chain, inventory_row, tuning, upgrade_legacy, Applied, Cancel, CaptureError, Result, Store,
};
