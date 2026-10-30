//! Multi-byte patterns: adjacent columns read together as a 16- or 32-bit counter
//! or sensor, or as a run of text.
//!
//! A pattern overlays the columns it spans; their single-byte roles stand.

use serde::{Deserialize, Serialize};

use super::{consistent_step, ByteColumn, ByteRole};

/// A 16-bit delta beyond this is read as a wrap through 0/65535.
const COUNTER16_FOLD: i32 = 60_000;
/// A text column is printable in this share of the payloads that reach it.
const TEXT_PRINTABLE: f64 = 0.9;

/// Byte order, of one pattern or across a frame's patterns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "NoteEndianness"))]
#[serde(rename_all = "camelCase")]
pub enum Endianness {
    Little,
    Big,
    /// Patterns of both orders in one frame.
    Mixed,
}

/// What a multi-byte pattern is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum PatternKind {
    Counter16,
    Sensor16,
    Sensor32,
    Text,
}

/// Adjacent columns `start..start + len` read as one value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MultiBytePattern {
    pub start: usize,
    pub len: usize,
    pub kind: PatternKind,
    /// `Little` or `Big`; `None` for text.
    pub endianness: Option<Endianness>,
    pub rollover: bool,
    /// The upper part stepped as the lower part wrapped.
    pub correlated_rollover: bool,
    /// A `sensor32`'s upper bytes are static or change rarely.
    pub slow_upper_bytes: bool,
    /// The lowest and highest value seen, for sensors.
    pub range: Option<(u32, u32)>,
    /// The first payload's bytes, with non-printable ones as `.`, for text.
    pub sample_text: Option<String>,
}

impl MultiBytePattern {
    fn new(start: usize, len: usize, kind: PatternKind) -> Self {
        Self {
            start,
            len,
            kind,
            endianness: None,
            rollover: false,
            correlated_rollover: false,
            slow_upper_bytes: false,
            range: None,
            sample_text: None,
        }
    }
}

/// Find multi-byte patterns across adjacent `columns` of oldest-first, contiguous
/// `payloads`: counters and sensors left to right, then the longest text run.
pub fn find_patterns(payloads: &[Vec<u8>], columns: &[ByteColumn]) -> Vec<MultiBytePattern> {
    let mut patterns = Vec::new();
    let mut i = 0;
    while i + 1 < columns.len() {
        let found = if columns[i..i + 2].iter().any(is_static) {
            None
        } else {
            counter16(payloads, &columns[i..i + 2])
                .or_else(|| sensor16(payloads, &columns[i..i + 2]))
                .or_else(|| sensor32(payloads, columns.get(i..i + 4)?))
        };
        match found {
            Some(pattern) => {
                i += pattern.len;
                patterns.push(pattern);
            }
            None => i += 1,
        }
    }
    patterns.extend(text(payloads, columns, &patterns));
    patterns
}

/// The byte order the patterns agree on, `Mixed` when they don't, or `None`
/// when none has one.
pub fn infer_endianness<'a>(
    patterns: impl IntoIterator<Item = &'a MultiBytePattern>,
) -> Option<Endianness> {
    patterns
        .into_iter()
        .filter_map(|p| p.endianness)
        .reduce(|a, b| if a == b { a } else { Endianness::Mixed })
}

fn is_static(column: &ByteColumn) -> bool {
    matches!(column.role, ByteRole::Static { .. })
}

fn start_of(column: &ByteColumn) -> usize {
    column.stats.position as usize
}

/// Each payload's `width` bytes from `start`, or `None` where it is too short.
fn words(payloads: &[Vec<u8>], start: usize, width: usize, order: Endianness) -> Vec<Option<u32>> {
    let push = |acc: u32, &b: &u8| acc << 8 | b as u32;
    payloads
        .iter()
        .map(|p| {
            let bytes = p.get(start..start + width)?;
            Some(match order {
                Endianness::Little => bytes.iter().rev().fold(0, push),
                _ => bytes.iter().fold(0, push),
            })
        })
        .collect()
}

/// Consecutive pairs, broken where a payload is too short.
fn pairs(values: &[Option<u32>]) -> impl Iterator<Item = (u32, u32)> + '_ {
    values.windows(2).filter_map(|w| Some((w[0]?, w[1]?)))
}

