// ui/src-tauri/src/bufferquery.rs
//
// Query commands for running analytical queries against buffer SQLite data.
// Mirrors the PostgreSQL query commands in dbquery.rs but operates on the
// local buffer_db instead.

use std::collections::{BTreeMap, HashMap};

use crate::buffer_db;
use crate::dbquery::{
    ByteChangeQueryResult, ByteChangeResult, DistributionQueryResult, DistributionResult,
    FirstLastQueryResult, FirstLastResult, FrameChangeQueryResult, FrameChangeResult,
    FrequencyBucket, FrequencyQueryResult, GapAnalysisQueryResult, GapResult,
    MirrorValidationQueryResult, MirrorValidationResult, MuxStatisticsQueryResult,
    PatternSearchQueryResult, PatternSearchResult, QueryStats, compute_mux_statistics,
};

/// Query for byte changes in a specific frame within a buffer.
///
/// Returns timestamps where the specified byte changed value.
/// Time bounds are in microseconds (matching buffer timestamp_us).
#[tauri::command]
pub fn buffer_query_byte_changes(
    buffer_id: String,
    frame_id: u32,
    byte_index: u8,
    is_extended: Option<bool>,
    start_time_us: Option<i64>,
    end_time_us: Option<i64>,
    limit: Option<i64>,
) -> Result<ByteChangeQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(10000);

    tlog!(
        "[bufferquery] byte_changes: buffer_id='{}', frame_id={}, byte_index={}, is_extended={:?}, limit={}",
        buffer_id, frame_id, byte_index, is_extended, result_limit
    );

    // Build the SQL dynamically based on optional filters
    let mut sql = String::from(
        "WITH ordered AS (
            SELECT timestamp_us, payload,
                   LAG(payload) OVER (ORDER BY rowid) as prev_payload
            FROM frames
            WHERE buffer_id = ?1 AND frame_id = ?2",
    );

    let mut param_idx = 3;
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    params.push(Box::new(buffer_id.clone()));
    params.push(Box::new(frame_id as i64));

    if let Some(ext) = is_extended {
        sql.push_str(&format!(" AND is_extended = ?{}", param_idx));
        params.push(Box::new(ext as i32));
        param_idx += 1;
    }
    if let Some(start) = start_time_us {
        sql.push_str(&format!(" AND timestamp_us >= ?{}", param_idx));
        params.push(Box::new(start));
        param_idx += 1;
    }
    if let Some(end) = end_time_us {
        sql.push_str(&format!(" AND timestamp_us < ?{}", param_idx));
        params.push(Box::new(end));
        param_idx += 1;
    }

    sql.push_str(
        " ORDER BY rowid
        )
        SELECT timestamp_us, prev_payload, payload
        FROM ordered
        WHERE prev_payload IS NOT NULL",
    );

    sql.push_str(&format!(" LIMIT ?{}", param_idx));
    // We'll filter in Rust after fetching, so fetch more rows to account for no-change rows
    // Actually, we need to filter byte changes in Rust since SQLite can't easily extract a
    // single byte from a BLOB in the WHERE clause. Fetch up to limit * 10 rows and filter.
    let fetch_limit = result_limit * 10;
    params.push(Box::new(fetch_limit));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = buffer_db::query_raw(&sql, &param_refs)?;

    let byte_idx = byte_index as usize;
    let mut results = Vec::new();
    let mut rows_scanned = 0usize;

    for row in &rows {
        rows_scanned += 1;
        let (timestamp_us, prev_payload, payload): (i64, Vec<u8>, Vec<u8>) = row.clone();

        let prev_byte = prev_payload.get(byte_idx).copied();
        let curr_byte = payload.get(byte_idx).copied();

        if let (Some(prev), Some(curr)) = (prev_byte, curr_byte) {
            if prev != curr {
                results.push(ByteChangeResult {
                    timestamp_us,
                    old_value: prev,
                    new_value: curr,
                });
                if results.len() >= result_limit as usize {
                    break;
                }
            }
        }
    }

    let elapsed = query_start.elapsed();

    tlog!(
        "[bufferquery] byte_changes: {} results from {} rows in {}ms",
        results.len(),
        rows_scanned,
        elapsed.as_millis()
    );

    Ok(ByteChangeQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms: elapsed.as_millis() as u64,
        },
        results,
    })
}

