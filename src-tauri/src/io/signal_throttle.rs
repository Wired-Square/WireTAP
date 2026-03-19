// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// src-tauri/src/io/signal_throttle.rs

use std::collections::HashMap;
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
}

impl SignalThrottle {
    pub fn new() -> Self {
        Self {
            last_signal: HashMap::new(),
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
                false
            }
            _ => {
                self.last_signal.insert(signal_name.to_string(), now);
                true
            }
        }
    }

    /// Clear all timestamps so the next signal of any name fires immediately.
    /// Call on stream stop to ensure a final flush signal reaches the frontend.
    pub fn flush(&mut self) {
        self.last_signal.clear();
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
    fn passes_after_interval() {
        let mut t = SignalThrottle::new();
        assert!(t.should_signal("test"));
        thread::sleep(Duration::from_millis(SIGNAL_INTERVAL_MS + 50));
        assert!(t.should_signal("test"));
    }
}