fn counter16(payloads: &[Vec<u8>], pair: &[ByteColumn]) -> Option<MultiBytePattern> {
    if pair[1].stats.sample_count < 3 {
        return None;
    }
    let start = start_of(&pair[0]);
    [Endianness::Little, Endianness::Big]
        .into_iter()
        .find_map(|order| {
            let values = words(payloads, start, 2, order);
            let (deltas, rolls): (Vec<i32>, Vec<bool>) = pairs(&values)
                .map(|(prev, next)| match next as i32 - prev as i32 {
                    d if d < -COUNTER16_FOLD => (d + 65_536, true),
                    d if d > COUNTER16_FOLD => (d - 65_536, true),
                    d => (d, false),
                })
                .unzip();
            consistent_step(&deltas)?;
            Some(MultiBytePattern {
                endianness: Some(order),
                rollover: rolls.contains(&true),
                ..MultiBytePattern::new(start, 2, PatternKind::Counter16)
            })
        })
}

/// A sensor found by its low half wrapping between `≥ top` and `≤ bottom` while
/// its high half steps the other way, at least once.
struct Rollover {
    kind: PatternKind,
    width: usize,
    bottom: u32,
    top: u32,
}

const SENSOR16: Rollover = Rollover {
    kind: PatternKind::Sensor16,
    width: 2,
    bottom: 5,
    top: 250,
};

const SENSOR32: Rollover = Rollover {
    kind: PatternKind::Sensor32,
    width: 4,
    bottom: 500,
    top: 65_000,
};

impl Rollover {
    /// The first byte order in which the value at `start` rolls over together.
    fn find(&self, payloads: &[Vec<u8>], start: usize) -> Option<MultiBytePattern> {
        [Endianness::Little, Endianness::Big]
            .into_iter()
            .find_map(|order| {
                let values = words(payloads, start, self.width, order);
                if !self.correlated(&values) {
                    return None;
                }
                let seen = values.iter().flatten().copied();
                Some(MultiBytePattern {
                    endianness: Some(order),
                    rollover: true,
                    correlated_rollover: true,
                    range: Some((seen.clone().min()?, seen.max()?)),
                    ..MultiBytePattern::new(start, self.width, self.kind)
                })
            })
    }

    fn correlated(&self, values: &[Option<u32>]) -> bool {
        let half_bits = self.width as u32 * 4;
        let low = |v: u32| v & ((1 << half_bits) - 1);
        let high = |v: u32| v >> half_bits;
        pairs(values).any(|(prev, next)| {
            let (from, to) = (low(prev), low(next));
            let wrapped =
                (from >= self.top && to <= self.bottom) || (from <= self.bottom && to >= self.top);
            wrapped && high(next).cmp(&high(prev)) == from.cmp(&to)
        })
    }
}

fn sensor16(payloads: &[Vec<u8>], pair: &[ByteColumn]) -> Option<MultiBytePattern> {
    (pair[1].stats.sample_count >= 5)
        .then(|| SENSOR16.find(payloads, start_of(&pair[0])))
        .flatten()
}

/// A 32-bit sensor whose upper two bytes are static or rarely change, though not
/// both static: that is a `sensor16` beside padding.
fn sensor32(payloads: &[Vec<u8>], quad: &[ByteColumn]) -> Option<MultiBytePattern> {
    let upper = &quad[2..];
    if quad[3].stats.sample_count < 1000
        || !upper.iter().all(|c| is_static(c) || slow_changing(c))
        || upper.iter().all(is_static)
    {
        return None;
    }
    let found = SENSOR32.find(payloads, start_of(&quad[0]))?;
    Some(MultiBytePattern {
        slow_upper_bytes: true,
        ..found
    })
}

/// 2–20 values over at least 1 000 samples, under 0.1 % of them distinct.
fn slow_changing(column: &ByteColumn) -> bool {
    let (distinct, n) = (column.stats.distinct_values, column.stats.sample_count);
    n >= 1000 && (2..=20).contains(&distinct) && (distinct as f64 / n as f64) < 0.001
}

fn is_printable(b: u8) -> bool {
    (0x20..=0x7E).contains(&b) || matches!(b, b'\t' | b'\n' | b'\r')
}

