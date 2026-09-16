// crates/wiretap-app/src/io_test.rs
//
// Test Pattern — drives round-trip I/O tests through existing sessions.
//
// The wire contract is `wiretap_protocol::testpattern`, documented at that
// crate's `docs/test-pattern.md`. Both ends of it live there, so this app and
// the capture server cannot disagree about what a run means. What stays here is
// everything the crate deliberately cannot see: tokio, `FrameMessage`, session
// transmit, and the serde shapes `src/api/testPattern.ts` reads.
//
// State is stored in IO_TEST_STATES and fetched by the frontend via
// get_io_test_state after receiving a TestPatternState WebSocket message.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use wiretap_protocol::testpattern as tp;
use wiretap_protocol::testpattern::{Command, Message, Reply, Responder, SequenceTracker};

use crate::io::{self, now_us, CanTransmitFrame, FrameMessage, TransmitPayload};

/// How long a `Hello` waits for an answer, and how many times it asks. A
/// responder that is there answers in one bus round trip; the retries are for
/// the frame that collided with real traffic.
const HELLO_TIMEOUT: Duration = Duration::from_millis(400);
const HELLO_ATTEMPTS: u32 = 3;

/// A status report is four frames; this is the wait for all of them.
const STATUS_TIMEOUT: Duration = Duration::from_millis(500);

/// One sweep code's echo. The sweep is lock-step, so this is the entire cost of
/// a peer that has stopped answering.
const SWEEP_TIMEOUT: Duration = Duration::from_millis(500);

/// How often a running test pushes its counters at the UI.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// A transmit failing this many times in a row is a broken session, not a busy
/// bus, and there is nothing to learn by carrying on.
const MAX_CONSECUTIVE_FAILURES: u32 = 10;

/// A failing link can produce an error per transmitted frame, and every
/// progress tick clones the list, serialises it and broadcasts it. The panel
/// shows ten; keeping more than this buys nothing and costs the whole run.
const MAX_KEPT_ERRORS: usize = 16;

/// Likewise for sequence gaps: a run losing frames at a few thousand a second
/// accumulates them faster than anyone can read them.
const MAX_KEPT_GAPS: usize = 100;

/// Put one frame on the session's bus.
///
/// Every transmit in this module goes through here, so the tests can stand a
/// bus up in process — a real session is reachable only through the global
/// registry, whose entries hold an `AppHandle<Wry>` no headless test can make.
async fn send(
    session_id: &str,
    payload: &TransmitPayload,
) -> Result<crate::io::TransmitResult, String> {
    #[cfg(test)]
    if let Some(result) = tests::intercept(session_id, payload) {
        return result;
    }
    io::session_transmit(session_id, payload).await
}

// ============================================================================
// Types
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestMode {
    Echo,
    Sweep,
    Throughput,
    Latency,
    Reliability,
    Loopback,
    Auto,
}

impl std::fmt::Display for TestMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TestMode::Echo => "echo",
            TestMode::Sweep => "sweep",
            TestMode::Throughput => "throughput",
            TestMode::Latency => "latency",
            TestMode::Reliability => "reliability",
            TestMode::Loopback => "loopback",
            TestMode::Auto => "auto",
        })
    }
}

impl TestMode {
    /// The mode byte a `Start` carries.
    ///
    /// A responder does not act on it — it echoes whatever it is asked — so
    /// this only tells a peer's log what it is taking part in. The table
    /// belongs in the crate beside the rest of the contract; it is here until
    /// the crate names one, which is why the two modes that never reach a peer
    /// have no code rather than a made-up one.
    fn code(self) -> u8 {
        match self {
            TestMode::Echo => 0x01,
            TestMode::Sweep => 0x02,
            TestMode::Throughput => 0x03,
            TestMode::Latency => 0x04,
            TestMode::Reliability => 0x05,
            // Loopback never sends a `Start`, and Auto dispatches per-phase
            // configs, so neither is ever named on the wire.
            TestMode::Loopback | TestMode::Auto => 0x00,
        }
    }

    /// Does this mode talk to a peer at all? Loopback is answered by the
    /// interface itself, so there is nobody to greet, bind or stop.
    fn has_peer(self) -> bool {
        !matches!(self, TestMode::Loopback)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestRole {
    Initiator,
    Responder,
}

impl std::fmt::Display for TestRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TestRole::Initiator => "initiator",
            TestRole::Responder => "responder",
        })
    }
}

/// What the run is doing, as the panel reads it.
///
/// `Listening` is a responder that has not been bound to a run yet; everything
/// after `Running` is terminal. Typed rather than a bare string because
/// `run_auto` decides a phase passed by reading it back.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TestStatus {
    Running,
    Listening,
    Completed,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TestConfig {
    pub mode: TestMode,
    pub role: TestRole,
    pub duration_sec: f64,
    pub rate_hz: f64,
    pub bus: u8,
    pub use_fd: bool,
    pub use_extended: bool,
}

impl TestConfig {
    /// One CAN frame, ready to hand to the session.
    fn can(&self, frame_id: u32, data: Vec<u8>, is_extended: bool, is_fd: bool) -> TransmitPayload {
        TransmitPayload::CanFrame(CanTransmitFrame {
            frame_id,
            data,
            bus: self.bus,
            is_extended,
            is_fd,
            is_brs: is_fd,
            is_rtr: false,
        })
    }

    /// A framed message, on the id width this run asked for. `use_extended`
    /// used to set the flag and leave the id at `0x7Fx`, so an "extended" run
    /// was a standard-id run with a bit set.
    fn message(&self, msg: Message, run: u8) -> TransmitPayload {
        let arb_id = msg.arb_id();
        self.can(
            if self.use_extended { tp::extended_id(arb_id) } else { arb_id },
            tp::encode(msg, tp::Flags::new(self.bus, run)).to_vec(),
            self.use_extended,
            self.use_fd,
        )
    }

    /// A sweep request. Always a standard id: the sweep ids have no extended
    /// form, because the length code in the low nibble is the whole of their
    /// meaning.
    fn sweep_request(&self, code: u8) -> TransmitPayload {
        self.can(
            tp::SWEEP_REQUEST_BASE + u32::from(code),
            tp::sweep_payload(code, self.use_fd),
            false,
            self.use_fd,
        )
    }

    /// A frame the crate's responder asked for, at the width and type it chose:
    /// a run using 29-bit ids that got 11-bit replies would read as a dead link.
    fn reply(&self, reply: Reply) -> TransmitPayload {
        self.can(reply.arb_id, reply.data, reply.extended, reply.fd)
    }
}

