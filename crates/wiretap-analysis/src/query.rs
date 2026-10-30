//! The analytical query kernels, over rows already read and oldest first,
//! answering in the [`wslib_wiretap_gateway`] result types.
//!
//! Every kernel stops at `limit` results, never rows; `None` is no limit. A
//! kernel's `rows_scanned` is the rows it was handed, and its time its own.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::Instant;

use wslib_wiretap_catalogue::Catalogue;
use wslib_wiretap_gateway::{
    ByteChangeQueryResult, ByteChangeResult, BytePositionStats, DistributionQueryResult,
    DistributionResult, FirstLastQueryResult, FirstLastResult, FrameChangeQueryResult,
    FrameChangeResult, FrequencyBucket, FrequencyQueryResult, GapAnalysisQueryResult, GapResult,
    MirrorValidationQueryResult, MirrorValidationResult, MuxCaseStats, MuxStatisticsQueryResult,
    MuxStatisticsResult, PatternSearchQueryResult, PatternSearchResult, QueryStats, Word16Stats,
};

/// One frame as a query reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryRow {
    pub timestamp_us: i64,
    pub frame_id: u32,
    pub is_extended: bool,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatternError {
    MaskLengthMismatch,
    Empty,
}

impl fmt::Display for PatternError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::MaskLengthMismatch => "Pattern and mask must have the same length",
            Self::Empty => "Pattern must not be empty",
        })
    }
}

impl std::error::Error for PatternError {}

fn cap(limit: Option<u32>) -> usize {
    limit.map_or(usize::MAX, |n| n as usize)
}

/// A kernel's [`QueryStats`], its time measured from `started`.
pub fn stats(rows_scanned: usize, results_count: usize, started: Instant) -> QueryStats {
    QueryStats {
        rows_scanned: rows_scanned as u64,
        results_count: results_count as u64,
        execution_time_ms: started.elapsed().as_millis() as u64,
    }
}

/// Where `byte_index` changed from one row to the next; a row without the byte is skipped.
pub fn byte_changes(
    rows: &[QueryRow],
    byte_index: u8,
    limit: Option<u32>,
) -> ByteChangeQueryResult {
    let started = Instant::now();
    let i = byte_index as usize;
    let results: Vec<_> = rows
        .windows(2)
        .filter_map(|pair| {
            let (old, new) = (*pair[0].payload.get(i)?, *pair[1].payload.get(i)?);
            (old != new).then_some(ByteChangeResult {
                timestamp_us: pair[1].timestamp_us,
                old_value: old,
                new_value: new,
            })
        })
        .take(cap(limit))
        .collect();
    ByteChangeQueryResult {
        stats: stats(rows.len(), results.len(), started),
        results,
    }
}

/// Where the payload changed from one row to the next; a length change marks the
/// bytes only one side has.
pub fn frame_changes(rows: &[QueryRow], limit: Option<u32>) -> FrameChangeQueryResult {
    let started = Instant::now();
    let results: Vec<_> = rows
        .windows(2)
        .filter(|pair| pair[0].payload != pair[1].payload)
        .map(|pair| {
            let (old, new) = (&pair[0].payload, &pair[1].payload);
            FrameChangeResult {
                timestamp_us: pair[1].timestamp_us,
                old_payload: old.clone(),
                new_payload: new.clone(),
                changed_indices: (0..old.len().max(new.len()))
                    .filter(|&i| old.get(i) != new.get(i))
                    .map(|i| i as u64)
                    .collect(),
            }
        })
        .take(cap(limit))
        .collect();
    FrameChangeQueryResult {
        stats: stats(rows.len(), results.len(), started),
        results,
    }
}

/// Byte indices where two payloads differ, within `compare` when given; the
/// shorter payload reads as zero-padded.
pub fn differing_byte_indices(a: &[u8], b: &[u8], compare: Option<&BTreeSet<usize>>) -> Vec<u64> {
    (0..a.len().max(b.len()))
        .filter(|i| compare.is_none_or(|set| set.contains(i)))
        .filter(|&i| a.get(i).copied().unwrap_or(0) != b.get(i).copied().unwrap_or(0))
        .map(|i| i as u64)
        .collect()
}

