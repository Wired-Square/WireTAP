// ui/crates/wiretap-app/src/replay.rs
//
// Time-accurate frame replay — plays back a set of captured frames to a target
// session, preserving the original inter-frame timing scaled by a speed multiplier.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;
use tokio::sync::watch;

use crate::io::{self, CanTransmitFrame};

// ============================================================================
// Types
// ============================================================================

/// A single frame with its original capture timestamp, used for time-accurate replay.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ReplayFrame {
    /// Original capture timestamp (microseconds since UNIX epoch).
    pub timestamp_us: u64,
    /// The CAN frame to transmit.
    pub frame: CanTransmitFrame,
}

impl From<&io::FrameMessage> for ReplayFrame {
    fn from(f: &io::FrameMessage) -> Self {
        ReplayFrame {
            timestamp_us: f.timestamp_us,
            frame: CanTransmitFrame {
                frame_id: f.frame_id,
                data: f.bytes.clone(),
                bus: f.bus,
                is_extended: f.is_extended,
                is_fd: f.is_fd,
                is_brs: false,
                is_rtr: false,
            },
        }
    }
}

/// Active replay task handle.
struct ReplayTask {
    cancel: watch::Sender<bool>,
    #[allow(dead_code)]
    handle: tauri::async_runtime::JoinHandle<()>,
}

/// Map of replay_id -> ReplayTask for active replay operations.
static IO_REPLAY_TASKS: Lazy<tokio::sync::Mutex<HashMap<String, ReplayTask>>> =
    Lazy::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// Snapshot of a replay's progress, pushed to the frontend over WS.
#[derive(Clone, Debug, Serialize)]
pub struct ReplayState {
    pub status: String,
    pub replay_id: String,
    pub session_id: String,
    pub frames_sent: usize,
    pub total_frames: usize,
    pub speed: f64,
    pub loop_replay: bool,
    pub pass: usize,
}

// Maximum inter-frame sleep to avoid hanging on large timestamp gaps (5 seconds).
const MAX_SLEEP_US: u64 = 5_000_000;

/// When each frame of one replay pass is due, measured from the pass's start so
/// the time a send takes is not added to the gap after it.
struct ReplaySchedule {
    speed: f64,
    start: tokio::time::Instant,
    due_us: u64,
    previous_us: Option<u64>,
}

impl ReplaySchedule {
    fn new(speed: f64) -> Self {
        Self { speed, start: tokio::time::Instant::now(), due_us: 0, previous_us: None }
    }

