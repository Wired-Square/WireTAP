// src-tauri/src/io_test.rs
//
// Test Pattern protocol — drives round-trip I/O tests through existing sessions.
//
// State is stored in IO_TEST_STATES and fetched by the frontend via
// get_io_test_state after receiving a TestPatternState WebSocket message.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use tokio::sync::mpsc;

use crate::io::{self, CanTransmitFrame, FrameMessage, TransmitPayload};

// ============================================================================
// Protocol constants (see docs/test-pattern-protocol.md)
// ============================================================================

// Tags (byte 0)
pub const TP_TAG_PING_REQ: u8 = 0x01;
pub const TP_TAG_PING_RESP: u8 = 0x02;
pub const TP_TAG_THROUGHPUT: u8 = 0x03;
pub const TP_TAG_LATENCY_PROBE: u8 = 0x04;
pub const TP_TAG_LATENCY_REPLY: u8 = 0x05;
pub const TP_TAG_CONTROL: u8 = 0x06;
pub const TP_TAG_STATUS: u8 = 0x07;

// Control command codes (byte 4 of control frame)
pub const TP_CMD_REQUEST_STATUS: u8 = 0x04;

// Status report field IDs (byte 2 of status frame)
pub const TP_STATUS_RX_COUNT: u8 = 0x00;
pub const TP_STATUS_TX_COUNT: u8 = 0x01;
pub const TP_STATUS_DROPS: u8 = 0x02;
pub const TP_STATUS_FPS: u8 = 0x03;

// CAN frame IDs
pub const TP_ID_PING_REQ: u32 = 0x7F0;
pub const TP_ID_PING_RESP: u32 = 0x7F1;
pub const TP_ID_THROUGHPUT_TX: u32 = 0x7F2;
#[allow(dead_code)]
pub const TP_ID_THROUGHPUT_RX: u32 = 0x7F3;
pub const TP_ID_LATENCY_PROBE: u32 = 0x7F4;
pub const TP_ID_LATENCY_REPLY: u32 = 0x7F5;
pub const TP_ID_CONTROL: u32 = 0x7F6;

/// Check if a frame_id is a Test Pattern protocol frame.
pub fn is_test_pattern_frame(frame_id: u32) -> bool {
    (0x7F0..=0x7F7).contains(&frame_id)
}

// CAN FD fill patterns
#[allow(dead_code)]
pub const TP_PATTERN_SEQUENTIAL: u8 = 0x00;
#[allow(dead_code)]
pub const TP_PATTERN_WALKING_BIT: u8 = 0x01;
#[allow(dead_code)]
pub const TP_PATTERN_COUNTER: u8 = 0x02;
#[allow(dead_code)]
pub const TP_PATTERN_ALTERNATING: u8 = 0x03;
pub const TP_PATTERN_NONE: u8 = 0xFF;

// ============================================================================
// Types
// ============================================================================

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestMode {
    Echo,
    Throughput,
    Latency,
    Reliability,
    Loopback,
}

impl std::fmt::Display for TestMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TestMode::Echo => write!(f, "echo"),
            TestMode::Throughput => write!(f, "throughput"),
            TestMode::Latency => write!(f, "latency"),
            TestMode::Reliability => write!(f, "reliability"),
            TestMode::Loopback => write!(f, "loopback"),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestRole {
    Initiator,
    Responder,
}

impl std::fmt::Display for TestRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TestRole::Initiator => write!(f, "initiator"),
            TestRole::Responder => write!(f, "responder"),
        }
    }
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
    pub status: String,
    pub mode: String,
    pub role: String,
    pub tx_count: u64,
    pub rx_count: u64,
    pub drops: u64,
    pub duplicates: u64,
    pub out_of_order: u64,
    pub sequence_gaps: Vec<(u16, u16)>,
    pub latency_us: Option<LatencyStats>,
    pub elapsed_sec: f64,
    pub frames_per_sec: f64,
    pub errors: Vec<String>,
    pub remote: Option<RemoteStats>,
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

/// Frame tap senders: session_id -> list of senders that want Test Pattern frames.
static FRAME_TAPS: Lazy<StdMutex<HashMap<String, Vec<mpsc::UnboundedSender<FrameMessage>>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

