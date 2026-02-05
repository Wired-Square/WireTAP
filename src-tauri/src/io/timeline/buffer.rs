// ui/src-tauri/src/io/timeline/buffer.rs
//
// Buffer Reader - streams CAN data from the shared in-memory buffer.
// Used for replaying imported CSV files across all apps.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::AppHandle;

use super::base::{TimelineControl, TimelineReaderState};
use crate::io::{emit_frames, emit_to_session, FrameMessage, IOCapabilities, IODevice, IOState, PlaybackPosition};
use crate::buffer_store;

/// Sentinel value meaning "no seek requested"
const NO_SEEK: i64 = i64::MIN;
/// Sentinel value meaning "no frame seek requested"
const NO_SEEK_FRAME: i64 = -1;

/// Buffer Reader - streams frames from the shared memory buffer
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
        let buffer_id = if session_id.starts_with("buffer_") {
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
        // If the stream completed naturally, reset state so we can restart
        if self.completed_flag.load(Ordering::Relaxed) {
            self.reader_state.state = IOState::Stopped;
            self.completed_flag.store(false, Ordering::Relaxed);
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
        eprintln!(
            "[Buffer:{}] Seek requested to {}us",
            self.reader_state.session_id, timestamp_us
        );
        self.seek_target_us.store(timestamp_us, Ordering::Relaxed);
        Ok(())
    }

    fn seek_by_frame(&mut self, frame_index: i64) -> Result<(), String> {
        eprintln!(
            "[Buffer:{}] Seek by frame requested to index {}",
            self.reader_state.session_id, frame_index
        );
        self.seek_target_frame.store(frame_index, Ordering::Relaxed);
        Ok(())
    }

    fn set_direction(&mut self, reverse: bool) -> Result<(), String> {
        eprintln!(
            "[Buffer:{}] Direction set to {}",
            self.reader_state.session_id,
            if reverse { "reverse" } else { "forward" }
        );
        self.reader_state.control.set_reverse(reverse);
        Ok(())
    }

    fn state(&self) -> IOState {
        // If stream completed naturally, report as stopped so start() can be called to restart
        if self.completed_flag.load(Ordering::Relaxed) {
            return IOState::Stopped;
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

/// Build a snapshot of the most recent frame for each unique frame ID
/// up to and including the given index. This is used when seeking while paused
/// to show the decoder what the state would be at that point in time.
///
/// The algorithm walks backwards from the seek position, collecting frames until
/// we've seen all unique frame IDs that appear in the buffer, or we've walked
/// back far enough (limited by a time window to avoid excessive work).
fn build_snapshot(frames: &[FrameMessage], up_to_index: usize) -> Vec<FrameMessage> {
    if frames.is_empty() || up_to_index >= frames.len() {
        return Vec::new();
    }

    // First, find all unique frame IDs in the entire buffer
    let mut all_frame_ids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for f in frames.iter() {
        all_frame_ids.insert(f.frame_id);
    }

    // Now walk backwards from up_to_index, collecting the most recent instance of each frame ID
    let mut snapshot: HashMap<u32, FrameMessage> = HashMap::new();
    let target_time_us = frames[up_to_index].timestamp_us;

    // Walk backwards until we've found all frame IDs or hit the beginning
    // Limit how far back we look to avoid pathological cases
    let max_lookback_us: u64 = 120_000_000; // 2 minutes max lookback

    for i in (0..=up_to_index).rev() {
        let frame = &frames[i];

        // Stop if we've gone back too far in time
        if target_time_us > frame.timestamp_us
            && target_time_us - frame.timestamp_us > max_lookback_us
        {
            break;
        }

        // Only keep the first (most recent) occurrence of each frame ID
        snapshot.entry(frame.frame_id).or_insert_with(|| frame.clone());

        // Early exit if we've found all frame IDs
        if snapshot.len() == all_frame_ids.len() {
            break;
        }
    }

    // Convert to Vec, sorted by frame_id for consistent ordering
    let mut result: Vec<FrameMessage> = snapshot.into_values().collect();
    result.sort_by_key(|f| f.frame_id);
    result
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
    let frames = buffer_store::get_frames();
    if frames.is_empty() {
        return Err("Buffer is empty".to_string());
    }

    // Determine current index: use provided index, or find it from timestamp
    let current_idx = if let Some(idx) = current_frame_index {
        idx.min(frames.len().saturating_sub(1))
    } else if let Some(ts) = current_timestamp_us {
        // Find frame index from timestamp using binary search
        frames
            .binary_search_by(|f| (f.timestamp_us as i64).cmp(&ts))
            .unwrap_or_else(|i| i.min(frames.len().saturating_sub(1)))
    } else {
        // No position info - start from beginning or end depending on direction
        if backward { frames.len().saturating_sub(1) } else { 0 }
    };

    // Convert filter to a HashSet for fast lookup (if provided)
    let filter_set: Option<std::collections::HashSet<u32>> = filter_frame_ids.map(|ids| ids.iter().copied().collect());

    // Step through frames until we find one that matches the filter
    let new_idx = if backward {
        // Step backward, skipping frames that don't match the filter
        let mut idx = current_idx;
        loop {
            if idx == 0 {
                return Ok(None); // Already at the beginning
            }
            idx -= 1;
            // If no filter, or frame matches filter, we found our target
            if filter_set.as_ref().map_or(true, |set| set.contains(&frames[idx].frame_id)) {
                break;
            }
        }
        idx
    } else {
        // Step forward, skipping frames that don't match the filter
        let mut idx = current_idx;
        loop {
            if idx >= frames.len() - 1 {
                return Ok(None); // Already at the end
            }
            idx += 1;
            // If no filter, or frame matches filter, we found our target
            if filter_set.as_ref().map_or(true, |set| set.contains(&frames[idx].frame_id)) {
                break;
            }
        }
        idx
    };

    let frame = &frames[new_idx];
    let new_timestamp_us = frame.timestamp_us as i64;

    eprintln!(
        "[Buffer:{}] Step {} from frame {} to frame {} (timestamp {}us, frame_id=0x{:X})",
        session_id,
        if backward { "backward" } else { "forward" },
        current_idx,
        new_idx,
        new_timestamp_us,
        frame.frame_id
    );

    // Emit only the single stepped-to frame (not a full snapshot)
    emit_frames(app, session_id, vec![frame.clone()]);

    // Emit the new playback position
    emit_to_session(app, "playback-time", session_id, PlaybackPosition {
        timestamp_us: new_timestamp_us,
        frame_index: new_idx,
    });

    Ok(Some(StepResult {
        frame_index: new_idx,
        timestamp_us: new_timestamp_us,
    }))
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

async fn run_buffer_stream(
    app_handle: AppHandle,
    session_id: String,
    control: TimelineControl,
    seek_target_us: Arc<AtomicI64>,
    seek_target_frame: Arc<AtomicI64>,
    completed_flag: Arc<AtomicBool>,
    buffer_id: Option<String>,
) {
    // Get frames from the specific buffer (if ID provided) or the active buffer
    let frames = if let Some(ref id) = buffer_id {
        buffer_store::get_frames_by_id(id)
    } else {
        buffer_store::get_frames()
    };
    if frames.is_empty() {
        emit_to_session(
            &app_handle,
            "session-error",
            &session_id,
            "Buffer is empty".to_string(),
        );
        return;
    }

    let metadata = buffer_store::get_metadata();
    let initial_speed = control.read_speed();
    let initial_pacing = control.is_pacing_enabled();
    eprintln!(
        "[Buffer:{}] Starting stream (frames: {}, speed: {}x, pacing: {}, source: '{}')",
        session_id,
        frames.len(),
        initial_speed,
        initial_pacing,
        metadata.as_ref().map(|m| m.name.as_str()).unwrap_or("unknown")
    );

    // Streaming constants
    const HIGH_SPEED_BATCH_SIZE: usize = 50;
    const MIN_DELAY_MS: f64 = 1.0;
    const PACING_INTERVAL_MS: u64 = 50;
    const NO_LIMIT_BATCH_SIZE: usize = 1000;
    const NO_LIMIT_YIELD_MS: u64 = 10;

    let mut total_emitted = 0i64;
    let mut frame_index = 0usize;
    let mut total_wait_ms = 0u64;
    let mut wait_count = 0u64;

    // Get stream start time from first frame
    let stream_start_secs = frames
        .first()
        .map(|f| f.timestamp_us as f64 / 1_000_000.0)
        .unwrap_or(0.0);

    let mut last_frame_time_secs: Option<f64> = None;
    let mut batch_buffer: Vec<FrameMessage> = Vec::new();

    // Track wall-clock time vs playback time for proper pacing
    let mut wall_clock_baseline = std::time::Instant::now();
    let mut playback_baseline_secs = stream_start_secs;
    let mut last_speed = control.read_speed();
    let mut last_pacing_check = std::time::Instant::now();
    let mut last_reverse = control.is_reverse();

    eprintln!(
        "[Buffer:{}] Starting frame-by-frame loop (stream_start: {:.3}s, reverse: {})",
        session_id, stream_start_secs, last_reverse
    );

    // Loop condition: check bounds based on direction
    // Forward: frame_index < frames.len()
    // Reverse: frame_index > 0 (we decrement after processing, so we check > 0)
    // We use a unified loop that checks both conditions and exits appropriately
    loop {
        let is_reverse = control.is_reverse();

        // Check if we've reached the end (based on direction)
        let at_end = if is_reverse {
            frame_index == 0
        } else {
            frame_index >= frames.len()
        };

        if at_end {
            break;
        }
        // Check if cancelled
        if control.is_cancelled() {
            eprintln!(
                "[Buffer:{}] Stream cancelled, stopping immediately ({} remaining frames)",
                session_id,
                frames.len() - frame_index
            );
            break;
        }

        // Check for frame-based seek request FIRST (takes priority over timestamp seek)
        let seek_frame = seek_target_frame.load(Ordering::Relaxed);
        if seek_frame != NO_SEEK_FRAME {
            // Clear the seek request
            seek_target_frame.store(NO_SEEK_FRAME, Ordering::Relaxed);

            // Clamp to valid range
            let target_idx = (seek_frame as usize).min(frames.len().saturating_sub(1));

            let is_paused = control.is_paused();
            eprintln!(
                "[Buffer:{}] Seeking to frame {} (by index, paused={})",
                session_id, target_idx, is_paused
            );

            frame_index = target_idx;

            // Flush any pending batch
            if !batch_buffer.is_empty() {
                emit_to_session(
                    &app_handle,
                    "frame-message",
                    &session_id,
                    batch_buffer.clone(),
                );
                batch_buffer.clear();
            }

            // Reset timing baselines after seek
            if let Some(f) = frames.get(target_idx) {
                let seek_time_secs = f.timestamp_us as f64 / 1_000_000.0;
                playback_baseline_secs = seek_time_secs;
                wall_clock_baseline = std::time::Instant::now();
                last_frame_time_secs = None;

                // Emit the new playback position
                emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                    timestamp_us: f.timestamp_us as i64,
                    frame_index: target_idx,
                });

                // When paused, emit a snapshot of the most recent frame for each frame ID
                if is_paused {
                    let snapshot = build_snapshot(&frames, target_idx);
                    if !snapshot.is_empty() {
                        eprintln!(
                            "[Buffer:{}] Emitting snapshot of {} unique frames at seek position",
                            session_id,
                            snapshot.len()
                        );
                        emit_frames(&app_handle, &session_id, snapshot);
                    }
                }
            }

            continue;
        }

        // Check for timestamp-based seek request (fallback for backwards compatibility)
        let seek_target = seek_target_us.load(Ordering::Relaxed);
        if seek_target != NO_SEEK {
            // Clear the seek request
            seek_target_us.store(NO_SEEK, Ordering::Relaxed);

            // Binary search to find the frame closest to the target timestamp
            let target_idx = frames
                .binary_search_by(|f| (f.timestamp_us as i64).cmp(&seek_target))
                .unwrap_or_else(|i| i.min(frames.len().saturating_sub(1)));

            let is_paused = control.is_paused();
            eprintln!(
                "[Buffer:{}] Seeking to frame {} (timestamp {}us, paused={})",
                session_id, target_idx, seek_target, is_paused
            );

            frame_index = target_idx;

            // Flush any pending batch
            if !batch_buffer.is_empty() {
                emit_to_session(
                    &app_handle,
                    "frame-message",
                    &session_id,
                    batch_buffer.clone(),
                );
                batch_buffer.clear();
            }

            // Reset timing baselines after seek
            if let Some(f) = frames.get(target_idx) {
                let seek_time_secs = f.timestamp_us as f64 / 1_000_000.0;
                playback_baseline_secs = seek_time_secs;
                wall_clock_baseline = std::time::Instant::now();
                last_frame_time_secs = None;

                // Emit the new playback position
                emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                    timestamp_us: f.timestamp_us as i64,
                    frame_index: target_idx,
                });

                // When paused, emit a snapshot of the most recent frame for each frame ID
                // up to and including the seek position. This allows the decoder to show
                // the state at this point in time.
                if is_paused {
                    let snapshot = build_snapshot(&frames, target_idx);
                    if !snapshot.is_empty() {
                        eprintln!(
                            "[Buffer:{}] Emitting snapshot of {} unique frames at seek position",
                            session_id,
                            snapshot.len()
                        );
                        emit_frames(&app_handle, &session_id, snapshot);
                    }
                }
            }

            continue;
        }

        // Check if paused (after seek check so seek works while paused)
        if control.is_paused() {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }

        // Get current frame (for reverse, decrement first to get the frame at index-1)
        let actual_index = if is_reverse {
            frame_index - 1
        } else {
            frame_index
        };
        let frame = frames[actual_index].clone();

        // Update index for next iteration
        if is_reverse {
            frame_index = frame_index.saturating_sub(1);
        } else {
            frame_index += 1;
        }

        let is_pacing = control.is_pacing_enabled();
        let current_speed = control.read_speed();

        // Check for direction change and reset timing baseline
        if is_reverse != last_reverse {
            eprintln!(
                "[Buffer:{}] Direction changed to {}",
                session_id,
                if is_reverse { "reverse" } else { "forward" }
            );
            if let Some(last_time) = last_frame_time_secs {
                playback_baseline_secs = last_time;
                wall_clock_baseline = std::time::Instant::now();
            }
            last_reverse = is_reverse;
        }

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
                frame_index -= 1; // Re-process this frame after resume
                continue;
            }

            // Emit single frame with active listener filtering
            emit_frames(&app_handle, &session_id, vec![frame]);
            total_emitted += 1;

            emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                timestamp_us: playback_time_us,
                frame_index: actual_index,
            });
        }
    }

    // Emit any remaining frames in batch buffer with active listener filtering
    if !batch_buffer.is_empty() {
        emit_frames(&app_handle, &session_id, batch_buffer);
    }

    // Check if we completed naturally (not cancelled)
    let was_cancelled = control.is_cancelled();
    let reason = if was_cancelled { "stopped" } else { "complete" };

    if !was_cancelled {
        // Mark as completed so start() knows it can restart
        completed_flag.store(true, Ordering::Relaxed);
        // Emit stream-complete event so frontend knows playback finished
        emit_to_session(&app_handle, "stream-complete", &session_id, true);
    }

    // Calculate stats
    let total_wall_time_ms = wall_clock_baseline.elapsed().as_millis();
    let data_duration_secs = last_frame_time_secs.unwrap_or(stream_start_secs) - stream_start_secs;
    eprintln!(
        "[Buffer:{}] Stream ended (reason: {}, count: {}, wall_time: {}ms, data_duration: {:.1}s, waits: {} totaling {}ms)",
        session_id, reason, total_emitted, total_wall_time_ms, data_duration_secs, wait_count, total_wait_ms
    );
}
