// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// src-tauri/src/io/periodic.rs
//
// Shared cadence primitive for interval-driven loops.
//
// Both the transmit "repeat" tasks (transmit.rs) and the Modbus TCP poll tasks
// (io/modbus_tcp/reader.rs) run the same skeleton: fire an action immediately,
// then once every N ms, stopping when a cancel flag is set, and (for Modbus)
// skipping ticks while a pause flag is set. The per-tick body differs — transmit
// pushes a frame and logs history; a poll does a request/response and emits a
// frame — but the timing/cancel/pause logic is identical. `Cadence` owns that
// triad so the two sites share one source of truth instead of hand-rolling it.
//
// The per-tick mutable state (throttle, error counters) stays in the caller's
// task, so a closure-based runner isn't used here — that would force the state
// into Arc/Mutex or run into async-closure `Send` limitations on stable Rust.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::time::{interval, Duration, Interval};

/// Drives an interval loop with cancel and optional pause support.
///
/// The first `next()` returns immediately (tokio's interval fires its first
/// tick straight away), so the action runs without waiting a full interval;
/// subsequent ticks are spaced by `interval_ms`.
pub struct Cadence {
    timer: Interval,
    cancel: Arc<AtomicBool>,
    pause: Option<Arc<AtomicBool>>,
}

impl Cadence {
    /// Create a cadence firing every `interval_ms`. `cancel` stops the loop when
    /// set; while `pause` is `Some(flag)` and set, ticks are skipped (the timer
    /// keeps running, so resume is immediate).
    pub fn new(interval_ms: u64, cancel: Arc<AtomicBool>, pause: Option<Arc<AtomicBool>>) -> Self {
        Self {
            timer: interval(Duration::from_millis(interval_ms)),
            cancel,
            pause,
        }
    }

    /// Await the next due tick.
    ///
    /// Returns `Some(())` when the caller should run its per-tick body, or
    /// `None` when the loop should stop (cancel flag set). Paused ticks are
    /// awaited internally until one is due or the loop is cancelled, so callers
    /// can simply write `while cadence.next().await.is_some() { ... }`.
    pub async fn next(&mut self) -> Option<()> {
        loop {
            self.timer.tick().await;

            if self.cancel.load(Ordering::Relaxed) {
                return None;
            }

            // Skip reads while paused (timer keeps ticking, so resume is immediate).
            if self
                .pause
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Relaxed))
            {
                continue;
            }

            return Some(());
        }
    }
}
