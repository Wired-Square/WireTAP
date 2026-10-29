//! Serial frame structure: which leading bytes look like a message-type id, and
//! which bytes after the best id look like a source address.
//!
//! The windows, thresholds and scoring are the desktop's TypeScript ones, which the
//! golden fixture under `tests/fixtures/byte_roles` pins. Checksum candidates are
//! [`wslib_checksum::detect_checksum`]'s, called separately.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use serde::Serialize;

/// Ids are looked for at bytes `0..ID_WINDOW`.
const ID_WINDOW: usize = 5;
/// Source addresses are looked for in this many bytes after the best id.
const SOURCE_WINDOW: usize = 5;

/// The id and source-address candidates in one link's serial frames.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SerialStructure {
    pub sample_count: usize,
    pub min_len: usize,
    pub max_len: usize,
    /// Best first.
    pub ids: Vec<FieldCandidate>,
    /// After the best id, or from byte 1 without one; best first.
    pub sources: Vec<FieldCandidate>,
}

/// Bytes `start..start + len`, read big-endian, as a candidate field.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FieldCandidate {
    pub start: usize,
    /// 1 or 2.
    pub len: u8,
    /// Sorted.
    pub values: Vec<u16>,
    pub sample_count: usize,
    /// 0–100.
    pub confidence: f64,
    pub reasons: Vec<CandidateReason>,
}

/// Why a candidate scored as it did; the caller renders these as text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CandidateReason {
    /// An id value in `0xFB..=0xFE`, as TWC-like protocols use.
    ProtocolMarkers,
    /// An id of at most 16 values, one of them `0x10` or below.
    CommandIds,
    /// A two-byte id whose first byte takes at most five values.
    TypeSubtype { first_byte_values: usize },
    /// A source of 2–10 values.
    DeviceCount { count: usize },
    /// A source of 11–20 values.
    AddressCount { count: usize },
    /// A two-byte source above `0xFF` and no higher than `0xFFF`.
    TwelveBitRange,
    /// No source value is under a tenth of the mean count, or over five times it.
    EvenDistribution,
    /// A one-byte source no higher than `0x20`.
    SmallAddresses,
    /// A source of at most 10 values, none of them zero.
    NoZeroAddress,
}

/// Find the id and source-address candidates in serial `frames`.
pub fn serial_structure(frames: &[Vec<u8>]) -> SerialStructure {
    let lengths = frames.iter().map(Vec::len);
    let min_len = lengths.clone().min().unwrap_or(0);
    let ids = candidates(frames, 0..ID_WINDOW, min_len, id_candidate);
    let source_from = ids.first().map_or(1, |id| id.start + usize::from(id.len));
    let sources = candidates(
        frames,
        source_from..source_from + SOURCE_WINDOW,
        min_len,
        source_candidate,
    );

    SerialStructure {
        sample_count: frames.len(),
        min_len,
        max_len: lengths.max().unwrap_or(0),
        ids,
        sources,
    }
}

/// Every one- and two-byte field starting in `starts` that fits in `min_len`,
/// scored, best first; ties keep their order.
fn candidates(
    frames: &[Vec<u8>],
    starts: Range<usize>,
    min_len: usize,
    score: fn(&[Vec<u8>], usize, u8) -> Option<FieldCandidate>,
) -> Vec<FieldCandidate> {
    let mut found: Vec<_> = starts
        .flat_map(|start| [1, 2].map(|len| (start, len)))
        .filter(|&(start, len)| start + usize::from(len) <= min_len)
        .filter_map(|(start, len)| score(frames, start, len))
        .collect();
    found.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    found
}

