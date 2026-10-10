// ui/crates/wiretap-app/src/payload_source.rs
//
// The app's `PayloadSource`s: a SQLite capture, and a WireTAP backend profile
// reached through the settings `AppHandle` holds.

use tauri::AppHandle;

use crate::analysis::{FrameSource, PayloadQuery, PayloadSource, Sampling};
use crate::capture_db::InventoryRow;
use crate::capture_store::FrameSelection;
use crate::io::FrameMessage;

/// Where a query runs: a SQLite capture or a WireTAP backend profile.
pub enum QuerySource {
    Capture(String),
    Backend(String),
}

/// Resolve the source from the dual `capture_id` / `profile_id` MCP params.
pub fn resolve(
    capture_id: Option<String>,
    profile_id: Option<String>,
) -> Result<QuerySource, String> {
    match (capture_id, profile_id) {
        (Some(c), None) => Ok(QuerySource::Capture(c)),
        (None, Some(p)) => Ok(QuerySource::Backend(p)),
        (Some(_), Some(_)) => Err("Provide exactly one of capture_id / profile_id, not both".into()),
        (None, None) => Err("Provide one of capture_id or profile_id".into()),
    }
}

impl QuerySource {
    pub fn reader<'a>(&'a self, app: &'a AppHandle) -> AppSource<'a> {
        match self {
            QuerySource::Capture(id) => AppSource::Capture(Capture(id)),
            QuerySource::Backend(profile_id) => AppSource::Gateway(Gateway { app, profile_id }),
        }
    }
}

/// Parse an RFC3339 timestamp into epoch microseconds (capture timeline). Also
/// accepts a bare integer treated as already-µs.
pub fn iso_to_micros(s: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_micros());
    }
    s.trim().parse::<i64>().ok()
}

pub struct Capture<'a>(pub &'a str);

impl PayloadSource for Capture<'_> {
    async fn inventory(
        &self,
        start_time: Option<&str>,
        end_time: Option<&str>,
    ) -> Result<Vec<InventoryRow>, String> {
        crate::capture_db::frame_inventory(
            self.0,
            start_time.and_then(iso_to_micros),
            end_time.and_then(iso_to_micros),
        )
    }

    async fn payloads(&self, q: PayloadQuery<'_>) -> Result<Vec<Vec<u8>>, String> {
        let read = match q.sampling {
            Sampling::Spread => crate::capture_db::sample_frame_payloads,
            Sampling::Recent => crate::capture_db::tail_frame_payloads,
        };
        read(self.0, q.protocol, q.frame_id, q.is_extended, q.limit)
    }
}

/// Frames read a page at a time, so a whole capture is never one query.
const FRAME_PAGE: usize = 50_000;

impl FrameSource for Capture<'_> {
    async fn frames(
        &self,
        selection: &FrameSelection,
        newest: Option<usize>,
    ) -> Result<Vec<FrameMessage>, String> {
        if let Some(n) = newest {
            return Ok(crate::capture_store::get_capture_frames_tail(self.0, n, selection).frames);
        }
        let mut frames = Vec::new();
        loop {
            let (page, _, total) = crate::capture_store::get_capture_frames_paginated_filtered(
                self.0,
                frames.len(),
                FRAME_PAGE,
                selection,
            );
            let done = page.is_empty() || frames.len() + page.len() >= total;
            frames.extend(page);
            if done {
                return Ok(frames);
            }
        }
    }
}

pub struct Gateway<'a> {
    app: &'a AppHandle,
    profile_id: &'a str,
}

impl PayloadSource for Gateway<'_> {
    async fn inventory(
        &self,
        start_time: Option<&str>,
        end_time: Option<&str>,
    ) -> Result<Vec<InventoryRow>, String> {
        crate::dbquery::db_frame_inventory(
            self.app,
            self.profile_id,
            start_time.map(str::to_owned),
            end_time.map(str::to_owned),
        )
        .await
    }

    // No protocol and no stride: a backend profile reads one protocol, and a
    // modulo window over a multi-month archive is a full scan where the tail
    // query is an index seek. A capture is bounded and local, which is what
    // makes striding it affordable.
    async fn payloads(&self, q: PayloadQuery<'_>) -> Result<Vec<Vec<u8>>, String> {
        crate::dbquery::db_fetch_frame_payloads(
            self.app,
            self.profile_id,
            q.frame_id,
            q.is_extended,
            q.limit,
        )
        .await
    }
}

pub enum AppSource<'a> {
    Capture(Capture<'a>),
    Gateway(Gateway<'a>),
}

impl PayloadSource for AppSource<'_> {
    async fn inventory(
        &self,
        start_time: Option<&str>,
        end_time: Option<&str>,
    ) -> Result<Vec<InventoryRow>, String> {
        match self {
            AppSource::Capture(s) => s.inventory(start_time, end_time).await,
            AppSource::Gateway(s) => s.inventory(start_time, end_time).await,
        }
    }

    async fn payloads(&self, q: PayloadQuery<'_>) -> Result<Vec<Vec<u8>>, String> {
        match self {
            AppSource::Capture(s) => s.payloads(q).await,
            AppSource::Gateway(s) => s.payloads(q).await,
        }
    }
}

/// The Query app's per-id rollup, over either source. Time bounds are RFC3339.
#[tauri::command]
pub async fn query_frame_inventory(
    app: AppHandle,
    capture_id: Option<String>,
    profile_id: Option<String>,
    start_time: Option<String>,
    end_time: Option<String>,
) -> Result<Vec<InventoryRow>, String> {
    resolve(capture_id, profile_id)?
        .reader(&app)
        .inventory(start_time.as_deref(), end_time.as_deref())
        .await
}

#[cfg(test)]
mod tests {
    use super::iso_to_micros;

    /// The `rust` column of the bounds table `queryStore.ts` is checked against.
    #[test]
    fn iso_to_micros_matches_the_bounds_table() {
        let table: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../frontend/wiretap-ui/src/tests/fixtures/data/queryBounds.json"
            ))
            .expect("table"),
        )
        .expect("table json");
        for row in table["rows"].as_array().expect("rows") {
            let input = row["input"].as_str().expect("input");
            assert_eq!(iso_to_micros(input), row["rust"].as_i64(), "{input:?}");
        }
    }
}