    async fn wait_for(&mut self, timestamp_us: u64) {
        if let Some(previous_us) = self.previous_us.replace(timestamp_us) {
            let delta_us = timestamp_us.saturating_sub(previous_us);
            self.due_us += (((delta_us as f64) / self.speed).round() as u64).min(MAX_SLEEP_US);
        }
        tokio::time::sleep_until(self.start + tokio::time::Duration::from_micros(self.due_us)).await;
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Start a time-accurate replay of a sequence of frames.
///
/// Frames are transmitted in order with delays derived from their original timestamps
/// divided by `speed`. A speed of 1.0 is realtime; 2.0 is twice as fast.
///
/// Progress is pushed to the frontend as `ReplayState` WS messages.
#[tauri::command]
pub async fn io_start_replay(
    _app: AppHandle,
    session_id: String,
    replay_id: String,
    frames: Vec<ReplayFrame>,
    speed: f64,
    loop_replay: bool,
) -> Result<(), String> {
    start_replay(session_id, replay_id, frames, speed, loop_replay).await
}

/// Core replay implementation, callable without an `AppHandle`.
/// Used by both the Tauri command above and the MCP `replay_capture` tool.
pub async fn start_replay(
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

    let (cancel, mut cancelled_rx) = watch::channel(false);
    let session_id_clone = session_id.clone();
    let replay_id_for_task = replay_id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        let total_frames = frames.len() as u64;
        let mut frames_sent: u64 = 0;
        let mut frames_failed: u64 = 0;
        let mut cancelled = false;

        // Notify frontend that replay has started
        let initial_state = ReplayState {
            status: "running".to_string(),
            replay_id: replay_id_for_task.clone(),
            session_id: session_id_clone.clone(),
            frames_sent: 0,
            total_frames: total_frames as usize,
            speed,
            loop_replay,
            pass: 1,
        };
        crate::ws::dispatch::send_replay_state(&initial_state);

        let mut last_progress = std::time::Instant::now();
        const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);
        let mut pass: u64 = 1;

        'outer: loop {
            let mut schedule = ReplaySchedule::new(speed);
            for replay_frame in &frames {
                let frame = &replay_frame.frame;

                // Transmit the frame. Writing to SQLite per frame is safe here because
                // the write_entry mutex lock is held only for the INSERT (~microseconds).
                let send = async {
                    schedule.wait_for(replay_frame.timestamp_us).await;
                    io::transmit_frame_when_ready(&session_id_clone, frame).await
                };
                let result = tokio::select! {
                    _ = cancelled_rx.wait_for(|stop| *stop) => {
                        cancelled = true;
                        break 'outer;
                    }
                    result = send => result,
                };

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
                        session_id: session_id_clone.clone(),
                        frames_sent: frames_sent as usize,
                        total_frames: total_frames as usize,
                        speed,
                        loop_replay,
                        pass: pass as usize,
                    };
                    crate::ws::dispatch::send_replay_state(&error_state);
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
                        session_id: session_id_clone.clone(),
                        frames_sent: frames_sent as usize,
                        total_frames: total_frames as usize,
                        speed,
                        loop_replay,
                        pass: pass as usize,
                    };
                    crate::ws::dispatch::send_replay_state(&progress_state);
                    crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
                    last_progress = std::time::Instant::now();
                }
            }

            if !loop_replay {
                break;
            }

            // Notify frontend before beginning the next pass
            let loop_state = ReplayState {
                status: "running".to_string(),
                replay_id: replay_id_for_task.clone(),
                session_id: session_id_clone.clone(),
                frames_sent: frames_sent as usize,
                total_frames: total_frames as usize,
                speed,
                loop_replay,
                pass: pass as usize,
            };
            crate::ws::dispatch::send_replay_state(&loop_state);
            pass += 1;
        }

        tlog!("[replay] '{}' complete: {} sent, {} failed", replay_id_for_task, frames_sent, frames_failed);

        // Final history update notification
        crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());

        // Notify frontend of the final state
        let final_state = ReplayState {
            status: if cancelled { "stopped" } else { "completed" }.to_string(),
            replay_id: replay_id_for_task.clone(),
            session_id: session_id_clone.clone(),
            frames_sent: frames_sent as usize,
            total_frames: total_frames as usize,
            speed,
            loop_replay,
            pass: pass as usize,
        };
        crate::ws::dispatch::send_replay_state(&final_state);

        // Remove from active tasks map.
        let mut tasks = IO_REPLAY_TASKS.lock().await;
        tasks.remove(&replay_id_for_task);
    });

    let mut tasks = IO_REPLAY_TASKS.lock().await;
    tasks.insert(replay_id.clone(), ReplayTask { cancel, handle });

    Ok(())
}

/// Stop an active replay by ID.
#[tauri::command]
pub async fn io_stop_replay(replay_id: String) -> Result<(), String> {
    let mut tasks = IO_REPLAY_TASKS.lock().await;
    if let Some(task) = tasks.remove(&replay_id) {
        task.cancel.send_replace(true);
    }
    Ok(())
}

/// Stop all active replays.
#[tauri::command]
pub async fn io_stop_all_replays() -> Result<(), String> {
    let mut tasks = IO_REPLAY_TASKS.lock().await;
    for (_, task) in tasks.drain() {
        task.cancel.send_replace(true);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::Instant;

    fn capture(spacing_ms: u64, count: u64) -> Vec<u64> {
        (0..count).map(|n| 1_000_000 + n * spacing_ms * 1000).collect()
    }

    async fn replay_with_send_cost(timestamps_us: &[u64], speed: f64, send_cost: Duration) -> Duration {
        let started = Instant::now();
        let mut schedule = ReplaySchedule::new(speed);
        for &timestamp_us in timestamps_us {
            schedule.wait_for(timestamp_us).await;
            tokio::time::sleep(send_cost).await;
        }
        started.elapsed()
    }

    #[tokio::test(start_paused = true)]
    async fn replay_keeps_to_the_capture_schedule_when_a_send_is_slow() {
        let elapsed = replay_with_send_cost(&capture(5, 101), 1.0, Duration::from_millis(2)).await;
        assert_eq!(elapsed, Duration::from_millis(502), "500 ms of capture plus the last send");
    }

    #[tokio::test(start_paused = true)]
    async fn replay_scales_the_schedule_by_its_speed() {
        let elapsed = replay_with_send_cost(&capture(10, 11), 10.0, Duration::ZERO).await;
        assert_eq!(elapsed, Duration::from_millis(10));
    }

    #[tokio::test(start_paused = true)]
    async fn replay_caps_a_long_gap_in_the_capture() {
        let elapsed = replay_with_send_cost(&[0, 60_000_000], 1.0, Duration::ZERO).await;
        assert_eq!(elapsed, Duration::from_micros(MAX_SLEEP_US));
    }
}
