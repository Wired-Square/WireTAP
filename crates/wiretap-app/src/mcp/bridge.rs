// Copyright 2026 Wired Square Pty Ltd

//! Reverse RPC: lets the Rust backend (driven by the MCP server) ask the
//! frontend for what only the page can do — open a panel, read or drive the
//! DOM. A request is pushed to the frontend over the global WS channel; the
//! frontend replies with a `BridgeResponse` which `resolve` routes back to the
//! awaiting caller.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::Value;
use wslib_mcp::bridge::Pending;

use crate::ws::protocol::{self, MsgType};
use crate::ws::server::{authenticated_connection_count, ws_server};

static PENDING: LazyLock<Pending> = LazyLock::new(Pending::default);

/// Send a request to the frontend and await its JSON response.
///
/// Fails fast (without waiting for `timeout`) when no frontend window is
/// connected, so a window-driving MCP tool returns a clear error instead of hanging.
pub async fn request(method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let server = ws_server().ok_or_else(|| "WebSocket server not running".to_string())?;
    if authenticated_connection_count() == 0 {
        return Err(
            "Frontend not available — this tool drives the WireTAP window, so open it first"
                .to_string(),
        );
    }

    let (id, rx) = PENDING.open();
    let params_bytes = serde_json::to_vec(&params).unwrap_or_default();
    let payload = protocol::encode_bridge_request(id, method, &params_bytes);
    let msg = protocol::encode_message(MsgType::BridgeRequest, 0, &payload);
    server.send_global(msg);
    PENDING.wait(id, rx, timeout).await
}

/// Resolve a pending request from a `BridgeResponse` received over WS.
/// `status` is 0 for success (payload is JSON) or 1 for error (payload is text).
pub fn resolve(correlation_id: u32, status: u8, payload: Vec<u8>) {
    let result = if status == 0 {
        serde_json::from_slice::<Value>(&payload)
            .map_err(|e| format!("Invalid bridge response JSON: {e}"))
    } else {
        Err(String::from_utf8_lossy(&payload).into_owned())
    };
    PENDING.settle(correlation_id, result);
}
