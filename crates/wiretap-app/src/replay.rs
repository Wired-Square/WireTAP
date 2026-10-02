// ui/crates/wiretap-app/src/replay.rs
//
// Time-accurate frame replay — plays back a set of captured frames to a target
// session, preserving the original inter-frame timing scaled by a speed multiplier.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    handle: tauri::async_runtime::JoinHandle<()>,
}

/// Map of replay_id -> ReplayTask for active replay operations.
static IO_REPLAY_TASKS: Lazy<tokio::sync::Mutex<HashMap<String, ReplayTask>>> =
    Lazy::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// What happened to a replay. `PassCompleted` is sent only when looping; a pass
/// that ends the replay ends it as `Finished`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplayEvent {
    Started,
    Progress,
    PassCompleted,
    Finished,
    Stopped,
    Failed { error: String },
}

/// Snapshot of a replay's progress, pushed to the frontend over WS.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ReplayState {
    pub event: ReplayEvent,
    pub replay_id: String,
    pub session_id: String,
    /// Frames sent since the replay started, over every pass.
    pub frames_sent: usize,
    pub total_frames: usize,
    pub speed: f64,
    pub loop_replay: bool,
    pub pass: usize,
    /// How long one pass takes on the replay's schedule.
    pub pass_duration_us: u64,
}

// Maximum inter-frame sleep to avoid hanging on large timestamp gaps (5 seconds).
const MAX_SLEEP_US: u64 = 5_000_000;

const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

fn scheduled_gap_us(delta_us: u64, speed: f64) -> u64 {
    (((delta_us as f64) / speed).round() as u64).min(MAX_SLEEP_US)
}

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
            self.due_us += scheduled_gap_us(timestamp_us.saturating_sub(previous_us), self.speed);
        }
        tokio::time::sleep_until(self.start + tokio::time::Duration::from_micros(self.due_us)).await;
    }
}

struct Replay {
    replay_id: String,
    session_id: String,
    frames: Vec<ReplayFrame>,
    speed: f64,
    loop_replay: bool,
    pass_duration_us: u64,
}

impl Replay {
    fn new(session_id: String, replay_id: String, frames: Vec<ReplayFrame>, speed: f64, loop_replay: bool) -> Self {
        let speed = speed.max(0.001);
        let pass_duration_us = frames
            .windows(2)
            .map(|pair| scheduled_gap_us(pair[1].timestamp_us.saturating_sub(pair[0].timestamp_us), speed))
            .sum();
        Self { replay_id, session_id, frames, speed, loop_replay, pass_duration_us }
    }

    fn state(&self, event: ReplayEvent, frames_sent: usize, pass: usize) -> ReplayState {
        ReplayState {
            event,
            replay_id: self.replay_id.clone(),
            session_id: self.session_id.clone(),
            frames_sent,
            total_frames: self.frames.len(),
            speed: self.speed,
            loop_replay: self.loop_replay,
            pass,
            pass_duration_us: self.pass_duration_us,
        }
    }

