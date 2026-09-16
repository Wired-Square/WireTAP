// Copyright (c) 2026, Wired Square Pty Ltd
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

use crate::io::error::IoError;
use framelink::protocol::capabilities::decode_capabilities;
use framelink::protocol::types::{FLAG_ACK_REQ, MSG_CAPABILITIES_REQ};
use framelink::session::FrameLinkSession;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;

use super::version_probe;
use super::{FrameLinkProbeResult, ProbeInterface};

// ============================================================================
// WS command param helpers — shared by every framelink command module
// ============================================================================

/// Convert any `Display` error into a `String`, for WS command results.
pub(super) trait IntoStringErr<T> {
    fn str_err(self) -> Result<T, String>;
}

impl<T, E: std::fmt::Display> IntoStringErr<T> for Result<T, E> {
    fn str_err(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

/// Extract a non-empty `device_id` string from WS command params.
pub(super) fn get_device_id(params: &serde_json::Value) -> Result<String, String> {
    params["device_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "Missing 'device_id' parameter".to_string())
}

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
    /// Outstanding [`ConnectionLease`]s. At zero the connection is idle and the
    /// sweeper may evict it once the linger expires.
    leases: AtomicUsize,
    /// When the connection last fell to zero leases, or `None` while in use.
    /// Kept here rather than in a second map keyed by device id, so the pool
    /// entry carries its own idleness and the two cannot disagree.
    idle_since: std::sync::Mutex<Option<std::time::Instant>>,
}

/// A borrowed handle on a pooled connection.
///
/// The pool used to hand out bare `Arc`s and count session references in a
/// field nothing read, so nothing ever removed a pool entry: a stopped session
/// left the socket open, and since a FrameLink device serves exactly one
/// client, that held the device's only slot for the life of the process.
/// Holding a lease keeps the connection alive; dropping the last one starts the
/// linger.
pub(crate) struct ConnectionLease {
    conn: Arc<ManagedConnection>,
}

impl std::ops::Deref for ConnectionLease {
    type Target = ManagedConnection;

    fn deref(&self) -> &Self::Target {
        &self.conn
    }
}

impl Drop for ConnectionLease {
    fn drop(&mut self) {
        if self.conn.leases.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.conn.mark_idle();
            wake_sweeper();
        }
    }
}

impl ConnectionLease {
    fn take(conn: Arc<ManagedConnection>) -> Self {
        conn.leases.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut idle) = conn.idle_since.lock() {
            *idle = None;
        }
        Self { conn }
    }
}

impl ManagedConnection {
    fn mark_idle(&self) {
        if let Ok(mut idle) = self.idle_since.lock() {
            *idle = Some(std::time::Instant::now());
        }
    }

    /// How long this connection has had no leases, if it has none.
    fn idle_for(&self) -> Option<Duration> {
        if self.leases.load(Ordering::SeqCst) != 0 {
            return None;
        }
        self.idle_since.lock().ok()?.map(|since| since.elapsed())
    }
}

// ============================================================================
// Global Pool — keyed by device_id
// ============================================================================

static POOL: Lazy<Mutex<HashMap<String, Arc<ManagedConnection>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// How long an unused connection is kept before the socket is closed.
///
/// Long enough that the ~40 short-lived rules/signal commands reuse one warm
/// connection instead of reconnecting per command, short enough that a stopped
/// session stops squatting on a single-client device.
const IDLE_LINGER: Duration = Duration::from_secs(30);

/// Set while the sweeper task is alive, so releases do not stack up tasks.
static SWEEPER_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Nudge the sweeper, starting it if the last one has gone home.
///
/// Called from `Drop`, so it must not be async or block.
fn wake_sweeper() {
    if SWEEPER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        // Sleep to the next deadline rather than ticking: a permanent interval
        // would wake a desktop app every few seconds for the life of the
        // process, and `interval` bursts every missed tick after a suspend.
        loop {
            tokio::time::sleep(IDLE_LINGER).await;
            if !sweep_idle_connections().await {
                SWEEPER_RUNNING.store(false, Ordering::SeqCst);
                // A release between the sweep and the store would otherwise be
                // lost, so check once more before actually standing down.
                if POOL.lock().await.values().any(|c| c.idle_for().is_some())
                    && !SWEEPER_RUNNING.swap(true, Ordering::SeqCst)
                {
                    continue;
                }
                return;
            }
        }
    });
}

