// Copyright (c) 2026, Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// FrameLink connection manager. FrameLink devices accept exactly one TCP
// client, so all operations — session streaming AND signal read/write — must
// share a single connection per device.
//
// Connection lifecycle:
//   - Created on first use (session_acquire or request)
//   - session_acquire/session_release track session-tier references
//   - request() uses the connection without touching session_refs

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use framelink::codec::frame::Frame;
use framelink::protocol::capabilities::decode_capabilities;
use framelink::protocol::types::{FLAG_ACK_REQ, MSG_CAPABILITIES_REQ};
use framelink::session::FrameLinkSession;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;

use super::{FrameLinkProbeResult, ProbeInterface};

// ============================================================================
// Types
// ============================================================================

/// Managed connection state for a single FrameLink device.
pub(crate) struct ManagedConnection {
    pub session: Arc<FrameLinkSession>,
    pub iface_types: HashMap<u8, u8>,
    pub probe_cache: FrameLinkProbeResult,
    session_refs: AtomicUsize,
}

// ============================================================================
// Global Pool
// ============================================================================

static POOL: Lazy<Mutex<HashMap<String, Arc<ManagedConnection>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Persistent device_id → (host, port) mapping.
/// Populated when a connection's capabilities reveal a device_id.
/// NOT cleared when connections drop — allows automatic reconnection.
static DEVICE_MAP: Lazy<Mutex<HashMap<String, (String, u16)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ============================================================================
// Internal — ensure_connection
// ============================================================================

/// Ensure a managed connection exists for the given host:port.
/// Creates the connection, fetches capabilities, and returns it.
/// session_refs left unchanged (callers increment as needed).
async fn ensure_connection(
    host: &str,
    port: u16,
    timeout_sec: f64,
) -> Result<Arc<ManagedConnection>, String> {
    let key = format!("{}:{}", host, port);
    let mut pool = POOL.lock().await;

    if let Some(conn) = pool.get(&key) {
        if conn.session.is_alive() {
            return Ok(conn.clone());
        }
        pool.remove(&key);
    }

    // Drop pool lock before I/O
    drop(pool);

    let addr = key
        .parse()
        .map_err(|e| format!("Invalid address {}: {}", key, e))?;

    let session = tokio::time::timeout(
        Duration::from_secs_f64(timeout_sec),
        FrameLinkSession::connect(addr),
    )
    .await
    .map_err(|_| format!("Connection to {} timed out", key))?
    .map_err(|e| format!("Connection to {} failed: {}", key, e))?;

    let (iface_types, probe_cache) =
        fetch_capabilities(&session, &key, timeout_sec).await;

    let conn = Arc::new(ManagedConnection {
        session,
        iface_types,
        probe_cache,
        session_refs: AtomicUsize::new(1),
    });

    tlog!("[framelink:{}] Created managed connection", key);

    // Re-acquire pool lock — check for race
    let mut pool = POOL.lock().await;
    if let Some(existing) = pool.get(&key) {
        if existing.session.is_alive() {
            tlog!("[framelink:{}] Discarding duplicate connection (race)", key);
            drop(conn);
            return Ok(existing.clone());
        }
    }
    pool.insert(key, conn.clone());
    Ok(conn)
}