/// The bytes a mirror validation compares: the mirror frame's inherited bytes, or
/// `None` (the whole payload) when the catalogue has no such frame or it inherits nothing.
pub fn mirror_compare_set(catalog: &Catalogue, mirror_frame_id: u32) -> Option<BTreeSet<usize>> {
    let id = wslib_wiretap_catalogue::decode::frame_id_mask(catalog)
        .map_or(mirror_frame_id, |mask| mirror_frame_id & mask);
    catalog
        .frame(id)
        .map(wslib_wiretap_catalogue::mirror::inherited_byte_indices)
        .filter(|set| !set.is_empty())
}

/// Mirror rows whose nearest source row within `|Δt| <= tolerance_ms` differs
/// in the `compare` bytes.
pub fn mirror_validation(
    mirror: &[QueryRow],
    source: &[QueryRow],
    tolerance_ms: u32,
    compare: Option<&BTreeSet<usize>>,
    limit: Option<u32>,
) -> MirrorValidationQueryResult {
    let started = Instant::now();
    let tolerance_us = i64::from(tolerance_ms) * 1000;
    let mut first = 0;
    let results: Vec<_> = mirror
        .iter()
        .filter_map(|m| {
            while source
                .get(first)
                .is_some_and(|s| s.timestamp_us < m.timestamp_us - tolerance_us)
            {
                first += 1;
            }
            let s = source[first..]
                .iter()
                .take_while(|s| s.timestamp_us <= m.timestamp_us + tolerance_us)
                .min_by_key(|s| (s.timestamp_us - m.timestamp_us).abs())?;
            let mismatch_indices = differing_byte_indices(&m.payload, &s.payload, compare);
            (!mismatch_indices.is_empty()).then(|| MirrorValidationResult {
                mirror_timestamp_us: m.timestamp_us,
                source_timestamp_us: s.timestamp_us,
                mirror_payload: m.payload.clone(),
                source_payload: s.payload.clone(),
                mismatch_indices,
            })
        })
        .take(cap(limit))
        .collect();
    MirrorValidationQueryResult {
        stats: stats(mirror.len() + source.len(), results.len(), started),
        results,
    }
}

struct Summary<T> {
    min: T,
    max: T,
    avg: f64,
    distinct: u32,
    count: u64,
}

fn summarise<T: Copy + Ord + Into<f64>>(values: impl Iterator<Item = T>) -> Option<Summary<T>> {
    let (mut seen, mut sum, mut count) = (BTreeSet::new(), 0.0, 0);
    for value in values {
        seen.insert(value);
        sum += value.into();
        count += 1;
    }
    Some(Summary {
        min: *seen.first()?,
        max: *seen.last()?,
        avg: sum / count as f64,
        distinct: seen.len() as u32,
        count,
    })
}

/// Per-case statistics of the bytes after `mux_byte` up to `payload_length`, and
/// with `include_16bit` each byte pair after it read both ways.
pub fn compute_mux_statistics(
    payloads_by_mux: &BTreeMap<u16, Vec<Vec<u8>>>,
    include_16bit: bool,
    mux_byte: u8,
    payload_length: u8,
) -> MuxStatisticsResult {
    let first = mux_byte as usize + 1;
    let end = payload_length as usize;
    let cases: Vec<_> = payloads_by_mux
        .iter()
        .map(|(&mux_value, payloads)| {
            let byte_stats = (first..end)
                .filter_map(|i| {
                    let s = summarise(payloads.iter().filter_map(|p| p.get(i).copied()))?;
                    Some(BytePositionStats {
                        byte_index: i as u8,
                        min: s.min,
                        max: s.max,
                        avg: s.avg,
                        distinct_count: s.distinct,
                        sample_count: s.count,
                    })
                })
                .collect();
            let word_starts = if include_16bit {
                first..end.saturating_sub(1)
            } else {
                0..0
            };
            let word16_stats = word_starts
                .step_by(2)
                .flat_map(|i| {
                    let pairs = || payloads.iter().filter(move |p| i + 1 < p.len());
                    let le = summarise(pairs().map(|p| u16::from_le_bytes([p[i], p[i + 1]])));
                    let be = summarise(pairs().map(|p| u16::from_be_bytes([p[i], p[i + 1]])));
                    [("le", le), ("be", be)].map(|(endianness, s)| {
                        s.map(|s| Word16Stats {
                            start_byte: i as u8,
                            endianness: endianness.to_string(),
                            min: s.min,
                            max: s.max,
                            avg: s.avg,
                            distinct_count: s.distinct,
                        })
                    })
                })
                .flatten()
                .collect();
            MuxCaseStats {
                mux_value,
                frame_count: payloads.len() as u64,
                byte_stats,
                word16_stats,
            }
        })
        .collect();
    MuxStatisticsResult {
        mux_byte,
        total_frames: cases.iter().map(|c| c.frame_count).sum(),
        cases,
    }
}