/// Query for frame payload changes in a buffer.
///
/// Returns timestamps where any byte in the frame payload changed.
#[tauri::command]
pub fn buffer_query_frame_changes(
    buffer_id: String,
    frame_id: u32,
    is_extended: Option<bool>,
    start_time_us: Option<i64>,
    end_time_us: Option<i64>,
    limit: Option<i64>,
) -> Result<FrameChangeQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(10000);

    tlog!(
        "[bufferquery] frame_changes: buffer_id='{}', frame_id={}, is_extended={:?}, limit={}",
        buffer_id, frame_id, is_extended, result_limit
    );

    let mut sql = String::from(
        "WITH ordered AS (
            SELECT timestamp_us, payload,
                   LAG(payload) OVER (ORDER BY rowid) as prev_payload
            FROM frames
            WHERE buffer_id = ?1 AND frame_id = ?2",
    );

    let mut param_idx = 3;
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    params.push(Box::new(buffer_id.clone()));
    params.push(Box::new(frame_id as i64));

    if let Some(ext) = is_extended {
        sql.push_str(&format!(" AND is_extended = ?{}", param_idx));
        params.push(Box::new(ext as i32));
        param_idx += 1;
    }
    if let Some(start) = start_time_us {
        sql.push_str(&format!(" AND timestamp_us >= ?{}", param_idx));
        params.push(Box::new(start));
        param_idx += 1;
    }
    if let Some(end) = end_time_us {
        sql.push_str(&format!(" AND timestamp_us < ?{}", param_idx));
        params.push(Box::new(end));
        param_idx += 1;
    }

    sql.push_str(&format!(
        " ORDER BY rowid
        )
        SELECT timestamp_us, prev_payload, payload
        FROM ordered
        WHERE prev_payload IS NOT NULL AND prev_payload != payload
        ORDER BY timestamp_us
        LIMIT ?{}",
        param_idx
    ));
    params.push(Box::new(result_limit));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = buffer_db::query_raw(&sql, &param_refs)?;

    let mut results = Vec::new();
    let rows_scanned = rows.len();

    for (timestamp_us, prev_payload, payload) in &rows {
        let changed_indices: Vec<usize> = prev_payload
            .iter()
            .zip(payload.iter())
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(i, _)| i)
            .collect();

        // Also check for length differences
        let max_len = prev_payload.len().max(payload.len());
        let min_len = prev_payload.len().min(payload.len());
        let mut all_changed = changed_indices;
        for i in min_len..max_len {
            all_changed.push(i);
        }

        results.push(FrameChangeResult {
            timestamp_us: *timestamp_us,
            old_payload: prev_payload.clone(),
            new_payload: payload.clone(),
            changed_indices: all_changed,
        });
    }

    let elapsed = query_start.elapsed();

    tlog!(
        "[bufferquery] frame_changes: {} results from {} rows in {}ms",
        results.len(),
        rows_scanned,
        elapsed.as_millis()
    );

    Ok(FrameChangeQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms: elapsed.as_millis() as u64,
        },
        results,
    })
}

