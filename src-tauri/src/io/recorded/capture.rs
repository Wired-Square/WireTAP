// ui/src-tauri/src/io/recorded/capture.rs
//
// Capture Source - streams CAN data from the SQLite-backed capture store.
// Used for replaying imported CSV files across all apps.
// Reads frames in chunks from SQLite instead of loading everything into memory.

use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::AppHandle;

use super::base::{PlaybackControl, RecordedSourceState};
use crate::io::{emit_session_error, post_session, signal_frames_ready, signal_playback_position, FrameMessage, IOCapabilities, IOSource, IOState, PlaybackPosition, SignalThrottle, TemporalMode};
use crate::{capture_db, capture_store};

/// Sentinel value meaning "no seek requested"
const NO_SEEK: i64 = i64::MIN;
/// Sentinel value meaning "no frame seek requested"
const NO_SEEK_FRAME: i64 = -1;

/// Capture Source - streams frames from the SQLite-backed capture store
pub struct CaptureSource {
    app: AppHandle,
    /// Common recorded source state (control, state, session_id, task_handle)
    reader_state: RecordedSourceState,
    /// Seek target in microseconds. Set to NO_SEEK when no seek is pending.
    seek_target_us: Arc<AtomicI64>,
    /// Seek target as frame index. Set to NO_SEEK_FRAME when no seek is pending.
    /// Frame-based seek takes priority over timestamp-based seek.
    seek_target_frame: Arc<AtomicI64>,
    /// Set to true when the stream completes naturally (not cancelled)
    completed_flag: Arc<AtomicBool>,
    /// Capture ID to read from
    capture_id: Option<String>,
    /// Available buses in this capture (from metadata)
    buses: Vec<u8>,
}

impl CaptureSource {
    pub fn new(app: AppHandle, session_id: String, capture_id: String, speed: f64) -> Self {
        let buses = capture_store::get_capture_metadata(&capture_id)
            .map(|m| m.buses)
            .unwrap_or_default();

        // Bind the capture to this session so WS frame dispatch
        // (send_new_frames) can locate it via get_session_frame_capture_id.
        // Without this, no FrameData is broadcast and apps that rely on the
        // onFrames callback (Decoder, etc.) see nothing while playback runs.
        // Ownership is released by orphan_captures_for_session on session destroy.
        if let Err(e) = capture_store::set_capture_owner(&capture_id, &session_id) {
            tlog!(
                "[CaptureSource] Failed to set capture owner for '{}' on session '{}': {}",
                capture_id, session_id, e
            );
        }

        Self {
            app,
            reader_state: RecordedSourceState::new(session_id, speed),
            seek_target_us: Arc::new(AtomicI64::new(NO_SEEK)),
            seek_target_frame: Arc::new(AtomicI64::new(NO_SEEK_FRAME)),
            completed_flag: Arc::new(AtomicBool::new(false)),
            capture_id: Some(capture_id),
            buses,
        }
    }
}

#[async_trait]
impl IOSource for CaptureSource {
    fn capabilities(&self) -> IOCapabilities {
        IOCapabilities::recorded_can()
            .with_temporal_mode(TemporalMode::Capture)
            .with_seek(true)
            .with_reverse(true)
            .with_buses(self.buses.clone())
    }

    async fn start(&mut self) -> Result<(), String> {
        // If the stream completed naturally (paused at end), resume instead of restarting
        if self.completed_flag.load(Ordering::Relaxed) {
            return self.resume().await;
        }

        self.reader_state.check_can_start()?;

        // Check if capture has data
        if !capture_store::has_any_data() {
            return Err("No data in capture. Please import a CSV file first.".to_string());
        }

        self.reader_state.prepare_start();

        let app = self.app.clone();
        let session_id = self.reader_state.session_id.clone();
        let control = self.reader_state.control.clone();
        let seek_target_us = self.seek_target_us.clone();
        let seek_target_frame = self.seek_target_frame.clone();
        let completed_flag = self.completed_flag.clone();
        let capture_id = self.capture_id.clone();

        let handle = spawn_capture_stream(app, session_id, control, seek_target_us, seek_target_frame, completed_flag, capture_id);
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
        self.reader_state.set_speed(speed, "Capture")
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("Capture source does not support time range filtering".to_string())
    }

