// crates/wiretap-app/src/gateway_admin.rs
//
// Catalogue assignment over a WireTAP Backend profile's gateway: which catalogue
// each daemon's device is assigned and which it is running, and assigning or
// clearing one from the local decoder library.

use std::collections::HashMap;
use std::path::Path;

use reqwest::StatusCode;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use wiretap_gateway::{
    ActiveCatalog, AssignCatalog, AssignedCatalog, AssignmentConflict, CatalogFinding,
    CatalogRejected, Daemon, DaemonDevice, DaemonList, Provenance, ProvenanceBase, StoredCatalog,
    UnassignParams,
};

use crate::apiclient::{describe, http, resolve_by_id, send, urlencoding, Endpoint};
use crate::catalog_share::registry::{
    git_blob_sha, git_blob_sha_of_file, CatalogEntry, CatalogSourceRegistry, LocalState,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct GatewayDaemon {
    pub daemon_id: String,
    pub devices: Vec<GatewayDevice>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct GatewayDevice {
    pub interface: String,
    pub assigned: Option<CatalogueRef>,
    /// `None`: the daemon has not reported what it runs.
    pub active: Option<ActiveCatalogue>,
    pub status: AssignmentStatus,
}

/// A catalogue by its git blob SHA, named by the gateway or else by the local
/// library file with the same bytes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CatalogueRef {
    pub blob_sha: String,
    pub name: Option<String>,
    pub local_filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ActiveCatalogue {
    /// `assigned`, `local` or `none`.
    pub source: String,
    pub catalogue: Option<CatalogueRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum AssignmentStatus {
    Unassigned,
    Applied,
    /// The daemon has not yet taken up the change, or has not reported since.
    Pending,
    Refused { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum AssignmentOutcome {
    Done { warnings: Vec<CatalogueFinding> },
    Rejected { error: String, findings: Vec<CatalogueFinding> },
    /// Someone else changed the assignment since it was read.
    Conflict { current: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CatalogueFinding {
    pub field: String,
    pub message: String,
}

impl From<CatalogFinding> for CatalogueFinding {
    fn from(f: CatalogFinding) -> Self {
        Self { field: f.field, message: f.message }
    }
}

fn findings(list: Vec<CatalogFinding>) -> Vec<CatalogueFinding> {
    list.into_iter().map(Into::into).collect()
}

struct LibraryEntry {
    filename: String,
    name: String,
}

/// The local decoder library keyed by blob SHA.
type Library = HashMap<String, LibraryEntry>;

fn catalogue_ref(blob_sha: &str, gateway_name: Option<String>, library: &Library) -> CatalogueRef {
    let local = library.get(blob_sha);
    CatalogueRef {
        blob_sha: blob_sha.to_string(),
        name: gateway_name.or_else(|| local.map(|l| l.name.clone())),
        local_filename: local.map(|l| l.filename.clone()),
    }
}

fn status(assigned: Option<&str>, active: Option<&ActiveCatalog>) -> AssignmentStatus {
    let running_assigned = active
        .filter(|a| a.source == "assigned")
        .and_then(|a| a.blob_sha.as_deref());
    match assigned {
        None if running_assigned.is_some() => AssignmentStatus::Pending,
        None => AssignmentStatus::Unassigned,
        Some(sha) if running_assigned == Some(sha) => AssignmentStatus::Applied,
        Some(sha) => match active.and_then(|a| a.refused.as_ref()).filter(|r| r.blob_sha == sha) {
            Some(refused) => AssignmentStatus::Refused { reason: refused.reason.clone() },
            None => AssignmentStatus::Pending,
        },
    }
}

fn device_view(d: DaemonDevice, library: &Library) -> GatewayDevice {
    let status = status(d.assignment.as_ref().map(|a| a.blob_sha.as_str()), d.active.as_ref());
    GatewayDevice {
        assigned: d.assignment.map(|a| catalogue_ref(&a.blob_sha, a.name, library)),
        active: d.active.map(|a| ActiveCatalogue {
            catalogue: a.blob_sha.as_deref().map(|sha| catalogue_ref(sha, a.name, library)),
            source: a.source,
        }),
        interface: d.interface,
        status,
    }
}

fn daemon_views(list: DaemonList, library: &Library) -> Vec<GatewayDaemon> {
    list.daemons
        .into_iter()
        .map(|Daemon { daemon_id, devices }| GatewayDaemon {
            daemon_id,
            devices: devices.into_iter().map(|d| device_view(d, library)).collect(),
        })
        .collect()
}

/// A shared catalogue that matches what it was last synced with names its
/// repository and blob; one with local edits names what it was based on.
fn provenance(tracked: &[(&CatalogEntry, String)], blob_sha: &str) -> Provenance {
    if let Some((entry, repo)) =
        tracked.iter().find(|(e, _)| e.local_state_of(Some(blob_sha)) == LocalState::Committed)
    {
        return Provenance {
            repo: Some(repo.clone()),
            path: Some(entry.remote_path.clone()),
            blob_sha: Some(blob_sha.to_string()),
            git_ref: Some(entry.git_ref.clone()),
            ..Provenance::default()
        };
    }
    let Some((entry, repo)) = tracked.first() else { return Provenance::default() };
    Provenance {
        based_on: Some(ProvenanceBase {
            repo: Some(repo.clone()),
            path: Some(entry.remote_path.clone()),
            blob_sha: Some(entry.synced_sha.clone()).filter(|s| !s.is_empty()),
        }),
        ..Provenance::default()
    }
}

/// The request for a library file: its bytes as they are on disk, CRLF and all.
fn assign_request(
    daemon_id: String,
    interface: String,
    bytes: Vec<u8>,
    tracked: &[(&CatalogEntry, String)],
    expected: Option<String>,
) -> Result<AssignCatalog, String> {
    let blob_sha = git_blob_sha(&bytes);
    let content =
        String::from_utf8(bytes).map_err(|_| "the catalogue is not UTF-8 text".to_string())?;
    Ok(AssignCatalog {
        daemon_id,
        interface,
        content,
        provenance: provenance(tracked, &blob_sha),
        expected,
    })
}

async fn list_daemons(ep: &Endpoint) -> Result<DaemonList, String> {
    send(http().get(format!("{}/v1/admin/daemons", ep.base_url)).bearer_auth(&ep.api_key)).await
}

async fn fetch_catalogue(ep: &Endpoint, blob_sha: &str) -> Result<StoredCatalog, String> {
    let url = format!("{}/v1/admin/catalogs/{}", ep.base_url, urlencoding(blob_sha));
    send(http().get(url).bearer_auth(&ep.api_key)).await
}

async fn put_assignment(ep: &Endpoint, body: &AssignCatalog) -> Result<AssignmentOutcome, String> {
    let url = format!("{}/v1/admin/assignments", ep.base_url);
    outcome(request(http().put(url).bearer_auth(&ep.api_key).json(body)).await?).await
}

async fn delete_assignment(ep: &Endpoint, params: &UnassignParams) -> Result<AssignmentOutcome, String> {
    let mut url = format!(
        "{}/v1/admin/assignments?daemon_id={}&interface={}",
        ep.base_url,
        urlencoding(&params.daemon_id),
        urlencoding(&params.interface)
    );
    if let Some(expected) = &params.expected {
        url.push_str(&format!("&expected={}", urlencoding(expected)));
    }
    let resp = request(http().delete(url).bearer_auth(&ep.api_key)).await?;
    // A gateway before the change to an idempotent DELETE answers 404 when nothing is assigned.
    if resp.status() == StatusCode::NOT_FOUND {
        return Ok(AssignmentOutcome::Done { warnings: Vec::new() });
    }
    outcome(resp).await
}

async fn request(req: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    req.send().await.map_err(|e| format!("API request failed: {}", describe(&e)))
}

/// A 200 with no body is a `DELETE`'s 204; any other answer the admin API does
/// not define comes back as its `error` text.
async fn outcome(resp: reqwest::Response) -> Result<AssignmentOutcome, String> {
    let status = resp.status();
    let body = resp.bytes().await.map_err(|e| format!("API response failed: {}", describe(&e)))?;
    match status {
        StatusCode::CONFLICT => {
            if let Ok(c) = serde_json::from_slice::<AssignmentConflict>(&body) {
                return Ok(AssignmentOutcome::Conflict { current: c.current });
            }
        }
        StatusCode::BAD_REQUEST => {
            if let Ok(r) = serde_json::from_slice::<CatalogRejected>(&body) {
                return Ok(AssignmentOutcome::Rejected { error: r.error, findings: findings(r.findings) });
            }
        }
        s if s.is_success() && body.is_empty() => {
            return Ok(AssignmentOutcome::Done { warnings: Vec::new() });
        }
        s if s.is_success() => {
            return serde_json::from_slice::<AssignedCatalog>(&body)
                .map(|a| AssignmentOutcome::Done { warnings: findings(a.warnings) })
                .map_err(|e| format!("API response decode failed: {e}"));
        }
        _ => {}
    }
    Err(serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or_else(|| format!("HTTP {status}")))
}

async fn endpoint(app: &AppHandle, profile_id: &str) -> Result<Endpoint, String> {
    Ok(resolve_by_id(app, profile_id).await?.endpoint())
}

async fn read_library(app: &AppHandle) -> Library {
    let files = crate::catalog::list_catalogs(app.clone()).await.unwrap_or_default();
    files
        .into_iter()
        .filter_map(|f| {
            let sha = git_blob_sha_of_file(Path::new(&f.path))?;
            Some((sha, LibraryEntry { filename: f.filename, name: f.name }))
        })
        .collect()
}

fn library_file(app: &AppHandle, filename: &str) -> Result<(String, Vec<u8>), String> {
    let filename = crate::catalog::reject_unsafe_filename(filename)?.to_string();
    let dir = crate::catalog::decoder_dir(app).ok_or("No decoder directory is set")?;
    let bytes = std::fs::read(dir.join(&filename))
        .map_err(|e| format!("Failed to read {filename}: {e}"))?;
    Ok((filename, bytes))
}

#[tauri::command]
pub async fn gateway_list_daemons(app: AppHandle, profile_id: String) -> Result<Vec<GatewayDaemon>, String> {
    let list = list_daemons(&endpoint(&app, &profile_id).await?).await?;
    Ok(daemon_views(list, &read_library(&app).await))
}

/// `expected` is the SHA the dialog showed as assigned, `""` for none.
#[tauri::command]
pub async fn gateway_assign_catalogue(
    app: AppHandle,
    profile_id: String,
    daemon_id: String,
    interface: String,
    filename: String,
    expected: String,
) -> Result<AssignmentOutcome, String> {
    let ep = endpoint(&app, &profile_id).await?;
    let (filename, bytes) = library_file(&app, &filename)?;
    let body = app.state::<CatalogSourceRegistry>().read(&app, |r| {
        let tracked: Vec<_> = r
            .catalogs_for_file(&filename)
            .map(|e| (e, r.repo(&e.repo_id).map_or_else(|| e.repo_id.clone(), |repo| repo.repo_url())))
            .collect();
        assign_request(daemon_id, interface, bytes, &tracked, Some(expected))
    })?;
    put_assignment(&ep, &body).await
}

#[tauri::command]
pub async fn gateway_clear_assignment(
    app: AppHandle,
    profile_id: String,
    daemon_id: String,
    interface: String,
    expected: String,
) -> Result<AssignmentOutcome, String> {
    let ep = endpoint(&app, &profile_id).await?;
    delete_assignment(&ep, &UnassignParams { daemon_id, interface, expected: Some(expected) }).await
}

/// Copy a catalogue the gateway stores into the decoder library, returning its path.
#[tauri::command]
pub async fn gateway_copy_catalogue(
    app: AppHandle,
    profile_id: String,
    blob_sha: String,
    name: Option<String>,
) -> Result<String, String> {
    let stored = fetch_catalogue(&endpoint(&app, &profile_id).await?, &blob_sha).await?;
    let filename = copy_filename(&stored, name.as_deref());
    crate::catalog::import_catalog(app, filename, stored.content).await
}

fn copy_filename(stored: &StoredCatalog, gateway_name: Option<&str>) -> String {
    let safe = |n: &&str| !n.is_empty() && !n.contains(['/', '\\']) && !n.starts_with('.');
    stored
        .provenance
        .path
        .as_deref()
        .and_then(|p| p.rsplit('/').next())
        .filter(safe)
        .map(String::from)
        .or_else(|| gateway_name.filter(safe).map(|n| format!("{n}.toml")))
        .unwrap_or_else(|| format!("{}.toml", &stored.blob_sha[..stored.blob_sha.len().min(12)]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use wiretap_gateway::RefusedCatalog;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[derive(Debug)]
    struct Request {
        method: String,
        target: String,
        authorisation: Option<String>,
        body: Vec<u8>,
    }

    /// A one-request HTTP server on 127.0.0.1 answering `status` with `body`.
    async fn mock(status: u16, body: &str) -> (Endpoint, tokio::task::JoinHandle<Request>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ep = Endpoint {
            base_url: format!("http://{}", listener.local_addr().unwrap()),
            api_key: "admin-key".into(),
        };
        let body = body.to_string();
        let served = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
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
            let header = |name: &str| {
                head.lines()
                    .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)))
                    .map(|(_, v)| v.trim().to_string())
            };
            let length: usize = header("content-length").map_or(0, |v| v.parse().unwrap());
            while buf.len() < head_end + length {
                let mut chunk = [0u8; 4096];
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
            }
            let mut start = head.lines().next().unwrap().split(' ');
            let request = Request {
                method: start.next().unwrap().to_string(),
                target: start.next().unwrap().to_string(),
                authorisation: header("authorization"),
                body: buf[head_end..head_end + length].to_vec(),
            };
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(reply.as_bytes()).await.unwrap();
            request
        });
        (ep, served)
    }

    fn sent(request: &Request) -> Value {
        serde_json::from_slice(&request.body).unwrap()
    }

    fn active(source: &str, sha: Option<&str>, refused: Option<(&str, &str)>) -> ActiveCatalog {
        ActiveCatalog {
            source: source.into(),
            blob_sha: sha.map(String::from),
            name: None,
            since_us: 0,
            refused: refused.map(|(blob_sha, reason)| RefusedCatalog { blob_sha: blob_sha.into(), reason: reason.into() }),
        }
    }

    fn library() -> Library {
        Library::from([(B.to_string(), LibraryEntry { filename: "site.toml".into(), name: "Site".into() })])
    }

    fn entry(synced_sha: &str) -> CatalogEntry {
        let mut e = CatalogEntry::new("gh:o/r", "cats/site.toml", "main", "site.toml");
        e.mark_exchanged(synced_sha.into());
        e
    }

    #[test]
    fn status_follows_the_assignment_against_what_the_daemon_runs() {
        use AssignmentStatus::*;
        assert_eq!(status(None, None), Unassigned);
        assert_eq!(status(None, Some(&active("local", Some(B), None))), Unassigned);
        assert_eq!(status(None, Some(&active("assigned", Some(A), None))), Pending);
        assert_eq!(status(Some(A), None), Pending);
        assert_eq!(status(Some(A), Some(&active("assigned", Some(A), None))), Applied);
        assert_eq!(status(Some(A), Some(&active("local", Some(A), None))), Pending);
        assert_eq!(status(Some(A), Some(&active("local", Some(B), None))), Pending);
        assert_eq!(
            status(Some(A), Some(&active("local", Some(B), Some((A, "did_not_parse"))))),
            Refused { reason: "did_not_parse".into() }
        );
        assert_eq!(status(Some(A), Some(&active("assigned", Some(B), Some((B, "hash_mismatch"))))), Pending);
    }

    #[tokio::test]
    async fn the_daemon_list_names_a_local_catalogue_from_the_library() {
        let body = json!({ "daemons": [{ "daemon_id": "debian", "devices": [
            { "interface": "/dev/ttyUSB0", "bus": 1, "database": "site", "last_seen_us": 5,
              "assignment": { "blob_sha": A, "name": "Gateway", "assigned_at_us": 1,
                              "assigned_by": "alex", "provenance": {} },
              "active": { "source": "local", "blob_sha": B, "name": null, "since_us": 2, "refused": null } },
            { "interface": "can0", "bus": null, "database": null, "last_seen_us": null,
              "assignment": null, "active": null },
        ]}]});
        let (ep, served) = mock(200, &body.to_string()).await;
        let views = daemon_views(list_daemons(&ep).await.unwrap(), &library());
        let request = served.await.unwrap();
        assert_eq!((request.method.as_str(), request.target.as_str()), ("GET", "/v1/admin/daemons"));
        assert_eq!(request.authorisation.as_deref(), Some("Bearer admin-key"));

        let [usb, can] = &views[0].devices[..] else { panic!("{views:?}") };
        assert_eq!(views[0].daemon_id, "debian");
        assert_eq!(
            usb.assigned,
            Some(CatalogueRef { blob_sha: A.into(), name: Some("Gateway".into()), local_filename: None })
        );
        assert_eq!(
            usb.active,
            Some(ActiveCatalogue {
                source: "local".into(),
                catalogue: Some(CatalogueRef {
                    blob_sha: B.into(),
                    name: Some("Site".into()),
                    local_filename: Some("site.toml".into()),
                }),
            })
        );
        assert_eq!(usb.status, AssignmentStatus::Pending);
        assert_eq!((&can.active, &can.status), (&None, &AssignmentStatus::Unassigned));
    }

    #[tokio::test]
    async fn assign_sends_the_exact_bytes_and_the_expected_guard() {
        let bytes = b"[meta]\r\nname = \"Site\"\r\n".to_vec();
        let sha = git_blob_sha(&bytes);
        let request = assign_request("debian".into(), "/dev/ttyUSB0".into(), bytes.clone(), &[], Some(String::new()))
            .unwrap();
        let answer = json!({
            "daemon_id": "debian", "interface": "/dev/ttyUSB0",
            "assignment": { "blob_sha": sha, "name": "Site", "assigned_at_us": 1, "assigned_by": null, "provenance": {} },
            "warnings": [{ "field": "frame.0x100", "message": "no signals" }],
        });
        let (ep, served) = mock(200, &answer.to_string()).await;
        let outcome = put_assignment(&ep, &request).await.unwrap();
        let sent_request = served.await.unwrap();

        assert_eq!((sent_request.method.as_str(), sent_request.target.as_str()), ("PUT", "/v1/admin/assignments"));
        let body = sent(&sent_request);
        assert_eq!(body["content"].as_str().unwrap().as_bytes(), bytes);
        assert_eq!(body["expected"], "");
        assert_eq!(body["provenance"], json!({}));
        assert_eq!(
            outcome,
            AssignmentOutcome::Done {
                warnings: vec![CatalogueFinding { field: "frame.0x100".into(), message: "no signals".into() }]
            }
        );
    }

    #[test]
    fn a_catalogue_that_is_not_utf8_is_refused_before_sending() {
        assert!(assign_request("d".into(), "i".into(), vec![0xff, 0xfe], &[], None).is_err());
    }

    #[test]
    fn provenance_names_the_synced_blob_or_what_an_edit_was_based_on() {
        let bytes = b"[meta]\r\nname = \"Site\"\r\n";
        let sha = git_blob_sha(bytes);
        let repo = "https://github.com/o/r".to_string();

        let synced = entry(&sha);
        let committed = provenance(&[(&synced, repo.clone())], &sha);
        assert_eq!(
            serde_json::to_value(&committed).unwrap(),
            json!({ "repo": repo, "path": "cats/site.toml", "blob_sha": sha, "ref": "main" })
        );

        let edited = entry(B);
        assert_eq!(
            serde_json::to_value(provenance(&[(&edited, repo.clone())], &sha)).unwrap(),
            json!({ "based_on": { "repo": repo, "path": "cats/site.toml", "blob_sha": B } })
        );

        assert_eq!(provenance(&[], &sha), Provenance::default());
    }

    #[tokio::test]
    async fn a_conflict_reports_what_is_assigned_now() {
        let (ep, served) =
            mock(409, &json!({ "error": "the assignment changed since it was read", "current": B }).to_string()).await;
        let params = UnassignParams { daemon_id: "debian".into(), interface: "/dev/ttyUSB0".into(), expected: Some(A.into()) };
        let outcome = delete_assignment(&ep, &params).await.unwrap();
        let request = served.await.unwrap();
        assert_eq!(request.method, "DELETE");
        assert_eq!(
            request.target,
            format!("/v1/admin/assignments?daemon_id=debian&interface=%2Fdev%2FttyUSB0&expected={A}")
        );
        assert_eq!(outcome, AssignmentOutcome::Conflict { current: Some(B.into()) });
    }

    #[tokio::test]
    async fn a_rejected_catalogue_carries_its_findings() {
        let body = json!({ "error": "meta.name: missing", "findings": [{ "field": "meta.name", "message": "missing" }] });
        let (ep, _served) = mock(400, &body.to_string()).await;
        let request = assign_request("d".into(), "i".into(), b"x = 1".to_vec(), &[], None).unwrap();
        assert_eq!(
            put_assignment(&ep, &request).await.unwrap(),
            AssignmentOutcome::Rejected {
                error: "meta.name: missing".into(),
                findings: vec![CatalogueFinding { field: "meta.name".into(), message: "missing".into() }],
            }
        );
    }

    #[tokio::test]
    async fn a_clear_of_nothing_is_done_and_other_failures_come_back_as_their_error() {
        let params = UnassignParams { daemon_id: "d".into(), interface: "i".into(), expected: None };
        let (ep, served) = mock(204, "").await;
        assert_eq!(delete_assignment(&ep, &params).await.unwrap(), AssignmentOutcome::Done { warnings: vec![] });
        assert_eq!(served.await.unwrap().target, "/v1/admin/assignments?daemon_id=d&interface=i");

        let (ep, _served) = mock(404, &json!({ "error": "nothing is assigned there" }).to_string()).await;
        assert_eq!(delete_assignment(&ep, &params).await.unwrap(), AssignmentOutcome::Done { warnings: vec![] });

        let (ep, _served) = mock(403, &json!({ "error": "admin role required" }).to_string()).await;
        assert_eq!(list_daemons(&ep).await.unwrap_err(), "admin role required");
    }

    #[test]
    fn a_copied_catalogue_is_named_by_its_path_then_its_name_then_its_hash() {
        let stored = |path: Option<&str>| StoredCatalog {
            blob_sha: A.into(),
            content: String::new(),
            provenance: Provenance { path: path.map(String::from), ..Default::default() },
            created_at_us: 0,
        };
        assert_eq!(copy_filename(&stored(Some("cats/site.toml")), Some("sungrow-rs485")), "site.toml");
        assert_eq!(copy_filename(&stored(None), Some("sungrow-rs485")), "sungrow-rs485.toml");
        assert_eq!(copy_filename(&stored(None), Some("../escape")), format!("{}.toml", &A[..12]));
        assert_eq!(copy_filename(&stored(None), None), format!("{}.toml", &A[..12]));
    }

    #[tokio::test]
    async fn a_stored_catalogue_comes_back_byte_for_byte() {
        let content = "[meta]\r\nname = \"Site\"\r\n";
        let body = json!({ "blob_sha": A, "content": content, "provenance": { "path": "cats/site.toml" }, "created_at_us": 1 });
        let (ep, served) = mock(200, &body.to_string()).await;
        let stored = fetch_catalogue(&ep, A).await.unwrap();
        assert_eq!(served.await.unwrap().target, format!("/v1/admin/catalogs/{A}"));
        assert_eq!(stored.content, content);
    }
}
