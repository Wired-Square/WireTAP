// ui/src-tauri/src/io/timeline/buffer.rs
//
// Buffer Reader - streams CAN data from the SQLite-backed buffer store.
// Used for replaying imported CSV files across all apps.
// Reads frames in chunks from SQLite instead of loading everything into memory.

use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::AppHandle;

use super::base::{TimelineControl, TimelineReaderState};
use crate::io::{emit_frames, emit_to_session, FrameMessage, IOCapabilities, IODevice, IOState, PlaybackPosition};
use crate::{buffer_db, buffer_store};

/// Sentinel value meaning "no seek requested"
const NO_SEEK: i64 = i64::MIN;
/// Sentinel value meaning "no frame seek requested"
const NO_SEEK_FRAME: i64 = -1;

/// Buffer Reader - streams frames from the SQLite-backed buffer store
pub struct BufferReader {
    app: AppHandle,
    /// Common timeline reader state (control, state, session_id, task_handle)
    reader_state: TimelineReaderState,
    /// Seek target in microseconds. Set to NO_SEEK when no seek is pending.
    seek_target_us: Arc<AtomicI64>,
    /// Seek target as frame index. Set to NO_SEEK_FRAME when no seek is pending.
    /// Frame-based seek takes priority over timestamp-based seek.
    seek_target_frame: Arc<AtomicI64>,
    /// Set to true when the stream completes naturally (not cancelled)
    completed_flag: Arc<AtomicBool>,
    /// Buffer ID to read from (extracted from session_id for buffer_N patterns)
    buffer_id: Option<String>,
}

impl BufferReader {
    pub fn new(app: AppHandle, session_id: String, speed: f64) -> Self {
        // Extract buffer_id from session_id if it matches the buffer_N pattern
        let buffer_id = if session_id.starts_with("buf_") {
            Some(session_id.clone())
        } else {
            None
        };

        Self {
            app,
            reader_state: TimelineReaderState::new(session_id, speed),
            seek_target_us: Arc::new(AtomicI64::new(NO_SEEK)),
            seek_target_frame: Arc::new(AtomicI64::new(NO_SEEK_FRAME)),
            completed_flag: Arc::new(AtomicBool::new(false)),
            buffer_id,
        }
    }

    /// Create a BufferReader that reads from a specific buffer by ID.
    /// Use this when the session_id doesn't match the buffer_N pattern
    /// (e.g., for ingest sessions like "ingest_a7f3c9" that own a buffer).
    pub fn new_with_buffer(app: AppHandle, session_id: String, buffer_id: String, speed: f64) -> Self {
        Self {
            app,
            reader_state: TimelineReaderState::new(session_id, speed),
            seek_target_us: Arc::new(AtomicI64::new(NO_SEEK)),
            seek_target_frame: Arc::new(AtomicI64::new(NO_SEEK_FRAME)),
            completed_flag: Arc::new(AtomicBool::new(false)),
            buffer_id: Some(buffer_id),
        }
    }
}

#[async_trait]
impl IODevice for BufferReader {
    fn capabilities(&self) -> IOCapabilities {
        IOCapabilities::timeline_can().with_seek(true).with_reverse(true)
    }

    async fn start(&mut self) -> Result<(), String> {
        // If the stream completed naturally (paused at end), resume instead of restarting
        if self.completed_flag.load(Ordering::Relaxed) {
            return self.resume().await;
        }

        self.reader_state.check_can_start()?;

        // Check if buffer has data
        if !buffer_store::has_data() {
            return Err("No data in buffer. Please import a CSV file first.".to_string());
        }

        self.reader_state.prepare_start();

        let app = self.app.clone();
        let session_id = self.reader_state.session_id.clone();
        let control = self.reader_state.control.clone();
        let seek_target_us = self.seek_target_us.clone();
        let seek_target_frame = self.seek_target_frame.clone();
        let completed_flag = self.completed_flag.clone();
        let buffer_id = self.buffer_id.clone();

        let handle = spawn_buffer_stream(app, session_id, control, seek_target_us, seek_target_frame, completed_flag, buffer_id);
        self.reader_state.mark_running(handle);

        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.reader_state.stop().await;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        self.reader_state.pause()
    }

