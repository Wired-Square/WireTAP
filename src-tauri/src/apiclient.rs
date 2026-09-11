// ui/src-tauri/src/apiclient.rs
//
// HTTP client for "wiretap" profiles — IO profiles that talk to the WireTAP
// backend gateway over HTTP instead of connecting to PostgreSQL directly.
// Each function mirrors a dbquery command and returns the SAME result struct,
// so callers (the Query app, MCP tools, analysis) are agnostic to the backend.

use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::credentials::{self, get_credential};
use crate::queryresults::{
    differing_byte_indices, ByteChangeQueryResult, DatabaseActivityResult, DistributionQueryResult,
    FirstLastQueryResult, FrameChangeQueryResult, FrequencyQueryResult, GapAnalysisQueryResult,
    MirrorValidationQueryResult, MuxStatisticsQueryResult, PatternSearchQueryResult,
};
use crate::settings::IOProfile;

/// The one client for the WireTAP backend gateway — queries here and the frame
/// stream in `io/recorded/backend_api.rs` alike, so both share a connection pool
/// and both inherit the connect bound. Without it an unroutable gateway waits out
/// the OS default, which is minutes.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(crate::io::net::CONNECT_TIMEOUT)
        .build()
        .unwrap_or_default()
});

/// The shared backend client, for the streaming path in `io/`.
pub fn http() -> &'static reqwest::Client {
    &HTTP
}

/// A transport error with its cause chain. `reqwest::Error` displays as "error
/// sending request" and keeps refused, reset or timed out for `source()`.
pub fn describe(e: &reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        out.push_str(": ");
        out.push_str(&s.to_string());
        source = s.source();
    }
    out
}

/// Queries currently in flight, keyed by `query_id`: what to DELETE to cancel
/// one, and enough about it to be worth printing in the session status log.
static API_RUNNING: LazyLock<Mutex<HashMap<String, InFlight>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct Endpoint {
    base_url: String,
    api_key: String,
}

/// An in-flight query: what to DELETE to cancel it, and what to say about it.
/// The endpoint is kept apart from the reportable half because it holds the API
/// key, which must not reach a log line.
#[derive(Clone)]
struct InFlight {
    endpoint: Endpoint,
    info: RunningQueryInfo,
}

/// A running query, for status logging.
#[derive(Debug, Clone)]
pub struct RunningQueryInfo {
    pub query_type: String,
    pub profile_id: String,
    pub started_at: std::time::Instant,
}

/// Resolved connection details for a wiretap profile.
pub struct ApiProfile {
    profile_id: String,
    base_url: String,
    api_key: String,
    database: String,
}

impl ApiProfile {
    fn endpoint(&self) -> Endpoint {
        Endpoint { base_url: self.base_url.clone(), api_key: self.api_key.clone() }
    }

    fn db_url(&self, path: &str) -> String {
        format!("{}/v1/db/{}{}", self.base_url, self.database, path)
    }
}

/// Pull url + api key + database out of a wiretap profile.
pub fn resolve(profile: &IOProfile) -> Result<ApiProfile, String> {
    let conn = &profile.connection;
    let base_url = conn
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("wiretap profile is missing 'url'")?
        .trim_end_matches('/')
        .to_string();
    let database = conn
        .get("database")
        .and_then(|v| v.as_str())
        .unwrap_or("wiretap")
        .to_string();
    let api_key = resolve_api_key(profile)?;
    Ok(ApiProfile { profile_id: profile.id.clone(), base_url, api_key, database })
}

