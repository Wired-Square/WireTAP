// Copyright 2026 Wired Square Pty Ltd

//! MCP tool definitions. Read tools are always available; control (mutation)
//! tools are only merged into the router when `mcp_allow_control` is on.

use crate::capture_store::{FrameSelection, ProtocolFrames};
use crate::io::FrameMessage;
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use wiretap_io::modbus::{
    ExceptionCode, ModbusTcp, ReadData, ReadRequest, Reading, RequestError, WriteRefused,
};

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CacheScope, CallToolResult};
use rmcp::{ErrorData as McpError, tool, tool_router};
use serde_json::{json, Value};
use wslib_ai_mcp::dom::{self, DomBridge};
use wslib_ai_mcp::result::{internal_error as err, ok_json};
use wslib_ai_mcp::rmcp;
use wslib_ai_mcp::router::{compose, mark_read_only};
use wslib_ai_mcp::server::{ServerIdentity, ToolListCache};

use super::types::*;
use super::McpRunningConfig;
use crate::analysis::PayloadSource;
use crate::payload_source::{resolve, Capture, QuerySource};

/// Counter for generating unique replay IDs without a clock/RNG.
static REPLAY_SEQ: AtomicU64 = AtomicU64::new(1);
static REPEAT_SEQ: AtomicU64 = AtomicU64::new(1);
static TEST_PATTERN_SEQ: AtomicU64 = AtomicU64::new(1);

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct WireTapTools {
    pub(super) app: tauri::AppHandle,
}

/// The tool set only changes with the permission gates, which force a server
/// restart; `Private` because it varies per gate and the endpoint is bearer-gated.
pub(super) const TOOL_LIST_CACHE: ToolListCache = ToolListCache {
    ttl_ms: 300_000,
    scope: CacheScope::Private,
};

impl WireTapTools {
    /// Build the tool router for a set of permission gates. Built once when the
    /// server starts and shared per request. Read-only-ness is a property of
    /// *being in* `read_router`; the write routers annotate per tool, because
    /// destructive/idempotent genuinely differ between them.
    pub fn router(cfg: McpRunningConfig) -> ToolRouter<WireTapTools> {
        let mut router = Self::read_router();
        mark_read_only(&mut router);
        compose(
            router + dom::read_router(),
            [
                cfg.control.then(Self::control_router),
                cfg.session_control.then(Self::session_control_router),
                cfg.catalog_write.then(Self::catalog_write_router),
                cfg.catalog_modify.then(Self::catalog_modify_router),
                cfg.dashboard_write.then(Self::dashboard_write_router),
                cfg.ui_control.then(Self::ui_control_router),
                cfg.ui_control.then(dom::drive_router),
            ],
        )
    }

    pub(super) fn identity() -> ServerIdentity {
        ServerIdentity::new("wiretap", env!("CARGO_PKG_VERSION"))
            .with_title("WireTAP")
            .with_instructions(
                "WireTAP runtime introspection and control for CAN-bus reverse \
                 engineering and development. Read tools expose live sessions, captures, \
                 frame data, payload analysis and decoded signals. Permission-gated \
                 control tools open/stop sessions, transmit one-shot or repeating frames \
                 (a repeat is mirrored into the Transmit queue as an Agent-badged, \
                 human-controllable row), replay captures, and read/write Modbus. \
                 attach_source surfaces a session in a source-aware tab (discovery, \
                 decoder, transmit, query, or dashboard) so the human sees what the agent is \
                 working on. Every read tool answers with no window open. The DOM tools \
                 need one: query and wait_for read the window, and with UI control click, \
                 type and press drive it without needing focus.",
            )
    }
}

/// Convert an optional RFC3339 time bound to capture-timeline microseconds.
fn us(s: &Option<String>) -> Option<i64> {
    s.as_deref().and_then(crate::payload_source::iso_to_micros)
}

/// Widen an optional row limit to the i64 the capture engines take.
fn lim(l: Option<u32>) -> Option<i64> {
    l.map(|v| v as i64)
}

/// Resolve a catalog filename to an absolute path under the decoder directory.
/// Rejects path separators / traversal and ensures a `.toml` suffix. Returns the
/// path and whether it already exists.
fn resolve_catalog_path(
    app: &tauri::AppHandle,
    filename: &str,
) -> Result<(std::path::PathBuf, bool), McpError> {
    let name = crate::catalog::sanitise_catalog_filename(filename).map_err(err)?;
    let settings = crate::settings::load_settings_sync(app).map_err(err)?;
    let path = std::path::PathBuf::from(&settings.decoder_dir).join(&name);
    let exists = path.exists();
    Ok((path, exists))
}

/// The text a catalogue write saves: `content` as given, or `ops` applied to `base`.
fn catalog_text(
    base: impl FnOnce() -> Result<String, String>,
    content: Option<String>,
    ops: Option<Vec<serde_json::Value>>,
) -> Result<String, String> {
    match (content, ops) {
        (Some(content), None) => Ok(content),
        (None, Some(ops)) => {
            let ops: Vec<wiretap_catalog::edit::EditOp> = ops
                .into_iter()
                .map(serde_json::from_value)
                .collect::<Result<_, _>>()
                .map_err(|e| format!("invalid edit op: {e}"))?;
            wiretap_catalog::edit::apply_edits(&base()?, &ops)
        }
        _ => Err("give either content or ops".to_string()),
    }
}

/// Validate catalog TOML; on findings, return an error embedding them (no write).
fn validate_or_reject(content: &str) -> Result<(), McpError> {
    let findings = wiretap_catalog::validate::validate(content);
    if findings.is_empty() {
        return Ok(());
    }
    let detail = serde_json::to_string(&findings).unwrap_or_default();
    Err(err(format!(
        "Catalog validation failed ({} issue(s)) — not written: {detail}",
        findings.len()
    )))
}

fn modbus_exception_json(rt: &str, address: u16, code: ExceptionCode) -> serde_json::Value {
    json!({"ok":false,"register_type":rt,"address":address,"exception":code.to_string(),"exception_code":code.code()})
}

/// A transport error is the tool's error: it cannot say whether the device saw
/// the request.
fn modbus_read_json(
    rt: &str,
    address: u16,
    count: u16,
    r: Result<Reading, RequestError>,
) -> Result<serde_json::Value, String> {
    match r {
        Ok(reading) => {
            let values = match reading.data {
                ReadData::Registers(v) => json!(v),
                ReadData::Coils(v) => json!(v),
            };
            Ok(json!({"ok":true,"register_type":rt,"address":address,"count":count,"values":values}))
        }
        Err(RequestError::Exception { code, .. }) => Ok(modbus_exception_json(rt, address, code)),
        Err(RequestError::Transport(e)) => Err(format!("Modbus IO error reading {rt} {address}: {e}")),
    }
}

fn modbus_write_json(
    rt: &str,
    address: u16,
    written: impl serde::Serialize,
    r: Result<Result<Duration, RequestError>, WriteRefused>,
) -> Result<serde_json::Value, String> {
    match r {
        Ok(Ok(_)) => Ok(json!({"ok":true,"register_type":rt,"address":address,"written":written})),
        Ok(Err(RequestError::Exception { code, .. })) => Ok(modbus_exception_json(rt, address, code)),
        Ok(Err(RequestError::Transport(e))) => Err(format!("Modbus IO error writing {rt} {address}: {e}")),
        Err(refused) => Ok(json!({"ok":false,"register_type":rt,"address":address,"sent":false,"refused":refused.to_string()})),
    }
}

fn modbus_endpoint_of(
    app: &tauri::AppHandle,
    profile_id: &str,
) -> Result<(String, u16, u8), McpError> {
    let profile = crate::settings::profile_by_id(app, profile_id).map_err(err)?;
    Ok(crate::io::modbus_endpoint(&profile))
}