/// Query for mirror validation mismatches in a buffer.
///
/// Finds timestamps where a mirror frame's payload doesn't match its source frame
/// within the given tolerance window (in microseconds).
#[tauri::command]
pub fn buffer_query_mirror_validation(
    buffer_id: String,
    mirror_frame_id: u32,
    source_frame_id: u32,
    is_extended: Option<bool>,
    tolerance_us: i64,
    start_time_us: Option<i64>,
    end_time_us: Option<i64>,
    limit: Option<i64>,
) -> Result<MirrorValidationQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(10000);

    tlog!(
        "[bufferquery] mirror_validation: buffer_id='{}', mirror={}, source={}, tolerance_us={}, limit={}",
        buffer_id, mirror_frame_id, source_frame_id, tolerance_us, result_limit
    );

    // Strategy: load mirror frames, then for each mirror frame find the closest
    // source frame within tolerance. This avoids a potentially expensive cross-join.
    let mut mirror_sql = String::from(
        "SELECT timestamp_us, payload FROM frames WHERE buffer_id = ?1 AND frame_id = ?2",
    );
    let mut source_sql = String::from(
        "SELECT timestamp_us, payload FROM frames WHERE buffer_id = ?1 AND frame_id = ?2",
    );

    let mut mirror_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    mirror_params.push(Box::new(buffer_id.clone()));
    mirror_params.push(Box::new(mirror_frame_id as i64));

    let mut source_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    source_params.push(Box::new(buffer_id.clone()));
    source_params.push(Box::new(source_frame_id as i64));

    let mut param_idx = 3;

    if let Some(ext) = is_extended {
        let clause = format!(" AND is_extended = ?{}", param_idx);
        mirror_sql.push_str(&clause);
        source_sql.push_str(&clause);
        mirror_params.push(Box::new(ext as i32));
        source_params.push(Box::new(ext as i32));
        param_idx += 1;
    }
    if let Some(start) = start_time_us {
        let clause = format!(" AND timestamp_us >= ?{}", param_idx);
        mirror_sql.push_str(&clause);
        source_sql.push_str(&clause);
        mirror_params.push(Box::new(start));
        source_params.push(Box::new(start));
        param_idx += 1;
    }
    if let Some(end) = end_time_us {
        let clause = format!(" AND timestamp_us < ?{}", param_idx);
        mirror_sql.push_str(&clause);
        source_sql.push_str(&clause);
        mirror_params.push(Box::new(end));
        source_params.push(Box::new(end));
        param_idx += 1;
    }
    let _ = param_idx; // suppress unused warning

    mirror_sql.push_str(" ORDER BY timestamp_us");
    source_sql.push_str(" ORDER BY timestamp_us");

    let mirror_param_refs: Vec<&dyn rusqlite::types::ToSql> =
        mirror_params.iter().map(|p| p.as_ref()).collect();
    let source_param_refs: Vec<&dyn rusqlite::types::ToSql> =
        source_params.iter().map(|p| p.as_ref()).collect();

    let mirror_rows = buffer_db::query_raw_two_col(&mirror_sql, &mirror_param_refs)?;
    let source_rows = buffer_db::query_raw_two_col(&source_sql, &source_param_refs)?;

    let rows_scanned = mirror_rows.len() + source_rows.len();

    // For each mirror frame, find the closest source frame within tolerance
    let mut results = Vec::new();
    let mut source_idx = 0usize;

    for (mirror_ts, mirror_payload) in &mirror_rows {
        // Advance source_idx to the first source frame within or past the tolerance window
        while source_idx < source_rows.len()
            && source_rows[source_idx].0 < mirror_ts - tolerance_us
        {
            source_idx += 1;
        }

        // Check source frames within the tolerance window
        let mut best_match: Option<(i64, &Vec<u8>)> = None;
        let mut best_diff = i64::MAX;

        let mut check_idx = source_idx;
        while check_idx < source_rows.len()
            && source_rows[check_idx].0 <= mirror_ts + tolerance_us
        {
            let diff = (source_rows[check_idx].0 - mirror_ts).abs();
            if diff < best_diff {
                best_diff = diff;
                best_match = Some((source_rows[check_idx].0, &source_rows[check_idx].1));
            }
            check_idx += 1;
        }

        if let Some((source_ts, source_payload)) = best_match {
            // Compare payloads
            if mirror_payload != source_payload {
                let mismatch_indices: Vec<usize> = {
                    let max_len = mirror_payload.len().max(source_payload.len());
                    (0..max_len)
                        .filter(|&i| {
                            mirror_payload.get(i) != source_payload.get(i)
                        })
                        .collect()
                };

                results.push(MirrorValidationResult {
                    mirror_timestamp_us: *mirror_ts,
                    source_timestamp_us: source_ts,
                    mirror_payload: mirror_payload.clone(),
                    source_payload: source_payload.clone(),
                    mismatch_indices,
                });

                if results.len() >= result_limit as usize {
                    break;
                }
            }
        }
    }

    let elapsed = query_start.elapsed();

    tlog!(
        "[bufferquery] mirror_validation: {} results from {} rows in {}ms",
        results.len(),
        rows_scanned,
        elapsed.as_millis()
    );

    Ok(MirrorValidationQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms: elapsed.as_millis() as u64,
        },
        results,
    })
}

