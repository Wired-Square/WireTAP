// Copyright (c) 2026, Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// FrameLink connection manager. FrameLink devices accept exactly one TCP
// client, so all operations — session streaming AND signal read/write — must
// share a single connection per device.
//
// Pool keyed by device_id (from capabilities). Bootstrap via connect_by_address,
// then all operations use device_id.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

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
    pub addr: SocketAddr,
    pub iface_types: HashMap<u8, u8>,
    pub probe_cache: FrameLinkProbeResult,
    pub editable_board_def: std::sync::Mutex<Option<framelink::board::editable::EditableBoardDef>>,
    session_refs: AtomicUsize,
}

// ============================================================================
// Global Pool — keyed by device_id
// ============================================================================

static POOL: Lazy<Mutex<HashMap<String, Arc<ManagedConnection>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Per-key connection lock — prevents duplicate TCP connections to the same device.
static CONNECTING: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Remove a per-key connecting lock entry.
async fn cleanup_connecting(race_key: &str) {
    let mut connecting = CONNECTING.lock().await;
    connecting.remove(race_key);
}

// ============================================================================
// Bootstrap — connect by address
// ============================================================================

/// Connect by address, fetch capabilities, return device_id.
/// This is the only function that takes host:port — all others use device_id.
pub(crate) async fn connect_by_address(
    host: &str,
    port: u16,
    timeout_sec: f64,
) -> Result<String, String> {
    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .map_err(|e| format!("Invalid address {}:{}: {}", host, port, e))?;

    let race_key = format!("addr:{}:{}", host, port);

    // Per-key lock: only one connection attempt per address at a time
    let lock = {
        let mut connecting = CONNECTING.lock().await;
        connecting
            .entry(race_key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;

    // Check if this address already has a live connection in the pool
    {
        let pool = POOL.lock().await;
        for (device_id, conn) in pool.iter() {
            if conn.addr == addr && conn.session.is_alive() {
                return Ok(device_id.clone());
            }
        }
    }

    // Create new connection
    let display_key = format!("{}:{}", host, port);
    let session = tokio::time::timeout(
        Duration::from_secs_f64(timeout_sec),
        FrameLinkSession::connect(addr),
    )
    .await
    .map_err(|_| format!("Connection to {} timed out", display_key))?
    .map_err(|e| format!("Connection to {} failed: {}", display_key, e))?;

    let (iface_types, probe_cache, editable_board_def) =
        fetch_capabilities(&session, &display_key, timeout_sec).await;

    let device_id = probe_cache
        .device_id
        .clone()
        .unwrap_or_else(|| display_key.clone());

    let conn = Arc::new(ManagedConnection {
        session,
        addr,
        iface_types,
        probe_cache,
        editable_board_def: std::sync::Mutex::new(editable_board_def),
        session_refs: AtomicUsize::new(0),
    });

    // Insert into pool by device_id
    let mut pool = POOL.lock().await;
    if let Some(existing) = pool.get(&device_id) {
        if existing.session.is_alive() {
            tlog!("[framelink:{}] Discarding duplicate connection (race)", device_id);
            cleanup_connecting(&race_key).await;
            return Ok(device_id);
        }
    }
    pool.insert(device_id.clone(), conn);
    tlog!("[framelink:{}] Created managed connection ({})", device_id, display_key);
    drop(pool);

    cleanup_connecting(&race_key).await;
    Ok(device_id)
}

// ============================================================================
// Internal — fetch capabilities
// ============================================================================

/// Load the embedded board def by name and revision as a fallback.
fn embedded_board_def_fallback(
    board_name: &Option<String>,
    board_revision: &Option<String>,
) -> (
    Option<framelink::board::BoardDef>,
    Option<framelink::board::editable::EditableBoardDef>,
) {
    let bd = board_name.as_deref().and_then(|name| {
        board_revision
            .as_deref()
            .and_then(|rev| framelink::board::load_board_def(name, rev))
    });
    let ed = bd
        .as_ref()
        .map(framelink::board::editable::EditableBoardDef::from_board_def);
    (bd, ed)
}

/// Fetch capabilities from a freshly connected session.
async fn fetch_capabilities(
    session: &Arc<FrameLinkSession>,
    key: &str,
    timeout_sec: f64,
) -> (
    HashMap<u8, u8>,
    FrameLinkProbeResult,
    Option<framelink::board::editable::EditableBoardDef>,
) {
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
            return (HashMap::new(), empty_probe(), None);
        }
        Err(_) => {
            tlog!("[framelink:{}] Capabilities request timed out", key);
            return (HashMap::new(), empty_probe(), None);
        }
    };

    let caps = match decode_capabilities(&frame.payload) {
        Ok(c) => c,
        Err(e) => {
            tlog!("[framelink:{}] Failed to decode capabilities: {}", key, e);
            return (HashMap::new(), empty_probe(), None);
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

    // Try downloading the device TOML first; fall back to embedded board def
    let (board_def, editable) = match framelink::board::transfer::download_board_def(session)
        .await
    {
        Ok(Some(toml_str)) => {
            tlog!(
                "[framelink:{}] Downloaded device TOML ({} bytes)",
                key,
                toml_str.len()
            );
            let ed = framelink::board::editable::EditableBoardDef::from_toml(&toml_str).ok();
            let bd = framelink::board::parse_board_def(&toml_str).ok();
            (bd, ed)
        }
        Ok(None) => {
            tlog!(
                "[framelink:{}] No device TOML stored, using embedded board def",
                key
            );
            embedded_board_def_fallback(&board_name, &board_revision)
        }
        Err(e) => {
            tlog!(
                "[framelink:{}] Board def download failed ({}), using embedded board def",
                key,
                e
            );
            embedded_board_def_fallback(&board_name, &board_revision)
        }
    };

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
                type_name: framelink::protocol::types::interface_name(iface.iface_type).to_string(),
            }
        })
        .collect();

    let probe = FrameLinkProbeResult {
        device_id,
        board_name,
        board_revision,
        interfaces,
    };

    (iface_types, probe, editable)
}