fn store_test_state(test_id: &str, state: IOTestState) {
    if let Ok(mut states) = IO_TEST_STATES.lock() {
        states.insert(test_id.to_string(), state);
    }
}


fn register_frame_tap(session_id: &str) -> mpsc::UnboundedReceiver<FrameMessage> {
    let (tx, rx) = mpsc::unbounded_channel();
    if let Ok(mut taps) = FRAME_TAPS.lock() {
        taps.entry(session_id.to_string()).or_default().push(tx);
    }
    rx
}

fn unregister_frame_taps(session_id: &str) {
    if let Ok(mut taps) = FRAME_TAPS.lock() {
        taps.remove(session_id);
    }
}

/// Called from buffer_store::append_frames_to_session to forward test frames.
/// Returns true if any frames were tapped (for logging).
pub fn tap_test_frames(session_id: &str, frames: &[FrameMessage]) {
    let taps = match FRAME_TAPS.lock() {
        Ok(t) => t,
        Err(_) => return,
    };
    if let Some(senders) = taps.get(session_id) {
        for frame in frames {
            if is_test_pattern_frame(frame.frame_id) {
                for sender in senders {
                    let _ = sender.send(frame.clone());
                }
            }
        }
    }
}

// ============================================================================
// Payload helpers
// ============================================================================

fn build_test_payload(tag: u8, flags: u8, seq: u16, extra: [u8; 4]) -> Vec<u8> {
    let mut data = vec![tag, flags, (seq >> 8) as u8, (seq & 0xFF) as u8];
    data.extend_from_slice(&extra);
    data
}

fn parse_test_payload(data: &[u8]) -> Option<(u8, u8, u16, [u8; 4])> {
    if data.len() < 8 {
        return None;
    }
    let tag = data[0];
    let flags = data[1];
    let seq = ((data[2] as u16) << 8) | (data[3] as u16);
    let mut extra = [0u8; 4];
    extra.copy_from_slice(&data[4..8]);
    Some((tag, flags, seq, extra))
}

fn now_us() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

fn build_can_frame(frame_id: u32, data: Vec<u8>, bus: u8, is_fd: bool, is_extended: bool) -> CanTransmitFrame {
    CanTransmitFrame {
        frame_id,
        data,
        bus,
        is_extended,
        is_fd,
        is_brs: is_fd,
        is_rtr: false,
    }
}

// ============================================================================
// Sequence tracker
// ============================================================================

struct SequenceTracker {
    expected: u16,
    rx_count: u64,
    drops: u64,
    duplicates: u64,
    out_of_order: u64,
    gaps: Vec<(u16, u16)>,
}

impl SequenceTracker {
    fn new() -> Self {
        Self {
            expected: 0,
            rx_count: 0,
            drops: 0,
            duplicates: 0,
            out_of_order: 0,
            gaps: Vec::new(),
        }
    }

    fn track(&mut self, seq: u16) {
        self.rx_count += 1;

        if seq == self.expected {
            self.expected = self.expected.wrapping_add(1);
        } else if seq > self.expected {
            let gap = seq.wrapping_sub(self.expected);
            if gap > 32768 {
                self.out_of_order += 1;
            } else {
                self.drops += gap as u64;
                self.gaps.push((self.expected, seq));
                self.expected = seq.wrapping_add(1);
            }
        } else {
            // seq < expected
            let diff = self.expected.wrapping_sub(seq);
            if diff > 32768 {
                // Wrap
                let gap = (65536u32 - self.expected as u32 + seq as u32) as u64;
                if gap > 1 {
                    self.drops += gap - 1;
                    self.gaps.push((self.expected, seq));
                }
                self.expected = seq.wrapping_add(1);
            } else {
                self.out_of_order += 1;
            }
        }
    }
}

// ============================================================================
// Latency collector
// ============================================================================

struct LatencyCollector {
    samples: Vec<u64>,
}

impl LatencyCollector {
    fn new() -> Self {
        Self { samples: Vec::new() }
    }

    fn record(&mut self, rtt_us: u64) {
        self.samples.push(rtt_us);
    }

