// io/framelink/shared.rs
//
// FrameLink connection manager. FrameLink devices accept exactly one TCP
// client, so all operations — session streaming AND signal read/write — must
// share a single connection per device.
//
// Connection lifecycle:
//   - Created on first use (session_acquire or request)
//   - session_acquire/session_release track session-tier references
//   - request() uses the connection without touching session_refs
//   - When session_refs == 0 AND no commands for 10 s, the connection shuts down

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use framelink::client::FrameLinkClient;
use framelink::protocol::capabilities::decode_capabilities;
use framelink::protocol::stream::{build_stream_start, build_stream_stop, parse_frame_rx};
use framelink::protocol::types::{
    FLAG_ACK_REQ, MSG_CAPABILITIES_REQ, MSG_FRAME_RX, MSG_FRAME_TX, MSG_STREAM_START,
    MSG_STREAM_STOP,
};
use framelink::codec::frame::Frame;
use once_cell::sync::Lazy;
use tokio::sync::{broadcast, mpsc, Mutex};

use super::{FrameLinkProbeResult, ProbeInterface};

const IDLE_TIMEOUT: Duration = Duration::from_secs(10);

// ============================================================================
// Types
// ============================================================================

/// Raw FRAME_RX payload broadcast to all subscribers.
/// Includes the pre-parsed interface index for cheap filtering.
#[derive(Clone)]
pub(crate) struct BroadcastFrame {
    pub iface_index: u8,
    pub payload: Vec<u8>,
}

/// Command sent from a source reader to the connection task.
pub(crate) enum ConnCommand {
    StartStream(u8),
    Transmit {
        data: Vec<u8>,
        result_tx: std::sync::mpsc::SyncSender<Result<(), String>>,
    },
    Request {
        msg_type: u8,
        flags: u8,
        payload: Vec<u8>,
        result_tx: tokio::sync::oneshot::Sender<Result<Frame, String>>,
    },
}

/// Managed connection state for a single FrameLink device.
pub(crate) struct ManagedConnection {
    pub frame_tx: broadcast::Sender<BroadcastFrame>,
    pub cmd_tx: mpsc::Sender<ConnCommand>,
    pub iface_types: HashMap<u8, u8>,
    pub probe_cache: FrameLinkProbeResult,
    session_refs: AtomicUsize,
}

// ============================================================================
// Global Pool
// ============================================================================

static POOL: Lazy<Mutex<HashMap<String, Arc<ManagedConnection>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ============================================================================
// Internal — ensure_connection
// ============================================================================

/// Ensure a managed connection exists for the given host:port.
/// Creates the connection, fetches capabilities, and spawns the background
/// task if one doesn't already exist. Returns the connection with
/// session_refs unchanged (callers increment as needed).
async fn ensure_connection(
    host: &str,
    port: u16,
    timeout_sec: f64,
) -> Result<Arc<ManagedConnection>, String> {
    let key = format!("{}:{}", host, port);
    let mut pool = POOL.lock().await;

    // Reuse existing connection if still alive
    if let Some(conn) = pool.get(&key) {
        if !conn.cmd_tx.is_closed() {
            return Ok(conn.clone());
        }
        // Stale entry — connection task exited; remove and create fresh
        pool.remove(&key);
    }

    // Drop pool lock before I/O
    drop(pool);

    // Create new connection
    let addr = key
        .parse()
        .map_err(|e| format!("Invalid address {}: {}", key, e))?;

    let client = tokio::time::timeout(
        Duration::from_secs_f64(timeout_sec),
        FrameLinkClient::connect(addr),
    )
    .await
    .map_err(|_| format!("Connection to {} timed out", key))?
    .map_err(|e| format!("Connection to {} failed: {}", key, e))?;

    // Fetch capabilities for interface type map and probe cache
    let (iface_types, probe_cache) = fetch_capabilities(&client, &key, timeout_sec).await;

    let (frame_tx, _) = broadcast::channel(4096);
    let (cmd_tx, cmd_rx) = mpsc::channel(64);

    let conn = Arc::new(ManagedConnection {
        frame_tx: frame_tx.clone(),
        cmd_tx,
        iface_types,
        probe_cache,
        session_refs: AtomicUsize::new(0),
    });

    let key_clone = key.clone();
    let conn_weak = Arc::downgrade(&conn);
    tokio::spawn(run_connection_task(
        client, frame_tx, cmd_rx, key_clone, conn_weak,
    ));

    tlog!("[framelink:{}] Created managed connection", key);

    // Re-acquire pool lock to insert
    let mut pool = POOL.lock().await;
    pool.insert(key, conn.clone());
    Ok(conn)
}