/// The session's Modbus source profile, which names its device and keys its poll.
fn session_modbus_profile(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<crate::settings::IOProfile, McpError> {
    let settings = crate::settings::load_settings_sync(app).map_err(err)?;
    crate::io::modbus_tcp::session_modbus_profile(&settings, session_id)
        .cloned()
        .ok_or_else(|| err(format!("Session '{session_id}' has no Modbus source profile")))
}

fn transient_connection(profile: &crate::settings::IOProfile) -> ModbusTcp {
    let (host, port, unit_id) = crate::io::modbus_endpoint(profile);
    crate::io::modbus_tcp::poll::device_connection(&host, port, unit_id)
}

// ── Modbus discovery helpers ─────────────────────────────────────────────────

impl WireTapTools {
    /// Resolve a scan target from either a profile or explicit address fields.
    /// Explicit values win, so a profile can be used as a starting point and
    /// then overridden — useful when probing a second slave behind one gateway.
    fn resolve_modbus_target(
        &self,
        t: &ModbusTargetParams,
    ) -> Result<(String, u16, u8), McpError> {
        let base = match &t.profile_id {
            Some(id) => modbus_endpoint_of(&self.app, id)?,
            None => ("127.0.0.1".to_string(), 502, 1),
        };
        if t.profile_id.is_none() && t.host.is_none() {
            return Err(err(
                "Give either profile_id or host — there is nothing to connect to",
            ));
        }
        Ok((
            t.host.clone().unwrap_or(base.0),
            t.port.unwrap_or(base.1),
            t.unit_id.unwrap_or(base.2),
        ))
    }

    /// Create, start and (optionally) await a scan session, then summarise it.
    ///
    /// The session is created stopped and started here deliberately: headless
    /// there is no subscriber to race, whereas the UI must subscribe first (see
    /// `create_modbus_scan_session`).
    async fn run_scan_session(
        &self,
        job: crate::io::ScanJob,
        session_id: Option<String>,
        wait: bool,
        max_wait_ms: u64,
    ) -> Result<CallToolResult, McpError> {
        let sid = match session_id {
            Some(sid) => sid,
            None => crate::sessions::mint_session_id(crate::sessions::MODBUS_SCAN_SESSION_PREFIX).await,
        };

        crate::sessions::create_modbus_scan_session(
            self.app.clone(),
            sid.clone(),
            job,
            None,
            Some(super::session::subscriber_for(&sid)),
            Some("mcp".to_string()),
            // An agent sweeping a device that something else is polling may well be
            // doing so deliberately, and it has no parameter to override a refusal with.
            Some(true),
        )
        .await
        .map_err(err)?;
        super::session::spawn_keepalive(sid.clone());

        if let Err(e) = crate::io::start_session(&sid).await {
            let _ = crate::io::destroy_session(&sid, false).await;
            return Err(err(e));
        }

        let capture_id = || async {
            crate::io::session_info(&sid)
                .await
                .and_then(|s| s.capture_id)
        };

        if !wait {
            return ok_json(json!({
                "session_id": sid,
                "capture_id": capture_id().await,
                "status": "scanning",
                "next": "poll get_modbus_scan_progress, then read rows with get_capture_frames",
            }));
        }

        // Wait for the terminal summary, which the sweep parks on completion.
        let result = crate::io::modbus_tcp::scanner::await_scan_result(
            &sid,
            Duration::from_millis(max_wait_ms),
        )
        .await;

        let capture_id = capture_id().await;

        let r = match result {
            Some(Ok(r)) => r,
            Some(Err(e)) => {
                return ok_json(json!({
                    "session_id": sid,
                    "capture_id": capture_id,
                    "status": "error",
                    "error": e,
                }))
            }
            None => {
                return ok_json(json!({
                    "session_id": sid,
                    "capture_id": capture_id,
                    "status": "scanning",
                    "note": format!("still running after {max_wait_ms}ms — poll get_modbus_scan_progress"),
                }))
            }
        };

        // Blocks are already a run-length summary, but a pathologically sparse
        // device could still produce a lot of them. Cap and say so rather than
        // returning an unbounded response.
        const MAX_BLOCKS: usize = 256;
        let blocks_truncated = r.blocks.len() > MAX_BLOCKS;
        let blocks: Vec<_> = r.blocks.iter().take(MAX_BLOCKS).collect();
        let gaps: Vec<_> = r.gaps.iter().take(MAX_BLOCKS).collect();

        ok_json(json!({
            "session_id": sid,
            "capture_id": capture_id,
            "status": if r.truncated { "stopped" } else { "complete" },
            "duration_ms": r.duration_ms,
            "scanned": r.total_scanned,
            "found": r.found_count,
            "requests": r.requests,
            "blocks": blocks,
            "blocks_truncated": blocks_truncated,
            "gaps": gaps,
            "devices": r.devices,
            "notes": r.notes,
            "next_page": capture_id.as_ref().map(|c| format!(
                "get_capture_frames(capture_id='{c}', offset=0, count=200)"
            )),
        }))
    }
}

/// Bounds an unfiltered `get_discovery_analysis` response.
const DISCOVERY_ANALYSIS_MAX_FRAMES: usize = 64;

/// A `"protocol:id"` frame key, as Discovery writes it.
fn parse_frame_key(key: &str) -> Result<(&str, u32), String> {
    key.split_once(':')
        .and_then(|(protocol, id)| Some((protocol, id.parse().ok()?)))
        .filter(|(protocol, _)| !protocol.is_empty())
        .ok_or_else(|| format!("Bad frame key '{key}' — expected protocol:id, e.g. \"can:256\""))
}

/// The frames an MCP analysis reads: the newest `newest`, or the panel's live
/// window, Discovery's default history buffer.
fn analysis_window(newest: Option<usize>) -> usize {
    newest.unwrap_or(crate::settings::default_discovery_history_buffer() as usize)
}

fn frame_key_groups(keys: Option<Vec<String>>) -> Result<Vec<ProtocolFrames>, String> {
    keys.unwrap_or_default()
        .iter()
        .map(|key| parse_frame_key(key).map(|(protocol, id)| ProtocolFrames::ids(protocol, vec![id])))
        .collect()
}

/// The session's frame capture, which the live tools read.
fn session_frame_capture(session_id: &str) -> Result<String, McpError> {
    crate::capture_store::get_session_frame_capture_id(session_id).ok_or_else(|| {
        err(format!(
            "Session '{session_id}' has no frame capture — use list_sessions, or list_captures and the capture tools"
        ))
    })
}

/// How many of a capture's newest frames `get_decoded_signals` decodes: every
/// mux case of a frame at 5 kfps over 200 ms.
const DECODED_TAIL_FRAMES: usize = 1000;

/// A `get_decoded_signals` frame filter: a masked decimal id, bare or as a frame key.
fn masked_id_of(filter: &str) -> Result<u32, String> {
    filter
        .rsplit(':')
        .next()
        .and_then(|id| id.parse().ok())
        .ok_or_else(|| format!("Bad frame_id '{filter}' — expected a decimal id (\"256\") or frame key (\"can:256\")"))
}

/// Decode a chronological run of frames into one entry per masked frame id,
/// newest last. Signals merge by `muxValue:name`, so an inactive mux case keeps
/// its last value, as the Decoder keeps it.
fn decode_tail(
    catalog: &wiretap_catalog::Catalog,
    frames: &[FrameMessage],
    wanted: Option<u32>,
) -> Vec<Value> {
    let mask = wiretap_catalog::decode::frame_id_mask(catalog).unwrap_or(u32::MAX);
    let mut latest: Vec<(u32, Value)> = Vec::new();
    for f in frames {
        let masked = f.frame_id & mask;
        if wanted.is_some_and(|id| id != masked) {
            continue;
        }
        let Some(entry) = crate::ws::dispatch::decode_entry(catalog, f, None, &[]) else {
            continue;
        };
        let mut entry = serde_json::to_value(entry).expect("a decoded entry serialises");
        let object = entry
            .as_object_mut()
            .expect("decode_entry builds an object");
        object.remove("bytes");
        match latest.iter_mut().find(|(id, _)| *id == masked) {
            Some((_, seen)) => {
                let mut signals = seen["signals"].take();
                merge_signals(
                    signals.as_array_mut().expect("array"),
                    entry["signals"].take(),
                );
                entry["signals"] = signals;
                *seen = entry;
            }
            None => latest.push((masked, entry)),
        }
    }
    latest.into_iter().map(|(_, entry)| entry).collect()
}

fn merge_signals(seen: &mut Vec<Value>, newer: Value) {
    for signal in newer.as_array().into_iter().flatten() {
        match seen
            .iter_mut()
            .find(|s| signal_key(s) == signal_key(signal))
        {
            Some(slot) => *slot = signal.clone(),
            None => seen.push(signal.clone()),
        }
    }
}

fn signal_key(s: &Value) -> (Option<i64>, &str) {
    (
        s["muxValue"].as_i64(),
        s["name"].as_str().unwrap_or_default(),
    )
}

/// The newest frame per `protocol:id` key: its bytes, bus, flags, length and stamp.
fn latest_by_key(
    frames: Vec<FrameMessage>,
    wanted: Option<&HashSet<String>>,
) -> serde_json::Map<String, Value> {
    let mut latest: BTreeMap<String, FrameMessage> = BTreeMap::new();
    for f in frames {
        let key = format!("{}:{}", f.protocol, f.frame_id);
        if wanted.is_some_and(|w| !w.contains(&key)) {
            continue;
        }
        if latest
            .get(&key)
            .is_none_or(|seen| seen.timestamp_us <= f.timestamp_us)
        {
            latest.insert(key, f);
        }
    }
    latest
        .into_iter()
        .map(|(key, f)| {
            let data = json!({
                "bytes": f.bytes,
                "bus": f.bus,
                "is_extended": f.is_extended,
                "is_fd": f.is_fd,
                "is_rtr": f.is_rtr,
                "is_brs": f.is_brs,
                "is_esi": f.is_esi,
                "dlc": f.dlc,
                "timestampUs": f.timestamp_us,
            });
            (key, data)
        })
        .collect()
}

/// Forward a request to the page over the bridge and wrap the result.
async fn bridge_call(method: &str, params: impl serde::Serialize) -> Result<CallToolResult, McpError> {
    let value = serde_json::to_value(params).map_err(|e| err(e.to_string()))?;
    ok_json(super::bridge::request(method, value, BRIDGE_TIMEOUT).await.map_err(err)?)
}

impl DomBridge for WireTapTools {
    async fn call(&self, op: &str, args: serde_json::Value, timeout: Duration) -> Result<serde_json::Value, String> {
        super::bridge::request(&format!("dom.{op}"), args, timeout).await
    }
}

// ── Read tools ───────────────────────────────────────────────────────────────

#[tool_router(router = read_router)]
impl WireTapTools {
    #[tool(description = "List all active IO sessions with state, source type, capture and subscribers.")]
    async fn list_sessions(&self) -> Result<CallToolResult, McpError> {
        ok_json(crate::io::list_sessions().await)
    }

    #[tool(description = "Get full state (lifecycle, capabilities, capture, subscribers) for one session.")]
    async fn get_session_state(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
    ) -> Result<CallToolResult, McpError> {
        let info = crate::io::session_info(&p.session_id)
            .await
            .ok_or_else(|| err(format!("Session '{}' not found", p.session_id)))?;
        ok_json(info)
    }

    #[tool(description = "List all captures (frame/byte recordings) with id, name, kind, count and time range.")]
    async fn list_captures(&self) -> Result<CallToolResult, McpError> {
        ok_json(crate::capture_store::list_captures())
    }

    #[tool(description = "Get the total frame count for a capture.")]
    async fn get_capture_count(
        &self,
        Parameters(p): Parameters<CaptureIdParams>,
    ) -> Result<CallToolResult, McpError> {
        let total = crate::capture_store::get_capture_count(&p.capture_id);
        ok_json(json!({ "capture_id": p.capture_id, "total": total }))
    }

    #[tool(description = "Get a page of frames from a capture (offset + count). Returns frames and the total.")]
    async fn get_capture_frames(
        &self,
        Parameters(p): Parameters<GetFramesParams>,
    ) -> Result<CallToolResult, McpError> {
        let (frames, _idx, total) =
            crate::capture_store::get_capture_frames_paginated(&p.capture_id, p.offset, p.count);
        ok_json(json!({ "total": total, "offset": p.offset, "frames": frames }))
    }

    #[tool(description = "Query frames from a capture, optionally filtered to a single frame id (decimal), and optionally to one protocol.")]
    async fn query_capture_frames(
        &self,
        Parameters(p): Parameters<QueryFramesParams>,
    ) -> Result<CallToolResult, McpError> {
        // Identity is (protocol, frame_id). With no protocol given, match the id under
        // every protocol the capture holds, which is what a bare id used to do.
        let groups = match (p.frame_id, p.protocol) {
            (None, _) => Vec::new(),
            (Some(frame_id), Some(protocol)) => vec![ProtocolFrames::ids(protocol, vec![frame_id])],
            (Some(frame_id), None) => crate::capture_store::get_capture_frame_info(&p.capture_id)
                .into_iter()
                .filter(|info| info.frame_id == frame_id)
                .map(|info| ProtocolFrames::ids(info.protocol, vec![frame_id]))
                .collect(),
        };
        let (frames, _idx, total) = crate::capture_store::get_capture_frames_paginated_filtered(
            &p.capture_id,
            p.offset,
            p.count,
            &FrameSelection::from_groups(groups),
        );
        ok_json(json!({ "total": total, "offset": p.offset, "frames": frames }))
    }

    #[tool(description = "Get the current playback position (timestamp, frame index, frame count) for a session.")]
    async fn get_playback_position(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
    ) -> Result<CallToolResult, McpError> {
        ok_json(crate::io::get_playback_position(&p.session_id))
    }

    #[tool(description = "Get a Test Pattern run's state: status (running, listening, completed, stopped, failed), tx/rx counts, drops, duplicates, out_of_order, latency_us, the peer Hello found, remote counters, sweep rows per length code, and Auto phase results.")]
    async fn test_pattern_state(
        &self,
        Parameters(p): Parameters<TestIdParams>,
    ) -> Result<CallToolResult, McpError> {
        ok_json(read_test_pattern_state(&p.test_id).map_err(err)?)
    }

    #[tool(description = "List configured IO profiles (id, name, kind). Connection secrets are redacted.")]
    async fn list_io_profiles(&self) -> Result<CallToolResult, McpError> {
        let settings = crate::settings::load_settings_sync(&self.app).map_err(err)?;
        let profiles: Vec<_> = settings
            .io_profiles
            .iter()
            .map(|prof| {
                let mut keys: Vec<&String> = prof.connection.keys().collect();
                keys.sort();
                json!({
                    "id": prof.id,
                    "name": prof.name,
                    "kind": prof.kind,
                    "preferred_catalog": prof.preferred_catalog,
                    "connection_keys": keys,
                })
            })
            .collect();
        ok_json(json!({ "profiles": profiles }))
    }

    #[tool(description = "Get app version and platform info.")]
    async fn get_app_info(&self) -> Result<CallToolResult, McpError> {
        let version = self
            .app
            .config()
            .version
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        ok_json(json!({
            "name": "WireTAP",
            "version": version,
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        }))
    }

    #[tool(description = "Return the most recent lines from the WireTAP log file (requires file logging enabled).")]
    async fn tail_log(
        &self,
        Parameters(p): Parameters<TailLogParams>,
    ) -> Result<CallToolResult, McpError> {
        let path = match crate::logging::current_log_path() {
            Some(path) => path,
            None => {
                return ok_json(json!({
                    "available": false,
                    "message": "File logging is disabled — enable it in Settings → Diagnostics."
                }));
            }
        };
        let content = std::fs::read_to_string(&path)
            .map_err(|e| err(format!("Failed to read log file: {e}")))?;
        let lines: Vec<&str> = content.lines().collect();
        let start = lines.len().saturating_sub(p.lines);
        let tail = lines[start..].join("\n");
        ok_json(json!({ "available": true, "path": path.to_string_lossy(), "lines": tail }))
    }

    #[tool(description = "Read the session log every window shows in Session Manager: typed entries (id, timestamp_ms, session_id, profile_ids, subscriber_id, app_name, event with a kind such as created, joined, left, state, transition, stream_ended, error, destroyed, device_probe, mcp_connected). The ring keeps the newest 500; pass after_id to read on from an earlier call.")]
    async fn get_session_log(
        &self,
        Parameters(p): Parameters<SessionLogParams>,
    ) -> Result<CallToolResult, McpError> {
        ok_json(crate::io::session_log::read(p.after_id, p.limit))
    }

    #[tool(description = "List the decoder catalogs (TOML) in the decoder directory, with name, filename, path and git sync status.")]
    async fn list_catalogs(&self) -> Result<CallToolResult, McpError> {
        ok_json(crate::catalog::list_catalogs(self.app.clone()).await.map_err(err)?)
    }

    #[tool(description = "Read a decoder catalog's TOML by filename or display name (resolved within the decoder directory).")]
    async fn read_catalog(
        &self,
        Parameters(p): Parameters<ReadCatalogParams>,
    ) -> Result<CallToolResult, McpError> {
        let cat = crate::catalog::find_catalog(&self.app, &p.name)
            .await
            .map_err(err)?;
        let toml = crate::catalog::open_catalog(cat.path.clone())
            .await
            .map_err(err)?;
        ok_json(
            json!({ "name": cat.name, "filename": cat.filename, "path": cat.path, "toml": toml }),
        )
    }

    #[tool(description = "Validate catalog TOML without writing it. Returns { valid, errors: [{field, message}] } — a dry run for create_catalog/update_catalog.")]
    async fn validate_catalog(
        &self,
        Parameters(p): Parameters<ValidateCatalogParams>,
    ) -> Result<CallToolResult, McpError> {
        let errors = wiretap_catalog::validate::validate(&p.content);
        ok_json(json!({ "valid": errors.is_empty(), "errors": errors }))
    }

    #[tool(description = "Live one-off Modbus read of a register/coil block from a session's configured device. Returns the values, or { ok: false, exception, exception_code } when the device rejects the read (e.g. 'Server Device Failure'). Opens its own short-lived connection beside any running poll, so a device that accepts only one client may refuse it.")]
    async fn modbus_read(
        &self,
        Parameters(p): Parameters<ModbusReadParams>,
    ) -> Result<CallToolResult, McpError> {
        let rt = p.register_type.to_lowercase();
        let register_type = match rt.as_str() {
            "holding" => wiretap_catalog::RegisterType::Holding,
            "input" => wiretap_catalog::RegisterType::Input,
            "coil" => wiretap_catalog::RegisterType::Coil,
            "discrete" => wiretap_catalog::RegisterType::Discrete,
            other => return Err(err(format!("Unknown register_type '{other}' (use holding/input/coil/discrete)"))),
        };
        let profile = session_modbus_profile(&self.app, &p.session_id)?;
        let (start, count) = (p.address, p.count.max(1));
        let request = ReadRequest { register_type, start, count, unit: None };
        let r = transient_connection(&profile).read(request).await;
        modbus_read_json(&rt, start, count, r)
            .map_err(err)
            .and_then(ok_json)
    }

    #[tool(description = "Per-byte payload analysis (byte roles, counters, sensors, multi-byte patterns, mux cases, and the notes Discovery shows as codes) of a session's frame capture, each frame over its most recent 5000 payloads, with mirror groups (ids carrying one changing payload together) and each frame's burst flag over the capture's newest `newest` frames (default 100000, Discovery's default live window; pass a larger newest to read more of a long capture). Headless — no view needed. Without frame_ids the first 64 frames are profiled and the rest counted in skippedFrames.")]
    async fn get_discovery_analysis(
        &self,
        Parameters(p): Parameters<SessionAnalysisParams>,
    ) -> Result<CallToolResult, McpError> {
        let capture_id = session_frame_capture(&p.session_id)?;
        let groups = frame_key_groups(p.frame_ids).map_err(err)?;
        let max_frames = if groups.is_empty() { DISCOVERY_ANALYSIS_MAX_FRAMES } else { usize::MAX };
        let changes = crate::byte_roles::payload_changes(&Capture(&capture_id), groups, Some(analysis_window(p.newest)), max_frames)
            .await
            .map_err(err)?;
        ok_json(json!({
            "captureId": capture_id,
            "frameCount": changes.frames.len(),
            "framesRead": changes.frame_count,
            "skippedFrames": changes.skipped_frames,
            "frames": changes.frames,
            "mirrors": changes.mirrors,
        }))
    }

    #[tool(description = "Message order of a session's frame capture, per protocol and per bus: interval groups, start-id candidates, cycle patterns (the order frames follow a start id), mux and burst timing, and the ids seen on more than one bus. The same answer as Discovery's Frame Order. Headless. Optional frame_ids (\"can:256\") restrict it, newest sets how many of the capture's newest frames are read (default 100000, Discovery's default live window; pass a larger value to read more of a long capture), and start_frame_id (with start_is_extended, and start_protocol to name one protocol) walks cycles from that id.")]
    async fn get_frame_order(
        &self,
        Parameters(p): Parameters<FrameOrderParams>,
    ) -> Result<CallToolResult, McpError> {
        let capture_id = session_frame_capture(&p.session_id)?;
        let selection = FrameSelection::from_groups(frame_key_groups(p.frame_ids).map_err(err)?);
        let start = p.start_frame_id.map(|frame_id| crate::analysis::OrderStart {
            protocol: p.start_protocol,
            frame_id,
            is_extended: p.start_is_extended,
        });
        let orders = crate::analysis::message_order(&Capture(&capture_id), &selection, Some(analysis_window(p.newest)), start.as_ref())
            .await
            .map_err(err)?;
        ok_json(json!({ "captureId": capture_id, "protocols": orders }))
    }

    #[tool(
        description = "Decode the latest frames of a session's capture against its attached catalogue. Returns one entry per masked frame id with the newest reading of every signal (each mux case keeps its last value), the mux selectors, header fields and source address. Headless — no view needed. The session must have a catalogue: open_session binds the profile's preferred catalogue, set_profile_catalog chooses one. frame_id restricts it to one frame."
    )]
    async fn get_decoded_signals(
        &self,
        Parameters(p): Parameters<DecodedSignalsParams>,
    ) -> Result<CallToolResult, McpError> {
        let capture_id = session_frame_capture(&p.session_id)?;
        let catalog = crate::ws::dispatch::attached_catalog(&p.session_id).ok_or_else(|| {
            err(format!(
                "Session '{}' has no catalogue attached — bind one with set_profile_catalog and reopen it with open_session",
                p.session_id
            ))
        })?;
        let wanted = p
            .frame_id
            .as_deref()
            .map(masked_id_of)
            .transpose()
            .map_err(err)?;
        let tail = crate::capture_store::get_capture_frames_tail(
            &capture_id,
            DECODED_TAIL_FRAMES,
            &FrameSelection::default(),
        );
        let frames = decode_tail(&catalog, &tail.frames, wanted);
        ok_json(json!({ "frameCount": frames.len(), "frames": frames }))
    }

    #[tool(
        description = "The last-seen payload of every frame id in a session's capture, keyed as Discovery keys them (\"can:256\", \"modbus:5013\"): bytes, bus, is_extended, is_fd, is_rtr, is_brs, is_esi, dlc (an RTR's is the length it asks for) and timestampUs. Headless — no view needed. frame_ids restricts it to those keys."
    )]
    async fn get_live_frame_map(
        &self,
        Parameters(p): Parameters<LiveFrameMapParams>,
    ) -> Result<CallToolResult, McpError> {
        let capture_id = session_frame_capture(&p.session_id)?;
        let wanted: Option<HashSet<String>> = p
            .frame_ids
            .filter(|ids| !ids.is_empty())
            .map(|ids| ids.into_iter().collect());
        let frames =
            crate::capture_store::get_capture_latest_frames(&capture_id).unwrap_or_default();
        let frames = latest_by_key(frames, wanted.as_ref());
        ok_json(json!({ "frameCount": frames.len(), "frames": frames }))
    }

    // ── Headless analysis levers (capture OR WireTAP backend) ───────────────────────

    #[tool(description = "Per-frame-id rollup (count, first/last timestamp, max dlc, extended) for a capture (capture_id) or WireTAP backend profile (profile_id). Headless — no view needed. Use to see which frame ids exist and how often.")]
    async fn frame_inventory(
        &self,
        Parameters(p): Parameters<FrameInventoryParams>,
    ) -> Result<CallToolResult, McpError> {
        let src = resolve(p.capture_id, p.profile_id).map_err(err)?;
        let rows = src
            .reader(&self.app)
            .inventory(p.start_time.as_deref(), p.end_time.as_deref())
            .await
            .map_err(err)?;
        ok_json(json!({ "frames": rows.len(), "inventory": rows }))
    }

    #[tool(description = "Byte profile of one frame id over its most recent sample_limit payloads: per-byte statistics and role (static/counter/sensor/value/unknown), multi-byte patterns (counter16/sensor16/sensor32/text) and mux cases. Headless; the same profile Discovery's Payload Changes shows. Source is capture_id or profile_id.")]
    async fn frame_byte_profile(
        &self,
        Parameters(p): Parameters<ByteProfileParams>,
    ) -> Result<CallToolResult, McpError> {
        let src = resolve(p.capture_id, p.profile_id).map_err(err)?;
        let profile = crate::analysis::byte_profile(
            &src.reader(&self.app),
            p.protocol.as_deref(),
            p.frame_id,
            p.is_extended,
            p.sample_limit,
        )
        .await
        .map_err(err)?;
        ok_json(profile)
    }

    #[tool(
        description = "Find checksums in a source (capture_id or profile_id), frame id by frame id. Identification runs first — a byte that changes while every other byte holds still cannot be a checksum of them — so most columns are ruled out before any algorithm is tried, and the reason is reported per byte. Survivors are matched against the eleven named algorithms and solved for sums with a constant offset; set search_custom_polynomials to also recover arbitrary CRC polynomials. Headless equivalent of Discovery's Checksum Discovery."
    )]
    async fn frame_checksum_scan(
        &self,
        Parameters(p): Parameters<ChecksumScanParams>,
    ) -> Result<CallToolResult, McpError> {
        let src = resolve(p.capture_id, p.profile_id).map_err(err)?;
        // Every field named rather than `..Default::default()`: an option added
        // to the crate must be a build failure here, not a setting silently
        // unreachable from MCP.
        let defaults = wiretap_analysis::ChecksumScanOptions::default();
        let options = wiretap_analysis::ChecksumScanOptions {
            min_samples: defaults.min_samples,
            positions: defaults.positions,
            search_custom_polynomials: p.search_custom_polynomials,
            min_likeness: p.min_likeness,
        };
        let filter = crate::analysis::ScanFilter::Ids(p.frame_ids.unwrap_or_default());
        let result =
            crate::analysis::checksum_scan(&src.reader(&self.app), &filter, p.sample_limit, options)
                .await
                .map_err(err)?;
        ok_json(result)
    }

    #[tool(description = "Diff a decoder catalog against a data source (capture_id or profile_id): present/missing catalog frames, uncatalogued data frame ids, and a high/medium/low/unset signal confidence rollup. Set include_byte_roles=true to also attach each present frame's byte profile, as frame_byte_profile reports it (heavier — one sampling query per frame).")]
    async fn catalog_coverage(
        &self,
        Parameters(p): Parameters<CatalogCoverageParams>,
    ) -> Result<CallToolResult, McpError> {
        let src = resolve(p.capture_id, p.profile_id).map_err(err)?;
        let entry = crate::catalog::find_catalog(&self.app, &p.catalog).await.map_err(err)?;
        let toml = crate::catalog::open_catalog(entry.path).await.map_err(err)?;
        let catalog = wiretap_catalog::Catalog::parse(&toml).map_err(|e| err(e.to_string()))?;
        let report = crate::analysis::catalog_coverage(
            &src.reader(&self.app),
            &entry.name,
            &catalog,
            p.include_byte_roles,
            p.sample_limit,
            p.start_time.as_deref(),
            p.end_time.as_deref(),
        )
        .await
        .map_err(err)?;
        ok_json(report)
    }

    // ── Exposed analytical engines (dispatch capture vs WireTAP backend) ────────────

    #[tool(description = "Find timestamps where one payload byte of a frame changed value. Source: capture_id or profile_id.")]
    async fn query_byte_changes(
        &self,
        Parameters(p): Parameters<ByteQueryParams>,
    ) -> Result<CallToolResult, McpError> {
        let r = match resolve(p.capture_id, p.profile_id).map_err(err)? {
            QuerySource::Backend(pid) => {
                crate::dbquery::db_query_byte_changes(
                    self.app.clone(), pid, p.frame_id, p.byte_index, p.is_extended,
                    p.start_time, p.end_time, p.limit, None,
                ).await
            }
            QuerySource::Capture(cid) => crate::capturequery::capture_query_byte_changes(
                cid, p.frame_id, p.byte_index, p.is_extended, us(&p.start_time), us(&p.end_time), lim(p.limit),
            ),
        };
        ok_json(r.map_err(err)?)
    }

    #[tool(description = "Find timestamps where a frame's full payload changed (with the changed byte indices). Source: capture_id or profile_id.")]
    async fn query_frame_changes(
        &self,
        Parameters(p): Parameters<FrameQueryParams>,
    ) -> Result<CallToolResult, McpError> {
        let r = match resolve(p.capture_id, p.profile_id).map_err(err)? {
            QuerySource::Backend(pid) => {
                crate::dbquery::db_query_frame_changes(
                    self.app.clone(), pid, p.frame_id, p.is_extended, p.start_time, p.end_time, p.limit, None,
                ).await
            }
            QuerySource::Capture(cid) => crate::capturequery::capture_query_frame_changes(
                cid, p.frame_id, p.is_extended, us(&p.start_time), us(&p.end_time), lim(p.limit),
            ),
        };
        ok_json(r.map_err(err)?)
    }

    #[tool(description = "Histogram of values at one byte index of a frame (value → count, percentage). Source: capture_id or profile_id.")]
    async fn query_distribution(
        &self,
        Parameters(p): Parameters<ByteQueryParams>,
    ) -> Result<CallToolResult, McpError> {
        let r = match resolve(p.capture_id, p.profile_id).map_err(err)? {
            QuerySource::Backend(pid) => {
                crate::dbquery::db_query_distribution(
                    self.app.clone(), pid, p.frame_id, p.byte_index, p.is_extended, p.start_time, p.end_time, None,
                ).await
            }
            QuerySource::Capture(cid) => crate::capturequery::capture_query_distribution(
                cid, p.frame_id, p.byte_index, p.is_extended, us(&p.start_time), us(&p.end_time),
            ),
        };
        ok_json(r.map_err(err)?)
    }

    #[tool(description = "Find gaps longer than gap_threshold_ms in a frame's arrival times. Source: capture_id or profile_id.")]
    async fn query_gap_analysis(
        &self,
        Parameters(p): Parameters<GapQueryParams>,
    ) -> Result<CallToolResult, McpError> {
        let r = match resolve(p.capture_id, p.profile_id).map_err(err)? {
            QuerySource::Backend(pid) => {
                crate::dbquery::db_query_gap_analysis(
                    self.app.clone(), pid, p.frame_id, p.is_extended, p.gap_threshold_ms,
                    p.start_time, p.end_time, p.limit, None,
                ).await
            }
            QuerySource::Capture(cid) => crate::capturequery::capture_query_gap_analysis(
                cid, p.frame_id, p.is_extended, p.gap_threshold_ms, us(&p.start_time), us(&p.end_time), lim(p.limit),
            ),
        };
        ok_json(r.map_err(err)?)
    }

    #[tool(description = "Frame arrival frequency bucketed by bucket_size_ms (min/max/avg interval per bucket). Source: capture_id or profile_id.")]
    async fn query_frequency(
        &self,
        Parameters(p): Parameters<FrequencyQueryParams>,
    ) -> Result<CallToolResult, McpError> {
        let r = match resolve(p.capture_id, p.profile_id).map_err(err)? {
            QuerySource::Backend(pid) => {
                crate::dbquery::db_query_frequency(
                    self.app.clone(), pid, p.frame_id, p.is_extended, p.bucket_size_ms,
                    p.start_time, p.end_time, p.limit, None,
                ).await
            }
            QuerySource::Capture(cid) => crate::capturequery::capture_query_frequency(
                cid, p.frame_id, p.is_extended, p.bucket_size_ms, us(&p.start_time), us(&p.end_time), lim(p.limit),
            ),
        };
        ok_json(r.map_err(err)?)
    }

    #[tool(description = "First and last occurrence (timestamp + payload) and total count for a frame. Source: capture_id or profile_id.")]
    async fn query_first_last(
        &self,
        Parameters(p): Parameters<FrameQueryParams>,
    ) -> Result<CallToolResult, McpError> {
        let r = match resolve(p.capture_id, p.profile_id).map_err(err)? {
            QuerySource::Backend(pid) => {
                crate::dbquery::db_query_first_last(
                    self.app.clone(), pid, p.frame_id, p.is_extended, p.start_time, p.end_time, None,
                ).await
            }
            QuerySource::Capture(cid) => crate::capturequery::capture_query_first_last(
                cid, p.frame_id, p.is_extended, us(&p.start_time), us(&p.end_time),
            ),
        };
        ok_json(r.map_err(err)?)
    }

    #[tool(description = "Group a frame's payloads by a mux selector byte and compute per-byte (and optional 16-bit word) statistics per mux case. Source: capture_id or profile_id.")]
    async fn query_mux_statistics(
        &self,
        Parameters(p): Parameters<MuxQueryParams>,
    ) -> Result<CallToolResult, McpError> {
        let r = match resolve(p.capture_id, p.profile_id).map_err(err)? {
            QuerySource::Backend(pid) => {
                crate::dbquery::db_query_mux_statistics(
                    self.app.clone(), pid, p.frame_id, p.mux_selector_byte, p.is_extended,
                    p.include_16bit, p.payload_length, p.start_time, p.end_time, p.limit, None,
                ).await
            }
            QuerySource::Capture(cid) => crate::capturequery::capture_query_mux_statistics(
                cid, p.frame_id, p.mux_selector_byte, p.is_extended, p.include_16bit, p.payload_length,
                us(&p.start_time), us(&p.end_time), lim(p.limit),
            ),
        };
        ok_json(r.map_err(err)?)
    }
}