/// Round-trip times over a run. Mirrors the crate's [`tp::LatencyStats`] so the
/// frontend has a serde shape to read; the maths is the crate's.
#[derive(Clone, Debug, Serialize, Default)]
pub struct LatencyStats {
    pub min_us: u64,
    pub max_us: u64,
    pub mean_us: u64,
    pub p50_us: u64,
    pub p95_us: u64,
    pub p99_us: u64,
    pub count: u64,
}

impl From<tp::LatencyStats> for LatencyStats {
    fn from(s: tp::LatencyStats) -> Self {
        Self {
            min_us: s.min_us,
            max_us: s.max_us,
            mean_us: s.mean_us,
            p50_us: s.p50_us,
            p95_us: s.p95_us,
            p99_us: s.p99_us,
            count: s.count,
        }
    }
}

/// What `Hello` found: proof that something is out there, and what it says it
/// can do.
#[derive(Clone, Debug, Serialize)]
pub struct PeerInfo {
    pub fd: bool,
    pub extended: bool,
    pub bus: u8,
}

/// One length code's result.
///
/// The echo is compared against the payload the *code* names, not against what
/// was sent, so an endpoint that answered a different length has failed even if
/// every byte it did send was right — which is precisely how a length-versus-
/// code confusion presents.
#[derive(Clone, Debug, Serialize)]
pub struct SweepRow {
    pub code: u8,
    pub expected_len: u32,
    /// `None` when nothing came back at all.
    pub received_len: Option<u32>,
    pub passed: bool,
}

/// Result of a single phase in an Auto test.
#[derive(Clone, Debug, Serialize)]
pub struct AutoPhaseResult {
    pub phase: String,
    pub passed: bool,
    pub tx_count: u64,
    pub rx_count: u64,
    pub drops: u64,
    pub frames_per_sec: f64,
    pub elapsed_sec: f64,
    pub latency_us: Option<LatencyStats>,
    pub remote: Option<RemoteStats>,
    pub sweep: Option<Vec<SweepRow>>,
    pub errors: Vec<String>,
}

/// Remote endpoint stats received via status report frames.
#[derive(Clone, Debug, Serialize, Default)]
pub struct RemoteStats {
    pub rx_count: u32,
    pub tx_count: u32,
    pub drops: u32,
    pub fps: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct IOTestState {
    pub test_id: String,
    pub status: TestStatus,
    pub mode: TestMode,
    pub role: TestRole,
    pub tx_count: u64,
    pub rx_count: u64,
    pub drops: u64,
    pub duplicates: u64,
    pub out_of_order: u64,
    /// The first [`MAX_KEPT_GAPS`] gaps, not necessarily all of them — `drops`
    /// is the authoritative count.
    pub sequence_gaps: Vec<(u16, u16)>,
    pub latency_us: Option<LatencyStats>,
    pub elapsed_sec: f64,
    pub frames_per_sec: f64,
    pub errors: Vec<String>,
    pub remote: Option<RemoteStats>,
    /// What the `Hello` handshake found, once it has answered.
    pub peer: Option<PeerInfo>,
    /// Per-length-code results, for a Sweep run.
    pub sweep: Option<Vec<SweepRow>>,
    /// Phase results for Auto mode.
    pub auto_results: Option<Vec<AutoPhaseResult>>,
    /// Current phase label for Auto mode (e.g. "Echo (1/5)").
    pub auto_phase: Option<String>,
}

// ============================================================================
// State management (signal-then-fetch, same pattern as replay.rs)
// ============================================================================

struct TestTask {
    cancel_flag: std::sync::Arc<AtomicBool>,
    #[allow(dead_code)]
    handle: tauri::async_runtime::JoinHandle<()>,
}

static IO_TEST_TASKS: Lazy<tokio::sync::Mutex<HashMap<String, TestTask>>> =
    Lazy::new(|| tokio::sync::Mutex::new(HashMap::new()));

static IO_TEST_STATES: Lazy<StdMutex<HashMap<String, IOTestState>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

/// One tap: an id to remove it by, and where its frames go.
type Tap = (u64, mpsc::UnboundedSender<FrameMessage>);

/// Frame tap senders: session_id -> the taps that want Test Pattern frames.
static FRAME_TAPS: Lazy<StdMutex<HashMap<String, Vec<Tap>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

static NEXT_TAP_ID: AtomicU64 = AtomicU64::new(1);

/// Run tags cycle 0-15, so two runs on one bus in quick succession cannot be
/// counted as each other's drops.
static NEXT_RUN_TAG: AtomicU64 = AtomicU64::new(1);

fn next_run_tag() -> u8 {
    (NEXT_RUN_TAG.fetch_add(1, Ordering::Relaxed) & 0x0F) as u8
}

fn store_test_state(test_id: &str, state: IOTestState) {
    if let Ok(mut states) = IO_TEST_STATES.lock() {
        states.insert(test_id.to_string(), state);
    }
}

/// A live tap on one session's Test Pattern frames.
///
/// Dropping it removes only this tap. Removing every tap for the session — what
/// the old cleanup did — meant an initiator and a responder sharing a session
/// killed each other's receive channel as soon as the first one finished.
struct FrameTap {
    session_id: String,
    id: u64,
    rx: mpsc::UnboundedReceiver<FrameMessage>,
}

impl Drop for FrameTap {
    fn drop(&mut self) {
        if let Ok(mut taps) = FRAME_TAPS.lock() {
            if let Some(list) = taps.get_mut(&self.session_id) {
                list.retain(|(id, _)| *id != self.id);
                if list.is_empty() {
                    taps.remove(&self.session_id);
                }
            }
        }
    }
}

impl FrameTap {
    /// Wait for the next tapped frame, or `None` once `deadline` has passed.
    async fn recv_until(&mut self, deadline: Instant) -> Option<FrameMessage> {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        tokio::time::timeout(remaining, self.rx.recv()).await.ok().flatten()
    }
}

fn register_frame_tap(session_id: &str) -> FrameTap {
    let (tx, rx) = mpsc::unbounded_channel();
    let id = NEXT_TAP_ID.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut taps) = FRAME_TAPS.lock() {
        taps.entry(session_id.to_string()).or_default().push((id, tx));
    }
    FrameTap { session_id: session_id.to_string(), id, rx }
}

