// Copyright 2026 Wired Square Pty Ltd
//
// crates/wiretap-app/src/io/periodic.rs
//
// Shared cadence primitive for interval-driven loops.
//
// The transmit "repeat" tasks (transmit.rs) run the same skeleton: fire an
// action immediately, then once every N ms, stopping when a cancel flag is set.
// `Cadence` owns that so the sites share one source of truth.
//
// The per-tick mutable state stays in the caller's task, so a closure-based
// runner isn't used here — that would force the state into Arc/Mutex or run
// into async-closure `Send` limitations on stable Rust.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::time::{interval, sleep, Duration, Interval};

/// How often `next()` re-checks the cancel flag while waiting for the next tick.
/// Long intervals would otherwise keep the task — and the
/// connection it holds — alive long after `stop()` was requested, stalling teardown
/// and leaving the device busy for a restart. Bounding the wait to this makes
/// cancellation prompt without affecting tick timing (the timer still wins the
/// select when its deadline is sooner).
const CANCEL_POLL_MS: u64 = 100;

/// Drives an interval loop with cancel support.
///
/// The first `next()` returns immediately (tokio's interval fires its first
/// tick straight away), so the action runs without waiting a full interval;
/// subsequent ticks are spaced by `interval_ms`.
pub struct Cadence {
    timer: Interval,
    cancel: Arc<AtomicBool>,
}

impl Cadence {
    /// Create a cadence firing every `interval_ms`. `cancel` stops the loop when
    /// set.
    pub fn new(interval_ms: u64, cancel: Arc<AtomicBool>) -> Self {
        Self {
            timer: interval(Duration::from_millis(interval_ms)),
            cancel,
        }
    }

    /// Await the next due tick.
    ///
    /// Returns `Some(())` when the caller should run its per-tick body, or
    /// `None` when the loop should stop (cancel flag set), so callers can simply
    /// write `while cadence.next().await.is_some() { ... }`.
    pub async fn next(&mut self) -> Option<()> {
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
        (!self.cancel.load(Ordering::Relaxed)).then_some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;

    #[tokio::test(start_paused = true)]
    async fn the_first_tick_is_immediate_and_the_rest_are_an_interval_apart() {
        let mut cadence = Cadence::new(1_000, Arc::new(AtomicBool::new(false)));
        let start = Instant::now();
        cadence.next().await.unwrap();
        assert_eq!(start.elapsed(), Duration::ZERO);
        cadence.next().await.unwrap();
        assert_eq!(start.elapsed(), Duration::from_millis(1_000));
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_set_mid_interval_is_seen_within_one_poll() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut cadence = Cadence::new(10_000, cancel.clone());
        cadence.next().await.unwrap();
        let start = Instant::now();
        tokio::spawn({
            let cancel = cancel.clone();
            async move {
                sleep(Duration::from_millis(250)).await;
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert!(cadence.next().await.is_none());
        assert_eq!(start.elapsed(), Duration::from_millis(300));
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_set_before_the_first_tick_stops_at_once() {
        let mut cadence = Cadence::new(1_000, Arc::new(AtomicBool::new(true)));
        assert!(cadence.next().await.is_none());
    }
}
