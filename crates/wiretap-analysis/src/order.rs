//! Message order: when each frame id is sent on each bus — the periods ids group
//! into, the ids that start a cycle and the order that follows them, mux and burst
//! timing — and which ids are seen on more than one bus.
//!
//! Frames are read **oldest first**; putting them in order is the caller's job, as
//! is running one call per protocol. Gaps and periods never cross buses. The
//! thresholds are the desktop's TypeScript ones, which the golden fixture under
//! `tests/fixtures/analysis` pins.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::roles::{detect_mux, MuxDetection};
use crate::scan::FrameKey;

/// A gap this long or longer ends a burst.
const BURST_GAP_MS: f64 = 50.0;
const PERIOD_BUCKETS_MS: [f64; 10] = [
    10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0,
];
/// A bucket, and a leftover group, take periods within ±30 % of its interval.
const PERIOD_TOLERANCE: f64 = 0.3;
/// A leftover period past 1.6× its group's shortest starts a new group.
const LEFTOVER_SPREAD: f64 = 1.6;
const START_CANDIDATES: usize = 5;
const AUTO_STARTS_TRIED: usize = 3;

/// One frame as message order reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimedFrame {
    pub bus: u8,
    pub key: FrameKey,
    pub timestamp_us: u64,
    pub payload: Vec<u8>,
}

/// Message order across a capture.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OrderAnalysis {
    pub total_frames: usize,
    pub unique_keys: usize,
    pub time_span_ms: f64,
    /// By bus.
    pub buses: Vec<BusOrder>,
    /// By key.
    pub multi_bus: Vec<MultiBusFrame>,
}

/// Message order on one bus.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BusOrder {
    pub bus: u8,
    pub frame_count: usize,
    /// Best first, by confidence × sequence length.
    pub patterns: Vec<CyclePattern>,
    /// By interval.
    pub interval_groups: Vec<IntervalGroup>,
    /// Longest gap before first.
    pub start_candidates: Vec<StartCandidate>,
    /// In order of first appearance.
    pub mux: Vec<MuxTiming>,
    /// In order of first appearance; never a mux id.
    pub bursts: Vec<BurstTiming>,
}

/// The order frames follow from a start id until one repeats.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CyclePattern {
    pub start: FrameKey,
    /// The most common sequence, the first reached on a tie.
    pub sequence: Vec<FrameKey>,
    /// Walks from the start id that reached a second id.
    pub occurrences: usize,
    /// The share of `occurrences` that follow `sequence`.
    pub confidence: f64,
    /// The median gap between starts of `sequence`; `None` when it starts once.
    pub cycle_ms: Option<f64>,
}

impl CyclePattern {
    fn score(&self) -> f64 {
        self.confidence * self.sequence.len() as f64
    }
}

/// Ids whose period falls within `interval_ms ± tolerance_ms`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IntervalGroup {
    pub interval_ms: f64,
    pub tolerance_ms: f64,
    /// Ascending.
    pub keys: Vec<FrameKey>,
}

/// An id that may start a cycle, by the gaps before it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StartCandidate {
    #[serde(flatten)]
    pub key: FrameKey,
    pub max_gap_before_ms: f64,
    pub avg_gap_before_ms: f64,
    pub min_gap_before_ms: f64,
    pub occurrences: usize,
}

/// A mux id's timing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MuxTiming {
    #[serde(flatten)]
    pub key: FrameKey,
    #[serde(flatten)]
    pub detection: MuxDetection,
    /// The median gap between frames of one case; `None` when no case repeats.
    pub mux_period_ms: Option<f64>,
    /// The median gap between frames of the id.
    pub inter_message_ms: f64,
}

/// An id sent in bursts, or at more than one length.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BurstTiming {
    #[serde(flatten)]
    pub key: FrameKey,
    /// 1 without a burst pattern.
    pub frames_per_burst: f64,
    /// Between burst starts, or the median gap without a burst pattern.
    pub burst_period_ms: f64,
    /// The median gap within a burst, or the median gap without a burst pattern.
    pub inter_message_ms: f64,
    /// Ascending.
    pub lengths: Vec<usize>,
    pub flags: Vec<BurstFlag>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum BurstFlag {
    VariableLength,
    /// At least two bursts averaging over 1.5 frames, the largest at most twice the
    /// smallest.
    BurstPattern,
    /// Bursts of 2–4 frames on average.
    RequestResponse,
}

/// An id seen on more than one bus.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MultiBusFrame {
    #[serde(flatten)]
    pub key: FrameKey,
    pub frames_per_bus: BTreeMap<u8, usize>,
}