/// Close connections idle for longer than the linger. Returns whether any
/// connection is still idling, i.e. whether the sweeper has more to do.
async fn sweep_idle_connections() -> bool {
    let mut pool = POOL.lock().await;
    let expired: Vec<String> = pool
        .iter()
        .filter(|(_, conn)| conn.idle_for().is_some_and(|idle| idle >= IDLE_LINGER))
        .map(|(id, _)| id.clone())
        .collect();

    for device_id in expired {
        pool.remove(&device_id);
        tlog!(
            "[framelink:{}] Idle {}s — connection closed",
            device_id,
            IDLE_LINGER.as_secs()
        );
    }
    // Dropping the last Arc runs FrameLinkSession::Drop, which aborts the IO
    // task and closes the socket. There is no explicit close to call.

    pool.values().any(|conn| conn.idle_for().is_some())
}

/// Per-key connection lock — prevents duplicate TCP connections to the same
/// device. A `std::sync::Mutex` because it is only ever held long enough to
/// clone an `Arc`, never across an await — which is also what lets
/// [`ConnectingGuard`]'s `Drop` clean up without being async.
static CONNECTING: Lazy<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

/// Holds the per-address connect lock and drops the map entry with it.
///
/// Cleanup used to be two explicit calls on the success paths, so every `?`
/// between resolving the host and inserting into the pool leaked an entry
/// forever — and the failure paths are exactly the ones a flaky device takes
/// repeatedly.
struct ConnectingGuard {
    race_key: String,
    lock: Arc<tokio::sync::Mutex<()>>,
}

impl ConnectingGuard {
    fn acquire(race_key: String) -> Self {
        let lock = CONNECTING
            .lock()
            .expect("CONNECTING mutex poisoned")
            .entry(race_key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        Self { race_key, lock }
    }
}

impl Drop for ConnectingGuard {
    fn drop(&mut self) {
        let mut connecting = match CONNECTING.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        // Only the map and this guard hold it, so nobody is queued behind us —
        // dropping the entry now cannot cost another caller its exclusion.
        if Arc::strong_count(&self.lock) <= 2 {
            connecting.remove(&self.race_key);
        }
    }
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
    let addr = crate::io::net::resolve_host_port(host, port)
        .await
        .map_err(|e| e.user_message())?;

    // Per-key lock: only one connection attempt per address at a time
    let connecting = ConnectingGuard::acquire(format!("addr:{}:{}", host, port));
    let _guard = connecting.lock.clone().lock_owned().await;

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
    .map_err(|_| IoError::timeout(&display_key, "connect").user_message())?
    .map_err(|e| IoError::connection(&display_key, e.to_string()).user_message())?;

    let (iface_types, probe_cache, editable_board_def) =
        match fetch_capabilities(&session, &display_key, timeout_sec).await {
            Ok(caps) => caps,
            Err(e) => {
                // A device that will not describe itself is usually one that
                // cannot read us at all — the protocol has no handshake, so a
                // version mismatch looks exactly like a hang. Ask it directly
                // rather than reporting a bare timeout.
                //
                // Dropping the session first is load-bearing: it closes the
                // socket, and a FrameLink device serves exactly one client, so
                // the probe cannot get in until this one is gone.
                drop(session);
                return Err(diagnose_failed_connect(addr, &display_key, e)
                    .await
                    .user_message());
            }
        };

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
        leases: AtomicUsize::new(0),
        idle_since: std::sync::Mutex::new(Some(std::time::Instant::now())),
    });

    // Insert into pool by device_id
    let mut pool = POOL.lock().await;
    if let Some(existing) = pool.get(&device_id) {
        if existing.session.is_alive() {
            tlog!("[framelink:{}] Discarding duplicate connection (race)", device_id);
            return Ok(device_id);
        }
    }
    pool.insert(device_id.clone(), conn);
    tlog!("[framelink:{}] Created managed connection ({})", device_id, display_key);
    // A probe connects and reads the cache without ever taking a lease, so an
    // unclaimed connection would otherwise hold the device's only client slot
    // with nothing to release it.
    wake_sweeper();

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