    async fn resume(&mut self) -> Result<(), String> {
        // If stream completed naturally (paused at end), clear the flag and resume
        if self.completed_flag.load(Ordering::Relaxed) {
            self.completed_flag.store(false, Ordering::Relaxed);
            self.reader_state.control.resume();
            self.reader_state.state = IOState::Running;
            return Ok(());
        }
        self.reader_state.resume()
    }

    fn set_speed(&mut self, speed: f64) -> Result<(), String> {
        self.reader_state.set_speed(speed, "Buffer")
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("Buffer reader does not support time range filtering".to_string())
    }

    fn seek(&mut self, timestamp_us: i64) -> Result<(), String> {
        tlog!(
            "[Buffer:{}] Seek requested to {}us",
            self.reader_state.session_id, timestamp_us
        );
        self.seek_target_us.store(timestamp_us, Ordering::Relaxed);
        Ok(())
    }

    fn seek_by_frame(&mut self, frame_index: i64) -> Result<(), String> {
        tlog!(
            "[Buffer:{}] Seek by frame requested to index {}",
            self.reader_state.session_id, frame_index
        );
        self.seek_target_frame.store(frame_index, Ordering::Relaxed);
        Ok(())
    }

    fn set_direction(&mut self, reverse: bool) -> Result<(), String> {
        tlog!(
            "[Buffer:{}] Direction set to {}",
            self.reader_state.session_id,
            if reverse { "reverse" } else { "forward" }
        );
        self.reader_state.control.set_reverse(reverse);
        Ok(())
    }

    fn state(&self) -> IOState {
        // If stream completed naturally, report as paused (stream stays alive at end position)
        if self.completed_flag.load(Ordering::Relaxed) {
            return IOState::Paused;
        }
        self.reader_state.state()
    }

    fn session_id(&self) -> &str {
        self.reader_state.session_id()
    }

    fn device_type(&self) -> &'static str {
        "buffer"
    }
}

/// Step one frame forward or backward from the given timestamp.
/// Returns the new timestamp after stepping, or None if at the boundary.
/// Also emits the frame and a snapshot via events.
/// Result of a step operation, containing both the new frame index and timestamp
#[derive(Debug, Clone, serde::Serialize)]
pub struct StepResult {
    pub frame_index: usize,
    pub timestamp_us: i64,
}