    fn seek(&mut self, timestamp_us: i64) -> Result<(), String> {
        tlog!(
            "[Capture:{}] Seek requested to {}us",
            self.reader_state.session_id, timestamp_us
        );
        self.seek_target_us.store(timestamp_us, Ordering::Relaxed);
        Ok(())
    }

    fn seek_by_frame(&mut self, frame_index: i64) -> Result<(), String> {
        tlog!(
            "[Capture:{}] Seek by frame requested to index {}",
            self.reader_state.session_id, frame_index
        );
        self.seek_target_frame.store(frame_index, Ordering::Relaxed);
        Ok(())
    }

    fn set_direction(&mut self, reverse: bool) -> Result<(), String> {
        tlog!(
            "[Capture:{}] Direction set to {}",
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

    fn source_type(&self) -> &'static str {
        "capture"
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
    _app: &AppHandle,
    session_id: &str,
    capture_id: &str,
    current_frame_index: Option<usize>,
    current_timestamp_us: Option<i64>,
    backward: bool,
    filter_frame_ids: Option<&[u32]>,
) -> Result<Option<StepResult>, String> {
    let buf_id = capture_id;

    let total_frames = capture_store::get_capture_count(&buf_id);
    if total_frames == 0 {
        return Err("Capture is empty".to_string());
    }

    // Determine current rowid from frame index or timestamp
    let current_rowid = if let Some(idx) = current_frame_index {
        let clamped = idx.min(total_frames.saturating_sub(1));
        match capture_db::get_frame_at_index(&buf_id, clamped)? {
            Some((rowid, _)) => rowid,
            None => return Err("Frame index out of bounds".to_string()),
        }
    } else if let Some(ts) = current_timestamp_us {
        match capture_db::find_rowid_for_timestamp(&buf_id, ts as u64)? {
            Some(rowid) => rowid,
            None => {
                // Fallback to start or end
                let idx = if backward { total_frames.saturating_sub(1) } else { 0 };
                match capture_db::get_frame_at_index(&buf_id, idx)? {
                    Some((rowid, _)) => rowid,
                    None => return Err("Capture empty".to_string()),
                }
            }
        }
    } else {
        // No position info - start from beginning or end depending on direction
        let idx = if backward { total_frames.saturating_sub(1) } else { 0 };
        match capture_db::get_frame_at_index(&buf_id, idx)? {
            Some((rowid, _)) => rowid,
            None => return Err("Capture empty".to_string()),
        }
    };

    // Find next/prev frame using targeted SQLite query
    let filter = filter_frame_ids.unwrap_or(&[]);
    match capture_db::get_next_filtered_frame(&buf_id, current_rowid, filter, backward)? {
        Some((_, new_idx, frame)) => {
            let new_timestamp_us = frame.timestamp_us as i64;

            tlog!(
                "[Capture:{}] Step {} from rowid {} to frame {} (timestamp {}us, frame_id=0x{:X})",
                session_id,
                if backward { "backward" } else { "forward" },
                current_rowid,
                new_idx,
                new_timestamp_us,
                frame.frame_id
            );

            // Signal that frames are available (step is a seek-like operation)
            signal_frames_ready(session_id);

            // Store and signal playback position (seek — always signal immediately)
            let position = PlaybackPosition {
                timestamp_us: new_timestamp_us,
                frame_index: new_idx,
                frame_count: Some(total_frames),
            };
            crate::io::store_playback_position(session_id, position);
            signal_playback_position(session_id);

            Ok(Some(StepResult {
                frame_index: new_idx,
                timestamp_us: new_timestamp_us,
            }))
        }
        None => Ok(None), // At boundary
    }
}

/// Spawn a capture stream task
fn spawn_capture_stream(
    app_handle: AppHandle,
    session_id: String,
    control: PlaybackControl,
    seek_target_us: Arc<AtomicI64>,
    seek_target_frame: Arc<AtomicI64>,
    completed_flag: Arc<AtomicBool>,
    capture_id: Option<String>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        run_capture_stream(app_handle, session_id, control, seek_target_us, seek_target_frame, completed_flag, capture_id).await;
    })
}

