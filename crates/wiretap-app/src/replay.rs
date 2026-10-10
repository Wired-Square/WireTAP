// ui/crates/wiretap-app/src/replay.rs
//
// Time-accurate frame replay — plays back a set of captured frames to a target
// session, preserving the original inter-frame timing scaled by a speed multiplier.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use tokio::sync::watch;

use crate::io::{self, CanTransmitFrame};

// ============================================================================
// Types
// ============================================================================

/// A single frame with its original capture timestamp, used for time-accurate replay.
#[derive(Clone, Debug)]
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
                data: if f.is_rtr { vec![0; f.dlc.into()] } else { f.bytes.clone() },
                bus: f.bus,
                is_extended: f.is_extended,
                is_fd: f.is_fd,
                is_brs: f.is_brs,
                is_rtr: f.is_rtr,
            },
        }
    }
}

/// The frames a replay plays: `count` from `offset` in a capture, CAN only,
/// every one on `bus` when it is set.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
pub struct ReplaySource {
    pub capture_id: String,
    pub offset: usize,
    pub count: usize,
    pub bus: Option<u8>,
}

impl ReplaySource {
    fn frames(&self) -> Vec<ReplayFrame> {
        let (frames, _, _) = crate::capture_store::get_capture_frames_paginated(&self.capture_id, self.offset, self.count);
        frames
            .iter()
            .filter(|f| f.protocol == "can" || f.protocol == "canfd")
            .map(|f| {
                let mut replay = ReplayFrame::from(f);
                if let Some(bus) = self.bus {
                    replay.frame.bus = bus;
                }
                replay
            })
            .collect()
    }
}

/// What a replay of a source would take, before it starts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ReplayEstimate {
    pub frame_count: usize,
    /// Last frame's timestamp less the first's.
    pub span_us: u64,
    /// One pass on the replay's schedule at the asked speed.
    pub pass_duration_us: u64,
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
const MIN_SPEED: f64 = 0.001;

const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

fn scheduled_gap_us(delta_us: u64, speed: f64) -> u64 {
    (((delta_us as f64) / speed).round() as u64).min(MAX_SLEEP_US)
}