/// Query mux statistics for a multiplexed frame within a buffer.
///
/// Fetches payloads from the SQLite buffer, groups by mux selector byte, and
/// computes per-byte and optional 16-bit word statistics for each mux case.
#[tauri::command]
pub fn buffer_query_mux_statistics(
    buffer_id: String,
    frame_id: u32,
    mux_selector_byte: u8,
    is_extended: Option<bool>,
    include_16bit: bool,
    payload_length: u8,
    start_time_us: Option<i64>,
    end_time_us: Option<i64>,
    limit: Option<i64>,
) -> Result<MuxStatisticsQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(500_000);

    tlog!(
        "[bufferquery] mux_statistics: buffer_id='{}', frame_id={}, mux_byte={}, limit={}",
        buffer_id, frame_id, mux_selector_byte, result_limit
    );

    // Build SQL to fetch payloads
    let mut sql = String::from(
        "SELECT payload FROM frames WHERE buffer_id = ?1 AND frame_id = ?2",
    );

    let mut param_idx = 3;
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    params.push(Box::new(buffer_id.clone()));
    params.push(Box::new(frame_id as i64));

    if let Some(ext) = is_extended {
        sql.push_str(&format!(" AND is_extended = ?{}", param_idx));
        params.push(Box::new(ext as i32));
        param_idx += 1;
    }
    if let Some(start) = start_time_us {
        sql.push_str(&format!(" AND timestamp_us >= ?{}", param_idx));
        params.push(Box::new(start));
        param_idx += 1;
    }
    if let Some(end) = end_time_us {
        sql.push_str(&format!(" AND timestamp_us < ?{}", param_idx));
        params.push(Box::new(end));
        param_idx += 1;
    }

    sql.push_str(&format!(" ORDER BY rowid LIMIT ?{}", param_idx));
    params.push(Box::new(result_limit));

    // Execute query and collect payloads
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows: Vec<Vec<u8>> = buffer_db::query_payloads(&sql, &param_refs)?;

    let rows_scanned = rows.len();
    tlog!("[bufferquery] mux_statistics: fetched {} payloads", rows_scanned);

    // Group by mux selector byte
    let mux_idx = mux_selector_byte as usize;
    let mut payloads_by_mux: BTreeMap<u16, Vec<Vec<u8>>> = BTreeMap::new();
    for payload in rows {
        if mux_idx < payload.len() {
            let mux_value = payload[mux_idx] as u16;
            payloads_by_mux.entry(mux_value).or_default().push(payload);
        }
    }

    let result = compute_mux_statistics(&payloads_by_mux, include_16bit, mux_selector_byte, payload_length);
    let elapsed = query_start.elapsed();

    tlog!(
        "[bufferquery] mux_statistics: {} cases, {} total frames in {}ms",
        result.cases.len(), result.total_frames, elapsed.as_millis()
    );

    Ok(MuxStatisticsQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: result.cases.len(),
            execution_time_ms: elapsed.as_millis() as u64,
        },
        results: result,
    })
}

