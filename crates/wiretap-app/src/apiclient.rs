// ui/crates/wiretap-app/src/apiclient.rs
//
// HTTP client for "wiretap" profiles — IO profiles that talk to the WireTAP
// backend gateway over HTTP instead of connecting to PostgreSQL directly.
// Each function mirrors a dbquery command and returns the SAME result struct,
// so callers (the Query app, MCP tools, analysis) are agnostic to the backend.
//
// The archive is one table with a `protocol` column and every read on the
// gateway defaults to CAN, so a profile names the protocol it reads
// (`wiretap_gateway::Protocol`) and this module says so on every request that is
// not CAN.

use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use wiretap_gateway::{
    ByteChangesParams, DistributionParams, Event, EventPatch, EventsResponse, FirstLastParams,
    FrameChangesParams, FrameFilter, FrequencyParams, GapAnalysisParams, ImportResult,
    InventoryEntry, InventoryResponse, MirrorValidationParams, MuxStatisticsParams, NewEvent,
    PatternSearchParams, PayloadsParams, PayloadsResponse, Protocol, SignalResponse, TimeBounds,
};

use crate::capture_events::CaptureEvent;
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
pub(crate) struct Endpoint {
    pub(crate) base_url: String,
    pub(crate) api_key: String,
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

/// The profile's archive protocol, absent meaning CAN. There is no serial
/// archive reader yet, so a profile naming one is refused here.
pub fn archive_protocol(conn: &HashMap<String, Value>) -> Result<Protocol, String> {
    match conn.get("protocol").and_then(|v| v.as_str()) {
        None | Some("") | Some("can") => Ok(Protocol::Can),
        Some("modbus") => Ok(Protocol::Modbus),
        Some("serial") => Err("a WireTAP backend profile cannot read the serial archive yet".into()),
        Some(other) => Err(format!("unknown archive protocol '{other}'")),
    }
}

/// The `FrameMessage.protocol` a row of this protocol becomes. A Modbus
/// archive row is one whole RTU message, which this app calls `modbus_rtu`;
/// `modbus` here means a register poll and would decode it as one.
pub fn frame_tag(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Can => "can",
        Protocol::Modbus => "modbus_rtu",
        Protocol::Serial => unreachable!("archive_protocol refuses serial"),
    }
}

/// `?protocol=…` for a GET, empty for CAN. `first` says whether this is the
/// first parameter on the URL.
pub fn protocol_query(protocol: Protocol, first: bool) -> String {
    let name = match protocol {
        Protocol::Can => return String::new(),
        Protocol::Modbus => "modbus",
        Protocol::Serial => "serial",
    };
    format!("{}protocol={name}", if first { "?" } else { "&" })
}

/// Resolved connection details for a wiretap profile.
pub struct ApiProfile {
    profile_id: String,
    base_url: String,
    api_key: String,
    database: String,
    pub protocol: Protocol,
}

impl ApiProfile {
    pub(crate) fn endpoint(&self) -> Endpoint {
        Endpoint { base_url: self.base_url.clone(), api_key: self.api_key.clone() }
    }

    fn db_url(&self, path: &str) -> String {
        format!("{}/v1/db/{}{}", self.base_url, self.database, path)
    }

    /// The gateway's default goes unsaid, so a CAN profile's requests carry
    /// no `protocol` key, as before the column existed.
    fn wire_protocol(&self) -> Option<Protocol> {
        (self.protocol != Protocol::Can).then_some(self.protocol)
    }

    fn filter(
        &self,
        frame_id: u32,
        is_extended: Option<bool>,
        start_time: Option<String>,
        end_time: Option<String>,
    ) -> FrameFilter {
        FrameFilter { frame_id, is_extended, start_time, end_time, protocol: self.wire_protocol() }
    }
}

/// Pull url + api key + database + protocol out of a wiretap profile.
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
    let protocol = archive_protocol(conn)?;
    Ok(ApiProfile { profile_id: profile.id.clone(), base_url, api_key, database, protocol })
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

