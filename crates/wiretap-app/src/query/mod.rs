// crates/wiretap-app/src/query/mod.rs
//
// The Query app's one path: a `wiretap_gateway::QuerySpec` run against a capture
// or a WireTAP backend, answered with the SQL (or request) that ran, behind a
// queue every window shares, and exported as CSV.

pub mod capture;
mod csv;
mod gateway;
pub mod queue;

use std::collections::BTreeSet;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use wiretap_gateway::{
    ByteChangeQueryResult, ByteChangeResult, DistributionQueryResult, DistributionResult,
    FirstLastQueryResult, FirstLastResult, FrameChangeQueryResult, FrameChangeResult,
    FrequencyBucket, FrequencyQueryResult, GapAnalysisQueryResult, GapResult,
    MirrorValidationQueryResult, MirrorValidationResult, MuxStatisticsQueryResult,
    MuxStatisticsResult, PatternSearchQueryResult, PatternSearchResult, QuerySpec, QueryStats,
};

use crate::capture_db::InventoryRow;
use crate::payload_source::QuerySource;

pub use queue::QueryQueue;

/// A query and where it runs. `catalog_path` narrows a mirror validation to the
/// mirror's inherited bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueryRequest {
    pub source: QuerySource,
    pub spec: QuerySpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub catalog_path: Option<String>,
}

/// A query's results; which variant follows from the spec's type.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(untagged)]
pub enum QueryResults {
    ByteChanges(Vec<ByteChangeResult>),
    FrameChanges(Vec<FrameChangeResult>),
    MirrorValidation(Vec<MirrorValidationResult>),
    MuxStatistics(MuxStatisticsResult),
    FirstLast(FirstLastResult),
    Frequency(Vec<FrequencyBucket>),
    Distribution(Vec<DistributionResult>),
    GapAnalysis(Vec<GapResult>),
    PatternSearch(Vec<PatternSearchResult>),
    FrameInventory(Vec<InventoryRow>),
}

impl QueryResults {
    pub fn len(&self) -> usize {
        match self {
            Self::ByteChanges(r) => r.len(),
            Self::FrameChanges(r) => r.len(),
            Self::MirrorValidation(r) => r.len(),
            Self::MuxStatistics(r) => r.cases.len(),
            Self::FirstLast(_) => 1,
            Self::Frequency(r) => r.len(),
            Self::Distribution(r) => r.len(),
            Self::GapAnalysis(r) => r.len(),
            Self::PatternSearch(r) => r.len(),
            Self::FrameInventory(r) => r.len(),
        }
    }
}

/// A query's answer and the statements that produced it: SQLite with its values
/// in place for a capture, the HTTP request for a backend.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QueryOutcome {
    pub results: QueryResults,
    pub stats: Option<QueryStats>,
    pub sql: Vec<String>,
}

macro_rules! outcome_from {
    ($($result:ty => $variant:ident),* $(,)?) => {$(
        impl From<$result> for QueryOutcome {
            fn from(r: $result) -> Self {
                Self { results: QueryResults::$variant(r.results), stats: Some(r.stats), sql: Vec::new() }
            }
        }
    )*};
}

outcome_from! {
    ByteChangeQueryResult => ByteChanges,
    FrameChangeQueryResult => FrameChanges,
    MirrorValidationQueryResult => MirrorValidation,
    MuxStatisticsQueryResult => MuxStatistics,
    FirstLastQueryResult => FirstLast,
    FrequencyQueryResult => Frequency,
    DistributionQueryResult => Distribution,
    GapAnalysisQueryResult => GapAnalysis,
    PatternSearchQueryResult => PatternSearch,
}

/// What a query with no limit of its own stops at.
fn with_default_limit(mut spec: QuerySpec) -> QuerySpec {
    use QuerySpec::*;
    match &mut spec {
        Frequency { limit, .. } => {
            limit.get_or_insert(100_000);
        }
        ByteChanges { limit, .. }
        | FrameChanges { limit, .. }
        | MirrorValidation { limit, .. }
        | GapAnalysis { limit, .. }
        | PatternSearch { limit, .. }
        | FrameInventory { limit, .. } => {
            limit.get_or_insert(10_000);
        }
        MuxStatistics { .. } | FirstLast { .. } | Distribution { .. } => {}
    }
    spec
}

