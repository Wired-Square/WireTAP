// ui/src-tauri/src/replay.rs
//
// Time-accurate frame replay — plays back a set of captured frames to a target
// session, preserving the original inter-frame timing scaled by a speed multiplier.
//
// Each replay is ephemeral: results appear in transmit history via the existing
// `transmit-history` and `repeat-stopped` events so the frontend needs no new
// event listeners.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

use crate::io::{self, CanTransmitFrame};
use crate::transmit::RepeatStoppedEvent;

// ============================================================================
// Progress Events
// ============================================================================

/// Emitted once when a replay task starts.
#[derive(Clone, Serialize)]
pub struct ReplayStartedEvent {
    pub replay_id: String,
    pub total_frames: u64,
    pub speed: f64,
    pub loop_replay: bool,
}

/// Emitted periodically (~250 ms) during a replay to report progress.
#[derive(Clone, Serialize)]
pub struct ReplayProgressEvent {
    pub replay_id: String,
    pub frames_sent: u64,
    pub total_frames: u64,
}

/// Emitted when a looping replay completes a pass and is about to restart.
#[derive(Clone, Serialize)]
pub struct ReplayLoopRestartedEvent {
    /// The replay that looped.
    pub replay_id: String,
    /// The pass number that just completed (1-based).
    pub pass: u64,
    /// Cumulative frames sent across all passes so far.
    pub frames_sent: u64,
}

// ============================================================================
// Types
// ============================================================================

/// A single frame with its original capture timestamp, used for time-accurate replay.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReplayFrame {
    /// Original capture timestamp (microseconds since UNIX epoch).
    pub timestamp_us: u64,
    /// The CAN frame to transmit.
    pub frame: CanTransmitFrame,
}

/// Active replay task handle.
struct ReplayTask {
    cancel_flag: std::sync::Arc<AtomicBool>,
    #[allow(dead_code)]
    handle: tauri::async_runtime::JoinHandle<()>,
}

/// Map of replay_id -> ReplayTask for active replay operations.
static IO_REPLAY_TASKS: Lazy<tokio::sync::Mutex<HashMap<String, ReplayTask>>> =
    Lazy::new(|| tokio::sync::Mutex::new(HashMap::new()));

// Maximum inter-frame sleep to avoid hanging on large timestamp gaps (5 seconds).
const MAX_SLEEP_US: u64 = 5_000_000;

// ============================================================================
// Tauri Commands
// ============================================================================