/// Message order over oldest-first `frames`, cycles walked from `start` when it
/// occurs at least twice on a bus, or else from the likeliest start ids.
pub fn analyse_order(frames: &[TimedFrame], start: Option<FrameKey>) -> OrderAnalysis {
    let mut analysis = OrderAnalysis {
        total_frames: frames.len(),
        unique_keys: 0,
        time_span_ms: 0.0,
        buses: Vec::new(),
        multi_bus: Vec::new(),
    };
    let [first, .., last] = frames else {
        return analysis;
    };

    let mut by_bus: BTreeMap<u8, Vec<&TimedFrame>> = BTreeMap::new();
    let mut per_key: BTreeMap<FrameKey, BTreeMap<u8, usize>> = BTreeMap::new();
    for frame in frames {
        by_bus.entry(frame.bus).or_default().push(frame);
        *per_key
            .entry(frame.key)
            .or_default()
            .entry(frame.bus)
            .or_default() += 1;
    }

    analysis.unique_keys = per_key.len();
    analysis.time_span_ms = ms_between(first.timestamp_us, last.timestamp_us);
    analysis.buses = by_bus
        .into_iter()
        .map(|(bus, frames)| bus_order(bus, &frames, start))
        .collect();
    analysis.multi_bus = per_key
        .into_iter()
        .filter(|(_, buses)| buses.len() > 1)
        .map(|(key, frames_per_bus)| MultiBusFrame {
            key,
            frames_per_bus,
        })
        .collect();
    analysis
}

fn bus_order(bus: u8, frames: &[&TimedFrame], start: Option<FrameKey>) -> BusOrder {
    let by_key = group_by_key(frames);
    let mux: Vec<MuxTiming> = by_key
        .iter()
        .filter_map(|(key, frames)| mux_timing(*key, frames))
        .collect();
    let bursts: Vec<BurstTiming> = by_key
        .iter()
        .filter(|(key, _)| !mux.iter().any(|m| m.key == *key))
        .filter_map(|(key, frames)| burst_timing(*key, frames))
        .collect();
    let periods = by_key
        .iter()
        .filter_map(|(key, frames)| {
            let special = mux
                .iter()
                .find(|m| m.key == *key)
                .map(|m| m.mux_period_ms.unwrap_or(m.inter_message_ms))
                .or_else(|| {
                    bursts
                        .iter()
                        .find(|b| b.key == *key)
                        .map(|b| b.burst_period_ms)
                });
            Some((*key, special.or_else(|| median_gap(frames))?))
        })
        .collect();
    let start_candidates = start_candidates(frames, &by_key);

    let tried: Vec<FrameKey> = match start {
        Some(key) => vec![key],
        None => start_candidates
            .iter()
            .take(AUTO_STARTS_TRIED)
            .map(|c| c.key)
            .collect(),
    };
    let mut patterns: Vec<CyclePattern> = tried
        .into_iter()
        .filter_map(|key| cycle_pattern(frames, key))
        .filter(|p| start.is_some() || (p.occurrences >= 2 && p.confidence >= 0.5))
        .collect();
    patterns.sort_by(|a, b| b.score().total_cmp(&a.score()));

    BusOrder {
        bus,
        frame_count: frames.len(),
        patterns,
        interval_groups: interval_groups(periods),
        start_candidates,
        mux,
        bursts,
    }
}

/// Frames per key, keys in order of first appearance.
fn group_by_key<'a>(frames: &[&'a TimedFrame]) -> Vec<(FrameKey, Vec<&'a TimedFrame>)> {
    let mut index: HashMap<FrameKey, usize> = HashMap::new();
    let mut groups: Vec<(FrameKey, Vec<&TimedFrame>)> = Vec::new();
    for &frame in frames {
        let i = *index.entry(frame.key).or_insert_with(|| {
            groups.push((frame.key, Vec::new()));
            groups.len() - 1
        });
        groups[i].1.push(frame);
    }
    groups
}

fn ms_between(earlier: u64, later: u64) -> f64 {
    (later as f64 - earlier as f64) / 1000.0
}

fn gaps_ms(frames: &[&TimedFrame]) -> Vec<f64> {
    frames
        .windows(2)
        .map(|w| ms_between(w[0].timestamp_us, w[1].timestamp_us))
        .collect()
}

/// `sorted[n / 2]`.
fn upper_median(mut values: Vec<f64>) -> Option<f64> {
    values.sort_by(f64::total_cmp);
    values.get(values.len() / 2).copied()
}

fn median_gap(frames: &[&TimedFrame]) -> Option<f64> {
    upper_median(gaps_ms(frames))
}

