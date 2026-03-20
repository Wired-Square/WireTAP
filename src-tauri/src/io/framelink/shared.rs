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
/// Guard timeout for device operations within the connection task.
/// If a single request/batch doesn't complete in this time, the connection
/// is considered broken and the task exits (reconnection handles recovery).
const CMD_GUARD_TIMEOUT: Duration = Duration::from_secs(10);

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
    /// Send a request and collect all RESP frames until ACK/NACK.
    RequestMulti {
        msg_type: u8,
        flags: u8,
        payload: Vec<u8>,
        result_tx: tokio::sync::oneshot::Sender<Result<Vec<Frame>, String>>,
    },
    /// Send N messages pipelined, collect N responses (via client.send_batch).
    RequestBatch {
        messages: Vec<(u8, u8, Vec<u8>)>,
        result_tx: tokio::sync::oneshot::Sender<Result<Vec<Frame>, String>>,
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

/// Persistent device_id → (host, port) mapping.
/// Populated when a connection's capabilities reveal a device_id.
/// NOT cleared when connections drop — allows automatic reconnection.
static DEVICE_MAP: Lazy<Mutex<HashMap<String, (String, u16)>>> =
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
        session_refs: AtomicUsize::new(1), // persistent — no idle timeout
    });

    let key_clone = key.clone();
    let conn_weak = Arc::downgrade(&conn);
    tokio::spawn(run_connection_task(
        client, frame_tx, cmd_rx, key_clone, conn_weak,
    ));

    tlog!("[framelink:{}] Created managed connection", key);

    // Re-acquire pool lock to insert — but check if another caller raced us
    let mut pool = POOL.lock().await;
    if let Some(existing) = pool.get(&key) {
        if !existing.cmd_tx.is_closed() {
            // Another call won the race — drop our connection and use theirs
            tlog!("[framelink:{}] Discarding duplicate connection (race)", key);
            drop(conn);
            return Ok(existing.clone());
        }
    }
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

    // Persist device_id → (host, port) for reconnection after pool eviction
    if let Some(ref did) = device_id {
        if let Some((host, port_str)) = key.rsplit_once(':') {
            if let Ok(port) = port_str.parse::<u16>() {
                DEVICE_MAP.lock().await.insert(did.clone(), (host.to_string(), port));
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

/// Send a request that returns multiple RESP frames before the final ACK/NACK.
/// Collects all non-ACK/non-NACK responses into a Vec, then returns them.
pub(crate) async fn request_multi(
    host: &str,
    port: u16,
    msg_type: u8,
    flags: u8,
    payload: &[u8],
    timeout_sec: f64,
) -> Result<Vec<Frame>, String> {
    let conn = ensure_connection(host, port, timeout_sec).await?;
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();

    conn.cmd_tx
        .send(ConnCommand::RequestMulti {
            msg_type,
            flags,
            payload: payload.to_vec(),
            result_tx,
        })
        .await
        .map_err(|_| "Connection task closed".to_string())?;

    tokio::time::timeout(Duration::from_secs_f64(timeout_sec), result_rx)
        .await
        .map_err(|_| "Request timed out".to_string())?
        .map_err(|_| "Connection task dropped response".to_string())?
}

/// Send multiple messages pipelined and collect responses.
/// Delegates to FrameLinkClient::send_batch from the library.
pub(crate) async fn request_batch(
    host: &str,
    port: u16,
    messages: Vec<(u8, u8, Vec<u8>)>,
    timeout_sec: f64,
) -> Result<Vec<Frame>, String> {
    let conn = ensure_connection(host, port, timeout_sec).await?;
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();

    conn.cmd_tx
        .send(ConnCommand::RequestBatch {
            messages,
            result_tx,
        })
        .await
        .map_err(|_| "Connection task closed".to_string())?;

    tokio::time::timeout(Duration::from_secs_f64(timeout_sec), result_rx)
        .await
        .map_err(|_| "Batch request timed out".to_string())?
        .map_err(|_| "Connection task dropped response".to_string())?
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
        .filter(|conn| !conn.cmd_tx.is_closed())
        .and_then(|conn| conn.iface_types.get(&iface_index).copied())
}

/// Resolve a device_id to its (host, port).
/// First checks the active connection pool. If not found, falls back to the
/// persistent device map and reconnects automatically.
pub(crate) async fn resolve_device_id(device_id: &str) -> Option<(String, u16)> {
    // Check active connections first
    {
        let pool = POOL.lock().await;
        for (key, conn) in pool.iter() {
            if conn.cmd_tx.is_closed() {
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

    // Fall back to persistent device map — reconnect if we know the address
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

// ============================================================================
// Connection Task
// ============================================================================

/// Background task that owns the FrameLinkClient. Broadcasts received frames
/// to all subscribers, processes transmit / stream-control / request commands,
/// and shuts down after an idle timeout when no sessions are active.
///
/// Uses `tokio::select!` to process commands and incoming frames concurrently,
/// preventing the frame_rx channel from backing up and blocking the reader task.
async fn run_connection_task(
    mut client: FrameLinkClient,
    frame_tx: broadcast::Sender<BroadcastFrame>,
    mut cmd_rx: mpsc::Receiver<ConnCommand>,
    key: String,
    conn_ref: std::sync::Weak<ManagedConnection>,
) {
    let mut started_interfaces = HashSet::new();
    let mut last_cmd_at = Instant::now();
    let mut idle_check = tokio::time::interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            // Branch 1: Process a command from the channel
            cmd = cmd_rx.recv() => {
                let cmd = match cmd {
                    Some(c) => c,
                    None => {
                        tlog!("[framelink:{}] Command channel closed", key);
                        return;
                    }
                };
                last_cmd_at = Instant::now();
                if !handle_command(&mut client, cmd, &key).await {
                    // Command handler signalled connection is broken
                    let mut pool = POOL.lock().await;
                    pool.remove(&key);
                    return;
                }
            }

            // Branch 2: Process an incoming frame from the device
            frame_result = client.recv_frame() => {
                match frame_result {
                    Ok(frame) if frame.msg_type == MSG_FRAME_RX => {
                        if let Ok(sf) = parse_frame_rx(&frame.payload) {
                            let _ = frame_tx.send(BroadcastFrame {
                                iface_index: sf.iface_index,
                                payload: frame.payload,
                            });
                        }
                    }
                    Ok(_) => {} // non-FRAME_RX unsolicited message — discard
                    Err(e) => {
                        tlog!("[framelink:{}] Connection error: {}", key, e);
                        let mut pool = POOL.lock().await;
                        pool.remove(&key);
                        return;
                    }
                }
            }

            // Branch 3: Periodic session/idle check
            _ = idle_check.tick() => {
                if let Some(conn) = conn_ref.upgrade() {
                    let session_active = conn.session_refs.load(Ordering::SeqCst) > 0;

                    if !session_active && !started_interfaces.is_empty() {
                        stop_all_streams(&mut client, &started_interfaces, &key).await;
                        started_interfaces.clear();
                    }

                    if !session_active && last_cmd_at.elapsed() > IDLE_TIMEOUT {
                        tlog!(
                            "[framelink:{}] Idle timeout — shutting down managed connection",
                            key
                        );
                        let mut pool = POOL.lock().await;
                        pool.remove(&key);
                        return;
                    }
                } else {
                    tlog!("[framelink:{}] Connection refs dropped, exiting", key);
                    return;
                }
            }
        }
    }
}

/// Process a single command. Returns `false` if the connection is broken
/// and the task should exit.
async fn handle_command(
    client: &mut FrameLinkClient,
    cmd: ConnCommand,
    key: &str,
) -> bool {
    match cmd {
        ConnCommand::StartStream(idx) => {
            let payload = build_stream_start(idx, None);
            match client.send(MSG_STREAM_START, FLAG_ACK_REQ, &payload).await {
                Ok(_) => tlog!("[framelink:{}] Started stream on iface {}", key, idx),
                Err(e) => tlog!(
                    "[framelink:{}] Failed to start stream on iface {}: {}",
                    key, idx, e
                ),
            }
            true
        }
        ConnCommand::Transmit { data, result_tx } => {
            let result = client
                .send(MSG_FRAME_TX, 0, &data)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string());
            let _ = result_tx.send(result);
            true
        }
        ConnCommand::Request {
            msg_type,
            flags,
            payload,
            result_tx,
        } => {
            match tokio::time::timeout(
                CMD_GUARD_TIMEOUT,
                client.request(msg_type, flags, &payload),
            )
            .await
            {
                Ok(result) => {
                    let _ = result_tx.send(result.map_err(|e| e.to_string()));
                    true
                }
                Err(_) => {
                    tlog!("[framelink:{}] Command guard timeout — closing connection", key);
                    let _ = result_tx.send(Err("Device not responding".to_string()));
                    false
                }
            }
        }
        ConnCommand::RequestMulti {
            msg_type,
            flags,
            payload,
            result_tx,
        } => {
            match tokio::time::timeout(
                CMD_GUARD_TIMEOUT,
                collect_multi_response(client, msg_type, flags, &payload),
            )
            .await
            {
                Ok(result) => {
                    let _ = result_tx.send(result);
                    true
                }
                Err(_) => {
                    tlog!("[framelink:{}] Multi-response guard timeout — closing connection", key);
                    let _ = result_tx.send(Err("Device not responding".to_string()));
                    false
                }
            }
        }
        ConnCommand::RequestBatch {
            messages,
            result_tx,
        } => {
            match tokio::time::timeout(
                CMD_GUARD_TIMEOUT,
                client.send_batch(&messages),
            )
            .await
            {
                Ok(result) => {
                    let _ = result_tx.send(result.map_err(|e| e.to_string()));
                    true
                }
                Err(_) => {
                    tlog!("[framelink:{}] Batch guard timeout — closing connection", key);
                    let _ = result_tx.send(Err("Device not responding".to_string()));
                    false
                }
            }
        }
    }
}

/// Send a request and collect all RESP frames until ACK/NACK.
/// Called within the connection task where `client` is available.
///
/// Uses `send()` (not `request()`) so no oneshot waiter is registered — all
/// response frames flow through to `recv_frame()` via the unsolicited channel.
async fn collect_multi_response(
    client: &mut FrameLinkClient,
    msg_type: u8,
    flags: u8,
    payload: &[u8],
) -> Result<Vec<Frame>, String> {
    use framelink::protocol::types::{MSG_ACK, MSG_NACK};

    client
        .send(msg_type, flags, payload)
        .await
        .map_err(|e| e.to_string())?;

    let mut frames = Vec::new();
    loop {
        let frame = client.recv_frame().await.map_err(|e| e.to_string())?;
        if frame.msg_type == MSG_ACK {
            return Ok(frames);
        }
        if frame.msg_type == MSG_NACK {
            let code = frame.payload.first().copied().unwrap_or(0);
            return Err(format!(
                "NACK: {}",
                framelink::protocol::types::error_name(code)
            ));
        }
        frames.push(frame);
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
