// Copyright 2026 Wired Square Pty Ltd
//
// crates/wiretap-app/src/io/periodic.rs
//
// Shared cadence primitive for interval-driven loops.
//
// The transmit "repeat" tasks (transmit.rs) run the same skeleton: fire an
// action immediately, then once every N ms, until cancelled.
// `Cadence` owns that so the sites share one source of truth.
//
// The per-tick mutable state stays in the caller's task, so a closure-based
// runner isn't used here — that would force the state into Arc/Mutex or run
// into async-closure `Send` limitations on stable Rust.

use tokio::time::{interval, Duration, Interval};
use tokio_util::sync::CancellationToken;

/// Drives an interval loop with cancel support.
///
/// The first `next()` returns immediately (tokio's interval fires its first
/// tick straight away), so the action runs without waiting a full interval;
/// subsequent ticks are spaced by `interval_ms`.
pub struct Cadence {
    timer: Interval,
    cancel: CancellationToken,
}

impl Cadence {
    /// Create a cadence firing every `interval_ms` until `cancel` is cancelled.
    pub fn new(interval_ms: u64, cancel: CancellationToken) -> Self {
        Self {
            timer: interval(Duration::from_millis(interval_ms)),
            cancel,
        }
    }

    /// Await the next due tick.
    ///
    /// Returns `Some(())` when the caller should run its per-tick body, or
    /// `None` once cancelled, so callers can simply write
    /// `while cadence.next().await.is_some() { ... }`.
    pub async fn next(&mut self) -> Option<()> {
        tokio::select! {
            biased;
            () = self.cancel.cancelled() => None,
            _ = self.timer.tick() => Some(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Instant;

    #[tokio::test(start_paused = true)]
    async fn the_first_tick_is_immediate_and_the_rest_are_an_interval_apart() {
        let mut cadence = Cadence::new(1_000, CancellationToken::new());
        let start = Instant::now();
        cadence.next().await.unwrap();
        assert_eq!(start.elapsed(), Duration::ZERO);
        cadence.next().await.unwrap();
        assert_eq!(start.elapsed(), Duration::from_millis(1_000));
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_mid_interval_is_seen_at_once() {
        let cancel = CancellationToken::new();
        let mut cadence = Cadence::new(10_000, cancel.clone());
        cadence.next().await.unwrap();
        let start = Instant::now();
        tokio::spawn({
            let cancel = cancel.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                cancel.cancel();
            }
        });
        assert!(cadence.next().await.is_none());
        assert_eq!(start.elapsed(), Duration::from_millis(250));
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_before_the_first_tick_stops_at_once() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut cadence = Cadence::new(1_000, cancel);
        assert!(cadence.next().await.is_none());
    }
}
