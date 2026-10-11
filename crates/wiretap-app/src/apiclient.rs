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

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Serialize;
use wiretap_analysis::source::InventoryRow;
use wiretap_gateway::client::{ClientError, ClientOptions, Db, GatewayClient};
use wiretap_gateway::{
    DatabaseActivityResult, EventPatch, FrameFilter, NewEvent, Protocol, TimeRangeQuery,
};
use wiretap_io::profile::ConnValue;

use crate::capture_events::CaptureEvent;
use crate::credentials::{self, get_credential};
use crate::settings::IOProfile;

/// The root of every gateway client — queries, the frame stream in
/// `io/recorded/backend_api.rs` and the editor probes — so all share one pool,
/// one running-query registry and the connect bound.
static GATEWAY: LazyLock<GatewayClient> = LazyLock::new(|| {
    GatewayClient::new(
        "",
        "",
        ClientOptions {
            connect_timeout: Some(crate::io::net::CONNECT_TIMEOUT),
        },
    )
    .expect("the gateway HTTP client builds")
});

pub(crate) fn gateway() -> &'static GatewayClient {
    &GATEWAY
}

/// The profile's archive protocol, absent meaning CAN. There is no serial
/// archive reader yet, so a profile naming one is refused here.
pub fn archive_protocol(conn: &HashMap<String, ConnValue>) -> Result<Protocol, String> {
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

/// Resolved connection details for a wiretap profile.
pub struct ApiProfile {
    pub(crate) client: GatewayClient,
    api_key: String,
    database: String,
    pub protocol: Protocol,
}

impl ApiProfile {
    fn new(
        profile_id: &str,
        base_url: &str,
        api_key: String,
        database: String,
        protocol: Protocol,
    ) -> Self {
        Self {
            client: gateway()
                .with_endpoint(base_url, &api_key)
                .with_label(profile_id),
            api_key,
            database,
            protocol,
        }
    }

    pub(crate) fn db(&self) -> Db<'_> {
        self.client.db(&self.database, self.protocol)
    }
}