/// Query the first and last frames for a given frame ID within a buffer.
///
/// Returns the first timestamp/payload, last timestamp/payload, and total count.
/// Time bounds are in microseconds (matching buffer timestamp_us).
#[tauri::command]
pub fn buffer_query_first_last(
    buffer_id: String,
    frame_id: u32,
    is_extended: Option<bool>,
    start_time_us: Option<i64>,
    end_time_us: Option<i64>,
) -> Result<FirstLastQueryResult, String> {
    let query_start = std::time::Instant::now();

    tlog!(
        "[bufferquery] first_last: buffer_id='{}', frame_id={}, is_extended={:?}",
        buffer_id, frame_id, is_extended
    );

    // Build the shared WHERE clause for all three queries
    let mut where_clause = String::from("WHERE buffer_id = ?1 AND frame_id = ?2");
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    params.push(Box::new(buffer_id.clone()));
    params.push(Box::new(frame_id as i64));

    let mut param_idx = 3;

    if let Some(ext) = is_extended {
        where_clause.push_str(&format!(" AND is_extended = ?{}", param_idx));
        params.push(Box::new(ext as i32));
        param_idx += 1;
    }
    if let Some(start) = start_time_us {
        where_clause.push_str(&format!(" AND timestamp_us >= ?{}", param_idx));
        params.push(Box::new(start));
        param_idx += 1;
    }
    if let Some(end) = end_time_us {
        where_clause.push_str(&format!(" AND timestamp_us < ?{}", param_idx));
        params.push(Box::new(end));
        param_idx += 1;
    }
    let _ = param_idx; // suppress unused warning

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    // Query 1: first frame (ASC)
    let first_sql = format!(
        "SELECT timestamp_us, payload FROM frames {} ORDER BY rowid ASC LIMIT 1",
        where_clause
    );
    let first_rows = buffer_db::query_raw_two_col(&first_sql, &param_refs)?;

    // Query 2: last frame (DESC)
    let last_sql = format!(
        "SELECT timestamp_us, payload FROM frames {} ORDER BY rowid DESC LIMIT 1",
        where_clause
    );
    let last_rows = buffer_db::query_raw_two_col(&last_sql, &param_refs)?;

    // Query 3: total count
    let count_sql = format!("SELECT COUNT(*), x'00' FROM frames {}", where_clause);
    let count_rows = buffer_db::query_raw_two_col(&count_sql, &param_refs)?;
    let total_count = count_rows.first().map(|(c, _)| *c).unwrap_or(0);

    let rows_scanned = 2 + 1; // 2 LIMIT-1 queries + 1 count query (logical)

    let (first_timestamp_us, first_payload) = first_rows
        .first()
        .map(|(ts, p)| (*ts, p.clone()))
        .ok_or_else(|| "No frames found for the given filters".to_string())?;

    let (last_timestamp_us, last_payload) = last_rows
        .first()
        .map(|(ts, p)| (*ts, p.clone()))
        .ok_or_else(|| "No frames found for the given filters".to_string())?;

    let elapsed = query_start.elapsed();

    tlog!(
        "[bufferquery] first_last: count={}, first_ts={}, last_ts={} in {}ms",
        total_count, first_timestamp_us, last_timestamp_us, elapsed.as_millis()
    );

    Ok(FirstLastQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: 1,
            execution_time_ms: elapsed.as_millis() as u64,
        },
        results: FirstLastResult {
            first_timestamp_us,
            first_payload,
            last_timestamp_us,
            last_payload,
            total_count,
        },
    })
}