/// Fetch capabilities from a freshly connected client.
async fn fetch_capabilities(
    client: &FrameLinkClient,
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
        client.request(MSG_CAPABILITIES_REQ, FLAG_ACK_REQ, &[]),
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

/// Release a session reference. When session_refs hits 0, the connection
/// task's idle timer handles cleanup.
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
/// The connection task handles the actual client.request() call.
pub(crate) async fn request(
    host: &str,
    port: u16,
    msg_type: u8,
    flags: u8,
    payload: &[u8],
    timeout_sec: f64,
) -> Result<Frame, String> {
    let conn = ensure_connection(host, port, timeout_sec).await?;
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();

    conn.cmd_tx
        .send(ConnCommand::Request {
            msg_type,
            flags,
            payload: payload.to_vec(),
            result_tx,
        })
        .await
        .map_err(|_| "Connection task closed".to_string())?;

    let result: Result<Frame, String> =
        tokio::time::timeout(Duration::from_secs_f64(timeout_sec), result_rx)
            .await
            .map_err(|_| "Request timed out".to_string())?
            .map_err(|_| "Connection task dropped response".to_string())?;
    result
}

// ============================================================================
// Public API — Query
// ============================================================================

/// Return cached probe data if a managed connection already exists.
pub(crate) async fn get_cached_probe(host: &str, port: u16) -> Option<FrameLinkProbeResult> {
    let key = format!("{}:{}", host, port);
    let pool = POOL.lock().await;
    pool.get(&key)
        .filter(|conn| !conn.cmd_tx.is_closed())
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
        .filter(|conn| !conn.cmd_tx.is_closed())
        .and_then(|conn| {
            let name = conn.probe_cache.board_name.as_ref()?;
            let rev = conn.probe_cache.board_revision.as_ref()?;
            Some((name.clone(), rev.clone()))
        })
}

/// Return the interface type for a given interface index from a managed connection.
pub(crate) async fn get_iface_type(host: &str, port: u16, iface_index: u8) -> Option<u8> {
    let key = format!("{}:{}", host, port);
    let pool = POOL.lock().await;
    pool.get(&key)
        .filter(|conn| !conn.cmd_tx.is_closed())
        .and_then(|conn| conn.iface_types.get(&iface_index).copied())
}

// ============================================================================
// Connection Task
// ============================================================================

/// Background task that owns the FrameLinkClient. Broadcasts received frames
/// to all subscribers, processes transmit / stream-control / request commands,
/// and shuts down after an idle timeout when no sessions are active.
async fn run_connection_task(
    mut client: FrameLinkClient,
    frame_tx: broadcast::Sender<BroadcastFrame>,
    mut cmd_rx: mpsc::Receiver<ConnCommand>,
    key: String,
    conn_ref: std::sync::Weak<ManagedConnection>,
) {
    let mut started_interfaces = HashSet::new();
    let mut last_cmd_at = Instant::now();

    loop {
        // Drain pending commands (non-blocking)
        loop {
            match cmd_rx.try_recv() {
                Ok(ConnCommand::StartStream(idx)) => {
                    last_cmd_at = Instant::now();
                    if started_interfaces.insert(idx) {
                        let payload = build_stream_start(idx, None);
                        match client.send(MSG_STREAM_START, FLAG_ACK_REQ, &payload).await {
                            Ok(_) => {
                                tlog!("[framelink:{}] Started stream on iface {}", key, idx)
                            }
                            Err(e) => tlog!(
                                "[framelink:{}] Failed to start stream on iface {}: {}",
                                key,
                                idx,
                                e
                            ),
                        }
                    }
                }
                Ok(ConnCommand::Transmit { data, result_tx }) => {
                    last_cmd_at = Instant::now();
                    let result = client
                        .send(MSG_FRAME_TX, 0, &data)
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string());
                    let _ = result_tx.send(result);
                }
                Ok(ConnCommand::Request {
                    msg_type,
                    flags,
                    payload,
                    result_tx,
                }) => {
                    last_cmd_at = Instant::now();
                    let result = client
                        .request(msg_type, flags, &payload)
                        .await
                        .map_err(|e| e.to_string());
                    let _ = result_tx.send(result);
                }
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    tlog!("[framelink:{}] Command channel closed", key);
                    return;
                }
            }
        }

        // Session-aware stream and idle management
        if let Some(conn) = conn_ref.upgrade() {
            let session_active = conn.session_refs.load(Ordering::SeqCst) > 0;

            // Stop streams immediately when no sessions need them
            if !session_active && !started_interfaces.is_empty() {
                stop_all_streams(&mut client, &started_interfaces, &key).await;
                started_interfaces.clear();
            }

            // Idle shutdown: no sessions and no recent commands
            if !session_active && last_cmd_at.elapsed() > IDLE_TIMEOUT {
                tlog!(
                    "[framelink:{}] Idle timeout — shutting down managed connection",
                    key
                );
                // Remove from pool
                let mut pool = POOL.lock().await;
                pool.remove(&key);
                return;
            }
        } else {
            // All Arc references dropped — pool entry already removed
            tlog!("[framelink:{}] Connection refs dropped, exiting", key);
            return;
        }

        // Wait for next RX frame with short timeout so we loop back to
        // drain commands promptly.
        match tokio::time::timeout(Duration::from_millis(1), client.recv_frame()).await {
            Ok(Ok(frame)) if frame.msg_type == MSG_FRAME_RX => {
                if let Ok(sf) = parse_frame_rx(&frame.payload) {
                    let _ = frame_tx.send(BroadcastFrame {
                        iface_index: sf.iface_index,
                        payload: frame.payload,
                    });
                }
            }
            Ok(Ok(_)) => {} // non-FRAME_RX unsolicited message
            Ok(Err(e)) => {
                tlog!("[framelink:{}] Connection error: {}", key, e);
                // Remove from pool on error
                let mut pool = POOL.lock().await;
                pool.remove(&key);
                return;
            }
            Err(_) => {} // timeout — loop again
        }
    }
}

/// Stop all started streams and log.
async fn stop_all_streams(
    client: &mut FrameLinkClient,
    started: &HashSet<u8>,
    key: &str,
) {
    for idx in started {
        let payload = build_stream_stop(*idx);
        let _ = client.send(MSG_STREAM_STOP, 0, &payload).await;
    }
    if !started.is_empty() {
        tlog!(
            "[framelink:{}] Stopped {} streams",
            key,
            started.len()
        );
    }
}
