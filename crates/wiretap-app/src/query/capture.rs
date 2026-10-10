// crates/wiretap-app/src/query/capture.rs
//
// A query against a SQLite capture: the statements a spec reads, composed from
// the lib's `FrameRowFilter`, and the lib's kernels over the rows they return.

use std::collections::BTreeSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use wiretap_analysis::query::{self as kernel, QueryRow};
use wiretap_gateway::{FrameRowFilter, QuerySpec, Sql, SqlValue};

use super::{QueryOutcome, QueryResults};
use crate::capture_db::{self, InventoryRow, STORED_LENGTH};

const ROW: &str = "timestamp_us, frame_id, is_extended, payload";
const PAGED_ROW: &str = "timestamp_us, frame_id, is_extended, payload, rowid";

/// Rows a query that can stop early reads at a time.
const PAGE: usize = 50_000;
const TIMES: &str = "timestamp_us, frame_id, is_extended, x''";

fn select(capture_id: &str, columns: &str, filter: &FrameRowFilter, tail: &str) -> Sql {
    let filter = filter.sql_where(capture_id);
    Sql { sql: format!("SELECT {columns} FROM frames WHERE {}{tail}", filter.sql), values: filter.values }
}

fn inventory_statement(capture_id: &str, filter: &FrameRowFilter, limit: Option<u32>) -> Sql {
    let mut statement = select(
        capture_id,
        &format!(
            "protocol, frame_id, is_extended, COUNT(*), MIN(timestamp_us), MAX(timestamp_us), MAX({STORED_LENGTH})"
        ),
        filter,
        &format!(
            " GROUP BY protocol, frame_id, is_extended ORDER BY frame_id, protocol, is_extended{}",
            if limit.is_some() { " LIMIT ?" } else { "" }
        ),
    );
    statement.values.extend(limit.map(|n| SqlValue::Integer(n.into())));
    statement
}

/// One page of rows after `after_rowid`.
fn page_statement(capture_id: &str, filter: &FrameRowFilter, after_rowid: i64, page: usize) -> Sql {
    let mut statement = select(capture_id, PAGED_ROW, filter, &format!(" AND rowid > ? ORDER BY rowid LIMIT {page}"));
    statement.values.push(SqlValue::Integer(after_rowid));
    statement
}

/// The statements a spec runs, in the order `run` reads them; a paged query
/// shows its first page.
pub fn statements(capture_id: &str, spec: &QuerySpec) -> Vec<Sql> {
    statements_paged(capture_id, spec, PAGE)
}

fn statements_paged(capture_id: &str, spec: &QuerySpec, page: usize) -> Vec<Sql> {
    let filters = spec.row_filters();
    let rows = |columns, tail| select(capture_id, columns, &filters[0], tail);
    match spec {
        QuerySpec::MirrorValidation { .. } => filters
            .iter()
            .map(|f| select(capture_id, ROW, f, " ORDER BY timestamp_us"))
            .collect(),
        QuerySpec::FirstLast { .. } => vec![
            rows(ROW, " ORDER BY rowid ASC LIMIT 1"),
            rows(ROW, " ORDER BY rowid DESC LIMIT 1"),
            rows("COUNT(*)", ""),
        ],
        QuerySpec::Frequency { .. } | QuerySpec::GapAnalysis { .. } => vec![rows(TIMES, " ORDER BY rowid")],
        QuerySpec::FrameInventory { limit, .. } => vec![inventory_statement(capture_id, &filters[0], *limit)],
        QuerySpec::ByteChanges { .. } | QuerySpec::FrameChanges { .. } | QuerySpec::PatternSearch { .. } => {
            vec![page_statement(capture_id, &filters[0], 0, page)]
        }
        _ => vec![rows(ROW, " ORDER BY rowid")],
    }
}

fn query_row(row: &rusqlite::Row) -> rusqlite::Result<QueryRow> {
    Ok(QueryRow {
        timestamp_us: row.get(0)?,
        frame_id: row.get::<_, i64>(1)? as u32,
        is_extended: row.get(2)?,
        payload: row.get(3)?,
    })
}

fn inventory_row(row: &rusqlite::Row) -> rusqlite::Result<InventoryRow> {
    Ok(InventoryRow::new(
        &row.get::<_, String>(0)?,
        row.get::<_, i64>(1)? as u32,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get::<_, i64>(6)? as u16,
    ))
}

/// Page through `filter`'s rows until `kernel` has found `limit` results.
/// `carry` hands each page the previous page's last row, for kernels that
/// compare neighbours; it is not read twice.
fn paged<R>(
    capture_id: &str,
    filter: &FrameRowFilter,
    page: usize,
    limit: Option<u32>,
    carry: bool,
    cancel: &Arc<AtomicBool>,
    mut kernel: impl FnMut(&[QueryRow], Option<u32>) -> Result<Vec<R>, String>,
) -> Result<(Vec<R>, usize), String> {
    let wanted = limit.map_or(usize::MAX, |n| n as usize);
    let (mut results, mut read, mut after, mut carried) = (Vec::new(), 0, 0, None);
    loop {
        let rows = capture_db::read_rows(&page_statement(capture_id, filter, after, page), cancel, |row| {
            Ok((query_row(row)?, row.get::<_, i64>(4)?))
        })?;
        read += rows.len();
        let full = rows.len() == page;
        after = rows.last().map_or(after, |(_, rowid)| *rowid);
        let batch: Vec<QueryRow> = carried.take().into_iter().chain(rows.into_iter().map(|(row, _)| row)).collect();
        let remaining = (wanted - results.len()).min(u32::MAX as usize) as u32;
        results.extend(kernel(&batch, limit.map(|_| remaining))?);
        if results.len() >= wanted || !full {
            results.truncate(wanted);
            return Ok((results, read));
        }
        if carry {
            carried = batch.into_iter().last();
        }
    }
}