/// Called from capture_store::append_frames_to_session to forward test frames.
pub fn tap_test_frames(session_id: &str, frames: &[FrameMessage]) {
    let taps = match FRAME_TAPS.lock() {
        Ok(t) => t,
        Err(_) => return,
    };
    if let Some(senders) = taps.get(session_id) {
        for frame in frames {
            if tp::is_test_pattern_frame(frame.frame_id) {
                for (_, sender) in senders {
                    let _ = sender.send(frame.clone());
                }
            }
        }
    }
}

// ============================================================================
// Publishing
// ============================================================================

/// One Auto phase's live context: how to label it, and the rows already done.
struct AutoPhase<'a> {
    label: String,
    done: &'a [AutoPhaseResult],
}

/// Where a run's state is published, and how it is labelled.
///
/// An Auto phase publishes under the suite's own id. Per-phase state used to be
/// stored under `{test_id}_phase_{i}` while the panel filters on `test_id`, so
/// nothing reached the UI until the whole suite had finished.
struct Publish<'a> {
    test_id: &'a str,
    mode: TestMode,
    role: TestRole,
    auto: Option<AutoPhase<'a>>,
}

impl<'a> Publish<'a> {
    fn new(test_id: &'a str, config: &TestConfig) -> Self {
        Self { test_id, mode: config.mode, role: config.role, auto: None }
    }

    fn phase(test_id: &'a str, label: String, done: &'a [AutoPhaseResult]) -> Self {
        Self {
            test_id,
            mode: TestMode::Auto,
            role: TestRole::Initiator,
            auto: Some(AutoPhase { label, done }),
        }
    }

    /// Serialise straight out of the state being stored, so a publish costs one
    /// copy rather than one to store and another to read back for the wire.
    fn emit(&self, state: IOTestState) {
        crate::ws::dispatch::send_io_test_state(&state);
        store_test_state(self.test_id, state);
    }

    /// Publish a run's last state. An Auto phase finishing is not the suite
    /// finishing, so a phase's terminal status is downgraded here — publishing
    /// it verbatim would tell the panel the whole run was over.
    fn emit_final(&self, state: &IOTestState) {
        let mut published = state.clone();
        if self.auto.is_some() {
            published.status = TestStatus::Running;
        }
        self.emit(published);
    }
}

/// What a run has accumulated so far.
///
/// The sequence tracker is passed in rather than held: a responder's lives
/// inside the crate's [`Responder`], which is what counts its frames.
struct RunStats {
    started: Instant,
    tx_count: u64,
    latency: tp::Latencies,
    /// Send time per outstanding latency probe, keyed by sequence number.
    pending: HashMap<u16, u64>,
    /// The first [`MAX_KEPT_ERRORS`] messages, and how many there were in all.
    errors: Vec<String>,
    error_count: u64,
    sweep: Vec<SweepRow>,
    peer: Option<PeerInfo>,
    remote: Option<RemoteStats>,
}

