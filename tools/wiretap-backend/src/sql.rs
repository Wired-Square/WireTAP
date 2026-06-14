//! Analytical queries over a capture database — ported from the desktop's
//! src-tauri/src/dbquery.rs (SQL kept intentionally close to verbatim so the
//! two stay in lockstep; the desktop A/B parity test guards drift).

use std::collections::BTreeMap;
use std::time::Instant;

use base64::Engine;
use futures_util::TryStreamExt;
use serde::Deserialize;
use tokio_postgres::types::ToSql;
use tokio_postgres::Client;

use crate::types::*;

// ---------------------------------------------------------------------------
// Parameter plumbing
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Args {
    boxed: Vec<Box<dyn ToSql + Sync + Send>>,
}

impl Args {
    /// Add a parameter; returns its 1-based placeholder index.
    fn add<T: ToSql + Sync + Send + 'static>(&mut self, v: T) -> usize {
        self.boxed.push(Box::new(v));
        self.boxed.len()
    }

    fn refs(&self) -> Vec<&(dyn ToSql + Sync)> {
        self.boxed.iter().map(|b| b.as_ref() as &(dyn ToSql + Sync)).collect()
    }
}

/// Common per-frame filter (id, optional extended flag, optional time range).
#[derive(Debug, Clone, Deserialize)]
pub struct FrameFilter {
    pub frame_id: u32,
    pub is_extended: Option<bool>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
}

impl FrameFilter {
    fn where_clause(&self, args: &mut Args) -> String {
        let mut sql = format!("WHERE id = ${}::int4", args.add(self.frame_id as i32));
        if let Some(ext) = self.is_extended {
            sql += &format!(" AND extended = ${}::bool", args.add(ext));
        }
        sql += &time_clause(args, &self.start_time, &self.end_time);
        sql
    }
}

fn time_clause(args: &mut Args, start: &Option<String>, end: &Option<String>) -> String {
    let mut sql = String::new();
    if let Some(s) = start {
        sql += &format!(" AND ts >= (${}::text)::timestamptz", args.add(s.clone()));
    }
    if let Some(e) = end {
        sql += &format!(" AND ts < (${}::text)::timestamptz", args.add(e.clone()));
    }
    sql
}

