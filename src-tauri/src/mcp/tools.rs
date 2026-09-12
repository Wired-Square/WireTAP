// Copyright 2026 Wired Square Pty Ltd

//! MCP tool definitions. Read tools are always available; control (mutation)
//! tools are only merged into the router when `mcp_allow_control` is on.

use crate::capture_store::{FrameSelection, ProtocolFrames};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio_modbus::client::tcp;
use tokio_modbus::prelude::*;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CacheScope, CallToolResult, ContentBlock, DiscoverResult, Implementation, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerInfo, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler, tool, tool_handler, tool_router};
use serde_json::json;

use super::types::*;
use super::McpRunningConfig;
use crate::analysis::QuerySource;

/// Counter for generating unique replay IDs without a clock/RNG.
static REPLAY_SEQ: AtomicU64 = AtomicU64::new(1);
static REPEAT_SEQ: AtomicU64 = AtomicU64::new(1);

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct WireTapTools {
    app: tauri::AppHandle,
    tool_router: Arc<ToolRouter<WireTapTools>>,
}

/// How long a client may treat `tools/list` as fresh. The set only changes when
/// the permission gates change, which forces an explicit server restart.
const TOOL_LIST_TTL_MS: u64 = 300_000;

/// Protocol revisions this server implements. Narrower than rmcp's default
/// (which advertises every version it knows, back to 2024-11-05) — this is the
/// list `server/discover` publishes and the bound on `initialize` negotiation.
const SUPPORTED_VERSIONS: &[ProtocolVersion] = &[
    ProtocolVersion::V_2026_07_28,
    ProtocolVersion::V_2025_11_25,
    ProtocolVersion::V_2025_06_18,
];

impl WireTapTools {
    /// Build the tool router for a set of permission gates. Built once when the
    /// server starts and shared per request: under the stateless 2026-07-28
    /// transport `StreamableHttpService` runs its service factory on *every*
    /// request, so assembling seven routers there would be per-call work.
    pub fn router(cfg: McpRunningConfig) -> ToolRouter<WireTapTools> {
        let mut router = Self::read_router();
        // Read-only-ness is a property of *being in* `read_router`, so it is
        // stamped on here rather than repeated on all 27 tools — where one
        // omission would silently ship a read tool with no hint. The write
        // routers annotate per tool, because destructive/idempotent genuinely
        // differ between them.
        for route in router.map.values_mut() {
            route.attr.annotations = Some(ToolAnnotations::new().read_only(true));
        }
        for extra in [
            cfg.control.then(Self::control_router),
            cfg.session_control.then(Self::session_control_router),
            cfg.catalog_write.then(Self::catalog_write_router),
            cfg.catalog_modify.then(Self::catalog_modify_router),
            cfg.dashboard_write.then(Self::dashboard_write_router),
            cfg.ui_control.then(Self::ui_control_router),
        ]
        .into_iter()
        .flatten()
        {
            router += extra;
        }
        router
    }

    pub fn new(app: tauri::AppHandle, tool_router: Arc<ToolRouter<WireTapTools>>) -> Self {
        Self { app, tool_router }
    }
}

fn err(message: impl Into<String>) -> McpError {
    McpError::internal_error(message.into(), None)
}

/// Every tool answers through here. `CallToolResult::structured` emits the value
/// as `structuredContent` *and* as a serialised text block — the latter is the
/// backwards-compatibility path the spec asks for, and is what pre-2026-07-28
/// clients read.
///
/// Non-object values are sent as the text block alone. SEP-2106 widened
/// `structuredContent` to any JSON value for `2026-07-28`, but it was
/// object-only before that and clients still enforce the old rule — a top-level
/// array (`list_sessions`, `list_catalogs`, …) is rejected outright as a
/// malformed result. Nothing is lost by omitting it: the text block carries
/// every result either way.
fn ok_json<T: serde::Serialize>(value: T) -> Result<CallToolResult, McpError> {
    let value = serde_json::to_value(value)
        .map_err(|e| err(format!("Failed to serialise tool result: {e}")))?;
    if value.is_object() {
        return Ok(CallToolResult::structured(value));
    }
    Ok(CallToolResult::success(vec![ContentBlock::text(value.to_string())]))
}