    /// Plays the frames until they end, the replay is cancelled or the device
    /// refuses for good, reporting each step through `emit`.
    async fn run(&self, mut cancelled: watch::Receiver<bool>, emit: impl Fn(&ReplayState)) {
        let session_id = self.session_id.as_str();
        let mut frames_sent = 0;
        let mut frames_failed = 0;
        let mut pass = 1;
        let mut last_progress = std::time::Instant::now();
        emit(&self.state(ReplayEvent::Started, 0, pass));

        let end = 'outer: loop {
            let mut schedule = ReplaySchedule::new(self.speed);
            for replay_frame in &self.frames {
                let frame = &replay_frame.frame;
                let send = async {
                    schedule.wait_for(replay_frame.timestamp_us).await;
                    io::transmit_frame_when_ready(session_id, frame).await
                };
                let result = tokio::select! {
                    _ = cancelled.wait_for(|stop| *stop) => break 'outer ReplayEvent::Stopped,
                    result = send => result,
                };

                let (success, error) = match &result {
                    Ok(r) => (r.success, r.error.clone()),
                    Err(e) => (false, Some(e.clone())),
                };
                let is_permanent = match &result {
                    Ok(r) => !r.success && r.error.as_deref().is_some_and(crate::transmit::is_permanent_error),
                    Err(e) => crate::transmit::transmit_refusal_is_permanent(session_id, e).await,
                };
                crate::transmit_history::write_entry(
                    session_id, "can",
                    Some(frame.frame_id as i64),
                    Some(frame.data.len() as i64),
                    &frame.data,
                    frame.bus as i64,
                    frame.is_extended,
                    frame.is_fd,
                    success,
                    error.as_deref(),
                );
                if is_permanent {
                    let error = error.unwrap_or_else(|| "Device error".to_string());
                    tlog!("[replay] Stopping replay '{}' due to permanent error: {}", self.replay_id, error);
                    break 'outer ReplayEvent::Failed { error };
                }
                if success {
                    frames_sent += 1;
                } else {
                    frames_failed += 1;
                }

                if last_progress.elapsed() >= PROGRESS_INTERVAL {
                    emit(&self.state(ReplayEvent::Progress, frames_sent, pass));
                    crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
                    last_progress = std::time::Instant::now();
                }
            }

            if !self.loop_replay {
                break ReplayEvent::Finished;
            }
            emit(&self.state(ReplayEvent::PassCompleted, frames_sent, pass));
            pass += 1;
        };

        tlog!("[replay] '{}' ended: {} sent, {} failed", self.replay_id, frames_sent, frames_failed);
        crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
        emit(&self.state(end, frames_sent, pass));
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
    session_id: String,
    replay_id: String,
    frames: Vec<ReplayFrame>,
    speed: f64,
    loop_replay: bool,
) -> Result<(), String> {
    if frames.is_empty() {
        return Err("No frames to replay".to_string());
    }

    // The old run's last event goes out before this run's first.
    io_stop_replay(replay_id.clone()).await?;

    let (cancel, cancelled) = watch::channel(false);
    let replay = Replay::new(session_id, replay_id.clone(), frames, speed, loop_replay);
    let handle = tauri::async_runtime::spawn(async move {
        replay.run(cancelled, crate::ws::dispatch::send_replay_state).await;
        IO_REPLAY_TASKS.lock().await.remove(&replay.replay_id);
    });
    IO_REPLAY_TASKS.lock().await.insert(replay_id, ReplayTask { cancel, handle });
    Ok(())
}

/// Stop an active replay by ID, returning once it has reported its stop.
#[tauri::command]
pub async fn io_stop_replay(replay_id: String) -> Result<(), String> {
    let task = IO_REPLAY_TASKS.lock().await.remove(&replay_id);
    if let Some(task) = task {
        stop(task).await;
    }
    Ok(())
}

/// Stop all active replays.
#[tauri::command]
pub async fn io_stop_all_replays() -> Result<(), String> {
    let tasks: Vec<ReplayTask> = IO_REPLAY_TASKS.lock().await.drain().map(|(_, task)| task).collect();
    for task in tasks {
        stop(task).await;
    }
    Ok(())
}

