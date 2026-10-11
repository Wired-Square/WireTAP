// ui/crates/wiretap-app/src/io/recorded/capture.rs
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

use wiretap_io::replay::{Pacer, PlaybackControl, Playout, Unlimited};

use super::base::{publish_position, publish_position_now, RecordedSourceState};
use crate::io::{emit_session_error, post_session, signal_frames_ready, FrameMessage, IOCapabilities, IOSource, IOState, PlaybackPosition, SignalThrottle, StreamEndReason, TemporalMode};
use crate::{capture_db, capture_store};

/// `source_type()` for a session replaying a capture.
pub const CAPTURE_SOURCE_TYPE: &str = "capture";

/// Sentinel value meaning "no seek requested"
const NO_SEEK: i64 = i64::MIN;
/// Sentinel value meaning "no frame seek requested"
const NO_SEEK_FRAME: i64 = -1;
/// Frames read from the capture at a time.
const CHUNK_SIZE: usize = 2000;

/// Capture Source - streams frames from the SQLite-backed capture store
pub struct CaptureSource {
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
    pub fn new(session_id: String, capture_id: String, speed: f64) -> Self {
        let buses = capture_store::get_capture_metadata(&capture_id)
            .map(|m| m.buses)
            .unwrap_or_default();

        // Claim the capture as this session's own so WS frame dispatch
        // (send_new_frames) can locate it via get_session_frame_capture_id.
        // Without this, no FrameData is broadcast and apps that rely on the
        // onFrames callback (Decoder, etc.) see nothing while playback runs.
        // Ownership is released by orphan_captures_for_session on session destroy.
        if let Err(e) = capture_store::set_capture_owner(
            &capture_id,
            &session_id,
            capture_store::CaptureRole::Stream,
        ) {
            tlog!(
                "[CaptureSource] Failed to claim capture '{}' for session '{}': {}",
                capture_id, session_id, e
            );
        }

        Self {
            reader_state: RecordedSourceState::new(session_id, speed),
            seek_target_us: Arc::new(AtomicI64::new(NO_SEEK)),
            seek_target_frame: Arc::new(AtomicI64::new(NO_SEEK_FRAME)),
            completed_flag: Arc::new(AtomicBool::new(false)),
            capture_id: Some(capture_id),
            buses,
        }
    }

    /// A stopped reader has no loop to answer a seek, so the position is
    /// published from here; `start()` still lands on the stored target.
    fn publish_while_stopped(&self, position: Option<PlaybackPosition>) {
        if self.reader_state.state() != IOState::Stopped {
            return;
        }
        let Some(position) = position else { return };
        let session_id = self.reader_state.session_id();
        publish_position_now(session_id, position);
        signal_frames_ready(session_id);
    }
}

fn position_at_timestamp(capture_id: &str, timestamp_us: i64) -> Option<PlaybackPosition> {
    let rowid = capture_db::find_rowid_for_timestamp(capture_id, timestamp_us as u64).ok()??;
    let frame_index = capture_db::count_frames_before_rowid(capture_id, rowid).unwrap_or(0);
    position_at_frame(capture_id, frame_index)
}

fn position_at_frame(capture_id: &str, frame_index: usize) -> Option<PlaybackPosition> {
    let total = capture_store::get_capture_count(capture_id);
    let frame_index = frame_index.min(total.saturating_sub(1));
    let (_, frame) = capture_db::get_frame_at_index(capture_id, frame_index).ok()??;
    Some(PlaybackPosition {
        timestamp_us: frame.timestamp_us as i64,
        frame_index,
        frame_count: Some(total),
    })
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

        let session_id = self.reader_state.session_id.clone();
        let control = self.reader_state.control.clone();
        let seek_target_us = self.seek_target_us.clone();
        let seek_target_frame = self.seek_target_frame.clone();
        let completed_flag = self.completed_flag.clone();
        let capture_id = self.capture_id.clone();

        let handle = spawn_capture_stream(session_id, control, seek_target_us, seek_target_frame, completed_flag, capture_id);
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
        self.publish_while_stopped(self.capture_id.as_deref().and_then(|id| position_at_timestamp(id, timestamp_us)));
        Ok(())
    }

    fn seek_by_frame(&mut self, frame_index: i64) -> Result<(), String> {
        tlog!(
            "[Capture:{}] Seek by frame requested to index {}",
            self.reader_state.session_id, frame_index
        );
        self.seek_target_frame.store(frame_index, Ordering::Relaxed);
        self.publish_while_stopped(self.capture_id.as_deref().and_then(|id| position_at_frame(id, frame_index.max(0) as usize)));
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
        CAPTURE_SOURCE_TYPE
    }
}

