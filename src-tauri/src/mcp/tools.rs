// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

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

/// Counter for generating unique replay IDs without a clock/RNG.
static REPLAY_SEQ: AtomicU64 = AtomicU64::new(1);

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
pub struct WireTapTools {
    app: tauri::AppHandle,
    tool_router: ToolRouter<WireTapTools>,
}

impl WireTapTools {
    pub fn new(app: tauri::AppHandle, allow_control: bool) -> Self {
        let tool_router = if allow_control {
            Self::read_router() + Self::control_router()
        } else {
            Self::read_router()
        };
        Self { app, tool_router }
    }
}

fn err(message: impl Into<String>) -> McpError {
    McpError::internal_error(message.into(), None)
}

fn ok_json<T: serde::Serialize>(value: T) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![Content::json(value)?]))
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

    #[tool(description = "Stop a running IO session.")]
    async fn stop_session(
        &self,
        Parameters(p): Parameters<SessionIdParams>,
    ) -> Result<CallToolResult, McpError> {
        let state = crate::io::stop_session(&p.session_id).await.map_err(err)?;
        ok_json(state)
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

#[tool_handler(router = self.tool_router)]
impl ServerHandler for WireTapTools {
    fn get_info(&self) -> ServerInfo {
        // ServerInfo is #[non_exhaustive]; build from Default and set fields.
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "WireTAP runtime introspection for CAN-bus reverse engineering and \
             development. Read tools expose live sessions, captures, frame data, \
             payload analysis and decoded signals. Tier 2 tools (discovery analysis, \
             decoded signals, live frame map) require the WireTAP window to be open."
                .to_string(),
        );
        info
    }
}