fn id_candidate(frames: &[Vec<u8>], start: usize, len: u8) -> Option<FieldCandidate> {
    let tally = tally(frames, start, len);
    let count = tally.len();
    let wide = len == 2;
    if count < 2 || count > by_width(wide, 50, 100) {
        return None;
    }
    let mut reasons = Vec::new();
    let mut bonus = 0;
    let value_score = if wide {
        let first_byte_values = frames
            .iter()
            .map(|f| f[start])
            .collect::<BTreeSet<_>>()
            .len();
        if first_byte_values <= 5 {
            reasons.push(CandidateReason::TypeSubtype { first_byte_values });
            bonus += 20;
        }
        if (5..=50).contains(&count) {
            70
        } else {
            40
        }
    } else {
        if tally.keys().any(|v| (0xFB..=0xFE).contains(v)) {
            reasons.push(CandidateReason::ProtocolMarkers);
            bonus += 15;
        }
        if count <= 16 && tally.keys().any(|&v| v <= 0x10) {
            reasons.push(CandidateReason::CommandIds);
            bonus += 10;
        }
        if (3..=20).contains(&count) {
            80
        } else {
            50
        }
    };
    let position_score = 100usize.saturating_sub(start * 20);
    let confidence = ((position_score + value_score + bonus) as f64 / 2.0).min(100.0);
    (confidence >= by_width(wide, 30.0, 35.0))
        .then(|| candidate(frames, start, len, tally, confidence, reasons))
}

fn source_candidate(frames: &[Vec<u8>], start: usize, len: u8) -> Option<FieldCandidate> {
    let tally = tally(frames, start, len);
    let count = tally.len();
    let wide = len == 2;
    if count < 2 || count > by_width(wide, 30, 50) {
        return None;
    }
    let mut reasons = Vec::new();
    let mut confidence: i32 = match count {
        2..=10 => {
            reasons.push(CandidateReason::DeviceCount { count });
            by_width(wide, 40, 50)
        }
        11..=20 => {
            reasons.push(CandidateReason::AddressCount { count });
            by_width(wide, 25, 35)
        }
        21..=30 if wide => 20,
        _ => 10,
    };
    let max = *tally.keys().next_back()?;
    if wide && max <= 0xFF {
        confidence -= 25;
    } else if wide && max <= 0xFFF {
        confidence += 15;
        reasons.push(CandidateReason::TwelveBitRange);
    }
    if evenly_spread(&tally) {
        confidence += 20;
        reasons.push(CandidateReason::EvenDistribution);
    }
    if !wide && max <= 0x20 {
        confidence += 15;
        reasons.push(CandidateReason::SmallAddresses);
    }
    if count <= 10 && !tally.contains_key(&0) {
        confidence += 10;
        reasons.push(CandidateReason::NoZeroAddress);
    }
    (confidence >= by_width(wide, 30, 35)).then(|| {
        candidate(
            frames,
            start,
            len,
            tally,
            confidence.min(100).into(),
            reasons,
        )
    })
}

/// `one` for a one-byte field, `two` for a two-byte one.
fn by_width<T>(wide: bool, one: T, two: T) -> T {
    if wide {
        two
    } else {
        one
    }
}

fn candidate(
    frames: &[Vec<u8>],
    start: usize,
    len: u8,
    tally: BTreeMap<u16, usize>,
    confidence: f64,
    reasons: Vec<CandidateReason>,
) -> FieldCandidate {
    FieldCandidate {
        start,
        len,
        values: tally.into_keys().collect(),
        sample_count: frames.len(),
        confidence,
        reasons,
    }
}

/// How many frames carry each big-endian value of bytes `start..start + len`.
fn tally(frames: &[Vec<u8>], start: usize, len: u8) -> BTreeMap<u16, usize> {
    let mut tally = BTreeMap::new();
    for frame in frames {
        let value = frame[start..start + usize::from(len)]
            .iter()
            .fold(0u16, |v, &b| v << 8 | u16::from(b));
        *tally.entry(value).or_default() += 1;
    }
    tally
}

