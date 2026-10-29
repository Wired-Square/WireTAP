// ui/crates/wiretap-app/src/io/recorded/base.rs
//
// Shared control state for recorded sources (Capture, the WireTAP backend):
// their start/stop state machine and where their playback position goes.

use crate::io::replay::{PlaybackControl, Timestamped};

use crate::io::{
    signal_playback_position, store_playback_position, FrameMessage, IOState, PlaybackPosition,
    SignalThrottle,
};

impl Timestamped for FrameMessage {
    fn timestamp_us(&self) -> u64 {
        self.timestamp_us
    }
}

/// State management for recorded sources.
/// Encapsulates the common state machine (Stopped -> Running <-> Paused -> Stopped)
/// and reduces boilerplate in CaptureSource and BackendApiSource.
pub struct RecordedSourceState {
    pub control: PlaybackControl,
    pub state: IOState,
    pub session_id: String,
    pub task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl RecordedSourceState {
    /// Create a new source state with the given session ID and initial speed.
    pub fn new(session_id: String, speed: f64) -> Self {
        Self {
            control: PlaybackControl::new(speed),
            state: IOState::Stopped,
            session_id,
            task_handle: None,
        }
    }

    /// Check if the reader can start. Returns error if already running.
    pub fn check_can_start(&self) -> Result<(), String> {
        if self.state == IOState::Running || self.state == IOState::Paused {
            return Err("Source is already running".to_string());
        }
        Ok(())
    }

    /// Prepare for starting: reset control flags and set state to Starting.
    pub fn prepare_start(&mut self) {
        self.state = IOState::Starting;
        self.control.reset();
    }

    /// Mark as running after task is spawned.
    pub fn mark_running(&mut self, handle: tauri::async_runtime::JoinHandle<()>) {
        self.task_handle = Some(handle);
        self.state = IOState::Running;
    }

    /// Stop the reader: cancel, await task, set state to Stopped.
    pub async fn stop(&mut self) {
        self.control.cancel();
        if let Some(handle) = self.task_handle.take() {
            let _ = handle.await;
        }
        self.state = IOState::Stopped;
    }

    /// Pause playback. Returns error if not running.
    pub fn pause(&mut self) -> Result<(), String> {
        if self.state != IOState::Running {
            return Err("Source is not running".to_string());
        }
        self.control.pause();
        self.state = IOState::Paused;
        Ok(())
    }

    /// Resume playback. Returns error if not paused.
    pub fn resume(&mut self) -> Result<(), String> {
        if self.state != IOState::Paused {
            return Err("Source is not paused".to_string());
        }
        self.control.resume();
        self.state = IOState::Running;
        Ok(())
    }

    /// Set playback speed with logging.
    pub fn set_speed(&mut self, speed: f64, device_name: &str) -> Result<(), String> {
        if speed == 0.0 {
            tlog!(
                "[{}:{}] set_speed: disabling pacing (speed=0)",
                device_name, self.session_id
            );
        } else {
            tlog!(
                "[{}:{}] set_speed: enabling pacing at {}x",
                device_name, self.session_id, speed
            );
        }
        self.control.set_speed(speed).map_err(|e| e.to_string())
    }

    /// Get current state.
    pub fn state(&self) -> IOState {
        self.state.clone()
    }

    /// Get session ID reference.
    #[allow(dead_code)] // Used by IOSource trait implementations
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

/// Stores `position` and signals it, as often as `throttle` allows.
pub fn publish_position(
    session_id: &str,
    position: PlaybackPosition,
    throttle: &mut SignalThrottle,
) {
    store_playback_position(session_id, position);
    if throttle.should_signal("playback-position") {
        signal_playback_position(session_id);
    }
}

/// Stores `position` and signals it at once, as a seek does.
pub fn publish_position_now(session_id: &str, position: PlaybackPosition) {
    store_playback_position(session_id, position);
    signal_playback_position(session_id);
}