fn mux_timing(key: FrameKey, frames: &[&TimedFrame]) -> Option<MuxTiming> {
    let payloads: Vec<Vec<u8>> = frames.iter().map(|f| f.payload.clone()).collect();
    let detection = detect_mux(&payloads)?;
    let mut per_case: BTreeMap<u16, Vec<&TimedFrame>> = BTreeMap::new();
    for &frame in frames {
        if let Some(case) = detection.selector.key(&frame.payload) {
            per_case.entry(case).or_default().push(frame);
        }
    }
    Some(MuxTiming {
        key,
        mux_period_ms: upper_median(per_case.values().flat_map(|c| gaps_ms(c)).collect()),
        inter_message_ms: median_gap(frames)?,
        detection,
    })
}

fn burst_timing(key: FrameKey, frames: &[&TimedFrame]) -> Option<BurstTiming> {
    if frames.len() < 4 {
        return None;
    }
    let lengths: BTreeSet<usize> = frames.iter().map(|f| f.payload.len()).collect();
    let variable_length = lengths.len() > 1;
    let bursts: Vec<&[&TimedFrame]> = frames
        .chunk_by(|a, b| ms_between(a.timestamp_us, b.timestamp_us) < BURST_GAP_MS)
        .collect();
    let mean = frames.len() as f64 / bursts.len() as f64;
    let has_pattern = bursts.len() >= 2 && mean > 1.5;

    let mut timing = BurstTiming {
        key,
        frames_per_burst: 1.0,
        burst_period_ms: 0.0,
        inter_message_ms: 0.0,
        lengths: lengths.into_iter().collect(),
        flags: Vec::new(),
    };
    if variable_length {
        timing.flags.push(BurstFlag::VariableLength);
    }
    if !has_pattern {
        let gap = median_gap(frames)?;
        timing.burst_period_ms = gap;
        timing.inter_message_ms = gap;
        return variable_length.then_some(timing);
    }

    let sizes = bursts.iter().map(|b| b.len());
    let (smallest, largest) = (sizes.clone().min()?, sizes.max()?);
    if largest <= smallest * 2 {
        timing.flags.push(BurstFlag::BurstPattern);
    }
    if (2.0..=4.0).contains(&mean) {
        timing.flags.push(BurstFlag::RequestResponse);
    }
    let starts: Vec<&TimedFrame> = bursts.iter().map(|b| b[0]).collect();
    timing.frames_per_burst = mean;
    timing.burst_period_ms = median_gap(&starts)?;
    timing.inter_message_ms = upper_median(bursts.iter().flat_map(|b| gaps_ms(b)).collect())?;
    Some(timing)
}

fn interval_groups(mut periods: Vec<(FrameKey, f64)>) -> Vec<IntervalGroup> {
    let mut groups = Vec::new();
    for interval_ms in PERIOD_BUCKETS_MS {
        let tolerance_ms = interval_ms * PERIOD_TOLERANCE;
        let window = interval_ms - tolerance_ms..=interval_ms + tolerance_ms;
        let (inside, outside) = periods.into_iter().partition(|(_, p)| window.contains(p));
        periods = outside;
        groups.extend(IntervalGroup::of(interval_ms, tolerance_ms, inside));
    }

    periods.sort_by(|a, b| a.1.total_cmp(&b.1));
    let mut rest = periods.as_slice();
    while let Some(&(_, shortest)) = rest.first() {
        let n = rest
            .iter()
            .take_while(|(_, p)| *p <= shortest * LEFTOVER_SPREAD)
            .count()
            .max(1);
        let (cluster, tail) = rest.split_at(n);
        let interval_ms = upper_median(cluster.iter().map(|(_, p)| *p).collect())
            .unwrap_or_default()
            .round();
        groups.extend(IntervalGroup::of(
            interval_ms,
            interval_ms * PERIOD_TOLERANCE,
            cluster.to_vec(),
        ));
        rest = tail;
    }

    groups.sort_by(|a, b| a.interval_ms.total_cmp(&b.interval_ms));
    groups
}

impl IntervalGroup {
    fn of(interval_ms: f64, tolerance_ms: f64, members: Vec<(FrameKey, f64)>) -> Option<Self> {
        let mut keys: Vec<FrameKey> = members.into_iter().map(|(key, _)| key).collect();
        keys.sort();
        (!keys.is_empty()).then_some(Self {
            interval_ms,
            tolerance_ms,
            keys,
        })
    }
}