pub fn step_frame(
    app: &AppHandle,
    session_id: &str,
    current_frame_index: Option<usize>,
    current_timestamp_us: Option<i64>,
    backward: bool,
    filter_frame_ids: Option<&[u32]>,
) -> Result<Option<StepResult>, String> {
    let buf_id = buffer_store::find_frame_buffer_id()
        .ok_or_else(|| "No frame buffer found".to_string())?;

    let total_frames = buffer_store::get_buffer_count(&buf_id);
    if total_frames == 0 {
        return Err("Buffer is empty".to_string());
    }

    // Determine current rowid from frame index or timestamp
    let current_rowid = if let Some(idx) = current_frame_index {
        let clamped = idx.min(total_frames.saturating_sub(1));
        match buffer_db::get_frame_at_index(&buf_id, clamped)? {
            Some((rowid, _)) => rowid,
            None => return Err("Frame index out of bounds".to_string()),
        }
    } else if let Some(ts) = current_timestamp_us {
        match buffer_db::find_rowid_for_timestamp(&buf_id, ts as u64)? {
            Some(rowid) => rowid,
            None => {
                // Fallback to start or end
                let idx = if backward { total_frames.saturating_sub(1) } else { 0 };
                match buffer_db::get_frame_at_index(&buf_id, idx)? {
                    Some((rowid, _)) => rowid,
                    None => return Err("Buffer empty".to_string()),
                }
            }
        }
    } else {
        // No position info - start from beginning or end depending on direction
        let idx = if backward { total_frames.saturating_sub(1) } else { 0 };
        match buffer_db::get_frame_at_index(&buf_id, idx)? {
            Some((rowid, _)) => rowid,
            None => return Err("Buffer empty".to_string()),
        }
    };

    // Find next/prev frame using targeted SQLite query
    let filter = filter_frame_ids.unwrap_or(&[]);
    match buffer_db::get_next_filtered_frame(&buf_id, current_rowid, filter, backward)? {
        Some((_, new_idx, frame)) => {
            let new_timestamp_us = frame.timestamp_us as i64;

            tlog!(
                "[Buffer:{}] Step {} from rowid {} to frame {} (timestamp {}us, frame_id=0x{:X})",
                session_id,
                if backward { "backward" } else { "forward" },
                current_rowid,
                new_idx,
                new_timestamp_us,
                frame.frame_id
            );

            // Emit only the single stepped-to frame (not a full snapshot)
            emit_frames(app, session_id, vec![frame]);

            // Emit the new playback position
            emit_to_session(app, "playback-time", session_id, PlaybackPosition {
                timestamp_us: new_timestamp_us,
                frame_index: new_idx,
                frame_count: Some(total_frames),
            });

            Ok(Some(StepResult {
                frame_index: new_idx,
                timestamp_us: new_timestamp_us,
            }))
        }
        None => Ok(None), // At boundary
    }
}

/// Spawn a buffer reader task
fn spawn_buffer_stream(
    app_handle: AppHandle,
    session_id: String,
    control: TimelineControl,
    seek_target_us: Arc<AtomicI64>,
    seek_target_frame: Arc<AtomicI64>,
    completed_flag: Arc<AtomicBool>,
    buffer_id: Option<String>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        run_buffer_stream(app_handle, session_id, control, seek_target_us, seek_target_frame, completed_flag, buffer_id).await;
    })
}

/// Resolve the buffer ID to use for streaming.
fn resolve_buffer_id(buffer_id: &Option<String>) -> Option<String> {
    if let Some(id) = buffer_id {
        Some(id.clone())
    } else {
        buffer_store::find_frame_buffer_id()
    }
}

/// Load a chunk of frames from SQLite for the current playback direction.
fn load_chunk(
    buf_id: &str,
    boundary_rowid: i64,
    chunk_size: usize,
    reverse: bool,
) -> Vec<(i64, FrameMessage)> {
    let result = if reverse {
        buffer_db::read_frame_chunk_reverse(buf_id, boundary_rowid, chunk_size)
    } else {
        buffer_db::read_frame_chunk(buf_id, boundary_rowid, chunk_size)
    };
    result.unwrap_or_default()
}

