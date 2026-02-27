// Shared playback pacing constants for timeline readers (buffer, CSV, PostgreSQL).
//
// These values control how frames are batched and emitted during playback.
// Extracted here to ensure consistent behaviour across all timeline reader
// implementations.

/// Minimum number of frames to emit per batch during high-speed playback (>1x).
pub(super) const HIGH_SPEED_BATCH_SIZE: usize = 50;

/// Minimum inter-frame delay (ms) to avoid busy-spinning during paced playback.
pub(super) const MIN_DELAY_MS: f64 = 1.0;

/// Interval (ms) between forced batch emissions during paced playback.
pub(super) const PACING_INTERVAL_MS: u64 = 50;

/// Maximum frames to buffer per batch when playback speed is unlimited (0 / instant replay).
pub(super) const NO_LIMIT_BATCH_SIZE: usize = 1000;

/// Yield interval (ms) between batches during unlimited-speed playback.
pub(super) const NO_LIMIT_YIELD_MS: u64 = 10;