/// A gateway response as its type, or its `error` text — "invalid database
/// name 'X'" rather than "HTTP 404". Shared with the frame stream.
pub(crate) async fn parse<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T, String> {
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

/// GET a full URL with a bearer key. An empty key sends no header — right for
/// `/v1/health`, and elsewhere the gateway's 401 comes back as the error text.
async fn get_url<T: DeserializeOwned>(url: String, api_key: &str) -> Result<T, String> {
    let req = HTTP.get(url);
    send(if api_key.is_empty() { req } else { req.bearer_auth(api_key) }).await
}

pub(crate) async fn send<T: DeserializeOwned>(req: reqwest::RequestBuilder) -> Result<T, String> {
    let resp = req
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", describe(&e)))?;
    parse(resp).await
}

async fn get<T: DeserializeOwned>(api: &ApiProfile, path: &str) -> Result<T, String> {
    get_url(api.db_url(path), &api.api_key).await
}

/// POST a query body, registering it for cancellation under `query_id`.
async fn post_query<T: DeserializeOwned>(
    api: &ApiProfile,
    path: &str,
    body: &impl Serialize,
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
    let result = send(HTTP.post(api.db_url(path)).bearer_auth(&api.api_key).json(body)).await;
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
    let body = ByteChangesParams {
        filter: api.filter(frame_id, is_extended, start_time, end_time),
        byte_index,
        limit,
        query_id: Some(query_id.clone()),
    };
    post_query(&api, "/query/byte-changes", &body, &query_id).await
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
    let body = FrameChangesParams {
        filter: api.filter(frame_id, is_extended, start_time, end_time),
        limit,
        query_id: Some(query_id.clone()),
    };
    post_query(&api, "/query/frame-changes", &body, &query_id).await
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
    let body = MirrorValidationParams {
        protocol: api.wire_protocol(),
        mirror_frame_id,
        source_frame_id,
        is_extended,
        tolerance_ms,
        start_time,
        end_time,
        limit,
        query_id: Some(query_id.clone()),
    };
    let mut out: MirrorValidationQueryResult =
        post_query(&api, "/query/mirror-validation", &body, &query_id).await?;

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
        out.stats.results_count = out.results.len() as u64;
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
    let body = MuxStatisticsParams {
        filter: api.filter(frame_id, is_extended, start_time, end_time),
        mux_selector_byte,
        include_16bit,
        payload_length,
        limit,
        query_id: Some(query_id.clone()),
    };
    post_query(&api, "/query/mux-statistics", &body, &query_id).await
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
    let body = FirstLastParams {
        filter: api.filter(frame_id, is_extended, start_time, end_time),
        query_id: Some(query_id.clone()),
    };
    post_query(&api, "/query/first-last", &body, &query_id).await
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
    let body = FrequencyParams {
        filter: api.filter(frame_id, is_extended, start_time, end_time),
        bucket_size_ms,
        limit,
        query_id: Some(query_id.clone()),
    };
    post_query(&api, "/query/frequency", &body, &query_id).await
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
    let body = DistributionParams {
        filter: api.filter(frame_id, is_extended, start_time, end_time),
        byte_index,
        query_id: Some(query_id.clone()),
    };
    post_query(&api, "/query/distribution", &body, &query_id).await
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
    let body = GapAnalysisParams {
        filter: api.filter(frame_id, is_extended, start_time, end_time),
        gap_threshold_ms,
        limit,
        query_id: Some(query_id.clone()),
    };
    post_query(&api, "/query/gap-analysis", &body, &query_id).await
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
    let body = PatternSearchParams {
        protocol: api.wire_protocol(),
        pattern,
        pattern_mask,
        start_time,
        end_time,
        limit,
        query_id: Some(query_id.clone()),
    };
    post_query(&api, "/query/pattern-search", &body, &query_id).await
}

pub async fn activity(profile: &IOProfile) -> Result<DatabaseActivityResult, String> {
    let api = resolve(profile)?;
    get(&api, "/activity").await
}

pub async fn signal_backend(profile: &IOProfile, pid: i32, terminate: bool) -> Result<bool, String> {
    let api = resolve(profile)?;
    let url = if terminate {
        api.db_url(&format!("/activity/{pid}"))
    } else {
        api.db_url(&format!("/activity/{pid}/cancel"))
    };
    let req = if terminate { HTTP.delete(url) } else { HTTP.post(url) };
    Ok(send::<SignalResponse>(req.bearer_auth(&api.api_key)).await?.ok)
}

// ---------------------------------------------------------------------------
// Inventory / payloads (used by analysis.rs + MCP via dbquery)
// ---------------------------------------------------------------------------

/// `max_dlc` is a CAN length code or a Modbus message length (up to 256). A
/// gateway before 0.1.4 serves no `max_len`, and the archive stores a classic
/// frame's code clamped to 8, so a CAN code above 8 can only be FD.
fn inventory_max_len(entry: &InventoryEntry, protocol: Protocol) -> u16 {
    entry.max_len.unwrap_or_else(|| match protocol {
        Protocol::Can => wiretap_protocol::dlc_to_len(entry.max_dlc as u8, true) as u16,
        Protocol::Modbus => entry.max_dlc,
        Protocol::Serial => unreachable!("archive_protocol refuses serial"),
    })
}

/// Every entry is the profile's protocol — the gateway groups one protocol at
/// a time, and a Modbus row's `frame_id` is its unit/function word.
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
    path.push_str(&protocol_query(api.protocol, params.is_empty()));
    let resp: InventoryResponse = get(&api, &path).await?;
    Ok(resp
        .entries
        .into_iter()
        .map(|e| {
            crate::capture_db::InventoryRow::new(
                frame_tag(api.protocol),
                e.frame_id,
                e.is_extended,
                e.count,
                e.first_us,
                e.last_us,
                inventory_max_len(&e, api.protocol),
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
    let body = PayloadsParams { filter: api.filter(frame_id, is_extended, None, None), limit: Some(limit) };
    let resp: PayloadsResponse =
        send(HTTP.post(api.db_url("/payloads")).bearer_auth(&api.api_key).json(&body)).await?;
    Ok(oldest_first(resp))
}

/// The gateway serves `/payloads` newest first; every reader here wants capture order.
fn oldest_first(resp: PayloadsResponse) -> Vec<Vec<u8>> {
    let mut payloads = resp.payloads;
    payloads.reverse();
    payloads
}

// ---------------------------------------------------------------------------
// Capture import — push a local SQLite capture to the backend
// ---------------------------------------------------------------------------

use wiretap_protocol::{can::CanFrame, import};

const IMPORT_PAGE: usize = 50_000;

#[derive(serde::Serialize, Clone)]
struct ImportProgress {
    capture_id: String,
    sent: usize,
    total: usize,
    done: bool,
}

// ---------------------------------------------------------------------------
// Events — the archive's annotations, one per database
// ---------------------------------------------------------------------------

impl From<Event> for CaptureEvent {
    fn from(e: Event) -> Self {
        CaptureEvent {
            id: e.id.to_string(),
            timestamp_us: e.ts_us,
            duration_us: e.duration_us,
            note: e.note,
            created_at_us: e.created_at_us,
            updated_at_us: e.updated_at_us,
        }
    }
}

pub async fn events_list(app: &tauri::AppHandle, profile_id: &str) -> Result<Vec<CaptureEvent>, String> {
    let api = resolve_by_id(app, profile_id).await?;
    // The gateway's default is the oldest 1000; there is no cursor, so ask for all of them.
    let resp: EventsResponse = get(&api, "/events?limit=1000000").await?;
    Ok(resp.events.into_iter().map(Into::into).collect())
}

pub async fn events_add(
    app: &tauri::AppHandle,
    profile_id: &str,
    timestamp_us: i64,
    duration_us: i64,
    note: &str,
) -> Result<CaptureEvent, String> {
    let api = resolve_by_id(app, profile_id).await?;
    let body = NewEvent { ts_us: timestamp_us, duration_us, note: note.to_string() };
    send::<Event>(HTTP.post(api.db_url("/events")).bearer_auth(&api.api_key).json(&body))
        .await
        .map(Into::into)
}

pub async fn events_update(
    app: &tauri::AppHandle,
    profile_id: &str,
    id: &str,
    timestamp_us: i64,
    duration_us: i64,
    note: &str,
) -> Result<CaptureEvent, String> {
    let api = resolve_by_id(app, profile_id).await?;
    let body = EventPatch {
        ts_us: Some(timestamp_us),
        duration_us: Some(duration_us),
        note: Some(note.to_string()),
    };
    send::<Event>(HTTP.patch(api.db_url(&format!("/events/{id}"))).bearer_auth(&api.api_key).json(&body))
        .await
        .map(Into::into)
}

/// A 204 carries no body, which `parse` would reject — only a failure is read.
pub async fn events_delete(app: &tauri::AppHandle, profile_id: &str, id: &str) -> Result<(), String> {
    let api = resolve_by_id(app, profile_id).await?;
    let resp = HTTP
        .delete(api.db_url(&format!("/events/{id}")))
        .bearer_auth(&api.api_key)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", describe(&e)))?;
    if resp.status().is_success() {
        return Ok(());
    }
    parse::<Value>(resp).await.map(|_| ())
}

/// Every frame goes as a CAN record, as the format has no other kind.
fn import_body(frames: &[crate::io::FrameMessage]) -> Vec<u8> {
    let mut body = Vec::with_capacity(import::BODY_HEADER + frames.len() * 24);
    import::encode_header_into(&mut body);
    for f in frames {
        let frame = if f.is_rtr {
            CanFrame::remote(f.bus, f.frame_id, f.is_extended, wiretap_protocol::payload_dlc(f.dlc as usize, false))
        } else {
            let mut frame = CanFrame::data(f.bus, f.frame_id, f.is_extended, f.is_fd, f.is_brs, f.bytes.clone());
            frame.esi = f.is_esi;
            frame
        };
        import::encode_record_into(&mut body, f.timestamp_us as i64, &frame, f.direction.as_deref() == Some("tx"));
    }
    body
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
    if !wiretap_protocol::ingest::valid_database_name(&database) {
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
        let body = import_body(&frames);

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
        imported_total += parse::<ImportResult>(resp).await?.imported;

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

pub(crate) async fn resolve_by_id(app: &tauri::AppHandle, profile_id: &str) -> Result<ApiProfile, String> {
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
    list_databases(&api.base_url, &api.api_key).await
}

async fn list_databases(base_url: &str, api_key: &str) -> Result<Vec<ApiDatabase>, String> {
    #[derive(Deserialize)]
    struct Resp {
        databases: Vec<ApiDatabase>,
    }
    Ok(get_url::<Resp>(format!("{base_url}/v1/databases"), api_key).await?.databases)
}

/// Create a new capture database on the backend (admin key required).
#[tauri::command]
pub async fn api_create_database(
    app: tauri::AppHandle,
    profile_id: String,
    name: String,
) -> Result<(), String> {
    let api = resolve_by_id(&app, &profile_id).await?;
    let req = HTTP.post(format!("{}/v1/databases", api.base_url)).bearer_auth(&api.api_key).json(&json!({ "name": name }));
    send::<Value>(req).await.map(|_| ())
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

// ---------------------------------------------------------------------------
// Profile-editor probes — from loose parameters, so an unsaved profile works
// ---------------------------------------------------------------------------

/// The key for a form that is still being edited: what was typed, else what the
/// saved profile keeps in the keychain. Empty when there is neither, which the
/// gateway answers with a 401 the probe reports as such.
async fn editor_api_key(
    app: &tauri::AppHandle,
    api_key: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        return Ok(key);
    }
    match profile_id {
        Some(id) => resolve_by_id(app, &id).await.map(|api| api.api_key),
        None => Ok(String::new()),
    }
}

/// What `/v1/health` and `/v1/databases` say about a gateway. Health needs no
/// key, so a wrong key still gets the version and a `databases_error` naming
/// the refusal rather than an opaque failure.
#[derive(serde::Serialize)]
pub struct BackendProbe {
    pub version: String,
    pub status: String,
    pub db_ok: bool,
    pub databases: Vec<ApiDatabase>,
    pub databases_error: Option<String>,
}

#[tauri::command]
pub async fn api_probe_backend(
    app: tauri::AppHandle,
    url: String,
    api_key: Option<String>,
    profile_id: Option<String>,
) -> Result<BackendProbe, String> {
    let base_url = url.trim_end_matches('/').to_string();
    #[derive(Deserialize)]
    struct Health {
        #[serde(default)]
        version: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        db_ok: bool,
    }
    let health: Health = get_url(format!("{base_url}/v1/health"), "").await?;
    let key = editor_api_key(&app, api_key, profile_id).await?;
    let (databases, databases_error) = match list_databases(&base_url, &key).await {
        Ok(d) => (d, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    Ok(BackendProbe {
        version: health.version,
        status: health.status,
        db_ok: health.db_ok,
        databases,
        databases_error,
    })
}

/// The protocols a capture database holds, for defaulting a profile's.
///
/// `time-bounds` is one rollup row per call, so this costs two of them. A
/// gateway that predates the column ignores `?protocol=` and answers the CAN
/// bounds to both, which is why Modbus is reported only when its bounds differ
/// from CAN's — a database holding both will have different edges, and one
/// answered by an old gateway cannot.
#[tauri::command]
pub async fn api_database_protocols(
    app: tauri::AppHandle,
    url: String,
    api_key: Option<String>,
    profile_id: Option<String>,
    database: String,
) -> Result<Vec<Protocol>, String> {
    let base_url = url.trim_end_matches('/').to_string();
    let key = editor_api_key(&app, api_key, profile_id).await?;
    let bounds = |protocol: Protocol| {
        get_url::<TimeBounds>(
            format!("{base_url}/v1/db/{database}/time-bounds{}", protocol_query(protocol, true)),
            &key,
        )
    };
    let can = bounds(Protocol::Can).await?;
    let modbus = bounds(Protocol::Modbus).await?;
    let mut out = Vec::new();
    if can.min_ts_us.is_some() {
        out.push(Protocol::Can);
    }
    if modbus.min_ts_us.is_some() && modbus != can {
        out.push(Protocol::Modbus);
    }
    Ok(out)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(pairs: &[(&str, Value)]) -> HashMap<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    fn api(protocol: Protocol) -> ApiProfile {
        ApiProfile {
            profile_id: "p".into(),
            base_url: "http://g:8423".into(),
            api_key: String::new(),
            database: "db".into(),
            protocol,
        }
    }

    #[test]
    fn can_is_the_unsaid_default_modbus_is_named_and_serial_is_refused() {
        assert_eq!(archive_protocol(&conn(&[])).unwrap(), Protocol::Can);
        assert_eq!(archive_protocol(&conn(&[("protocol", json!("can"))])).unwrap(), Protocol::Can);
        assert_eq!(archive_protocol(&conn(&[("protocol", json!("modbus"))])).unwrap(), Protocol::Modbus);
        assert!(archive_protocol(&conn(&[("protocol", json!("modbsu"))])).is_err());
        let serial = archive_protocol(&conn(&[("protocol", json!("serial"))])).unwrap_err();
        assert!(serial.contains("serial"), "{serial}");

        assert_eq!(protocol_query(Protocol::Can, true), "");
        assert_eq!(protocol_query(Protocol::Modbus, true), "?protocol=modbus");
        assert_eq!(protocol_query(Protocol::Modbus, false), "&protocol=modbus");
        assert_eq!(frame_tag(Protocol::Can), "can");
        assert_eq!(frame_tag(Protocol::Modbus), "modbus_rtu");
    }

    #[test]
    fn payloads_arrive_newest_first_and_are_read_oldest_first() {
        let resp = PayloadsResponse { payloads: vec![vec![3], vec![2], vec![1]] };
        assert_eq!(oldest_first(resp), vec![vec![1], vec![2], vec![3]]);
    }

    #[test]
    fn an_inventory_length_code_becomes_a_length_for_can_only() {
        let entry = |max_dlc| InventoryEntry {
            frame_id: 0,
            is_extended: false,
            count: 1,
            first_us: 0,
            last_us: 0,
            max_dlc,
            max_len: None,
        };
        for (code, len) in [(8, 8), (9, 12), (15, 64)] {
            assert_eq!(inventory_max_len(&entry(code), Protocol::Can), len);
        }
        assert_eq!(inventory_max_len(&entry(15), Protocol::Modbus), 15);
        assert_eq!(inventory_max_len(&entry(256), Protocol::Modbus), 256);
    }

    #[test]
    fn the_gateways_max_len_is_taken_over_the_code_when_served() {
        let entry = |max_len: Value| -> InventoryEntry {
            serde_json::from_value(json!({
                "frame_id": 0, "is_extended": false, "count": 1, "first_us": 0, "last_us": 0,
                "max_dlc": 9, "max_len": max_len,
            }))
            .unwrap()
        };
        assert_eq!(inventory_max_len(&entry(json!(20)), Protocol::Can), 20);
        assert_eq!(inventory_max_len(&entry(Value::Null), Protocol::Can), 12);
    }

    #[test]
    fn a_query_body_names_the_protocol_only_when_it_is_not_can() {
        let body = |protocol| {
            serde_json::to_value(ByteChangesParams {
                filter: api(protocol).filter(613, Some(false), Some("s".into()), None),
                byte_index: 2,
                limit: Some(10),
                query_id: Some("q".into()),
            })
            .unwrap()
        };
        let can = json!({
            "frame_id": 613, "is_extended": false, "start_time": "s", "end_time": null,
            "byte_index": 2, "limit": 10, "query_id": "q",
        });
        assert_eq!(body(Protocol::Can), can);
        let mut modbus = can;
        modbus["protocol"] = json!("modbus");
        assert_eq!(body(Protocol::Modbus), modbus);

        let pattern = |protocol| {
            serde_json::to_value(PatternSearchParams {
                protocol: api(protocol).wire_protocol(),
                pattern: vec![1],
                pattern_mask: vec![0xff],
                start_time: None,
                end_time: None,
                limit: None,
                query_id: None,
            })
            .unwrap()
        };
        assert!(pattern(Protocol::Can).get("protocol").is_none());
        assert_eq!(pattern(Protocol::Modbus)["protocol"], "modbus");
    }

    fn uploaded(body: &[u8]) -> Vec<(i64, bool, CanFrame)> {
        let mut at = import::parse_header(body).unwrap().expect("a whole header");
        let mut records = Vec::new();
        while let Some((record, consumed)) = import::parse_record(&body[at..]).unwrap() {
            at += consumed;
            let wiretap_protocol::ingest::RecordFields::Can { transmitted, .. } = record.fields() else {
                unreachable!("an import record is CAN")
            };
            records.push((record.ts_us, transmitted, record.into_can()));
        }
        assert_eq!(at, body.len(), "trailing bytes");
        records
    }

    #[test]
    fn an_upload_keeps_an_rtrs_length_code_and_fd_brs_esi() {
        let rtr = crate::io::FrameMessage {
            protocol: "can".into(),
            timestamp_us: 1,
            frame_id: 0x123,
            dlc: 6,
            is_rtr: true,
            ..Default::default()
        };
        let fd = crate::io::FrameMessage {
            protocol: "can".into(),
            timestamp_us: 2,
            frame_id: 0x1234_5678,
            bus: 2,
            dlc: 12,
            bytes: vec![7; 12],
            is_extended: true,
            is_fd: true,
            is_brs: true,
            is_esi: true,
            direction: Some("tx".into()),
            ..Default::default()
        };
        let mut esi = CanFrame::data(2, 0x1234_5678, true, true, true, vec![7; 12]);
        esi.esi = true;
        assert_eq!(
            uploaded(&import_body(&[rtr, fd])),
            vec![(1, false, CanFrame::remote(0, 0x123, false, 6)), (2, true, esi)],
        );
    }

    #[test]
    fn every_upload_body_starts_with_the_import_header() {
        let page = |ts| crate::io::FrameMessage { protocol: "can".into(), timestamp_us: ts, ..Default::default() };
        for body in [import_body(&[page(1)]), import_body(&[page(2)])] {
            assert_eq!(import::parse_header(&body), Ok(Some(import::BODY_HEADER)));
        }
    }

    #[test]
    fn an_uploaded_classic_frame_is_unchanged() {
        let classic = crate::io::FrameMessage {
            protocol: "can".into(),
            timestamp_us: 1_767_225_600_000_000,
            frame_id: 0x7FF,
            bus: 1,
            dlc: 3,
            bytes: vec![1, 2, 3],
            ..Default::default()
        };
        assert_eq!(
            uploaded(&import_body(&[classic])),
            vec![(1_767_225_600_000_000, false, CanFrame::data(1, 0x7FF, false, false, false, vec![1, 2, 3]))],
        );
    }
}