/// Handle a seek operation (frame-based or timestamp-based).
/// Returns true if a seek was handled.
fn handle_seek(
    app_handle: &AppHandle,
    session_id: &str,
    buf_id: &str,
    total_frames: usize,
    seek_target_frame: &AtomicI64,
    seek_target_us: &AtomicI64,
    control: &TimelineControl,
    chunk: &mut Vec<(i64, FrameMessage)>,
    chunk_idx: &mut usize,
    frame_index: &mut usize,
    last_consumed_rowid: &mut i64,
    batch_buffer: &mut Vec<FrameMessage>,
    playback_baseline_secs: &mut f64,
    wall_clock_baseline: &mut std::time::Instant,
    last_frame_time_secs: &mut Option<f64>,
) -> bool {
    // Check for frame-based seek (takes priority)
    let seek_frame = seek_target_frame.load(Ordering::Relaxed);
    if seek_frame != NO_SEEK_FRAME {
        seek_target_frame.store(NO_SEEK_FRAME, Ordering::Relaxed);
        let target_idx = (seek_frame as usize).min(total_frames.saturating_sub(1));
        let is_paused = control.is_paused();

        tlog!(
            "[Buffer:{}] Seeking to frame {} (by index, paused={})",
            session_id, target_idx, is_paused
        );

        if let Ok(Some((rowid, frame))) = buffer_db::get_frame_at_index(buf_id, target_idx) {
            let is_reverse = control.is_reverse();
            // In reverse mode, the main loop pre-decrements before capturing actual_index,
            // so set frame_index one higher so pre-decrement yields target_idx.
            *frame_index = if is_reverse { target_idx + 1 } else { target_idx };
            *last_consumed_rowid = rowid;

            // Reload chunk from seek position
            *chunk = load_chunk(buf_id, if is_reverse { rowid + 1 } else { rowid - 1 }, 2000, is_reverse);
            *chunk_idx = 0;

            // Flush pending batch
            if !batch_buffer.is_empty() {
                emit_to_session(app_handle, "frame-message", session_id, batch_buffer.clone());
                batch_buffer.clear();
            }

            // Reset timing baselines
            let seek_time_secs = frame.timestamp_us as f64 / 1_000_000.0;
            *playback_baseline_secs = seek_time_secs;
            *wall_clock_baseline = std::time::Instant::now();
            *last_frame_time_secs = None;

            emit_to_session(app_handle, "playback-time", session_id, PlaybackPosition {
                timestamp_us: frame.timestamp_us as i64,
                frame_index: target_idx,
                frame_count: Some(total_frames),
            });

            // When paused, emit a snapshot of the most recent frame for each frame ID
            if is_paused {
                let min_ts = frame.timestamp_us.saturating_sub(120_000_000);
                if let Ok(snapshot) = buffer_db::build_snapshot(buf_id, rowid, min_ts) {
                    if !snapshot.is_empty() {
                        tlog!(
                            "[Buffer:{}] Emitting snapshot of {} unique frames at seek position",
                            session_id, snapshot.len()
                        );
                        emit_frames(app_handle, session_id, snapshot);
                    }
                }
            }
        }

        return true;
    }

    // Check for timestamp-based seek
    let seek_target = seek_target_us.load(Ordering::Relaxed);
    if seek_target != NO_SEEK {
        seek_target_us.store(NO_SEEK, Ordering::Relaxed);
        let is_paused = control.is_paused();

        if let Ok(Some(rowid)) = buffer_db::find_rowid_for_timestamp(buf_id, seek_target as u64) {
            // Compute 0-based frame index for this rowid
            let target_idx = buffer_db::count_frames_before_rowid(buf_id, rowid).unwrap_or(0);

            tlog!(
                "[Buffer:{}] Seeking to frame {} (timestamp {}us, paused={})",
                session_id, target_idx, seek_target, is_paused
            );

            let is_reverse = control.is_reverse();
            // In reverse mode, the main loop pre-decrements before capturing actual_index,
            // so set frame_index one higher so pre-decrement yields target_idx.
            *frame_index = if is_reverse { target_idx + 1 } else { target_idx };
            *last_consumed_rowid = rowid;

            // Reload chunk from seek position
            *chunk = load_chunk(buf_id, if is_reverse { rowid + 1 } else { rowid - 1 }, 2000, is_reverse);
            *chunk_idx = 0;

            // Flush pending batch
            if !batch_buffer.is_empty() {
                emit_to_session(app_handle, "frame-message", session_id, batch_buffer.clone());
                batch_buffer.clear();
            }

            // Get frame at this rowid for timing info
            if let Some((_, ref frame)) = chunk.first() {
                let seek_time_secs = frame.timestamp_us as f64 / 1_000_000.0;
                *playback_baseline_secs = seek_time_secs;
                *wall_clock_baseline = std::time::Instant::now();
                *last_frame_time_secs = None;

                emit_to_session(app_handle, "playback-time", session_id, PlaybackPosition {
                    timestamp_us: frame.timestamp_us as i64,
                    frame_index: target_idx,
                    frame_count: Some(total_frames),
                });

                if is_paused {
                    let min_ts = frame.timestamp_us.saturating_sub(120_000_000);
                    if let Ok(snapshot) = buffer_db::build_snapshot(buf_id, rowid, min_ts) {
                        if !snapshot.is_empty() {
                            tlog!(
                                "[Buffer:{}] Emitting snapshot of {} unique frames at seek position",
                                session_id, snapshot.len()
                            );
                            emit_frames(app_handle, session_id, snapshot);
                        }
                    }
                }
            }
        }

        return true;
    }

    false
}

