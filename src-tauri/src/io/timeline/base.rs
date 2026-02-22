// ui/src-tauri/src/io/timeline/base.rs
//
// Shared control state for timeline readers (Buffer, CSV, PostgreSQL).
// These readers share identical pause/resume and speed control patterns.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

use crate::io::IOState;

/// Shared control state for timeline playback.
/// Used by BufferReader, CsvReader, and PostgresReader.
#[derive(Clone)]
pub struct TimelineControl {
    /// Set to true to cancel the stream
    pub cancel_flag: Arc<AtomicBool>,
    /// Set to true to pause playback
    pub pause_flag: Arc<AtomicBool>,
    /// Whether pacing is enabled (speed > 0)
    pub pacing_enabled: Arc<AtomicBool>,
    /// Playback speed as f64 bits (use read_speed/write_speed)
    pub speed: Arc<AtomicU64>,
    /// Set to true for reverse playback
    pub reverse_flag: Arc<AtomicBool>,
}

impl TimelineControl {
    /// Create new timeline control with the given initial speed.
    /// Speed of 0 means no pacing (unlimited speed).
    /// Speed > 0 enables pacing at that multiplier (1.0 = realtime).
    pub fn new(initial_speed: f64) -> Self {
        let pacing_enabled = initial_speed > 0.0;
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            pause_flag: Arc::new(AtomicBool::new(false)),
            pacing_enabled: Arc::new(AtomicBool::new(pacing_enabled)),
            speed: Arc::new(AtomicU64::new(if pacing_enabled {
                initial_speed.to_bits()
            } else {
                1.0_f64.to_bits()
            })),
            reverse_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Reset control flags for a new stream
    pub fn reset(&self) {
        self.cancel_flag.store(false, Ordering::Relaxed);
        self.pause_flag.store(false, Ordering::Relaxed);
        self.reverse_flag.store(false, Ordering::Relaxed);
    }

    /// Signal cancellation
    pub fn cancel(&self) {
        self.cancel_flag.store(true, Ordering::Relaxed);
    }

    /// Check if cancelled
    pub fn is_cancelled(&self) -> bool {
        self.cancel_flag.load(Ordering::Relaxed)
    }

    /// Pause playback
    pub fn pause(&self) {
        self.pause_flag.store(true, Ordering::Relaxed);
    }

    /// Resume playback
    pub fn resume(&self) {
        self.pause_flag.store(false, Ordering::Relaxed);
    }

    /// Check if paused
    pub fn is_paused(&self) -> bool {
        self.pause_flag.load(Ordering::Relaxed)
    }

    /// Set reverse playback
    pub fn set_reverse(&self, reverse: bool) {
        self.reverse_flag.store(reverse, Ordering::Relaxed);
    }

    /// Check if playing in reverse
    pub fn is_reverse(&self) -> bool {
        self.reverse_flag.load(Ordering::Relaxed)
    }

    /// Read the current playback speed
    pub fn read_speed(&self) -> f64 {
        f64::from_bits(self.speed.load(Ordering::Relaxed))
    }

    /// Check if pacing is enabled
    pub fn is_pacing_enabled(&self) -> bool {
        self.pacing_enabled.load(Ordering::Relaxed)
    }

    /// Set playback speed. Returns error if speed is negative.
    /// Speed of 0 disables pacing (unlimited speed).
    /// Speed > 0 enables pacing at that multiplier.
    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        if speed < 0.0 {
            return Err("Speed cannot be negative".to_string());
        }
        if speed == 0.0 {
            self.pacing_enabled.store(false, Ordering::Relaxed);
        } else {
            self.pacing_enabled.store(true, Ordering::Relaxed);
            self.speed.store(speed.to_bits(), Ordering::Relaxed);
        }
        Ok(())
    }
}

impl Default for TimelineControl {
    fn default() -> Self {
        Self::new(0.0) // No pacing by default
    }
}

/// Reader state management for timeline readers.
/// Encapsulates the common state machine (Stopped -> Running <-> Paused -> Stopped)
/// and reduces boilerplate in BufferReader, CsvReader, and PostgresReader.
pub struct TimelineReaderState {
    pub control: TimelineControl,
    pub state: IOState,
    pub session_id: String,
    pub task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl TimelineReaderState {
    /// Create a new reader state with the given session ID and initial speed.
    pub fn new(session_id: String, speed: f64) -> Self {
        Self {
            control: TimelineControl::new(speed),
            state: IOState::Stopped,
            session_id,
            task_handle: None,
        }
    }

    /// Check if the reader can start. Returns error if already running.
    pub fn check_can_start(&self) -> Result<(), String> {
        if self.state == IOState::Running || self.state == IOState::Paused {
            return Err("Reader is already running".to_string());
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
            return Err("Reader is not running".to_string());
        }
        self.control.pause();
        self.state = IOState::Paused;
        Ok(())
    }

    /// Resume playback. Returns error if not paused.
    pub fn resume(&mut self) -> Result<(), String> {
        if self.state != IOState::Paused {
            return Err("Reader is not paused".to_string());
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
        self.control.set_speed(speed)
    }

    /// Get current state.
    pub fn state(&self) -> IOState {
        self.state.clone()
    }

    /// Get session ID reference.
    #[allow(dead_code)] // Used by IODevice trait implementations
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_speed_zero_disables_pacing() {
        let ctrl = TimelineControl::new(0.0);
        assert!(!ctrl.is_pacing_enabled());
        assert!((ctrl.read_speed() - 1.0).abs() < 0.001); // Stores 1.0 when disabled
    }

    #[test]
    fn test_initial_speed_nonzero_enables_pacing() {
        let ctrl = TimelineControl::new(2.0);
        assert!(ctrl.is_pacing_enabled());
        assert!((ctrl.read_speed() - 2.0).abs() < 0.001);
    }

    #[test]
    fn test_set_speed_zero_disables_pacing() {
        let ctrl = TimelineControl::new(1.0);
        assert!(ctrl.is_pacing_enabled());

        ctrl.set_speed(0.0).unwrap();
        assert!(!ctrl.is_pacing_enabled());
    }

    #[test]
    fn test_set_speed_nonzero_enables_pacing() {
        let ctrl = TimelineControl::new(0.0);
        assert!(!ctrl.is_pacing_enabled());

        ctrl.set_speed(1.5).unwrap();
        assert!(ctrl.is_pacing_enabled());
        assert!((ctrl.read_speed() - 1.5).abs() < 0.001);
    }

    #[test]
    fn test_set_speed_negative_fails() {
        let ctrl = TimelineControl::new(1.0);
        assert!(ctrl.set_speed(-1.0).is_err());
    }

    #[test]
    fn test_pause_resume() {
        let ctrl = TimelineControl::new(1.0);
        assert!(!ctrl.is_paused());

        ctrl.pause();
        assert!(ctrl.is_paused());

        ctrl.resume();
        assert!(!ctrl.is_paused());
    }

    #[test]
    fn test_cancel() {
        let ctrl = TimelineControl::new(1.0);
        assert!(!ctrl.is_cancelled());

        ctrl.cancel();
        assert!(ctrl.is_cancelled());
    }

    #[test]
    fn test_reset() {
        let ctrl = TimelineControl::new(1.0);
        ctrl.cancel();
        ctrl.pause();
        assert!(ctrl.is_cancelled());
        assert!(ctrl.is_paused());

        ctrl.reset();
        assert!(!ctrl.is_cancelled());
        assert!(!ctrl.is_paused());
    }
}
