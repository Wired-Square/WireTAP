// Copyright 2026 Wired Square Pty Ltd
//
// crates/wiretap-app/src/io/signal_throttle.rs

use std::collections::{HashMap, HashSet};
use std::time::Instant;

/// Interval between throttled signals (500ms = 2Hz)
const SIGNAL_INTERVAL_MS: u64 = 500;

/// Per-session signal rate limiter.
///
/// Owned by each IO task (not shared globally). Tracks last emission time
/// per signal name. Continuous signals check `should_signal()` before emitting.
/// One-shot signals bypass the throttle entirely.
pub struct SignalThrottle {
    last_signal: HashMap<String, Instant>,
    suppressed: HashSet<String>,
}

impl SignalThrottle {
    pub fn new() -> Self {
        Self {
            last_signal: HashMap::new(),
            suppressed: HashSet::new(),
        }
    }

    /// Returns `true` if enough time has elapsed since the last signal.
    /// Updates the timestamp when returning true.
    pub fn should_signal(&mut self, signal_name: &str) -> bool {
        let now = Instant::now();
        match self.last_signal.get(signal_name) {
            Some(last)
                if now.duration_since(*last).as_millis() < SIGNAL_INTERVAL_MS as u128 =>
            {
                self.suppressed.insert(signal_name.to_string());
                false
            }
            _ => {
                self.last_signal.insert(signal_name.to_string(), now);
                self.suppressed.remove(signal_name);
                true
            }
        }
    }

    /// Whether a signal this throttle suppressed is now due. A burst that ends
    /// inside the interval is otherwise never signalled until more data arrives.
    pub fn owed(&mut self, signal_name: &str) -> bool {
        self.suppressed.contains(signal_name) && self.should_signal(signal_name)
    }

    /// Whether to signal now, given whether new data `landed`: on the leading
    /// edge, and once more when a suppressed signal falls due.
    pub fn ready(&mut self, signal_name: &str, landed: bool) -> bool {
        (landed && self.should_signal(signal_name)) || self.owed(signal_name)
    }

    /// Clear all timestamps so the next signal of any name fires immediately.
    /// Call on stream stop to ensure a final flush signal reaches the frontend.
    pub fn flush(&mut self) {
        self.last_signal.clear();
        self.suppressed.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn first_signal_always_passes() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
    }

    #[test]
    fn immediate_repeat_is_blocked() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
        assert!(!t.should_signal("test"));
    }

    #[test]
    fn different_names_are_independent() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("a"));
        assert!(t.should_signal("b"));
        assert!(!t.should_signal("a"));
    }

    #[test]
    fn flush_resets_all() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
        assert!(!t.should_signal("test"));
        t.flush();
        assert!(t.should_signal("test"));
    }

    #[test]
    fn a_suppressed_signal_is_owed_once_the_interval_passes() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
        assert!(!t.should_signal("test"));
        assert!(!t.owed("test"));
        thread::sleep(Duration::from_millis(SIGNAL_INTERVAL_MS + 50));
        assert!(t.owed("test"));
        assert!(!t.owed("test"));
    }

    #[test]
    fn nothing_is_owed_without_a_suppressed_signal() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
        thread::sleep(Duration::from_millis(SIGNAL_INTERVAL_MS + 50));
        assert!(!t.owed("test"));
    }

    #[test]
    fn data_landing_inside_the_interval_is_signalled_once_it_passes_without_more() {
        let mut t = SignalThrottle::new();
        assert!(t.ready("test", true));
        assert!(!t.ready("test", true));
        assert!(!t.ready("test", false));
        thread::sleep(Duration::from_millis(SIGNAL_INTERVAL_MS + 50));
        assert!(t.ready("test", false), "the held-back signal never came");
        assert!(!t.ready("test", false));
    }

    #[test]
    fn passes_after_interval() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
        thread::sleep(Duration::from_millis(SIGNAL_INTERVAL_MS + 50));
        assert!(t.should_signal("test"));
    }
}