/// The mirror's inherited bytes in the catalogue at `catalog_path`; `None`
/// compares whole payloads.
fn mirror_compare(spec: &QuerySpec, catalog_path: Option<&str>) -> Result<Option<BTreeSet<usize>>, String> {
    let (QuerySpec::MirrorValidation { mirror_frame_id, .. }, Some(path)) = (spec, catalog_path) else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(path).map_err(|e| format!("Failed to read catalog file: {e}"))?;
    let catalog = wiretap_catalog::Catalog::parse(&text).map_err(|e| e.to_string())?;
    Ok(wiretap_analysis::query::mirror_compare_set(&catalog, *mirror_frame_id))
}

/// A query id for the backend's logs and `DELETE /queries/{id}`.
pub fn new_query_id() -> String {
    format!("query_{:x}", crate::io::now_us())
}

/// Run one query. Setting `cancel` stops a capture query; a backend query is
/// cancelled by its `query_id`.
pub async fn run(
    app: &AppHandle,
    request: &QueryRequest,
    query_id: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<QueryOutcome, String> {
    let spec = with_default_limit(request.spec.clone());
    let compare = mirror_compare(&spec, request.catalog_path.as_deref())?;
    match &request.source {
        QuerySource::Capture(capture_id) => {
            let (capture_id, cancel) = (capture_id.clone(), Arc::clone(cancel));
            tauri::async_runtime::spawn_blocking(move || {
                capture::run(&capture_id, &spec, compare.as_ref(), &cancel)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        QuerySource::Backend(profile_id) => {
            gateway::run(app, profile_id, &spec, query_id, compare.as_ref()).await
        }
    }
}

/// The statements `run` would send, without sending them.
pub async fn preview(app: &AppHandle, request: &QueryRequest) -> Result<Vec<String>, String> {
    let spec = with_default_limit(request.spec.clone());
    match &request.source {
        QuerySource::Capture(capture_id) => Ok(capture::statements(capture_id, &spec)
            .iter()
            .map(|s| s.inlined())
            .collect()),
        QuerySource::Backend(profile_id) => {
            let narrowed = mirror_compare(&spec, request.catalog_path.as_deref())?.is_some();
            gateway::preview(app, profile_id, &spec, narrowed).await
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Mutex;

    use serde_json::{json, Value};
    use wiretap_gateway::{Protocol, RowWindow};

    use super::*;
    use crate::io::FrameMessage;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../frontend/wiretap-ui/src/tests/fixtures/data");
    const SQL_CAPTURE: &str = "d5-sql-golden";

    pub(crate) fn fixture(name: &str) -> Value {
        serde_json::from_str(&std::fs::read_to_string(format!("{FIXTURES}/{name}")).expect("fixture")).expect("json")
    }

    fn golden(name: &str, served: &Value) {
        if std::env::var_os("WRITE_DATA_FIXTURES").is_some() {
            std::fs::write(format!("{FIXTURES}/{name}"), serde_json::to_string_pretty(served).unwrap() + "\n").unwrap();
        }
        assert_eq!(*served, fixture(name), "{name}");
    }

    /// The specs the Query form builds (`querySpec.json`), as Rust reads them.
    pub(crate) fn form_specs() -> Vec<(String, QuerySpec)> {
        fixture("querySpec.json")["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["name"].as_str().unwrap().to_string(), serde_json::from_value(c["expected"].clone()).expect("spec")))
            .collect()
    }

    fn frame(frame_id: u32, timestamp_us: u64, bytes: &[u8]) -> FrameMessage {
        FrameMessage {
            protocol: "can".into(),
            timestamp_us,
            frame_id,
            dlc: bytes.len() as u16,
            bytes: bytes.to_vec(),
            ..Default::default()
        }
    }

    fn capture_of(capture_id: &str, frames: &[FrameMessage]) {
        crate::capture_db::use_in_memory_database();
        crate::capture_db::insert_frames(capture_id, frames).unwrap();
    }

    fn run_capture(capture_id: &str, spec: QuerySpec) -> Result<QueryOutcome, String> {
        capture::run(capture_id, &with_default_limit(spec), None, &Arc::default())
    }

    static EXECUTED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    fn record(sql: &str) {
        if sql.contains(SQL_CAPTURE) {
            EXECUTED.lock().unwrap().push(sql.split_whitespace().collect::<Vec<_>>().join(" "));
        }
    }

    /// Each form spec's capture statements as run (a rusqlite trace) and as
    /// previewed, which must be the same text, beside the backend request.
    /// `WRITE_DATA_FIXTURES=1` rewrites `querySql.json`.
    #[test]
    fn a_query_runs_the_sql_it_previews() {
        let in_window = 1_772_319_700_000_000;
        let extended = |id, at, bytes: &[u8]| FrameMessage { is_extended: true, ..frame(id, at, bytes) };
        capture_of(SQL_CAPTURE, &[extended(0x100, in_window, &[0xAA, 0xBB, 0x01]), extended(0x101, in_window + 100, &[0xAA, 0xBB, 0x02])]);
        crate::capture_db::trace_statements(Some(record));
        let mut cases = Vec::new();
        for (name, spec) in form_specs() {
            EXECUTED.lock().unwrap().clear();
            let outcome = run_capture(SQL_CAPTURE, spec.clone()).unwrap();
            let executed = std::mem::take(&mut *EXECUTED.lock().unwrap());
            let previewed: Vec<String> =
                capture::statements(SQL_CAPTURE, &with_default_limit(spec.clone())).iter().map(|s| s.inlined()).collect();
            assert_eq!(executed, outcome.sql, "{name}");
            assert_eq!(previewed, outcome.sql, "{name}");
            let api = crate::apiclient::test_api(Protocol::Can);
            let request = gateway::request(&api, &with_default_limit(spec), None, false).unwrap().text();
            cases.push(json!({ "name": name, "capture": outcome.sql, "gateway": request.lines().collect::<Vec<_>>() }));
        }
        crate::capture_db::trace_statements(None);
        golden("querySql.json", &json!({
            "note": "Each querySpec.json case: the SQLite a capture runs (traced, and equal to its preview), and the request a CAN backend profile is sent.",
            "cases": cases,
        }));
    }

    pub(crate) fn results_named(name: &str, input: Value) -> QueryResults {
        fn parse<T: serde::de::DeserializeOwned>(v: Value) -> T {
            serde_json::from_value(v).unwrap()
        }
        match name {
            "byte_changes" => QueryResults::ByteChanges(parse(input)),
            "frame_changes" => QueryResults::FrameChanges(parse(input)),
            "mirror_validation" => QueryResults::MirrorValidation(parse(input)),
            "mux_statistics" => QueryResults::MuxStatistics(parse(input)),
            "first_last" => QueryResults::FirstLast(parse(input)),
            "frequency" => QueryResults::Frequency(parse(input)),
            "distribution" => QueryResults::Distribution(parse(input)),
            "gap_analysis" => QueryResults::GapAnalysis(parse(input)),
            "pattern_search" => QueryResults::PatternSearch(parse(input)),
            "frame_inventory" => QueryResults::FrameInventory(
                input
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| {
                        let n = |k: &str| r[k].as_i64().unwrap();
                        InventoryRow::new(
                            r["protocol"].as_str().unwrap(),
                            n("frame_id") as u32,
                            r["is_extended"].as_bool().unwrap(),
                            n("count"),
                            n("first_us"),
                            n("last_us"),
                            n("max_dlc") as u16,
                        )
                    })
                    .collect(),
            ),
            other => panic!("no query type {other}"),
        }
    }

    /// `WRITE_DATA_FIXTURES=1` rewrites each case's `expected`.
    #[test]
    fn each_type_exports_as_the_csv_golden() {
        let mut table = fixture("queryCsv.json");
        for case in table["cases"].as_array_mut().unwrap() {
            let results = results_named(case["name"].as_str().unwrap(), case["input"].clone());
            case["expected"] = json!(csv::render(&results).split('\n').collect::<Vec<_>>());
        }
        golden("queryCsv.json", &table);
    }

    #[test]
    fn byte_changes_count_changes_over_every_row_read() {
        let frames: Vec<_> = (0..50u64).map(|i| frame(0x200, i * 1000, &[0, (i / 10) as u8])).collect();
        capture_of("d5-byte-changes", &frames);
        let spec = QuerySpec::ByteChanges {
            frame_id: 0x200,
            is_extended: None,
            window: RowWindow::default(),
            byte_index: 1,
            limit: Some(3),
        };
        let QueryResults::ByteChanges(changes) = run_capture("d5-byte-changes", spec).unwrap().results else { panic!() };
        assert_eq!(changes.iter().map(|c| c.timestamp_us).collect::<Vec<_>>(), [10_000, 20_000, 30_000]);
    }

    #[test]
    fn a_paged_byte_change_query_stops_early_and_matches_the_unpaged_one() {
        let frames: Vec<_> = (0..1000u64).map(|i| frame(0x210, i * 1000, &[0, (i / 7) as u8])).collect();
        capture_of("d5-paged", &frames);
        let spec = |limit| QuerySpec::ByteChanges {
            frame_id: 0x210,
            is_extended: None,
            window: RowWindow::default(),
            byte_index: 1,
            limit,
        };
        let changes = |o: QueryOutcome| match o.results {
            QueryResults::ByteChanges(c) => (c.iter().map(|c| c.timestamp_us).collect::<Vec<_>>(), o.stats.unwrap().rows_scanned),
            _ => panic!(),
        };
        let (whole, read) = changes(capture::run_in_pages("d5-paged", &spec(None), 1000).unwrap());
        assert_eq!((whole.len(), read), (142, 1000));
        let (all_paged, _) = changes(capture::run_in_pages("d5-paged", &spec(None), 10).unwrap());
        assert_eq!(all_paged, whole, "a change across a page edge is found once");
        let (first, read) = changes(capture::run_in_pages("d5-paged", &spec(Some(20)), 10).unwrap());
        assert_eq!(first, whole[..20]);
        assert_eq!(read, 150, "stops at the page holding the 20th change");
    }

    #[test]
    fn first_last_counts_the_window_and_inventory_rolls_it_up() {
        let frames: Vec<_> = (0..5u64).map(|i| frame(0x300, i * 1000, &[i as u8])).collect();
        capture_of("d5-first-last", &frames);
        let window = RowWindow { protocol: None, start_us: Some(1000), end_us: Some(4000) };
        let inventory = QuerySpec::FrameInventory { window: window.clone(), limit: None };
        let spec = QuerySpec::FirstLast { frame_id: 0x300, is_extended: None, window: window.clone() };
        let QueryResults::FirstLast(fl) = run_capture("d5-first-last", spec).unwrap().results else { panic!() };
        assert_eq!((fl.first_timestamp_us, fl.last_timestamp_us, fl.total_count), (1000, 3000, 3));

        let QueryResults::FrameInventory(rows) =
            run_capture("d5-first-last", inventory).unwrap().results
        else {
            panic!()
        };
        assert_eq!(rows.iter().map(|r| (r.frame_id, r.count, r.first_us, r.last_us)).collect::<Vec<_>>(), [(0x300, 3, 1000, 3000)]);
        assert_eq!(capture::frame_inventory("d5-first-last", None, Some(2000)).unwrap()[0].count, 2);
    }

    #[test]
    fn an_empty_pattern_is_refused_before_reading() {
        let spec = QuerySpec::PatternSearch { window: RowWindow::default(), pattern: vec![], pattern_mask: vec![], limit: None };
        assert_eq!(run_capture("d5-nothing", spec).unwrap_err(), "Pattern must not be empty");
    }

    #[test]
    fn a_cancelled_capture_query_stops() {
        let frames: Vec<_> = (0..5000u64).map(|i| frame(0x400, i, &[i as u8])).collect();
        capture_of("d5-cancel", &frames);
        let spec = QuerySpec::Distribution { frame_id: 0x400, is_extended: None, window: RowWindow::default(), byte_index: 0 };
        let cancel = Arc::new(AtomicBool::new(true));
        assert_eq!(capture::run("d5-cancel", &spec, None, &cancel).unwrap_err(), "Query cancelled");
    }

    #[test]
    fn a_mirror_reads_its_compared_bytes_from_the_catalogue() {
        let dir = std::env::temp_dir().join(format!("wiretap-mirror-compare-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("masked.toml");
        std::fs::write(&path, include_str!("mirror-fixture.toml")).unwrap();
        let path = path.to_str();
        let spec = |mirror_frame_id| QuerySpec::MirrorValidation {
            mirror_frame_id,
            source_frame_id: 0x705,
            is_extended: None,
            window: RowWindow::default(),
            tolerance_ms: 10,
            limit: None,
        };
        assert_eq!(mirror_compare(&spec(0x7005), path).unwrap(), Some(BTreeSet::from([0, 1])));
        assert_eq!(mirror_compare(&spec(0x705), path).unwrap(), None, "a source inherits nothing");
        assert_eq!(mirror_compare(&spec(0x005), None).unwrap(), None);
        assert!(mirror_compare(&spec(0x005), Some("/nonexistent/catalogue.toml")).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn inherited_bytes_match_the_query_golden() {
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../frontend/wiretap-ui/src/tests/fixtures/analysis/inheritedBytes.json"
        );
        let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(fixture).expect("fixture")).expect("cases");
        for case in cases {
            let frame: wiretap_catalog::Frame = serde_json::from_value(json!({
                "key": "0x100", "frameId": 0x100, "protocol": "can", "length": 8, "signals": case["signals"],
            }))
            .expect("frame");
            let indices: Vec<usize> = wiretap_catalog::mirror::inherited_byte_indices(&frame).into_iter().collect();
            assert_eq!(json!(indices), case["expected"], "{}", case["name"]);
        }
    }
}