/// Fetch capabilities from a freshly connected session.
async fn fetch_capabilities(
    session: &Arc<FrameLinkSession>,
    key: &str,
    timeout_sec: f64,
) -> (HashMap<u8, u8>, FrameLinkProbeResult) {
    let empty_probe = || FrameLinkProbeResult {
        device_id: None,
        board_name: None,
        board_revision: None,
        interfaces: vec![],
    };

    let frame = match tokio::time::timeout(
        Duration::from_secs_f64(timeout_sec),
        session.request(MSG_CAPABILITIES_REQ, FLAG_ACK_REQ, &[]),
    )
    .await
    {
        Ok(Ok(f)) => f,
        Ok(Err(e)) => {
            tlog!("[framelink:{}] Capabilities request failed: {}", key, e);
            return (HashMap::new(), empty_probe());
        }
        Err(_) => {
            tlog!("[framelink:{}] Capabilities request timed out", key);
            return (HashMap::new(), empty_probe());
        }
    };

    let caps = match decode_capabilities(&frame.payload) {
        Ok(c) => c,
        Err(e) => {
            tlog!("[framelink:{}] Failed to decode capabilities: {}", key, e);
            return (HashMap::new(), empty_probe());
        }
    };

    let iface_types: HashMap<u8, u8> = caps
        .interfaces
        .iter()
        .map(|i| (i.index, i.iface_type))
        .collect();

    let device_id = caps.device_id().map(|s| s.to_string());
    let board_name = caps.board_name().map(|s| s.to_string());
    let board_revision = caps.board_revision().map(|s| s.to_string());

    if let Some(ref did) = device_id {
        if let Some((host, port_str)) = key.rsplit_once(':') {
            if let Ok(port) = port_str.parse::<u16>() {
                DEVICE_MAP
                    .lock()
                    .await
                    .insert(did.clone(), (host.to_string(), port));
            }
        }
    }

    let board_def = board_name.as_deref().and_then(|name| {
        board_revision
            .as_deref()
            .and_then(|rev| framelink::board::load_board_def(name, rev))
    });

    let interfaces: Vec<ProbeInterface> = caps
        .interfaces
        .iter()
        .map(|iface| {
            let name = board_def
                .as_ref()
                .and_then(|bd| bd.interface_name(iface.index))
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    let type_name =
                        framelink::protocol::types::interface_name(iface.iface_type);
                    format!("{} {}", type_name, iface.index)
                });
            ProbeInterface {
                index: iface.index,
                iface_type: iface.iface_type,
                name,
            }
        })
        .collect();

    let probe = FrameLinkProbeResult {
        device_id,
        board_name,
        board_revision,
        interfaces,
    };

    (iface_types, probe)
}

// ============================================================================
// Public API — Session Tier
// ============================================================================

/// Acquire a managed connection for session streaming.
/// Increments session_refs; the connection stays alive while any session holds a ref.
pub(crate) async fn session_acquire(
    host: &str,
    port: u16,
    timeout_sec: f64,
) -> Result<Arc<ManagedConnection>, String> {
    let conn = ensure_connection(host, port, timeout_sec).await?;
    let refs = conn.session_refs.fetch_add(1, Ordering::SeqCst) + 1;
    tlog!(
        "[framelink:{}:{}] Session acquired (refs={})",
        host,
        port,
        refs
    );
    Ok(conn)
}

/// Release a session reference.
pub(crate) async fn session_release(host: &str, port: u16) {
    let key = format!("{}:{}", host, port);
    let pool = POOL.lock().await;

    if let Some(conn) = pool.get(&key) {
        let prev = conn.session_refs.load(Ordering::SeqCst);
        if prev == 0 {
            tlog!(
                "[framelink:{}] Session release called but refs already 0 — skipping decrement",
                key
            );
        } else {
            conn.session_refs.fetch_sub(1, Ordering::SeqCst);
            tlog!(
                "[framelink:{}] Session released (refs={})",
                key,
                prev - 1
            );
        }
    }
}

// ============================================================================
// Public API — Request Tier
// ============================================================================

/// Send a request/response message through the managed connection.
/// Creates the connection on demand if needed (without touching session_refs).
pub(crate) async fn request(
    host: &str,
    port: u16,
    msg_type: u8,
    flags: u8,
    payload: &[u8],
    timeout_sec: f64,
) -> Result<Frame, String> {
    let conn = ensure_connection(host, port, timeout_sec).await?;
    conn.session
        .request(msg_type, flags, payload)
        .await
        .map_err(|e| e.to_string())
}

