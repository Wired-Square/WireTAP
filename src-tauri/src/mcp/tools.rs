// Copyright 2026 Wired Square Pty Ltd

//! MCP tool definitions. Read tools are always available; control (mutation)
//! tools are only merged into the router when `mcp_allow_control` is on.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio_modbus::client::tcp;
use tokio_modbus::prelude::*;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, ServerCapabilities, ServerInfo};
use rmcp::{ErrorData as McpError, ServerHandler, tool, tool_handler, tool_router};
use serde_json::json;

use super::types::*;
use crate::analysis::QuerySource;

/// Counter for generating unique replay IDs without a clock/RNG.
static REPLAY_SEQ: AtomicU64 = AtomicU64::new(1);
static REPEAT_SEQ: AtomicU64 = AtomicU64::new(1);

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct WireTapTools {
    app: tauri::AppHandle,
    tool_router: ToolRouter<WireTapTools>,
}

impl WireTapTools {
    pub fn new(
        app: tauri::AppHandle,
        allow_control: bool,
        allow_session_control: bool,
        allow_catalog_write: bool,
        allow_catalog_modify: bool,
        allow_dashboard_write: bool,
        allow_ui_control: bool,
    ) -> Self {
        let mut tool_router = Self::read_router();
        if allow_control {
            tool_router = tool_router + Self::control_router();
        }
        if allow_session_control {
            tool_router = tool_router + Self::session_control_router();
        }
        if allow_catalog_write {
            tool_router = tool_router + Self::catalog_write_router();
        }
        if allow_catalog_modify {
            tool_router = tool_router + Self::catalog_modify_router();
        }
        if allow_dashboard_write {
            tool_router = tool_router + Self::dashboard_write_router();
        }
        if allow_ui_control {
            tool_router = tool_router + Self::ui_control_router();
        }
        Self { app, tool_router }
    }
}

fn err(message: impl Into<String>) -> McpError {
    McpError::internal_error(message.into(), None)
}

fn ok_json<T: serde::Serialize>(value: T) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![Content::json(value)?]))
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
    let name = filename.trim();
    if name.is_empty() {
        return Err(err("Catalog filename is empty"));
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(err(format!(
            "Invalid catalog filename '{name}' — must be a bare name with no path separators"
        )));
    }
    let name = if name.to_lowercase().ends_with(".toml") {
        name.to_string()
    } else {
        format!("{name}.toml")
    };
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