// ============================================================================
// Public API — Connection (by device_id)
// ============================================================================

/// Get or reconnect a managed connection by device_id.
/// If the connection is dead, reconnects using the last known address.
/// If the device is not in the pool, discovers it via mDNS and connects.
pub(crate) async fn get_connection(
    device_id: &str,
    timeout_sec: f64,
) -> Result<Arc<ManagedConnection>, String> {
    let pool = POOL.lock().await;

    if let Some(conn) = pool.get(device_id) {
        if conn.session.is_alive() {
            return Ok(conn.clone());
        }
        // Dead connection — reconnect using last known address
        let addr = conn.addr;
        drop(pool);
        let host = addr.ip().to_string();
        let port = addr.port();
        connect_by_address(&host, port, timeout_sec).await?;
        let pool = POOL.lock().await;
        pool.get(device_id)
            .cloned()
            .ok_or_else(|| format!("Reconnection to '{}' failed", device_id))
    } else {
        drop(pool);
        // Not in pool — discover via mDNS and connect
        let timeout = Duration::from_secs_f64(timeout_sec);
        let devices = framelink::discovery::discover(timeout)
            .await
            .map_err(|e| format!("mDNS discovery failed: {}", e))?;

        let device = devices
            .into_iter()
            .find(|d| d.name == device_id)
            .ok_or_else(|| format!("Device '{}' not found via discovery", device_id))?;

        let host = device.addr.ip().to_string();
        let port = device.addr.port();
        connect_by_address(&host, port, timeout_sec).await?;

        let pool = POOL.lock().await;
        pool.get(device_id)
            .cloned()
            .ok_or_else(|| format!("Connection to '{}' failed after discovery", device_id))
    }
}

// ============================================================================
// Public API — Session Tier
// ============================================================================

/// Acquire a managed connection for session streaming.
/// Increments session_refs for diagnostics.
pub(crate) async fn session_acquire(
    device_id: &str,
    timeout_sec: f64,
) -> Result<Arc<ManagedConnection>, String> {
    let conn = get_connection(device_id, timeout_sec).await?;
    let refs = conn.session_refs.fetch_add(1, Ordering::SeqCst) + 1;
    tlog!("[framelink:{}] Session acquired (refs={})", device_id, refs);
    Ok(conn)
}