// ── Control tools (only registered when mcp_allow_control is on) ──────────────

#[tool_router(router = control_router)]
impl WireTapTools {
    #[tool(
        description = "Transmit a CAN frame through a session. Requires a transmit-capable session.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn transmit_frame(
        &self,
        Parameters(p): Parameters<TransmitFrameParams>,
    ) -> Result<CallToolResult, McpError> {
        ok_json(
            crate::transmit::transmit_can(&p.session_id, &p.frame)
                .await
                .map_err(err)?,
        )
    }

    #[tool(
        description = "Start a repeating frame transmit through a session at a fixed interval — the same cadence engine that backs the Transmit app's repeat. Returns a queue_id; pass it to repeat_transmit_stop. A frame sent to a serial bus is framed onto that interface, like transmit_frame. interval_ms 250 ≈ 4 Hz.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn repeat_transmit_start(
        &self,
        Parameters(p): Parameters<RepeatTransmitStartParams>,
    ) -> Result<CallToolResult, McpError> {
        let queue_id = format!("mcp-repeat-{}", REPEAT_SEQ.fetch_add(1, Ordering::Relaxed));
        crate::transmit::start_repeat_transmit(
            &self.app,
            p.session_id,
            queue_id.clone(),
            p.frame,
            p.interval_ms,
            "agent",
        )
        .await
        .map_err(err)?;
        ok_json(json!({ "queue_id": queue_id, "interval_ms": p.interval_ms }))
    }

    #[tool(
        description = "Stop a repeating transmit started by repeat_transmit_start, by its queue_id.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn repeat_transmit_stop(
        &self,
        Parameters(p): Parameters<RepeatTransmitStopParams>,
    ) -> Result<CallToolResult, McpError> {
        crate::transmit::io_stop_repeat_transmit(p.queue_id.clone())
            .await
            .map_err(err)?;
        // Mark the agent's queue row stopped in the Transmit UI (the UI's own
        // stop path updates state locally, but a backend stop needs this).
        crate::ws::dispatch::send_repeat_stopped(&crate::transmit::RepeatStoppedEvent {
            queue_id: p.queue_id.clone(),
            reason: "Stopped by agent".to_string(),
        });
        ok_json(json!({ "stopped": p.queue_id }))
    }

    #[tool(
        description = "Replay all CAN frames from a capture through a session with original timing. Returns a replay_id.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn replay_capture(
        &self,
        Parameters(p): Parameters<ReplayCaptureParams>,
    ) -> Result<CallToolResult, McpError> {
        let total = crate::capture_store::get_capture_count(&p.capture_id);
        if total == 0 {
            return Err(err(format!("Capture '{}' is empty or not found", p.capture_id)));
        }
        let cap = total.min(100_000);
        let (frames, _idx, _total) =
            crate::capture_store::get_capture_frames_paginated(&p.capture_id, 0, cap);

        let replay_frames: Vec<crate::replay::ReplayFrame> = frames
            .iter()
            .filter(|f| f.protocol == "can" || f.protocol == "canfd")
            .map(crate::replay::ReplayFrame::from)
            .collect();

        if replay_frames.is_empty() {
            return Err(err("Capture contains no CAN frames to replay".to_string()));
        }

        let seq = REPLAY_SEQ.fetch_add(1, Ordering::Relaxed);
        let replay_id = format!("mcp-{}-{}", p.capture_id, seq);
        let count = replay_frames.len();
        crate::replay::io_start_replay(
            p.session_id.clone(),
            replay_id.clone(),
            replay_frames,
            p.speed,
            p.loop_replay,
        )
        .await
        .map_err(err)?;
        ok_json(json!({ "replay_id": replay_id, "frame_count": count }))
    }

    #[tool(
        description = "Stop a running replay by its replay_id.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn stop_replay(
        &self,
        Parameters(p): Parameters<ReplayIdParams>,
    ) -> Result<CallToolResult, McpError> {
        crate::replay::io_stop_replay(p.replay_id.clone()).await.map_err(err)?;
        ok_json(json!({ "stopped": p.replay_id }))
    }

    #[tool(
        description = "Start a Test Pattern run through a session, as the Test Pattern app does: an initiator exchanges framed test traffic with a responder on the same bus (or with the interface itself in loopback mode) and counts drops, duplicates, reordering and latency. A responder runs until test_pattern_stop. Returns { test_id }; poll test_pattern_state with it.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn test_pattern_start(
        &self,
        Parameters(p): Parameters<TestPatternStartParams>,
    ) -> Result<CallToolResult, McpError> {
        let test_id = start_test_pattern(p).await.map_err(err)?;
        ok_json(json!({ "test_id": test_id }))
    }

    #[tool(
        description = "Stop a Test Pattern run by its test_id. Its final state stays readable through test_pattern_state.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn test_pattern_stop(
        &self,
        Parameters(p): Parameters<TestIdParams>,
    ) -> Result<CallToolResult, McpError> {
        crate::io_test::io_test_stop(p.test_id.clone()).await.map_err(err)?;
        ok_json(json!({ "stopped": p.test_id }))
    }

    #[tool(
        description = "Live Modbus write to holding registers or coils on a session's configured device. While the session polls the device, the write goes over the poll's own connection between reads; otherwise over a short-lived connection. Returns { ok: true }, { ok: false, exception, exception_code } when the device rejects the write, or { ok: false, sent: false, refused } when it was never sent: the poll's connection is down, its write queue is full, or the poll has stopped.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn modbus_write(
        &self,
        Parameters(p): Parameters<ModbusWriteParams>,
    ) -> Result<CallToolResult, McpError> {
        if p.values.is_empty() {
            return Err(err("No values to write".to_string()));
        }
        let profile = session_modbus_profile(&self.app, &p.session_id)?;
        let writer = crate::io::modbus_tcp::poll::poll_writer(&p.session_id, &profile.id);
        let a = p.address;
        let result = match p.register_type.to_lowercase().as_str() {
            "holding" => {
                let r = match writer {
                    Some(writer) => writer.write_registers(None, a, p.values.clone()).await,
                    None => Ok(transient_connection(&profile).write_registers(None, a, &p.values).await),
                };
                modbus_write_json("holding", a, &p.values, r)
            }
            "coil" => {
                let bits: Vec<bool> = p.values.iter().map(|v| *v != 0).collect();
                let r = match writer {
                    Some(writer) => writer.write_coils(None, a, bits.clone()).await,
                    None => Ok(transient_connection(&profile).write_coils(None, a, &bits).await),
                };
                modbus_write_json("coil", a, &bits, r)
            }
            other => return Err(err(format!("register_type '{other}' is not writable (use holding or coil)"))),
        };
        result.map_err(err).and_then(ok_json)
    }
}