/// Resolve the capture ID to use for streaming.
fn resolve_capture_id(capture_id: &Option<String>) -> Option<String> {
    capture_id.clone()
}

/// Load a chunk of frames from SQLite for the current playback direction.
fn load_chunk(
    buf_id: &str,
    boundary_rowid: i64,
    chunk_size: usize,
    reverse: bool,
) -> Vec<(i64, FrameMessage)> {
    let result = if reverse {
        capture_db::read_frame_chunk_reverse(buf_id, boundary_rowid, chunk_size)
    } else {
        capture_db::read_frame_chunk(buf_id, boundary_rowid, chunk_size)
    };
    result.unwrap_or_default()
}

/// Handle a seek operation (frame-based or timestamp-based).
/// Returns true if a seek was handled.
fn handle_seek(
    _app_handle: &AppHandle,
    session_id: &str,
    buf_id: &str,
    total_frames: usize,
    seek_target_frame: &AtomicI64,
    seek_target_us: &AtomicI64,
    control: &PlaybackControl,
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
            "[Capture:{}] Seeking to frame {} (by index, paused={})",
            session_id, target_idx, is_paused
        );

        if let Ok(Some((rowid, frame))) = capture_db::get_frame_at_index(buf_id, target_idx) {
            let is_reverse = control.is_reverse();
            // In reverse mode, the main loop pre-decrements before capturing actual_index,
            // so set frame_index one higher so pre-decrement yields target_idx.
            *frame_index = if is_reverse { target_idx + 1 } else { target_idx };
            *last_consumed_rowid = rowid;

            // Reload chunk from seek position
            *chunk = load_chunk(buf_id, if is_reverse { rowid + 1 } else { rowid - 1 }, 2000, is_reverse);
            *chunk_idx = 0;

            // Discard pending batch
            batch_buffer.clear();

            // Reset timing baselines
            let seek_time_secs = frame.timestamp_us as f64 / 1_000_000.0;
            *playback_baseline_secs = seek_time_secs;
            *wall_clock_baseline = std::time::Instant::now();
            *last_frame_time_secs = None;

            // Store and signal playback position (seek — always signal immediately)
            let position = PlaybackPosition {
                timestamp_us: frame.timestamp_us as i64,
                frame_index: target_idx,
                frame_count: Some(total_frames),
            };
            crate::io::store_playback_position(session_id, position);
            signal_playback_position(session_id);

            // Signal frontend to fetch current state from capture
            signal_frames_ready(session_id);
        }

        return true;
    }

    // Check for timestamp-based seek
    let seek_target = seek_target_us.load(Ordering::Relaxed);
    if seek_target != NO_SEEK {
        seek_target_us.store(NO_SEEK, Ordering::Relaxed);
        let is_paused = control.is_paused();

        if let Ok(Some(rowid)) = capture_db::find_rowid_for_timestamp(buf_id, seek_target as u64) {
            // Compute 0-based frame index for this rowid
            let target_idx = capture_db::count_frames_before_rowid(buf_id, rowid).unwrap_or(0);

            tlog!(
                "[Capture:{}] Seeking to frame {} (timestamp {}us, paused={})",
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

            // Discard pending batch
            batch_buffer.clear();

            // Get frame at this rowid for timing info
            if let Some((_, ref frame)) = chunk.first() {
                let seek_time_secs = frame.timestamp_us as f64 / 1_000_000.0;
                *playback_baseline_secs = seek_time_secs;
                *wall_clock_baseline = std::time::Instant::now();
                *last_frame_time_secs = None;

                // Store and signal playback position (seek — always signal immediately)
                let position = PlaybackPosition {
                    timestamp_us: frame.timestamp_us as i64,
                    frame_index: target_idx,
                    frame_count: Some(total_frames),
                };
                crate::io::store_playback_position(session_id, position);
                signal_playback_position(session_id);
            }

            // Signal frontend to fetch current state from capture
            signal_frames_ready(session_id);
        }

        return true;
    }

    false
}