/// Release a session reference.
pub(crate) async fn session_release(device_id: &str) {
    let pool = POOL.lock().await;
    if let Some(conn) = pool.get(device_id) {
        let prev = conn.session_refs.load(Ordering::SeqCst);
        if prev > 0 {
            conn.session_refs.fetch_sub(1, Ordering::SeqCst);
            tlog!(
                "[framelink:{}] Session released (refs={})",
                device_id,
                prev - 1
            );
        }
    }
}

// ============================================================================
// Public API — Query (by device_id)
// ============================================================================

/// Return cached probe data if a managed connection exists for this device.
pub(crate) async fn get_cached_probe(device_id: &str) -> Option<FrameLinkProbeResult> {
    let pool = POOL.lock().await;
    pool.get(device_id)
        .filter(|conn| conn.session.is_alive())
        .map(|conn| conn.probe_cache.clone())
}

/// Search the pool for a live connection matching the given address.
pub(crate) async fn find_probe_by_address(addr: SocketAddr) -> Option<FrameLinkProbeResult> {
    let pool = POOL.lock().await;
    pool.values()
        .find(|conn| conn.addr == addr && conn.session.is_alive())
        .map(|conn| conn.probe_cache.clone())
}

/// Load the board definition for the device, using cached board info.
pub(crate) async fn load_board_def(device_id: &str) -> Option<framelink::board::BoardDef> {
    let pool = POOL.lock().await;
    let conn = pool.get(device_id).filter(|c| c.session.is_alive())?;
    let name = conn.probe_cache.board_name.as_ref()?;
    let rev = conn.probe_cache.board_revision.as_ref()?;
    framelink::board::load_board_def(name, rev)
}

/// Return the interface type for a given interface index.
pub(crate) async fn get_iface_type(device_id: &str, iface_index: u8) -> Option<u8> {
    let pool = POOL.lock().await;
    pool.get(device_id)
        .filter(|conn| conn.session.is_alive())
        .and_then(|conn| conn.iface_types.get(&iface_index).copied())
}

// ============================================================================
// Public API — Editable Board Definition (by device_id)
// ============================================================================

/// Clone the EditableBoardDef from a managed connection, if one exists.
pub(crate) async fn clone_editable_board_def(
    device_id: &str,
) -> Option<framelink::board::editable::EditableBoardDef> {
    let pool = POOL.lock().await;
    let conn = pool.get(device_id).filter(|c| c.session.is_alive())?;
    let guard = conn.editable_board_def.lock().ok()?;
    guard.clone()
}

/// Execute a closure with mutable access to the connection's EditableBoardDef.
pub(crate) async fn with_editable_board_def<F, R>(
    device_id: &str,
    timeout_sec: f64,
    f: F,
) -> Result<R, String>
where
    F: FnOnce(&mut framelink::board::editable::EditableBoardDef) -> R,
{
    let conn = get_connection(device_id, timeout_sec).await?;
    let mut guard = conn
        .editable_board_def
        .lock()
        .map_err(|e| format!("editable_board_def mutex poisoned: {}", e))?;
    match guard.as_mut() {
        Some(board_def) => Ok(f(board_def)),
        None => Err("No board definition available for this device".to_string()),
    }
}

/// Serialise the EditableBoardDef to TOML and upload to the device.
pub(crate) async fn upload_board_def(
    device_id: &str,
    timeout_sec: f64,
) -> Result<(), String> {
    let conn = get_connection(device_id, timeout_sec).await?;

    let toml_string = {
        let guard = conn
            .editable_board_def
            .lock()
            .map_err(|e| format!("editable_board_def mutex poisoned: {}", e))?;
        match guard.as_ref() {
            Some(board_def) => board_def.to_toml(),
            None => return Err("No board definition available for this device".to_string()),
        }
    };

    tlog!(
        "[framelink:{}] Uploading board def ({} bytes)",
        device_id,
        toml_string.len()
    );

    conn.session
        .upload_board_def(&toml_string)
        .await
        .map_err(|e| e.to_string())?;

    tlog!("[framelink:{}] Board def upload complete", device_id);
    Ok(())
}