// ── Session lifecycle (only registered when mcp_allow_session_control is on) ──

#[tool_router(router = session_control_router)]
impl WireTapTools {
    #[tool(
        description = "Open (create + start) a session for an IO profile, binding the profile's preferred catalog so the stream decodes (Modbus also gets its poll groups from it). A Modbus profile with no catalog can still be opened by passing register_ranges, which polls an address range directly — use that to watch a device you have no decoder for. A recorded source replays its whole archive from the head unless bounded — pass start_time/end_time, and speed to pace it. Returns { session_id, state, catalog_path, capabilities }.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn open_session(
        &self,
        Parameters(p): Parameters<OpenSessionParams>,
    ) -> Result<CallToolResult, McpError> {
        let modbus_ranges = p
            .register_ranges
            .as_ref()
            .map(|r| r.to_spec())
            .transpose()
            .map_err(err)?;
        let opts = super::session::OpenOptions {
            window: super::session::Window {
                start: p.start_time,
                end: p.end_time,
                speed: p.speed,
                limit: p.limit,
            },
            modbus_ranges,
        };
        let result = super::session::open(self.app.clone(), p.profile_id, p.session_id, opts)
            .await
            .map_err(err)?;
        ok_json(result)
    }

    #[tool(
        description = "Put raw bytes into a byte capture, as though a serial port had produced them. \
                       The capture is then an ordinary byte capture: open it in Discovery to frame it \
                       (SLIP, delimiter, Modbus RTU), run the Serial Framing tool over it, or hand its \
                       id to any capture-taking tool. Use it to exercise a wire format with no device \
                       attached — a recorded line, a hand-built message, a protocol you are still \
                       working out. Call again with the returned capture_id to append. \
                       Returns { capture_id, appended, total }.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn ingest_bytes(
        &self,
        Parameters(p): Parameters<IngestBytesParams>,
    ) -> Result<CallToolResult, McpError> {
        let data = wiretap_decode::hex::parse_bytes(&p.bytes)
            .map_err(|e| err(format!("bytes: {e}")))?;
        if data.is_empty() {
            return Err(err("bytes is empty"));
        }

        let capture_id = match p.capture_id {
            Some(id) => {
                if crate::capture_store::get_capture_kind(&id)
                    != Some(crate::capture_store::CaptureKind::Bytes)
                {
                    return Err(err(format!("Capture '{id}' is not a byte capture")));
                }
                id
            }
            None => {
                let id = crate::capture_store::create_standalone_capture(
                    crate::capture_store::CaptureKind::Bytes,
                    p.name.unwrap_or_else(|| "Ingested bytes".to_string()),
                );
                // Ingested data survives a restart. It is not stream residue that can
                // be recaptured by reconnecting — it came from outside, and clearing
                // it on start would throw away the only copy.
                let _ = crate::capture_store::set_capture_persistent(&id, true);
                id
            }
        };

        // Timestamps only shape the hex dump — every framer here works off byte order,
        // never gaps — but they must advance, or the dump cannot be read. An append
        // continues from where the capture left off rather than from now, so a line
        // built up over several calls does not show the gaps between them as gaps on
        // the wire.
        let step = p.interval_us.unwrap_or(1).max(1);
        let bus = p.bus.unwrap_or(0);
        let start = crate::capture_store::get_capture_metadata(&capture_id)
            .and_then(|m| m.end_time_us)
            .map_or_else(crate::io::now_us, |last| last + step);
        let entries: Vec<crate::capture_store::TimestampedByte> = data
            .iter()
            .enumerate()
            .map(|(i, &byte)| crate::capture_store::TimestampedByte {
                byte,
                timestamp_us: start + (i as u64 * step),
                bus,
            })
            .collect();

        let appended = entries.len();
        crate::capture_store::append_raw_bytes_to_capture(&capture_id, entries);
        crate::ws::dispatch::send_capture_changed(&capture_id);
        // If a session is showing this capture right now, its byte total just
        // changed. `send_new_bytes` is keyed by session, so find the one holding
        // it — appending to a capture somebody is watching should move its view.
        if let Some(session_id) = crate::capture_store::get_capture_metadata(&capture_id)
            .and_then(|m| m.owning_session_id)
        {
            crate::ws::dispatch::send_new_bytes(&session_id);
        }

        ok_json(json!({
            "capture_id": capture_id,
            "appended": appended,
            "total": crate::capture_store::get_capture_count(&capture_id),
            "hint": "Open it in Discovery: source picker > Captures > this capture, then set framing.",
        }))
    }

    #[tool(
        description = "Stop a running IO session and destroy it, releasing its profile to be opened again. Pass keep_session: true to stop it but leave it listed, its capture still readable.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = true)
    )]
    async fn stop_session(
        &self,
        Parameters(p): Parameters<StopSessionParams>,
    ) -> Result<CallToolResult, McpError> {
        if p.keep_session {
            let state = crate::io::stop_session(&p.session_id).await.map_err(err)?;
            return ok_json(json!({ "session_id": p.session_id, "state": state }));
        }
        if !crate::io::session_exists(&p.session_id).await {
            return Err(err(format!("Session '{}' not found", p.session_id)));
        }
        crate::sessions::destroy_reader_session(p.session_id.clone(), true)
            .await
            .map_err(err)?;
        ok_json(json!({ "session_id": p.session_id, "state": "destroyed" }))
    }

    #[tool(
        description = "Surface an existing session in a source-aware tab so a human can see it. Opens or focuses the given tab (discovery, decoder, transmit, query, or dashboard) and points it at the session, replacing any source it is currently showing.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn attach_source(
        &self,
        Parameters(p): Parameters<AttachSourceParams>,
    ) -> Result<CallToolResult, McpError> {
        if !crate::io::session_exists(&p.session_id).await {
            return Err(err(format!("Session '{}' not found", p.session_id)));
        }
        if !crate::app_registry::is_session_aware_panel(&p.panel) {
            return Err(err(format!(
                "'{}' is not a source-aware tab; valid tabs: {}",
                p.panel,
                crate::app_registry::session_aware_panel_ids().join(", ")
            )));
        }
        crate::ws::dispatch::send_attach_to_panel(&p.panel, &p.session_id);
        ok_json(json!({ "attached": p.session_id, "panel": p.panel }))
    }

    #[tool(
        description = "Ask a Modbus device which read function codes it actually answers, before sweeping anything. Reads one address on each of FC03 (holding), FC04 (input), FC01 (coil) and FC02 (discrete), for each unit id. The distinction that matters is exception vs silence: an exception proves the device implements that function code and you asked for the wrong address, whereas silence usually means it isn't implemented at all and sweeping it would burn the whole timeout budget. At most 4 requests per unit. Returns { units: [{ unit_id, responded, supported_types, holding, input, coil, discrete }] }.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn modbus_probe_function_codes(
        &self,
        Parameters(p): Parameters<ModbusProbeParams>,
    ) -> Result<CallToolResult, McpError> {
        let (host, port, _) = self.resolve_modbus_target(&p.target)?;
        let config = crate::io::FcProbeConfig {
            host,
            port,
            unit_ids: p.unit_ids.unwrap_or_else(|| vec![1, 0, 255, 2, 3]),
            test_register: p.test_register,
            timeout_ms: p.timeout_ms.unwrap_or(2000),
            connect_settle_ms: p.connect_settle_ms.unwrap_or(0),
        };
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let units = crate::io::modbus_tcp::scanner::probe_function_codes(config, cancel)
            .await
            .map_err(err)?;
        ok_json(json!({ "units": units }))
    }

    #[tool(
        description = "Sweep a Modbus address range to discover which registers exist, without needing a catalog. Runs as its own session writing into a frame capture, so results survive, can be paged with get_capture_frames, analysed with the Discovery tools, and exported as a catalog. The response is summarised as contiguous blocks rather than one row per register, so a 1000-register sweep stays small. Chunks that return a Modbus exception are bisected to localise the gap; chunks that return silence are not (silence says nothing about which address was at fault) and the sweep abandons that register type after max_consecutive_timeouts. Set repeat=2 to sample every register twice so the Changes tool can tell live telemetry from static config. Returns { session_id, capture_id, status, found, requests, blocks, gaps, notes }.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn modbus_scan_registers(
        &self,
        Parameters(p): Parameters<ModbusScanParams>,
    ) -> Result<CallToolResult, McpError> {
        let (host, port, unit_id) = self.resolve_modbus_target(&p.target)?;
        let register_type = p
            .register_type
            .parse::<crate::io::RegisterType>()
            .map_err(|e| err(e.to_string()))?;
        let max_chunk = register_type.catalog().max_per_read();

        let config = crate::io::ModbusScanConfig {
            host,
            port,
            unit_id,
            register_type,
            start_register: p.start,
            end_register: p.end,
            chunk_size: p.chunk_size.unwrap_or(max_chunk),
            inter_request_delay_ms: p.inter_request_delay_ms.unwrap_or(50),
            timeout_ms: p.timeout_ms.unwrap_or(2000),
            connect_settle_ms: p.connect_settle_ms.unwrap_or(0),
            reconnect_per_request: p.reconnect_per_request.unwrap_or(false),
            max_consecutive_timeouts: p.max_consecutive_timeouts.unwrap_or(3),
            max_registers: p.max_registers.unwrap_or(4096),
            max_requests: p.max_requests.unwrap_or(2000),
            repeat: p.repeat.unwrap_or(1),
            repeat_delay_ms: p.repeat_delay_ms.unwrap_or(6000),
        };

        self.run_scan_session(
            crate::io::ScanJob::Registers { config },
            p.session_id,
            p.wait,
            p.max_wait_ms,
        )
        .await
    }

    #[tool(
        description = "Sweep Modbus unit (slave) ids to find which devices answer on a gateway, identifying each via FC43 (Read Device Identification) where supported and falling back to a single register read. Runs as its own session writing into a frame capture. Returns { session_id, capture_id, status, found, devices }.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn modbus_scan_unit_ids(
        &self,
        Parameters(p): Parameters<ModbusUnitScanParams>,
    ) -> Result<CallToolResult, McpError> {
        let (host, port, _) = self.resolve_modbus_target(&p.target)?;
        let config = crate::io::UnitIdScanConfig {
            host,
            port,
            start_unit_id: p.start_unit_id,
            end_unit_id: p.end_unit_id,
            test_register: p.test_register,
            register_type: p
                .register_type
                .parse::<crate::io::RegisterType>()
                .map_err(|e| err(e.to_string()))?,
            inter_request_delay_ms: p.inter_request_delay_ms.unwrap_or(50),
            timeout_ms: p.timeout_ms.unwrap_or(2000),
            connect_settle_ms: 0,
        };
        self.run_scan_session(
            crate::io::ScanJob::UnitIds { config },
            p.session_id,
            p.wait,
            p.max_wait_ms,
        )
        .await
    }

    #[tool(
        description = "Check on a Modbus scan session started with wait=false. Returns { status, current, total, found_count, pass, capture_id, frames, notes }.",
        annotations(read_only_hint = true, destructive_hint = false, idempotent_hint = true)
    )]
    async fn get_modbus_scan_progress(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
    ) -> Result<CallToolResult, McpError> {
        let state = crate::io::modbus_tcp::scanner::get_scan_state(&p.session_id);
        let session = crate::io::session_info(&p.session_id).await;
        let progress = state.as_ref().and_then(|s| s.progress.clone());
        let status = scan_status(
            state.as_ref().map(|s| s.status.clone()),
            session.as_ref().map(|s| &s.state),
        );
        ok_json(json!({
            "session_id": p.session_id,
            "status": status,
            "current": progress.as_ref().map(|p| p.current),
            "total": progress.as_ref().map(|p| p.total),
            "found_count": progress.as_ref().map(|p| p.found_count),
            "pass": progress.as_ref().map(|p| p.pass),
            "total_passes": progress.as_ref().map(|p| p.total_passes),
            "capture_id": session.as_ref().and_then(|s| s.capture_id.clone()),
            "frames": session.as_ref().and_then(|s| s.capture_frame_count),
            "device_info": state.as_ref().map(|s| s.device_info.clone()).unwrap_or_default(),
            "notes": state.map(|s| s.notes).unwrap_or_default(),
        }))
    }
}