/// The rows grouped by the selector at `mux_selector_byte`, the lowest `limit`
/// cases kept; a row too short for the selector is left out.
pub fn mux_statistics(
    rows: &[QueryRow],
    mux_selector_byte: u8,
    include_16bit: bool,
    payload_length: u8,
    limit: Option<u32>,
) -> MuxStatisticsQueryResult {
    let started = Instant::now();
    let mut by_mux: BTreeMap<u16, Vec<Vec<u8>>> = BTreeMap::new();
    for row in rows {
        if let Some(&selector) = row.payload.get(mux_selector_byte as usize) {
            by_mux
                .entry(selector.into())
                .or_default()
                .push(row.payload.clone());
        }
    }
    let by_mux = by_mux.into_iter().take(cap(limit)).collect();
    let results = compute_mux_statistics(&by_mux, include_16bit, mux_selector_byte, payload_length);
    MuxStatisticsQueryResult {
        stats: stats(rows.len(), results.cases.len(), started),
        results,
    }
}

/// The first and last rows and how many there are; `None` without rows.
pub fn first_last(rows: &[QueryRow]) -> Option<FirstLastQueryResult> {
    let mut found = first_last_from_ends(rows.first()?, rows.last()?, rows.len() as i64);
    found.stats.rows_scanned = rows.len() as u64;
    Some(found)
}

/// [`first_last`] from the two end rows and the total, read without the rows between.
pub fn first_last_from_ends(
    first: &QueryRow,
    last: &QueryRow,
    total_count: i64,
) -> FirstLastQueryResult {
    let started = Instant::now();
    FirstLastQueryResult {
        results: FirstLastResult {
            first_timestamp_us: first.timestamp_us,
            first_payload: first.payload.clone(),
            last_timestamp_us: last.timestamp_us,
            last_payload: last.payload.clone(),
            total_count,
        },
        stats: stats(2, 1, started),
    }
}

/// Frames per `bucket_size_ms` bucket, each counted in the bucket its own
/// timestamp falls in, with the intervals that end in it; the earliest `limit`
/// buckets. A bucket holding only the first frame has no interval and reports 0.
pub fn frequency(
    rows: &[QueryRow],
    bucket_size_ms: u32,
    limit: Option<u32>,
) -> FrequencyQueryResult {
    let started = Instant::now();
    let bucket_us = i64::from(bucket_size_ms) * 1000;
    let mut buckets: BTreeMap<i64, (i64, Vec<f64>)> = BTreeMap::new();
    if bucket_us > 0 {
        for (i, row) in rows.iter().enumerate() {
            let (frames, intervals) = buckets
                .entry(row.timestamp_us.div_euclid(bucket_us) * bucket_us)
                .or_default();
            *frames += 1;
            if let Some(previous) = i.checked_sub(1).map(|p| &rows[p]) {
                intervals.push((row.timestamp_us - previous.timestamp_us) as f64);
            }
        }
    }
    let results: Vec<_> = buckets
        .into_iter()
        .take(cap(limit))
        .map(|(bucket_start_us, (frame_count, intervals))| {
            let reduce = |f: fn(f64, f64) -> f64| intervals.iter().copied().reduce(f);
            FrequencyBucket {
                bucket_start_us,
                frame_count,
                min_interval_us: reduce(f64::min).unwrap_or(0.0),
                max_interval_us: reduce(f64::max).unwrap_or(0.0),
                avg_interval_us: reduce(|a, b| a + b)
                    .map_or(0.0, |sum| sum / intervals.len() as f64),
            }
        })
        .collect();
    FrequencyQueryResult {
        stats: stats(rows.len(), results.len(), started),
        results,
    }
}