fn evenly_spread(tally: &BTreeMap<u16, usize>) -> bool {
    let mean = tally.values().sum::<usize>() as f64 / tally.len() as f64;
    let min = *tally.values().min().unwrap() as f64;
    let max = *tally.values().max().unwrap() as f64;
    min >= mean * 0.1 && max <= mean * 5.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use CandidateReason::*;

    /// One frame per value, `len` bytes big-endian.
    fn frames(values: &[u16], len: u8) -> Vec<Vec<u8>> {
        values
            .iter()
            .map(|v| v.to_be_bytes()[2 - usize::from(len)..].to_vec())
            .collect()
    }

    fn run(from: u16, count: u16) -> Vec<u16> {
        (from..from + count).collect()
    }

    fn id(values: &[u16], len: u8) -> Option<(f64, Vec<CandidateReason>)> {
        id_candidate(&frames(values, len), 0, len).map(|c| (c.confidence, c.reasons))
    }

    fn source(values: &[u16], len: u8) -> Option<(f64, Vec<CandidateReason>)> {
        source_candidate(&frames(values, len), 0, len).map(|c| (c.confidence, c.reasons))
    }

    fn confidence(scored: Option<(f64, Vec<CandidateReason>)>) -> Option<f64> {
        scored.map(|(c, _)| c)
    }

    #[test]
    fn a_one_byte_id_takes_2_to_50_values() {
        assert_eq!(id(&[0x40; 4], 1), None);
        assert_eq!(id(&run(0x40, 2), 1), Some((75.0, vec![])));
        assert_eq!(confidence(id(&run(0x40, 50), 1)), Some(75.0));
        assert_eq!(id(&run(0x40, 51), 1), None);
    }

    #[test]
    fn a_one_byte_id_of_3_to_20_values_scores_higher() {
        assert_eq!(confidence(id(&run(0x40, 3), 1)), Some(90.0));
        assert_eq!(confidence(id(&run(0x40, 20), 1)), Some(90.0));
        assert_eq!(confidence(id(&run(0x40, 21), 1)), Some(75.0));
    }

    #[test]
    fn protocol_markers_are_0xfb_to_0xfe() {
        let with = |v| id(&[0x40, 0x41, v], 1);
        assert_eq!(with(0xFA), Some((90.0, vec![])));
        assert_eq!(with(0xFB), Some((97.5, vec![ProtocolMarkers])));
        assert_eq!(with(0xFE), Some((97.5, vec![ProtocolMarkers])));
        assert_eq!(with(0xFF), Some((90.0, vec![])));
    }

    #[test]
    fn command_ids_are_at_most_16_values_one_at_most_0x10() {
        assert_eq!(id(&[0x10, 0x40, 0x41], 1), Some((95.0, vec![CommandIds])));
        assert_eq!(id(&[0x11, 0x40, 0x41], 1), Some((90.0, vec![])));
        assert_eq!(confidence(id(&run(0x10, 16), 1)), Some(95.0));
        assert_eq!(id(&run(0x10, 17), 1), Some((90.0, vec![])));
    }

    #[test]
    fn id_confidence_falls_20_a_byte_and_caps_at_100() {
        let values = frames(&run(0x40, 2), 1);
        let late: Vec<Vec<u8>> = values.iter().map(|f| [&[0; 4][..], f].concat()).collect();
        assert_eq!(id_candidate(&late, 4, 1).unwrap().confidence, 35.0);
        assert_eq!(
            id(&[0x01, 0x40, 0xFB], 1),
            Some((100.0, vec![ProtocolMarkers, CommandIds]))
        );
    }

    #[test]
    fn a_two_byte_id_takes_2_to_100_values() {
        assert_eq!(id(&[0x4000; 4], 2), None);
        assert!(id(&run(0x4000, 2), 2).is_some());
        assert!(id(&run(0x4000, 100), 2).is_some());
        assert_eq!(id(&run(0x4000, 101), 2), None);
    }

    #[test]
    fn a_two_byte_id_of_5_to_50_values_scores_higher() {
        let subtype = TypeSubtype {
            first_byte_values: 1,
        };
        assert_eq!(id(&run(0x4000, 4), 2), Some((80.0, vec![subtype])));
        assert_eq!(id(&run(0x4000, 5), 2), Some((95.0, vec![subtype])));
        assert_eq!(id(&run(0x4000, 50), 2), Some((95.0, vec![subtype])));
        assert_eq!(id(&run(0x4000, 51), 2), Some((80.0, vec![subtype])));
    }

    #[test]
    fn type_subtype_is_a_first_byte_of_at_most_5_values() {
        let firsts = |n: u16| (0..n).map(|hi| hi << 8).collect::<Vec<_>>();
        assert_eq!(
            id(&firsts(5), 2),
            Some((
                95.0,
                vec![TypeSubtype {
                    first_byte_values: 5
                }]
            ))
        );
        assert_eq!(id(&firsts(6), 2), Some((85.0, vec![])));
    }

    #[test]
    fn a_two_byte_id_needs_35() {
        let at_4 = |values: &[u16]| {
            let late: Vec<Vec<u8>> = frames(values, 2)
                .iter()
                .map(|f| [&[0; 4][..], f].concat())
                .collect();
            id_candidate(&late, 4, 2).map(|c| c.confidence)
        };
        let spread = |n: u16| (0..n).map(|i| i << 8 | i).collect::<Vec<_>>();
        assert_eq!(at_4(&spread(51)), None);
        assert_eq!(at_4(&spread(50)), Some(45.0));
    }

    #[test]
    fn a_one_byte_source_scores_its_value_count() {
        let even = |n| source(&run(0x40, n), 1);
        assert_eq!(even(1), None);
        assert_eq!(
            even(10),
            Some((
                70.0,
                vec![DeviceCount { count: 10 }, EvenDistribution, NoZeroAddress]
            ))
        );
        assert_eq!(
            even(11),
            Some((45.0, vec![AddressCount { count: 11 }, EvenDistribution]))
        );
        assert_eq!(confidence(even(20)), Some(45.0));
        assert_eq!(even(21), Some((30.0, vec![EvenDistribution])));
        assert_eq!(confidence(even(30)), Some(30.0));
        assert_eq!(even(31), None);
    }

    #[test]
    fn a_one_byte_source_needs_30() {
        let mut uneven = run(0x40, 21);
        uneven.extend([0x40; 200]);
        assert_eq!(source(&uneven, 1), None);
    }

    #[test]
    fn small_addresses_are_at_most_0x20_and_zero_counts_against_ten_or_fewer() {
        let reasons = |values: &[u16]| source(values, 1).unwrap().1;
        assert!(reasons(&[0x01, 0x20]).contains(&SmallAddresses));
        assert!(!reasons(&[0x01, 0x21]).contains(&SmallAddresses));
        assert!(reasons(&[0x01, 0x20]).contains(&NoZeroAddress));
        assert!(!reasons(&[0x00, 0x20]).contains(&NoZeroAddress));
        assert_eq!(
            source(&[0x01, 0x20], 1),
            Some((
                85.0,
                vec![
                    DeviceCount { count: 2 },
                    EvenDistribution,
                    SmallAddresses,
                    NoZeroAddress
                ]
            ))
        );
    }

    #[test]
    fn an_even_spread_is_within_a_tenth_and_five_times_the_mean() {
        let spread = |counts: &[usize]| {
            evenly_spread(
                &counts
                    .iter()
                    .enumerate()
                    .map(|(v, &n)| (v as u16, n))
                    .collect(),
            )
        };
        assert!(spread(&[1, 19]));
        assert!(!spread(&[1, 20]));
        assert!(spread(&[1, 1, 1, 1, 1, 1, 1, 1, 1, 9]));
        assert!(!spread(&[1, 1, 1, 1, 1, 1, 1, 1, 1, 10]));
    }

    #[test]
    fn a_two_byte_source_scores_its_value_count() {
        let even = |n| confidence(source(&run(0x1000, n), 2));
        assert_eq!(even(1), None);
        assert_eq!(even(10), Some(80.0));
        assert_eq!(even(11), Some(55.0));
        assert_eq!(even(20), Some(55.0));
        assert_eq!(even(21), Some(40.0));
        assert_eq!(even(30), Some(40.0));
        assert_eq!(even(31), None);
        assert_eq!(confidence(source(&run(0x100, 50), 2)), Some(45.0));
        assert_eq!(source(&run(0x100, 51), 2), None);
    }

    #[test]
    fn a_two_byte_source_is_marked_down_within_a_byte_and_up_within_12_bits() {
        assert_eq!(confidence(source(&[0x01, 0xFF], 2)), Some(55.0));
        assert_eq!(
            source(&[0x01, 0x100], 2),
            Some((
                95.0,
                vec![
                    DeviceCount { count: 2 },
                    TwelveBitRange,
                    EvenDistribution,
                    NoZeroAddress
                ]
            ))
        );
        assert_eq!(confidence(source(&[0x01, 0xFFF], 2)), Some(95.0));
        assert_eq!(confidence(source(&[0x01, 0x1000], 2)), Some(80.0));
    }

    #[test]
    fn a_two_byte_source_needs_35() {
        let uneven = |from| {
            let mut values = run(from, 11);
            values.extend([from; 200]);
            confidence(source(&values, 2))
        };
        assert_eq!(uneven(0x1000), Some(35.0));
        assert_eq!(uneven(0x80), None);
    }

    #[test]
    fn ids_are_sought_at_bytes_0_to_4() {
        let varying_at = |byte: usize| -> Vec<Vec<u8>> {
            (0..6u8)
                .map(|i| {
                    let mut frame = vec![0x40; 8];
                    frame[byte] = 0x40 + i % 3;
                    frame
                })
                .collect()
        };
        assert!(serial_structure(&varying_at(6)).ids.is_empty());
        let ids = serial_structure(&varying_at(4)).ids;
        assert!(ids.iter().any(|c| c.start == 4 && c.len == 1));
    }

    #[test]
    fn sources_are_sought_in_the_5_bytes_after_the_best_id() {
        let frames: Vec<Vec<u8>> = (0..12u8)
            .map(|i| {
                let mut frame = vec![0x40; 10];
                frame[0] = 0xFB + i % 3;
                frame[5] = 1 + i % 4;
                frame[6] = 1 + i % 4;
                frame
            })
            .collect();
        let structure = serial_structure(&frames);
        assert_eq!((structure.ids[0].start, structure.ids[0].len), (0, 1));
        assert!(structure.sources.iter().any(|c| c.start == 5));
        assert!(structure.sources.iter().all(|c| c.start <= 5));
    }

    #[test]
    fn without_an_id_sources_are_sought_from_byte_1() {
        let frames: Vec<Vec<u8>> = (0..120u8)
            .map(|i| vec![0x40, 0x40, 0x40, 0x40, i, 1 + i % 3])
            .collect();
        let structure = serial_structure(&frames);
        assert!(structure.ids.is_empty());
        let sources: Vec<_> = structure.sources.iter().map(|c| (c.start, c.len)).collect();
        assert_eq!(sources, [(5, 1)]);
    }

    #[test]
    fn no_frames_and_one_byte_frames() {
        let empty = serial_structure(&[]);
        assert_eq!(
            (empty.sample_count, empty.min_len, empty.max_len),
            (0, 0, 0)
        );
        assert!(empty.ids.is_empty() && empty.sources.is_empty());

        let one = serial_structure(&frames(&[0xFB, 0xFC, 0xFD], 1));
        assert_eq!(one.ids.len(), 1);
        assert!(one.sources.is_empty());
    }

    #[test]
    fn reasons_cross_as_codes() {
        let json = serde_json::to_value([
            TypeSubtype {
                first_byte_values: 3,
            },
            NoZeroAddress,
        ])
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!([
                { "code": "typeSubtype", "firstByteValues": 3 },
                { "code": "noZeroAddress" },
            ])
        );
    }
}