// ── Catalog write tools (registered when mcp_allow_catalog_write is on) ───────

#[tool_router(router = catalog_write_router)]
impl WireTapTools {
    #[tool(
        description = "Create a NEW decoder catalog file in the decoder directory. Validates the TOML first and refuses if the file already exists (use update_catalog to overwrite). Pass `content` (the full TOML) or `ops`: wiretap-catalog edit ops tagged by `op` (SetMeta, SetCanConfig, SetSerialConfig, SetModbusConfig, AddFrame, SetFrame, UpsertSignal, SetMux, DeleteAtPath, …), which build it from nothing and apply the catalogue's authoring rules. Requires the catalog-write MCP permission.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false)
    )]
    async fn create_catalog(
        &self,
        Parameters(p): Parameters<CreateCatalogParams>,
    ) -> Result<CallToolResult, McpError> {
        let (path, exists) = resolve_catalog_path(&self.app, &p.filename)?;
        if exists {
            return Err(err(format!(
                "Catalog '{}' already exists — use update_catalog to overwrite",
                p.filename
            )));
        }
        let content = catalog_text(|| Ok(String::new()), p.content, p.ops).map_err(err)?;
        validate_or_reject(&content)?;
        crate::catalog::save_catalog(self.app.clone(), path.to_string_lossy().into_owned(), content)
            .await
            .map_err(err)?;
        ok_json(json!({ "created": true, "path": path.to_string_lossy() }))
    }

    #[tool(
        description = "Bind a decoder catalog to an IO profile as its preferred_catalog, so open_session decodes that profile's stream (and, for Modbus, builds its poll groups) without further setup. This is the last step of authoring a catalog for a device you just reverse-engineered. Pass catalog: null to unbind. NOTE: this writes to the app's persisted settings, not just a catalog file. Requires the catalog-write MCP permission.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn set_profile_catalog(
        &self,
        Parameters(p): Parameters<SetProfileCatalogParams>,
    ) -> Result<CallToolResult, McpError> {
        // Resolve the catalogue first: binding a name that doesn't resolve would
        // leave the profile in a state where every open fails.
        let resolved = match p
            .catalog
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(want) => Some(
                crate::catalog::find_catalog(&self.app, want)
                    .await
                    .map_err(err)?
                    .filename,
            ),
            None => None,
        };

        let mut settings = crate::settings::load_settings_sync(&self.app).map_err(err)?;
        let profile = settings.profile_mut(&p.profile_id).map_err(err)?;
        profile.preferred_catalog = resolved.clone();
        let name = profile.name.clone();

        crate::settings::save_settings(self.app.clone(), settings)
            .await
            .map_err(err)?;

        ok_json(json!({
            "profile_id": p.profile_id,
            "profile_name": name,
            "preferred_catalog": resolved,
        }))
    }
}

