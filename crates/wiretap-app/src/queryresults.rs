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

/// The bytes a mirror validation compares: the mirror frame's inherited bytes in
/// the catalogue at `catalog_path`. `None` — the whole payload — when no
/// catalogue is given or the frame inherits nothing.
pub fn mirror_compare_set(
    catalog_path: Option<&str>,
    mirror_frame_id: u32,
) -> Result<Option<BTreeSet<usize>>, String> {
    let Some(path) = catalog_path else { return Ok(None) };
    let text = std::fs::read_to_string(path).map_err(|e| format!("Failed to read catalog file: {e}"))?;
    let catalog = wiretap_catalog::Catalog::parse(&text).map_err(|e| e.to_string())?;
    let id = wiretap_catalog::decode::frame_id_mask(&catalog).map_or(mirror_frame_id, |m| mirror_frame_id & m);
    Ok(catalog
        .frame(id)
        .map(wiretap_catalog::mirror::inherited_byte_indices)
        .filter(|set| !set.is_empty()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct InheritedCase {
        name: String,
        signals: serde_json::Value,
        expected: Vec<usize>,
    }

    #[test]
    fn inherited_bytes_match_the_query_golden() {
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../frontend/wiretap-ui/src/tests/fixtures/analysis/inheritedBytes.json"
        );
        let cases: Vec<InheritedCase> =
            serde_json::from_str(&std::fs::read_to_string(fixture).expect("fixture")).expect("cases");
        for case in cases {
            let frame: wiretap_catalog::Frame = serde_json::from_value(serde_json::json!({
                "key": "0x100", "frameId": 0x100, "protocol": "can", "length": 8, "signals": case.signals,
            }))
            .expect("frame");
            let indices: Vec<usize> = wiretap_catalog::mirror::inherited_byte_indices(&frame).into_iter().collect();
            assert_eq!(indices, case.expected, "{}", case.name);
        }
    }

    const MASKED_MIRROR: &str = r#"
[meta]
name = "masked"
[meta.can]
frame_id_mask = 0xFFF
[frame.can."0x705"]
length = 8
[[frame.can."0x705".signals]]
name = "current"
start_bit = 0
bit_length = 16
[[frame.can."0x705".signals]]
name = "end_stop"
start_bit = 16
bit_length = 8
[frame.can."0x005"]
length = 8
mirror_of = "0x705"
[[frame.can."0x005".signals]]
name = "local_end_stop"
start_bit = 16
bit_length = 8
"#;

    #[test]
    fn mirror_compare_set_reads_the_catalogue_at_the_path() {
        let dir = std::env::temp_dir().join(format!("wiretap-mirror-compare-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("masked.toml");
        std::fs::write(&path, MASKED_MIRROR).unwrap();
        let path = path.to_str();

        assert_eq!(mirror_compare_set(path, 0x7005).unwrap(), Some(BTreeSet::from([0, 1])));
        assert_eq!(mirror_compare_set(path, 0x705).unwrap(), None, "a source inherits nothing");
        assert_eq!(mirror_compare_set(path, 0x123).unwrap(), None, "not in the catalogue");
        assert_eq!(mirror_compare_set(None, 0x005).unwrap(), None);
        assert!(mirror_compare_set(Some("/nonexistent/catalogue.toml"), 0x005).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
