// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

//! Reverse RPC: lets the Rust backend (driven by the MCP server) ask the
//! frontend for state only it holds — payload analysis, decoded signals, the
//! live discovery buffer. A request is pushed to the frontend over the global
//! WS channel; the frontend replies with a `BridgeResponse` which `resolve`
//! routes back to the awaiting caller.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::ws::protocol::{self, MsgType};
use crate::ws::server::{authenticated_connection_count, ws_server};

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Pending requests keyed by correlation id, awaiting a frontend response.
static PENDING: Lazy<Mutex<HashMap<u32, oneshot::Sender<Result<Value, String>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Send a request to the frontend and await its JSON response.
///
/// Fails fast (without waiting for `timeout`) when no frontend window is
/// connected, so Tier 2 MCP tools return a clear error instead of hanging.
pub async fn request(method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let server = ws_server().ok_or_else(|| "WebSocket server not running".to_string())?;
    if authenticated_connection_count() == 0 {
        return Err(
            "Frontend not available — open the WireTAP window and the relevant \
             (Discovery/Decoder) view to use this tool"
                .to_string(),
        );
    }

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    if let Ok(mut pending) = PENDING.lock() {
        pending.insert(id, tx);
    }

    let params_bytes = serde_json::to_vec(&params).unwrap_or_default();
    let payload = protocol::encode_bridge_request(id, method, &params_bytes);
    let msg = protocol::encode_message(MsgType::BridgeRequest, 0, &payload);
    server.send_global(msg);

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            remove(id);
            Err("Bridge request cancelled".to_string())
        }
        Err(_) => {
            remove(id);
            Err(format!("Bridge request '{method}' timed out — is a relevant view open?"))
        }
    }
}

fn remove(id: u32) {
    if let Ok(mut pending) = PENDING.lock() {
        pending.remove(&id);
    }
}

/// Resolve a pending request from a `BridgeResponse` received over WS.
/// `status` is 0 for success (payload is JSON) or 1 for error (payload is text).
pub fn resolve(correlation_id: u32, status: u8, payload: Vec<u8>) {
    let tx = match PENDING.lock().ok().and_then(|mut p| p.remove(&correlation_id)) {
        Some(tx) => tx,
        None => return,
    };
    let result = if status == 0 {
        serde_json::from_slice::<Value>(&payload)
            .map_err(|e| format!("Invalid bridge response JSON: {e}"))
    } else {
        Err(String::from_utf8_lossy(&payload).into_owned())
    };
    let _ = tx.send(result);
}