fn pass_duration_us(frames: &[ReplayFrame], speed: f64) -> u64 {
    let speed = speed.max(MIN_SPEED);
    frames.windows(2).map(|pair| scheduled_gap_us(pair[1].timestamp_us.saturating_sub(pair[0].timestamp_us), speed)).sum()
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
        let speed = speed.max(MIN_SPEED);
        let pass_duration_us = pass_duration_us(&frames, speed);
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

                crate::transmit::record_can(session_id, frame, &result);
                if let Some(error) = crate::transmit::permanent_failure(session_id, &result).await {
                    tlog!("[replay] Stopping replay '{}' due to permanent error: {}", self.replay_id, error);
                    break 'outer ReplayEvent::Failed { error };
                }
                if result.as_ref().is_ok_and(|r| r.success) {
                    frames_sent += 1;
                } else {
                    frames_failed += 1;
                }

                if last_progress.elapsed() >= PROGRESS_INTERVAL {
                    emit(&self.state(ReplayEvent::Progress, frames_sent, pass));
                    crate::ws::dispatch::send_transmit_updated(crate::transmit_history::next_revision());
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
        crate::ws::dispatch::send_transmit_updated(crate::transmit_history::next_revision());
        emit(&self.state(end, frames_sent, pass));
    }
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// What a replay was started with, kept so it can be played again.
#[derive(Clone)]
struct Recipe {
    session_id: String,
    source: ReplaySource,
    speed: f64,
    loop_replay: bool,
}

const RECIPES_KEPT: usize = 64;

static RECIPES: Lazy<std::sync::Mutex<VecDeque<(String, Recipe)>>> = Lazy::new(Default::default);

fn recipes() -> std::sync::MutexGuard<'static, VecDeque<(String, Recipe)>> {
    RECIPES.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// How long a replay of `source` would take at `speed`, by the schedule it would keep.
#[tauri::command]
pub fn replay_estimate(source: ReplaySource, speed: f64) -> ReplayEstimate {
    estimate(&source.frames(), speed)
}

fn estimate(frames: &[ReplayFrame], speed: f64) -> ReplayEstimate {
    let span_us = match (frames.first(), frames.last()) {
        (Some(first), Some(last)) => last.timestamp_us.saturating_sub(first.timestamp_us),
        _ => 0,
    };
    ReplayEstimate { frame_count: frames.len(), span_us, pass_duration_us: pass_duration_us(frames, speed) }
}

/// Start a time-accurate replay of `source` through a session.
///
/// Frames are transmitted in order with delays derived from their original timestamps
/// divided by `speed`. A speed of 1.0 is realtime; 2.0 is twice as fast.
///
/// Progress is pushed to the frontend as `ReplayState` WS messages.
#[tauri::command]
pub async fn io_start_replay(
    session_id: String,
    replay_id: String,
    source: ReplaySource,
    speed: f64,
    loop_replay: bool,
) -> Result<usize, String> {
    start(replay_id, Recipe { session_id, source, speed, loop_replay }).await
}

/// Play a replay again from its start, with what it was started with.
#[tauri::command]
pub async fn io_restart_replay(replay_id: String) -> Result<usize, String> {
    let recipe = recipes().iter().find(|(id, _)| *id == replay_id).map(|(_, r)| r.clone());
    start(replay_id, recipe.ok_or("This replay can no longer be restarted")?).await
}

/// Starts a replay and returns how many frames it plays.
async fn start(replay_id: String, recipe: Recipe) -> Result<usize, String> {
    let frames = recipe.source.frames();
    if frames.is_empty() {
        return Err("No frames to replay".to_string());
    }
    let count = frames.len();

    // The old run's last event goes out before this run's first.
    io_stop_replay(replay_id.clone()).await?;

    {
        let mut kept = recipes();
        kept.retain(|(id, _)| *id != replay_id);
        if kept.len() == RECIPES_KEPT {
            kept.pop_front();
        }
        kept.push_back((replay_id.clone(), recipe.clone()));
    }

    let (cancel, cancelled) = watch::channel(false);
    let replay = Replay::new(recipe.session_id, replay_id.clone(), frames, recipe.speed, recipe.loop_replay);
    let handle = tauri::async_runtime::spawn(async move {
        replay.run(cancelled, crate::ws::dispatch::send_replay_state).await;
        IO_REPLAY_TASKS.lock().await.remove(&replay.replay_id);
    });
    IO_REPLAY_TASKS.lock().await.insert(replay_id, ReplayTask { cancel, handle });
    Ok(count)
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

    /// The `rust` column of the table `ReplayDialog.tsx`'s estimate is checked against.
    #[test]
    fn the_pass_estimate_matches_the_rule_table() {
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../../frontend/wiretap-ui/src/tests/fixtures/data/replayEstimate.json"
        ))
        .expect("table");
        for row in table["rows"].as_array().expect("rows") {
            let timestamps: Vec<u64> =
                row["timestamps_us"].as_array().expect("timestamps").iter().map(|t| t.as_u64().expect("u64")).collect();
            let speed = row["speed"].as_f64().expect("speed");
            let replay = Replay::new("s".into(), "r".into(), frames(&timestamps), speed, false);
            assert_eq!(Some(replay.pass_duration_us), row["rust"].as_u64(), "{}", row["name"]);
        }
    }

    fn capture_of(frames: &[(&str, u64)]) -> String {
        crate::capture_db::use_in_memory_database();
        let id = crate::capture_store::create_standalone_capture(crate::capture_store::CaptureKind::Frames, "replay".into());
        let frames = frames
            .iter()
            .map(|&(protocol, timestamp_us)| io::FrameMessage { protocol: protocol.into(), timestamp_us, frame_id: 0x100, dlc: 1, bytes: vec![1], ..Default::default() })
            .collect();
        crate::capture_store::append_frames_to_capture(&id, frames);
        id
    }

    #[test]
    fn an_estimate_reads_the_range_as_the_replay_plays_it() {
        let capture_id = capture_of(&[("can", 0), ("can", 10_000), ("modbus", 20_000), ("canfd", 60_010_000), ("can", 70_000_000)]);
        let source = ReplaySource { capture_id, offset: 0, count: 4, bus: Some(2) };

        assert_eq!(
            replay_estimate(source.clone(), 1.0),
            ReplayEstimate { frame_count: 3, span_us: 60_010_000, pass_duration_us: 10_000 + MAX_SLEEP_US }
        );
        assert!(source.frames().iter().all(|f| f.frame.bus == 2));
    }

    #[tokio::test]
    async fn a_restart_plays_what_the_replay_was_started_with() {
        let id = "f_replay_restart";
        crate::io_test::tests::open_virtual_loopback(id).await;
        let source = ReplaySource { capture_id: capture_of(&[("can", 0), ("can", 0)]), offset: 0, count: 2, bus: None };

        assert_eq!(io_start_replay(id.into(), "r_restart".into(), source, 1.0, false).await, Ok(2));
        assert_eq!(io_restart_replay("r_restart".into()).await, Ok(2));
        assert!(io_restart_replay("r_never_started".into()).await.is_err());
        io_stop_replay("r_restart".into()).await.unwrap();
        crate::io::destroy_session(id, false).await.ok();
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

    #[test]
    fn a_replayed_remote_frame_goes_out_as_a_remote_frame_for_its_length() {
        let rtr = io::FrameMessage { protocol: "can".into(), frame_id: 0x123, dlc: 4, is_rtr: true, ..Default::default() };
        let frame = ReplayFrame::from(&rtr).frame;
        assert!(frame.is_rtr);
        assert_eq!(frame.data, [0; 4]);
    }

    #[test]
    fn a_replayed_fd_frame_keeps_its_bit_rate_switch() {
        let fd = io::FrameMessage { protocol: "can".into(), dlc: 12, bytes: vec![1; 12], is_fd: true, is_brs: true, ..Default::default() };
        assert!(ReplayFrame::from(&fd).frame.is_brs);
    }
}
