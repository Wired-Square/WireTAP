// Copyright 2026 Wired Square Pty Ltd

//! MCP server — exposes live WireTAP runtime state to an external MCP client
//! over a localhost streamable-HTTP transport. Opt-in via settings; read-only
//! unless `mcp_allow_control` is also enabled. Hosted in Rust (the only layer an
//! external client can reach); Tier 2 tools reach frontend-only state via
//! [`bridge`].

pub mod bridge;
mod session;
mod tools;
mod types;

use std::sync::Arc;
use std::sync::Mutex;

use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header::AUTHORIZATION};
use axum::middleware::Next;
use axum::response::Response;
use once_cell::sync::Lazy;
use tauri::Emitter;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use tokio_util::sync::CancellationToken;

use tools::WireTapTools;

/// The gates/port/token-presence the server was actually started with. Reported
/// to the settings UI so it can tell when the running server differs from the
/// saved settings and a restart is pending.
/// The gates/port/token-presence the server was started with. `token_set` is a
/// presence flag only; the raw token lives in [`McpHandle`] for value comparison.
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

/// Start the MCP server on `127.0.0.1:port`.
///
/// `allow_control` decides whether the control (mutation) tools are registered.
/// `token` is the bearer token clients must present (empty = no auth).
/// Binds synchronously so a port conflict is returned as an error rather than
/// crashing the spawned task.
pub fn start(
    app: tauri::AppHandle,
    port: u16,
    allow_control: bool,
    allow_session_control: bool,
    allow_catalog_write: bool,
    allow_catalog_modify: bool,
    allow_dashboard_write: bool,
    allow_ui_control: bool,
    token: String,
) -> Result<(), String> {
    if is_running() {
        return Err("MCP server already running".to_string());
    }

    let token_set = !token.is_empty();
    let token_value = token.clone();

    // A restart (stop→start on the same port) can race: stop() cancels the old
    // task but the OS may not have released the socket yet, so an immediate bind
    // fails with EADDRINUSE. Retry briefly — the old listener is dropped within a
    // few ms of cancellation. A genuine port conflict still surfaces as an error.
    let std_listener = {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match std::net::TcpListener::bind(("127.0.0.1", port)) {
                Ok(l) => break l,
                Err(e)
                    if e.kind() == std::io::ErrorKind::AddrInUse
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(e) => {
                    return Err(format!("Failed to bind MCP server on 127.0.0.1:{port}: {e}"));
                }
            }
        }
    };
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set MCP listener non-blocking: {e}"))?;

    let cancel = CancellationToken::new();
    let cancel_for_shutdown = cancel.clone();
    let cancel_for_config = cancel.child_token();

    let app_for_mw = app.clone();
    let service = StreamableHttpService::new(
        move || {
            Ok(WireTapTools::new(
                app.clone(),
                allow_control,
                allow_session_control,
                allow_catalog_write,
                allow_catalog_modify,
                allow_dashboard_write,
                allow_ui_control,
            ))
        },
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_cancellation_token(cancel_for_config),
    );

    let mw = McpMiddleware { token: Arc::new(token), app: app_for_mw };
    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(mw, mcp_middleware));

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                tlog!("[mcp] Failed to adopt listener: {e}");
                return;
            }
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                cancel_for_shutdown.cancelled().await;
            })
            .await;
        tlog!("[mcp] Server task exited");
    });

    let config = McpRunningConfig {
        port,
        control: allow_control,
        session_control: allow_session_control,
        catalog_write: allow_catalog_write,
        catalog_modify: allow_catalog_modify,
        dashboard_write: allow_dashboard_write,
        ui_control: allow_ui_control,
        token_set,
    };
    if let Ok(mut guard) = HANDLE.lock() {
        *guard = Some(McpHandle { cancel, config, token: token_value });
    }
    tlog!("[mcp] Server listening on 127.0.0.1:{port} (control={allow_control})");
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

#[derive(Clone)]
struct McpMiddleware {
    /// Bearer token clients must present (empty = no auth).
    token: Arc<String>,
    app: tauri::AppHandle,
}

/// Bearer-token gate plus connection logging. Localhost-only bind + this token
/// are the security boundary for the (otherwise read-only) API. After auth, the
/// `initialize` handshake (a POST with no `mcp-session-id`) and session
/// termination (`DELETE`) are surfaced as a `mcp-connection` event so the
/// session log can show MCP clients connecting and disconnecting.
async fn mcp_middleware(
    State(mw): State<McpMiddleware>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if !mw.token.is_empty() {
        let ok = req
            .headers()
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(|v| v == format!("Bearer {}", mw.token.as_str()))
            .unwrap_or(false);
        if !ok {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    let method = req.method().clone();
    let req_session = req
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let resp = next.run(req).await;

    let emit = |event: &str, session_id: String| {
        let _ = mw
            .app
            .emit("mcp-connection", serde_json::json!({ "event": event, "session_id": session_id }));
    };
    if method == Method::POST && req_session.is_none() && resp.status().is_success() {
        // initialize handshake → a new client connected
        let sid = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        emit("connected", sid);
    } else if method == Method::DELETE {
        emit("disconnected", req_session.unwrap_or_default());
    }

    Ok(resp)
}