async fn run_capture_stream(
    app_handle: AppHandle,
    session_id: String,
    control: PlaybackControl,
    seek_target_us: Arc<AtomicI64>,
    seek_target_frame: Arc<AtomicI64>,
    completed_flag: Arc<AtomicBool>,
    capture_id: Option<String>,
) {
    // Resolve which capture to read from
    let buf_id = match resolve_capture_id(&capture_id) {
        Some(id) => id,
        None => {
            emit_session_error(&session_id, "No frame capture found".to_string());
            return;
        }
    };

    let total_frames = capture_store::get_capture_count(&buf_id);
    if total_frames == 0 {
        emit_session_error(&session_id, "Capture is empty".to_string());
        return;
    }

    let (min_rowid, max_rowid) = match capture_db::get_rowid_range(&buf_id) {
        Ok(Some(range)) => range,
        _ => {
            emit_session_error(&session_id, "Capture has no data".to_string());
            return;
        }
    };

    let metadata = capture_store::get_capture_metadata(&buf_id);
    let initial_speed = control.read_speed();
    let initial_pacing = control.is_pacing_enabled();
    tlog!(
        "[Capture:{}] Starting stream (frames: {}, speed: {}x, pacing: {}, source: '{}')",
        session_id,
        total_frames,
        initial_speed,
        initial_pacing,
        metadata.as_ref().map(|m| m.name.as_str()).unwrap_or("unknown")
    );

    // Streaming constants
    use super::pacing::*;
    const CHUNK_SIZE: usize = 2000;

    let mut total_emitted = 0i64;
    let mut frame_index = 0usize;
    let mut total_wait_ms = 0u64;
    let mut wait_count = 0u64;

    // Chunk state - frames loaded from SQLite
    let mut chunk: Vec<(i64, FrameMessage)> = load_chunk(&buf_id, min_rowid - 1, CHUNK_SIZE, false);
    let mut chunk_idx: usize = 0;
    let mut last_consumed_rowid: i64 = min_rowid - 1;
    if chunk.is_empty() {
        emit_session_error(&session_id, "Capture is empty".to_string());
        return;
    }

    // Get stream start time from first frame
    let stream_start_secs = chunk[0].1.timestamp_us as f64 / 1_000_000.0;

    let mut last_frame_time_secs: Option<f64> = None;
    let mut batch_buffer: Vec<FrameMessage> = Vec::new();
    let mut throttle = SignalThrottle::new();

    // Track wall-clock time vs playback time for proper pacing
    let mut wall_clock_baseline = std::time::Instant::now();
    let mut playback_baseline_secs = stream_start_secs;
    let mut last_speed = control.read_speed();
    let mut last_pacing_check = std::time::Instant::now();
    let mut last_reverse = control.is_reverse();

    tlog!(
        "[Capture:{}] Starting frame-by-frame loop (stream_start: {:.3}s, reverse: {})",
        session_id, stream_start_secs, last_reverse
    );

    'outer: loop {
    loop {
        // Check if cancelled
        if control.is_cancelled() {
            tlog!(
                "[Capture:{}] Stream cancelled, stopping immediately",
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
                "[Capture:{}] Direction changed to {}",
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
                break; // End of capture
            }
        }

        // Get current frame from chunk
        let (rowid, frame) = chunk[chunk_idx].clone();
        chunk_idx += 1;
        last_consumed_rowid = rowid;

        // Pre-decrement for reverse so actual_index reflects the correct capture position.
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
                crate::ws::dispatch::send_frames(&session_id, &batch_buffer);
                batch_buffer.clear();

                crate::io::store_playback_position(&session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: actual_index,
                    frame_count: Some(total_frames),
                });
                if throttle.should_signal("playback-position") {
                    signal_playback_position(&session_id);
                }

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

                crate::ws::dispatch::send_frames(&session_id, &batch_buffer);
                batch_buffer.clear();

                crate::io::store_playback_position(&session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: actual_index,
                    frame_count: Some(total_frames),
                });
                if throttle.should_signal("playback-position") {
                    signal_playback_position(&session_id);
                }

                tokio::task::yield_now().await;
            }
        } else {
            // Normal speed: flush any pending batch first
            if !batch_buffer.is_empty() {
                crate::ws::dispatch::send_frames(&session_id, &batch_buffer);
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

            // Send this single frame to all WS subscribers
            total_emitted += 1;
            crate::ws::dispatch::send_frames(&session_id, std::slice::from_ref(&frame));

            crate::io::store_playback_position(&session_id, PlaybackPosition {
                timestamp_us: playback_time_us,
                frame_index: actual_index,
                frame_count: Some(total_frames),
            });
            if throttle.should_signal("playback-position") {
                signal_playback_position(&session_id);
            }
        }
    }

    // Flush any remaining batch
    if !batch_buffer.is_empty() {
        crate::ws::dispatch::send_frames(&session_id, &batch_buffer);
        batch_buffer.clear();
        throttle.flush();

        // Emit final position so frontend highlights the last frame.
        // Forward: frame_index is one-past-end (post-increment), subtract 1.
        // Reverse: frame_index IS the last consumed position (pre-decrement), use directly.
        if let Some(last_time) = last_frame_time_secs {
            let is_reverse = control.is_reverse();
            let final_index = if is_reverse { frame_index } else { frame_index.saturating_sub(1) };
            let playback_time_us = (last_time * 1_000_000.0) as i64;
            // throttle already flushed above; always signal final position
            crate::io::store_playback_position(&session_id, PlaybackPosition {
                timestamp_us: playback_time_us,
                frame_index: final_index,
                frame_count: Some(total_frames),
            });
            signal_playback_position(&session_id);
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
    let frame_count = capture_store::get_capture_count(&buf_id);
    let stream_ended_info = post_session::StreamEndedInfo {
        reason: "paused".to_string(),
        capture_available: true,
        capture_id: Some(buf_id.clone()),
        capture_kind: Some("frames".to_string()),
        count: frame_count,
        time_range: None,
    };
    post_session::store_stream_ended(&session_id, stream_ended_info.clone());
    crate::ws::dispatch::send_stream_ended(&session_id, &stream_ended_info);
    let final_pos = if control.is_reverse() { frame_index } else { frame_index.saturating_sub(1) };
    tlog!(
        "[Capture:{}] Stream reached end of data, pausing at final position (frame_index: {})",
        session_id, final_pos
    );

    // Post-completion pause-wait loop: stay alive for step/seek/resume
    let mut seeked_during_pause = false;
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
            seeked_during_pause = true;
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

        // Only reload chunk if no seek occurred — seek already loaded the correct chunk
        if !seeked_during_pause {
            chunk = load_chunk(&buf_id, last_consumed_rowid, CHUNK_SIZE, is_reverse);
            chunk_idx = 0;
        }

        if chunk.is_empty() {
            // Still at boundary in this direction, re-pause and notify frontend
            control.pause();
            completed_flag.store(true, Ordering::Relaxed);
            let frame_count = capture_store::get_capture_count(&buf_id);
            let stream_ended_info = post_session::StreamEndedInfo {
                reason: "paused".to_string(),
                capture_available: true,
                capture_id: Some(buf_id.clone()),
                capture_kind: Some("frames".to_string()),
                count: frame_count,
                time_range: None,
            };
            post_session::store_stream_ended(&session_id, stream_ended_info.clone());
            crate::ws::dispatch::send_stream_ended(&session_id, &stream_ended_info);
            continue;
        }

        // Reset timing baselines for resumed playback
        wall_clock_baseline = std::time::Instant::now();
        if let Some(last_time) = last_frame_time_secs {
            playback_baseline_secs = last_time;
        }
        last_reverse = is_reverse;
        last_speed = control.read_speed();
        tlog!("[Capture:{}] Resuming playback from post-completion pause", session_id);
        break; // Break post-completion loop → re-enter main streaming via 'outer
    }
    } // end 'outer

    // Calculate stats
    let total_wall_time_ms = wall_clock_baseline.elapsed().as_millis();
    let data_duration_secs = last_frame_time_secs.unwrap_or(stream_start_secs) - stream_start_secs;
    tlog!(
        "[Capture:{}] Stream ended (reason: stopped, count: {}, wall_time: {}ms, data_duration: {:.1}s, waits: {} totaling {}ms)",
        session_id, total_emitted, total_wall_time_ms, data_duration_secs, wait_count, total_wait_ms
    );
}
