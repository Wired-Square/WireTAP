//! Byte roles: what each front-addressed column of one frame id's payloads does.
//!
//! Payloads are read **oldest first and contiguous**. Direction, trend and looping
//! all read consecutive pairs, so newest-first input flips every one of them and a
//! strided sample multiplies a counter's step. Putting the payloads in order is the
//! caller's job.
//!
//! The thresholds are the desktop's TypeScript classifier's, which the golden
//! fixture under `tests/fixtures/byte_roles` pins.

use std::collections::HashMap;
use std::hash::Hash;

use serde::{Deserialize, Serialize};
use wslib_checksum::columns::{analyse_columns_from, Anchor, ColumnStats};

pub mod multi;
pub mod mux;

pub use multi::{find_patterns, infer_endianness, Endianness, MultiBytePattern, PatternKind};
pub use mux::{detect_mux, is_mux_like_sequence, MuxAnalysis, MuxCase, MuxDetection, MuxSelector};

/// A counter's modal step must cover this share of its transitions.
const COUNTER_CONSISTENCY: f64 = 0.8;
/// A trending sensor moves this share of its moving transitions one way.
const SENSOR_TREND: f64 = 0.6;
/// A signed byte delta beyond this is read as a wrap through 0/255.
const ROLLOVER_FOLD: i16 = 200;

/// One column and the role it plays.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ByteColumn {
    #[serde(flatten)]
    pub stats: ColumnStats,
    #[serde(flatten)]
    pub role: ByteRole,
}

/// What a byte column does across the sample.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum ByteRole {
    Static {
        value: u8,
    },
    Counter {
        direction: Direction,
        step: u8,
        rollover: bool,
        looping: Option<Loop>,
    },
    Sensor {
        trend: Trend,
        strength: f64,
        rollover: bool,
    },
    Value,
    Unknown,
}

/// Which way a counter steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Up,
    Down,
}

/// Which way a sensor trends; `Mixed` oscillates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Trend {
    Increasing,
    Decreasing,
    Mixed,
}

/// The range a looping counter cycles through; `modulo` is `max - min + 1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Loop {
    pub min: u8,
    pub max: u8,
    pub modulo: u16,
}

/// The byte-level profile of one frame id's payloads.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ByteProfile {
    pub sample_count: usize,
    pub min_len: usize,
    pub max_len: usize,
    /// The payload, when there is more than one sample and every one is equal.
    pub identical: Option<Vec<u8>>,
    /// 0, or the first byte past a mux selector.
    pub analysed_from: usize,
    /// `analysed_from..max_len` over every payload; past `min_len` a column's
    /// `sample_count` says how many payloads reached it.
    pub columns: Vec<ByteColumn>,
    /// Over `columns`; a mux frame's cases carry their own.
    pub patterns: Vec<MultiBytePattern>,
    /// Across `patterns` and every mux case's.
    pub endianness: Option<Endianness>,
    pub mux: Option<MuxAnalysis>,
}

/// Profile oldest-first, contiguous `payloads`: mux detection, then byte roles
/// and multi-byte patterns.
pub fn profile_bytes(payloads: &[Vec<u8>]) -> ByteProfile {
    let lengths = payloads.iter().map(Vec::len);
    let identical = (payloads.len() > 1 && payloads.iter().all(|p| *p == payloads[0]))
        .then(|| payloads[0].clone());
    let mux = detect_mux(payloads).map(|detection| MuxAnalysis::of(detection, payloads));
    let analysed_from = mux.as_ref().map_or(0, |m| m.detection.selector.width());
    let columns = classify_columns(payloads, analysed_from);
    let patterns = find_patterns(payloads, &columns);
    let case_patterns = mux.iter().flat_map(|m| &m.cases).flat_map(|c| &c.patterns);

    ByteProfile {
        sample_count: payloads.len(),
        min_len: lengths.clone().min().unwrap_or(0),
        max_len: lengths.max().unwrap_or(0),
        identical,
        analysed_from,
        endianness: infer_endianness(patterns.iter().chain(case_patterns)),
        columns,
        patterns,
        mux,
    }
}

/// Classify every front-addressed column from byte `from` out to the longest
/// payload, from oldest-first, contiguous `payloads`.
pub fn classify_columns(payloads: &[Vec<u8>], from: usize) -> Vec<ByteColumn> {
    analyse_columns_from(payloads, Anchor::Front)
        .into_iter()
        .skip(from)
        .map(|stats| {
            let column: Vec<Option<u8>> = payloads
                .iter()
                .map(|p| p.get(stats.position as usize).copied())
                .collect();
            ByteColumn {
                role: classify(&stats, &column),
                stats,
            }
        })
        .collect()
}