/// How often each value occurs at `byte_index`, ascending by value; the
/// percentage is of the rows that have the byte.
pub fn distribution(rows: &[QueryRow], byte_index: u8) -> DistributionQueryResult {
    let started = Instant::now();
    let mut counts: BTreeMap<u8, i64> = BTreeMap::new();
    for value in rows
        .iter()
        .filter_map(|r| r.payload.get(byte_index as usize))
    {
        *counts.entry(*value).or_default() += 1;
    }
    let total: i64 = counts.values().sum();
    let results: Vec<_> = counts
        .into_iter()
        .map(|(value, count)| DistributionResult {
            value,
            count,
            percentage: count as f64 / total as f64 * 100.0,
        })
        .collect();
    DistributionQueryResult {
        stats: stats(rows.len(), results.len(), started),
        results,
    }
}

/// Intervals longer than `gap_threshold_ms`, longest first (ties oldest first),
/// the `limit` longest kept.
pub fn gap_analysis(
    rows: &[QueryRow],
    gap_threshold_ms: f64,
    limit: Option<u32>,
) -> GapAnalysisQueryResult {
    let started = Instant::now();
    let threshold_us = gap_threshold_ms * 1000.0;
    let mut results: Vec<_> = rows
        .windows(2)
        .map(|pair| (pair[0].timestamp_us, pair[1].timestamp_us))
        .filter(|(start, end)| (end - start) as f64 > threshold_us)
        .map(|(gap_start_us, gap_end_us)| GapResult {
            gap_start_us,
            gap_end_us,
            duration_ms: (gap_end_us - gap_start_us) as f64 / 1000.0,
        })
        .collect();
    results.sort_by(|a, b| b.duration_ms.total_cmp(&a.duration_ms));
    results.truncate(cap(limit));
    GapAnalysisQueryResult {
        stats: stats(rows.len(), results.len(), started),
        results,
    }
}

/// Rows where `pattern` matches at some offset, comparing only the bits set in
/// `pattern_mask`, with every offset it matches at.
pub fn pattern_search(
    rows: &[QueryRow],
    pattern: &[u8],
    pattern_mask: &[u8],
    limit: Option<u32>,
) -> Result<PatternSearchQueryResult, PatternError> {
    if pattern.len() != pattern_mask.len() {
        return Err(PatternError::MaskLengthMismatch);
    }
    if pattern.is_empty() {
        return Err(PatternError::Empty);
    }
    let started = Instant::now();
    let matches = |window: &[u8]| {
        window
            .iter()
            .zip(pattern.iter().zip(pattern_mask))
            .all(|(byte, (want, mask))| byte & mask == want & mask)
    };
    let results: Vec<_> = rows
        .iter()
        .filter_map(|row| {
            let match_positions: Vec<u64> = row
                .payload
                .windows(pattern.len())
                .enumerate()
                .filter(|(_, window)| matches(window))
                .map(|(i, _)| i as u64)
                .collect();
            (!match_positions.is_empty()).then(|| PatternSearchResult {
                timestamp_us: row.timestamp_us,
                frame_id: row.frame_id,
                is_extended: row.is_extended,
                payload: row.payload.clone(),
                match_positions,
            })
        })
        .take(cap(limit))
        .collect();
    Ok(PatternSearchQueryResult {
        stats: stats(rows.len(), results.len(), started),
        results,
    })
}
