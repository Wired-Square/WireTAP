// Copyright 2026 Wired Square Pty Ltd

//! MCP server — exposes live WireTAP runtime state to an external MCP client
//! over a localhost streamable-HTTP transport. Opt-in via settings; read-only
//! unless `mcp_allow_control` is also enabled. The transport, bearer gate and
//! connection tracking are `wiredai-mcp`'s; this module owns the settings
//! mapping and the start/stop lifecycle. Tier 2 tools reach frontend-only state
//! via [`bridge`].

pub mod bridge;
mod session;
mod tools;
mod types;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use once_cell::sync::Lazy;
use tauri::Emitter;
use wiredai_mcp::CancellationToken;
use wiredai_mcp::http::{self, ConnectionObserver, HttpConfig};
use wiredai_mcp::server::ToolServer;

use tools::WireTapTools;

/// The gates/port/token-presence the server was started with — reported to the
/// settings UI so it can tell when the running server differs from the saved
/// settings and a restart is pending. `token_set` is a presence flag only; the
/// raw token lives in [`McpHandle`] for value comparison.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct McpRunningConfig {
    pub port: u16,
    pub control: bool,
    pub session_control: bool,
    pub catalog_write: bool,
    pub catalog_modify: bool,
    pub dashboard_write: bool,
    pub ui_control: bool,
    pub token_set: bool,
}

impl McpRunningConfig {
    /// The single place the gate list is read off settings. Every caller that
    /// needs "which tools would this configuration expose?" goes through here,
    /// so adding a gate is one edit rather than one per call site.
    pub fn from_settings(s: &crate::settings::AppSettings) -> Self {
        Self {
            port: s.mcp_server_port,
            control: s.mcp_allow_control,
            session_control: s.mcp_allow_session_control,
            catalog_write: s.mcp_allow_catalog_write,
            catalog_modify: s.mcp_allow_catalog_modify,
            dashboard_write: s.mcp_allow_dashboard_write,
            ui_control: s.mcp_allow_ui_control,
            token_set: !s.mcp_server_token.is_empty(),
        }
    }
}

struct McpHandle {
    cancel: CancellationToken,
    config: McpRunningConfig,
    token: String,
}

static HANDLE: Lazy<Mutex<Option<McpHandle>>> = Lazy::new(|| Mutex::new(None));

/// Whether the MCP server is currently listening.
pub fn is_running() -> bool {
    HANDLE.lock().map(|h| h.is_some()).unwrap_or(false)
}

/// The port the MCP server is listening on, if running.
pub fn running_port() -> Option<u16> {
    HANDLE.lock().ok().and_then(|h| h.as_ref().map(|x| x.config.port))
}

/// Whether applying the given desired settings would change the running server
/// — the server should start/stop, or its live gates/port/token differ. The
/// comparison lives here because Rust owns both the running config and the token
/// value; the settings UI just reads the result instead of reconstructing it.
pub fn restart_pending(enabled: bool, desired: McpRunningConfig, token: &str) -> bool {
    match HANDLE.lock().ok().and_then(|g| g.as_ref().map(|h| (h.config, h.token.clone()))) {
        None => enabled,
        Some((config, running_token)) => !enabled || config != desired || running_token != token,
    }
}

/// Start the MCP server on `127.0.0.1:config.port`.
///
/// `config` decides which permission-gated tool groups are registered; `token`
/// is the bearer token clients must present (empty = no auth). Binds
/// synchronously so a port conflict is returned as an error rather than
/// crashing the spawned task.
pub fn start(
    app: tauri::AppHandle,
    mut config: McpRunningConfig,
    token: String,
) -> Result<(), String> {
    if is_running() {
        return Err("MCP server already running".to_string());
    }

    // Derived rather than trusted, so the reported flag cannot disagree with the
    // token actually in force.
    config.token_set = !token.is_empty();
    let port = config.port;

    let listener = http::bind_with_retry(
        SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(2),
    )
    .map_err(|e| e.to_string())?;

    // Built once and shared: under the stateless 2026-07-28 transport the
    // service factory runs on every request, not once per session.
    let router = Arc::new(WireTapTools::router(config));
    let identity = WireTapTools::identity();
    let http_config = HttpConfig {
        bearer_token: (!token.is_empty()).then(|| token.clone()),
        allowed_origins: http::loopback_origins(port),
        observer: Some(Arc::new(TauriConnectionObserver(app.clone()))),
        ..HttpConfig::default()
    };
    let factory = move || {
        ToolServer::new(WireTapTools { app: app.clone() }, router.clone(), identity.clone())
            .with_list_cache(tools::TOOL_LIST_CACHE)
    };

    let cancel = CancellationToken::new();
    let serve_cancel = cancel.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = http::serve(listener, factory, http_config, serve_cancel).await {
            tlog!("[mcp] Server error: {e}");
        }
        tlog!("[mcp] Server task exited");
    });

    if let Ok(mut guard) = HANDLE.lock() {
        *guard = Some(McpHandle { cancel, config, token });
    }
    tlog!("[mcp] Server listening on 127.0.0.1:{port} (control={})", config.control);
    Ok(())
}

/// Stop the MCP server if running (graceful shutdown via cancellation token).
pub fn stop() {
    if let Ok(mut guard) = HANDLE.lock() {
        if let Some(handle) = guard.take() {
            handle.cancel.cancel();
            tlog!("[mcp] Server stopping on port {}", handle.config.port);
        }
    }
}

/// Feeds the Session Manager log: `mcp-connection` events for the client the
/// transport first sees and the one it judges gone.
struct TauriConnectionObserver(tauri::AppHandle);

impl TauriConnectionObserver {
    fn emit(&self, event: &str, session_id: &str) {
        let _ = self.0.emit(
            "mcp-connection",
            serde_json::json!({ "event": event, "session_id": session_id }),
        );
    }
}

impl ConnectionObserver for TauriConnectionObserver {
    fn connected(&self, session_id: &str) {
        self.emit("connected", session_id);
    }

    fn disconnected(&self, session_id: &str) {
        self.emit("disconnected", session_id);
    }
}