/// `column` holds `None` where a payload is too short, which breaks the run as
/// it does in [`ColumnStats`].
fn classify(stats: &ColumnStats, column: &[Option<u8>]) -> ByteRole {
    if let Some(value) = stats.constant_value {
        return ByteRole::Static { value };
    }
    let pairs: Vec<(u8, u8)> = column
        .windows(2)
        .filter_map(|w| Some((w[0]?, w[1]?)))
        .collect();

    if let Some(role) = looping_counter(stats, &pairs) {
        return role;
    }
    if stats.distinct_values < 3 {
        return ByteRole::Value;
    }
    linear_counter(stats, &pairs)
        .or_else(|| sensor(stats, &pairs))
        .unwrap_or(
            if stats.distinct_values as f64 >= stats.sample_count as f64 * 0.1 {
                ByteRole::Value
            } else {
                ByteRole::Unknown
            },
        )
}

/// The signed delta, with anything past ±200 read as a wrap through 0/255.
fn folded_delta(prev: u8, next: u8) -> (i16, bool) {
    match next as i16 - prev as i16 {
        d if d < -ROLLOVER_FOLD => (d + 256, true),
        d if d > ROLLOVER_FOLD => (d - 256, true),
        d => (d, false),
    }
}

/// The most common delta, if it is non-zero and covers enough transitions to
/// call the column a counter. At 80 % the mode is unique, so ties cannot matter.
fn consistent_step<T: Copy + Eq + Hash + Default>(deltas: &[T]) -> Option<T> {
    let mut counts: HashMap<T, usize> = HashMap::new();
    for &d in deltas {
        *counts.entry(d).or_default() += 1;
    }
    let (&step, &n) = counts.iter().max_by_key(|(_, n)| **n)?;
    (step != T::default() && n as f64 / deltas.len() as f64 >= COUNTER_CONSISTENCY).then_some(step)
}

fn direction(step: i16) -> Direction {
    if step > 0 {
        Direction::Up
    } else {
        Direction::Down
    }
}

/// A counter cycling through a small range, wrapping max→min (or min→max).
fn looping_counter(stats: &ColumnStats, pairs: &[(u8, u8)]) -> Option<ByteRole> {
    let n = stats.sample_count;
    if n < 5 || !(2..=16).contains(&stats.distinct_values) {
        return None;
    }
    let (min, max) = (stats.min, stats.max);
    let modulo = (max - min) as u16 + 1;

    let mut wraps = 0usize;
    let deltas: Vec<i16> = pairs
        .iter()
        .map(|&(prev, next)| {
            if prev == max && next == min {
                wraps += 1;
                1
            } else if prev == min && next == max {
                wraps += 1;
                -1
            } else {
                next as i16 - prev as i16
            }
        })
        .collect();

    let min_wraps = if n >= 50 { 2 } else { 1 };
    if wraps < min_wraps {
        return None;
    }
    let step = consistent_step(&deltas)?;
    let complete = modulo as usize == stats.distinct_values;
    let expected_wraps = n / modulo as usize;
    (complete || wraps as f64 >= expected_wraps as f64 * 0.5).then_some(ByteRole::Counter {
        direction: direction(step),
        step: step.unsigned_abs() as u8,
        rollover: true,
        looping: Some(Loop { min, max, modulo }),
    })
}

fn linear_counter(stats: &ColumnStats, pairs: &[(u8, u8)]) -> Option<ByteRole> {
    if stats.sample_count < 3 {
        return None;
    }
    let (deltas, rolls): (Vec<i16>, Vec<bool>) =
        pairs.iter().map(|&(p, n)| folded_delta(p, n)).unzip();
    let step = consistent_step(&deltas)?;
    Some(ByteRole::Counter {
        direction: direction(step),
        step: step.unsigned_abs() as u8,
        rollover: rolls.contains(&true),
        looping: None,
    })
}

