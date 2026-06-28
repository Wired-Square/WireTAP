// Copyright 2026 Wired Square Pty Ltd
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
use tokio::time::{interval, sleep, Duration, Interval};

/// How often `next()` re-checks the cancel flag while waiting for the next tick.
/// Long intervals (e.g. a 30s Modbus poll) would otherwise keep the task — and the
/// connection it holds — alive long after `stop()` was requested, stalling teardown
/// and leaving the device busy for a restart. Bounding the wait to this makes
/// cancellation prompt without affecting tick timing (the timer still wins the
/// select when its deadline is sooner).
const CANCEL_POLL_MS: u64 = 100;

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
            // Wait for the next due tick, but wake at least every CANCEL_POLL_MS so a set
            // cancel flag is noticed promptly instead of after a full interval. The timer
            // still wins the select when its deadline is sooner, so tick timing is unchanged.
            loop {
                if self.cancel.load(Ordering::Relaxed) {
                    return None;
                }
                tokio::select! {
                    _ = self.timer.tick() => break,
                    _ = sleep(Duration::from_millis(CANCEL_POLL_MS)) => {}
                }
            }

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