/// Query frame frequency / interval statistics bucketed over time.
///
/// Groups frames into time buckets and computes min/max/avg inter-frame intervals
/// within each bucket. Useful for detecting jitter, dropouts, and timing drift.
#[tauri::command]
pub fn buffer_query_frequency(
    buffer_id: String,
    frame_id: u32,
    is_extended: Option<bool>,
    bucket_size_ms: u32,
    start_time_us: Option<i64>,
    end_time_us: Option<i64>,
    limit: Option<i64>,
) -> Result<FrequencyQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(100_000);

    tlog!(
        "[bufferquery] frequency: buffer_id='{}', frame_id={}, bucket_size_ms={}, is_extended={:?}, limit={}",
        buffer_id, frame_id, bucket_size_ms, is_extended, result_limit
    );

    // Build SQL to fetch timestamps (use query_raw_two_col, ignore payload)
    let mut sql = String::from(
        "SELECT timestamp_us, payload FROM frames WHERE buffer_id = ?1 AND frame_id = ?2",
    );

    let mut param_idx = 3;
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    params.push(Box::new(buffer_id.clone()));
    params.push(Box::new(frame_id as i64));

    if let Some(ext) = is_extended {
        sql.push_str(&format!(" AND is_extended = ?{}", param_idx));
        params.push(Box::new(ext as i32));
        param_idx += 1;
    }
    if let Some(start) = start_time_us {
        sql.push_str(&format!(" AND timestamp_us >= ?{}", param_idx));
        params.push(Box::new(start));
        param_idx += 1;
    }
    if let Some(end) = end_time_us {
        sql.push_str(&format!(" AND timestamp_us < ?{}", param_idx));
        params.push(Box::new(end));
        param_idx += 1;
    }

    sql.push_str(&format!(" ORDER BY rowid LIMIT ?{}", param_idx));
    params.push(Box::new(result_limit));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = buffer_db::query_raw_two_col(&sql, &param_refs)?;
    let rows_scanned = rows.len();

    // Extract just timestamps
    let timestamps: Vec<i64> = rows.iter().map(|(ts, _)| *ts).collect();

    // Compute intervals and group by bucket
    let bucket_us = bucket_size_ms as i64 * 1000;
    let mut bucket_map: BTreeMap<i64, Vec<f64>> = BTreeMap::new();

    for window in timestamps.windows(2) {
        let interval_us = (window[1] - window[0]) as f64;
        let bucket_start = (window[1] / bucket_us) * bucket_us;
        bucket_map.entry(bucket_start).or_default().push(interval_us);
    }

    // Build results
    let mut results = Vec::with_capacity(bucket_map.len());
    for (bucket_start_us, intervals) in &bucket_map {
        let frame_count = intervals.len() as i64 + 1; // +1 because intervals = frames - 1
        let min_interval_us = intervals.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_interval_us = intervals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let avg_interval_us = intervals.iter().sum::<f64>() / intervals.len() as f64;

        results.push(FrequencyBucket {
            bucket_start_us: *bucket_start_us,
            frame_count,
            min_interval_us,
            max_interval_us,
            avg_interval_us,
        });
    }

    let elapsed = query_start.elapsed();

    tlog!(
        "[bufferquery] frequency: {} buckets from {} rows in {}ms",
        results.len(),
        rows_scanned,
        elapsed.as_millis()
    );

    Ok(FrequencyQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms: elapsed.as_millis() as u64,
        },
        results,
    })
}

/// Query byte value distribution for a specific byte position in a frame.
///
/// Counts how often each byte value (0-255) appears at the given byte index,
/// returning value, count, and percentage.
#[tauri::command]
pub fn buffer_query_distribution(
    buffer_id: String,
    frame_id: u32,
    byte_index: u8,
    is_extended: Option<bool>,
    start_time_us: Option<i64>,
    end_time_us: Option<i64>,
) -> Result<DistributionQueryResult, String> {
    let query_start = std::time::Instant::now();

    tlog!(
        "[bufferquery] distribution: buffer_id='{}', frame_id={}, byte_index={}, is_extended={:?}",
        buffer_id, frame_id, byte_index, is_extended
    );

    // Build SQL to fetch payloads
    let mut sql = String::from(
        "SELECT payload FROM frames WHERE buffer_id = ?1 AND frame_id = ?2",
    );

    let mut param_idx = 3;
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    params.push(Box::new(buffer_id.clone()));
    params.push(Box::new(frame_id as i64));

    if let Some(ext) = is_extended {
        sql.push_str(&format!(" AND is_extended = ?{}", param_idx));
        params.push(Box::new(ext as i32));
        param_idx += 1;
    }
    if let Some(start) = start_time_us {
        sql.push_str(&format!(" AND timestamp_us >= ?{}", param_idx));
        params.push(Box::new(start));
        param_idx += 1;
    }
    if let Some(end) = end_time_us {
        sql.push_str(&format!(" AND timestamp_us < ?{}", param_idx));
        params.push(Box::new(end));
        param_idx += 1;
    }
    let _ = param_idx; // suppress unused warning

    sql.push_str(" ORDER BY rowid");

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let payloads = buffer_db::query_payloads(&sql, &param_refs)?;

    let rows_scanned = payloads.len();
    let byte_idx = byte_index as usize;

    // Count occurrences of each byte value
    let mut counts: HashMap<u8, i64> = HashMap::new();
    let mut total: i64 = 0;

    for payload in &payloads {
        if let Some(&val) = payload.get(byte_idx) {
            *counts.entry(val).or_insert(0) += 1;
            total += 1;
        }
    }

    // Build results sorted by value
    let mut results: Vec<DistributionResult> = counts
        .into_iter()
        .map(|(value, count)| DistributionResult {
            value,
            count,
            percentage: if total > 0 {
                (count as f64 / total as f64) * 100.0
            } else {
                0.0
            },
        })
        .collect();
    results.sort_by_key(|r| r.value);

    let elapsed = query_start.elapsed();

    tlog!(
        "[bufferquery] distribution: {} distinct values from {} rows in {}ms",
        results.len(),
        rows_scanned,
        elapsed.as_millis()
    );

    Ok(DistributionQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms: elapsed.as_millis() as u64,
        },
        results,
    })
}