/// Turn a failed capabilities exchange into the most specific message we can
/// justify, by asking the device which protocol version it speaks.
///
/// The probe only runs on a path that has already failed, so its ~1.5s costs
/// nothing that was not already lost — and it replaces a 15s stall reported as
/// "timed out" with an answer naming the actual versions.
async fn diagnose_failed_connect(addr: SocketAddr, display_key: &str, original: IoError) -> IoError {
    // Only a timeout is ambiguous. A decode failure means the device answered
    // *in our version* and the reply was bad — probing would spend the window
    // to reach the SameVersion arm and throw the answer away.
    if !matches!(original, IoError::Timeout { .. }) {
        return original;
    }

    let verdict = version_probe::probe_version(addr).await;
    tlog!(
        "[framelink:{}] Capabilities failed ({}); version probe says {:?}",
        display_key,
        original,
        verdict
    );

    use version_probe::VersionVerdict;
    match verdict {
        // The peer speaks our version, so the mismatch story would be a lie —
        // report what actually went wrong.
        VersionVerdict::SameVersion => original,
        VersionVerdict::Speaks(v) => IoError::protocol(
            display_key,
            format!(
                "device speaks FrameLink protocol v{v}, but this build speaks \
                 v{}. The two cannot talk to each other — update the device \
                 firmware, then try again.",
                framelink::codec::frame::PROTOCOL_VERSION
            ),
        ),
        VersionVerdict::Unintelligible => IoError::protocol(
            display_key,
            "device replied in a FrameLink dialect this build cannot read — its \
             firmware predates a change to the frame format. Update the device \
             firmware, then try again."
                .to_string(),
        ),
        // Connected, pinged in every dialect, heard nothing. On a device that
        // serves exactly one client that is overwhelmingly "someone else has
        // it" — which is what DeviceBusy already says, including the close-the-
        // other-app instruction this used to reinvent without.
        VersionVerdict::Silent => IoError::busy(display_key),
    }
}

/// Fetch capabilities from a freshly connected session.
///
/// A device that cannot describe itself is not a device we have connected to,
/// so every failure here is fatal to the connection. This used to return an
/// empty probe instead, which let `connect_by_address` pool a half-open
/// connection, name it `host:port`, and report success — so a device speaking a
/// protocol version we do not (the whole of this bug) presented as a healthy
/// session that silently streamed nothing.
async fn fetch_capabilities(
    session: &Arc<FrameLinkSession>,
    key: &str,
    timeout_sec: f64,
) -> Result<
    (
        HashMap<u8, u8>,
        FrameLinkProbeResult,
        Option<framelink::board::editable::EditableBoardDef>,
    ),
    IoError,
> {
    let frame = tokio::time::timeout(
        Duration::from_secs_f64(timeout_sec),
        session.request(MSG_CAPABILITIES_REQ, FLAG_ACK_REQ, &[]),
    )
    .await
    .map_err(|_| {
        tlog!("[framelink:{}] Capabilities request timed out", key);
        IoError::timeout(key, "capabilities request")
    })?
    .map_err(|e| {
        tlog!("[framelink:{}] Capabilities request failed: {}", key, e);
        IoError::protocol(key, format!("capabilities request failed: {e}"))
    })?;

    let caps = decode_capabilities(&frame.payload).map_err(|e| {
        tlog!("[framelink:{}] Failed to decode capabilities: {}", key, e);
        IoError::protocol(key, format!("could not decode capabilities: {e}"))
    })?;

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
            if ed.is_none() && bd.is_none() {
                // A poisoned/unparseable device TOML would otherwise leave no
                // board def and no way to recover. Fall back to embedded so the
                // next persist-save re-uploads clean TOML.
                tlog!(
                    "[framelink:{}] Device TOML unparseable; using embedded board def",
                    key
                );
                embedded_board_def_fallback(&board_name, &board_revision)
            } else {
                (bd, ed)
            }
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

    Ok((iface_types, probe, editable))
}

// ============================================================================
// Public API — Connection (by device_id)
// ============================================================================

/// Take a lease on a pooled connection, if it is there.
/// Get or reconnect a managed connection by device_id.
///
/// Resolves an address three ways — a live pool entry, the stored host of a
/// Manual registry device (never discovered, matching the SMP path), or mDNS —
/// then connects and leases through one tail.
pub(crate) async fn get_connection(
    device_id: &str,
    timeout_sec: f64,
) -> Result<ConnectionLease, String> {
    let pooled = {
        let pool = POOL.lock().await;
        match pool.get(device_id) {
            Some(conn) if conn.session.is_alive() => {
                return Ok(ConnectionLease::take(conn.clone()))
            }
            Some(conn) => Some(conn.addr),
            None => None,
        }
    };

    let addr = match pooled {
        // Dead connection — reconnect using its last known address.
        Some(addr) => addr,
        None => match framelink::target_for(
            &framelink::DeviceId::from(device_id),
            framelink::Transport::Tcp,
        ) {
            framelink::ConnectTarget::Direct(addr) => addr,
            _ => discover_address(device_id, timeout_sec).await?,
        },
    };

    connect_by_address(&addr.ip().to_string(), addr.port(), timeout_sec).await?;
    POOL.lock()
        .await
        .get(device_id)
        .map(|conn| ConnectionLease::take(conn.clone()))
        .ok_or_else(|| format!("Connection to '{}' ({}) failed", device_id, addr))
}