/// Send a request that returns multiple RESP frames before the final ACK/NACK.
pub(crate) async fn request_multi(
    host: &str,
    port: u16,
    msg_type: u8,
    flags: u8,
    payload: &[u8],
    timeout_sec: f64,
) -> Result<Vec<Frame>, String> {
    let conn = ensure_connection(host, port, timeout_sec).await?;
    conn.session
        .request_multi(msg_type, flags, payload)
        .await
        .map_err(|e| e.to_string())
}

/// Send multiple messages pipelined and collect responses.
pub(crate) async fn request_batch(
    host: &str,
    port: u16,
    messages: Vec<(u8, u8, Vec<u8>)>,
    timeout_sec: f64,
) -> Result<Vec<Frame>, String> {
    let conn = ensure_connection(host, port, timeout_sec).await?;
    conn.session
        .send_batch(&messages)
        .await
        .map_err(|e| e.to_string())
}

// ============================================================================
// Public API — Query
// ============================================================================

/// Return cached probe data if a managed connection already exists.
pub(crate) async fn get_cached_probe(host: &str, port: u16) -> Option<FrameLinkProbeResult> {
    let key = format!("{}:{}", host, port);
    let pool = POOL.lock().await;
    pool.get(&key)
        .filter(|conn| conn.session.is_alive())
        .map(|conn| conn.probe_cache.clone())
}

/// Return cached board name and revision if a managed connection exists.
pub(crate) async fn get_cached_board_info(
    host: &str,
    port: u16,
) -> Option<(String, String)> {
    let key = format!("{}:{}", host, port);
    let pool = POOL.lock().await;
    pool.get(&key)
        .filter(|conn| conn.session.is_alive())
        .and_then(|conn| {
            let name = conn.probe_cache.board_name.as_ref()?;
            let rev = conn.probe_cache.board_revision.as_ref()?;
            Some((name.clone(), rev.clone()))
        })
}

/// Load the board definition for the device at host:port, using cached board info.
pub(crate) async fn load_board_def(host: &str, port: u16) -> Option<framelink::board::BoardDef> {
    get_cached_board_info(host, port)
        .await
        .and_then(|(name, rev)| framelink::board::load_board_def(&name, &rev))
}

/// Return the interface type for a given interface index from a managed connection.
pub(crate) async fn get_iface_type(host: &str, port: u16, iface_index: u8) -> Option<u8> {
    let key = format!("{}:{}", host, port);
    let pool = POOL.lock().await;
    pool.get(&key)
        .filter(|conn| conn.session.is_alive())
        .and_then(|conn| conn.iface_types.get(&iface_index).copied())
}

/// Resolve a device_id to its (host, port).
/// First checks the active connection pool. If not found, falls back to the
/// persistent device map and reconnects automatically.
pub(crate) async fn resolve_device_id(device_id: &str) -> Option<(String, u16)> {
    {
        let pool = POOL.lock().await;
        for (key, conn) in pool.iter() {
            if !conn.session.is_alive() {
                continue;
            }
            if let Some(ref did) = conn.probe_cache.device_id {
                if did == device_id {
                    if let Some((host, port_str)) = key.rsplit_once(':') {
                        if let Ok(port) = port_str.parse::<u16>() {
                            return Some((host.to_string(), port));
                        }
                    }
                }
            }
        }
    }

    let addr = {
        let map = DEVICE_MAP.lock().await;
        map.get(device_id).cloned()
    };
    if let Some((host, port)) = addr {
        tlog!(
            "[framelink] Reconnecting to {} ({}:{}) from device map",
            device_id, host, port
        );
        match ensure_connection(&host, port, 5.0).await {
            Ok(_) => return Some((host, port)),
            Err(e) => {
                tlog!(
                    "[framelink] Reconnection to {} failed: {}",
                    device_id, e
                );
            }
        }
    }

    None
}