    fn stats(&self) -> Option<LatencyStats> {
        if self.samples.is_empty() {
            return None;
        }
        let mut sorted = self.samples.clone();
        sorted.sort_unstable();
        let n = sorted.len();
        let sum: u64 = sorted.iter().sum();
        Some(LatencyStats {
            min_us: sorted[0],
            max_us: sorted[n - 1],
            mean_us: sum / n as u64,
            p50_us: sorted[n / 2],
            p95_us: sorted[(n as f64 * 0.95) as usize],
            p99_us: sorted[(n as f64 * 0.99) as usize],
            count: n as u64,
        })
    }
}

/// Send a status request and collect status report frames from the remote.
/// Returns RemoteStats if the remote responds within the timeout.
async fn request_remote_status(
    session_id: &str,
    frame_rx: &mut mpsc::UnboundedReceiver<FrameMessage>,
    bus: u8,
    use_fd: bool,
    use_extended: bool,
) -> Option<RemoteStats> {
    // Send control frame: tag=0x06, cmd=REQUEST_STATUS
    let extra = [TP_CMD_REQUEST_STATUS, 0, 0, 0];
    let flags = (bus & 0x07) << 1;
    let data = build_test_payload(TP_TAG_CONTROL, flags, 0, extra);
    let frame = build_can_frame(TP_ID_CONTROL, data, bus, use_fd, use_extended);
    let payload = TransmitPayload::CanFrame(frame);

    if let Err(e) = io::session_transmit(session_id, &payload).await {
        tlog!("[io_test] Failed to send status request: {}", e);
        return None;
    }

    // Collect status report frames (up to 500ms)
    let mut remote = RemoteStats::default();
    let mut fields_received = 0u8;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);

    while std::time::Instant::now() < deadline && fields_received != 0x0F {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match tokio::time::timeout(remaining, frame_rx.recv()).await {
            Ok(Some(frame)) => {
                if let Some((tag, _flags, _seq, extra)) = parse_test_payload(&frame.bytes) {
                    if tag == TP_TAG_STATUS {
                        let field_id = extra[0];
                        let value = ((extra[1] as u32) << 16)
                                  | ((extra[2] as u32) << 8)
                                  |  (extra[3] as u32);
                        match field_id {
                            TP_STATUS_RX_COUNT => { remote.rx_count = value; fields_received |= 1; }
                            TP_STATUS_TX_COUNT => { remote.tx_count = value; fields_received |= 2; }
                            TP_STATUS_DROPS    => { remote.drops = value; fields_received |= 4; }
                            TP_STATUS_FPS      => { remote.fps = value; fields_received |= 8; }
                            _ => {}
                        }
                    }
                }
            }
            Ok(None) => break,  // Channel closed
            Err(_) => break,    // Timeout expired
        }
    }

    if fields_received > 0 {
        Some(remote)
    } else {
        None
    }
}

/// Send status report frames (4 frames, one per metric).
async fn send_status_reports(
    session_id: &str,
    config: &TestConfig,
    rx_count: u32,
    tx_count: u32,
    drops: u32,
    fps: u32,
) {
    let flags = (config.bus & 0x07) << 1;
    for (field_id, value) in [
        (TP_STATUS_RX_COUNT, rx_count),
        (TP_STATUS_TX_COUNT, tx_count),
        (TP_STATUS_DROPS, drops),
        (TP_STATUS_FPS, fps),
    ] {
        let extra = [
            field_id,
            ((value >> 16) & 0xFF) as u8,
            ((value >> 8) & 0xFF) as u8,
            (value & 0xFF) as u8,
        ];
        let data = build_test_payload(TP_TAG_STATUS, flags, 0, extra);
        let frame = build_can_frame(TP_ID_CONTROL, data, config.bus, config.use_fd, config.use_extended);
        let _ = io::session_transmit(session_id, &TransmitPayload::CanFrame(frame)).await;
    }
}

