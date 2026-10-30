//! Recorded frames played back at a speed against the wall clock: the shared
//! pause, speed, direction and cancel flags, and the pacer that holds each
//! frame until it is due.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use tokio::time::Instant;

/// A recorded frame's capture time, in epoch microseconds.
pub trait Timestamped {
    fn timestamp_us(&self) -> u64;
}

/// Playback control shared between whoever drives a recorded source and the
/// task playing it. A clone shares the same flags.
#[derive(Debug, Clone)]
pub struct PlaybackControl {
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    pacing_enabled: Arc<AtomicBool>,
    /// `f64` bits; kept at the last positive speed while pacing is off.
    speed: Arc<AtomicU64>,
    reverse: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Speed cannot be negative")]
pub struct NegativeSpeed;

impl PlaybackControl {
    /// `0` plays unpaced, as fast as the frames come; above that it is a
    /// multiplier, `1.0` being real time.
    pub fn new(initial_speed: f64) -> Self {
        let pacing_enabled = initial_speed > 0.0;
        let speed = if pacing_enabled { initial_speed } else { 1.0 };
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            pause: Arc::new(AtomicBool::new(false)),
            pacing_enabled: Arc::new(AtomicBool::new(pacing_enabled)),
            speed: Arc::new(AtomicU64::new(speed.to_bits())),
            reverse: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Clears cancel, pause and reverse for a new stream; the speed stays.
    pub fn reset(&self) {
        self.cancel.store(false, Ordering::Relaxed);
        self.pause.store(false, Ordering::Relaxed);
        self.reverse.store(false, Ordering::Relaxed);
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn pause(&self) {
        self.pause.store(true, Ordering::Relaxed);
    }

    pub fn resume(&self) {
        self.pause.store(false, Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.pause.load(Ordering::Relaxed)
    }

    pub fn set_reverse(&self, reverse: bool) {
        self.reverse.store(reverse, Ordering::Relaxed);
    }

    pub fn is_reverse(&self) -> bool {
        self.reverse.load(Ordering::Relaxed)
    }

    pub fn read_speed(&self) -> f64 {
        f64::from_bits(self.speed.load(Ordering::Relaxed))
    }

    pub fn is_pacing_enabled(&self) -> bool {
        self.pacing_enabled.load(Ordering::Relaxed)
    }

    /// `0` turns pacing off and keeps the last speed; above that it paces at
    /// the new speed.
    pub fn set_speed(&self, speed: f64) -> Result<(), NegativeSpeed> {
        if speed < 0.0 {
            return Err(NegativeSpeed);
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

/// Unpaced.
impl Default for PlaybackControl {
    fn default() -> Self {
        Self::new(0.0)
    }
}

/// Where a pacer's frames go.
pub trait Playout<F> {
    fn frames(&mut self, frames: Vec<F>);
    /// The playback reached `timestamp_us`, `emitted` frames in.
    fn position(&mut self, timestamp_us: i64, emitted: i64);
}

/// Frames held per batch at unlimited speed, and the pause after each batch.
#[derive(Debug, Clone, Copy)]
pub struct Unlimited {
    pub batch: usize,
    pub yield_ms: u64,
}

/// What a pacer has done so far.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PacerStats {
    pub emitted: i64,
    pub waits: u64,
    pub waited_ms: u64,
}

/// Frames per batch while paced faster than one frame a millisecond.
const HIGH_SPEED_BATCH_SIZE: usize = 50;
/// A paced frame due sooner than this joins a batch rather than waiting.
const MIN_DELAY_MS: f64 = 1.0;
/// Most time (ms) a paced batch is held before it goes out.
const PACING_INTERVAL_MS: u64 = 50;

/// Plays frames at the control's speed against the wall clock, in either
/// direction of the recording.
#[derive(Debug)]
pub struct Pacer<F> {
    unlimited: Unlimited,
    pacing: bool,
    speed: f64,
    last_speed: f64,
    playback_baseline_secs: f64,
    wall_clock_baseline: Instant,
    last_pacing_check: Instant,
    last_frame_secs: Option<f64>,
    batch: Vec<F>,
    stats: PacerStats,
}

impl<F: Timestamped> Pacer<F> {
    pub fn new(start_secs: f64, control: &PlaybackControl, unlimited: Unlimited) -> Self {
        Self {
            unlimited,
            pacing: control.is_pacing_enabled(),
            speed: control.read_speed(),
            last_speed: control.read_speed(),
            playback_baseline_secs: start_secs,
            wall_clock_baseline: Instant::now(),
            last_pacing_check: Instant::now(),
            last_frame_secs: None,
            batch: Vec::new(),
            stats: PacerStats::default(),
        }
    }

    /// Reads the speed, measuring from the last frame when it changed, and waits
    /// out any lead the playback has built over the wall clock.
    pub async fn keep_time(&mut self, control: &PlaybackControl) {
        self.pacing = control.is_pacing_enabled();
        self.speed = control.read_speed();
        if !self.pacing {
            return;
        }
        if (self.speed - self.last_speed).abs() > 0.001 {
            self.rebaseline_at_last();
            self.last_speed = self.speed;
        }
        if let Some(last_secs) = self.last_frame_secs {
            let (expected_ms, actual_ms) = self.schedule(last_secs);
            if expected_ms > actual_ms + 100 {
                self.wait((expected_ms - actual_ms).min(500)).await;
            }
        }
    }

    /// Plays `frame`, handing it back when a pause came during its wait.
    pub async fn play(
        &mut self,
        frame: F,
        control: &PlaybackControl,
        out: &mut impl Playout<F>,
    ) -> Option<F> {
        let frame_secs = frame.timestamp_us() as f64 / 1_000_000.0;
        let playback_time_us = (frame_secs * 1_000_000.0) as i64;

        if !self.pacing {
            self.batch.push(frame);
            self.stats.emitted += 1;
            self.last_frame_secs = Some(frame_secs);
            if self.batch.len() >= self.unlimited.batch {
                out.frames(std::mem::take(&mut self.batch));
                out.position(playback_time_us, self.stats.emitted);
                tokio::time::sleep(Duration::from_millis(self.unlimited.yield_ms)).await;
            }
            return None;
        }

        let delay_ms = self.last_frame_secs.map_or(0.0, |last_secs| {
            (frame_secs - last_secs).abs() * 1000.0 / self.speed
        });
        self.last_frame_secs = Some(frame_secs);

        if delay_ms < MIN_DELAY_MS {
            self.batch.push(frame);
            self.stats.emitted += 1;
            let since_check_ms = self.last_pacing_check.elapsed().as_millis() as u64;
            if self.batch.len() >= HIGH_SPEED_BATCH_SIZE || since_check_ms >= PACING_INTERVAL_MS {
                let (expected_ms, actual_ms) = self.schedule(frame_secs);
                if expected_ms > actual_ms {
                    self.wait((expected_ms - actual_ms).min(1000)).await;
                }
                self.last_pacing_check = Instant::now();
                out.frames(std::mem::take(&mut self.batch));
                out.position(playback_time_us, self.stats.emitted);
                tokio::task::yield_now().await;
            }
            return None;
        }

        if !self.batch.is_empty() {
            out.frames(std::mem::take(&mut self.batch));
        }
        let capped_delay_ms = delay_ms.min(10_000.0);
        if capped_delay_ms >= 1.0 {
            self.wait(capped_delay_ms as u64).await;
        }
        if control.is_paused() {
            return Some(frame);
        }
        self.stats.emitted += 1;
        out.frames(vec![frame]);
        out.position(playback_time_us, self.stats.emitted);
        None
    }

    /// Measures from `secs` with no frame played yet, as a seek lands.
    pub fn restart_at(&mut self, secs: f64) {
        self.playback_baseline_secs = secs;
        self.wall_clock_baseline = Instant::now();
        self.last_frame_secs = None;
    }

    /// Measures from the last frame played, as a change of direction does.
    pub fn rebaseline_at_last(&mut self) {
        if let Some(last_secs) = self.last_frame_secs {
            self.playback_baseline_secs = last_secs;
            self.wall_clock_baseline = Instant::now();
        }
    }

    /// Measures from now, and from the last frame played, at today's speed.
    pub fn resume(&mut self, control: &PlaybackControl) {
        self.wall_clock_baseline = Instant::now();
        if let Some(last_secs) = self.last_frame_secs {
            self.playback_baseline_secs = last_secs;
        }
        self.last_speed = control.read_speed();
    }

    pub fn wall_elapsed(&self) -> Duration {
        self.wall_clock_baseline.elapsed()
    }

    /// The capture time of the last frame played, in seconds.
    pub fn last_frame_secs(&self) -> Option<f64> {
        self.last_frame_secs
    }

    /// The frames held for the next batch, for a caller flushing at the end.
    pub fn take_batch(&mut self) -> Vec<F> {
        std::mem::take(&mut self.batch)
    }

    /// Drops the frames held for the next batch, as a seek does.
    pub fn clear_batch(&mut self) {
        self.batch.clear();
    }

    pub fn stats(&self) -> PacerStats {
        self.stats
    }

    /// The wall time (ms) playback at `secs` is due at, and the wall time gone,
    /// both since the baseline.
    fn schedule(&self, secs: f64) -> (u64, u64) {
        let playback_elapsed_secs = (secs - self.playback_baseline_secs).abs();
        let expected_ms = (playback_elapsed_secs * 1000.0 / self.speed) as u64;
        let actual_ms = self.wall_clock_baseline.elapsed().as_millis() as u64;
        (expected_ms, actual_ms)
    }

    async fn wait(&mut self, ms: u64) {
        self.stats.waits += 1;
        self.stats.waited_ms += ms;
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_speed_zero_disables_pacing() {
        let ctrl = PlaybackControl::new(0.0);
        assert!(!ctrl.is_pacing_enabled());
        assert!((ctrl.read_speed() - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_initial_speed_nonzero_enables_pacing() {
        let ctrl = PlaybackControl::new(2.0);
        assert!(ctrl.is_pacing_enabled());
        assert!((ctrl.read_speed() - 2.0).abs() < 0.001);
    }

    #[test]
    fn test_set_speed_zero_disables_pacing() {
        let ctrl = PlaybackControl::new(1.0);
        assert!(ctrl.is_pacing_enabled());

        ctrl.set_speed(0.0).unwrap();
        assert!(!ctrl.is_pacing_enabled());
    }

    #[test]
    fn test_set_speed_nonzero_enables_pacing() {
        let ctrl = PlaybackControl::new(0.0);
        assert!(!ctrl.is_pacing_enabled());

        ctrl.set_speed(1.5).unwrap();
        assert!(ctrl.is_pacing_enabled());
        assert!((ctrl.read_speed() - 1.5).abs() < 0.001);
    }

    #[test]
    fn test_set_speed_negative_fails() {
        let ctrl = PlaybackControl::new(1.0);
        assert_eq!(ctrl.set_speed(-1.0), Err(NegativeSpeed));
    }

    #[test]
    fn test_pause_resume() {
        let ctrl = PlaybackControl::new(1.0);
        assert!(!ctrl.is_paused());

        ctrl.pause();
        assert!(ctrl.is_paused());

        ctrl.resume();
        assert!(!ctrl.is_paused());
    }

    #[test]
    fn test_cancel() {
        let ctrl = PlaybackControl::new(1.0);
        assert!(!ctrl.is_cancelled());

        ctrl.cancel();
        assert!(ctrl.is_cancelled());
    }

    #[test]
    fn test_reset() {
        let ctrl = PlaybackControl::new(1.0);
        ctrl.cancel();
        ctrl.pause();
        assert!(ctrl.is_cancelled());
        assert!(ctrl.is_paused());

        ctrl.reset();
        assert!(!ctrl.is_cancelled());
        assert!(!ctrl.is_paused());
    }

    #[derive(Debug, PartialEq)]
    struct At(u64);

    impl Timestamped for At {
        fn timestamp_us(&self) -> u64 {
            self.0
        }
    }

    #[derive(Default)]
    struct Out {
        batches: Vec<Vec<u64>>,
        positions: Vec<(i64, i64)>,
    }

    impl Playout<At> for Out {
        fn frames(&mut self, frames: Vec<At>) {
            self.batches.push(frames.into_iter().map(|f| f.0).collect());
        }

        fn position(&mut self, timestamp_us: i64, emitted: i64) {
            self.positions.push((timestamp_us, emitted));
        }
    }

    const UNLIMITED: Unlimited = Unlimited {
        batch: 2,
        yield_ms: 5,
    };

    async fn play_all(
        pacer: &mut Pacer<At>,
        control: &PlaybackControl,
        out: &mut Out,
        timestamps: impl IntoIterator<Item = u64>,
    ) {
        for t in timestamps {
            assert_eq!(pacer.play(At(t), control, out).await, None);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn unpaced_frames_go_out_in_batches_of_the_unlimited_size() {
        let control = PlaybackControl::new(0.0);
        let mut pacer = Pacer::new(0.0, &control, UNLIMITED);
        let mut out = Out::default();

        play_all(&mut pacer, &control, &mut out, [0, 1_000_000, 2_000_000]).await;

        assert_eq!(out.batches, vec![vec![0, 1_000_000]]);
        assert_eq!(out.positions, vec![(1_000_000, 2)]);
        assert_eq!(pacer.take_batch(), vec![At(2_000_000)]);
        assert_eq!(pacer.wall_elapsed(), Duration::from_millis(5), "one yield");
        assert_eq!(pacer.stats().waits, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn frames_under_a_millisecond_apart_go_out_fifty_at_a_time_on_schedule() {
        let control = PlaybackControl::new(1.0);
        let mut pacer = Pacer::new(0.0, &control, UNLIMITED);
        let mut out = Out::default();

        play_all(&mut pacer, &control, &mut out, (0..51).map(|i| i * 500)).await;

        assert_eq!(out.batches.len(), 1);
        assert_eq!(out.batches[0].len(), 50);
        assert_eq!(out.positions, vec![(24_500, 50)]);
        assert_eq!(
            pacer.stats(),
            PacerStats {
                emitted: 51,
                waits: 1,
                waited_ms: 24
            },
            "the batch is held until its last frame is due"
        );
        assert_eq!(pacer.take_batch(), vec![At(25_000)]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_gap_is_waited_out_but_never_for_more_than_ten_seconds() {
        let control = PlaybackControl::new(1.0);
        let mut pacer = Pacer::new(0.0, &control, UNLIMITED);
        let mut out = Out::default();

        play_all(&mut pacer, &control, &mut out, [0, 60_000_000]).await;

        assert_eq!(out.batches, vec![vec![0], vec![60_000_000]]);
        assert_eq!(pacer.stats().waited_ms, 10_000);
        assert_eq!(pacer.wall_elapsed(), Duration::from_secs(10));
    }

    #[tokio::test(start_paused = true)]
    async fn a_pause_during_the_wait_hands_the_frame_back() {
        let control = PlaybackControl::new(1.0);
        let mut pacer = Pacer::new(0.0, &control, UNLIMITED);
        let mut out = Out::default();
        play_all(&mut pacer, &control, &mut out, [0]).await;

        control.pause();
        let handed_back = pacer.play(At(5_000), &control, &mut out).await;

        assert_eq!(handed_back, Some(At(5_000)));
        assert_eq!(out.batches, vec![vec![0]], "only the held batch went out");
        assert_eq!(pacer.stats().emitted, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_speed_change_measures_from_the_last_frame_not_the_start() {
        let control = PlaybackControl::new(1.0);
        let mut pacer = Pacer::new(0.0, &control, UNLIMITED);
        let mut out = Out::default();
        play_all(&mut pacer, &control, &mut out, [0, 10_000_000]).await;
        let waits = pacer.stats().waits;

        // From the start, 10 s of capture at half speed is 20 s of wall time
        // against the 10 s gone, a lead keep_time would wait out.
        control.set_speed(0.5).unwrap();
        pacer.keep_time(&control).await;

        assert_eq!(pacer.stats().waits, waits);
        assert_eq!(pacer.wall_elapsed(), Duration::ZERO);
    }
}