fn stats(start: Instant, rows_scanned: usize, results_count: usize) -> QueryStats {
    QueryStats {
        rows_scanned,
        results_count,
        execution_time_ms: start.elapsed().as_millis() as u64,
    }
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ByteChangesParams {
    #[serde(flatten)]
    pub filter: FrameFilter,
    pub byte_index: u8,
    pub limit: Option<u32>,
    pub query_id: Option<String>,
}

pub async fn byte_changes(
    client: &Client,
    p: &ByteChangesParams,
) -> Result<ByteChangeQueryResult, String> {
    let t0 = Instant::now();
    let limit = p.limit.unwrap_or(10000);
    let mut args = Args::default();
    let byte_idx = args.add(p.byte_index as i32);
    // frame filter appends after the byte param so placeholder order matches
    let mut filter_args = String::new();
    {
        let w = p.filter.where_clause(&mut args);
        filter_args.push_str(&w);
    }
    let query = format!(
        "WITH ordered_frames AS (\
            SELECT ts, \
                   public.get_byte_safe(data_bytes, ${byte_idx}::int4) AS curr_byte, \
                   LAG(public.get_byte_safe(data_bytes, ${byte_idx}::int4)) OVER (ORDER BY ts) AS prev_byte \
            FROM public.can_frame {filter_args} ORDER BY ts) \
         SELECT (EXTRACT(EPOCH FROM ts) * 1000000)::float8 AS timestamp_us, prev_byte, curr_byte \
         FROM ordered_frames \
         WHERE prev_byte IS NOT NULL AND curr_byte IS NOT NULL \
           AND prev_byte IS DISTINCT FROM curr_byte \
         ORDER BY ts LIMIT {limit}"
    );
    let rows = client.query(&query, &args.refs()).await.map_err(|e| format!("Query failed: {e}"))?;
    let results: Vec<ByteChangeResult> = rows
        .iter()
        .map(|row| ByteChangeResult {
            timestamp_us: row.get::<_, f64>("timestamp_us") as i64,
            old_value: row.get::<_, i32>("prev_byte") as u8,
            new_value: row.get::<_, i32>("curr_byte") as u8,
        })
        .collect();
    let n = results.len();
    Ok(ByteChangeQueryResult { results, stats: stats(t0, n, n) })
}

#[derive(Debug, Deserialize)]
pub struct FrameChangesParams {
    #[serde(flatten)]
    pub filter: FrameFilter,
    pub limit: Option<u32>,
    pub query_id: Option<String>,
}

pub async fn frame_changes(
    client: &Client,
    p: &FrameChangesParams,
) -> Result<FrameChangeQueryResult, String> {
    let t0 = Instant::now();
    let limit = p.limit.unwrap_or(10000);
    let mut args = Args::default();
    let w = p.filter.where_clause(&mut args);
    let query = format!(
        "WITH ordered_frames AS (\
            SELECT ts, data_bytes, LAG(data_bytes) OVER (ORDER BY ts) AS prev_data \
            FROM public.can_frame {w} ORDER BY ts) \
         SELECT (EXTRACT(EPOCH FROM ts) * 1000000)::float8 AS timestamp_us, prev_data, data_bytes \
         FROM ordered_frames \
         WHERE prev_data IS NOT NULL AND prev_data IS DISTINCT FROM data_bytes \
         ORDER BY ts LIMIT {limit}"
    );
    let rows = client.query(&query, &args.refs()).await.map_err(|e| format!("Query failed: {e}"))?;
    let results: Vec<FrameChangeResult> = rows
        .iter()
        .map(|row| {
            let old_payload: Vec<u8> = row.get("prev_data");
            let new_payload: Vec<u8> = row.get("data_bytes");
            let changed_indices = diff_indices(&old_payload, &new_payload);
            FrameChangeResult {
                timestamp_us: row.get::<_, f64>("timestamp_us") as i64,
                old_payload,
                new_payload,
                changed_indices,
            }
        })
        .collect();
    let n = results.len();
    Ok(FrameChangeQueryResult { results, stats: stats(t0, n, n) })
}

fn diff_indices(a: &[u8], b: &[u8]) -> Vec<usize> {
    (0..a.len().max(b.len()))
        .filter(|&i| a.get(i).copied().unwrap_or(0) != b.get(i).copied().unwrap_or(0))
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct MirrorValidationParams {
    pub mirror_frame_id: u32,
    pub source_frame_id: u32,
    pub is_extended: Option<bool>,
    pub tolerance_ms: u32,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub limit: Option<u32>,
    pub query_id: Option<String>,
}

pub async fn mirror_validation(
    client: &Client,
    p: &MirrorValidationParams,
) -> Result<MirrorValidationQueryResult, String> {
    let t0 = Instant::now();
    let limit = p.limit.unwrap_or(10000);
    let mut args = Args::default();
    let mirror_id = args.add(p.mirror_frame_id as i32);
    let source_id = args.add(p.source_frame_id as i32);
    let tolerance = args.add(p.tolerance_ms as i32);
    let mut extra = String::new();
    if let Some(ext) = p.is_extended {
        extra += &format!(" AND extended = ${}::bool", args.add(ext));
    }
    extra += &time_clause(&mut args, &p.start_time, &p.end_time);
    let query = format!(
        "WITH mirror_frames AS (\
            SELECT ts, data_bytes FROM public.can_frame WHERE id = ${mirror_id}::int4{extra}), \
         source_frames AS (\
            SELECT ts, data_bytes FROM public.can_frame WHERE id = ${source_id}::int4{extra}) \
         SELECT (EXTRACT(EPOCH FROM m.ts) * 1000000)::float8 AS mirror_ts, \
                (EXTRACT(EPOCH FROM s.ts) * 1000000)::float8 AS source_ts, \
                m.data_bytes AS mirror_payload, s.data_bytes AS source_payload \
         FROM mirror_frames m \
         JOIN source_frames s ON ABS(EXTRACT(EPOCH FROM (m.ts - s.ts)) * 1000) < ${tolerance}::int4 \
         WHERE m.data_bytes IS DISTINCT FROM s.data_bytes \
         ORDER BY m.ts LIMIT {limit}"
    );
    let rows = client.query(&query, &args.refs()).await.map_err(|e| format!("Query failed: {e}"))?;
    let results: Vec<MirrorValidationResult> = rows
        .iter()
        .map(|row| {
            let mirror_payload: Vec<u8> = row.get("mirror_payload");
            let source_payload: Vec<u8> = row.get("source_payload");
            let mismatch_indices = diff_indices(&mirror_payload, &source_payload);
            MirrorValidationResult {
                mirror_timestamp_us: row.get::<_, f64>("mirror_ts") as i64,
                source_timestamp_us: row.get::<_, f64>("source_ts") as i64,
                mirror_payload,
                source_payload,
                mismatch_indices,
            }
        })
        .collect();
    let n = results.len();
    Ok(MirrorValidationQueryResult { results, stats: stats(t0, n, n) })
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct MuxStatisticsParams {
    #[serde(flatten)]
    pub filter: FrameFilter,
    pub mux_selector_byte: u8,
    pub include_16bit: bool,
    pub payload_length: u8,
    pub limit: Option<u32>,
    pub query_id: Option<String>,
}

pub async fn mux_statistics(
    client: &Client,
    p: &MuxStatisticsParams,
) -> Result<MuxStatisticsQueryResult, String> {
    let t0 = Instant::now();
    let limit = p.limit.unwrap_or(500_000);
    let mux = p.mux_selector_byte as i32;
    let plen = p.payload_length as i32;

    let mut args = Args::default();
    let w = p.filter.where_clause(&mut args);
    let src = format!(
        "SELECT data_bytes FROM public.can_frame {w} \
         AND octet_length(data_bytes) > {mux} ORDER BY ts LIMIT {limit}"
    );

    let count_query = format!(
        "SELECT public.get_byte_safe(data_bytes, {mux})::int4 AS mux_value, \
         COUNT(*)::int8 AS frame_count FROM ({src}) s GROUP BY 1 ORDER BY 1"
    );
    let byte_query = format!(
        "SELECT public.get_byte_safe(data_bytes, {mux})::int4 AS mux_value, \
         b.idx::int4 AS byte_index, \
         MIN(public.get_byte_safe(data_bytes, b.idx))::int4 AS min, \
         MAX(public.get_byte_safe(data_bytes, b.idx))::int4 AS max, \
         AVG(public.get_byte_safe(data_bytes, b.idx))::float8 AS avg, \
         COUNT(DISTINCT public.get_byte_safe(data_bytes, b.idx))::int8 AS distinct_count, \
         COUNT(public.get_byte_safe(data_bytes, b.idx))::int8 AS sample_count \
         FROM ({src}) s CROSS JOIN generate_series({start_b}, {end_b}) AS b(idx) \
         GROUP BY 1, 2 HAVING COUNT(public.get_byte_safe(data_bytes, b.idx)) > 0 \
         ORDER BY 1, 2",
        start_b = mux + 1,
        end_b = plen - 1,
    );

    let count_rows =
        client.query(&count_query, &args.refs()).await.map_err(|e| format!("Query failed: {e}"))?;
    let byte_rows = client
        .query(&byte_query, &args.refs())
        .await
        .map_err(|e| format!("Byte stats query failed: {e}"))?;

    let mut cases: BTreeMap<u16, MuxCaseStats> = BTreeMap::new();
    let mut total_frames: u64 = 0;
    for row in &count_rows {
        let mux_value = row.get::<_, i32>("mux_value") as u16;
        let frame_count = row.get::<_, i64>("frame_count") as u64;
        total_frames += frame_count;
        cases.insert(
            mux_value,
            MuxCaseStats { mux_value, frame_count, byte_stats: Vec::new(), word16_stats: Vec::new() },
        );
    }
    for row in &byte_rows {
        let mux_value = row.get::<_, i32>("mux_value") as u16;
        if let Some(case) = cases.get_mut(&mux_value) {
            case.byte_stats.push(BytePositionStats {
                byte_index: row.get::<_, i32>("byte_index") as u8,
                min: row.get::<_, i32>("min") as u8,
                max: row.get::<_, i32>("max") as u8,
                avg: row.get("avg"),
                distinct_count: row.get::<_, i64>("distinct_count") as u32,
                sample_count: row.get::<_, i64>("sample_count") as u64,
            });
        }
    }

    if p.include_16bit {
        let word_query = format!(
            "SELECT mux_value::int4, start_byte::int4, \
             MIN(le_val)::int4 AS le_min, MAX(le_val)::int4 AS le_max, \
             AVG(le_val)::float8 AS le_avg, COUNT(DISTINCT le_val)::int8 AS le_distinct, \
             MIN(be_val)::int4 AS be_min, MAX(be_val)::int4 AS be_max, \
             AVG(be_val)::float8 AS be_avg, COUNT(DISTINCT be_val)::int8 AS be_distinct \
             FROM (SELECT public.get_byte_safe(data_bytes, {mux}) AS mux_value, \
                   w.idx AS start_byte, \
                   public.get_byte_safe(data_bytes, w.idx) | \
                   (public.get_byte_safe(data_bytes, w.idx + 1) << 8) AS le_val, \
                   (public.get_byte_safe(data_bytes, w.idx) << 8) | \
                   public.get_byte_safe(data_bytes, w.idx + 1) AS be_val \
                   FROM ({src}) s CROSS JOIN generate_series({start_b}, {end_b}, 2) AS w(idx)) t \
             GROUP BY 1, 2 HAVING COUNT(le_val) > 0 ORDER BY 1, 2",
            start_b = mux + 1,
            end_b = plen - 2,
        );
        let word_rows = client
            .query(&word_query, &args.refs())
            .await
            .map_err(|e| format!("Word stats query failed: {e}"))?;
        for row in &word_rows {
            let mux_value = row.get::<_, i32>("mux_value") as u16;
            if let Some(case) = cases.get_mut(&mux_value) {
                let start_byte = row.get::<_, i32>("start_byte") as u8;
                for (endianness, prefix) in [("le", "le"), ("be", "be")] {
                    case.word16_stats.push(Word16Stats {
                        start_byte,
                        endianness: endianness.to_string(),
                        min: row.get::<_, i32>(format!("{prefix}_min").as_str()) as u16,
                        max: row.get::<_, i32>(format!("{prefix}_max").as_str()) as u16,
                        avg: row.get(format!("{prefix}_avg").as_str()),
                        distinct_count: row.get::<_, i64>(format!("{prefix}_distinct").as_str())
                            as u32,
                    });
                }
            }
        }
    }

    let case_count = cases.len();
    Ok(MuxStatisticsQueryResult {
        results: MuxStatisticsResult {
            mux_byte: p.mux_selector_byte,
            total_frames,
            cases: cases.into_values().collect(),
        },
        stats: stats(t0, total_frames as usize, case_count),
    })
}

#[derive(Debug, Deserialize)]
pub struct FirstLastParams {
    #[serde(flatten)]
    pub filter: FrameFilter,
    pub query_id: Option<String>,
}

pub async fn first_last(client: &Client, p: &FirstLastParams) -> Result<FirstLastQueryResult, String> {
    let t0 = Instant::now();
    let mut args = Args::default();
    let w = p.filter.where_clause(&mut args);
    let select =
        "SELECT (EXTRACT(EPOCH FROM ts) * 1000000)::float8 AS timestamp_us, data_bytes FROM public.can_frame";

    let first_rows = client
        .query(&format!("{select} {w} ORDER BY ts ASC LIMIT 1"), &args.refs())
        .await
        .map_err(|e| format!("First query failed: {e}"))?;
    if first_rows.is_empty() {
        return Err("No frames found matching the filter".to_string());
    }
    let last_rows = client
        .query(&format!("{select} {w} ORDER BY ts DESC LIMIT 1"), &args.refs())
        .await
        .map_err(|e| format!("Last query failed: {e}"))?;
    let count_rows = client
        .query(&format!("SELECT COUNT(*) AS count FROM public.can_frame {w}"), &args.refs())
        .await
        .map_err(|e| format!("Count query failed: {e}"))?;

    Ok(FirstLastQueryResult {
        results: FirstLastResult {
            first_timestamp_us: first_rows[0].get::<_, f64>("timestamp_us") as i64,
            first_payload: first_rows[0].get("data_bytes"),
            last_timestamp_us: last_rows[0].get::<_, f64>("timestamp_us") as i64,
            last_payload: last_rows[0].get("data_bytes"),
            total_count: count_rows[0].get("count"),
        },
        stats: stats(t0, 3, 1),
    })
}

#[derive(Debug, Deserialize)]
pub struct FrequencyParams {
    #[serde(flatten)]
    pub filter: FrameFilter,
    pub bucket_size_ms: u32,
    pub limit: Option<u32>,
    pub query_id: Option<String>,
}

pub async fn frequency(client: &Client, p: &FrequencyParams) -> Result<FrequencyQueryResult, String> {
    let t0 = Instant::now();
    let limit = p.limit.unwrap_or(500_000);
    let bucket_us = p.bucket_size_ms as i64 * 1000;
    let mut args = Args::default();
    let w = p.filter.where_clause(&mut args);
    let query = format!(
        "SELECT (trunc((EXTRACT(EPOCH FROM ts) * 1000000) / {bucket_us}) * {bucket_us})::float8 AS bucket_start_us, \
         COUNT(*)::int8 AS frame_count, \
         MIN(dt_us)::float8 AS min_interval_us, \
         MAX(dt_us)::float8 AS max_interval_us, \
         AVG(dt_us)::float8 AS avg_interval_us \
         FROM (SELECT ts, EXTRACT(EPOCH FROM ts - LAG(ts) OVER (ORDER BY ts)) * 1000000 AS dt_us \
               FROM (SELECT ts FROM public.can_frame {w} ORDER BY ts LIMIT {limit}) f) s \
         WHERE dt_us IS NOT NULL GROUP BY 1 ORDER BY 1"
    );
    let rows = client.query(&query, &args.refs()).await.map_err(|e| format!("Query failed: {e}"))?;
    let mut rows_scanned = 0usize;
    let results: Vec<FrequencyBucket> = rows
        .iter()
        .map(|row| {
            let frame_count: i64 = row.get("frame_count");
            rows_scanned += frame_count as usize;
            FrequencyBucket {
                bucket_start_us: row.get::<_, f64>("bucket_start_us") as i64,
                frame_count,
                min_interval_us: row.get("min_interval_us"),
                max_interval_us: row.get("max_interval_us"),
                avg_interval_us: row.get("avg_interval_us"),
            }
        })
        .collect();
    let n = results.len();
    Ok(FrequencyQueryResult { results, stats: stats(t0, rows_scanned, n) })
}

#[derive(Debug, Deserialize)]
pub struct DistributionParams {
    #[serde(flatten)]
    pub filter: FrameFilter,
    pub byte_index: u8,
    pub query_id: Option<String>,
}

pub async fn distribution(
    client: &Client,
    p: &DistributionParams,
) -> Result<DistributionQueryResult, String> {
    let t0 = Instant::now();
    let mut args = Args::default();
    let byte_idx = args.add(p.byte_index as i32);
    let w = p.filter.where_clause(&mut args);
    let query = format!(
        "SELECT public.get_byte_safe(data_bytes, ${byte_idx}::int4) AS value, COUNT(*) AS count \
         FROM public.can_frame {w} GROUP BY value ORDER BY count DESC"
    );
    let rows = client.query(&query, &args.refs()).await.map_err(|e| format!("Query failed: {e}"))?;
    let mut results: Vec<DistributionResult> = Vec::new();
    let mut total: i64 = 0;
    for row in &rows {
        let count: i64 = row.get("count");
        total += count;
        results.push(DistributionResult {
            value: row.get::<_, i32>("value") as u8,
            count,
            percentage: 0.0,
        });
    }
    if total > 0 {
        for r in &mut results {
            r.percentage = (r.count as f64 / total as f64) * 100.0;
        }
    }
    let n = results.len();
    Ok(DistributionQueryResult { results, stats: stats(t0, n, n) })
}

#[derive(Debug, Deserialize)]
pub struct GapAnalysisParams {
    #[serde(flatten)]
    pub filter: FrameFilter,
    pub gap_threshold_ms: f64,
    pub limit: Option<u32>,
    pub query_id: Option<String>,
}

pub async fn gap_analysis(
    client: &Client,
    p: &GapAnalysisParams,
) -> Result<GapAnalysisQueryResult, String> {
    let t0 = Instant::now();
    let limit = p.limit.unwrap_or(10000);
    let threshold = format!("{:?}", p.gap_threshold_ms);
    let mut args = Args::default();
    let w = p.filter.where_clause(&mut args);
    let query = format!(
        "SELECT (EXTRACT(EPOCH FROM prev_ts) * 1000000)::float8 AS gap_start_us, \
         (EXTRACT(EPOCH FROM ts) * 1000000)::float8 AS gap_end_us, \
         (EXTRACT(EPOCH FROM ts - prev_ts) * 1000)::float8 AS duration_ms \
         FROM (SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev_ts \
               FROM (SELECT ts FROM public.can_frame {w}) f) s \
         WHERE prev_ts IS NOT NULL \
         AND (EXTRACT(EPOCH FROM ts - prev_ts) * 1000)::float8 > {threshold} \
         ORDER BY duration_ms DESC LIMIT {limit}"
    );
    let rows = client.query(&query, &args.refs()).await.map_err(|e| format!("Query failed: {e}"))?;
    let results: Vec<GapResult> = rows
        .iter()
        .map(|row| GapResult {
            gap_start_us: row.get::<_, f64>("gap_start_us") as i64,
            gap_end_us: row.get::<_, f64>("gap_end_us") as i64,
            duration_ms: row.get("duration_ms"),
        })
        .collect();
    let n = results.len();
    Ok(GapAnalysisQueryResult { results, stats: stats(t0, n, n) })
}

#[derive(Debug, Deserialize)]
pub struct PatternSearchParams {
    pub pattern: Vec<u8>,
    pub pattern_mask: Vec<u8>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub limit: Option<u32>,
    pub query_id: Option<String>,
}

pub async fn pattern_search(
    client: &Client,
    p: &PatternSearchParams,
) -> Result<PatternSearchQueryResult, String> {
    let t0 = Instant::now();
    if p.pattern.len() != p.pattern_mask.len() {
        return Err("Pattern and mask must have the same length".into());
    }
    if p.pattern.is_empty() {
        return Err("Pattern must not be empty".into());
    }
    let result_limit = p.limit.unwrap_or(10000) as usize;
    let mut args = Args::default();
    let w = time_clause(&mut args, &p.start_time, &p.end_time);
    let query = format!(
        "SELECT (EXTRACT(EPOCH FROM ts) * 1000000)::float8 AS timestamp_us, \
         id AS frame_id, extended, data_bytes \
         FROM public.can_frame WHERE true{w} ORDER BY ts"
    );

    // Stream rows so we can stop at the result limit without fetching the
    // remainder of a (potentially year-long) range.
    let refs = args.refs();
    let row_stream = client
        .query_raw(query.as_str(), refs.iter().map(|p| *p as &dyn ToSql))
        .await
        .map_err(|e| format!("Query failed: {e}"))?;
    futures_util::pin_mut!(row_stream);

    let mut rows_scanned = 0usize;
    let mut results: Vec<PatternSearchResult> = Vec::new();
    while let Some(row) = row_stream.try_next().await.map_err(|e| format!("Row fetch failed: {e}"))? {
        rows_scanned += 1;
        let data_bytes: Vec<u8> = row.get("data_bytes");
        if data_bytes.len() < p.pattern.len() {
            continue;
        }
        let match_positions: Vec<usize> = (0..=data_bytes.len() - p.pattern.len())
            .filter(|&start| {
                (0..p.pattern.len()).all(|j| {
                    (data_bytes[start + j] & p.pattern_mask[j]) == (p.pattern[j] & p.pattern_mask[j])
                })
            })
            .collect();
        if !match_positions.is_empty() {
            results.push(PatternSearchResult {
                timestamp_us: row.get::<_, f64>("timestamp_us") as i64,
                frame_id: row.get::<_, i32>("frame_id") as u32,
                is_extended: row.get("extended"),
                payload: data_bytes,
                match_positions,
            });
            if results.len() >= result_limit {
                break;
            }
        }
    }
    let n = results.len();
    Ok(PatternSearchQueryResult { results, stats: stats(t0, rows_scanned, n) })
}

// ---------------------------------------------------------------------------
// Inventory / bounds / payloads
// ---------------------------------------------------------------------------

async fn rollup_available(client: &Client) -> bool {
    client
        .query_one("SELECT to_regclass('public.can_frame_hourly') IS NOT NULL", &[])
        .await
        .map(|r| r.get::<_, bool>(0))
        .unwrap_or(false)
}

pub async fn inventory(
    client: &Client,
    start_time: Option<String>,
    end_time: Option<String>,
) -> Result<Vec<InventoryEntry>, String> {
    let map = |row: &tokio_postgres::Row| InventoryEntry {
        frame_id: row.get::<_, i32>("id") as u32,
        is_extended: row.get("extended"),
        count: row.get("cnt"),
        first_us: row.get::<_, f64>("first_us") as i64,
        last_us: row.get::<_, f64>("last_us") as i64,
        max_dlc: row.get::<_, i32>("max_dlc") as u8,
    };

    // Full-archive inventory reads the hourly rollup when present
    if start_time.is_none() && end_time.is_none() && rollup_available(client).await {
        let rows = client
            .query(
                "SELECT id, extended, sum(frame_count)::int8 AS cnt, \
                 (EXTRACT(EPOCH FROM min(first_ts)) * 1000000)::float8 AS first_us, \
                 (EXTRACT(EPOCH FROM max(last_ts)) * 1000000)::float8 AS last_us, \
                 max(max_dlc)::int4 AS max_dlc \
                 FROM public.can_frame_hourly GROUP BY id, extended ORDER BY id, extended",
                &[],
            )
            .await
            .map_err(|e| format!("Inventory rollup query failed: {e}"))?;
        return Ok(rows.iter().map(map).collect());
    }

    let mut args = Args::default();
    let w = time_clause(&mut args, &start_time, &end_time);
    let query = format!(
        "SELECT id, extended, COUNT(*)::int8 AS cnt, \
         (EXTRACT(EPOCH FROM MIN(ts)) * 1000000)::float8 AS first_us, \
         (EXTRACT(EPOCH FROM MAX(ts)) * 1000000)::float8 AS last_us, \
         MAX(dlc)::int4 AS max_dlc \
         FROM public.can_frame WHERE true{w} GROUP BY id, extended ORDER BY id, extended"
    );
    let rows = client
        .query(&query, &args.refs())
        .await
        .map_err(|e| format!("Inventory query failed: {e}"))?;
    Ok(rows.iter().map(map).collect())
}

pub async fn time_bounds(client: &Client) -> Result<TimeBounds, String> {
    let (min_expr, max_expr, table) = if rollup_available(client).await {
        ("min(first_ts)", "max(last_ts)", "public.can_frame_hourly")
    } else {
        ("min(ts)", "max(ts)", "public.can_frame")
    };
    let row = client
        .query_one(
            &format!(
                "SELECT (EXTRACT(EPOCH FROM {min_expr}) * 1000000)::float8 AS min_us, \
                 (EXTRACT(EPOCH FROM {max_expr}) * 1000000)::float8 AS max_us FROM {table}"
            ),
            &[],
        )
        .await
        .map_err(|e| format!("Time bounds query failed: {e}"))?;
    Ok(TimeBounds {
        min_ts_us: row.get::<_, Option<f64>>("min_us").map(|v| v as i64),
        max_ts_us: row.get::<_, Option<f64>>("max_us").map(|v| v as i64),
    })
}

#[derive(Debug, Deserialize)]
pub struct PayloadsParams {
    pub frame_id: u32,
    pub is_extended: Option<bool>,
    pub limit: Option<u32>,
}

/// Most-recent-N raw payloads for one frame id (headless byte analysis).
pub async fn payloads(client: &Client, p: &PayloadsParams) -> Result<Vec<Vec<u8>>, String> {
    let limit = p.limit.unwrap_or(1000);
    let mut args = Args::default();
    let mut sql = format!(
        "SELECT data_bytes FROM public.can_frame WHERE id = ${}::int4",
        args.add(p.frame_id as i32)
    );
    if let Some(ext) = p.is_extended {
        sql += &format!(" AND extended = ${}::bool", args.add(ext));
    }
    sql += &format!(" ORDER BY ts DESC LIMIT {limit}");
    let rows = client.query(&sql, &args.refs()).await.map_err(|e| format!("Payload fetch failed: {e}"))?;
    Ok(rows.iter().map(|r| r.get("data_bytes")).collect())
}

// ---------------------------------------------------------------------------
// Replay frame cursor
// ---------------------------------------------------------------------------

fn encode_cursor(ts_us: i64, skip: u32) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{ts_us}:{skip}"))
}

pub fn decode_cursor(cursor: &str) -> Result<(i64, u32), String> {
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| "bad cursor".to_string())?;
    let s = String::from_utf8(raw).map_err(|_| "bad cursor".to_string())?;
    let (ts, skip) = s.split_once(':').ok_or("bad cursor")?;
    Ok((ts.parse().map_err(|_| "bad cursor")?, skip.parse().map_err(|_| "bad cursor")?))
}

/// One keyset-cursor batch of frames in ascending time order. The cursor is
/// `(last_ts_us, rows already emitted at that exact ts)` — the hypertable has
/// no unique key, so ties on ts are broken by skip-counting.
pub async fn frames_batch(
    client: &Client,
    start_time: Option<String>,
    end_time: Option<String>,
    after: Option<&str>,
    limit: u32,
) -> Result<FrameBatch, String> {
    let cursor = after.map(decode_cursor).transpose()?;
    let mut args = Args::default();
    let mut sql = String::from(
        "SELECT (EXTRACT(EPOCH FROM ts) * 1000000)::float8 AS ts_us, \
         id, extended, dlc, is_fd, data_bytes, bus, dir \
         FROM public.can_frame WHERE true",
    );
    if let Some((ts_us, _)) = cursor {
        sql += &format!(
            " AND ts >= to_timestamp(${}::float8 / 1000000.0)",
            args.add(ts_us as f64)
        );
    }
    sql += &time_clause(&mut args, &start_time, &end_time);
    let skip = cursor.map(|(_, s)| s).unwrap_or(0) as usize;
    sql += &format!(" ORDER BY ts ASC LIMIT {}", limit as usize + skip);

    let rows = client.query(&sql, &args.refs()).await.map_err(|e| format!("Frame query failed: {e}"))?;
    let exhausted = rows.len() < limit as usize + skip;

    let frames: Vec<FrameBatchRow> = rows
        .iter()
        .skip(skip)
        .map(|row| FrameBatchRow {
            ts_us: row.get::<_, f64>("ts_us") as i64,
            id: row.get::<_, i32>("id") as u32,
            extended: row.get("extended"),
            dlc: row.get::<_, i16>("dlc") as u8,
            is_fd: row.get("is_fd"),
            bus: row.get::<_, i32>("bus") as u8,
            dir: row.get("dir"),
            data_hex: hex::encode(row.get::<_, Vec<u8>>("data_bytes")),
        })
        .collect();

    let next_cursor = if exhausted || frames.is_empty() {
        None
    } else {
        let last_ts = frames.last().unwrap().ts_us;
        let ties = frames.iter().rev().take_while(|f| f.ts_us == last_ts).count() as u32;
        // If the whole batch (and the cursor row before it) shares one ts,
        // carry the previous skip forward
        let carried = match cursor {
            Some((ts, s)) if ts == last_ts => s,
            _ => 0,
        };
        Some(encode_cursor(last_ts, ties + carried))
    };

    Ok(FrameBatch { frames, next_cursor })
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

pub async fn activity(client: &Client, database: &str) -> Result<DatabaseActivityResult, String> {
    let rows = client
        .query(
            "SELECT pid, datname AS database, usename AS username, application_name, \
             client_addr::text, state, LEFT(query, 500) AS query, query_start::text, \
             EXTRACT(EPOCH FROM (now() - query_start))::float8 AS duration_secs \
             FROM pg_stat_activity \
             WHERE datname = $1 AND pid != pg_backend_pid() \
             ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END, \
                      query_start DESC NULLS LAST",
            &[&database],
        )
        .await
        .map_err(|e| format!("Activity query failed: {e}"))?;

    let mut queries = Vec::new();
    let mut sessions = Vec::new();
    for row in &rows {
        let state: Option<String> = row.get("state");
        let is_active = state.as_deref() == Some("active");
        let entry = DatabaseActivity {
            pid: row.get("pid"),
            database: row.get("database"),
            username: row.get("username"),
            application_name: row.get("application_name"),
            client_addr: row.get("client_addr"),
            state,
            query: row.get("query"),
            query_start: row.get("query_start"),
            duration_secs: row.get("duration_secs"),
            is_cancellable: is_active,
        };
        if is_active {
            queries.push(entry);
        } else {
            sessions.push(entry);
        }
    }
    Ok(DatabaseActivityResult { queries, sessions })
}

pub async fn signal_backend(client: &Client, pid: i32, terminate: bool) -> Result<bool, String> {
    let func = if terminate { "pg_terminate_backend" } else { "pg_cancel_backend" };
    let row = client
        .query_one(&format!("SELECT {func}($1)"), &[&pid])
        .await
        .map_err(|e| format!("{func} failed: {e}"))?;
    Ok(row.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trip() {
        let c = encode_cursor(1_750_000_000_123_456, 3);
        assert_eq!(decode_cursor(&c).unwrap(), (1_750_000_000_123_456, 3));
        assert!(decode_cursor("not-base64!!").is_err());
    }
}