/// Process a received test frame — shared by send and drain phases.
fn receive_frame(
    frame: &FrameMessage,
    rx_tag: u8,
    config: &TestConfig,
    tracker: &mut SequenceTracker,
    latency: &mut LatencyCollector,
    pending_timestamps: &mut HashMap<u16, u64>,
) {
    if let Some((tag, _flags, resp_seq, _extra)) = parse_test_payload(&frame.bytes) {
        if tag == rx_tag {
            tracker.track(resp_seq);
            if matches!(config.mode, TestMode::Latency) {
                if let Some(sent_ts) = pending_timestamps.remove(&resp_seq) {
                    let rtt = now_us().wrapping_sub(sent_ts);
                    latency.record(rtt);
                }
            }
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
    // Check if already running
    {
        let tasks = IO_TEST_TASKS.lock().await;
        if tasks.contains_key(&test_id) {
            return Err(format!("Test '{}' is already running", test_id));
        }
    }

    let cancel_flag = std::sync::Arc::new(AtomicBool::new(false));
    let cancel_clone = cancel_flag.clone();
    let test_id_clone = test_id.clone();
    let session_id_clone = session_id.clone();

    let handle = tauri::async_runtime::spawn(async move {
        match config.role {
            TestRole::Initiator => {
                run_initiator(&session_id_clone, &test_id_clone, &config, &cancel_clone).await;
            }
            TestRole::Responder => {
                run_responder(&session_id_clone, &test_id_clone, &config, &cancel_clone).await;
            }
        }
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
// Initiator task
// ============================================================================

async fn run_initiator(
    session_id: &str,
    test_id: &str,
    config: &TestConfig,
    cancel: &AtomicBool,
) {
    let mut frame_rx = register_frame_tap(session_id);
    let start = std::time::Instant::now();
    let interval = if config.rate_hz > 0.0 {
        std::time::Duration::from_secs_f64(1.0 / config.rate_hz)
    } else {
        std::time::Duration::from_millis(10)
    };
    let duration = std::time::Duration::from_secs_f64(config.duration_sec);
    // Stop sending 1s before the end to drain in-flight responses.
    // For very short tests (<3s), use 1/3 of the duration as drain time.
    let drain_secs = if config.duration_sec >= 3.0 { 1.0 } else { config.duration_sec / 3.0 };
    let send_deadline = std::time::Duration::from_secs_f64(config.duration_sec - drain_secs);

    let mut seq: u16 = 0;
    let mut tx_count: u64 = 0;
    let mut tracker = SequenceTracker::new();
    let mut latency = LatencyCollector::new();
    let mut pending_timestamps: HashMap<u16, u64> = HashMap::new();
    let mut errors: Vec<String> = Vec::new();
    let mut consecutive_tx_failures: u32 = 0;
    const MAX_CONSECUTIVE_FAILURES: u32 = 10;
    let mut last_progress = std::time::Instant::now();
    let progress_interval = std::time::Duration::from_millis(250);

    // Determine which frame ID and tag to use based on mode
    let (tx_frame_id, tx_tag, rx_tag) = match config.mode {
        TestMode::Echo | TestMode::Reliability => {
            (TP_ID_PING_REQ, TP_TAG_PING_REQ, TP_TAG_PING_RESP)
        }
        TestMode::Loopback => {
            // Virtual Device loopback echoes the frame back unchanged —
            // same frame ID and tag, no responder needed.
            (TP_ID_PING_REQ, TP_TAG_PING_REQ, TP_TAG_PING_REQ)
        }
        TestMode::Throughput => {
            (TP_ID_THROUGHPUT_TX, TP_TAG_THROUGHPUT, TP_TAG_THROUGHPUT)
        }
        TestMode::Latency => {
            (TP_ID_LATENCY_PROBE, TP_TAG_LATENCY_PROBE, TP_TAG_LATENCY_REPLY)
        }
    };

    // Store initial state
    let mode_str = config.mode.to_string();
    let role_str = config.role.to_string();
    store_test_state(test_id, IOTestState {
        test_id: test_id.to_string(),
        status: "running".to_string(),
        mode: mode_str.clone(),
        role: role_str.clone(),
        tx_count: 0,
        rx_count: 0,
        drops: 0,
        duplicates: 0,
        out_of_order: 0,
        sequence_gaps: Vec::new(),
        latency_us: None,
        elapsed_sec: 0.0,
        frames_per_sec: 0.0,
        errors: Vec::new(),
            remote: None,
        });
    crate::ws::dispatch::send_io_test_state(test_id);

    let mut next_send = std::time::Instant::now();
    let mut sending = true;

    // ── Main loop: send + receive until duration expires ──
    loop {
        if cancel.load(Ordering::SeqCst) || start.elapsed() >= duration {
            break;
        }

        let now = std::time::Instant::now();
        let elapsed_dur = start.elapsed();

        // Phase 1: Send frames until send_deadline
        // Phase 2: Stop sending, keep receiving until duration (drain period)
        if sending && elapsed_dur >= send_deadline {
            sending = false;
            tlog!("[io_test] '{}' send phase complete (TX={}), draining responses for {:.1}s",
                  test_id, tx_count, drain_secs);
        }

        if sending && now >= next_send {
            let extra = match config.mode {
                TestMode::Latency => {
                    let ts = (now_us() & 0xFFFFFFFF) as u32;
                    pending_timestamps.insert(seq, now_us());
                    ts.to_be_bytes()
                }
                TestMode::Throughput => {
                    [TP_PATTERN_NONE, 0, 0, 0]
                }
                _ => [0, 0, 0, 0],
            };

            let flags = (config.bus & 0x07) << 1;
            let data = build_test_payload(tx_tag, flags, seq, extra);
            let frame = build_can_frame(tx_frame_id, data, config.bus, config.use_fd, config.use_extended);
            let payload = TransmitPayload::CanFrame(frame);

            match io::session_transmit(session_id, &payload).await {
                Ok(result) => {
                    if result.success {
                        tx_count += 1;
                        consecutive_tx_failures = 0;
                    } else if let Some(err) = result.error {
                        consecutive_tx_failures += 1;
                        errors.push(format!("seq {}: {}", seq, err));
                    }
                }
                Err(e) => {
                    consecutive_tx_failures += 1;
                    errors.push(format!("seq {}: {}", seq, e));
                }
            }

            // Abort if transmit is persistently failing
            if consecutive_tx_failures >= MAX_CONSECUTIVE_FAILURES {
                tlog!("[io_test] '{}' aborting: {} consecutive transmit failures",
                      test_id, consecutive_tx_failures);
                break;
            }

            seq = seq.wrapping_add(1);

            if matches!(config.mode, TestMode::Throughput) {
                next_send = now;
            } else {
                next_send += interval;
            }
        }

        // Receive incoming frames (non-blocking during send phase, blocking during drain)
        if sending {
            // Non-blocking drain while still sending
            loop {
                match frame_rx.try_recv() {
                    Ok(frame) => {
                        receive_frame(&frame, rx_tag, config, &mut tracker, &mut latency, &mut pending_timestamps);
                    }
                    Err(mpsc::error::TryRecvError::Empty) => break,
                    Err(mpsc::error::TryRecvError::Disconnected) => break,
                }
            }
        } else {
            // Drain phase: wait for responses with a short timeout
            match tokio::time::timeout(
                std::time::Duration::from_millis(50),
                frame_rx.recv(),
            ).await {
                Ok(Some(frame)) => {
                    receive_frame(&frame, rx_tag, config, &mut tracker, &mut latency, &mut pending_timestamps);
                }
                _ => {}
            }
        }

        // Progress update
        if last_progress.elapsed() >= progress_interval {
            let elapsed = start.elapsed().as_secs_f64();
            let fps = if elapsed > 0.0 { tx_count as f64 / elapsed } else { 0.0 };
            store_test_state(test_id, IOTestState {
                test_id: test_id.to_string(),
                status: "running".to_string(),
                mode: mode_str.clone(),
                role: role_str.clone(),
                tx_count,
                rx_count: tracker.rx_count,
                drops: tracker.drops,
                duplicates: tracker.duplicates,
                out_of_order: tracker.out_of_order,
                sequence_gaps: tracker.gaps.clone(),
                latency_us: latency.stats(),
                elapsed_sec: elapsed,
                frames_per_sec: fps,
                errors: errors.clone(),
            remote: None,
        });
            crate::ws::dispatch::send_io_test_state(test_id);
            last_progress = std::time::Instant::now();
        }

        // Yield
        if sending && matches!(config.mode, TestMode::Throughput) {
            tokio::task::yield_now().await;
        } else if sending {
            tokio::time::sleep(std::time::Duration::from_micros(100)).await;
        }
        // During drain phase, the timeout in recv provides the yield
    }

    // Count unmatched pending latency probes as drops
    tracker.drops += pending_timestamps.len() as u64;

    // Count any TX/RX mismatch as drops for modes that expect a reply per frame.
    // Throughput is one-way TX — no replies expected, so skip this check.
    if !matches!(config.mode, TestMode::Throughput) && tx_count > tracker.rx_count {
        let unaccounted = tx_count - tracker.rx_count;
        if unaccounted > tracker.drops {
            tracker.drops = unaccounted;
        }
    }

    // Request remote endpoint stats
    let remote = request_remote_status(
        session_id, &mut frame_rx, config.bus, config.use_fd, config.use_extended,
    ).await;
    if let Some(ref r) = remote {
        tlog!("[io_test] '{}' remote stats: RX={} TX={} drops={} fps={}",
              test_id, r.rx_count, r.tx_count, r.drops, r.fps);
    }

    // Final state
    let elapsed = start.elapsed().as_secs_f64();
    let fps = if elapsed > 0.0 { tx_count as f64 / elapsed } else { 0.0 };
    let status = if cancel.load(Ordering::SeqCst) {
        "stopped"
    } else if consecutive_tx_failures >= MAX_CONSECUTIVE_FAILURES {
        "failed"
    } else {
        "completed"
    };

    tlog!(
        "[io_test] '{}' {}: TX={} RX={} drops={} errors={} elapsed={:.1}s",
        test_id, status, tx_count, tracker.rx_count, tracker.drops, errors.len(), elapsed
    );

    store_test_state(test_id, IOTestState {
        test_id: test_id.to_string(),
        status: status.to_string(),
        mode: mode_str,
        role: role_str,
        tx_count,
        rx_count: tracker.rx_count,
        drops: tracker.drops,
        duplicates: tracker.duplicates,
        out_of_order: tracker.out_of_order,
        sequence_gaps: tracker.gaps,
        latency_us: latency.stats(),
        elapsed_sec: elapsed,
        frames_per_sec: fps,
        errors,
        remote,
    });
    crate::ws::dispatch::send_io_test_state(test_id);

    // Cleanup
    unregister_frame_taps(session_id);
    let mut tasks = IO_TEST_TASKS.lock().await;
    tasks.remove(test_id);
}

// ============================================================================
// Responder task
// ============================================================================

async fn run_responder(
    session_id: &str,
    test_id: &str,
    config: &TestConfig,
    cancel: &AtomicBool,
) {
    let mut frame_rx = register_frame_tap(session_id);
    let start = std::time::Instant::now();
    let duration = std::time::Duration::from_secs_f64(config.duration_sec);

    let mut tx_count: u64 = 0;
    let mut rx_count: u64 = 0;
    let mut errors: Vec<String> = Vec::new();
    let mut last_progress = std::time::Instant::now();
    let progress_interval = std::time::Duration::from_millis(250);

    let mode_str = config.mode.to_string();
    let role_str = config.role.to_string();

    store_test_state(test_id, IOTestState {
        test_id: test_id.to_string(),
        status: "running".to_string(),
        mode: mode_str.clone(),
        role: role_str.clone(),
        tx_count: 0,
        rx_count: 0,
        drops: 0,
        duplicates: 0,
        out_of_order: 0,
        sequence_gaps: Vec::new(),
        latency_us: None,
        elapsed_sec: 0.0,
        frames_per_sec: 0.0,
        errors: Vec::new(),
            remote: None,
        });
    crate::ws::dispatch::send_io_test_state(test_id);

    loop {
        if cancel.load(Ordering::SeqCst) || start.elapsed() >= duration {
            break;
        }

        // Wait for incoming frames
        match tokio::time::timeout(
            std::time::Duration::from_millis(100),
            frame_rx.recv(),
        )
        .await
        {
            Ok(Some(frame)) => {
                if let Some((tag, flags, seq, extra)) = parse_test_payload(&frame.bytes) {
                    // Handle status request from initiator
                    if tag == TP_TAG_CONTROL && extra[0] == TP_CMD_REQUEST_STATUS {
                        let elapsed = start.elapsed().as_secs_f64();
                        let current_fps = if elapsed > 0.0 { rx_count as f64 / elapsed } else { 0.0 };
                        tlog!("[io_test] responder '{}' status requested: RX={} TX={} fps={:.0}",
                              test_id, rx_count, tx_count, current_fps);
                        send_status_reports(
                            session_id, config, rx_count as u32, tx_count as u32, 0, current_fps as u32,
                        ).await;
                        continue;
                    }

                    rx_count += 1;

                    let (resp_tag, resp_id) = match tag {
                        TP_TAG_PING_REQ => (Some(TP_TAG_PING_RESP), Some(TP_ID_PING_RESP)),
                        TP_TAG_LATENCY_PROBE => (Some(TP_TAG_LATENCY_REPLY), Some(TP_ID_LATENCY_REPLY)),
                        _ => (None, None),
                    };

                    if let (Some(resp_tag), Some(resp_id)) = (resp_tag, resp_id) {
                        let resp_extra = if tag == TP_TAG_LATENCY_PROBE {
                            extra  // Echo timestamp unchanged
                        } else {
                            [0, 0, 0, 0]
                        };

                        let data = build_test_payload(resp_tag, flags, seq, resp_extra);
                        let can_frame = build_can_frame(
                            resp_id,
                            data,
                            config.bus,
                            config.use_fd,
                            config.use_extended,
                        );
                        let payload = TransmitPayload::CanFrame(can_frame);

                        match io::session_transmit(session_id, &payload).await {
                            Ok(result) => {
                                if result.success {
                                    tx_count += 1;
                                } else if let Some(err) = result.error {
                                    errors.push(err);
                                }
                            }
                            Err(e) => {
                                errors.push(e);
                            }
                        }
                    }
                }
            }
            Ok(None) => break,  // Channel closed
            Err(_) => {}  // Timeout, loop continues
        }

        // Progress update
        if last_progress.elapsed() >= progress_interval {
            let elapsed = start.elapsed().as_secs_f64();
            let fps = if elapsed > 0.0 { rx_count as f64 / elapsed } else { 0.0 };
            store_test_state(test_id, IOTestState {
                test_id: test_id.to_string(),
                status: "running".to_string(),
                mode: mode_str.clone(),
                role: role_str.clone(),
                tx_count,
                rx_count,
                drops: 0,
                duplicates: 0,
                out_of_order: 0,
                sequence_gaps: Vec::new(),
                latency_us: None,
                elapsed_sec: elapsed,
                frames_per_sec: fps,
                errors: errors.clone(),
            remote: None,
        });
            crate::ws::dispatch::send_io_test_state(test_id);
            last_progress = std::time::Instant::now();
        }
    }

    let elapsed = start.elapsed().as_secs_f64();
    let fps = if elapsed > 0.0 { rx_count as f64 / elapsed } else { 0.0 };
    let status = if cancel.load(Ordering::SeqCst) { "stopped" } else { "completed" };

    tlog!(
        "[io_test] responder '{}' {}: RX={} TX={} elapsed={:.1}s",
        test_id, status, rx_count, tx_count, elapsed
    );

    store_test_state(test_id, IOTestState {
        test_id: test_id.to_string(),
        status: status.to_string(),
        mode: mode_str,
        role: role_str,
        tx_count,
        rx_count,
        drops: 0,
        duplicates: 0,
        out_of_order: 0,
        sequence_gaps: Vec::new(),
        latency_us: None,
        elapsed_sec: elapsed,
        frames_per_sec: fps,
        errors,
            remote: None,
        });
    crate::ws::dispatch::send_io_test_state(test_id);

    // Cleanup
    unregister_frame_taps(session_id);
    let mut tasks = IO_TEST_TASKS.lock().await;
    tasks.remove(test_id);
}