// ── Catalog modify tools (registered when mcp_allow_catalog_modify is on) ─────

#[tool_router(router = catalog_modify_router)]
impl WireTapTools {
    #[tool(
        description = "Overwrite an EXISTING decoder catalog (by filename or display name). Validates the TOML first and refuses if no such catalog exists (use create_catalog for a new file). Pass `content` (the full TOML) or `ops`: wiretap-catalog edit ops tagged by `op` (SetMeta, SetCanConfig, SetSerialConfig, SetModbusConfig, AddFrame, SetFrame, UpsertSignal, SetMux, DeleteAtPath, …), which edit the file in place, keeping its comments, and apply the catalogue's authoring rules. Requires the catalog-modify MCP permission.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn update_catalog(
        &self,
        Parameters(p): Parameters<UpdateCatalogParams>,
    ) -> Result<CallToolResult, McpError> {
        let cat = crate::catalog::find_catalog(&self.app, &p.filename)
            .await
            .map_err(err)?;
        let on_disk = || std::fs::read_to_string(&cat.path).map_err(|e| format!("Failed to read catalog: {e}"));
        let content = catalog_text(on_disk, p.content, p.ops).map_err(err)?;
        validate_or_reject(&content)?;
        crate::catalog::save_catalog(self.app.clone(), cat.path.clone(), content).await.map_err(err)?;
        ok_json(json!({ "updated": true, "filename": cat.filename, "path": cat.path }))
    }
}