/// Convert an optional RFC3339 time bound to capture-timeline microseconds.
fn us(s: &Option<String>) -> Option<i64> {
    s.as_deref().and_then(crate::analysis::iso_to_micros)
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

/// Shape a tokio-modbus read result (values, device exception, or IO error) into a tool result.
fn modbus_read_json<T, E1, E2>(
    rt: &str,
    address: u16,
    count: u16,
    r: Result<Result<Vec<T>, E1>, E2>,
) -> Result<CallToolResult, McpError>
where
    T: serde::Serialize,
    E1: std::fmt::Display,
    E2: std::fmt::Display,
{
    match r {
        Ok(Ok(values)) => ok_json(json!({"ok":true,"register_type":rt,"address":address,"count":count,"values":values})),
        Ok(Err(exc)) => ok_json(json!({"ok":false,"register_type":rt,"address":address,"exception":exc.to_string()})),
        Err(e) => Err(err(format!("Modbus IO error reading {rt} {address}: {e}"))),
    }
}

/// Shape a tokio-modbus write result (success, device exception, or IO error) into a tool result.
fn modbus_write_json<W, R, E1, E2>(
    rt: &str,
    address: u16,
    written: W,
    r: Result<Result<R, E1>, E2>,
) -> Result<CallToolResult, McpError>
where
    W: serde::Serialize,
    E1: std::fmt::Display,
    E2: std::fmt::Display,
{
    match r {
        Ok(Ok(_)) => ok_json(json!({"ok":true,"register_type":rt,"address":address,"written":written})),
        Ok(Err(exc)) => ok_json(json!({"ok":false,"register_type":rt,"address":address,"exception":exc.to_string()})),
        Err(e) => Err(err(format!("Modbus IO error writing {rt} {address}: {e}"))),
    }
}

fn modbus_endpoint_of(
    app: &tauri::AppHandle,
    profile_id: &str,
) -> Result<(String, u16, u8), McpError> {
    let settings = crate::settings::load_settings_sync(app).map_err(err)?;
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| err(format!("Profile '{profile_id}' not found")))?;
    Ok(crate::io::modbus_endpoint(profile))
}

