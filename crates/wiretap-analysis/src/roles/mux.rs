//! Mux detection: whether byte 0, or bytes 0–1, select which of several layouts a
//! payload carries.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::{classify_columns, find_patterns, ByteColumn, MultiBytePattern};

/// The bytes that select a mux case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum MuxSelector {
    /// Byte 0.
    OneByte,
    /// Bytes 0–1, keyed `byte0 * 256 + byte1`.
    TwoByte,
}

impl MuxSelector {
    /// How many leading bytes the selector takes.
    pub fn width(self) -> usize {
        match self {
            Self::OneByte => 1,
            Self::TwoByte => 2,
        }
    }

    /// The case `payload` selects, or `None` when it is too short to say.
    pub fn key(self, payload: &[u8]) -> Option<u16> {
        match self {
            Self::OneByte => payload.first().map(|&b| b as u16),
            Self::TwoByte => Some(u16::from_be_bytes([*payload.first()?, *payload.get(1)?])),
        }
    }
}

/// A detected mux selector and how often each case occurs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MuxDetection {
    pub selector: MuxSelector,
    /// Occurrences per case key, in key order.
    pub occurrences: BTreeMap<u16, usize>,
}

/// A mux frame's cases, each profiled on its own.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MuxAnalysis {
    pub detection: MuxDetection,
    pub cases: Vec<MuxCase>,
}

/// One mux case's payloads, profiled past the selector.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "MuxCaseProfile"))]
#[serde(rename_all = "camelCase")]
pub struct MuxCase {
    pub value: u16,
    pub sample_count: usize,
    pub columns: Vec<ByteColumn>,
    pub patterns: Vec<MultiBytePattern>,
}

impl MuxAnalysis {
    pub(super) fn of(detection: MuxDetection, payloads: &[Vec<u8>]) -> Self {
        let selector = detection.selector;
        let cases = detection
            .occurrences
            .keys()
            .map(|&value| {
                let case: Vec<Vec<u8>> = payloads
                    .iter()
                    .filter(|p| selector.key(p) == Some(value))
                    .cloned()
                    .collect();
                let columns = classify_columns(&case, selector.width());
                MuxCase {
                    value,
                    sample_count: case.len(),
                    patterns: find_patterns(&case, &columns),
                    columns,
                }
            })
            .collect();
        Self { detection, cases }
    }
}

/// Detect a mux selector in byte 0, or bytes 0–1, of one frame id's payloads.
pub fn detect_mux(payloads: &[Vec<u8>]) -> Option<MuxDetection> {
    if payloads.len() < 4 {
        return None;
    }
    let mut first = BTreeMap::new();
    for &b in payloads.iter().filter_map(|p| p.first()) {
        *first.entry(b).or_insert(0usize) += 1;
    }
    if !is_mux_like_sequence(&first) {
        return None;
    }
    two_byte(payloads).or_else(|| {
        Some(MuxDetection {
            selector: MuxSelector::OneByte,
            occurrences: first.into_iter().map(|(b, n)| (b as u16, n)).collect(),
        })
    })
}

/// Whether byte values seen with these counts look like a mux selector: 2–16
/// small, mostly contiguous values, none more than three times as common as another.
pub fn is_mux_like_sequence(counts: &BTreeMap<u8, usize>) -> bool {
    (2..=16).contains(&counts.len())
        && selector_shaped(counts.keys().copied())
        && balanced(counts.values().copied(), 3)
}

/// Starts at 0–2, stays under 32, and covers half its span unless it has four
/// values or more.
fn selector_shaped(
    sorted: impl ExactSizeIterator<Item = u8> + DoubleEndedIterator + Clone,
) -> bool {
    let n = sorted.len();
    let (Some(min), Some(max)) = (sorted.clone().next(), sorted.last()) else {
        return false;
    };
    let span = (max - min) as usize + 1;
    min <= 2 && max <= 31 && (n as f64 / span as f64 >= 0.5 || n >= 4)
}

fn balanced(counts: impl Iterator<Item = usize> + Clone, ratio: usize) -> bool {
    match (counts.clone().min(), counts.max()) {
        (Some(min), Some(max)) => min >= 1 && max <= min * ratio,
        _ => false,
    }
}