/// Open a transient Modbus TCP connection to the device behind a session's
/// source profile. NB: opens a second connection alongside the running poller —
/// single-connection devices may contend.
async fn connect_session_modbus(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<tokio_modbus::client::Context, McpError> {
    let profile_id = crate::sessions::get_session_profile_ids(session_id)
        .into_iter()
        .next()
        .ok_or_else(|| err(format!("Session '{session_id}' has no source profile")))?;
    let settings = crate::settings::load_settings_sync(app).map_err(err)?;
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| err(format!("Profile '{profile_id}' not found")))?;
    let conn = &profile.connection;
    let host = conn.get("host").and_then(|v| v.as_str()).unwrap_or("127.0.0.1");
    let port = conn
        .get("port")
        .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_i64().map(|n| n as u16)))
        .unwrap_or(502);
    let unit_id = conn
        .get("unit_id")
        .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_i64().map(|n| n as u8)))
        .unwrap_or(1);
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| err(format!("Invalid Modbus address {host}:{port}: {e}")))?;
    tcp::connect_slave(addr, Slave(unit_id))
        .await
        .map_err(|e| err(format!("Connect to {addr} (unit {unit_id}) failed: {e}")))
}

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

    #[tool(description = "Query frames from a capture, optionally filtered to a single frame id (decimal).")]
    async fn query_capture_frames(
        &self,
        Parameters(p): Parameters<QueryFramesParams>,
    ) -> Result<CallToolResult, McpError> {
        let selected: HashSet<u32> = p.frame_id.into_iter().collect();
        let (frames, _idx, total) = crate::capture_store::get_capture_frames_paginated_filtered(
            &p.capture_id,
            p.offset,
            p.count,
            &selected,
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

    #[tool(description = "List the decoder catalogs (TOML) in the decoder directory, with name, filename and path.")]
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

    // ── Headless analysis levers (capture OR postgres) ───────────────────────

    #[tool(description = "Per-frame-id rollup (count, first/last timestamp, max dlc, extended) for a capture (capture_id) or postgres profile (profile_id). Headless — no view needed. Use to see which frame ids exist and how often.")]
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
        let profile =
            crate::analysis::byte_profile(&self.app, &src, p.frame_id, p.is_extended, p.sample_limit)
                .await
                .map_err(err)?;
        ok_json(profile)
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

    // ── Exposed analytical engines (dispatch capture vs postgres) ────────────

    #[tool(description = "Find timestamps where one payload byte of a frame changed value. Source: capture_id or profile_id.")]
    async fn query_byte_changes(
        &self,
        Parameters(p): Parameters<ByteQueryParams>,
    ) -> Result<CallToolResult, McpError> {
        let r = match crate::analysis::resolve(p.capture_id, p.profile_id).map_err(err)? {
            QuerySource::Postgres(pid) => {
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
            QuerySource::Postgres(pid) => {
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
            QuerySource::Postgres(pid) => {
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
            QuerySource::Postgres(pid) => {
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
            QuerySource::Postgres(pid) => {
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
            QuerySource::Postgres(pid) => {
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
            QuerySource::Postgres(pid) => {
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
    #[tool(description = "Transmit a CAN frame through a session. Requires a transmit-capable session.")]
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

    #[tool(description = "Start a repeating frame transmit through a session at a fixed interval — the same cadence engine that backs the Transmit app's repeat. Returns a queue_id; pass it to repeat_transmit_stop. A frame sent to a serial bus is framed onto that interface, like transmit_frame. interval_ms 250 ≈ 4 Hz.")]
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

    #[tool(description = "Stop a repeating transmit started by repeat_transmit_start, by its queue_id.")]
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

    #[tool(description = "Replay all CAN frames from a capture through a session with original timing. Returns a replay_id.")]
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

    #[tool(description = "Stop a running replay by its replay_id.")]
    async fn stop_replay(
        &self,
        Parameters(p): Parameters<ReplayIdParams>,
    ) -> Result<CallToolResult, McpError> {
        crate::replay::io_stop_replay(p.replay_id.clone()).await.map_err(err)?;
        ok_json(json!({ "stopped": p.replay_id }))
    }

    #[tool(description = "Live Modbus write to holding registers or coils on a session's configured device. Returns success or the exact device exception. Opens a transient connection — may contend with the running poller.")]
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
    #[tool(description = "Open (create + start) a session for an IO profile. For Modbus profiles, poll groups are built from the profile's preferred catalog so it polls immediately. Returns the new session_id.")]
    async fn open_session(
        &self,
        Parameters(p): Parameters<OpenSessionParams>,
    ) -> Result<CallToolResult, McpError> {
        let result = super::session::open(self.app.clone(), p.profile_id, p.session_id)
            .await
            .map_err(err)?;
        ok_json(result)
    }

    #[tool(description = "Stop (and destroy) a running IO session.")]
    async fn stop_session(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
    ) -> Result<CallToolResult, McpError> {
        let state = crate::io::stop_session(&p.session_id).await.map_err(err)?;
        ok_json(state)
    }

    #[tool(description = "Surface an existing session in a source-aware tab so a human can see it. Opens or focuses the given tab (discovery, decoder, transmit, query, or graph) and points it at the session, replacing any source it is currently showing.")]
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
}

// ── Catalog write tools (registered when mcp_allow_catalog_write is on) ───────

#[tool_router(router = catalog_write_router)]
impl WireTapTools {
    #[tool(description = "Create a NEW decoder catalog file in the decoder directory. Validates the TOML first and refuses if the file already exists (use update_catalog to overwrite). Requires the catalog-write MCP permission.")]
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
        crate::catalog::save_catalog(path.to_string_lossy().into_owned(), p.content)
            .await
            .map_err(err)?;
        ok_json(json!({ "created": true, "path": path.to_string_lossy() }))
    }
}

// ── Catalog modify tools (registered when mcp_allow_catalog_modify is on) ─────

#[tool_router(router = catalog_modify_router)]
impl WireTapTools {
    #[tool(description = "Overwrite an EXISTING decoder catalog (by filename or display name). Validates the TOML first and refuses if no such catalog exists (use create_catalog for a new file). Requires the catalog-modify MCP permission.")]
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
        crate::catalog::save_catalog(cat.path.clone(), p.content).await.map_err(err)?;
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
    #[tool(description = "Create or overwrite a dashboard artifact (*.dashboard.json, schema \"wiretap.dashboard/1\") in the dashboards directory. Validates the JSON shape and that every panel type is a known widget. Any embedded custom-widget code is stored opaque and only ever runs later inside the frontend's sandboxed worker — it is NOT executed here. Requires the dashboard-write MCP permission.")]
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
    #[tool(description = "Open (or focus) an app/panel in the running WireTAP window, e.g. \"dashboard\", \"discovery\", \"decoder\", \"query\". Pass args like { \"dashboardPath\": \"…\" } to load a dashboard before opening it. Requires an open WireTAP window and the ui-control MCP permission.")]
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
        info.instructions = Some(
            "WireTAP runtime introspection and control for CAN-bus reverse \
             engineering and development. Read tools expose live sessions, captures, \
             frame data, payload analysis and decoded signals. Permission-gated \
             control tools open/stop sessions, transmit one-shot or repeating frames \
             (a repeat is mirrored into the Transmit queue as an Agent-badged, \
             human-controllable row), replay captures, and read/write Modbus. \
             attach_source surfaces a session in a source-aware tab (discovery, \
             decoder, transmit, query, or graph) so the human sees what the agent is \
             working on. Tier 2 tools (discovery analysis, decoded signals, live \
             frame map) require the WireTAP window to be open."
                .to_string(),
        );
        info
    }
}