async fn run_buffer_stream(
    app_handle: AppHandle,
    session_id: String,
    control: TimelineControl,
    seek_target_us: Arc<AtomicI64>,
    seek_target_frame: Arc<AtomicI64>,
    completed_flag: Arc<AtomicBool>,
    buffer_id: Option<String>,
) {
    // Resolve which buffer to read from
    let buf_id = match resolve_buffer_id(&buffer_id) {
        Some(id) => id,
        None => {
            emit_to_session(
                &app_handle,
                "session-error",
                &session_id,
                "No frame buffer found".to_string(),
            );
            return;
        }
    };

    let total_frames = buffer_store::get_buffer_count(&buf_id);
    if total_frames == 0 {
        emit_to_session(
            &app_handle,
            "session-error",
            &session_id,
            "Buffer is empty".to_string(),
        );
        return;
    }

    let (min_rowid, max_rowid) = match buffer_db::get_rowid_range(&buf_id) {
        Ok(Some(range)) => range,
        _ => {
            emit_to_session(
                &app_handle,
                "session-error",
                &session_id,
                "Buffer has no data".to_string(),
            );
            return;
        }
    };

    let metadata = buffer_store::get_metadata();
    let initial_speed = control.read_speed();
    let initial_pacing = control.is_pacing_enabled();
    tlog!(
        "[Buffer:{}] Starting stream (frames: {}, speed: {}x, pacing: {}, source: '{}')",
        session_id,
        total_frames,
        initial_speed,
        initial_pacing,
        metadata.as_ref().map(|m| m.name.as_str()).unwrap_or("unknown")
    );

    // Streaming constants
    const CHUNK_SIZE: usize = 2000;
    const HIGH_SPEED_BATCH_SIZE: usize = 50;
    const MIN_DELAY_MS: f64 = 1.0;
    const PACING_INTERVAL_MS: u64 = 50;
    const NO_LIMIT_BATCH_SIZE: usize = 1000;
    const NO_LIMIT_YIELD_MS: u64 = 10;

    let mut total_emitted = 0i64;
    let mut frame_index = 0usize;
    let mut total_wait_ms = 0u64;
    let mut wait_count = 0u64;

    // Chunk state - frames loaded from SQLite
    let mut chunk: Vec<(i64, FrameMessage)> = load_chunk(&buf_id, min_rowid - 1, CHUNK_SIZE, false);
    let mut chunk_idx: usize = 0;
    let mut last_consumed_rowid: i64 = min_rowid - 1;
    if chunk.is_empty() {
        emit_to_session(
            &app_handle,
            "session-error",
            &session_id,
            "Buffer is empty".to_string(),
        );
        return;
    }

    // Get stream start time from first frame
    let stream_start_secs = chunk[0].1.timestamp_us as f64 / 1_000_000.0;

    let mut last_frame_time_secs: Option<f64> = None;
    let mut batch_buffer: Vec<FrameMessage> = Vec::new();

    // Track wall-clock time vs playback time for proper pacing
    let mut wall_clock_baseline = std::time::Instant::now();
    let mut playback_baseline_secs = stream_start_secs;
    let mut last_speed = control.read_speed();
    let mut last_pacing_check = std::time::Instant::now();
    let mut last_reverse = control.is_reverse();

    tlog!(
        "[Buffer:{}] Starting frame-by-frame loop (stream_start: {:.3}s, reverse: {})",
        session_id, stream_start_secs, last_reverse
    );

    'outer: loop {
    loop {
        // Check if cancelled
        if control.is_cancelled() {
            tlog!(
                "[Buffer:{}] Stream cancelled, stopping immediately",
                session_id
            );
            break 'outer;
        }

        // Handle seek requests (frame-based and timestamp-based)
        if handle_seek(
            &app_handle, &session_id, &buf_id, total_frames,
            &seek_target_frame, &seek_target_us, &control,
            &mut chunk, &mut chunk_idx, &mut frame_index, &mut last_consumed_rowid,
            &mut batch_buffer, &mut playback_baseline_secs, &mut wall_clock_baseline,
            &mut last_frame_time_secs,
        ) {
            continue;
        }

        // Check if paused (after seek check so seek works while paused)
        if control.is_paused() {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }

        let is_reverse = control.is_reverse();

        // Handle direction change: reload chunk from current position
        if is_reverse != last_reverse {
            tlog!(
                "[Buffer:{}] Direction changed to {}",
                session_id,
                if is_reverse { "reverse" } else { "forward" }
            );

            // Adjust frame_index for the direction change:
            // - After forward: frame_index is one-past-last-consumed (post-increment convention)
            // - After reverse: frame_index is at-last-consumed (pre-decrement convention)
            // Compensate so the first frame in the new direction gets the correct index.
            if is_reverse {
                frame_index = frame_index.saturating_sub(1);
            } else {
                frame_index += 1;
            }

            // Reload chunk from the last consumed position in the new direction
            chunk = load_chunk(
                &buf_id,
                last_consumed_rowid,
                CHUNK_SIZE,
                is_reverse,
            );
            chunk_idx = 0;

            // Reset timing baseline
            if let Some(last_time) = last_frame_time_secs {
                playback_baseline_secs = last_time;
                wall_clock_baseline = std::time::Instant::now();
            }
            last_reverse = is_reverse;
        }

        // Load next chunk if current one is exhausted
        if chunk_idx >= chunk.len() {
            let boundary = if is_reverse {
                // In reverse, chunk is in DESC order — last element has the smallest rowid
                chunk.last().map(|(r, _)| *r).unwrap_or(min_rowid)
            } else {
                // In forward, chunk is in ASC order — last element has the largest rowid
                chunk.last().map(|(r, _)| *r).unwrap_or(max_rowid)
            };
            chunk = load_chunk(&buf_id, boundary, CHUNK_SIZE, is_reverse);
            chunk_idx = 0;

            if chunk.is_empty() {
                break; // End of buffer
            }
        }

        // Get current frame from chunk
        let (rowid, frame) = chunk[chunk_idx].clone();
        chunk_idx += 1;
        last_consumed_rowid = rowid;

        // Pre-decrement for reverse so actual_index reflects the correct buffer position.
        // Forward: actual_index = frame_index (then post-increment for next frame).
        // Reverse: decrement first (backing up to this frame's position), then capture.
        if is_reverse {
            frame_index = frame_index.saturating_sub(1);
        }
        let actual_index = frame_index;
        if !is_reverse {
            frame_index += 1;
        }

        let is_pacing = control.is_pacing_enabled();
        let current_speed = control.read_speed();

        // Check for speed change and reset timing baseline
        if is_pacing && (current_speed - last_speed).abs() > 0.001 {
            if let Some(last_time) = last_frame_time_secs {
                playback_baseline_secs = last_time;
                wall_clock_baseline = std::time::Instant::now();
            }
            last_speed = current_speed;
        }

        // Proactive pacing check (use absolute elapsed time for reverse support)
        if is_pacing {
            if let Some(last_time) = last_frame_time_secs {
                let playback_elapsed_secs = (last_time - playback_baseline_secs).abs();
                let expected_wall_time_ms = (playback_elapsed_secs * 1000.0 / current_speed) as u64;
                let actual_wall_time_ms = wall_clock_baseline.elapsed().as_millis() as u64;

                if expected_wall_time_ms > actual_wall_time_ms + 100 {
                    let wait_ms = expected_wall_time_ms - actual_wall_time_ms;
                    let capped_wait = wait_ms.min(500);
                    total_wait_ms += capped_wait;
                    wait_count += 1;
                    tokio::time::sleep(Duration::from_millis(capped_wait)).await;
                }
            }
        }

        let frame_time_secs = frame.timestamp_us as f64 / 1_000_000.0;
        let playback_time_us = (frame_time_secs * 1_000_000.0) as i64;

        // When pacing is disabled, use maximum batch size
        if !is_pacing {
            batch_buffer.push(frame);
            total_emitted += 1;
            last_frame_time_secs = Some(frame_time_secs);

            if batch_buffer.len() >= NO_LIMIT_BATCH_SIZE {
                emit_frames(&app_handle, &session_id, batch_buffer.clone());
                batch_buffer.clear();

                emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: actual_index,
                    frame_count: Some(total_frames),
                });

                tokio::time::sleep(Duration::from_millis(NO_LIMIT_YIELD_MS)).await;
            }
            continue;
        }

        // Calculate delay based on inter-frame timing (pacing enabled)
        // Use absolute delta for reverse playback support
        let delay_ms = if let Some(last_time) = last_frame_time_secs {
            let delta_secs = (frame_time_secs - last_time).abs();
            (delta_secs * 1000.0 / current_speed).max(0.0)
        } else {
            0.0
        };

        last_frame_time_secs = Some(frame_time_secs);

        if delay_ms < MIN_DELAY_MS {
            // High-speed mode: batch frames
            batch_buffer.push(frame);
            total_emitted += 1;

            let time_since_pacing = last_pacing_check.elapsed().as_millis() as u64;
            let should_emit = batch_buffer.len() >= HIGH_SPEED_BATCH_SIZE
                || time_since_pacing >= PACING_INTERVAL_MS;

            if should_emit && !batch_buffer.is_empty() {
                let playback_elapsed_secs = (frame_time_secs - playback_baseline_secs).abs();
                let expected_wall_time_ms = (playback_elapsed_secs * 1000.0 / current_speed) as u64;
                let actual_wall_time_ms = wall_clock_baseline.elapsed().as_millis() as u64;

                if expected_wall_time_ms > actual_wall_time_ms {
                    let wait_ms = expected_wall_time_ms - actual_wall_time_ms;
                    if wait_ms > 0 {
                        let capped_wait = wait_ms.min(1000);
                        total_wait_ms += capped_wait;
                        wait_count += 1;
                        tokio::time::sleep(Duration::from_millis(capped_wait)).await;
                    }
                }

                last_pacing_check = std::time::Instant::now();

                emit_frames(&app_handle, &session_id, batch_buffer.clone());
                batch_buffer.clear();

                emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: actual_index,
                    frame_count: Some(total_frames),
                });

                tokio::task::yield_now().await;
            }
        } else {
            // Normal speed: emit any pending batch first
            if !batch_buffer.is_empty() {
                emit_frames(&app_handle, &session_id, batch_buffer.clone());
                batch_buffer.clear();
            }

            // Sleep for inter-frame delay (cap at 10 seconds)
            let capped_delay_ms = delay_ms.min(10000.0);
            if capped_delay_ms >= 1.0 {
                total_wait_ms += capped_delay_ms as u64;
                wait_count += 1;
                tokio::time::sleep(Duration::from_millis(capped_delay_ms as u64)).await;
            }

            // Re-check pause after sleeping
            if control.is_paused() {
                chunk_idx -= 1; // Re-process this frame after resume
                // Undo the frame_index update so re-processing gets the correct index
                if is_reverse { frame_index += 1; } else { frame_index -= 1; }
                continue;
            }

            // Emit single frame
            emit_frames(&app_handle, &session_id, vec![frame]);
            total_emitted += 1;

            emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                timestamp_us: playback_time_us,
                frame_index: actual_index,
                frame_count: Some(total_frames),
            });
        }
    }

    // Emit any remaining frames in batch buffer
    if !batch_buffer.is_empty() {
        emit_frames(&app_handle, &session_id, batch_buffer.clone());
        batch_buffer.clear();

        // Emit final position so frontend highlights the last frame.
        // Forward: frame_index is one-past-end (post-increment), subtract 1.
        // Reverse: frame_index IS the last consumed position (pre-decrement), use directly.
        if let Some(last_time) = last_frame_time_secs {
            let is_reverse = control.is_reverse();
            let final_index = if is_reverse { frame_index } else { frame_index.saturating_sub(1) };
            let playback_time_us = (last_time * 1_000_000.0) as i64;
            emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                timestamp_us: playback_time_us,
                frame_index: final_index,
                frame_count: Some(total_frames),
            });
        }
    }

    // If cancelled, exit the outer loop entirely
    if control.is_cancelled() {
        break;
    }

    // Natural completion — pause at end position instead of stopping.
    // This keeps the stream task alive so step/seek/resume work after playback ends.
    completed_flag.store(true, Ordering::Relaxed);
    control.pause();
    emit_to_session(&app_handle, "stream-complete", &session_id, "paused".to_string());
    let final_pos = if control.is_reverse() { frame_index } else { frame_index.saturating_sub(1) };
    tlog!(
        "[Buffer:{}] Stream reached end of data, pausing at final position (frame_index: {})",
        session_id, final_pos
    );

    // Post-completion pause-wait loop: stay alive for step/seek/resume
    loop {
        if control.is_cancelled() {
            break 'outer;
        }

        // Handle seek requests while paused at end
        if handle_seek(
            &app_handle, &session_id, &buf_id, total_frames,
            &seek_target_frame, &seek_target_us, &control,
            &mut chunk, &mut chunk_idx, &mut frame_index, &mut last_consumed_rowid,
            &mut batch_buffer, &mut playback_baseline_secs, &mut wall_clock_baseline,
            &mut last_frame_time_secs,
        ) {
            continue;
        }

        if control.is_paused() {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }

        // Resumed — reload chunk from current position and re-enter main loop
        let is_reverse = control.is_reverse();

        // Adjust frame_index if direction changed during post-completion pause
        if is_reverse != last_reverse {
            if is_reverse {
                frame_index = frame_index.saturating_sub(1);
            } else {
                frame_index += 1;
            }
        }

        chunk = load_chunk(&buf_id, last_consumed_rowid, CHUNK_SIZE, is_reverse);
        chunk_idx = 0;

        if chunk.is_empty() {
            // Still at boundary in this direction, re-pause
            control.pause();
            completed_flag.store(true, Ordering::Relaxed);
            continue;
        }

        // Reset timing baselines for resumed playback
        wall_clock_baseline = std::time::Instant::now();
        if let Some(last_time) = last_frame_time_secs {
            playback_baseline_secs = last_time;
        }
        last_reverse = is_reverse;
        last_speed = control.read_speed();
        tlog!("[Buffer:{}] Resuming playback from post-completion pause", session_id);
        break; // Break post-completion loop → re-enter main streaming via 'outer
    }
    } // end 'outer

    // Calculate stats
    let total_wall_time_ms = wall_clock_baseline.elapsed().as_millis();
    let data_duration_secs = last_frame_time_secs.unwrap_or(stream_start_secs) - stream_start_secs;
    tlog!(
        "[Buffer:{}] Stream ended (reason: stopped, count: {}, wall_time: {}ms, data_duration: {:.1}s, waits: {} totaling {}ms)",
        session_id, total_emitted, total_wall_time_ms, data_duration_secs, wait_count, total_wait_ms
    );
}
