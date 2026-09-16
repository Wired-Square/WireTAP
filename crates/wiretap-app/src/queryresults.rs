// ui/crates/wiretap-app/src/queryresults.rs
//
// The shapes an analytical query answers in, and the pure computation shared by
// the two things that answer them: `apiclient` (a WireTAP backend, over HTTP)
// and `capturequery` (a local SQLite capture). Neither queries through the
// other, so the types live here rather than in either — they used to sit in
// `dbquery`, which meant `apiclient` imported from the module that calls it.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// Result of a byte change query
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByteChangeResult {
    pub timestamp_us: i64,
    pub old_value: u8,
    pub new_value: u8,
}

/// Result of a frame change query
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameChangeResult {
    pub timestamp_us: i64,
    pub old_payload: Vec<u8>,
    pub new_payload: Vec<u8>,
    pub changed_indices: Vec<usize>,
}

/// Query statistics returned with results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryStats {
    /// Number of rows fetched from the database
    pub rows_scanned: usize,
    /// Number of results after filtering
    pub results_count: usize,
    /// Query execution time in milliseconds
    pub execution_time_ms: u64,
}

/// Wrapper for byte change query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByteChangeQueryResult {
    pub results: Vec<ByteChangeResult>,
    pub stats: QueryStats,
}

/// Wrapper for frame change query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameChangeQueryResult {
    pub results: Vec<FrameChangeResult>,
    pub stats: QueryStats,
}

/// Result of a mirror validation query
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorValidationResult {
    pub mirror_timestamp_us: i64,
    pub source_timestamp_us: i64,
    pub mirror_payload: Vec<u8>,
    pub source_payload: Vec<u8>,
    pub mismatch_indices: Vec<usize>,
}

/// Wrapper for mirror validation query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorValidationQueryResult {
    pub results: Vec<MirrorValidationResult>,
    pub stats: QueryStats,
}

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
pub fn differing_byte_indices(a: &[u8], b: &[u8], compare: Option<&BTreeSet<usize>>) -> Vec<usize> {
    (0..a.len().max(b.len()))
        .filter(|i| compare.is_none_or(|set| set.contains(i)))
        .filter(|&i| a.get(i).copied().unwrap_or(0) != b.get(i).copied().unwrap_or(0))
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

/// Statistics for a single byte position within a mux case
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BytePositionStats {
    pub byte_index: u8,
    pub min: u8,
    pub max: u8,
    pub avg: f64,
    pub distinct_count: u32,
    pub sample_count: u64,
}

/// Statistics for a reconstructed 16-bit value from two adjacent bytes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Word16Stats {
    pub start_byte: u8,
    pub endianness: String,
    pub min: u16,
    pub max: u16,
    pub avg: f64,
    pub distinct_count: u32,
}

/// Statistics for a single mux case
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuxCaseStats {
    pub mux_value: u16,
    pub frame_count: u64,
    pub byte_stats: Vec<BytePositionStats>,
    pub word16_stats: Vec<Word16Stats>,
}

/// Full result of a mux statistics query
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuxStatisticsResult {
    pub mux_byte: u8,
    pub total_frames: u64,
    pub cases: Vec<MuxCaseStats>,
}

/// Wrapper for mux statistics query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MuxStatisticsQueryResult {
    pub results: MuxStatisticsResult,
    pub stats: QueryStats,
}

/// Result of a first/last query
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FirstLastResult {
    pub first_timestamp_us: i64,
    pub first_payload: Vec<u8>,
    pub last_timestamp_us: i64,
    pub last_payload: Vec<u8>,
    pub total_count: i64,
}

/// Wrapper for first/last query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FirstLastQueryResult {
    pub results: FirstLastResult,
    pub stats: QueryStats,
}

/// A single frequency bucket with interval statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyBucket {
    pub bucket_start_us: i64,
    pub frame_count: i64,
    pub min_interval_us: f64,
    pub max_interval_us: f64,
    pub avg_interval_us: f64,
}

/// Wrapper for frequency query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyQueryResult {
    pub results: Vec<FrequencyBucket>,
    pub stats: QueryStats,
}

/// A single byte value distribution entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributionResult {
    pub value: u8,
    pub count: i64,
    pub percentage: f64,
}

/// Wrapper for distribution query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistributionQueryResult {
    pub results: Vec<DistributionResult>,
    pub stats: QueryStats,
}

/// A detected gap in frame transmission
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GapResult {
    pub gap_start_us: i64,
    pub gap_end_us: i64,
    pub duration_ms: f64,
}

/// Wrapper for gap analysis query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GapAnalysisQueryResult {
    pub results: Vec<GapResult>,
    pub stats: QueryStats,
}

/// A frame matching a byte pattern search
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternSearchResult {
    pub timestamp_us: i64,
    pub frame_id: u32,
    pub is_extended: bool,
    pub payload: Vec<u8>,
    pub match_positions: Vec<usize>,
}

/// Wrapper for pattern search query results with stats
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternSearchQueryResult {
    pub results: Vec<PatternSearchResult>,
    pub stats: QueryStats,
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

/// A running query or session from pg_stat_activity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseActivity {
    /// Process ID (pid) of the backend
    pub pid: i32,
    /// Database name
    pub database: Option<String>,
    /// Username
    pub username: Option<String>,
    /// Application name (e.g., "WireTAP Query")
    pub application_name: Option<String>,
    /// Client address
    pub client_addr: Option<String>,
    /// Current state (active, idle, idle in transaction, etc.)
    pub state: Option<String>,
    /// Current query text (truncated)
    pub query: Option<String>,
    /// When the query started (ISO 8601)
    pub query_start: Option<String>,
    /// How long the query has been running in seconds
    pub duration_secs: Option<f64>,
    /// Whether this is a query we can cancel (our own connection)
    pub is_cancellable: bool,
}

/// Result of querying database activity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseActivityResult {
    /// Active queries running on the database
    pub queries: Vec<DatabaseActivity>,
    /// Active sessions connected to the database
    pub sessions: Vec<DatabaseActivity>,
}