async fn stop(task: ReplayTask) {
    task.cancel.send_replace(true);
    let _ = task.handle.await;
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

    fn frames(timestamps_us: &[u64]) -> Vec<ReplayFrame> {
        timestamps_us
            .iter()
            .map(|&timestamp_us| ReplayFrame {
                timestamp_us,
                frame: CanTransmitFrame { frame_id: 0x100, data: vec![1], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false },
            })
            .collect()
    }

    #[test]
    fn the_pass_estimate_keeps_to_the_schedule() {
        let replay = |speed| Replay::new("s".into(), "r".into(), frames(&[0, 10_000, 60_010_000]), speed, false);
        assert_eq!(replay(1.0).pass_duration_us, 10_000 + MAX_SLEEP_US);
        assert_eq!(replay(10.0).pass_duration_us, 1_000 + MAX_SLEEP_US);
        assert_eq!(replay(0.0).pass_duration_us, 2 * MAX_SLEEP_US, "a speed of zero is floored, not divided by");
    }

    /// Runs a replay through `session_id`, cancelling it once `stop_when` holds
    /// for the events so far, and returns every event but the progress ticks.
    async fn events(
        session_id: &str,
        replay: Replay,
        stop_when: impl Fn(&[ReplayState]) -> bool,
    ) -> Vec<ReplayState> {
        let (cancel, cancelled) = watch::channel(false);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let run = tokio::spawn(async move { replay.run(cancelled, move |s| { let _ = tx.send(s.clone()); }).await });
        let mut seen = Vec::new();
        while let Some(state) = rx.recv().await {
            if state.event != ReplayEvent::Progress {
                seen.push(state);
            }
            if stop_when(&seen) {
                cancel.send_replace(true);
            }
        }
        run.await.unwrap();
        crate::io::destroy_session(session_id, false).await.ok();
        seen
    }

    fn kinds(states: &[ReplayState]) -> Vec<(ReplayEvent, usize, usize)> {
        states.iter().map(|s| (s.event.clone(), s.pass, s.frames_sent)).collect()
    }

    #[tokio::test]
    async fn a_looping_replay_reports_each_pass_then_its_stop() {
        let id = "f_replay_loop";
        crate::io_test::tests::open_virtual_loopback(id).await;
        let replay = Replay::new(id.into(), "r_loop".into(), frames(&[0, 0, 0]), 1.0, true);
        let passes = |seen: &[ReplayState]| seen.iter().filter(|s| s.event == ReplayEvent::PassCompleted).count();
        let seen = events(id, replay, |seen| passes(seen) >= 2).await;

        let (last, passes_seen) = seen.split_last().unwrap();
        assert_eq!(kinds(&passes_seen[..3]), [
            (ReplayEvent::Started, 1, 0),
            (ReplayEvent::PassCompleted, 1, 3),
            (ReplayEvent::PassCompleted, 2, 6),
        ]);
        assert!(passes_seen[1..].iter().all(|s| s.event == ReplayEvent::PassCompleted));
        assert_eq!(last.event, ReplayEvent::Stopped);
        assert_eq!(last.pass, passes_seen.len());
    }

    #[tokio::test]
    async fn a_stopped_replay_reports_its_start_then_its_stop() {
        let id = "f_replay_stop";
        crate::io_test::tests::open_virtual_loopback(id).await;
        let replay = Replay::new(id.into(), "r_stop".into(), frames(&[0, 60_000_000]), 1.0, false);
        let seen = events(id, replay, |seen| !seen.is_empty()).await;
        let events: Vec<_> = seen.iter().map(|s| (s.event.clone(), s.pass)).collect();
        assert_eq!(events, [(ReplayEvent::Started, 1), (ReplayEvent::Stopped, 1)]);
        assert_eq!(seen[1].pass_duration_us, MAX_SLEEP_US);
    }

    #[tokio::test]
    async fn a_replay_that_runs_out_reports_it_finished() {
        let id = "f_replay_end";
        crate::io_test::tests::open_virtual_loopback(id).await;
        let replay = Replay::new(id.into(), "r_end".into(), frames(&[0, 0]), 1.0, false);
        let seen = events(id, replay, |_| false).await;
        assert_eq!(kinds(&seen), [(ReplayEvent::Started, 1, 0), (ReplayEvent::Finished, 1, 2)]);
    }

    #[tokio::test]
    async fn a_replay_to_a_missing_session_fails_with_the_reason() {
        let replay = Replay::new("f_replay_gone".into(), "r_gone".into(), frames(&[0]), 1.0, true);
        let seen = events("f_replay_gone", replay, |_| false).await;
        assert_eq!(seen.len(), 2);
        assert!(matches!(&seen[1].event, ReplayEvent::Failed { error } if !error.is_empty()), "{:?}", seen[1].event);
    }
}