/// Analyse gaps in frame transmission for a given frame ID.
///
/// Finds inter-frame intervals that exceed the specified threshold, returning
/// them sorted by duration (longest first). Useful for detecting dropouts.
#[tauri::command]
pub fn buffer_query_gap_analysis(
    buffer_id: String,
    frame_id: u32,
    is_extended: Option<bool>,
    gap_threshold_ms: f64,
    start_time_us: Option<i64>,
    end_time_us: Option<i64>,
    limit: Option<i64>,
) -> Result<GapAnalysisQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(10000);

    tlog!(
        "[bufferquery] gap_analysis: buffer_id='{}', frame_id={}, threshold_ms={}, is_extended={:?}, limit={}",
        buffer_id, frame_id, gap_threshold_ms, is_extended, result_limit
    );

    // Build SQL to fetch timestamps (use query_raw_two_col, ignore payload)
    let mut sql = String::from(
        "SELECT timestamp_us, payload FROM frames WHERE buffer_id = ?1 AND frame_id = ?2",
    );

    let mut param_idx = 3;
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    params.push(Box::new(buffer_id.clone()));
    params.push(Box::new(frame_id as i64));

    if let Some(ext) = is_extended {
        sql.push_str(&format!(" AND is_extended = ?{}", param_idx));
        params.push(Box::new(ext as i32));
        param_idx += 1;
    }
    if let Some(start) = start_time_us {
        sql.push_str(&format!(" AND timestamp_us >= ?{}", param_idx));
        params.push(Box::new(start));
        param_idx += 1;
    }
    if let Some(end) = end_time_us {
        sql.push_str(&format!(" AND timestamp_us < ?{}", param_idx));
        params.push(Box::new(end));
        param_idx += 1;
    }
    let _ = param_idx; // suppress unused warning

    sql.push_str(" ORDER BY rowid");

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = buffer_db::query_raw_two_col(&sql, &param_refs)?;
    let rows_scanned = rows.len();

    // Extract timestamps and find gaps exceeding threshold
    let threshold_us = gap_threshold_ms * 1000.0;
    let mut results: Vec<GapResult> = Vec::new();

    let timestamps: Vec<i64> = rows.iter().map(|(ts, _)| *ts).collect();

    for window in timestamps.windows(2) {
        let gap_us = (window[1] - window[0]) as f64;
        if gap_us > threshold_us {
            results.push(GapResult {
                gap_start_us: window[0],
                gap_end_us: window[1],
                duration_ms: gap_us / 1000.0,
            });
        }
    }

    // Sort by duration descending (longest gaps first)
    results.sort_by(|a, b| b.duration_ms.partial_cmp(&a.duration_ms).unwrap_or(std::cmp::Ordering::Equal));

    // Apply limit
    results.truncate(result_limit as usize);

    let elapsed = query_start.elapsed();

    tlog!(
        "[bufferquery] gap_analysis: {} gaps from {} rows in {}ms",
        results.len(),
        rows_scanned,
        elapsed.as_millis()
    );

    Ok(GapAnalysisQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms: elapsed.as_millis() as u64,
        },
        results,
    })
}