/// The longest run of two or more columns outside `taken`, each printable in
/// most of the three or more payloads that reach it; the first wins a tie.
fn text(
    payloads: &[Vec<u8>],
    columns: &[ByteColumn],
    taken: &[MultiBytePattern],
) -> Option<MultiBytePattern> {
    let textual = |column: &ByteColumn| {
        let at = start_of(column);
        let n = column.stats.sample_count;
        let printable = payloads
            .iter()
            .filter_map(|p| p.get(at))
            .filter(|&&b| is_printable(b))
            .count();
        n >= 3
            && !taken
                .iter()
                .any(|p| (p.start..p.start + p.len).contains(&at))
            && printable as f64 / n as f64 >= TEXT_PRINTABLE
    };

    let (mut best, mut run) = (None::<(usize, usize)>, None::<(usize, usize)>);
    for column in columns {
        run = textual(column).then(|| run.map_or((start_of(column), 1), |(s, len)| (s, len + 1)));
        if let Some((_, len)) = run {
            if len >= 2 && best.is_none_or(|(_, longest)| len > longest) {
                best = run;
            }
        }
    }

    let (start, len) = best?;
    let sample = payloads.first()?.iter().skip(start).take(len);
    Some(MultiBytePattern {
        sample_text: Some(
            sample
                .map(|&b| if is_printable(b) { b as char } else { '.' })
                .collect(),
        ),
        ..MultiBytePattern::new(start, len, PatternKind::Text)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::{classify_columns, profile_bytes};

    fn patterns(payloads: &[Vec<u8>]) -> Vec<MultiBytePattern> {
        find_patterns(payloads, &classify_columns(payloads, 0))
    }

    /// A 16-bit value at bytes 1–2 behind a constant byte 0.
    fn pair16(values: impl IntoIterator<Item = u16>, order: Endianness) -> Vec<Vec<u8>> {
        values
            .into_iter()
            .map(|v| {
                let [a, b] = match order {
                    Endianness::Little => v.to_le_bytes(),
                    _ => v.to_be_bytes(),
                };
                vec![0xC0, a, b]
            })
            .collect()
    }

    fn quad32(values: impl IntoIterator<Item = u32>, order: Endianness) -> Vec<Vec<u8>> {
        values
            .into_iter()
            .map(|v| {
                let bytes = match order {
                    Endianness::Little => v.to_le_bytes(),
                    _ => v.to_be_bytes(),
                };
                [&[0xC0], &bytes[..]].concat()
            })
            .collect()
    }

    fn only(found: Vec<MultiBytePattern>) -> MultiBytePattern {
        assert_eq!(found.len(), 1, "{found:?}");
        found.into_iter().next().unwrap()
    }

    #[test]
    fn a_counter16_is_read_little_endian_first() {
        let found = only(patterns(&pair16(
            (0..40).map(|i| 0x00F0 + i * 3),
            Endianness::Little,
        )));
        assert_eq!(
            found,
            MultiBytePattern {
                endianness: Some(Endianness::Little),
                ..MultiBytePattern::new(1, 2, PatternKind::Counter16)
            }
        );
    }

    #[test]
    fn a_counter16_is_found_big_endian_when_little_fails() {
        let found = only(patterns(&pair16(
            (0..60).map(|i| 0x0100 + i * 97),
            Endianness::Big,
        )));
        assert_eq!(found.kind, PatternKind::Counter16);
        assert_eq!(found.endianness, Some(Endianness::Big));
    }

    #[test]
    fn a_counter16_steps_consistently_eighty_percent_of_the_time() {
        let mut values: Vec<u16> = (0..11).map(|i| 0x1000 + i * 0x101).collect();
        values[9] += 7;
        values[10] += 14;
        assert_eq!(
            patterns(&pair16(values.clone(), Endianness::Little))[0].kind,
            PatternKind::Counter16
        );

        values[8] += 3;
        assert!(patterns(&pair16(values, Endianness::Little)).is_empty());
    }

    #[test]
    fn a_counter16_rolls_over_past_60000() {
        let found = only(patterns(&pair16(
            (0..20u16).map(|i| 0xFFF6u16.wrapping_add(i * 0x101)),
            Endianness::Little,
        )));
        assert_eq!(found.kind, PatternKind::Counter16);
        assert!(found.rollover);
    }

    #[test]
    fn a_counter16_needs_three_samples() {
        assert!(patterns(&pair16([0x0101, 0x0202], Endianness::Little)).is_empty());
    }

    #[test]
    fn a_static_column_joins_no_pair() {
        let payloads: Vec<Vec<u8>> = (0..20u8).map(|i| vec![0xC0, i * 3, 0x55]).collect();
        assert!(patterns(&payloads).is_empty());
    }

    /// A slow 16-bit ramp whose low byte crosses 250→5 as the high byte steps up.
    fn ramp16(start: u16, step: u16, n: u16) -> impl Iterator<Item = u16> {
        (0..n).map(move |i| start + (i % 2) * 2 + i / 2 * step)
    }

    #[test]
    fn a_sensor16_correlates_a_low_byte_rollover_with_its_high_byte() {
        let values: Vec<u16> = ramp16(0x03E0, 5, 40).collect();
        let found = only(patterns(&pair16(values.clone(), Endianness::Little)));
        assert_eq!(
            found,
            MultiBytePattern {
                range: Some((
                    *values.iter().min().unwrap() as u32,
                    *values.iter().max().unwrap() as u32
                )),
                endianness: Some(Endianness::Little),
                rollover: true,
                correlated_rollover: true,
                ..MultiBytePattern::new(1, 2, PatternKind::Sensor16)
            }
        );
        let found = only(patterns(&pair16(values, Endianness::Big)));
        assert_eq!(found.endianness, Some(Endianness::Big));
    }

    #[test]
    fn a_sensor16_wraps_between_250_and_5() {
        let wrap = |from: u8, to: u8| -> Vec<Vec<u8>> {
            [0x10, 0x20, from, to, 0x30, 0x40]
                .iter()
                .zip([4u8, 1, 4, 5, 5, 2])
                .map(|(&low, high)| vec![0xC0, low, high])
                .collect()
        };
        let kinds = |p: &[Vec<u8>]| patterns(p).iter().map(|p| p.kind).collect::<Vec<_>>();
        assert_eq!(kinds(&wrap(250, 5)), [PatternKind::Sensor16]);
        assert!(kinds(&wrap(249, 5)).is_empty());
        assert!(kinds(&wrap(250, 6)).is_empty());
    }

    #[test]
    fn a_sensor16_needs_the_high_byte_to_step_the_right_way() {
        let payloads: Vec<Vec<u8>> = [(0x10, 4), (0x20, 1), (252, 4), (3, 3), (0x30, 2), (0x40, 6)]
            .iter()
            .map(|&(low, high)| vec![0xC0, low, high])
            .collect();
        assert!(patterns(&payloads).is_empty());
    }

    #[test]
    fn a_sensor16_needs_five_samples() {
        let payloads: Vec<Vec<u8>> = [(0x10, 1), (0x80, 7), (252, 4), (3, 5)]
            .iter()
            .map(|&(low, high)| vec![0xC0, low, high])
            .collect();
        assert!(patterns(&payloads).is_empty());
        let mut five = payloads;
        five.push(vec![0xC0, 0x40, 2]);
        assert_eq!(patterns(&five)[0].kind, PatternKind::Sensor16);
    }

    /// Steps of 13, 13 and 30: no counter, and too long for a low byte to wrap
    /// between 250 and 5.
    fn uneven(i: u32) -> u32 {
        i * 13 + i / 3 * 17
    }

    /// A 32-bit ramp over `n` samples whose low word crosses 65 000→500 once.
    fn ramp32(high: u32, n: u32) -> Vec<u32> {
        (0..n).map(|i| (high << 16) + 0xF000 + uneven(i)).collect()
    }

    #[test]
    fn a_sensor32_has_slow_upper_bytes_and_a_correlated_rollover() {
        let values = ramp32(2, 2400);
        let found = only(patterns(&quad32(values.clone(), Endianness::Little)));
        assert_eq!(
            found,
            MultiBytePattern {
                slow_upper_bytes: true,
                range: Some((values[0], *values.iter().max().unwrap())),
                endianness: Some(Endianness::Little),
                rollover: true,
                correlated_rollover: true,
                ..MultiBytePattern::new(1, 4, PatternKind::Sensor32)
            }
        );
    }

    /// Big-endian, the slow bytes are the low word's, so it can only toggle
    /// between the ends of its range as the high word climbs.
    #[test]
    fn a_sensor32_is_found_big_endian_when_little_fails() {
        let values: Vec<u32> = (0..2400)
            .map(|i| (0x0100 + uneven(i)) << 16 | if i % 2 == 0 { 0xFFFF } else { 0 })
            .collect();
        let found = only(patterns(&quad32(values, Endianness::Big)));
        assert_eq!(found.kind, PatternKind::Sensor32);
        assert_eq!(found.endianness, Some(Endianness::Big));
    }

    /// Row 7 of the API note: TypeScript's `<<` made this range negative.
    #[test]
    fn a_sensor32_range_above_0x80000000_stays_unsigned() {
        let values = ramp32(0x8001, 2400);
        let found = only(patterns(&quad32(values.clone(), Endianness::Little)));
        let (min, max) = found.range.unwrap();
        assert_eq!(min, values[0]);
        assert!(min > 0x8000_0000);
        assert_eq!(max, *values.iter().max().unwrap());
    }

    #[test]
    fn a_sensor32_needs_a_thousand_samples() {
        let values = ramp32(2, 999);
        assert!(patterns(&quad32(values, Endianness::Little))
            .iter()
            .all(|p| p.kind != PatternKind::Sensor32));
    }

    #[test]
    fn a_sensor32_upper_byte_changes_under_one_in_a_thousand() {
        let slow = |distinct: usize, n: usize| {
            let payloads: Vec<Vec<u8>> =
                (0..n).map(|i| vec![(i * distinct / n) as u8, 0]).collect();
            slow_changing(&classify_columns(&payloads, 0)[0])
        };
        assert!(slow(2, 2001));
        assert!(!slow(2, 2000));
        assert!(slow(20, 20_001));
        assert!(!slow(21, 30_000));
        assert!(!slow(1, 5000));
    }

    #[test]
    fn a_sensor32_with_both_upper_bytes_static_is_not_one() {
        let values: Vec<u32> = ramp32(0, 2400).into_iter().map(|v| v & 0xFFFF).collect();
        assert!(patterns(&quad32(values, Endianness::Little))
            .iter()
            .all(|p| p.kind != PatternKind::Sensor32));
    }

    fn ascii(text: &[u8], n: usize) -> Vec<Vec<u8>> {
        (0..n)
            .map(|i| [&[0xC0], text, &[i as u8]].concat())
            .collect()
    }

    #[test]
    fn text_is_the_longest_printable_run() {
        let found = only(patterns(&ascii(b"T=20C", 10)));
        assert_eq!(
            found,
            MultiBytePattern {
                sample_text: Some("T=20C".into()),
                ..MultiBytePattern::new(1, 5, PatternKind::Text)
            }
        );
    }

    #[test]
    fn text_needs_two_columns_and_three_samples() {
        assert!(patterns(&ascii(b"T", 10)).is_empty());
        assert!(patterns(&ascii(b"OK", 2)).is_empty());
        assert_eq!(patterns(&ascii(b"OK", 3))[0].kind, PatternKind::Text);
    }

    #[test]
    fn text_is_printable_in_ninety_percent_of_payloads() {
        let mut payloads = ascii(b"OK", 10);
        payloads[0][1] = 0x01;
        let found = only(patterns(&payloads));
        assert_eq!(found.sample_text.as_deref(), Some(".K"));

        payloads[1][1] = 0x01;
        assert!(patterns(&payloads).is_empty());
    }

    #[test]
    fn text_takes_the_first_of_two_equal_runs() {
        let payloads: Vec<Vec<u8>> = (0..5).map(|_| b"AB\x01CD".to_vec()).collect();
        assert_eq!(only(patterns(&payloads)).start, 0);
    }

    fn inferred(orders: &[Option<Endianness>]) -> Option<Endianness> {
        let patterns: Vec<MultiBytePattern> = orders
            .iter()
            .map(|&endianness| MultiBytePattern {
                endianness,
                ..MultiBytePattern::new(0, 2, PatternKind::Counter16)
            })
            .collect();
        infer_endianness(&patterns)
    }

    #[test]
    fn endianness_is_inferred_from_the_patterns_that_have_one() {
        let (little, big) = (Some(Endianness::Little), Some(Endianness::Big));
        assert_eq!(inferred(&[]), None);
        assert_eq!(inferred(&[None]), None);
        assert_eq!(inferred(&[little, None, little]), little);
        assert_eq!(inferred(&[big]), big);
        assert_eq!(inferred(&[little, big]), Some(Endianness::Mixed));
    }

    #[test]
    fn a_profile_carries_patterns_and_endianness() {
        let profile = profile_bytes(&pair16((0..40).map(|i| 0x00F0 + i * 3), Endianness::Little));
        assert_eq!(profile.patterns.len(), 1);
        assert_eq!(profile.endianness, Some(Endianness::Little));

        let json = serde_json::to_value(&profile.patterns[0]).unwrap();
        assert_eq!(json["kind"], "counter16");
        assert_eq!(json["endianness"], "little");
        assert_eq!(json["correlatedRollover"], false);
    }

    /// Decision for A2: a mux frame's endianness reads its cases' patterns too.
    #[test]
    fn a_mux_frame_infers_endianness_from_its_cases() {
        let payloads: Vec<Vec<u8>> = (0..40u16)
            .map(|i| {
                let [lo, hi] = (0x1240 + i / 4 * 0x0103).to_le_bytes();
                vec![(i % 4) as u8, lo, hi]
            })
            .collect();
        let profile = profile_bytes(&payloads);
        let mux = profile.mux.unwrap();

        assert!(profile.patterns.is_empty());
        assert_eq!(mux.cases[0].patterns[0].kind, PatternKind::Counter16);
        assert_eq!(profile.endianness, Some(Endianness::Little));
    }
}
