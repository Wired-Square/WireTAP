// ui/src-tauri/src/replay.rs
//
// Time-accurate frame replay — plays back a set of captured frames to a target
// session, preserving the original inter-frame timing scaled by a speed multiplier.
//
// Replay state is stored in REPLAY_STATES and fetched by the frontend via
// get_replay_state after receiving a `replay-lifecycle` or `replay-progress` signal.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use tauri::AppHandle;

use crate::io::{self, CanTransmitFrame};

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

// ============================================================================
// Replay State (signal-then-fetch)
// ============================================================================

/// Snapshot of a replay's progress, polled by the frontend via get_replay_state.
#[derive(Clone, Debug, Serialize)]
pub struct ReplayState {
    pub status: String,
    pub replay_id: String,
    pub frames_sent: usize,
    pub total_frames: usize,
    pub speed: f64,
    pub loop_replay: bool,
    pub pass: usize,
}

static REPLAY_STATES: Lazy<StdMutex<HashMap<String, ReplayState>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

pub fn store_replay_state(replay_id: &str, state: ReplayState) {
    if let Ok(mut states) = REPLAY_STATES.lock() {
        states.insert(replay_id.to_string(), state);
    }
}

pub fn clear_replay_state(replay_id: &str) {
    if let Ok(mut states) = REPLAY_STATES.lock() {
        states.remove(replay_id);
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_replay_state(replay_id: String) -> Option<ReplayState> {
    REPLAY_STATES.lock().ok().and_then(|s| s.get(&replay_id).cloned())
}

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
/// Progress is stored in REPLAY_STATES and signalled to the frontend via
/// `replay-lifecycle` (start/loop/end) and `replay-progress` (periodic frame count).
#[tauri::command]
pub async fn io_start_replay(
    _app: AppHandle,
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

        // Store initial state and notify frontend that replay has started
        let initial_state = ReplayState {
            status: "running".to_string(),
            replay_id: replay_id_for_task.clone(),
            frames_sent: 0,
            total_frames: total_frames as usize,
            speed,
            loop_replay,
            pass: 1,
        };
        store_replay_state(&replay_id_for_task, initial_state.clone());
        crate::ws::dispatch::send_replay_state(&initial_state);

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
                    crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
                    tlog!("[replay] Stopping replay '{}' due to permanent error: {}", replay_id_for_task, err_msg);
                    let error_state = ReplayState {
                        status: "error".to_string(),
                        replay_id: replay_id_for_task.clone(),
                        frames_sent: frames_sent as usize,
                        total_frames: total_frames as usize,
                        speed,
                        loop_replay,
                        pass: pass as usize,
                    };
                    store_replay_state(&replay_id_for_task, error_state.clone());
                    crate::ws::dispatch::send_replay_state(&error_state);
                    clear_replay_state(&replay_id_for_task);
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
                    let progress_state = ReplayState {
                        status: "running".to_string(),
                        replay_id: replay_id_for_task.clone(),
                        frames_sent: frames_sent as usize,
                        total_frames: total_frames as usize,
                        speed,
                        loop_replay,
                        pass: pass as usize,
                    };
                    store_replay_state(&replay_id_for_task, progress_state.clone());
                    crate::ws::dispatch::send_replay_state(&progress_state);
                    crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
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

            // Store loop-restart state and notify frontend before beginning the next pass
            let loop_state = ReplayState {
                status: "running".to_string(),
                replay_id: replay_id_for_task.clone(),
                frames_sent: frames_sent as usize,
                total_frames: total_frames as usize,
                speed,
                loop_replay,
                pass: pass as usize,
            };
            store_replay_state(&replay_id_for_task, loop_state.clone());
            crate::ws::dispatch::send_replay_state(&loop_state);
            pass += 1;
        }

        tlog!("[replay] '{}' complete: {} sent, {} failed", replay_id_for_task, frames_sent, frames_failed);

        // Final history update notification
        crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());

        // Store final state and notify frontend
        let final_state = ReplayState {
            status: if cancelled { "stopped" } else { "completed" }.to_string(),
            replay_id: replay_id_for_task.clone(),
            frames_sent: frames_sent as usize,
            total_frames: total_frames as usize,
            speed,
            loop_replay,
            pass: pass as usize,
        };
        store_replay_state(&replay_id_for_task, final_state.clone());
        crate::ws::dispatch::send_replay_state(&final_state);

        // Remove from active tasks map.
        // Keep final replay state in REPLAY_STATES so the frontend can fetch it
        // after receiving the WS notification. State is cleared on next replay start
        // or when io_stop_replay is called.
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