/// Search for a byte pattern across all frames in a buffer using a mask.
///
/// For each frame, checks if the pattern matches anywhere in the payload.
/// A position `p` matches if for all `i` in `0..pattern.len()`,
/// `(payload[p+i] & mask[i]) == (pattern[i] & mask[i])`.
/// No frame_id filter — searches across ALL frame IDs.
#[tauri::command]
pub fn buffer_query_pattern_search(
    buffer_id: String,
    pattern: Vec<u8>,
    pattern_mask: Vec<u8>,
    start_time_us: Option<i64>,
    end_time_us: Option<i64>,
    limit: Option<i64>,
) -> Result<PatternSearchQueryResult, String> {
    let query_start = std::time::Instant::now();
    let result_limit = limit.unwrap_or(10000);

    tlog!(
        "[bufferquery] pattern_search: buffer_id='{}', pattern_len={}, mask_len={}, limit={}",
        buffer_id, pattern.len(), pattern_mask.len(), result_limit
    );

    if pattern.len() != pattern_mask.len() {
        return Err("Pattern and mask must have the same length".to_string());
    }
    if pattern.is_empty() {
        return Err("Pattern must not be empty".to_string());
    }

    // Build SQL — no frame_id filter, search across all frames
    let mut sql = String::from(
        "SELECT timestamp_us, frame_id, is_extended, payload FROM frames WHERE buffer_id = ?1",
    );

    let mut param_idx = 2;
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    params.push(Box::new(buffer_id.clone()));

    if let Some(start) = start_time_us {
        sql.push_str(&format!(" AND timestamp_us >= ?{}", param_idx));
        params.push(Box::new(start));
        param_idx += 1;
    }
    if let Some(end) = end_time_us {
        sql.push_str(&format!(" AND timestamp_us < ?{}", param_idx));
        params.push(Box::new(end));
        param_idx += 1;
    }
    let _ = param_idx; // suppress unused warning

    sql.push_str(" ORDER BY rowid");

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = buffer_db::query_raw_four_col(&sql, &param_refs)?;
    let rows_scanned = rows.len();

    // Pre-compute masked pattern for comparison
    let masked_pattern: Vec<u8> = pattern
        .iter()
        .zip(pattern_mask.iter())
        .map(|(&p, &m)| p & m)
        .collect();
    let pat_len = pattern.len();

    let mut results: Vec<PatternSearchResult> = Vec::new();

    for (timestamp_us, frame_id_val, is_ext, payload) in &rows {
        if payload.len() < pat_len {
            continue;
        }

        let mut match_positions = Vec::new();

        for p in 0..=(payload.len() - pat_len) {
            let mut matches = true;
            for i in 0..pat_len {
                if (payload[p + i] & pattern_mask[i]) != masked_pattern[i] {
                    matches = false;
                    break;
                }
            }
            if matches {
                match_positions.push(p);
            }
        }

        if !match_positions.is_empty() {
            results.push(PatternSearchResult {
                timestamp_us: *timestamp_us,
                frame_id: *frame_id_val as u32,
                is_extended: *is_ext,
                payload: payload.clone(),
                match_positions,
            });

            if results.len() >= result_limit as usize {
                break;
            }
        }
    }

    let elapsed = query_start.elapsed();

    tlog!(
        "[bufferquery] pattern_search: {} matches from {} rows in {}ms",
        results.len(),
        rows_scanned,
        elapsed.as_millis()
    );

    Ok(PatternSearchQueryResult {
        stats: QueryStats {
            rows_scanned,
            results_count: results.len(),
            execution_time_ms: elapsed.as_millis() as u64,
        },
        results,
    })
}