/// Step one frame forward or backward from the given timestamp.
/// Returns the new timestamp after stepping, or None if at the boundary.
/// Also emits the frame and a snapshot via events.
/// Result of a step operation, containing both the new frame index and timestamp
#[derive(Debug, Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct StepResult {
    pub frame_index: usize,
    pub timestamp_us: i64,
}

pub fn step_frame(
    session_id: &str,
    capture_id: &str,
    current_frame_index: Option<usize>,
    current_timestamp_us: Option<i64>,
    backward: bool,
    selection: &crate::capture_store::FrameSelection,
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
    match capture_db::get_next_filtered_frame(&buf_id, current_rowid, selection, backward)? {
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
            publish_position_now(session_id, position);

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
    session_id: String,
    control: PlaybackControl,
    seek_target_us: Arc<AtomicI64>,
    seek_target_frame: Arc<AtomicI64>,
    completed_flag: Arc<AtomicBool>,
    capture_id: Option<String>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        run_capture_stream(session_id, control, seek_target_us, seek_target_frame, completed_flag, capture_id).await;
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
#[allow(clippy::too_many_arguments)]
fn handle_seek(
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
    pacer: &mut Pacer<FrameMessage>,
) -> bool {
    // Playback moves to `rowid`, frame `target_idx`, and is published there; the
    // frame's time is read from the reloaded chunk unless it is given.
    let mut land = |rowid: i64, target_idx: usize, timestamp_us: Option<u64>| {
        let is_reverse = control.is_reverse();
        // In reverse mode, the main loop pre-decrements before capturing actual_index,
        // so set frame_index one higher so pre-decrement yields target_idx.
        *frame_index = if is_reverse { target_idx + 1 } else { target_idx };
        *last_consumed_rowid = rowid;
        *chunk = load_chunk(buf_id, if is_reverse { rowid + 1 } else { rowid - 1 }, CHUNK_SIZE, is_reverse);
        *chunk_idx = 0;
        pacer.clear_batch();
        crate::ws::dispatch::reset_decode_state(session_id);

        if let Some(timestamp_us) = timestamp_us.or_else(|| chunk.first().map(|(_, f)| f.timestamp_us)) {
            pacer.restart_at(timestamp_us as f64 / 1_000_000.0);
            let position = PlaybackPosition {
                timestamp_us: timestamp_us as i64,
                frame_index: target_idx,
                frame_count: Some(total_frames),
            };
            publish_position_now(session_id, position);
        }
        signal_frames_ready(session_id);
    };

    // Check for frame-based seek (takes priority)
    let seek_frame = seek_target_frame.load(Ordering::Relaxed);
    if seek_frame != NO_SEEK_FRAME {
        seek_target_frame.store(NO_SEEK_FRAME, Ordering::Relaxed);
        let target_idx = (seek_frame as usize).min(total_frames.saturating_sub(1));
        tlog!(
            "[Capture:{}] Seeking to frame {} (by index, paused={})",
            session_id, target_idx, control.is_paused()
        );
        if let Ok(Some((rowid, frame))) = capture_db::get_frame_at_index(buf_id, target_idx) {
            land(rowid, target_idx, Some(frame.timestamp_us));
        }
        return true;
    }

    // Check for timestamp-based seek
    let seek_target = seek_target_us.load(Ordering::Relaxed);
    if seek_target != NO_SEEK {
        seek_target_us.store(NO_SEEK, Ordering::Relaxed);
        if let Ok(Some(rowid)) = capture_db::find_rowid_for_timestamp(buf_id, seek_target as u64) {
            let target_idx = capture_db::count_frames_before_rowid(buf_id, rowid).unwrap_or(0);
            tlog!(
                "[Capture:{}] Seeking to frame {} (timestamp {}us, paused={})",
                session_id, target_idx, seek_target, control.is_paused()
            );
            land(rowid, target_idx, None);
        }
        return true;
    }

    false
}

/// Played frames go to the session's subscribers, at the capture's own index.
struct ToSubscribers<'a> {
    session_id: &'a str,
    throttle: SignalThrottle,
    frame_index: usize,
    total_frames: usize,
}

impl Playout<FrameMessage> for ToSubscribers<'_> {
    fn frames(&mut self, frames: Vec<FrameMessage>) {
        crate::ws::dispatch::send_frames(self.session_id, &frames);
    }

    fn position(&mut self, timestamp_us: i64, _emitted: i64) {
        let position = PlaybackPosition {
            timestamp_us,
            frame_index: self.frame_index,
            frame_count: Some(self.total_frames),
        };
        publish_position(self.session_id, position, &mut self.throttle);
    }
}