fn resolve_api_key(profile: &IOProfile) -> Result<String, String> {
    if credentials::has_stored_marker(profile, "api_key") {
        match get_credential(&profile.id, "api_key") {
            Ok(Some(key)) => return Ok(key),
            Ok(None) => return Err("wiretap profile API key not found in credential store".into()),
            Err(e) => return Err(format!("credential store error: {e}")),
        }
    }
    // Fall back to an inline key (useful for unauthenticated/dev backends)
    Ok(profile
        .connection
        .get("api_key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async fn parse<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T, String> {
    if !resp.status().is_success() {
        let status = resp.status();
        let msg = resp
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(msg);
    }
    resp.json::<T>().await.map_err(|e| format!("API response decode failed: {e}"))
}

async fn get<T: DeserializeOwned>(api: &ApiProfile, path: &str) -> Result<T, String> {
    let resp = HTTP
        .get(api.db_url(path))
        .bearer_auth(&api.api_key)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", describe(&e)))?;
    parse(resp).await
}

/// POST a query body, registering it for cancellation under `query_id`.
async fn post_query<T: DeserializeOwned>(
    api: &ApiProfile,
    path: &str,
    body: Value,
    query_id: &str,
) -> Result<T, String> {
    API_RUNNING.lock().await.insert(
        query_id.to_string(),
        InFlight {
            endpoint: api.endpoint(),
            info: RunningQueryInfo {
                query_type: path.trim_start_matches('/').to_string(),
                profile_id: api.profile_id.clone(),
                started_at: std::time::Instant::now(),
            },
        },
    );
    let result = async {
        let resp = HTTP
            .post(api.db_url(path))
            .bearer_auth(&api.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("API request failed: {}", describe(&e)))?;
        parse(resp).await
    }
    .await;
    API_RUNNING.lock().await.remove(query_id);
    result
}

/// Every query currently in flight, for the session status log.
pub async fn running_queries() -> Vec<(String, RunningQueryInfo)> {
    API_RUNNING
        .lock()
        .await
        .iter()
        .map(|(id, q)| (id.clone(), q.info.clone()))
        .collect()
}

/// Cancel an in-flight query. Returns true if it was a known query.
pub async fn cancel_query(query_id: &str) -> bool {
    let ep = match API_RUNNING.lock().await.get(query_id) {
        Some(q) => q.endpoint.clone(),
        None => return false,
    };
    let _ = HTTP
        .delete(format!("{}/v1/queries/{}", ep.base_url, query_id))
        .bearer_auth(&ep.api_key)
        .send()
        .await;
    API_RUNNING.lock().await.remove(query_id);
    true
}

/// Common frame-filter fields shared by most query bodies.
fn filter_body(
    frame_id: u32,
    is_extended: Option<bool>,
    start_time: &Option<String>,
    end_time: &Option<String>,
) -> Value {
    json!({
        "frame_id": frame_id,
        "is_extended": is_extended,
        "start_time": start_time,
        "end_time": end_time,
    })
}

fn merge(mut base: Value, extra: &[(&str, Value)]) -> Value {
    let obj = base.as_object_mut().expect("object body");
    for (k, v) in extra {
        obj.insert((*k).to_string(), v.clone());
    }
    base
}

// ---------------------------------------------------------------------------
// Query functions — signatures mirror the dbquery commands
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub async fn byte_changes(
    profile: &IOProfile,
    frame_id: u32,
    byte_index: u8,
    is_extended: Option<bool>,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: String,
) -> Result<ByteChangeQueryResult, String> {
    let api = resolve(profile)?;
    let body = merge(
        filter_body(frame_id, is_extended, &start_time, &end_time),
        &[("byte_index", json!(byte_index)), ("limit", json!(limit)), ("query_id", json!(query_id))],
    );
    post_query(&api, "/query/byte-changes", body, &query_id).await
}

pub async fn frame_changes(
    profile: &IOProfile,
    frame_id: u32,
    is_extended: Option<bool>,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: String,
) -> Result<FrameChangeQueryResult, String> {
    let api = resolve(profile)?;
    let body = merge(
        filter_body(frame_id, is_extended, &start_time, &end_time),
        &[("limit", json!(limit)), ("query_id", json!(query_id))],
    );
    post_query(&api, "/query/frame-changes", body, &query_id).await
}

#[allow(clippy::too_many_arguments)]
pub async fn mirror_validation(
    profile: &IOProfile,
    mirror_frame_id: u32,
    source_frame_id: u32,
    is_extended: Option<bool>,
    tolerance_ms: u32,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: String,
    compare: Option<BTreeSet<usize>>,
) -> Result<MirrorValidationQueryResult, String> {
    let api = resolve(profile)?;
    let body = json!({
        "mirror_frame_id": mirror_frame_id,
        "source_frame_id": source_frame_id,
        "is_extended": is_extended,
        "tolerance_ms": tolerance_ms,
        "start_time": start_time,
        "end_time": end_time,
        "limit": limit,
        "query_id": query_id,
    });
    let mut out: MirrorValidationQueryResult =
        post_query(&api, "/query/mirror-validation", body, &query_id).await?;

    // The gateway compares whole payloads and has no catalogue, so narrowing to
    // the mirror's inherited bytes happens here. Note this filters *after* the
    // remote applied `limit`, so `limit` counts whole-payload differences and
    // you get the subset of those that also differ on an inherited byte — the
    // local Postgres path has the same shape, whereas a capture query limits
    // the filtered rows. `stats` still describes the remote's pre-filter work
    // apart from `results_count`.
    if let Some(compare) = compare {
        out.results.retain_mut(|r| {
            r.mismatch_indices = differing_byte_indices(
                &r.mirror_payload,
                &r.source_payload,
                Some(&compare),
            );
            !r.mismatch_indices.is_empty()
        });
        out.stats.results_count = out.results.len();
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub async fn mux_statistics(
    profile: &IOProfile,
    frame_id: u32,
    mux_selector_byte: u8,
    is_extended: Option<bool>,
    include_16bit: bool,
    payload_length: u8,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: String,
) -> Result<MuxStatisticsQueryResult, String> {
    let api = resolve(profile)?;
    let body = merge(
        filter_body(frame_id, is_extended, &start_time, &end_time),
        &[
            ("mux_selector_byte", json!(mux_selector_byte)),
            ("include_16bit", json!(include_16bit)),
            ("payload_length", json!(payload_length)),
            ("limit", json!(limit)),
            ("query_id", json!(query_id)),
        ],
    );
    post_query(&api, "/query/mux-statistics", body, &query_id).await
}

pub async fn first_last(
    profile: &IOProfile,
    frame_id: u32,
    is_extended: Option<bool>,
    start_time: Option<String>,
    end_time: Option<String>,
    query_id: String,
) -> Result<FirstLastQueryResult, String> {
    let api = resolve(profile)?;
    let body = merge(
        filter_body(frame_id, is_extended, &start_time, &end_time),
        &[("query_id", json!(query_id))],
    );
    post_query(&api, "/query/first-last", body, &query_id).await
}

#[allow(clippy::too_many_arguments)]
pub async fn frequency(
    profile: &IOProfile,
    frame_id: u32,
    is_extended: Option<bool>,
    bucket_size_ms: u32,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: String,
) -> Result<FrequencyQueryResult, String> {
    let api = resolve(profile)?;
    let body = merge(
        filter_body(frame_id, is_extended, &start_time, &end_time),
        &[
            ("bucket_size_ms", json!(bucket_size_ms)),
            ("limit", json!(limit)),
            ("query_id", json!(query_id)),
        ],
    );
    post_query(&api, "/query/frequency", body, &query_id).await
}

pub async fn distribution(
    profile: &IOProfile,
    frame_id: u32,
    byte_index: u8,
    is_extended: Option<bool>,
    start_time: Option<String>,
    end_time: Option<String>,
    query_id: String,
) -> Result<DistributionQueryResult, String> {
    let api = resolve(profile)?;
    let body = merge(
        filter_body(frame_id, is_extended, &start_time, &end_time),
        &[("byte_index", json!(byte_index)), ("query_id", json!(query_id))],
    );
    post_query(&api, "/query/distribution", body, &query_id).await
}

#[allow(clippy::too_many_arguments)]
pub async fn gap_analysis(
    profile: &IOProfile,
    frame_id: u32,
    is_extended: Option<bool>,
    gap_threshold_ms: f64,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: String,
) -> Result<GapAnalysisQueryResult, String> {
    let api = resolve(profile)?;
    let body = merge(
        filter_body(frame_id, is_extended, &start_time, &end_time),
        &[
            ("gap_threshold_ms", json!(gap_threshold_ms)),
            ("limit", json!(limit)),
            ("query_id", json!(query_id)),
        ],
    );
    post_query(&api, "/query/gap-analysis", body, &query_id).await
}

pub async fn pattern_search(
    profile: &IOProfile,
    pattern: Vec<u8>,
    pattern_mask: Vec<u8>,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: String,
) -> Result<PatternSearchQueryResult, String> {
    let api = resolve(profile)?;
    let body = json!({
        "pattern": pattern,
        "pattern_mask": pattern_mask,
        "start_time": start_time,
        "end_time": end_time,
        "limit": limit,
        "query_id": query_id,
    });
    post_query(&api, "/query/pattern-search", body, &query_id).await
}

pub async fn activity(profile: &IOProfile) -> Result<DatabaseActivityResult, String> {
    let api = resolve(profile)?;
    get(&api, "/activity").await
}

pub async fn signal_backend(profile: &IOProfile, pid: i32, terminate: bool) -> Result<bool, String> {
    let api = resolve(profile)?;
    #[derive(Deserialize)]
    struct Ok_ {
        ok: bool,
    }
    let url = if terminate {
        api.db_url(&format!("/activity/{pid}"))
    } else {
        api.db_url(&format!("/activity/{pid}/cancel"))
    };
    let req = if terminate { HTTP.delete(url) } else { HTTP.post(url) };
    let resp = req
        .bearer_auth(&api.api_key)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", describe(&e)))?;
    Ok(parse::<Ok_>(resp).await?.ok)
}

// ---------------------------------------------------------------------------
// Inventory / payloads (used by analysis.rs + MCP via dbquery)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct InventoryEntry {
    frame_id: u32,
    is_extended: bool,
    count: i64,
    first_us: i64,
    last_us: i64,
    max_dlc: u8,
}

/// The gateway serves the same CAN-only archive as a direct PostgreSQL profile,
/// so every entry is CAN.
pub async fn frame_inventory(
    profile: &IOProfile,
    start_time: Option<String>,
    end_time: Option<String>,
) -> Result<Vec<crate::capture_db::InventoryRow>, String> {
    let api = resolve(profile)?;
    let mut path = String::from("/inventory");
    let mut params = Vec::new();
    if let Some(s) = &start_time {
        params.push(format!("start={}", urlencoding(s)));
    }
    if let Some(e) = &end_time {
        params.push(format!("end={}", urlencoding(e)));
    }
    if !params.is_empty() {
        path.push('?');
        path.push_str(&params.join("&"));
    }
    #[derive(Deserialize)]
    struct Resp {
        entries: Vec<InventoryEntry>,
    }
    let resp: Resp = get(&api, &path).await?;
    Ok(resp
        .entries
        .into_iter()
        .map(|e| {
            crate::capture_db::InventoryRow::new(
                "can",
                e.frame_id,
                e.is_extended,
                e.count,
                e.first_us,
                e.last_us,
                e.max_dlc,
            )
        })
        .collect())
}

pub async fn fetch_frame_payloads(
    profile: &IOProfile,
    frame_id: u32,
    is_extended: Option<bool>,
    limit: u32,
) -> Result<Vec<Vec<u8>>, String> {
    let api = resolve(profile)?;
    let body = json!({ "frame_id": frame_id, "is_extended": is_extended, "limit": limit });
    #[derive(Deserialize)]
    struct Resp {
        payloads: Vec<Vec<u8>>,
    }
    let resp = HTTP
        .post(api.db_url("/payloads"))
        .bearer_auth(&api.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", describe(&e)))?;
    Ok(parse::<Resp>(resp).await?.payloads)
}

// ---------------------------------------------------------------------------
// Capture import — push a local SQLite capture to the backend
// ---------------------------------------------------------------------------

use wiretap_protocol::ingest::{ID_ARB_MASK, ID_EXTENDED, ID_FD, ID_TX};

const IMPORT_PAGE: usize = 50_000;

#[derive(serde::Serialize, Clone)]
struct ImportProgress {
    capture_id: String,
    sent: usize,
    total: usize,
    done: bool,
}

#[derive(Deserialize)]
struct ImportResp {
    imported: u64,
}

/// Encode one frame in the backend's flat import record format:
/// `ts_us u64 LE, id_flags u32 LE, bus u8, len u8, payload`.
fn encode_import_record(buf: &mut Vec<u8>, f: &crate::io::FrameMessage) {
    let mut id_flags = f.frame_id & ID_ARB_MASK;
    if f.is_extended {
        id_flags |= ID_EXTENDED;
    }
    if f.is_fd {
        id_flags |= ID_FD;
    }
    if f.direction.as_deref() == Some("tx") {
        id_flags |= ID_TX;
    }
    let payload = if f.bytes.len() > 64 { &f.bytes[..64] } else { &f.bytes[..] };
    buf.extend_from_slice(&(f.timestamp_us as i64).to_le_bytes());
    buf.extend_from_slice(&id_flags.to_le_bytes());
    buf.push(f.bus);
    buf.push(payload.len() as u8);
    buf.extend_from_slice(payload);
}

/// Upload a local SQLite capture's frames to a backend capture database.
/// Pages through the capture and POSTs chunks so memory stays bounded;
/// emits `capture-upload-progress` events for the UI.
#[tauri::command]
pub async fn api_import_capture(
    app: tauri::AppHandle,
    profile_id: String,
    capture_id: String,
    database: String,
    create: bool,
) -> Result<u64, String> {
    use tauri::Emitter;

    let settings = crate::settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {e}"))?;
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| format!("Profile not found: {profile_id}"))?;
    if profile.kind != "wiretap" {
        return Err("Target profile is not a WireTAP backend profile".into());
    }
    let api = resolve(&profile)?;
    if database.is_empty()
        || !database.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(format!("invalid database name '{database}'"));
    }

    let mut offset = 0usize;
    let mut total = usize::MAX;
    let mut imported_total: u64 = 0;
    let mut first = true;

    while offset < total {
        let (frames, _indices, count) =
            crate::capture_store::get_capture_frames_paginated(&capture_id, offset, IMPORT_PAGE);
        total = count;
        if frames.is_empty() {
            break;
        }
        let mut body = Vec::with_capacity(frames.len() * 24);
        for f in &frames {
            encode_import_record(&mut body, f);
        }

        let url = format!(
            "{}/v1/db/{}/import{}",
            api.base_url,
            database,
            if first && create { "?create=true" } else { "" }
        );
        let resp = HTTP
            .post(url)
            .bearer_auth(&api.api_key)
            .header("Content-Type", "application/x-wiretap-frames")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("import request failed: {}", describe(&e)))?;
        imported_total += parse::<ImportResp>(resp).await?.imported;

        offset += frames.len();
        first = false;
        let _ = app.emit(
            "capture-upload-progress",
            ImportProgress {
                capture_id: capture_id.clone(),
                sent: offset,
                total,
                done: false,
            },
        );
    }

    let _ = app.emit(
        "capture-upload-progress",
        ImportProgress { capture_id, sent: offset, total: offset, done: true },
    );
    Ok(imported_total)
}

// ---------------------------------------------------------------------------
// Database management (tauri commands used by the profile editor)
// ---------------------------------------------------------------------------

#[derive(Deserialize, serde::Serialize)]
pub struct ApiDatabase {
    pub name: String,
    pub size_bytes: i64,
}

async fn resolve_by_id(app: &tauri::AppHandle, profile_id: &str) -> Result<ApiProfile, String> {
    let settings = crate::settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {e}"))?;
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| format!("Profile not found: {profile_id}"))?;
    resolve(&profile)
}