// ── Dashboard write tools (registered when mcp_allow_dashboard_write is on) ────

/// Validate a dashboard JSON string (schema + panel widget types). The embedded
/// custom-widget `code` is NEVER executed here — it is stored opaque and only
/// ever runs later inside the frontend's sandboxed worker.
fn validate_dashboard_or_reject(content: &str) -> Result<(), McpError> {
    let value: serde_json::Value =
        serde_json::from_str(content).map_err(|e| err(format!("Dashboard is not valid JSON: {e}")))?;
    if value.get("schema").and_then(|s| s.as_str()) != Some("wiretap.dashboard/1") {
        return Err(err("Dashboard 'schema' must be \"wiretap.dashboard/1\""));
    }
    let panels = value
        .get("panels")
        .and_then(|p| p.as_array())
        .ok_or_else(|| err("Dashboard must have a 'panels' array"))?;
    if value.get("layout").and_then(|l| l.as_array()).is_none() {
        return Err(err("Dashboard must have a 'layout' array"));
    }
    const KNOWN: &[&str] = &[
        "line-chart", "gauge", "list", "flow", "heatmap", "histogram",
        "icon-state", "rotary", "level-bar", "bitfield", "raw-canvas", "custom-svg",
    ];
    for p in panels {
        let ty = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if !KNOWN.contains(&ty) {
            return Err(err(format!("Dashboard panel has unknown widget type: {ty:?}")));
        }
    }
    Ok(())
}

#[tool_router(router = dashboard_write_router)]
impl WireTapTools {
    #[tool(
        description = "Create or overwrite a dashboard artifact (*.dashboard.json, schema \"wiretap.dashboard/1\") in the dashboards directory. Validates the JSON shape and that every panel type is a known widget. Any embedded custom-widget code is stored opaque and only ever runs later inside the frontend's sandboxed worker — it is NOT executed here. Requires the dashboard-write MCP permission.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn create_dashboard(
        &self,
        Parameters(p): Parameters<DashboardParams>,
    ) -> Result<CallToolResult, McpError> {
        validate_dashboard_or_reject(&p.content)?;
        let settings = crate::settings::load_settings_sync(&self.app).map_err(err)?;
        let path = crate::dashboard::write_dashboard(&settings.decoder_dir, &p.filename, &p.content)
            .map_err(err)?;
        ok_json(json!({ "saved": true, "path": path }))
    }
}

// ── UI control tools (registered when mcp_allow_ui_control is on) ─────────────

#[tool_router(router = ui_control_router)]
impl WireTapTools {
    #[tool(
        description = "Open (or focus) an app/panel in the running WireTAP window, e.g. \"dashboard\", \"discovery\", \"decoder\", \"query\". Pass args like { \"dashboardPath\": \"…\" } to load a dashboard before opening it. Requires an open WireTAP window and the ui-control MCP permission.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true)
    )]
    async fn open_app(
        &self,
        Parameters(p): Parameters<OpenAppParams>,
    ) -> Result<CallToolResult, McpError> {
        bridge_call("ui.openPanel", json!({ "panelId": p.panel_id, "args": p.args })).await
    }
}

async fn start_test_pattern(p: TestPatternStartParams) -> Result<String, String> {
    let test_id = format!("mcp-test-{}", TEST_PATTERN_SEQ.fetch_add(1, Ordering::Relaxed));
    let config = p.config();
    crate::io_test::io_test_start(p.session_id, test_id, config).await
}

fn read_test_pattern_state(test_id: &str) -> Result<crate::io_test::IOTestState, String> {
    crate::io_test::get_io_test_state(test_id.to_string())
        .ok_or_else(|| format!("Test '{test_id}' not found"))
}