/// The stream reached the end it was playing towards: it pauses there, alive for
/// a step, seek or resume.
fn pause_at_end(session_id: &str, buf_id: &str, control: &PlaybackControl, completed_flag: &AtomicBool) {
    completed_flag.store(true, Ordering::Relaxed);
    control.pause();
    let stream_ended_info = post_session::StreamEndedInfo {
        reason: StreamEndReason::Paused,
        capture_available: true,
        capture_id: Some(buf_id.to_string()),
        capture_kind: Some(capture_store::CaptureKind::Frames),
        count: capture_store::get_capture_count(buf_id),
        time_range: None,
    };
    crate::io::publish_stream_ended(session_id, stream_ended_info);
}

async fn run_capture_stream(
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

    /// Frames batched at unlimited speed (0 / instant replay), and the yield (ms) after each batch.
    const UNLIMITED: Unlimited = Unlimited { batch: 1000, yield_ms: 10 };

    let mut frame_index = 0usize;

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

    let mut pacer = Pacer::new(stream_start_secs, &control, UNLIMITED);
    let mut out = ToSubscribers {
        session_id: &session_id,
        throttle: SignalThrottle::new(),
        frame_index: 0,
        total_frames,
    };
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
            &session_id, &buf_id, total_frames,
            &seek_target_frame, &seek_target_us, &control,
            &mut chunk, &mut chunk_idx, &mut frame_index, &mut last_consumed_rowid,
            &mut pacer,
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

            pacer.rebaseline_at_last();
            crate::ws::dispatch::reset_decode_state(&session_id);
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
        out.frame_index = frame_index;
        if !is_reverse {
            frame_index += 1;
        }

        pacer.keep_time(&control).await;
        if pacer.play(frame, &control, &mut out).await.is_some() {
            chunk_idx -= 1; // Re-process this frame after resume
            // Undo the frame_index update so re-processing gets the correct index
            if is_reverse { frame_index += 1; } else { frame_index -= 1; }
        }
    }

    // Flush any remaining batch
    let rest = pacer.take_batch();
    if !rest.is_empty() {
        out.frames(rest);
        out.throttle.flush();

        // Emit final position so frontend highlights the last frame.
        // Forward: frame_index is one-past-end (post-increment), subtract 1.
        // Reverse: frame_index IS the last consumed position (pre-decrement), use directly.
        if let Some(last_time) = pacer.last_frame_secs() {
            let is_reverse = control.is_reverse();
            let final_index = if is_reverse { frame_index } else { frame_index.saturating_sub(1) };
            // throttle already flushed above; always signal final position
            publish_position_now(&session_id, PlaybackPosition {
                timestamp_us: (last_time * 1_000_000.0) as i64,
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
    pause_at_end(&session_id, &buf_id, &control, &completed_flag);
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
            &session_id, &buf_id, total_frames,
            &seek_target_frame, &seek_target_us, &control,
            &mut chunk, &mut chunk_idx, &mut frame_index, &mut last_consumed_rowid,
            &mut pacer,
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
            pause_at_end(&session_id, &buf_id, &control, &completed_flag);
            continue;
        }

        pacer.resume(&control);
        last_reverse = is_reverse;
        tlog!("[Capture:{}] Resuming playback from post-completion pause", session_id);
        break; // Break post-completion loop → re-enter main streaming via 'outer
    }
    } // end 'outer

    let data_duration_secs = pacer.last_frame_secs().unwrap_or(stream_start_secs) - stream_start_secs;
    let stats = pacer.stats();
    tlog!(
        "[Capture:{}] Stream ended (reason: stopped, count: {}, wall_time: {}ms, data_duration: {:.1}s, waits: {} totaling {}ms)",
        session_id, stats.emitted, pacer.wall_elapsed().as_millis(), data_duration_secs, stats.waits, stats.waited_ms
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_store::{create_standalone_capture, CaptureKind, FrameSelection, ProtocolFrames};

    fn capture_of(name: &str, frames: &[(u64, u32)]) -> String {
        crate::capture_db::use_in_memory_database();
        let id = create_standalone_capture(CaptureKind::Frames, name.to_string());
        let frames = frames
            .iter()
            .map(|&(timestamp_us, frame_id)| FrameMessage {
                protocol: "can".into(),
                timestamp_us,
                frame_id,
                ..Default::default()
            })
            .collect();
        capture_store::append_frames_to_capture(&id, frames);
        id
    }

    fn step(capture: &str, index: Option<usize>, timestamp: Option<i64>, backward: bool) -> Option<(usize, i64)> {
        step_frame("f_step_test", capture, index, timestamp, backward, &FrameSelection::default())
            .unwrap()
            .map(|r| (r.frame_index, r.timestamp_us))
    }

    const THREE: &[(u64, u32)] = &[(10, 0x100), (20, 0x200), (30, 0x100)];

    #[test]
    fn an_empty_capture_cannot_be_stepped() {
        let id = capture_of("step-empty", &[]);
        let err = step_frame("f_step_test", &id, None, None, false, &FrameSelection::default()).unwrap_err();
        assert_eq!(err, "Capture is empty");
    }

    #[test]
    fn a_step_moves_one_frame_from_the_index_given() {
        let id = capture_of("step-index", THREE);
        assert_eq!(step(&id, Some(0), None, false), Some((1, 20)));
        assert_eq!(step(&id, Some(2), None, true), Some((1, 20)));
    }

    #[test]
    fn a_step_past_either_end_is_none() {
        let id = capture_of("step-ends", THREE);
        assert_eq!(step(&id, Some(2), None, false), None);
        assert_eq!(step(&id, Some(0), None, true), None);
    }

    #[test]
    fn an_index_past_the_end_is_clamped_to_the_last_frame() {
        let id = capture_of("step-clamp", THREE);
        assert_eq!(step(&id, Some(99), None, true), Some((1, 20)));
    }

    #[test]
    fn with_no_position_a_step_starts_at_the_end_it_leaves_and_skips_that_frame() {
        let id = capture_of("step-no-position", THREE);
        assert_eq!(step(&id, None, None, false), Some((1, 20)));
        assert_eq!(step(&id, None, None, true), Some((1, 20)));
    }

    #[test]
    fn a_timestamp_resolves_to_the_first_frame_at_or_after_it() {
        let id = capture_of("step-timestamp", THREE);
        assert_eq!(step(&id, None, Some(15), false), Some((2, 30)));
        assert_eq!(step(&id, None, Some(15), true), Some((0, 10)));
    }

    #[test]
    fn a_timestamp_past_the_last_frame_falls_back_to_the_end_it_leaves() {
        let id = capture_of("step-late-timestamp", THREE);
        assert_eq!(step(&id, None, Some(99), false), Some((1, 20)));
        assert_eq!(step(&id, None, Some(99), true), Some((1, 20)));
    }

    #[test]
    fn a_selection_skips_the_frames_it_leaves_out() {
        let id = capture_of("step-selection", THREE);
        let only_0x100 = FrameSelection::from_groups(vec![ProtocolFrames {
            protocol: "can".into(),
            frame_ids: vec![0x100],
            all_ids: false,
        }]);
        let result = step_frame("f_step_test", &id, Some(0), None, false, &only_0x100).unwrap().unwrap();
        assert_eq!((result.frame_index, result.timestamp_us), (2, 30));
    }

    async fn play_to_end(source: &mut CaptureSource, limit: Duration) -> Option<Duration> {
        let started = std::time::Instant::now();
        source.start().await.unwrap();
        let ended = tokio::time::timeout(limit, async {
            while source.state() != IOState::Paused {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        let elapsed = started.elapsed();
        source.stop().await.unwrap();
        ended.ok().map(|_| elapsed)
    }

    fn spread(count: usize, span_us: u64) -> Vec<(u64, u32)> {
        (0..count).map(|i| (i as u64 * span_us / count as u64, 0x100)).collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn at_unlimited_speed_a_capture_plays_through_its_chunks_and_pauses_at_the_end() {
        let id = capture_of("play-unlimited", &spread(4500, 60_000_000));
        let mut source = CaptureSource::new("f_play_unlimited".into(), id, 0.0);
        let elapsed = play_to_end(&mut source, Duration::from_secs(10)).await.expect("reached the end");
        assert!(elapsed < Duration::from_secs(10));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn at_1x_playback_takes_as_long_as_the_capture_spans() {
        let id = capture_of("play-paced", &spread(30, 400_000));
        let mut source = CaptureSource::new("f_play_paced".into(), id, 1.0);
        let elapsed = play_to_end(&mut source, Duration::from_secs(5)).await.expect("reached the end");
        assert!(elapsed >= Duration::from_millis(350), "finished in {elapsed:?}");
    }

    async fn open_playback(session_id: &str, frames: &[(u64, u32)], speed: f64) {
        let id = capture_of(session_id, frames);
        let source = CaptureSource::new(session_id.into(), id, speed);
        crate::io::create_session(session_id.into(), Box::new(source), None, None, None, vec![]).await;
        crate::io::start_session(session_id).await.unwrap();
    }

    /// The published position once it is `(frame_index, timestamp_us)` with the
    /// session in `state`, or what it was when that never came.
    async fn settles_at(session_id: &str, state: IOState, at: (usize, i64)) -> Result<(), String> {
        let position = || {
            crate::io::get_playback_position(session_id).map(|p| (p.frame_index, p.timestamp_us))
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while position() != Some(at) || crate::io::get_session_state(session_id).await != Some(state.clone()) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .map_err(|_| format!("settled at {:?}", position()))
    }

    fn ten_frames() -> Vec<(u64, u32)> {
        (1..=10).map(|i| (i * 10, 0x100)).collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn paused_at_the_end_a_seek_lands_on_its_frame() {
        const SESSION: &str = "f_play_seek_at_end";
        open_playback(SESSION, &ten_frames(), 0.0).await;
        let ended = settles_at(SESSION, IOState::Paused, (9, 100)).await;
        crate::io::seek_session_by_frame(SESSION, 4).await.unwrap();
        let by_frame = settles_at(SESSION, IOState::Paused, (4, 50)).await;
        crate::io::seek_session(SESSION, 65).await.unwrap();
        let by_time = settles_at(SESSION, IOState::Paused, (6, 70)).await;
        crate::io::destroy_session(SESSION, false).await.ok();

        assert_eq!((ended, by_frame, by_time), (Ok(()), Ok(()), Ok(())));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reversed_at_the_end_a_capture_plays_back_to_its_first_frame() {
        const SESSION: &str = "f_play_reverse";
        open_playback(SESSION, &ten_frames(), 0.0).await;
        let ended = settles_at(SESSION, IOState::Paused, (9, 100)).await;
        crate::io::update_session_direction(SESSION, true).await.unwrap();
        crate::io::resume_session(SESSION).await.unwrap();
        let back = settles_at(SESSION, IOState::Paused, (0, 10)).await;
        crate::io::destroy_session(SESSION, false).await.ok();

        assert_eq!((ended, back), (Ok(()), Ok(())));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_seek_while_paused_mid_play_resumes_from_its_frame() {
        const SESSION: &str = "f_play_seek_mid";
        let frames: Vec<(u64, u32)> = (0..200).map(|i| (1_000 + i * 10_000, 0x100)).collect();
        open_playback(SESSION, &frames, 1.0).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        crate::io::pause_session(SESSION).await.unwrap();
        crate::io::seek_session_by_frame(SESSION, 150).await.unwrap();
        let sought = settles_at(SESSION, IOState::Paused, (150, 1_501_000)).await;
        crate::io::resume_session(SESSION).await.unwrap();
        let ended = settles_at(SESSION, IOState::Paused, (199, 1_991_000)).await;
        crate::io::destroy_session(SESSION, false).await.ok();

        assert_eq!((sought, ended), (Ok(()), Ok(())));
    }
}
