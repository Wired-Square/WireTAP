// ui/src-tauri/src/bufferquery.rs
//
// Query commands for running analytical queries against buffer SQLite data.
// Mirrors the PostgreSQL query commands in dbquery.rs but operates on the
// local buffer_db instead.

use std::collections::BTreeMap;

use crate::buffer_db;
use crate::dbquery::{
    ByteChangeQueryResult, ByteChangeResult, FrameChangeQueryResult, FrameChangeResult,
    MirrorValidationQueryResult, MirrorValidationResult, MuxStatisticsQueryResult, QueryStats,
    compute_mux_statistics,
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