/// A sweep publishes no state until its first progress tick, so a live session
/// without one is still connecting; with no session at all it has cleaned up.
fn scan_status(published: Option<String>, session_state: Option<&crate::io::IOState>) -> String {
    use crate::io::IOState;
    published.unwrap_or_else(|| {
        match session_state {
            Some(IOState::Starting | IOState::Running) => "scanning",
            Some(IOState::Error(_)) => "error",
            Some(_) => "complete",
            None => "unknown",
        }
        .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::{analysis_window, catalog_text, modbus_write_json, parse_frame_key, scan_status};
    use crate::io::IOState;
    use std::time::Duration;
    use wiretap_io::modbus::{ExceptionCode, RequestError, TransportError, WriteRefused};

    #[test]
    fn an_analysis_reads_discoverys_default_window_unless_told_otherwise() {
        assert_eq!(analysis_window(None), 100_000);
        assert_eq!(analysis_window(Some(5_000_000)), 5_000_000);
    }

    #[test]
    fn a_catalogue_write_takes_content_or_ops_applied_to_its_base() {
        let base = || Ok("[meta]\nname = \"d\"\nversion = 1\n".to_string());
        assert_eq!(catalog_text(base, Some("x".into()), None).unwrap(), "x");
        let ops = vec![serde_json::json!({ "op": "AddFrame", "protocol": "modbus", "key": "5000", "frame": { "length": 2 } })];
        let text = catalog_text(base, None, Some(ops)).unwrap();
        assert!(text.starts_with("[meta]"), "{text}");
        let catalog = wiretap_catalog::Catalog::parse(&text).unwrap();
        let frame = catalog.frame_by_key(wiretap_catalog::Protocol::Modbus, "5000").unwrap();
        assert_eq!((frame.modbus_register_count, frame.signals.len()), (Some(2), 1));
        assert!(catalog_text(base, None, None).is_err());
        assert!(catalog_text(base, Some("x".into()), Some(vec![])).is_err());
        assert!(catalog_text(base, None, Some(vec![serde_json::json!({ "op": "Nope" })])).is_err());
    }

    #[test]
    fn a_frame_key_is_protocol_and_decimal_id() {
        assert_eq!(parse_frame_key("can:256"), Ok(("can", 256)));
        assert_eq!(parse_frame_key("modbus_rtu:288"), Ok(("modbus_rtu", 288)));
        assert!(parse_frame_key("256").is_err());
        assert!(parse_frame_key(":256").is_err());
        assert!(parse_frame_key("can:0x100").is_err());
    }

    #[test]
    fn a_refused_write_reads_as_not_sent() {
        let result = modbus_write_json("holding", 7, [1], Err(WriteRefused::Disconnected)).unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["sent"], false);
        assert_eq!(result["refused"], "not connected");
    }

    #[test]
    fn a_rejected_write_names_the_exception_and_its_code() {
        let rejected = RequestError::Exception {
            code: ExceptionCode::IllegalDataAddress,
            latency: Duration::ZERO,
        };
        let result = modbus_write_json("holding", 7, [1], Ok(Err(rejected))).unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(result["exception_code"], 2);
        assert!(result.get("sent").is_none());
    }

    #[test]
    fn a_write_lost_in_transit_is_an_error() {
        let lost = RequestError::Transport(TransportError::Timeout {
            after: Duration::from_secs(2),
        });
        assert!(modbus_write_json("coil", 7, [true], Ok(Err(lost))).is_err());
    }

    #[test]
    fn a_running_scan_with_no_progress_yet_is_scanning() {
        assert_eq!(scan_status(None, Some(&IOState::Running)), "scanning");
        assert_eq!(scan_status(None, Some(&IOState::Starting)), "scanning");
    }

    #[test]
    fn a_scan_session_that_is_not_running_is_complete() {
        assert_eq!(scan_status(None, Some(&IOState::Stopped)), "complete");
    }

    #[test]
    fn a_scan_session_that_failed_is_an_error() {
        assert_eq!(scan_status(None, Some(&IOState::Error("timeout".into()))), "error");
    }

    #[test]
    fn a_scan_with_no_session_is_unknown() {
        assert_eq!(scan_status(None, None), "unknown");
    }

    #[test]
    fn published_scan_status_wins() {
        assert_eq!(scan_status(Some("error".into()), Some(&IOState::Running)), "error");
    }

    mod test_pattern {
        use super::super::{read_test_pattern_state, start_test_pattern};
        use crate::io_test::tests::open_virtual_loopback;
        use crate::io_test::{io_test_stop, IOTestState, TestMode, TestRole, TestStatus};
        use crate::mcp::types::TestPatternStartParams;
        use std::time::{Duration, Instant};

        fn params(json: serde_json::Value) -> TestPatternStartParams {
            serde_json::from_value(json).expect("valid params")
        }

        async fn wait_for(test_id: &str, done: impl Fn(&IOTestState) -> bool) -> IOTestState {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Ok(state) = read_test_pattern_state(test_id) {
                    if done(&state) {
                        return state;
                    }
                }
                assert!(Instant::now() < deadline, "'{test_id}' never settled");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        #[test]
        fn only_the_session_and_mode_are_required() {
            let config = params(serde_json::json!({ "session_id": "s", "mode": "sweep" })).config();
            assert_eq!(config.mode, TestMode::Sweep);
            assert!(matches!(config.role, TestRole::Initiator));
            assert_eq!((config.duration_sec, config.rate_hz, config.bus), (10.0, 10.0, 0));
            assert!(!config.use_fd && !config.use_extended);
        }

        #[test]
        fn an_unknown_mode_is_refused() {
            let bad = serde_json::json!({ "session_id": "s", "mode": "ping" });
            assert!(serde_json::from_value::<TestPatternStartParams>(bad).is_err());
        }

        #[test]
        fn an_unknown_test_is_an_error() {
            assert!(read_test_pattern_state("mcp-test-none").is_err());
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn a_loopback_run_completes_through_the_wrappers() {
            open_virtual_loopback("mcp_tp_loopback").await;
            let test_id = start_test_pattern(params(serde_json::json!({
                "session_id": "mcp_tp_loopback",
                "mode": "loopback",
                "duration_sec": 1.0,
                "rate_hz": 100.0,
            })))
            .await
            .unwrap();

            let state = wait_for(&test_id, |s| s.status != TestStatus::Running).await;
            assert_eq!(state.status, TestStatus::Completed, "errors: {:?}", state.errors);
            assert!(state.tx_count > 0);
            assert_eq!(state.rx_count, state.tx_count);
            assert_eq!((state.drops, state.duplicates, state.out_of_order), (0, 0, 0));
            crate::io::destroy_session("mcp_tp_loopback", false).await.unwrap();
        }

        #[tokio::test]
        async fn a_responder_listens_until_stopped() {
            let test_id = start_test_pattern(params(serde_json::json!({
                "session_id": "mcp_tp_responder",
                "mode": "echo",
                "role": "responder",
            })))
            .await
            .unwrap();

            wait_for(&test_id, |s| s.status == TestStatus::Listening).await;
            io_test_stop(test_id.clone()).await.unwrap();
            wait_for(&test_id, |s| s.status == TestStatus::Stopped).await;
        }
    }

    mod live_reads {
        use super::super::{decode_tail, latest_by_key, masked_id_of};
        use crate::io::FrameMessage;
        use serde_json::json;
        use std::collections::HashSet;

        fn frame(
            protocol: &str,
            frame_id: u32,
            bus: u8,
            timestamp_us: u64,
            bytes: Vec<u8>,
        ) -> FrameMessage {
            FrameMessage {
                protocol: protocol.to_string(),
                timestamp_us,
                frame_id,
                bus,
                dlc: bytes.len() as u16,
                bytes,
                is_extended: false,
                is_fd: false,
                source_address: None,
                incomplete: None,
                direction: None,
                ..Default::default()
            }
        }

        fn mux_catalogue() -> wiretap_catalog::Catalog {
            wiretap_catalog::Catalog::parse(
                r#"
[meta]
name = "mux"
[frame.can.0x200]
length = 8
[frame.can.0x200.mux]
name = "sel"
start_bit = 0
bit_length = 8
[[frame.can.0x200.mux."0".signals]]
name = "low"
start_bit = 8
bit_length = 8
[[frame.can.0x200.mux."1".signals]]
name = "high"
start_bit = 8
bit_length = 8
"#,
            )
            .expect("catalogue parses")
        }

        /// The tail ends on case 1, yet case 0's last value is still reported:
        /// the Decoder keeps an inactive mux case, and so does the tool.
        #[test]
        fn a_two_case_mux_over_a_tail_keeps_both_cases() {
            let tail = [
                frame("can", 0x200, 0, 1, vec![0, 0x11, 0, 0, 0, 0, 0, 0]),
                frame("can", 0x200, 0, 2, vec![1, 0x22, 0, 0, 0, 0, 0, 0]),
                frame("can", 0x200, 0, 3, vec![0, 0x33, 0, 0, 0, 0, 0, 0]),
                frame("can", 0x200, 0, 4, vec![1, 0x44, 0, 0, 0, 0, 0, 0]),
                frame("can", 0x201, 0, 5, vec![0; 8]),
            ];
            let out = decode_tail(&mux_catalogue(), &tail, None);
            assert_eq!(out.len(), 1, "0x201 is not in the catalogue");
            let entry = &out[0];
            assert_eq!(
                (entry["maskedFrameId"].as_u64(), entry["t"].as_u64()),
                (Some(0x200), Some(4))
            );
            let signals = entry["signals"].as_array().expect("signals");
            let value = |name: &str| {
                signals
                    .iter()
                    .find(|s| s["name"] == name)
                    .map(|s| s["value"].as_f64())
            };
            assert_eq!(value("low"), Some(Some(0x33 as f64)));
            assert_eq!(value("high"), Some(Some(0x44 as f64)));
            assert_eq!(entry["selectors"][0]["value"], 1);
            assert!(entry.get("bytes").is_none());
        }

        #[test]
        fn a_frame_filter_is_a_bare_id_or_a_frame_key() {
            assert_eq!(masked_id_of("512"), Ok(0x200));
            assert_eq!(masked_id_of("can:512"), Ok(0x200));
            assert!(masked_id_of("can:0x200").is_err());
            let tail = [frame("can", 0x200, 0, 1, vec![0, 0x11, 0, 0, 0, 0, 0, 0])];
            assert!(decode_tail(&mux_catalogue(), &tail, Some(0x201)).is_empty());
        }

        #[test]
        fn the_live_map_keys_by_protocol_and_id_and_keeps_the_newest() {
            let frames = || {
                vec![
                    frame("can", 256, 0, 10, vec![1]),
                    frame("modbus", 5013, 0, 11, vec![2, 3]),
                    frame("can", 256, 1, 12, vec![9]),
                    frame("can", 256, 2, 5, vec![7]),
                ]
            };
            let map = latest_by_key(frames(), None);
            assert_eq!(map.keys().collect::<Vec<_>>(), ["can:256", "modbus:5013"]);
            assert_eq!(
                map["can:256"],
                json!({
                    "bytes": [9], "bus": 1, "is_extended": false, "is_fd": false, "is_rtr": false,
                    "is_brs": false, "is_esi": false, "dlc": 1, "timestampUs": 12
                })
            );
            assert_eq!(map["modbus:5013"]["dlc"], 2);

            let wanted: HashSet<String> = ["modbus:5013".to_string()].into();
            let map = latest_by_key(frames(), Some(&wanted));
            assert_eq!(map.keys().collect::<Vec<_>>(), ["modbus:5013"]);
        }

        #[test]
        fn the_live_map_carries_a_frames_can_flags() {
            let fd = FrameMessage { is_fd: true, is_brs: true, is_esi: true, ..frame("can", 1, 0, 1, vec![0; 12]) };
            let rtr = FrameMessage { is_rtr: true, dlc: 4, ..frame("can", 2, 0, 2, vec![]) };
            let map = latest_by_key(vec![fd, rtr], None);
            let flags = |key: &str| {
                ["is_fd", "is_rtr", "is_brs", "is_esi"].map(|f| map[key][f].as_bool())
            };
            assert_eq!(flags("can:1"), [Some(true), Some(false), Some(true), Some(true)]);
            assert_eq!(flags("can:2"), [Some(false), Some(true), Some(false), Some(false)]);
            assert_eq!(map["can:2"]["dlc"], 4);
        }
    }

    #[test]
    fn vendored_dom_ops_match_the_library() {
        let vendored = include_str!("../../../../frontend/wiretap-ui/src/services/domOps.ts");
        assert!(
            vendored == wslib_ai_mcp::dom::OPS_TS,
            "re-copy crates/wslib-ai-mcp/js/dom-ops.ts from wslib-ai-rs to frontend/wiretap-ui/src/services/domOps.ts"
        );
    }
}