/// Start a time-accurate replay of a sequence of frames.
///
/// Frames are transmitted in order with delays derived from their original timestamps
/// divided by `speed`. A speed of 1.0 is realtime; 2.0 is twice as fast.
///
/// History events are emitted as `transmit-history` (one per frame). A `repeat-stopped`
/// event is emitted when the replay finishes or is cancelled.
#[tauri::command]
pub async fn io_start_replay(
    app: AppHandle,
    session_id: String,
    replay_id: String,
    frames: Vec<ReplayFrame>,
    speed: f64,
    loop_replay: bool,
) -> Result<(), String> {
    if frames.is_empty() {
        return Err("No frames to replay".to_string());
    }

    let speed = speed.max(0.001); // Guard against zero/negative speed

    // Stop any existing replay with the same ID
    io_stop_replay(replay_id.clone()).await?;

    let cancel_flag = std::sync::Arc::new(AtomicBool::new(false));
    let cancel_flag_clone = cancel_flag.clone();
    let session_id_clone = session_id.clone();
    let replay_id_for_task = replay_id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        let total_frames = frames.len() as u64;
        let mut frames_sent: u64 = 0;
        let mut frames_failed: u64 = 0;
        let mut cancelled = false;

        // Notify frontend that replay has started
        let _ = app.emit("replay-started", ReplayStartedEvent {
            replay_id: replay_id_for_task.clone(),
            total_frames,
            speed,
            loop_replay,
        });

        let mut last_progress = std::time::Instant::now();
        const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);
        let mut pass: u64 = 1;

        'outer: loop {
            for i in 0..frames.len() {
                if cancel_flag_clone.load(Ordering::Relaxed) {
                    cancelled = true;
                    break 'outer;
                }

                let frame = &frames[i].frame;

                // Transmit the frame. Writing to SQLite per frame is safe here because
                // the write_entry mutex lock is held only for the INSERT (~microseconds).
                let result = io::transmit_frame(&session_id_clone, frame).await;

                // Stop on permanent device errors
                let is_permanent = match &result {
                    Ok(r) => r.error.as_deref().map(crate::transmit::is_permanent_error_pub).unwrap_or(false) && !r.success,
                    Err(e) => crate::transmit::is_permanent_error_pub(e),
                };
                if is_permanent {
                    let err_msg = match &result {
                        Ok(r) => r.error.clone().unwrap_or_else(|| "Device error".to_string()),
                        Err(e) => e.clone(),
                    };
                    // Write the failed frame to history before stopping
                    crate::transmit_history::write_entry(
                        &session_id_clone, "can",
                        Some(frame.frame_id as i64),
                        Some(frame.data.len() as i64),
                        &frame.data,
                        frame.bus as i64,
                        frame.is_extended,
                        frame.is_fd,
                        false,
                        Some(&err_msg),
                    );
                    let _ = app.emit("transmit-history-updated", ());
                    tlog!("[replay] Stopping replay '{}' due to permanent error: {}", replay_id_for_task, err_msg);
                    let _ = app.emit("repeat-stopped", RepeatStoppedEvent {
                        queue_id: replay_id_for_task.clone(),
                        reason: err_msg,
                    });
                    return;
                }

                let (r_success, r_error) = match &result {
                    Ok(r) => (r.success, r.error.clone()),
                    Err(e) => (false, Some(e.clone())),
                };
                crate::transmit_history::write_entry(
                    &session_id_clone, "can",
                    Some(frame.frame_id as i64),
                    Some(frame.data.len() as i64),
                    &frame.data,
                    frame.bus as i64,
                    frame.is_extended,
                    frame.is_fd,
                    r_success,
                    r_error.as_deref(),
                );

                match result {
                    Ok(r) if r.success => frames_sent += 1,
                    _ => frames_failed += 1,
                }

                // Throttled progress + history update (~250 ms)
                if last_progress.elapsed() >= PROGRESS_INTERVAL {
                    let _ = app.emit("replay-progress", ReplayProgressEvent {
                        replay_id: replay_id_for_task.clone(),
                        frames_sent,
                        total_frames,
                    });
                    let _ = app.emit("transmit-history-updated", ());
                    last_progress = std::time::Instant::now();
                }

                // Sleep until the next frame's timestamp (scaled by speed)
                if i + 1 < frames.len() {
                    let next_ts = frames[i + 1].timestamp_us;
                    let curr_ts = frames[i].timestamp_us;
                    let delta_us = next_ts.saturating_sub(curr_ts);
                    let sleep_us = ((delta_us as f64) / speed).round() as u64;
                    let capped_us = sleep_us.min(MAX_SLEEP_US);
                    if capped_us > 0 {
                        tokio::time::sleep(tokio::time::Duration::from_micros(capped_us)).await;
                    }
                }
            }

            if !loop_replay {
                break;
            }

            // Emit loop-restart event before beginning the next pass
            let _ = app.emit("replay-loop-restarted", ReplayLoopRestartedEvent {
                replay_id: replay_id_for_task.clone(),
                pass,
                frames_sent,
            });
            pass += 1;
        }

        tlog!("[replay] '{}' complete: {} sent, {} failed", replay_id_for_task, frames_sent, frames_failed);

        // Final history update notification
        let _ = app.emit("transmit-history-updated", ());

        // Notify frontend that replay has finished or was cancelled
        let reason = if cancelled {
            format!("Replay stopped ({} frames)", frames_sent)
        } else {
            format!("Replay complete ({} frames)", frames_sent)
        };
        let _ = app.emit("repeat-stopped", RepeatStoppedEvent {
            queue_id: replay_id_for_task.clone(),
            reason,
        });

        // Remove from active tasks map
        let mut tasks = IO_REPLAY_TASKS.lock().await;
        tasks.remove(&replay_id_for_task);
    });

    let mut tasks = IO_REPLAY_TASKS.lock().await;
    tasks.insert(replay_id.clone(), ReplayTask { cancel_flag, handle });

    Ok(())
}

/// Stop an active replay by ID.
#[tauri::command]
pub async fn io_stop_replay(replay_id: String) -> Result<(), String> {
    let mut tasks = IO_REPLAY_TASKS.lock().await;
    if let Some(task) = tasks.remove(&replay_id) {
        task.cancel_flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Stop all active replays.
#[tauri::command]
pub async fn io_stop_all_replays() -> Result<(), String> {
    let mut tasks = IO_REPLAY_TASKS.lock().await;
    for (_, task) in tasks.drain() {
        task.cancel_flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
