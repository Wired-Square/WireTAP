// ui/crates/wiretap-app/src/queryresults.rs
//
// The shapes an analytical query answers in — `wiretap-gateway`'s, re-exported
// so callers keep this path — and the pure computation shared by the two things
// that answer them: `apiclient` (a WireTAP backend, over HTTP) and
// `capturequery` (a local SQLite capture).

use std::collections::{BTreeMap, BTreeSet, HashSet};

pub use wiretap_gateway::{
    BytePositionStats, ByteChangeQueryResult, ByteChangeResult, DatabaseActivityResult,
    DistributionQueryResult, DistributionResult, FirstLastQueryResult,
    FirstLastResult, FrameChangeQueryResult, FrameChangeResult, FrequencyBucket,
    FrequencyQueryResult, GapAnalysisQueryResult, GapResult, MirrorValidationQueryResult,
    MirrorValidationResult, MuxCaseStats, MuxStatisticsQueryResult, MuxStatisticsResult,
    PatternSearchQueryResult, PatternSearchResult, QueryStats, Word16Stats,
};

/// Byte indices where two payloads differ, restricted to `compare` when the
/// caller supplied one. A payload shorter than the other is read as zero-padded.
///
/// `None` compares the whole payload — what a frame-to-frame change query wants,
/// and the only sensible answer for a mirror query with no catalogue to consult.
/// When a set *is* given it must be the mirror frame's inherited bytes
/// (`wiretap_catalog::mirror::inherited_byte_indices`), which is what the live
/// Decoder compares: a byte covered by a signal the mirror declares itself is
/// deliberately different data, not a fault, and reporting it here would
/// contradict the badge in the Decoder.
pub fn differing_byte_indices(a: &[u8], b: &[u8], compare: Option<&BTreeSet<usize>>) -> Vec<u64> {
    (0..a.len().max(b.len()))
        .filter(|i| compare.is_none_or(|set| set.contains(i)))
        .filter(|&i| a.get(i).copied().unwrap_or(0) != b.get(i).copied().unwrap_or(0))
        .map(|i| i as u64)
        .collect()
}

/// Normalise the frontend's `compare_byte_indices` argument into a lookup set.
/// An empty list is treated as "no restriction", so a caller that has no
/// catalogue loaded behaves exactly as before.
pub fn compare_index_set(indices: Option<Vec<u8>>) -> Option<BTreeSet<usize>> {
    indices
        .filter(|v| !v.is_empty())
        .map(|v| v.into_iter().map(usize::from).collect())
}

/// Compute per-mux-case statistics from grouped payloads.
/// `payloads_by_mux` maps mux selector value -> list of raw frame payloads.
/// `mux_byte` is the byte index of the mux selector (used to skip it in stats).
/// `payload_length` is the expected payload width for byte iteration.
pub fn compute_mux_statistics(
    payloads_by_mux: &BTreeMap<u16, Vec<Vec<u8>>>,
    include_16bit: bool,
    mux_byte: u8,
    payload_length: u8,
) -> MuxStatisticsResult {
    let mut total_frames: u64 = 0;
    let mut cases = Vec::new();
    let start_byte = (mux_byte + 1) as usize;
    let end_byte = payload_length as usize;

    for (&mux_value, payloads) in payloads_by_mux {
        let frame_count = payloads.len() as u64;
        total_frames += frame_count;

        // Per-byte statistics
        let mut byte_stats = Vec::new();
        for byte_idx in start_byte..end_byte {
            let mut min: u8 = 255;
            let mut max: u8 = 0;
            let mut sum: f64 = 0.0;
            let mut distinct = HashSet::new();
            let mut count: u64 = 0;

            for payload in payloads {
                if byte_idx < payload.len() {
                    let val = payload[byte_idx];
                    if val < min {
                        min = val;
                    }
                    if val > max {
                        max = val;
                    }
                    sum += val as f64;
                    distinct.insert(val);
                    count += 1;
                }
            }

            if count > 0 {
                byte_stats.push(BytePositionStats {
                    byte_index: byte_idx as u8,
                    min,
                    max,
                    avg: sum / count as f64,
                    distinct_count: distinct.len() as u32,
                    sample_count: count,
                });
            }
        }

        // 16-bit word statistics (LE and BE for each adjacent pair)
        let mut word16_stats = Vec::new();
        if include_16bit {
            let mut byte_idx = start_byte;
            while byte_idx + 1 < end_byte {
                // Little-endian: low byte first
                let mut le_min: u16 = u16::MAX;
                let mut le_max: u16 = 0;
                let mut le_sum: f64 = 0.0;
                let mut le_distinct = HashSet::new();

                // Big-endian: high byte first
                let mut be_min: u16 = u16::MAX;
                let mut be_max: u16 = 0;
                let mut be_sum: f64 = 0.0;
                let mut be_distinct = HashSet::new();

                let mut word_count: u64 = 0;

                for payload in payloads {
                    if byte_idx + 1 < payload.len() {
                        let lo = payload[byte_idx] as u16;
                        let hi = payload[byte_idx + 1] as u16;

                        let le_val = lo | (hi << 8);
                        let be_val = (lo << 8) | hi;

                        if le_val < le_min {
                            le_min = le_val;
                        }
                        if le_val > le_max {
                            le_max = le_val;
                        }
                        le_sum += le_val as f64;
                        le_distinct.insert(le_val);

                        if be_val < be_min {
                            be_min = be_val;
                        }
                        if be_val > be_max {
                            be_max = be_val;
                        }
                        be_sum += be_val as f64;
                        be_distinct.insert(be_val);

                        word_count += 1;
                    }
                }

                if word_count > 0 {
                    word16_stats.push(Word16Stats {
                        start_byte: byte_idx as u8,
                        endianness: "le".to_string(),
                        min: le_min,
                        max: le_max,
                        avg: le_sum / word_count as f64,
                        distinct_count: le_distinct.len() as u32,
                    });
                    word16_stats.push(Word16Stats {
                        start_byte: byte_idx as u8,
                        endianness: "be".to_string(),
                        min: be_min,
                        max: be_max,
                        avg: be_sum / word_count as f64,
                        distinct_count: be_distinct.len() as u32,
                    });
                }

                byte_idx += 2;
            }
        }

        cases.push(MuxCaseStats {
            mux_value,
            frame_count,
            byte_stats,
            word16_stats,
        });
    }

    MuxStatisticsResult {
        mux_byte,
        total_frames,
        cases,
    }
}