/// List capture databases on the backend (for the profile editor's picker).
#[tauri::command]
pub async fn api_list_databases(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<Vec<ApiDatabase>, String> {
    let api = resolve_by_id(&app, &profile_id).await?;
    #[derive(Deserialize)]
    struct Resp {
        databases: Vec<ApiDatabase>,
    }
    let resp = HTTP
        .get(format!("{}/v1/databases", api.base_url))
        .bearer_auth(&api.api_key)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", describe(&e)))?;
    Ok(parse::<Resp>(resp).await?.databases)
}

/// Create a new capture database on the backend (admin key required).
#[tauri::command]
pub async fn api_create_database(
    app: tauri::AppHandle,
    profile_id: String,
    name: String,
) -> Result<(), String> {
    let api = resolve_by_id(&app, &profile_id).await?;
    let resp = HTTP
        .post(format!("{}/v1/databases", api.base_url))
        .bearer_auth(&api.api_key)
        .json(&json!({ "name": name }))
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", describe(&e)))?;
    parse::<Value>(resp).await.map(|_| ())
}

/// Health/connectivity probe for the profile editor ("Test connection").
#[tauri::command]
pub async fn api_test_connection(app: tauri::AppHandle, profile_id: String) -> Result<bool, String> {
    let api = resolve_by_id(&app, &profile_id).await?;
    let resp = HTTP
        .get(format!("{}/v1/health", api.base_url))
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", describe(&e)))?;
    Ok(resp.status().is_success())
}

/// Minimal percent-encoding for query-string values (RFC3339 timestamps).
pub(crate) fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