/// Open a transient Modbus TCP connection to the device behind a session's
/// source profile. NB: opens a second connection alongside the running poller —
/// single-connection devices may contend.
async fn connect_session_modbus(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<tokio_modbus::client::Context, McpError> {
    let (host, port, unit_id) =
        crate::io::session_modbus_endpoint(app, session_id).map_err(err)?;
    let addr = crate::io::net::resolve_host_port(&host, port)
        .await
        .map_err(|e| err(e.user_message()))?;
    tcp::connect_slave(addr, Slave(unit_id))
        .await
        .map_err(|e| err(format!("Connect to {addr} (unit {unit_id}) failed: {e}")))
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
        let sid = session_id.unwrap_or_else(|| {
            format!("m_scan{}", SCAN_COUNTER.fetch_add(1, AtomicOrdering::Relaxed))
        });

        crate::sessions::create_modbus_scan_session(
            self.app.clone(),
            sid.clone(),
            job,
            None,
            Some("mcp".to_string()),
            Some("mcp".to_string()),
            // MCP names its own device and manages its own sessions, so it neither
            // retargets nor stops one. It opts out of the poller check to keep the
            // agent's behaviour exactly as it was: an agent sweeping a device that
            // something else is polling may well be doing so deliberately, and it
            // has no parameter to override a refusal with.
            None,
            None,
            Some(true),
        )
        .await
        .map_err(err)?;

        if let Err(e) = crate::io::start_session(&sid).await {
            let _ = crate::io::destroy_session(&sid, false).await;
            return Err(err(e));
        }

        let capture_id = || async {
            crate::io::list_sessions()
                .await
                .into_iter()
                .find(|s| s.session_id == sid)
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

        let Some(r) = result else {
            return ok_json(json!({
                "session_id": sid,
                "capture_id": capture_id,
                "status": "scanning",
                "note": format!("still running after {max_wait_ms}ms — poll get_modbus_scan_progress"),
            }));
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

/// Names generated scan sessions. Only ever incremented.
static SCAN_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
use std::sync::atomic::Ordering as AtomicOrdering;

/// Forward a Tier 2 request to the frontend over the bridge and wrap the result.
async fn bridge_call(method: &str, params: impl serde::Serialize) -> Result<CallToolResult, McpError> {
    let value = serde_json::to_value(params).map_err(|e| err(e.to_string()))?;
    ok_json(super::bridge::request(method, value, BRIDGE_TIMEOUT).await.map_err(err)?)
}

// ── Read tools (Tier 1 Rust-native + Tier 2 frontend bridge) ─────────────────

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
        let info = crate::io::list_sessions()
            .await
            .into_iter()
            .find(|s| s.session_id == p.session_id)
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
            (Some(frame_id), Some(protocol)) => {
                vec![ProtocolFrames { protocol, frame_ids: vec![frame_id], all_ids: false }]
            }
            (Some(frame_id), None) => crate::capture_store::get_capture_frame_info(&p.capture_id)
                .into_iter()
                .filter(|info| info.frame_id == frame_id)
                .map(|info| ProtocolFrames {
                    protocol: info.protocol,
                    frame_ids: vec![frame_id],
                    all_ids: false,
                })
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

    #[tool(description = "List the decoder catalogs (TOML) in the decoder directory, with name, filename, path and git sync status.")]
    async fn list_catalogs(&self) -> Result<CallToolResult, McpError> {
        ok_json(crate::catalog::list_catalogs(self.app.clone()).await.map_err(err)?)
    }

    #[tool(description = "Read a decoder catalog's TOML by filename or display name (resolved within the decoder directory).")]
    async fn read_catalog(
        &self,
        Parameters(p): Parameters<ReadCatalogParams>,
    ) -> Result<CallToolResult, McpError> {
        let catalogs = crate::catalog::list_catalogs(self.app.clone()).await.map_err(err)?;
        let cat = catalogs
            .iter()
            .find(|c| c.filename == p.name || c.name == p.name)
            .ok_or_else(|| err(format!("Catalog '{}' not found — use list_catalogs", p.name)))?;
        let toml = crate::catalog::open_catalog(cat.path.clone()).await.map_err(err)?;
        ok_json(json!({ "name": cat.name, "filename": cat.filename, "path": cat.path, "toml": toml }))
    }

    #[tool(description = "Validate catalog TOML without writing it. Returns { valid, errors: [{field, message}] } — a dry run for create_catalog/update_catalog.")]
    async fn validate_catalog(
        &self,
        Parameters(p): Parameters<ValidateCatalogParams>,
    ) -> Result<CallToolResult, McpError> {
        let errors = wiretap_catalog::validate::validate(&p.content);
        ok_json(json!({ "valid": errors.is_empty(), "errors": errors }))
    }

    #[tool(description = "Live one-off Modbus read of a register/coil block from a session's configured device. Returns the values, or the exact device exception (e.g. 'Server device failure'). Opens a transient connection — may contend with the running poller on single-connection devices.")]
    async fn modbus_read(
        &self,
        Parameters(p): Parameters<ModbusReadParams>,
    ) -> Result<CallToolResult, McpError> {
        let mut ctx = connect_session_modbus(&self.app, &p.session_id).await?;
        let (a, c) = (p.address, p.count.max(1));
        let rt = p.register_type.to_lowercase();
        match rt.as_str() {
            "holding" => modbus_read_json(&rt, a, c, ctx.read_holding_registers(a, c).await),
            "input" => modbus_read_json(&rt, a, c, ctx.read_input_registers(a, c).await),
            "coil" => modbus_read_json(&rt, a, c, ctx.read_coils(a, c).await),
            "discrete" => modbus_read_json(&rt, a, c, ctx.read_discrete_inputs(a, c).await),
            other => Err(err(format!("Unknown register_type '{other}' (use holding/input/coil/discrete)"))),
        }
    }

    // ── Tier 2: frontend bridge ──────────────────────────────────────────────

    #[tool(description = "Get per-byte payload analysis (byte roles, counters, sensors, multi-byte patterns, mux) for live discovery frames. Requires the WireTAP Discovery view to be open.")]
    async fn get_discovery_analysis(
        &self,
        Parameters(p): Parameters<DiscoveryAnalysisParams>,
    ) -> Result<CallToolResult, McpError> {
        bridge_call("discovery.analysis", p).await
    }

    #[tool(description = "Get the latest decoded signals (name, value, unit) for the loaded catalog. Requires the WireTAP Decoder view to be open.")]
    async fn get_decoded_signals(
        &self,
        Parameters(p): Parameters<DecodedSignalsParams>,
    ) -> Result<CallToolResult, McpError> {
        bridge_call("decoder.signals", p).await
    }

    #[tool(description = "Get the last-seen payload bytes for every discovered frame id. Requires the WireTAP Discovery view to be open.")]
    async fn get_live_frame_map(
        &self,
        Parameters(p): Parameters<DiscoveryAnalysisParams>,
    ) -> Result<CallToolResult, McpError> {
        bridge_call("live.frameMap", p).await
    }

    // ── Headless analysis levers (capture OR WireTAP backend) ───────────────────────

    #[tool(description = "Per-frame-id rollup (count, first/last timestamp, max dlc, extended) for a capture (capture_id) or WireTAP backend profile (profile_id). Headless — no view needed. Use to see which frame ids exist and how often.")]
    async fn frame_inventory(
        &self,
        Parameters(p): Parameters<FrameInventoryParams>,
    ) -> Result<CallToolResult, McpError> {
        let src = crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)?;
        let rows = crate::analysis::frame_inventory(&self.app, &src, p.start_time, p.end_time)
            .await
            .map_err(err)?;
        ok_json(json!({ "frames": rows.len(), "inventory": rows }))
    }

    #[tool(description = "Per-byte analysis of one frame id over sampled payloads: distinct values, min/max, change count and role (static/counter/sensor). Headless equivalent of the Discovery byte analysis. Source is capture_id or profile_id.")]
    async fn frame_byte_profile(
        &self,
        Parameters(p): Parameters<ByteProfileParams>,
    ) -> Result<CallToolResult, McpError> {
        let src = crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)?;
        let profile = crate::analysis::byte_profile(
            &self.app,
            &src,
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
        let src = crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)?;
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
            crate::analysis::checksum_scan(&self.app, &src, &filter, p.sample_limit, options)
                .await
                .map_err(err)?;
        ok_json(result)
    }

    #[tool(description = "Diff a decoder catalog against a data source (capture_id or profile_id): present/missing catalog frames, uncatalogued data frame ids, and a high/medium/low/unset signal confidence rollup. Set include_byte_roles=true to also sample per-byte static/varying roles for each present frame (heavier — one sampling query per frame).")]
    async fn catalog_coverage(
        &self,
        Parameters(p): Parameters<CatalogCoverageParams>,
    ) -> Result<CallToolResult, McpError> {
        let src = crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)?;
        let report = crate::analysis::catalog_coverage(
            &self.app,
            &src,
            &p.catalog,
            p.include_byte_roles,
            p.sample_limit,
            p.start_time,
            p.end_time,
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
        let r = match crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)? {
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
        let r = match crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)? {
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
        let r = match crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)? {
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
        let r = match crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)? {
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
        let r = match crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)? {
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
        let r = match crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)? {
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
        let r = match crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)? {
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
        let frame = crate::io::CanTransmitFrame {
            frame_id: p.frame_id,
            data: p.data,
            bus: p.bus,
            is_extended: p.is_extended,
            is_fd: p.is_fd,
            is_brs: false,
            is_rtr: false,
        };
        let result = crate::io::transmit_frame(&p.session_id, &frame).await.map_err(err)?;
        crate::transmit_history::write_entry(
            &p.session_id,
            "can",
            Some(frame.frame_id as i64),
            Some(frame.data.len() as i64),
            &frame.data,
            frame.bus as i64,
            frame.is_extended,
            frame.is_fd,
            result.success,
            result.error.as_deref(),
        );
        crate::ws::dispatch::send_transmit_updated(crate::transmit_history::count());
        ok_json(result)
    }

    #[tool(
        description = "Start a repeating frame transmit through a session at a fixed interval — the same cadence engine that backs the Transmit app's repeat. Returns a queue_id; pass it to repeat_transmit_stop. A frame sent to a serial bus is framed onto that interface, like transmit_frame. interval_ms 250 ≈ 4 Hz.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn repeat_transmit_start(
        &self,
        Parameters(p): Parameters<RepeatTransmitStartParams>,
    ) -> Result<CallToolResult, McpError> {
        let frame = crate::io::CanTransmitFrame {
            frame_id: p.frame_id,
            data: p.data.clone(),
            bus: p.bus,
            is_extended: p.is_extended,
            is_fd: p.is_fd,
            is_brs: false,
            is_rtr: false,
        };
        let seq = REPEAT_SEQ.fetch_add(1, Ordering::Relaxed);
        let queue_id = format!("mcp-repeat-{seq}");
        crate::transmit::io_start_repeat_transmit(
            p.session_id.clone(),
            queue_id.clone(),
            frame,
            p.interval_ms,
        )
        .await
        .map_err(err)?;

        // Surface it in the Transmit UI as an agent-originated queue row so the
        // human and the agent share one visible, controllable queue.
        let profile_id = crate::sessions::get_session_profile_ids(&p.session_id)
            .into_iter()
            .next()
            .unwrap_or_default();
        let profile_name = crate::settings::load_settings_sync(&self.app)
            .ok()
            .and_then(|s| {
                s.io_profiles
                    .iter()
                    .find(|pr| pr.id == profile_id)
                    .map(|pr| pr.name.clone())
            })
            .unwrap_or_else(|| profile_id.clone());
        crate::ws::dispatch::send_repeat_started(&crate::transmit::RepeatStartedEvent {
            queue_id: queue_id.clone(),
            session_id: p.session_id,
            profile_id,
            profile_name,
            frame_id: p.frame_id,
            data: p.data,
            bus: p.bus,
            is_extended: p.is_extended,
            is_fd: p.is_fd,
            interval_ms: p.interval_ms,
            origin: "agent".to_string(),
        });
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
            .into_iter()
            .filter(|f| f.protocol == "can" || f.protocol == "canfd")
            .map(|f| crate::replay::ReplayFrame {
                timestamp_us: f.timestamp_us,
                frame: crate::io::CanTransmitFrame {
                    frame_id: f.frame_id,
                    data: f.bytes,
                    bus: f.bus,
                    is_extended: f.is_extended,
                    is_fd: f.is_fd,
                    is_brs: false,
                    is_rtr: false,
                },
            })
            .collect();

        if replay_frames.is_empty() {
            return Err(err("Capture contains no CAN frames to replay".to_string()));
        }

        let seq = REPLAY_SEQ.fetch_add(1, Ordering::Relaxed);
        let replay_id = format!("mcp-{}-{}", p.capture_id, seq);
        let count = replay_frames.len();
        crate::replay::start_replay(
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
        description = "Live Modbus write to holding registers or coils on a session's configured device. Returns success or the exact device exception. Opens a transient connection — may contend with the running poller.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn modbus_write(
        &self,
        Parameters(p): Parameters<ModbusWriteParams>,
    ) -> Result<CallToolResult, McpError> {
        if p.values.is_empty() {
            return Err(err("No values to write".to_string()));
        }
        let mut ctx = connect_session_modbus(&self.app, &p.session_id).await?;
        let a = p.address;
        match p.register_type.to_lowercase().as_str() {
            "holding" => {
                let r = if p.values.len() == 1 {
                    ctx.write_single_register(a, p.values[0]).await
                } else {
                    ctx.write_multiple_registers(a, &p.values).await
                };
                modbus_write_json("holding", a, &p.values, r)
            }
            "coil" => {
                let bits: Vec<bool> = p.values.iter().map(|v| *v != 0).collect();
                let r = if bits.len() == 1 {
                    ctx.write_single_coil(a, bits[0]).await
                } else {
                    ctx.write_multiple_coils(a, &bits).await
                };
                modbus_write_json("coil", a, &bits, r)
            }
            other => Err(err(format!("register_type '{other}' is not writable (use holding or coil)"))),
        }
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
        let data = crate::hex::parse_bytes(&p.bytes).map_err(|e| err(format!("bytes: {e}")))?;
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
        description = "Stop (and destroy) a running IO session.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = true)
    )]
    async fn stop_session(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
    ) -> Result<CallToolResult, McpError> {
        let state = crate::io::stop_session(&p.session_id).await.map_err(err)?;
        ok_json(state)
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
        let register_type = super::types::parse_register_type(&p.register_type).map_err(err)?;
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
            register_type: super::types::parse_register_type(&p.register_type).map_err(err)?,
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
        let sessions = crate::io::list_sessions().await;
        let session = sessions.iter().find(|s| s.session_id == p.session_id);
        let progress = state.as_ref().and_then(|s| s.progress.clone());
        // No scan state and no session means the sweep finished and cleaned up.
        let status = state
            .as_ref()
            .map(|s| s.status.clone())
            .unwrap_or_else(|| if session.is_some() { "complete" } else { "unknown" }.to_string());
        ok_json(json!({
            "session_id": p.session_id,
            "status": status,
            "current": progress.as_ref().map(|p| p.current),
            "total": progress.as_ref().map(|p| p.total),
            "found_count": progress.as_ref().map(|p| p.found_count),
            "pass": progress.as_ref().map(|p| p.pass),
            "total_passes": progress.as_ref().map(|p| p.total_passes),
            "capture_id": session.and_then(|s| s.capture_id.clone()),
            "frames": session.and_then(|s| s.capture_frame_count),
            "device_info": state.as_ref().map(|s| s.device_info.clone()).unwrap_or_default(),
            "notes": state.map(|s| s.notes).unwrap_or_default(),
        }))
    }
}