/// The gap before each occurrence is from the frame before it, of any id.
fn start_candidates(
    frames: &[&TimedFrame],
    by_key: &[(FrameKey, Vec<&TimedFrame>)],
) -> Vec<StartCandidate> {
    let mut gaps: HashMap<FrameKey, Vec<f64>> = HashMap::new();
    for w in frames.windows(2) {
        gaps.entry(w[1].key)
            .or_default()
            .push(ms_between(w[0].timestamp_us, w[1].timestamp_us));
    }
    let mut candidates: Vec<StartCandidate> = by_key
        .iter()
        .filter_map(|(key, occurrences)| {
            let gaps = gaps.get(key)?;
            Some(StartCandidate {
                key: *key,
                max_gap_before_ms: gaps.iter().copied().fold(f64::MIN, f64::max),
                avg_gap_before_ms: gaps.iter().sum::<f64>() / gaps.len() as f64,
                min_gap_before_ms: gaps.iter().copied().fold(f64::MAX, f64::min),
                occurrences: occurrences.len(),
            })
        })
        .collect();
    candidates.sort_by(|a, b| b.max_gap_before_ms.total_cmp(&a.max_gap_before_ms));
    candidates.truncate(START_CANDIDATES);
    candidates
}

/// From each occurrence of `start`, the ids that follow until one repeats; `None`
/// when `start` occurs fewer than twice or no walk reaches a second id.
fn cycle_pattern(frames: &[&TimedFrame], start: FrameKey) -> Option<CyclePattern> {
    let starts: Vec<usize> = (0..frames.len())
        .filter(|&i| frames[i].key == start)
        .collect();
    if starts.len() < 2 {
        return None;
    }
    let walks: Vec<(u64, Vec<FrameKey>)> = starts
        .iter()
        .filter_map(|&s| {
            let mut seen = HashSet::new();
            let sequence: Vec<FrameKey> = frames[s..]
                .iter()
                .map(|f| f.key)
                .take_while(|&key| seen.insert(key))
                .collect();
            (sequence.len() >= 2).then_some((frames[s].timestamp_us, sequence))
        })
        .collect();

    let mut counts: Vec<(&[FrameKey], usize)> = Vec::new();
    for (_, sequence) in &walks {
        match counts.iter_mut().find(|(s, _)| *s == sequence.as_slice()) {
            Some((_, n)) => *n += 1,
            None => counts.push((sequence, 1)),
        }
    }
    let (modal, n) = counts
        .into_iter()
        .reduce(|best, c| if c.1 > best.1 { c } else { best })?;

    let modal_starts: Vec<u64> = walks
        .iter()
        .filter(|(_, s)| s == modal)
        .map(|(t, _)| *t)
        .collect();
    let cycle_ms = upper_median(
        modal_starts
            .windows(2)
            .map(|w| ms_between(w[0], w[1]))
            .collect(),
    );
    Some(CyclePattern {
        start,
        sequence: modal.to_vec(),
        occurrences: walks.len(),
        confidence: n as f64 / walks.len() as f64,
        cycle_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(key: u32, ms: u64, payload: &[u8]) -> TimedFrame {
        TimedFrame {
            bus: 0,
            key: FrameKey::new(key, false),
            timestamp_us: ms * 1000,
            payload: payload.to_vec(),
        }
    }

    #[test]
    fn a_single_frame_counts_and_says_nothing_else() {
        let analysis = analyse_order(&[frame(1, 0, &[0])], None);
        assert_eq!(analysis.total_frames, 1);
        assert!(analysis.buses.is_empty());
    }

    #[test]
    fn leftover_periods_cluster_within_one_point_six_of_the_shortest() {
        let key = |id| FrameKey::new(id, false);
        let groups = interval_groups(vec![
            (key(1), 3.0),
            (key(2), 4.0),
            (key(3), 30.0),
            (key(4), 3000.0),
        ]);
        let intervals: Vec<(f64, Vec<FrameKey>)> = groups
            .into_iter()
            .map(|g| (g.interval_ms, g.keys))
            .collect();
        assert_eq!(
            intervals,
            vec![
                (4.0, vec![key(1), key(2)]),
                (30.0, vec![key(3)]),
                (3000.0, vec![key(4)]),
            ]
        );
    }

    #[test]
    fn a_mux_whose_cases_never_repeat_takes_its_message_gap_as_period() {
        let frames: Vec<TimedFrame> = (0..4).map(|i| frame(1, i as u64 * 3, &[i, 0])).collect();
        let bus = &analyse_order(&frames, None).buses[0];
        assert_eq!(bus.mux[0].mux_period_ms, None);
        assert_eq!(bus.interval_groups[0].interval_ms, 3.0);
    }
}