/// Every byte-0 value carries the same selector-shaped set of byte-1 values, and
/// the combined keys are within 2× of each other.
fn two_byte(payloads: &[Vec<u8>]) -> Option<MuxDetection> {
    let pairs = || payloads.iter().filter(|p| p.len() >= 2);
    let mut seconds: BTreeMap<u8, BTreeSet<u8>> = BTreeMap::new();
    for p in pairs() {
        seconds.entry(p[0]).or_default().insert(p[1]);
    }
    let mut sets = seconds.values();
    let common = sets.next()?;
    if sets.any(|s| s != common) || common.len() < 2 || !selector_shaped(common.iter().copied()) {
        return None;
    }

    let mut occurrences = BTreeMap::new();
    for key in pairs().filter_map(|p| MuxSelector::TwoByte.key(p)) {
        *occurrences.entry(key).or_insert(0usize) += 1;
    }
    balanced(occurrences.values().copied(), 2).then_some(MuxDetection {
        selector: MuxSelector::TwoByte,
        occurrences,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(pairs: &[(u8, usize)]) -> BTreeMap<u8, usize> {
        pairs.iter().copied().collect()
    }

    fn cycling(values: &[u8], rounds: usize) -> Vec<Vec<u8>> {
        (0..rounds)
            .flat_map(|r| values.iter().map(move |&v| vec![v, 0x40 + r as u8, 0x11]))
            .collect()
    }

    #[test]
    fn a_selector_takes_two_to_sixteen_values() {
        let n = |k: u8| counts(&(0..k).map(|v| (v, 5)).collect::<Vec<_>>());
        assert!(!is_mux_like_sequence(&n(1)));
        assert!(is_mux_like_sequence(&n(2)));
        assert!(is_mux_like_sequence(&n(16)));
        assert!(!is_mux_like_sequence(&n(17)));
    }

    #[test]
    fn a_selector_starts_small_and_stays_under_32() {
        assert!(is_mux_like_sequence(&counts(&[(2, 5), (3, 5)])));
        assert!(!is_mux_like_sequence(&counts(&[(3, 5), (4, 5)])));
        assert!(is_mux_like_sequence(&counts(&[
            (0, 5),
            (1, 5),
            (31, 5),
            (30, 5)
        ])));
        assert!(!is_mux_like_sequence(&counts(&[
            (0, 5),
            (1, 5),
            (2, 5),
            (32, 5)
        ])));
    }

    #[test]
    fn a_sparse_selector_needs_four_values() {
        assert!(!is_mux_like_sequence(&counts(&[(0, 5), (10, 5)])));
        assert!(!is_mux_like_sequence(&counts(&[(0, 5), (5, 5), (10, 5)])));
        assert!(is_mux_like_sequence(&counts(&[
            (0, 5),
            (5, 5),
            (10, 5),
            (15, 5)
        ])));
    }

    #[test]
    fn a_selector_is_balanced_within_three_times() {
        assert!(is_mux_like_sequence(&counts(&[(0, 3), (1, 9)])));
        assert!(!is_mux_like_sequence(&counts(&[(0, 3), (1, 10)])));
    }

    #[test]
    fn detection_needs_four_payloads() {
        assert_eq!(detect_mux(&cycling(&[0, 1], 1)), None);
        assert!(detect_mux(&cycling(&[0, 1], 2)).is_some());
    }

    #[test]
    fn a_one_byte_selector_counts_its_cases() {
        let detection = detect_mux(&cycling(&[0, 1, 2, 3], 5)).unwrap();
        assert_eq!(detection.selector, MuxSelector::OneByte);
        assert_eq!(
            detection.occurrences,
            [(0, 5), (1, 5), (2, 5), (3, 5)].into()
        );
    }

    #[test]
    fn a_two_byte_selector_needs_the_same_second_byte_everywhere() {
        let payloads: Vec<Vec<u8>> = (0..36u8)
            .map(|i| vec![1 + (i / 3) % 3, 1 + i % 3, 0xAA])
            .collect();
        let detection = detect_mux(&payloads).unwrap();
        assert_eq!(detection.selector, MuxSelector::TwoByte);
        assert_eq!(detection.occurrences.len(), 9);
        assert_eq!(detection.occurrences[&0x0203], 4);

        let mut uneven = payloads;
        uneven[0][1] = 7;
        assert_eq!(detect_mux(&uneven).unwrap().selector, MuxSelector::OneByte);
    }

    #[test]
    fn a_two_byte_selector_is_balanced_within_twice() {
        let mut payloads: Vec<Vec<u8>> = (0..16u8).map(|i| vec![i % 2, (i / 2) % 2]).collect();
        assert_eq!(
            detect_mux(&payloads).unwrap().selector,
            MuxSelector::TwoByte
        );

        payloads.extend(vec![vec![0, 0]; 5]);
        assert_eq!(
            detect_mux(&payloads).unwrap().selector,
            MuxSelector::OneByte
        );
    }

    #[test]
    fn selector_keys() {
        assert_eq!(MuxSelector::OneByte.key(&[3, 9]), Some(3));
        assert_eq!(MuxSelector::TwoByte.key(&[3, 9]), Some(0x0309));
        assert_eq!(MuxSelector::TwoByte.key(&[3]), None);
        assert_eq!(MuxSelector::OneByte.key(&[]), None);
    }
}