// ── Catalog write tools (registered when mcp_allow_catalog_write is on) ───────

#[tool_router(router = catalog_write_router)]
impl WireTapTools {
    #[tool(
        description = "Create a NEW decoder catalog file in the decoder directory. Validates the TOML first and refuses if the file already exists (use update_catalog to overwrite). Requires the catalog-write MCP permission.",
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
        validate_or_reject(&p.content)?;
        crate::catalog::save_catalog(self.app.clone(), path.to_string_lossy().into_owned(), p.content)
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
        let resolved = match p.catalog.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(want) => {
                let catalogs = crate::catalog::list_catalogs(self.app.clone()).await.map_err(err)?;
                let cat = catalogs
                    .iter()
                    .find(|c| {
                        c.filename == want || c.name == want || c.filename == format!("{want}.toml")
                    })
                    .ok_or_else(|| {
                        err(format!(
                            "Catalog '{want}' not found — create it first with create_catalog"
                        ))
                    })?;
                Some(cat.filename.clone())
            }
            None => None,
        };

        let mut settings = crate::settings::load_settings_sync(&self.app).map_err(err)?;
        let profile = settings
            .io_profiles
            .iter_mut()
            .find(|prof| prof.id == p.profile_id)
            .ok_or_else(|| err(format!("Profile '{}' not found", p.profile_id)))?;
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
        description = "Overwrite an EXISTING decoder catalog (by filename or display name). Validates the TOML first and refuses if no such catalog exists (use create_catalog for a new file). Requires the catalog-modify MCP permission.",
        annotations(read_only_hint = false, destructive_hint = true,  idempotent_hint = false)
    )]
    async fn update_catalog(
        &self,
        Parameters(p): Parameters<UpdateCatalogParams>,
    ) -> Result<CallToolResult, McpError> {
        // Resolve an existing catalog by filename or display name.
        let catalogs = crate::catalog::list_catalogs(self.app.clone()).await.map_err(err)?;
        let want = p.filename.trim();
        let cat = catalogs
            .iter()
            .find(|c| c.filename == want || c.name == want || c.filename == format!("{want}.toml"))
            .ok_or_else(|| {
                err(format!("Catalog '{want}' not found — use create_catalog for a new file"))
            })?;
        validate_or_reject(&p.content)?;
        crate::catalog::save_catalog(self.app.clone(), cat.path.clone(), p.content).await.map_err(err)?;
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

#[tool_handler(router = self.tool_router)]
impl ServerHandler for WireTapTools {
    fn get_info(&self) -> ServerInfo {
        // ServerInfo is #[non_exhaustive]; build from Default and set fields.
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        // Must be set explicitly: the `Implementation::default()` behind
        // `ServerInfo::default()` reads the *rmcp* crate's build env, so leaving
        // it alone makes the server introduce itself to clients as "rmcp".
        info.server_info = Implementation::new("wiretap", env!("CARGO_PKG_VERSION"))
            .with_title("WireTAP");
        info.instructions = Some(
            "WireTAP runtime introspection and control for CAN-bus reverse \
             engineering and development. Read tools expose live sessions, captures, \
             frame data, payload analysis and decoded signals. Permission-gated \
             control tools open/stop sessions, transmit one-shot or repeating frames \
             (a repeat is mirrored into the Transmit queue as an Agent-badged, \
             human-controllable row), replay captures, and read/write Modbus. \
             attach_source surfaces a session in a source-aware tab (discovery, \
             decoder, transmit, query, or dashboard) so the human sees what the agent is \
             working on. Tier 2 tools (discovery analysis, decoded signals, live \
             frame map) require the WireTAP window to be open."
                .to_string(),
        );
        info
    }

    fn supported_protocol_versions(&self) -> std::borrow::Cow<'static, [ProtocolVersion]> {
        std::borrow::Cow::Borrowed(SUPPORTED_VERSIONS)
    }

    /// Overridden only to add the freshness hint — `from_server_info` derives
    /// everything else wanted from `get_info()` (including a private cache
    /// scope) but leaves `ttlMs` at zero. Nothing it reports can change without
    /// a server restart, so it is safe to let a client hold onto it.
    async fn discover(
        &self,
        _context: RequestContext<RoleServer>,
    ) -> Result<DiscoverResult, McpError> {
        Ok(DiscoverResult::from_server_info(SUPPORTED_VERSIONS.to_vec(), self.get_info())
            .with_ttl_ms(TOOL_LIST_TTL_MS))
    }

    /// Hand-written so the result can carry the SEP-2549 cache hints — the
    /// `#[tool_handler]` macro only generates `list_tools` when the impl doesn't
    /// already define one. `Private` because the tool set varies with the
    /// permission gates and the endpoint is bearer-gated, so no shared
    /// intermediary may cache it.
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(self.tool_router.list_all())
            .with_ttl_ms(TOOL_LIST_TTL_MS)
            .with_cache_scope(CacheScope::Private))
    }
}