/// Run `spec` against capture `capture_id`; `compare` narrows a mirror validation.
pub fn run(
    capture_id: &str,
    spec: &QuerySpec,
    compare: Option<&BTreeSet<usize>>,
    cancel: &Arc<AtomicBool>,
) -> Result<QueryOutcome, String> {
    run_paged(capture_id, spec, compare, cancel, PAGE)
}

fn run_paged(
    capture_id: &str,
    spec: &QuerySpec,
    compare: Option<&BTreeSet<usize>>,
    cancel: &Arc<AtomicBool>,
    page: usize,
) -> Result<QueryOutcome, String> {
    if let QuerySpec::PatternSearch { pattern, pattern_mask, .. } = spec {
        kernel::pattern_search(&[], pattern, pattern_mask, None).map_err(|e| e.to_string())?;
    }
    let started = Instant::now();
    let statements = statements_paged(capture_id, spec, page);
    let rows = |i: usize| capture_db::read_rows(&statements[i], cancel, query_row);
    let filter = &spec.row_filters()[0];
    let counted = |results: QueryResults, read: usize| {
        let stats = kernel::stats(read, results.len(), started);
        QueryOutcome { results, stats: Some(stats), sql: Vec::new(), truncated: false }
    };
    let mut outcome: QueryOutcome = match spec {
        QuerySpec::ByteChanges { byte_index, limit, .. } => {
            let (found, read) = paged(capture_id, filter, page, *limit, true, cancel, |rows, limit| {
                Ok(kernel::byte_changes(rows, *byte_index, limit).results)
            })?;
            counted(QueryResults::ByteChanges(found), read)
        }
        QuerySpec::FrameChanges { limit, .. } => {
            let (found, read) = paged(capture_id, filter, page, *limit, true, cancel, |rows, limit| {
                Ok(kernel::frame_changes(rows, limit).results)
            })?;
            counted(QueryResults::FrameChanges(found), read)
        }
        QuerySpec::MirrorValidation { tolerance_ms, limit, .. } => {
            kernel::mirror_validation(&rows(0)?, &rows(1)?, *tolerance_ms, compare, *limit).into()
        }
        QuerySpec::MuxStatistics { mux_selector_byte, include_16bit, payload_length, limit, .. } => {
            kernel::mux_statistics(&rows(0)?, *mux_selector_byte, *include_16bit, *payload_length, *limit).into()
        }
        QuerySpec::FirstLast { .. } => {
            let (first, last) = (rows(0)?, rows(1)?);
            let (Some(first), Some(last)) = (first.first(), last.first()) else {
                return Err("No frames found for the given filters".into());
            };
            let count = capture_db::read_rows(&statements[2], cancel, |r| r.get::<_, i64>(0))?;
            kernel::first_last_from_ends(first, last, count.first().copied().unwrap_or_default()).into()
        }
        QuerySpec::Frequency { bucket_size_ms, limit, .. } => kernel::frequency(&rows(0)?, *bucket_size_ms, *limit).into(),
        QuerySpec::Distribution { byte_index, .. } => kernel::distribution(&rows(0)?, *byte_index).into(),
        QuerySpec::GapAnalysis { gap_threshold_ms, limit, .. } => {
            kernel::gap_analysis(&rows(0)?, *gap_threshold_ms, *limit).into()
        }
        QuerySpec::PatternSearch { pattern, pattern_mask, limit, .. } => {
            let (found, read) = paged(capture_id, filter, page, *limit, false, cancel, |rows, limit| {
                kernel::pattern_search(rows, pattern, pattern_mask, limit).map(|r| r.results).map_err(|e| e.to_string())
            })?;
            counted(QueryResults::PatternSearch(found), read)
        }
        QuerySpec::FrameInventory { limit, .. } => {
            let rows = capture_db::read_rows(&statements[0], cancel, inventory_row)?;
            let read = rows.iter().map(|r| r.count as usize).sum();
            let truncated = limit.is_some_and(|n| rows.len() >= n as usize);
            QueryOutcome { truncated, ..counted(QueryResults::FrameInventory(rows), read) }
        }
    };
    outcome.sql = statements.iter().map(Sql::inlined).collect();
    Ok(outcome)
}

/// Every identity in capture `capture_id` within the window, with its rollup.
pub fn frame_inventory(capture_id: &str, start_us: Option<i64>, end_us: Option<i64>) -> Result<Vec<InventoryRow>, String> {
    let filter = FrameRowFilter { start_us, end_us, ..Default::default() };
    capture_db::read_rows(&inventory_statement(capture_id, &filter, None), &Arc::default(), inventory_row)
}

#[cfg(test)]
pub(crate) fn run_in_pages(capture_id: &str, spec: &QuerySpec, page: usize) -> Result<QueryOutcome, String> {
    run_paged(capture_id, spec, None, &Arc::default(), page)
}

#[cfg(test)]
pub(crate) fn inventory_with_conn(conn: &rusqlite::Connection, capture_id: &str) -> Vec<InventoryRow> {
    capture_db::read_rows_with_conn(conn, &inventory_statement(capture_id, &FrameRowFilter::default(), None), inventory_row)
        .unwrap()
}