/// Poll the shared Discovery until the device resolves, or the timeout passes.
async fn discover_address(device_id: &str, timeout_sec: f64) -> Result<SocketAddr, String> {
    let discovery = crate::device_scan::discovery_handle().await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(timeout_sec);
    loop {
        if let Some(addr) = discovery
            .devices()
            .await
            .into_iter()
            .find(|d| d.name() == device_id)
            .and_then(|d| d.address())
        {
            return Ok(addr);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(IoError::DeviceNotFound {
                device: device_id.to_string(),
            }
            .user_message());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn connecting_holds(key: &str) -> bool {
        CONNECTING.lock().unwrap().contains_key(key)
    }

    /// The guard must clean up on the *failure* paths, which is what the two
    /// explicit `cleanup_connecting` calls it replaced never did.
    #[test]
    fn connecting_entry_is_released_on_drop() {
        let key = "addr:release.test:120".to_string();
        {
            let _guard = ConnectingGuard::acquire(key.clone());
            assert!(connecting_holds(&key), "entry should exist while held");
        }
        assert!(!connecting_holds(&key), "entry should be gone after drop");
    }

    /// A second waiter keeps the entry alive, so the two callers go on sharing
    /// one lock rather than the first one out removing the exclusion.
    #[test]
    fn connecting_entry_survives_while_another_holder_waits() {
        let key = "addr:contended.test:120".to_string();
        let waiter = ConnectingGuard::acquire(key.clone());
        {
            let _first = ConnectingGuard::acquire(key.clone());
        }
        assert!(
            connecting_holds(&key),
            "entry must outlive the first guard while a second holds it"
        );
        drop(waiter);
        assert!(!connecting_holds(&key), "last guard out clears the entry");
    }

    /// A pooled connection against a throwaway local listener. `connect` only
    /// opens the socket — there is no handshake — so this exercises the real
    /// `ManagedConnection` rather than a stand-in for it.
    async fn test_connection() -> Arc<ManagedConnection> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = tokio::spawn(async move { listener.accept().await.map(|_| ()) });
        let session = FrameLinkSession::connect(addr).await.unwrap();
        let _ = accepted.await;
        Arc::new(ManagedConnection {
            session,
            addr,
            iface_types: HashMap::new(),
            probe_cache: FrameLinkProbeResult {
                device_id: None,
                board_name: None,
                board_revision: None,
                interfaces: vec![],
            },
            editable_board_def: std::sync::Mutex::new(None),
            leases: AtomicUsize::new(0),
            idle_since: std::sync::Mutex::new(None),
        })
    }

    /// Backdate a connection's idleness so the sweeper sees it as expired,
    /// rather than sleeping out the real linger in a test.
    fn backdate_idle(conn: &ManagedConnection) {
        *conn.idle_since.lock().unwrap() =
            Some(std::time::Instant::now() - IDLE_LINGER - Duration::from_secs(1));
    }

    /// A connection in use is not idle, however long ago it was acquired; only
    /// the last lease going makes it a candidate.
    #[tokio::test]
    async fn a_connection_in_use_is_never_idle() {
        let conn = test_connection().await;

        let first = ConnectionLease::take(conn.clone());
        let second = ConnectionLease::take(conn.clone());
        assert_eq!(conn.leases.load(Ordering::SeqCst), 2);

        drop(first);
        assert!(
            conn.idle_for().is_none(),
            "a connection still leased must never look idle"
        );

        drop(second);
        assert!(
            conn.idle_for().is_some(),
            "the last lease going starts the linger"
        );
    }

    /// The sweep itself: an expired connection is closed, and one whose lease
    /// came back inside the window is left alone — which is the whole point of
    /// lingering rather than closing on the last release.
    #[tokio::test]
    async fn the_sweep_closes_only_connections_still_idle() {
        let expired = test_connection().await;
        let revived = test_connection().await;
        expired.mark_idle();
        revived.mark_idle();
        backdate_idle(&expired);
        backdate_idle(&revived);

        {
            let mut pool = POOL.lock().await;
            pool.insert("sweep.expired".to_string(), expired.clone());
            pool.insert("sweep.revived".to_string(), revived.clone());
        }

        // Re-acquired just before the sweep runs.
        let lease = ConnectionLease::take(revived.clone());

        sweep_idle_connections().await;

        let pool = POOL.lock().await;
        assert!(
            !pool.contains_key("sweep.expired"),
            "an expired, unleased connection should have been closed"
        );
        assert!(
            pool.contains_key("sweep.revived"),
            "a re-acquired connection must survive its expired deadline"
        );
        drop(pool);

        drop(lease);
        POOL.lock().await.remove("sweep.revived");
    }
}