/// Pull url + api key + database + protocol out of a wiretap profile.
pub fn resolve(profile: &IOProfile) -> Result<ApiProfile, String> {
    let conn = &profile.connection;
    let base_url = conn
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("wiretap profile is missing 'url'")?;
    let database = conn
        .get("database")
        .and_then(|v| v.as_str())
        .unwrap_or("wiretap")
        .to_string();
    let api_key = resolve_api_key(profile)?;
    let protocol = archive_protocol(conn)?;
    Ok(ApiProfile::new(
        &profile.id,
        base_url,
        api_key,
        database,
        protocol,
    ))
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

pub(crate) fn text(e: ClientError) -> String {
    e.to_string()
}

pub async fn activity(profile: &IOProfile) -> Result<DatabaseActivityResult, String> {
    resolve(profile)?.db().activity().await.map_err(text)
}

pub async fn signal_backend(
    profile: &IOProfile,
    pid: i32,
    terminate: bool,
) -> Result<bool, String> {
    resolve(profile)?
        .db()
        .signal(pid, terminate)
        .await
        .map_err(text)
}

// ---------------------------------------------------------------------------
// Inventory / payloads (used by analysis.rs + MCP via dbquery)
// ---------------------------------------------------------------------------

/// The rows and whether the inventory was cut. Every entry is the profile's
/// protocol — the gateway groups one protocol at a time, and a Modbus row's
/// `frame_id` is its unit/function word.
pub(crate) async fn read_inventory(
    api: &ApiProfile,
    query: TimeRangeQuery,
) -> Result<(Vec<InventoryRow>, bool), String> {
    let (entries, truncated) = api.db().inventory(query).await.map_err(text)?;
    let rows = entries
        .into_iter()
        .map(|e| {
            let max_len = e.max_len_for(api.protocol);
            InventoryRow::new(
                frame_tag(api.protocol),
                e.frame_id,
                e.is_extended,
                e.count,
                e.first_us,
                e.last_us,
                max_len,
            )
        })
        .collect();
    Ok((rows, truncated))
}

pub async fn frame_inventory(
    profile: &IOProfile,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<Vec<InventoryRow>, String> {
    let api = resolve(profile)?;
    let bound = |us: Option<i64>| {
        us.map(wiretap_gateway::rfc3339)
            .transpose()
            .map_err(|e| e.to_string())
    };
    let query = TimeRangeQuery {
        start: bound(start_us)?,
        end: bound(end_us)?,
        protocol: None,
        limit: None,
    };
    Ok(read_inventory(&api, query).await?.0)
}

pub async fn fetch_frame_payloads(
    profile: &IOProfile,
    frame_id: u32,
    is_extended: Option<bool>,
    limit: u32,
) -> Result<Vec<Vec<u8>>, String> {
    let filter = FrameFilter {
        frame_id,
        is_extended,
        start_time: None,
        end_time: None,
        protocol: None,
    };
    resolve(profile)?
        .db()
        .payloads(filter, limit)
        .await
        .map_err(text)
}

// ---------------------------------------------------------------------------
// Capture import — push a local SQLite capture to the backend
// ---------------------------------------------------------------------------

use wiretap_protocol::{can::CanFrame, import};

const IMPORT_PAGE: usize = 50_000;

#[derive(Serialize, Clone)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "CaptureUploadProgress"))]
pub(crate) struct ImportProgress {
    capture_id: String,
    sent: usize,
    total: usize,
    done: bool,
}

// ---------------------------------------------------------------------------
// Events — the archive's annotations, one per database
// ---------------------------------------------------------------------------

impl From<wiretap_gateway::Event> for CaptureEvent {
    fn from(e: wiretap_gateway::Event) -> Self {
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

pub async fn events_list(
    app: &tauri::AppHandle,
    profile_id: &str,
) -> Result<Vec<CaptureEvent>, String> {
    let events = resolve_by_id(app, profile_id)
        .await?
        .db()
        .events_list()
        .await
        .map_err(text)?;
    Ok(events.into_iter().map(Into::into).collect())
}

pub async fn events_add(
    app: &tauri::AppHandle,
    profile_id: &str,
    timestamp_us: i64,
    duration_us: i64,
    note: &str,
) -> Result<CaptureEvent, String> {
    let api = resolve_by_id(app, profile_id).await?;
    let event = NewEvent {
        ts_us: timestamp_us,
        duration_us,
        note: note.to_string(),
    };
    api.db()
        .events_add(&event)
        .await
        .map(Into::into)
        .map_err(text)
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
    let patch = EventPatch {
        ts_us: Some(timestamp_us),
        duration_us: Some(duration_us),
        note: Some(note.to_string()),
    };
    api.db()
        .events_update(event_id(id)?, &patch)
        .await
        .map(Into::into)
        .map_err(text)
}

fn event_id(id: &str) -> Result<i64, String> {
    id.parse().map_err(|_| format!("invalid event id '{id}'"))
}

pub async fn events_delete(app: &tauri::AppHandle, profile_id: &str, id: &str) -> Result<(), String> {
    let api = resolve_by_id(app, profile_id).await?;
    api.db().events_delete(event_id(id)?).await.map_err(text)
}

/// The import format carries CAN records only, so anything else would land in the archive as CAN.
fn ensure_only_can(capture_id: &str) -> Result<(), String> {
    use crate::capture_store::{get_capture_kind, CaptureKind};
    let others = match get_capture_kind(capture_id) {
        Some(CaptureKind::Frames) => crate::capture_db::non_can_protocols(capture_id)?,
        Some(CaptureKind::Bytes) => vec!["raw bytes".into()],
        None => return Err(format!("Capture not found: {capture_id}")),
    };
    if others.is_empty() {
        return Ok(());
    }
    Err(format!("Only CAN frames can be sent to a backend; this capture holds {}", others.join(", ")))
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

    let profile = saved_profile(&app, &profile_id).await?;
    import_capture_to(&profile, &capture_id, &database, create, |progress| {
        let _ = app.emit("capture-upload-progress", progress);
    })
    .await
}

/// Upload a capture to the backend a WireTAP profile names.
pub(crate) async fn import_capture_to(
    profile: &IOProfile,
    capture_id: &str,
    database: &str,
    create: bool,
    progress: impl Fn(ImportProgress),
) -> Result<u64, String> {
    if profile.kind != "wiretap" {
        return Err("Target profile is not a WireTAP backend profile".into());
    }
    import_capture(&resolve(profile)?, capture_id, database, create, progress).await
}

async fn import_capture(
    api: &ApiProfile,
    capture_id: &str,
    database: &str,
    create: bool,
    progress: impl Fn(ImportProgress),
) -> Result<u64, String> {
    if !wiretap_protocol::ingest::valid_database_name(database) {
        return Err(format!("invalid database name '{database}'"));
    }
    ensure_only_can(capture_id)?;
    if create {
        // The import's own `?create=true` stays the fallback for a key that may not create.
        let _ = api.client.create_database(database).await;
    }
    let db = api.client.db(database, Protocol::Can);

    let mut offset = 0usize;
    let mut total = usize::MAX;
    let mut imported_total: u64 = 0;
    let mut first = true;

    while offset < total {
        let (frames, _indices, count) =
            crate::capture_store::get_capture_frames_paginated(capture_id, offset, IMPORT_PAGE)?;
        total = count;
        if frames.is_empty() {
            break;
        }
        let imported = db
            .import(import_body(&frames), first && create)
            .await
            .map_err(|e| match e {
                ClientError::Transport(cause) => format!("import request failed: {cause}"),
                e => e.to_string(),
            })?;
        imported_total += imported.imported;

        offset += frames.len();
        first = false;
        progress(ImportProgress { capture_id: capture_id.to_string(), sent: offset, total, done: false });
    }

    progress(ImportProgress { capture_id: capture_id.to_string(), sent: offset, total: offset, done: true });
    Ok(imported_total)
}

// ---------------------------------------------------------------------------
// Database management (tauri commands used by the profile editor)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ApiDatabase {
    pub name: String,
    pub size_bytes: i64,
}

pub(crate) async fn resolve_by_id(app: &tauri::AppHandle, profile_id: &str) -> Result<ApiProfile, String> {
    resolve(&saved_profile(app, profile_id).await?)
}

async fn saved_profile(app: &tauri::AppHandle, profile_id: &str) -> Result<IOProfile, String> {
    let settings = crate::settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {e}"))?;
    settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| format!("Profile not found: {profile_id}"))
}

/// List capture databases on the backend (for the profile editor's picker).
#[tauri::command]
pub async fn api_list_databases(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<Vec<ApiDatabase>, String> {
    list_databases(&resolve_by_id(&app, &profile_id).await?.client).await
}

async fn list_databases(client: &GatewayClient) -> Result<Vec<ApiDatabase>, String> {
    let list = client.databases().await.map_err(text)?;
    Ok(list
        .databases
        .into_iter()
        .map(|d| ApiDatabase {
            name: d.name,
            size_bytes: d.size_bytes,
        })
        .collect())
}

/// Health/connectivity probe for the profile editor ("Test connection").
#[tauri::command]
pub async fn api_test_connection(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<bool, String> {
    match resolve_by_id(&app, &profile_id)
        .await?
        .client
        .health()
        .await
    {
        Ok(_) | Err(ClientError::Decode(_)) => Ok(true),
        Err(ClientError::Status { .. }) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
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
#[derive(Serialize)]
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
    probe(&url, editor_api_key(&app, api_key, profile_id)).await
}

/// Health is asked first, so a gateway that is down says so before the key is looked up.
async fn probe(
    url: &str,
    api_key: impl std::future::Future<Output = Result<String, String>>,
) -> Result<BackendProbe, String> {
    let health = gateway()
        .with_endpoint(url, "")
        .health()
        .await
        .map_err(text)?;
    let client = gateway().with_endpoint(url, &api_key.await?);
    let (databases, databases_error) = match list_databases(&client).await {
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
    let key = editor_api_key(&app, api_key, profile_id).await?;
    let client = gateway().with_endpoint(&url, &key);
    let can = client
        .db(&database, Protocol::Can)
        .time_bounds()
        .await
        .map_err(text)?;
    let modbus = client
        .db(&database, Protocol::Modbus)
        .time_bounds()
        .await
        .map_err(text)?;
    let mut out = Vec::new();
    if can.min_ts_us.is_some() {
        out.push(Protocol::Can);
    }
    if modbus.min_ts_us.is_some() && modbus != can {
        out.push(Protocol::Modbus);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn conn(pairs: &[(&str, Value)]) -> HashMap<String, ConnValue> {
        pairs.iter().map(|(k, v)| (k.to_string(), serde_json::from_value(v.clone()).unwrap())).collect()
    }

    #[test]
    fn can_is_the_unsaid_default_modbus_is_named_and_serial_is_refused() {
        assert_eq!(archive_protocol(&conn(&[])).unwrap(), Protocol::Can);
        assert_eq!(archive_protocol(&conn(&[("protocol", json!("can"))])).unwrap(), Protocol::Can);
        assert_eq!(archive_protocol(&conn(&[("protocol", json!("modbus"))])).unwrap(), Protocol::Modbus);
        assert!(archive_protocol(&conn(&[("protocol", json!("modbsu"))])).is_err());
        let serial = archive_protocol(&conn(&[("protocol", json!("serial"))])).unwrap_err();
        assert!(serial.contains("serial"), "{serial}");

        assert_eq!(frame_tag(Protocol::Can), "can");
        assert_eq!(frame_tag(Protocol::Modbus), "modbus_rtu");
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

    #[test]
    fn only_a_capture_of_can_frames_can_be_uploaded() {
        use crate::capture_store::{append_frames_to_capture, create_standalone_capture, CaptureKind};
        let _db = crate::capture_db::use_own_database();
        let frame = |protocol: &str| crate::io::FrameMessage { protocol: protocol.into(), timestamp_us: 1, ..Default::default() };
        let capture_of = |protocols: &[&str]| {
            let id = create_standalone_capture(CaptureKind::Frames, "upload".into());
            append_frames_to_capture(&id, protocols.iter().map(|p| frame(p)).collect());
            id
        };

        assert_eq!(ensure_only_can(&capture_of(&["can", "can"])), Ok(()));
        let mixed = ensure_only_can(&capture_of(&["can", "modbus", "serial"])).unwrap_err();
        assert!(mixed.contains("modbus") && mixed.contains("serial"), "{mixed}");
        assert!(ensure_only_can(&capture_of(&["modbus_rtu"])).is_err());
        assert!(ensure_only_can(&create_standalone_capture(CaptureKind::Bytes, "bytes".into())).is_err());
    }

    /// A gateway on 127.0.0.1 that answers every request with success and records its request line.
    async fn recording_gateway(
        reply: fn(&str) -> &'static str,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = Vec::new();
                let head_end = loop {
                    let mut chunk = [0u8; 4096];
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let length: usize = head
                    .lines()
                    .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("content-length")))
                    .map_or(0, |(_, v)| v.trim().parse().unwrap());
                while buf.len() < head_end + length {
                    let mut chunk = [0u8; 4096];
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let line = head.lines().next().unwrap();
                let request = line.rsplit_once(' ').unwrap().0.to_string();
                let body = reply(&request);
                seen.lock().unwrap().push(request);
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                sock.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (base_url, requests)
    }

    const IMPORTED: &str = r#"{"created":"x","imported":1,"elapsed_ms":0}"#;

    #[tokio::test]
    async fn a_gateway_that_names_no_schema_still_probes_and_lists() {
        let (base_url, requests) = recording_gateway(|request| match request {
            "GET /v1/databases" => r#"{"databases":[{"name":"site","size_bytes":5}]}"#,
            _ => "{}",
        })
        .await;
        let probed = probe(&base_url, async { Ok("key".to_string()) })
            .await
            .unwrap();
        assert_eq!(
            (
                probed.version.as_str(),
                probed.status.as_str(),
                probed.db_ok
            ),
            ("", "", false)
        );
        assert_eq!(probed.databases_error, None);
        assert_eq!(
            probed
                .databases
                .iter()
                .map(|d| (d.name.as_str(), d.size_bytes))
                .collect::<Vec<_>>(),
            [("site", 5)]
        );
        assert_eq!(
            *requests.lock().unwrap(),
            ["GET /v1/health", "GET /v1/databases"]
        );
    }

    #[tokio::test]
    async fn a_new_database_is_created_only_for_a_capture_that_can_be_sent() {
        use crate::capture_store::{append_frames_to_capture, create_standalone_capture, CaptureKind};
        crate::capture_db::use_in_memory_database();
        let capture_of = |protocol: &str| {
            let id = create_standalone_capture(CaptureKind::Frames, "upload".into());
            let frame = crate::io::FrameMessage { protocol: protocol.into(), timestamp_us: 1, ..Default::default() };
            append_frames_to_capture(&id, vec![frame]);
            id
        };
        let (base_url, requests) = recording_gateway(|_| IMPORTED).await;
        let gateway = ApiProfile::new("p", &base_url, String::new(), "db".into(), Protocol::Can);

        assert!(import_capture(&gateway, &capture_of("modbus"), "fresh", true, |_| {}).await.is_err());
        assert!(requests.lock().unwrap().is_empty(), "{:?}", requests.lock().unwrap());

        import_capture(&gateway, &capture_of("can"), "fresh", true, |_| {}).await.unwrap();
        assert_eq!(*requests.lock().unwrap(), ["POST /v1/databases", "POST /v1/db/fresh/import?create=true"]);
    }

    #[tokio::test]
    async fn only_a_wiretap_profile_is_uploaded_to_with_its_inline_key() {
        use crate::capture_store::{append_frames_to_capture, create_standalone_capture, CaptureKind};
        crate::capture_db::use_in_memory_database();
        let capture_id = create_standalone_capture(CaptureKind::Frames, "upload".into());
        let frame = crate::io::FrameMessage { protocol: "can".into(), timestamp_us: 1, ..Default::default() };
        append_frames_to_capture(&capture_id, vec![frame]);
        let (base_url, requests) = recording_gateway(|_| IMPORTED).await;
        let profile = |kind: &str| IOProfile {
            id: "upload-target".into(),
            kind: kind.into(),
            connection: [("url".to_string(), format!("{base_url}/").into()), ("api_key".to_string(), "inline".into())]
                .into(),
            ..Default::default()
        };
        let finished = std::sync::Mutex::new(Vec::new());
        let progress = |p: ImportProgress| finished.lock().unwrap().push((p.sent, p.total, p.done));

        let refused = import_capture_to(&profile("mqtt"), &capture_id, "archive", false, progress).await;
        assert_eq!(refused, Err("Target profile is not a WireTAP backend profile".into()));
        assert!(requests.lock().unwrap().is_empty());

        let imported = import_capture_to(&profile("wiretap"), &capture_id, "archive", false, progress).await;
        assert_eq!(imported, Ok(1));
        assert_eq!(*requests.lock().unwrap(), ["POST /v1/db/archive/import"]);
        assert_eq!(*finished.lock().unwrap(), [(1, 1, false), (1, 1, true)]);
    }
}