impl RunStats {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            tx_count: 0,
            latency: tp::Latencies::new(),
            pending: HashMap::new(),
            errors: Vec::new(),
            error_count: 0,
            sweep: Vec::new(),
            peer: None,
            remote: None,
        }
    }

    fn error(&mut self, msg: String) {
        if self.errors.len() < MAX_KEPT_ERRORS {
            self.errors.push(msg);
        }
        self.error_count += 1;
    }

    /// The kept errors, with a tail naming how many were dropped.
    fn reported_errors(&self) -> Vec<String> {
        let mut out = self.errors.clone();
        let dropped = self.error_count - out.len() as u64;
        if dropped > 0 {
            out.push(format!("... and {} more", dropped));
        }
        out
    }

    /// Record the outcome of one transmit, returning whether it went out.
    async fn transmit(
        &mut self,
        session_id: &str,
        payload: &TransmitPayload,
        what: impl FnOnce() -> String,
    ) -> bool {
        match send(session_id, payload).await {
            Ok(result) if result.success => {
                self.tx_count += 1;
                true
            }
            Ok(result) => {
                self.error(format!("{}: {}", what(), result.error.unwrap_or_default()));
                false
            }
            Err(e) => {
                self.error(format!("{}: {}", what(), e));
                false
            }
        }
    }

    /// The counters as the UI sees them. `status` is the only thing a caller
    /// decides; everything else is what the run actually did.
    fn state(&self, publish: &Publish, status: TestStatus, seq: &SequenceTracker) -> IOTestState {
        let elapsed = self.started.elapsed().as_secs_f64();
        // Each end reports the rate it drives: the initiator's is what it put on
        // the wire, the responder's is what reached it.
        let driven = match publish.role {
            TestRole::Initiator => self.tx_count,
            TestRole::Responder => seq.rx_count,
        };
        IOTestState {
            test_id: publish.test_id.to_string(),
            status,
            mode: publish.mode,
            role: publish.role,
            tx_count: self.tx_count,
            rx_count: seq.rx_count,
            drops: seq.drops,
            duplicates: seq.duplicates,
            out_of_order: seq.out_of_order,
            sequence_gaps: seq.gaps.iter().take(MAX_KEPT_GAPS).copied().collect(),
            latency_us: self.latency.stats().map(Into::into),
            elapsed_sec: elapsed,
            frames_per_sec: if elapsed > 0.0 { driven as f64 / elapsed } else { 0.0 },
            errors: self.reported_errors(),
            remote: self.remote.clone(),
            peer: self.peer.clone(),
            sweep: (!self.sweep.is_empty()).then(|| self.sweep.clone()),
            auto_results: publish.auto.as_ref().map(|a| a.done.to_vec()),
            auto_phase: publish.auto.as_ref().map(|a| a.label.clone()),
        }
    }

    /// Did the run prove the link works?
    ///
    /// The status is derived from this, so a run that dropped every frame can no
    /// longer report `Completed` and be read as a pass.
    fn passed(&self, mode: TestMode, seq: &SequenceTracker) -> bool {
        if self.tx_count == 0 || self.error_count > 0 {
            return false;
        }
        match mode {
            // One-way by definition — nothing comes back to be counted.
            TestMode::Throughput => true,
            // An empty sweep swept nothing, which is a failure.
            TestMode::Sweep => !self.sweep.is_empty() && self.sweep.iter().all(|r| r.passed),
            _ => seq.drops == 0 && seq.duplicates == 0,
        }
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

#[tauri::command(rename_all = "snake_case")]
pub async fn io_test_start(
    session_id: String,
    test_id: String,
    config: TestConfig,
) -> Result<String, String> {
    {
        let tasks = IO_TEST_TASKS.lock().await;
        if tasks.contains_key(&test_id) {
            return Err(format!("Test '{}' is already running", test_id));
        }
    }

    let cancel_flag = std::sync::Arc::new(AtomicBool::new(false));
    let cancel = cancel_flag.clone();
    let id = test_id.clone();
    let session = session_id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        match (config.mode, config.role) {
            (TestMode::Auto, _) => run_auto(&session, &id, &config, &cancel).await,
            (_, TestRole::Initiator) => {
                Run::new(&session, &Publish::new(&id, &config), &config, &cancel)
                    .initiate()
                    .await;
            }
            (_, TestRole::Responder) => {
                run_responder(&session, &Publish::new(&id, &config), &config, &cancel).await;
            }
        }
        IO_TEST_TASKS.lock().await.remove(&id);
    });

    let mut tasks = IO_TEST_TASKS.lock().await;
    tasks.insert(test_id.clone(), TestTask { cancel_flag, handle });

    Ok(test_id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn io_test_stop(test_id: String) -> Result<(), String> {
    let mut tasks = IO_TEST_TASKS.lock().await;
    if let Some(task) = tasks.remove(&test_id) {
        task.cancel_flag.store(true, Ordering::SeqCst);
        tlog!("[io_test] Cancelled test '{}'", test_id);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_io_test_state(test_id: String) -> Option<IOTestState> {
    IO_TEST_STATES.lock().ok().and_then(|s| s.get(&test_id).cloned())
}

// ============================================================================
// Initiator
// ============================================================================

/// One run in flight: where it transmits, what it has counted, and the tap it
/// listens on.
///
/// Bundling these is what lets the phase runners be methods — they were passing
/// the same six values through argument lists long enough to need a clippy
/// exemption.
struct Run<'a> {
    session_id: &'a str,
    config: &'a TestConfig,
    publish: &'a Publish<'a>,
    cancel: &'a AtomicBool,
    /// This run's tag, stamped on every framed message it sends. A receiver
    /// discards any other run's, so two initiators can share a bus.
    run: u8,
    tap: FrameTap,
    stats: RunStats,
    tracker: SequenceTracker,
}

impl<'a> Run<'a> {
    fn new(
        session_id: &'a str,
        publish: &'a Publish<'a>,
        config: &'a TestConfig,
        cancel: &'a AtomicBool,
    ) -> Self {
        Self {
            session_id,
            config,
            publish,
            cancel,
            run: next_run_tag(),
            tap: register_frame_tap(session_id),
            stats: RunStats::new(),
            tracker: SequenceTracker::new(),
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn state(&self, status: TestStatus) -> IOTestState {
        self.stats.state(self.publish, status, &self.tracker)
    }

    fn emit(&self, status: TestStatus) {
        self.publish.emit(self.state(status));
    }

    /// Send a control message. Control frames carry no sequence number, so they
    /// are not counted as test traffic and a failure is not the run's failure.
    async fn control(&self, c: Command) -> bool {
        send(self.session_id, &self.config.message(Message::Control(c), self.run))
            .await
            .is_ok()
    }

    /// Broadcast `Hello` and wait for whatever answers.
    ///
    /// It is the only message a responder answers while idle, so it is how a run
    /// finds out anything is there at all — and the reply doubles as the
    /// capability exchange.
    async fn say_hello(&mut self) -> Option<PeerInfo> {
        for _ in 0..HELLO_ATTEMPTS {
            if !self.control(Command::Hello).await {
                return None;
            }
            let deadline = Instant::now() + HELLO_TIMEOUT;
            while let Some(frame) = self.tap.recv_until(deadline).await {
                if let Some((Message::Control(Command::HelloReply { capabilities, bus }), _)) =
                    tp::decode(&frame.bytes)
                {
                    return Some(PeerInfo {
                        fd: capabilities & tp::capability::FD != 0,
                        extended: capabilities & tp::capability::EXTENDED != 0,
                        bus,
                    });
                }
            }
        }
        None
    }

    /// Ask the remote for its counters and collect the four status frames.
    async fn request_remote_status(&mut self) -> Option<RemoteStats> {
        if !self.control(Command::RequestStatus).await {
            return None;
        }
        let mut remote = RemoteStats::default();
        let mut seen = 0u8;
        let deadline = Instant::now() + STATUS_TIMEOUT;
        while seen != 0x0F {
            let Some(frame) = self.tap.recv_until(deadline).await else { break };
            if let Some((Message::Status { field, value }, _)) = tp::decode(&frame.bytes) {
                match field {
                    tp::status_field::RX_COUNT => (remote.rx_count, seen) = (value, seen | 1),
                    tp::status_field::TX_COUNT => (remote.tx_count, seen) = (value, seen | 2),
                    tp::status_field::DROPS => (remote.drops, seen) = (value, seen | 4),
                    tp::status_field::FPS => (remote.fps, seen) = (value, seen | 8),
                    _ => {}
                }
            }
        }
        (seen != 0).then_some(remote)
    }

    /// Fold one tapped frame into the run's counters.
    ///
    /// A frame belonging to another run, and a reply this mode did not ask for,
    /// are both ignored.
    fn receive(&mut self, frame: &FrameMessage) {
        let Some((msg, flags)) = tp::decode(&frame.bytes) else { return };
        if flags.run != self.run {
            return;
        }
        let seq = match (self.config.mode, msg) {
            (TestMode::Echo | TestMode::Reliability, Message::PingReply { seq }) => seq,
            // Loopback hands the request back unchanged, so the reply *is* the
            // request — there is no responder in the exchange at all.
            (TestMode::Loopback, Message::PingRequest { seq }) => seq,
            (TestMode::Latency, Message::LatencyReply { seq, .. }) => seq,
            (TestMode::Throughput, Message::Throughput { seq, .. }) => seq,
            _ => return,
        };
        self.tracker.track(seq);
        // Only latency mode records send times, so this costs nothing elsewhere.
        if let Some(sent_us) = self.stats.pending.remove(&seq) {
            self.stats.latency.record(now_us().wrapping_sub(sent_us));
        }
    }

    /// Run the whole exchange and publish its result, which it also returns.
    async fn initiate(mut self) -> IOTestState {
        self.emit(TestStatus::Running);

        // ── Handshake: find the peer, then bind it to this run ──
        if self.config.mode.has_peer() {
            self.stats.peer = self.say_hello().await;
            match &self.stats.peer {
                Some(p) => tlog!(
                    "[io_test] '{}' peer answered: bus {} fd={} extended={}",
                    self.publish.test_id, p.bus, p.fd, p.extended
                ),
                None => tlog!("[io_test] '{}' no peer answered Hello", self.publish.test_id),
            }
            // Surface the peer before any traffic starts.
            self.emit(TestStatus::Running);

            let mode = self.config.mode;
            self.control(Command::Start { mode: mode.code(), run: self.run }).await;
            self.stats.started = Instant::now();
        }

        let tx_aborted = if matches!(self.config.mode, TestMode::Sweep) {
            self.sweep().await;
            false
        } else {
            self.stream().await
        };

        // Latency probes still outstanding never came back.
        self.tracker.drops += self.stats.pending.len() as u64;

        // Any TX/RX mismatch is a drop for modes that expect a reply per frame.
        // Throughput is one-way, so nothing is expected back.
        if !matches!(self.config.mode, TestMode::Throughput)
            && self.stats.tx_count > self.tracker.rx_count
        {
            self.tracker.drops = self.tracker.drops.max(self.stats.tx_count - self.tracker.rx_count);
        }

        if self.config.mode.has_peer() {
            self.stats.remote = self.request_remote_status().await;
            if let Some(r) = &self.stats.remote {
                tlog!(
                    "[io_test] '{}' remote stats: RX={} TX={} drops={} fps={}",
                    self.publish.test_id, r.rx_count, r.tx_count, r.drops, r.fps
                );
            }
            self.control(Command::Stop).await;
        }

        // The pass predicate decides the status: a run that dropped every frame
        // used to report "completed" and be read as a pass.
        let status = if self.cancelled() {
            TestStatus::Stopped
        } else if !tx_aborted && self.stats.passed(self.config.mode, &self.tracker) {
            TestStatus::Completed
        } else {
            TestStatus::Failed
        };
        let state = self.state(status);

        tlog!(
            "[io_test] '{}' {} {:?}: TX={} RX={} drops={} errors={} elapsed={:.1}s",
            self.publish.test_id, self.config.mode, state.status, state.tx_count,
            state.rx_count, state.drops, self.stats.error_count, state.elapsed_sec
        );

        self.publish.emit_final(&state);
        state
    }

    /// One frame per length code, lock-step: request, echo, next code.
    ///
    /// The part that validates CAN FD, and the only part that can. Every other
    /// message is exactly eight bytes, and 8 is where a payload length and a
    /// data length code are the same number.
    async fn sweep(&mut self) {
        // Under loopback the interface hands the request straight back on the id
        // it was sent on; a peer answers on the echo id.
        let want_echo = self.config.mode.has_peer();
        let fd = self.config.use_fd;

        for code in tp::sweep_codes(fd) {
            if self.cancelled() {
                break;
            }
            let expected_len = wiretap_protocol::dlc_to_len(code, fd) as u32;
            let mut row = SweepRow { code, expected_len, received_len: None, passed: false };

            let request = self.config.sweep_request(code);
            if self
                .stats
                .transmit(self.session_id, &request, || format!("sweep code {}", code))
                .await
            {
                let deadline = Instant::now() + SWEEP_TIMEOUT;
                while let Some(frame) = self.tap.recv_until(deadline).await {
                    if tp::sweep_code(frame.frame_id) != Some((code, want_echo)) {
                        continue;
                    }
                    // Sweep frames carry no sequence number, so the tracker never
                    // sees them; count the echo as the crate's responder does.
                    self.tracker.rx_count += 1;
                    row.received_len = Some(frame.bytes.len() as u32);
                    row.passed = tp::sweep_echo_matches(code, fd, &frame.bytes);
                    break;
                }
                if !row.passed {
                    self.stats.error(match row.received_len {
                        Some(got) => format!(
                            "sweep code {}: expected {} bytes, got {}",
                            code, expected_len, got
                        ),
                        None => format!("sweep code {}: no echo ({} bytes)", code, expected_len),
                    });
                }
            }

            self.stats.sweep.push(row);
            self.emit(TestStatus::Running);
        }
    }

    /// Send at a rate and receive replies, until the duration expires.
    ///
    /// Sending stops a little before the end so in-flight replies have somewhere
    /// to arrive; frames still outstanding at the end are drops, not a slow
    /// link. Returns whether it gave up on a session that stopped transmitting.
    async fn stream(&mut self) -> bool {
        let config = self.config;
        let interval = if config.rate_hz > 0.0 {
            Duration::from_secs_f64(1.0 / config.rate_hz)
        } else {
            Duration::from_millis(10)
        };
        let duration = Duration::from_secs_f64(config.duration_sec);
        // Stop sending 1s before the end to drain in-flight responses. For very
        // short tests (<3s), use a third of the duration instead.
        let drain_secs = if config.duration_sec >= 3.0 { 1.0 } else { config.duration_sec / 3.0 };
        let send_deadline = Duration::from_secs_f64(config.duration_sec - drain_secs);

        let start = Instant::now();
        let mut seq: u16 = 0;
        let mut next_send = start;
        let mut sending = true;
        let mut last_progress = start;
        let mut consecutive_failures: u32 = 0;

        loop {
            // One clock read per iteration: the throughput loop spins as fast as
            // the transport allows, so four would be four times the syscalls.
            let now = Instant::now();
            if self.cancelled() || now - start >= duration {
                return false;
            }

            if sending && now - start >= send_deadline {
                sending = false;
                tlog!(
                    "[io_test] '{}' send phase complete (TX={}), draining for {:.1}s",
                    self.publish.test_id, self.stats.tx_count, drain_secs
                );
            }

            if sending && now >= next_send {
                let msg = match config.mode {
                    TestMode::Throughput => Message::Throughput { seq, pattern: tp::pattern::NONE },
                    TestMode::Latency => {
                        // One reading, so the time recorded and the time sent
                        // cannot disagree.
                        let ts = now_us();
                        self.stats.pending.insert(seq, ts);
                        Message::LatencyProbe { seq, ts_us: ts as u32 }
                    }
                    _ => Message::PingRequest { seq },
                };
                let payload = config.message(msg, self.run);

                match send(self.session_id, &payload).await {
                    Ok(result) if result.success => {
                        self.stats.tx_count += 1;
                        consecutive_failures = 0;
                    }
                    Ok(result) => {
                        consecutive_failures += 1;
                        if let Some(err) = result.error {
                            self.stats.error(format!("seq {}: {}", seq, err));
                        }
                    }
                    Err(e) => {
                        // Buffer full is backpressure from the device channel. In
                        // throughput mode, yield briefly and retry the same seq
                        // rather than counting it as a fatal error.
                        if matches!(config.mode, TestMode::Throughput) && e.contains("buffer full") {
                            tokio::time::sleep(Duration::from_micros(100)).await;
                            continue;
                        }
                        consecutive_failures += 1;
                        self.stats.error(format!("seq {}: {}", seq, e));
                    }
                }

                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    tlog!(
                        "[io_test] '{}' aborting: {} consecutive transmit failures",
                        self.publish.test_id, consecutive_failures
                    );
                    return true;
                }

                seq = seq.wrapping_add(1);
                next_send = if matches!(config.mode, TestMode::Throughput) {
                    now
                } else {
                    next_send + interval
                };
            }

            if sending {
                // Non-blocking drain while still sending.
                while let Ok(frame) = self.tap.rx.try_recv() {
                    self.receive(&frame);
                }
            } else if let Some(frame) = self.tap.recv_until(now + Duration::from_millis(50)).await {
                self.receive(&frame);
            }

            if now - last_progress >= PROGRESS_INTERVAL {
                self.emit(TestStatus::Running);
                last_progress = now;
            }

            // The drain phase's own timeout is the yield.
            if sending && matches!(config.mode, TestMode::Throughput) {
                tokio::task::yield_now().await;
            } else if sending {
                tokio::time::sleep(Duration::from_micros(100)).await;
            }
        }
    }
}

// ============================================================================
// Auto test orchestrator
// ============================================================================

async fn run_auto(session_id: &str, test_id: &str, config: &TestConfig, cancel: &AtomicBool) {
    let mut results: Vec<AutoPhaseResult> = Vec::new();

    // (label, mode, rate_hz, duration_sec)
    let phases: &[(&str, TestMode, f64, f64)] = &[
        ("Echo", TestMode::Echo, 100.0, 10.0),
        // The only phase that can prove CAN FD carried what it claimed to.
        ("Sweep", TestMode::Sweep, 0.0, 20.0),
        ("Latency", TestMode::Latency, 10.0, 10.0),
        ("Throughput", TestMode::Throughput, 0.0, 10.0),
        // Rate is replaced below by the echo phase's achieved rate.
        ("Reliability", TestMode::Reliability, 100.0, 60.0),
    ];

    let total = phases.len();
    let mut achieved_echo_fps: f64 = 100.0;
    let mut peer: Option<PeerInfo> = None;

    for (i, (label, mode, rate_hz, duration_sec)) in phases.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        let sub_config = TestConfig {
            mode: *mode,
            role: TestRole::Initiator,
            duration_sec: *duration_sec,
            // Reliability runs at the rate echo actually achieved, backed off to
            // 80% so it is measuring loss rather than causing it.
            rate_hz: match mode {
                TestMode::Reliability => (achieved_echo_fps * 0.8).max(10.0),
                _ => *rate_hz,
            },
            bus: config.bus,
            use_fd: config.use_fd,
            use_extended: config.use_extended,
        };

        let phase_label = format!("{} ({}/{})", label, i + 1, total);
        tlog!(
            "[io_test] '{}' auto phase: {} (rate={:.0} Hz, dur={:.0}s)",
            test_id, phase_label, sub_config.rate_hz, sub_config.duration_sec
        );

        let publish = Publish::phase(test_id, phase_label, &results);
        let state = Run::new(session_id, &publish, &sub_config, cancel).initiate().await;
        let passed = state.status == TestStatus::Completed;

        if matches!(mode, TestMode::Echo) {
            achieved_echo_fps = state.frames_per_sec;
        }
        peer = state.peer.or(peer);

        results.push(AutoPhaseResult {
            phase: label.to_string(),
            passed,
            tx_count: state.tx_count,
            rx_count: state.rx_count,
            drops: state.drops,
            frames_per_sec: state.frames_per_sec,
            elapsed_sec: state.elapsed_sec,
            latency_us: state.latency_us,
            remote: state.remote,
            sweep: state.sweep,
            errors: state.errors,
        });

        // A failed echo is a connectivity problem; the rest would only restate it.
        if matches!(mode, TestMode::Echo) && !passed {
            tlog!("[io_test] '{}' auto: echo failed, skipping remaining phases", test_id);
            break;
        }
    }

    let all_passed = results.len() == total && results.iter().all(|r| r.passed);
    let total_elapsed: f64 = results.iter().map(|r| r.elapsed_sec).sum();
    let status = if cancel.load(Ordering::SeqCst) {
        TestStatus::Stopped
    } else if all_passed {
        TestStatus::Completed
    } else {
        TestStatus::Failed
    };

    tlog!(
        "[io_test] '{}' auto {:?}: {} phases, elapsed={:.1}s",
        test_id, status, results.len(), total_elapsed
    );

    let summary = IOTestState {
        test_id: test_id.to_string(),
        status,
        mode: TestMode::Auto,
        role: TestRole::Initiator,
        tx_count: results.iter().map(|r| r.tx_count).sum(),
        rx_count: results.iter().map(|r| r.rx_count).sum(),
        drops: results.iter().map(|r| r.drops).sum(),
        duplicates: 0,
        out_of_order: 0,
        sequence_gaps: Vec::new(),
        latency_us: results.iter().find_map(|r| r.latency_us.clone()),
        elapsed_sec: total_elapsed,
        frames_per_sec: 0.0,
        errors: Vec::new(),
        remote: results.iter().rev().find_map(|r| r.remote.clone()),
        peer,
        sweep: results.iter().find_map(|r| r.sweep.clone()),
        auto_results: Some(results),
        auto_phase: None,
    };
    crate::ws::dispatch::send_io_test_state(&summary);
    store_test_state(test_id, summary);
}

// ============================================================================
// Responder task
// ============================================================================

/// Answer whatever an initiator asks, for as long as the panel leaves it up.
///
/// It starts idle, answers `Hello` so an initiator can find it, adopts a run on
/// `Start`, and goes back to listening on `Stop` — so one responder serves every
/// phase of an Auto suite instead of needing its own duration set to match.
async fn run_responder(
    session_id: &str,
    publish: &Publish<'_>,
    config: &TestConfig,
    cancel: &AtomicBool,
) {
    let mut tap = register_frame_tap(session_id);
    let mut stats = RunStats::new();

    let capabilities = if config.use_fd { tp::capability::FD } else { 0 }
        | if config.use_extended { tp::capability::EXTENDED } else { 0 };
    let mut responder = Responder::new(capabilities, config.bus);

    let status = |bound: bool| if bound { TestStatus::Running } else { TestStatus::Listening };
    publish.emit(stats.state(publish, status(false), &responder.sequence));

    // One long-lived timer for the progress tick, rather than a fresh timeout
    // registered and cancelled for every frame that arrives.
    let mut ticker = tokio::time::interval(PROGRESS_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    while !cancel.load(Ordering::SeqCst) {
        tokio::select! {
            received = tap.rx.recv() => {
                let Some(frame) = received else { break }; // The session's tap closed.
                let was_bound = responder.run().is_some();
                let replies = responder.on_frame(
                    frame.frame_id,
                    frame.is_extended,
                    frame.is_fd,
                    &frame.bytes,
                    now_us(),
                );
                for reply in replies {
                    stats.transmit(session_id, &config.reply(reply), || "reply".into()).await;
                }

                // A run beginning or ending is worth showing straight away
                // rather than at the next tick.
                let bound = responder.run().is_some();
                if bound != was_bound {
                    if bound {
                        // Elapsed measures the run, not how long it waited.
                        stats = RunStats::new();
                    }
                    tlog!(
                        "[io_test] responder '{}' {}",
                        publish.test_id,
                        match responder.run() {
                            Some(run) => format!("bound to run {}", run),
                            None => "run ended, listening".to_string(),
                        }
                    );
                    publish.emit(stats.state(publish, status(bound), &responder.sequence));
                }
            }
            _ = ticker.tick() => {
                let bound = responder.run().is_some();
                publish.emit(stats.state(publish, status(bound), &responder.sequence));
            }
        }
    }

    tlog!(
        "[io_test] responder '{}' stopped: RX={} TX={} drops={}",
        publish.test_id, responder.sequence.rx_count, stats.tx_count, responder.sequence.drops
    );
    publish.emit(stats.state(publish, TestStatus::Stopped, &responder.sequence));
}

// ============================================================================
// Tests
// ============================================================================
//
// The bus is stood up in process. A real session would be the honest thing to
// run these against, but every entry point into one wants an `AppHandle<Wry>`
// and `tauri::test::mock_app()` hands back an `AppHandle<MockRuntime>`, so no
// headless test can build one. What `intercept` stands in for is a Virtual
// Device with `loopback: true`, which copies a transmitted frame back as a
// received one and does nothing else — and, in `Wire::Peer`, the crate's own
// `Responder`, so a run is measured against the reply side of the contract
// rather than against an echo of itself.

#[cfg(test)]
mod tests {
    use super::*;

    /// What answers a transmit on a test session.
    enum Wire {
        /// Hands the frame straight back, as a Virtual Device's loopback does.
        Loopback,
        /// The crate's reply side: a peer on the far end of the bus.
        Peer(Responder),
        /// A peer whose echo is capped at eight bytes — a codec that read a
        /// length code as a byte count, which is the fault the sweep exists to
        /// catch.
        Truncating(Responder),
        /// A bus that swallows everything: frames leave and nothing comes back.
        Deaf,
    }

    static WIRE: Lazy<StdMutex<HashMap<String, Wire>>> =
        Lazy::new(|| StdMutex::new(HashMap::new()));

    fn attach(session_id: &str, wire: Wire) {
        WIRE.lock().unwrap().insert(session_id.to_string(), wire);
    }

    fn received(arb_id: u32, extended: bool, fd: bool, data: Vec<u8>) -> FrameMessage {
        FrameMessage {
            protocol: "can".into(),
            timestamp_us: now_us(),
            frame_id: arb_id,
            bus: 0,
            dlc: data.len() as u8,
            bytes: data,
            is_extended: extended,
            is_fd: fd,
            source_address: None,
            incomplete: None,
            direction: Some("rx".into()),
        }
    }

    /// Stand in for `io::session_transmit` on a session a test has attached a
    /// wire to. `None` for any other session, so nothing else is affected.
    pub(super) fn intercept(
        session_id: &str,
        payload: &TransmitPayload,
    ) -> Option<Result<crate::io::TransmitResult, String>> {
        let TransmitPayload::CanFrame(tx) = payload else { return None };
        let back = {
            let mut wires = WIRE.lock().ok()?;
            match wires.get_mut(session_id)? {
                Wire::Loopback => {
                    vec![received(tx.frame_id, tx.is_extended, tx.is_fd, tx.data.clone())]
                }
                Wire::Peer(r) => r
                    .on_frame(tx.frame_id, tx.is_extended, tx.is_fd, &tx.data, now_us())
                    .into_iter()
                    .map(|r| received(r.arb_id, r.extended, r.fd, r.data))
                    .collect(),
                Wire::Truncating(r) => r
                    .on_frame(tx.frame_id, tx.is_extended, tx.is_fd, &tx.data, now_us())
                    .into_iter()
                    .map(|mut r| {
                        r.data.truncate(8);
                        received(r.arb_id, r.extended, r.fd, r.data)
                    })
                    .collect(),
                Wire::Deaf => Vec::new(),
            }
        };
        tap_test_frames(session_id, &back);
        Some(Ok(crate::io::TransmitResult::success()))
    }

    fn config(mode: TestMode, use_fd: bool) -> TestConfig {
        TestConfig {
            mode,
            role: TestRole::Initiator,
            duration_sec: 2.0,
            rate_hz: 200.0,
            bus: 0,
            use_fd,
            use_extended: false,
        }
    }

    async fn run(session_id: &str, wire: Wire, config: &TestConfig) -> IOTestState {
        attach(session_id, wire);
        let cancel = AtomicBool::new(false);
        Run::new(session_id, &Publish::new("test", config), config, &cancel).initiate().await
    }

    /// The test the protocol exists for: every length code round-trips at
    /// exactly the length its code names. A codec that confused a byte count
    /// for a length code fails here, at a nameable byte count, with no bus.
    #[tokio::test]
    async fn a_full_fd_sweep_round_trips_with_no_drops() {
        let peer = Wire::Peer(Responder::new(tp::capability::FD, 0));
        let state = run("test_sweep_fd", peer, &config(TestMode::Sweep, true)).await;

        let rows = state.sweep.expect("sweep rows");
        assert_eq!(rows.len(), 16, "every FD length code is swept");
        for row in &rows {
            assert_eq!(
                row.received_len,
                Some(row.expected_len),
                "code {} echoed {:?} bytes, wanted {}",
                row.code, row.received_len, row.expected_len
            );
            assert!(row.passed, "code {} did not match", row.code);
        }
        // 64 bytes: the length no classic frame can carry, and so the one a
        // silent downgrade to classic CAN cannot fake.
        assert_eq!(rows[15].expected_len, 64);
        assert_eq!(rows[0].expected_len, 0, "length zero is reachable");
        assert_eq!((state.drops, state.duplicates), (0, 0));
        assert_eq!(state.status, TestStatus::Completed, "errors: {:?}", state.errors);
        assert!(state.peer.is_some(), "Hello found the peer");
    }

    /// A classic sweep stops at code 8: codes above it are legal on the wire
    /// and still mean 8 bytes, so sweeping them tests the same length nine
    /// times.
    #[tokio::test]
    async fn a_classic_sweep_covers_zero_through_eight() {
        let peer = Wire::Peer(Responder::new(0, 0));
        let state = run("test_sweep_classic", peer, &config(TestMode::Sweep, false)).await;

        let rows = state.sweep.expect("sweep rows");
        assert_eq!(rows.len(), 9);
        assert!(rows.iter().all(|r| r.passed), "{:?}", state.errors);
        assert_eq!(state.status, TestStatus::Completed);
    }

    /// The whole reason the sweep exists. Every framed message is eight bytes,
    /// so a peer that caps its payloads at eight answers all of them perfectly
    /// — and every length code above 8 wrong. The failure has to name the byte
    /// count that broke.
    #[tokio::test]
    async fn a_peer_that_truncates_past_eight_bytes_is_caught() {
        let peer = Wire::Truncating(Responder::new(tp::capability::FD, 0));
        let state = run("test_sweep_truncated", peer, &config(TestMode::Sweep, true)).await;

        let rows = state.sweep.expect("sweep rows");
        assert!(rows[..=8].iter().all(|r| r.passed), "8 bytes and under survive");
        for row in &rows[9..] {
            assert!(!row.passed, "code {} should have failed", row.code);
            assert_eq!(row.received_len, Some(8), "capped at eight");
        }
        assert_eq!(state.status, TestStatus::Failed);
        assert!(
            state.errors.iter().any(|e| e.contains("expected 64 bytes, got 8")),
            "the failure names the byte count: {:?}",
            state.errors
        );
    }

    /// Loopback echoes the ping request unchanged, so the reply *is* the
    /// request — no responder is in the exchange at all.
    #[tokio::test]
    async fn a_loopback_echo_run_reports_no_drops() {
        let state = run("test_echo_loop", Wire::Loopback, &config(TestMode::Loopback, false)).await;

        assert!(state.tx_count > 0, "nothing was transmitted");
        assert_eq!(state.rx_count, state.tx_count, "every frame came back");
        assert_eq!((state.drops, state.duplicates), (0, 0));
        assert_eq!(state.status, TestStatus::Completed, "errors: {:?}", state.errors);
    }

    /// A run that lost every frame has proved nothing, and must not report
    /// "completed" — the status it used to report, whatever the drop count.
    #[tokio::test]
    async fn a_run_that_lost_everything_reports_failed() {
        let mut config = config(TestMode::Echo, false);
        config.duration_sec = 1.0;
        let state = run("test_echo_deaf", Wire::Deaf, &config).await;

        assert!(state.tx_count > 0, "frames did leave");
        assert_eq!(state.rx_count, 0, "and none came back");
        assert_eq!(state.drops, state.tx_count);
        assert!(state.peer.is_none(), "nothing answered Hello");
        assert_eq!(state.status, TestStatus::Failed);
    }

    /// Two taps on one session are independent. Dropping every tap for the
    /// session — what the old cleanup did — meant an initiator and a responder
    /// sharing one killed each other's receive channel.
    #[test]
    fn dropping_one_tap_leaves_the_others_receiving() {
        let session = "test_taps";
        let mut first = register_frame_tap(session);
        let mut second = register_frame_tap(session);
        let frame = received(tp::ID_PING_REQUEST, false, false, vec![0; 8]);

        tap_test_frames(session, std::slice::from_ref(&frame));
        assert!(first.rx.try_recv().is_ok());
        assert!(second.rx.try_recv().is_ok());

        drop(first);
        tap_test_frames(session, std::slice::from_ref(&frame));
        assert!(second.rx.try_recv().is_ok(), "the surviving tap still receives");
    }

    /// A frame stamped with another run's tag is neither answered nor counted,
    /// which is what lets two initiators share a bus.
    #[test]
    fn another_runs_frames_are_not_counted() {
        let config = config(TestMode::Echo, false);
        let publish = Publish::new("t", &config);
        let cancel = AtomicBool::new(false);
        let mut run = Run::new("test_run_tags", &publish, &config, &cancel);

        let theirs = tp::encode(Message::PingReply { seq: 2 }, tp::Flags::new(0, run.run ^ 1));
        run.receive(&received(tp::ID_PING_REPLY, false, false, theirs.to_vec()));
        assert_eq!(run.tracker.rx_count, 0);

        let mine = tp::encode(Message::PingReply { seq: 1 }, tp::Flags::new(0, run.run));
        run.receive(&received(tp::ID_PING_REPLY, false, false, mine.to_vec()));
        assert_eq!(run.tracker.rx_count, 1);
    }

    /// An extended run has to send on 29-bit ids. `use_extended` used to set
    /// the flag and leave the id at `0x7Fx`.
    #[test]
    fn an_extended_run_sends_on_extended_ids() {
        let mut config = config(TestMode::Echo, false);
        config.use_extended = true;
        let TransmitPayload::CanFrame(frame) =
            config.message(Message::PingRequest { seq: 0 }, 1)
        else {
            panic!("expected a CAN frame");
        };
        assert!(frame.is_extended);
        assert_eq!(frame.frame_id, tp::extended_id(tp::ID_PING_REQUEST));
        assert!(tp::is_test_pattern_frame(frame.frame_id));

        // Sweep ids have no extended form: the length code is their meaning.
        let TransmitPayload::CanFrame(sweep) = config.sweep_request(9) else {
            panic!("expected a CAN frame");
        };
        assert!(!sweep.is_extended);
        assert_eq!(sweep.frame_id, tp::SWEEP_REQUEST_BASE + 9);
    }
}