fn sensor(stats: &ColumnStats, pairs: &[(u8, u8)]) -> Option<ByteRole> {
    if stats.sample_count < 3 {
        return None;
    }
    let (mut increasing, mut decreasing, mut rollover) = (0usize, 0usize, false);
    for &(prev, next) in pairs {
        let (delta, rolled) = folded_delta(prev, next);
        rollover |= rolled;
        match delta.signum() {
            1 => increasing += 1,
            -1 => decreasing += 1,
            _ => {}
        }
    }
    let moving = increasing + decreasing;
    if moving == 0 {
        return None;
    }
    let (up, down) = (
        increasing as f64 / moving as f64,
        decreasing as f64 / moving as f64,
    );
    let trend = if up >= SENSOR_TREND {
        Trend::Increasing
    } else if down >= SENSOR_TREND {
        Trend::Decreasing
    } else if stats.distinct_values >= 3 && moving as f64 >= stats.sample_count as f64 * 0.5 {
        Trend::Mixed
    } else {
        return None;
    };
    Some(ByteRole::Sensor {
        trend,
        strength: up.max(down),
        rollover,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One column at byte 1, behind a constant byte 0.
    fn role_of(values: &[u8]) -> ByteRole {
        let payloads: Vec<Vec<u8>> = values.iter().map(|&v| vec![0xC0, v]).collect();
        classify_columns(&payloads, 1).remove(0).role
    }

    fn counter(direction: Direction, step: u8, rollover: bool) -> ByteRole {
        ByteRole::Counter {
            direction,
            step,
            rollover,
            looping: None,
        }
    }

    fn looping(step: u8, min: u8, max: u8) -> ByteRole {
        ByteRole::Counter {
            direction: Direction::Up,
            step,
            rollover: true,
            looping: Some(Loop {
                min,
                max,
                modulo: (max - min) as u16 + 1,
            }),
        }
    }

    fn trend_of(role: &ByteRole) -> Option<(Trend, f64)> {
        match role {
            ByteRole::Sensor {
                trend, strength, ..
            } => Some((*trend, *strength)),
            _ => None,
        }
    }

    #[test]
    fn one_value_is_static() {
        assert_eq!(role_of(&[7; 10]), ByteRole::Static { value: 7 });
    }

    #[test]
    fn a_loop_needs_five_samples() {
        assert_eq!(role_of(&[0, 1, 2, 0, 1]), looping(1, 0, 2));
        assert!(matches!(
            role_of(&[0, 1, 2, 0]),
            ByteRole::Sensor {
                trend: Trend::Increasing,
                ..
            }
        ));
    }

    #[test]
    fn a_loop_with_gaps_is_accepted_on_its_wraps() {
        let values: Vec<u8> = (0..20).map(|i| (i % 5) * 2).collect();
        assert_eq!(role_of(&values), looping(2, 0, 8));
    }

    #[test]
    fn a_loop_takes_at_most_sixteen_values() {
        let sixteen: Vec<u8> = (0..40).map(|i| i % 16).collect();
        assert_eq!(role_of(&sixteen), looping(1, 0, 15));

        let seventeen: Vec<u8> = (0..40).map(|i| i % 17).collect();
        assert_eq!(role_of(&seventeen), counter(Direction::Up, 1, false));
    }

    #[test]
    fn a_counter_steps_consistently_eighty_percent_of_the_time() {
        let eight_of_ten = [10, 11, 12, 13, 14, 15, 16, 17, 18, 23, 28];
        assert_eq!(role_of(&eight_of_ten), counter(Direction::Up, 1, false));

        let seven_of_ten = [10, 11, 12, 13, 14, 15, 16, 17, 22, 27, 32];
        assert!(!matches!(role_of(&seven_of_ten), ByteRole::Counter { .. }));
    }

    #[test]
    fn a_counter_can_step_down() {
        let values: Vec<u8> = (0..20).map(|i| 200 - 3 * i).collect();
        assert_eq!(role_of(&values), counter(Direction::Down, 3, false));
    }

    #[test]
    fn a_counter_rolls_over_through_zero() {
        let values: Vec<u8> = (0..20u8).map(|i| 250u8.wrapping_add(i)).collect();
        assert_eq!(role_of(&values), counter(Direction::Up, 1, true));
    }

    /// Row 3 of the API note: TypeScript folds only past ±200, so a step of 150
    /// reads as +150, −106 alternately, where wrapping arithmetic would see +150.
    #[test]
    fn a_step_of_150_is_not_a_counter_under_the_200_fold() {
        let values: Vec<u8> = (0..40u8).map(|i| i.wrapping_mul(150)).collect();
        assert!(!matches!(role_of(&values), ByteRole::Counter { .. }));
        assert_eq!(folded_delta(0, 201), (-55, true));
        assert_eq!(folded_delta(0, 200), (200, false));
    }

    /// Row 4: two samples with a change are not yet a counter.
    #[test]
    fn a_counter_needs_three_values() {
        assert_eq!(role_of(&[1, 2]), ByteRole::Value);
    }

    #[test]
    fn a_sensor_trends_sixty_percent_of_its_moves() {
        let (trend, strength) = trend_of(&role_of(&[10, 15, 12, 20, 18, 25])).unwrap();
        assert_eq!(trend, Trend::Increasing);
        assert!((strength - 0.6).abs() < 1e-9);

        let (trend, _) = trend_of(&role_of(&[200, 190, 195, 180, 170, 175, 160])).unwrap();
        assert_eq!(trend, Trend::Decreasing);
    }

    #[test]
    fn an_active_sensor_without_a_trend_is_mixed() {
        let wave = [0i16, 4, 8, 12, 8, 4, 0, -4, -8, -12, -8, -4];
        let values: Vec<u8> = (0..60).map(|i| (100 + wave[i % 12]) as u8).collect();
        let (trend, strength) = trend_of(&role_of(&values)).unwrap();
        assert_eq!(trend, Trend::Mixed);
        assert!((strength - 30.0 / 59.0).abs() < 1e-9);
    }

    #[test]
    fn two_values_are_a_value() {
        let flag: Vec<u8> = (0..40).map(|i| u8::from((10..15).contains(&i))).collect();
        assert_eq!(role_of(&flag), ByteRole::Value);
    }

    #[test]
    fn a_quiet_column_is_a_value_at_ten_percent_distinct_and_unknown_below() {
        let hold = |levels: &[u8]| -> Vec<u8> {
            levels
                .iter()
                .flat_map(|&v| std::iter::repeat_n(v, 10))
                .collect()
        };
        let ten = hold(&[10, 50, 20, 60, 30, 70, 40, 80, 35, 55]);
        assert_eq!(role_of(&ten), ByteRole::Value);

        let three = hold(&[10, 30, 20, 10, 20, 30, 10, 30, 20, 10]);
        assert_eq!(role_of(&three), ByteRole::Unknown);
    }

    /// Row 2: a payload too short for a column breaks its run, so no transition
    /// joins the payloads either side of it.
    #[test]
    fn a_runt_breaks_the_run() {
        let payloads = vec![
            vec![0xC0, 1],
            vec![0xC0],
            vec![0xC0, 2],
            vec![0xC0],
            vec![0xC0, 3],
        ];
        let column = classify_columns(&payloads, 1).remove(0);
        assert_eq!(column.stats.transitions, 0);
        assert_eq!(column.stats.sample_count, 3);
        assert_eq!(column.role, ByteRole::Value);
    }

    /// Row 1 and Q-D3: columns reach the longest payload, carrying their count.
    #[test]
    fn columns_reach_past_the_shortest_payload() {
        let payloads = vec![vec![1, 2, 3], vec![1, 2], vec![1, 2, 4]];
        let profile = profile_bytes(&payloads);
        assert_eq!((profile.min_len, profile.max_len), (2, 3));
        assert_eq!(profile.columns.len(), 3);
        assert_eq!(profile.columns[2].stats.position, 2);
        assert_eq!(profile.columns[2].stats.sample_count, 2);
    }

    #[test]
    fn identical_needs_more_than_one_sample() {
        assert_eq!(
            profile_bytes(&[vec![1, 2], vec![1, 2]]).identical,
            Some(vec![1, 2])
        );
        assert_eq!(profile_bytes(&[vec![1, 2]]).identical, None);
        assert_eq!(profile_bytes(&[vec![1, 2], vec![1]]).identical, None);
    }

    #[test]
    fn nothing_to_profile() {
        let profile = profile_bytes(&[]);
        assert_eq!(profile.sample_count, 0);
        assert!(profile.columns.is_empty());
        assert_eq!(profile.mux, None);
    }

    /// Row 8 and Q-D2: a mux frame's top-level columns cover every payload, and
    /// each case keeps its own.
    #[test]
    fn a_mux_frame_profiles_all_payloads_and_each_case() {
        let payloads: Vec<Vec<u8>> = (0..40u8).map(|i| vec![i % 4, 0x20 + i / 4, 0x11]).collect();
        let profile = profile_bytes(&payloads);

        assert_eq!(profile.analysed_from, 1);
        assert_eq!(profile.columns[0].stats.position, 1);
        assert_eq!(profile.columns[0].stats.sample_count, 40);

        let mux = profile.mux.unwrap();
        assert_eq!(mux.cases.len(), 4);
        assert_eq!(mux.cases[2].value, 2);
        assert_eq!(mux.cases[2].sample_count, 10);
        assert_eq!(
            mux.cases[2].columns[0].role,
            counter(Direction::Up, 1, false)
        );
    }

    #[test]
    fn a_column_serialises_its_statistics_and_role_flat() {
        let payloads: Vec<Vec<u8>> = (0..10u8).map(|i| vec![0xC0, i + 1]).collect();
        let json = serde_json::to_value(&classify_columns(&payloads, 1)[0]).unwrap();

        assert_eq!(json["position"], 1);
        assert_eq!(json["sampleCount"], 10);
        assert_eq!(json["role"], "counter");
        assert_eq!(json["direction"], "up");
        assert_eq!(json["step"], 1);
        assert_eq!(json["looping"], serde_json::Value::Null);

        let value = serde_json::to_value(ByteColumn {
            role: ByteRole::Value,
            ..classify_columns(&payloads, 1).remove(0)
        })
        .unwrap();
        assert_eq!(value["role"], "value");
    }
}
