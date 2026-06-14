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

struct McpHandle {
    cancel: CancellationToken,
    port: u16,
}

static HANDLE: Lazy<Mutex<Option<McpHandle>>> = Lazy::new(|| Mutex::new(None));

/// Whether the MCP server is currently listening.
pub fn is_running() -> bool {
    HANDLE.lock().map(|h| h.is_some()).unwrap_or(false)
}

/// The port the MCP server is listening on, if running.
pub fn running_port() -> Option<u16> {
    HANDLE.lock().ok().and_then(|h| h.as_ref().map(|x| x.port))
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
    token: String,
) -> Result<(), String> {
    if is_running() {
        return Err("MCP server already running".to_string());
    }

    let std_listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("Failed to bind MCP server on 127.0.0.1:{port}: {e}"))?;
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

    if let Ok(mut guard) = HANDLE.lock() {
        *guard = Some(McpHandle { cancel, port });
    }
    tlog!("[mcp] Server listening on 127.0.0.1:{port} (control={allow_control})");
    Ok(())
}

/// Stop the MCP server if running (graceful shutdown via cancellation token).
pub fn stop() {
    if let Ok(mut guard) = HANDLE.lock() {
        if let Some(handle) = guard.take() {
            handle.cancel.cancel();
            tlog!("[mcp] Server stopping on port {}", handle.port);
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
