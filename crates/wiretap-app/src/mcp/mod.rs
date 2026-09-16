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

use std::collections::HashMap;
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

    // Built once and shared: under the stateless 2026-07-28 transport the
    // service factory runs on every request, not once per session, so an `Arc`
    // keeps that per-request cost to one refcount bump.
    let tool_router = Arc::new(WireTapTools::router(config));

    // Per server run, not per process — a stop→start must not let the outgoing
    // watchdog's final drain report clients the incoming server just recorded.
    let activity: Activity = Arc::new(Mutex::new(HashMap::new()));
    spawn_idle_watchdog(app.clone(), cancel.clone(), activity.clone());

    let mw = McpMiddleware { token: Arc::new(token), app: app.clone(), activity };
    let service = StreamableHttpService::new(
        move || Ok(WireTapTools::new(app.clone(), tool_router.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_cancellation_token(cancel_for_config)
            // Origin validation is the DNS-rebinding defence the spec requires;
            // rmcp treats an empty allow-list as "allow everything". MCP clients
            // send no Origin at all, so only a browser page is affected — and
            // only a page served from this same loopback port is let through.
            .with_allowed_origins(loopback_origins(port))
            // A tools-only server has nothing to stream: reply with a plain JSON
            // body. rmcp still falls back to SSE if a handler emits first.
            .with_json_response(true),
    );

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

    if let Ok(mut guard) = HANDLE.lock() {
        *guard = Some(McpHandle { cancel, config, token: token_value });
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

/// The `Origin` values a page served from this server's own port could send.
/// Anything else with an `Origin` header is rejected as a rebinding attempt.
fn loopback_origins(port: u16) -> Vec<String> {
    ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .map(|host| format!("http://{host}:{port}"))
        .collect()
}

/// Compare two secrets without leaking their common prefix length through
/// timing. Length is not secret (the token is fixed-width), the value is.
fn secret_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The clients currently considered present, for the session log — keyed by
/// legacy session id, or the empty string for stateless 2026-07-28 traffic
/// (which carries no identity the transport layer can see). The value is the
/// last request seen. Scoped to one server run, not the process.
type Activity = Arc<Mutex<HashMap<String, std::time::Instant>>>;

#[derive(Clone)]
struct McpMiddleware {
    /// Bearer token clients must present (empty = no auth).
    token: Arc<String>,
    app: tauri::AppHandle,
    activity: Activity,
}

/// How long a client may be quiet before the server calls it gone. Protocol
/// 2026-07-28 has no disconnect signal at all, and even a legacy client usually
/// just exits rather than sending `DELETE`, so idleness is the only evidence
/// available for either.
const IDLE_DISCONNECT: std::time::Duration = std::time::Duration::from_secs(90);

fn emit_connection(app: &tauri::AppHandle, event: &str, session_id: &str) {
    let _ = app
        .emit("mcp-connection", serde_json::json!({ "event": event, "session_id": session_id }));
}

/// Record a request against a client, emitting `connected` the first time one is
/// seen. Expiry is the watchdog's job.
fn note_activity(mw: &McpMiddleware, key: &str) {
    let Ok(mut map) = mw.activity.lock() else { return };
    match map.get_mut(key) {
        Some(last) => *last = std::time::Instant::now(),
        None => {
            map.insert(key.to_string(), std::time::Instant::now());
            emit_connection(&mw.app, "connected", key);
        }
    }
}

/// Forget a client and emit `disconnected`. Used for an explicit legacy `DELETE`.
fn drop_activity(mw: &McpMiddleware, key: &str) {
    if mw.activity.lock().map(|mut m| m.remove(key).is_some()).unwrap_or(false) {
        emit_connection(&mw.app, "disconnected", key);
    }
}

/// Emit `disconnected` for any client quiet for [`IDLE_DISCONNECT`], and for
/// every remaining client when the server stops. Without this a client that
/// exits without saying goodbye — which is every stateless one, and most legacy
/// ones — would leave an unmatched "connected" in the log forever.
fn spawn_idle_watchdog(app: tauri::AppHandle, cancel: CancellationToken, activity: Activity) {
    tauri::async_runtime::spawn(async move {
        loop {
            let stopping = tokio::select! {
                _ = cancel.cancelled() => true,
                _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => false,
            };
            // A stopped server means every client is gone, whatever its idle time.
            let idle = if stopping { std::time::Duration::ZERO } else { IDLE_DISCONNECT };
            let expired: Vec<String> = activity
                .lock()
                .map(|mut m| {
                    m.extract_if(|_, last| last.elapsed() >= idle).map(|(k, _)| k).collect()
                })
                .unwrap_or_default();
            for key in expired {
                emit_connection(&app, "disconnected", &key);
            }
            if stopping {
                break;
            }
        }
    });
}

/// Bearer-token gate plus connection logging. Localhost-only bind + this token
/// are the security boundary for the (otherwise read-only) API — note the
/// transport applies a second gate of its own, `Origin` validation, configured
/// on `StreamableHttpServerConfig` in [`start`].
///
/// Connection logging is keyed on activity rather than on a handshake, because
/// 2026-07-28 removed the mechanisms the original version relied on: there is no
/// session id to identify a client by and no `DELETE` to close it with. A
/// stateless client is therefore tracked under the empty key, a legacy one under
/// its session id, and both are expired by [`spawn_idle_watchdog`]. An explicit
/// legacy `DELETE` still disconnects immediately.
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
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|v| secret_eq(v.as_bytes(), mw.token.as_bytes()));
        if !ok {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    let is_delete = req.method() == Method::DELETE;
    let req_session = req
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    // Every 2026-07-28 POST carries Mcp-Method; its absence marks a legacy one.
    let is_stateless = req.headers().contains_key("mcp-method");

    let resp = next.run(req).await;

    if !resp.status().is_success() {
        return Ok(resp);
    }
    // Stateless traffic shares the empty key. A legacy request carries its
    // session id — except the `initialize` that mints it, which returns it on
    // the response.
    let key = if is_stateless {
        String::new()
    } else {
        req_session.unwrap_or_else(|| {
            resp.headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string()
        })
    };
    if is_delete {
        drop_activity(&mw, &key);
    } else {
        note_activity(&mw, &key);
    }

    Ok(resp)
}
