// io/modbus_tcp/scanner.rs
//
// Modbus TCP discovery — find registers, unit IDs, and which function codes a
// device actually implements.
//
// Architecture:
//   - Standalone: opens its own connection, needs no session and no catalogue
//   - Register scan: chunked reads, subdividing on exception to localise gaps
//   - Unit ID scan: FC43 device identification with a register-read fallback
//   - Function code probe: one read per (unit, type) — "who answers what?"
//   - Frames go through the shared `FrameSink` (see `poll.rs`), so a sweep's
//     results reach a session capture by the same path a poll's do

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock,
};
use tokio::time::{sleep, Duration};

use super::poll::{modbus_frame, per_register_frames, FrameSink, ReadData};
use super::reader::RegisterType;
use wiretap_catalog::modbus::{
    coils_to_bytes, registers_to_bytes, AddressBlock, ExceptionCode, RangeError, ReadOutcome, RegisterSweep,
    SweepEnd, SweepLimits, SweepProgress, SweepStep,
};
use wiretap_io::modbus::{DeviceIdCode, ModbusTcp, ReadRequest, Reading, RequestError, TcpOptions};
use crate::io::SignalThrottle;

/// Device identification info discovered via FC43 (Read Device Identification)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DeviceInfoPayload {
    pub unit_id: u8,
    pub vendor: Option<String>,
    pub product_code: Option<String>,
    pub revision: Option<String>,
}

// ============================================================================
// Scan state
// ============================================================================

/// A sweep's progress, pushed on the scan session's WebSocket channel and kept
/// here for MCP, which is in-process Rust and cannot subscribe to that channel.
/// Frames are not carried here — they reach the UI through the session's
/// capture like any other frames.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "ModbusScanStateMsg"))]
pub struct ModbusScanState {
    pub status: String,
    pub progress: Option<ScanProgressPayload>,
    pub device_info: Vec<DeviceInfoPayload>,
    /// Diagnoses worth surfacing, e.g. a function code that never answered.
    pub notes: Vec<String>,
    /// The capture this sweep is filling.
    ///
    /// Sent with every tick because the UI needs it long after the sweep: a
    /// results tab reads its own capture once a later sweep owns the frame
    /// store. Registration cannot supply it — the capture is created in
    /// `ModbusScanSource::start`, which runs after the subscriber attaches —
    /// so the first progress tick is the earliest it can be known, and it must
    /// not depend on anyone still watching when the sweep ends.
    pub capture_id: Option<String>,
}

static SCAN_STATES: Lazy<RwLock<HashMap<String, ModbusScanState>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Terminal summaries, kept so a caller that didn't await the sweep can still
/// collect its result. Cleared with the scan state when the session stops.
static SCAN_RESULTS: Lazy<RwLock<HashMap<String, Result<ScanCompletePayload, String>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

fn store_scan_state(session_id: &str, state: ModbusScanState) {
    if let Ok(mut states) = SCAN_STATES.write() {
        states.insert(session_id.to_string(), state);
    }
}

pub fn get_scan_state(session_id: &str) -> Option<ModbusScanState> {
    SCAN_STATES.read().ok().and_then(|s| s.get(session_id).cloned())
}

/// Hands each sweep's outcome to anything waiting on it. The outcome travels
/// with the wakeup because a stop can clear the store before a waiter reads it.
/// Broadcast rather than per-session: the number of concurrent sweeps is tiny.
static SCAN_RESULT_READY: Lazy<
    tokio::sync::broadcast::Sender<(String, Result<ScanCompletePayload, String>)>,
> = Lazy::new(|| tokio::sync::broadcast::channel(16).0);

pub fn store_scan_result(session_id: &str, outcome: Result<ScanCompletePayload, String>) {
    if let Ok(mut results) = SCAN_RESULTS.write() {
        results.insert(session_id.to_string(), outcome.clone());
    }
    let _ = SCAN_RESULT_READY.send((session_id.to_string(), outcome));
}

pub fn get_scan_result(session_id: &str) -> Option<Result<ScanCompletePayload, String>> {
    SCAN_RESULTS.read().ok().and_then(|s| s.get(session_id).cloned())
}

/// Wait for a sweep's summary or error, or `None` if neither arrives within `timeout`.
///
/// For callers that can't subscribe to the session's WebSocket channel — MCP is
/// in-process Rust, so the transport migration doesn't reach it.
pub async fn await_scan_result(
    session_id: &str,
    timeout: Duration,
) -> Option<Result<ScanCompletePayload, String>> {
    use tokio::sync::broadcast::error::RecvError;
    // Subscribe before reading the store, or a result stored between the two is
    // missed until the timeout.
    let mut ready = SCAN_RESULT_READY.subscribe();
    tokio::time::timeout(timeout, async {
        if let Some(outcome) = get_scan_result(session_id) {
            return outcome;
        }
        loop {
            match ready.recv().await {
                Ok((id, outcome)) if id == session_id => return outcome,
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    if let Some(outcome) = get_scan_result(session_id) {
                        return outcome;
                    }
                }
                Err(RecvError::Closed) => std::future::pending().await,
            }
        }
    })
    .await
    .ok()
}

/// Drop both the progress state and the summary for a session. Called when the
/// scan session stops, so the state lives exactly as long as the session does.
pub fn clear_scan_state(session_id: &str) {
    if let Ok(mut states) = SCAN_STATES.write() {
        states.remove(session_id);
    }
    if let Ok(mut results) = SCAN_RESULTS.write() {
        results.remove(session_id);
    }
}

// ============================================================================
// Configuration
// ============================================================================

async fn resolve(host: &str, port: u16) -> Result<SocketAddr, String> {
    crate::io::net::resolve_host_port(host, port)
        .await
        .map_err(|e| e.user_message())
}

/// A sweep's connection. The connect is bounded by the same timeout as each
/// request, so an unreachable device costs one timeout, not the OS's.
fn sweep_connection(
    addr: SocketAddr,
    timeout_ms: u64,
    settle_ms: u64,
    reconnect_per_request: bool,
) -> ModbusTcp {
    let timeout = Duration::from_millis(timeout_ms);
    let options = TcpOptions {
        connect_timeout: timeout,
        op_timeout: timeout,
        settle: Duration::from_millis(settle_ms),
        reconnect_per_request,
        ..TcpOptions::default()
    };
    ModbusTcp::new(addr.to_string(), options)
}

fn read_request(register_type: &RegisterType, start: u16, count: u16, unit: u8) -> ReadRequest {
    ReadRequest {
        register_type: register_type.catalog(),
        start,
        count,
        unit: Some(unit),
    }
}

fn default_timeout_ms() -> u64 {
    2000
}
fn default_settle_ms() -> u64 {
    0
}
fn default_max_consecutive_timeouts() -> u32 {
    3
}
fn default_max_registers() -> u32 {
    4096
}
fn default_max_requests() -> u32 {
    2000
}
fn default_repeat() -> u32 {
    1
}
fn default_repeat_delay_ms() -> u64 {
    6000
}

/// Configuration for register range scanning.
///
/// Everything past `inter_request_delay_ms` has a serde default, so a caller
/// that only knows the original fields still deserialises.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ModbusScanConfig {
    /// Server hostname or IP
    #[serde(default = "default_host")]
    #[cfg_attr(test, ts(as = "Option<String>", optional))]
    pub host: String,
    /// Server port (default 502)
    #[serde(default = "default_port")]
    #[cfg_attr(test, ts(as = "Option<u16>", optional))]
    pub port: u16,
    /// Modbus unit/slave ID (1-247)
    #[serde(default = "default_unit_id")]
    pub unit_id: u8,
    /// Register type to scan
    pub register_type: RegisterType,
    /// First register address to scan (protocol-level, 0-based)
    pub start_register: u16,
    /// Last register address to scan (inclusive)
    pub end_register: u16,
    /// Number of registers to read per bulk request (max 125 for holding/input, 2000 for coils)
    pub chunk_size: u16,
    /// Delay between scan requests in milliseconds
    pub inter_request_delay_ms: u64,

    /// Per-request timeout. The only thing bounding a device that answers a
    /// function code with silence rather than an exception.
    #[serde(default = "default_timeout_ms")]
    #[cfg_attr(test, ts(as = "Option<u64>", optional))]
    pub timeout_ms: u64,
    /// Pause after connecting before the first request on that socket.
    #[serde(default = "default_settle_ms")]
    #[cfg_attr(test, ts(as = "Option<u64>", optional))]
    pub connect_settle_ms: u64,
    /// Open a fresh connection per request, for stacks that serve one
    /// conversation per socket.
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub reconnect_per_request: bool,
    /// Give up on this register type after this many silent requests in a row.
    #[serde(default = "default_max_consecutive_timeouts")]
    #[cfg_attr(test, ts(as = "Option<u32>", optional))]
    pub max_consecutive_timeouts: u32,
    /// Refuse a sweep wider than this.
    #[serde(default = "default_max_registers")]
    #[cfg_attr(test, ts(as = "Option<u32>", optional))]
    pub max_registers: u32,
    /// Hard ceiling on requests issued. This, not `max_registers`, is what
    /// actually bounds how long a scan can take.
    #[serde(default = "default_max_requests")]
    #[cfg_attr(test, ts(as = "Option<u32>", optional))]
    pub max_requests: u32,
    /// Number of passes. Two or more samples the same registers repeatedly, so
    /// the Changes tool can separate live telemetry from static configuration.
    #[serde(default = "default_repeat")]
    #[cfg_attr(test, ts(as = "Option<u32>", optional))]
    pub repeat: u32,
    /// Gap between passes when `repeat > 1`.
    #[serde(default = "default_repeat_delay_ms")]
    #[cfg_attr(test, ts(as = "Option<u64>", optional))]
    pub repeat_delay_ms: u64,
}

/// Configuration for unit ID scanning
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UnitIdScanConfig {
    /// Server hostname or IP
    #[serde(default = "default_host")]
    #[cfg_attr(test, ts(as = "Option<String>", optional))]
    pub host: String,
    /// Server port (default 502)
    #[serde(default = "default_port")]
    #[cfg_attr(test, ts(as = "Option<u16>", optional))]
    pub port: u16,
    /// First unit ID to scan (default 1)
    pub start_unit_id: u8,
    /// Last unit ID to scan (default 247)
    pub end_unit_id: u8,
    /// Register to probe for existence (default 0)
    pub test_register: u16,
    /// Register type to probe (default Holding)
    pub register_type: RegisterType,
    /// Delay between scan requests in milliseconds
    pub inter_request_delay_ms: u64,
    #[serde(default = "default_timeout_ms")]
    #[cfg_attr(test, ts(as = "Option<u64>", optional))]
    pub timeout_ms: u64,
    #[serde(default = "default_settle_ms")]
    #[cfg_attr(test, ts(as = "Option<u64>", optional))]
    pub connect_settle_ms: u64,
}

/// Configuration for the function-code probe.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FcProbeConfig {
    /// Server hostname or IP
    #[serde(default = "default_host")]
    #[cfg_attr(test, ts(as = "Option<String>", optional))]
    pub host: String,
    #[serde(default = "default_port")]
    #[cfg_attr(test, ts(as = "Option<u16>", optional))]
    pub port: u16,
    /// Slave addresses to try. Defaults to the common suspects.
    #[serde(default = "default_probe_units")]
    #[cfg_attr(test, ts(as = "Option<Vec<u8>>", optional))]
    pub unit_ids: Vec<u8>,
    /// Address read on each function code. 0 is almost always safe.
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<u16>", optional))]
    pub test_register: u16,
    #[serde(default = "default_timeout_ms")]
    #[cfg_attr(test, ts(as = "Option<u64>", optional))]
    pub timeout_ms: u64,
    #[serde(default = "default_settle_ms")]
    #[cfg_attr(test, ts(as = "Option<u64>", optional))]
    pub connect_settle_ms: u64,
}

fn default_probe_units() -> Vec<u8> {
    vec![1, 0, 255, 2, 3]
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

fn default_port() -> u16 {
    502
}

fn default_unit_id() -> u8 {
    1
}

// ============================================================================
// Event Payloads
// ============================================================================

/// Progress update emitted during scanning
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ScanProgressPayload {
    /// Current position in the scan range
    pub current: u32,
    /// Total items to scan
    pub total: u32,
    /// Number of responding items found so far
    pub found_count: u32,
    /// Which pass this is, when `repeat > 1` (1-based)
    pub pass: u32,
    /// Total passes
    pub total_passes: u32,
}

/// A contiguous run of addresses that answered, or didn't.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RegisterBlock {
    pub start: u16,
    pub end: u16,
    pub count: u32,
}

/// Completion summary returned when scan finishes
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ScanCompletePayload {
    /// Total responding items found
    pub found_count: u32,
    /// Total items scanned
    pub total_scanned: u32,
    /// Scan duration in milliseconds
    pub duration_ms: u64,
    /// Requests actually issued — the honest cost of the sweep.
    #[serde(default)]
    pub requests: u32,
    /// Contiguous runs of responding addresses. A wide sweep of a real device
    /// collapses to a handful of these, which is what makes the result
    /// summarisable instead of one row per register.
    #[serde(default)]
    pub blocks: Vec<RegisterBlock>,
    /// Contiguous runs that did not respond.
    #[serde(default)]
    pub gaps: Vec<RegisterBlock>,
    /// Diagnoses, e.g. "input: no response after 3 consecutive timeouts".
    #[serde(default)]
    pub notes: Vec<String>,
    /// True when the scan stopped early (cancelled or out of request budget).
    #[serde(default)]
    pub truncated: bool,
    /// Unit-ID scans only: what each responding slave said about itself.
    /// Naturally small — at most one entry per unit id.
    #[serde(default)]
    pub devices: Vec<DeviceInfoPayload>,
}

/// What one function code did when asked.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub enum FcVerdict {
    /// Values came back — the device implements this function code.
    Values { values: Vec<u16> },
    /// Bits came back (coils / discrete inputs).
    Bits { values: Vec<bool> },
    /// The device refused, which still proves it implements the function code.
    Exception { message: String },
    /// Nothing came back — most often an unimplemented function code.
    Silent,
}

impl FcVerdict {
    fn supported(&self) -> bool {
        !matches!(self, FcVerdict::Silent)
    }
}

/// One slave's answers across all four read function codes.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FcProbeEntry {
    pub unit_id: u8,
    /// FC03
    pub holding: FcVerdict,
    /// FC04
    pub input: FcVerdict,
    /// FC01
    pub coil: FcVerdict,
    /// FC02
    pub discrete: FcVerdict,
    /// True if any function code produced a reply.
    pub responded: bool,
    /// The register types worth sweeping on this unit.
    pub supported_types: Vec<RegisterType>,
}

/// Publishes progress on the scan session's WebSocket channel. `None` for
/// headless callers, which read the summary from the store instead.
struct ProgressReporter {
    session_id: Option<String>,
    throttle: SignalThrottle,
    device_info: Vec<DeviceInfoPayload>,
    notes: Vec<String>,
    last: Option<ScanProgressPayload>,
}

impl ProgressReporter {
    fn new(session_id: Option<String>) -> Self {
        Self {
            session_id,
            throttle: SignalThrottle::new(),
            device_info: Vec::new(),
            notes: Vec::new(),
            last: None,
        }
    }

    fn note(&mut self, note: String) {
        tlog!("[ModbusScan] {}", note);
        self.notes.push(note);
    }

    fn update(&mut self, progress: ScanProgressPayload) {
        self.last = Some(progress);
        if self.throttle.should_signal("modbus-scan") {
            self.publish("scanning");
        }
    }

    fn publish(&self, status: &str) {
        let Some(sid) = &self.session_id else { return };
        let state = ModbusScanState {
            status: status.to_string(),
            progress: self.last.clone(),
            device_info: self.device_info.clone(),
            notes: self.notes.clone(),
            capture_id: crate::capture_store::get_session_frame_capture_id(sid),
        };
        // Push the state on the session channel, and keep it in the store for
        // MCP, which is in-process Rust and cannot subscribe to the socket.
        crate::ws::dispatch::send_session_json(sid, crate::ws::protocol::MsgType::ModbusScanState, &state);
        store_scan_state(sid, state);
    }

    /// Publish the terminal state and leave it in the store. `ModbusScanSource::stop`
    /// clears it, but the pushed copy has already gone out — which is what stops the
    /// UI racing that clear, as it did when progress was signal-then-fetch.
    fn finish(&mut self, status: &str) {
        self.publish(status);
    }
}

// ============================================================================
// Register Scanner
// ============================================================================

fn register_blocks(blocks: Vec<AddressBlock>) -> Vec<RegisterBlock> {
    blocks
        .into_iter()
        .map(|b| RegisterBlock {
            start: b.start,
            end: b.end,
            count: b.len(),
        })
        .collect()
}

/// The planner counts a gateway's 0x0A/0x0B as silence, so a silence stop can
/// end on either kind.
enum LastFailure {
    Transport(String),
    Exception(ExceptionCode),
}

fn scan_progress(p: SweepProgress) -> ScanProgressPayload {
    ScanProgressPayload {
        current: p.swept,
        total: p.total,
        found_count: p.found,
        pass: p.pass,
        total_passes: p.passes,
    }
}

/// Scan a range of Modbus registers.
///
/// Strategy:
/// 1. Read in `chunk_size` blocks.
/// 2. Success → one frame per register.
/// 3. **Exception** → subdivide and retry each half; a single register that
///    excepts does not exist. The reply told us the address was the problem,
///    so bisecting it is worth the requests.
/// 4. **Silence**, or a gateway's 0x0A/0x0B → mark the whole chunk absent and
///    move on. Do *not* subdivide: a timeout says nothing about which address was at fault, and a device that
///    silently ignores a function code would turn one sweep into thousands of
///    full-timeout requests. Instead, give up on this register type after
///    `max_consecutive_timeouts` and record why.
pub async fn scan_registers(
    config: ModbusScanConfig,
    cancel_flag: Arc<AtomicBool>,
    session_id: Option<String>,
    sink: &FrameSink,
) -> Result<ScanCompletePayload, String> {
    let start_time = std::time::Instant::now();
    let mut reporter = ProgressReporter::new(session_id);
    let mut frame_throttle = SignalThrottle::new();

    let mut sweep = RegisterSweep::new(
        config.register_type.catalog(),
        config.start_register,
        config.end_register,
        config.chunk_size,
        SweepLimits {
            max_registers: config.max_registers,
            max_requests: config.max_requests,
            max_consecutive_silent: config.max_consecutive_timeouts,
            passes: config.repeat,
        },
    )
    .map_err(|e| match e {
        RangeError::Inverted { .. } => "Start register must be <= end register".to_string(),
        RangeError::ZeroBlockSize => "Chunk size must be > 0".to_string(),
        RangeError::TooManyRegisters { total, limit } => format!(
            "Range covers {} registers, over the {} limit — narrow the range or raise max_registers",
            total, limit
        ),
        other => other.to_string(),
    })?;
    let chunk_size = config
        .chunk_size
        .min(config.register_type.catalog().max_per_read());
    let SweepProgress {
        total: total_registers,
        passes,
        ..
    } = sweep.progress();
    let type_name = config.register_type.catalog().as_str();

    tlog!(
        "[ModbusScan] Register scan: {} {}-{} ({} regs, chunk={}, delay={}ms, timeout={}ms, \
         passes={}, budget={} requests)",
        type_name,
        config.start_register,
        config.end_register,
        total_registers,
        chunk_size,
        config.inter_request_delay_ms,
        config.timeout_ms,
        passes,
        config.max_requests
    );

    let addr = resolve(&config.host, config.port).await?;
    let mut conn = sweep_connection(
        addr,
        config.timeout_ms,
        config.connect_settle_ms,
        config.reconnect_per_request,
    );
    conn.connect()
        .await
        .map_err(|e| format!("Failed to connect to Modbus TCP server: {e}"))?;

    tlog!(
        "[ModbusScan] Connected to {} (unit {})",
        addr,
        config.unit_id
    );

    let mut last_failure = None;
    let end = loop {
        match sweep.next_step() {
            SweepStep::Read(span) => {
                if cancel_flag.load(Ordering::Relaxed) {
                    tlog!("[ModbusScan] Cancelled by user");
                    break None;
                }
                let outcome = match conn
                    .read(read_request(&config.register_type, span.start, span.count, config.unit_id))
                    .await
                {
                    Ok(reading) => {
                        let frames = per_register_frames(span.start, config.unit_id, reading.data);
                        let values = frames.len() as u16;
                        sink.frames(frames, &mut frame_throttle).await;
                        ReadOutcome::Answered { values }
                    }
                    Err(RequestError::Exception { code, .. }) => {
                        last_failure = Some(LastFailure::Exception(code));
                        ReadOutcome::Refused { code }
                    }
                    Err(RequestError::Transport(reason)) => {
                        tlog!(
                            "[ModbusScan] {} {}..{} silent: {}",
                            type_name,
                            span.start,
                            span.start + span.count - 1,
                            reason
                        );
                        last_failure = Some(LastFailure::Transport(reason.to_string()));
                        ReadOutcome::Silent
                    }
                };
                sweep.report(outcome);
                reporter.update(scan_progress(sweep.progress()));
                if config.inter_request_delay_ms > 0 {
                    sleep(Duration::from_millis(config.inter_request_delay_ms)).await;
                }
            }
            SweepStep::Pass(pass) => {
                if config.repeat_delay_ms > 0 {
                    sleep(Duration::from_millis(config.repeat_delay_ms)).await;
                }
                if cancel_flag.load(Ordering::Relaxed) {
                    break None;
                }
                tlog!("[ModbusScan] Pass {}/{}", pass, passes);
            }
            SweepStep::Done(end) => break Some(end),
        }
    };

    match end {
        Some(SweepEnd::OutOfRequests { swept, total }) => reporter.note(format!(
            "{}: stopped at the {}-request budget with {} of {} registers swept",
            type_name, config.max_requests, swept, total
        )),
        Some(SweepEnd::Silent { consecutive }) => reporter.note(match &last_failure {
            Some(LastFailure::Exception(code)) => format!(
                "{}: the gateway reported no response from the device {} times in a row \
                 (exception 0x{:02X}, {}) — check the unit id and that the device is powered \
                 and wired",
                type_name,
                consecutive,
                code.code(),
                code
            ),
            transport => format!(
                "{}: no response after {} consecutive timeouts ({}) — the device likely \
                 does not implement this function code",
                type_name,
                consecutive,
                match transport {
                    Some(LastFailure::Transport(reason)) => reason.as_str(),
                    _ => "no reply",
                }
            ),
        }),
        _ => {}
    }
    let truncated = !matches!(end, Some(SweepEnd::Complete));
    let SweepProgress {
        found: found_count,
        requests,
        ..
    } = sweep.progress();
    let blocks = register_blocks(sweep.blocks());
    let gaps = register_blocks(sweep.gaps());

    let duration_ms = start_time.elapsed().as_millis() as u64;

    tlog!(
        "[ModbusScan] Register scan complete: {} of {} {} registers in {} block(s), {} requests, {}ms",
        found_count,
        total_registers * passes,
        type_name,
        blocks.len(),
        requests,
        duration_ms
    );

    sink.flush(&mut frame_throttle);
    reporter.finish(if truncated { "stopped" } else { "complete" });

    Ok(ScanCompletePayload {
        found_count,
        total_scanned: total_registers,
        duration_ms,
        requests,
        blocks,
        gaps,
        notes: reporter.notes.clone(),
        truncated,
        devices: Vec::new(),
    })
}

// ============================================================================
// Unit ID Scanner
// ============================================================================

/// Scan for active Modbus unit IDs using FC43 (Read Device Identification),
/// falling back to a single register read where FC43 isn't supported.
pub async fn scan_unit_ids(
    config: UnitIdScanConfig,
    cancel_flag: Arc<AtomicBool>,
    session_id: Option<String>,
    sink: &FrameSink,
) -> Result<ScanCompletePayload, String> {
    let start_time = std::time::Instant::now();
    let mut reporter = ProgressReporter::new(session_id);
    let mut frame_throttle = SignalThrottle::new();

    if config.start_unit_id > config.end_unit_id {
        return Err("Start unit ID must be <= end unit ID".to_string());
    }

    let total = (config.end_unit_id as u32) - (config.start_unit_id as u32) + 1;
    let type_name = config.register_type.catalog().as_str();

    tlog!(
        "[ModbusScan] Unit ID scan: {}-{}, FC43 + {} reg {} fallback (delay={}ms)",
        config.start_unit_id,
        config.end_unit_id,
        type_name,
        config.test_register,
        config.inter_request_delay_ms
    );

    let addr = resolve(&config.host, config.port).await?;

    let mut found_count: u32 = 0;
    let mut requests: u32 = 0;
    let mut truncated = false;
    // If the gateway doesn't support FC43 at all, stop paying for it per unit.
    let mut fc43_supported = true;
    let mut fc43_tested = false;

    for unit_id in config.start_unit_id..=config.end_unit_id {
        if cancel_flag.load(Ordering::Relaxed) {
            tlog!("[ModbusScan] Unit ID scan cancelled by user");
            truncated = true;
            break;
        }

        let mut unit_found = false;
        let mut conn = sweep_connection(addr, config.timeout_ms, config.connect_settle_ms, false);

        if fc43_supported {
            let ident = conn
                .read_device_identification(Some(unit_id), DeviceIdCode::Basic, 0x00)
                .await;
            requests += 1;

            match ident {
                Ok(identification) => {
                    fc43_tested = true;
                    unit_found = true;

                    let fields = [
                        identification.vendor(),
                        identification.product_code(),
                        identification.revision(),
                    ];
                    let summary = fields
                        .iter()
                        .flatten()
                        .filter(|s| !s.is_empty())
                        .copied()
                        .collect::<Vec<&str>>()
                        .join(" | ");
                    let [vendor, product_code, revision] = fields.map(|f| f.map(str::to_owned));

                    found_count += 1;
                    // frame_id 0x2B = FC43, so the result table can tell an
                    // identification reply from a register probe.
                    sink.frames(
                        vec![modbus_frame(0x2B, unit_id, summary.as_bytes().to_vec())],
                        &mut frame_throttle,
                    )
                    .await;
                    reporter.device_info.push(DeviceInfoPayload {
                        unit_id,
                        vendor,
                        product_code,
                        revision,
                    });

                    tlog!("[ModbusScan] Unit {} identified via FC43: {}", unit_id, summary);
                }
                Err(RequestError::Exception { .. }) => {
                    // Alive, but doesn't serve FC43 — fall through to the probe.
                    fc43_tested = true;
                }
                Err(RequestError::Transport(_)) => {
                    if !fc43_tested {
                        fc43_tested = true;
                        fc43_supported = false;
                        reporter.note(
                            "FC43 (device identification) not supported — falling back to a \
                             register probe for every unit"
                                .to_string(),
                        );
                    }
                }
            }
        }

        if !unit_found {
            if conn.connect().await.is_err() {
                reporter.update(ScanProgressPayload {
                    current: (unit_id - config.start_unit_id + 1) as u32,
                    total,
                    found_count,
                    pass: 1,
                    total_passes: 1,
                });
                if config.inter_request_delay_ms > 0 {
                    sleep(Duration::from_millis(config.inter_request_delay_ms)).await;
                }
                continue;
            }
            let outcome = conn
                .read(read_request(&config.register_type, config.test_register, 1, unit_id))
                .await;
            requests += 1;

            match outcome.map(|reading| reading.data) {
                Ok(ReadData::Registers(data)) => {
                    found_count += 1;
                    sink.frames(
                        vec![modbus_frame(
                            config.test_register as u32,
                            unit_id,
                            registers_to_bytes(&data),
                        )],
                        &mut frame_throttle,
                    )
                    .await;
                    tlog!("[ModbusScan] Unit {} responded ({} reg {})", unit_id, type_name, config.test_register);
                }
                Ok(ReadData::Coils(data)) => {
                    found_count += 1;
                    sink.frames(
                        vec![modbus_frame(
                            config.test_register as u32,
                            unit_id,
                            coils_to_bytes(&data),
                        )],
                        &mut frame_throttle,
                    )
                    .await;
                    tlog!("[ModbusScan] Unit {} responded ({} reg {})", unit_id, type_name, config.test_register);
                }
                Err(RequestError::Exception { .. }) => {
                    // An exception still proves the unit is there — emit an
                    // empty frame so it shows up as present but unreadable.
                    found_count += 1;
                    sink.frames(
                        vec![modbus_frame(config.test_register as u32, unit_id, vec![])],
                        &mut frame_throttle,
                    )
                    .await;
                    tlog!("[ModbusScan] Unit {} alive (exception on reg {})", unit_id, config.test_register);
                }
                Err(RequestError::Transport(_)) => {}
            }
        }

        reporter.update(ScanProgressPayload {
            current: (unit_id - config.start_unit_id + 1) as u32,
            total,
            found_count,
            pass: 1,
            total_passes: 1,
        });

        if config.inter_request_delay_ms > 0 {
            sleep(Duration::from_millis(config.inter_request_delay_ms)).await;
        }
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;
    tlog!(
        "[ModbusScan] Unit ID scan complete: {} of {} in {}ms (FC43={})",
        found_count,
        total,
        duration_ms,
        if fc43_supported { "yes" } else { "no" }
    );

    sink.flush(&mut frame_throttle);
    reporter.finish(if truncated { "stopped" } else { "complete" });

    Ok(ScanCompletePayload {
        found_count,
        total_scanned: total,
        duration_ms,
        requests,
        blocks: Vec::new(),
        gaps: Vec::new(),
        notes: reporter.notes.clone(),
        truncated,
        devices: reporter.device_info.clone(),
    })
}

// ============================================================================
// Function Code Probe
// ============================================================================

fn verdict_for(outcome: Result<Reading, RequestError>) -> FcVerdict {
    match outcome.map(|reading| reading.data) {
        Ok(ReadData::Registers(values)) => FcVerdict::Values { values },
        Ok(ReadData::Coils(values)) => FcVerdict::Bits { values },
        Err(RequestError::Exception { code, .. }) => FcVerdict::Exception {
            message: code.to_string(),
        },
        Err(RequestError::Transport(_)) => FcVerdict::Silent,
    }
}

/// Ask each slave one question per function code: do you answer at all?
///
/// This is the cheapest possible first step against an unknown device — at most
/// four requests per unit — and it decides what a sweep should even look for.
/// The distinction that matters is exception vs silence: a device that returns
/// IllegalDataAddress on FC03 implements holding registers and you're just
/// asking for the wrong one, whereas silence on FC04 means input registers
/// aren't there at all and sweeping them would waste the whole timeout budget.
pub async fn probe_function_codes(
    config: FcProbeConfig,
    cancel_flag: Arc<AtomicBool>,
) -> Result<Vec<FcProbeEntry>, String> {
    if config.unit_ids.is_empty() {
        return Err("No unit IDs to probe".to_string());
    }

    let addr = resolve(&config.host, config.port).await?;
    let mut results = Vec::new();

    for unit_id in config.unit_ids {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }

        // A fresh connection per unit: a device that rejects an unknown slave
        // may drop the socket, and we don't want that to taint the next unit.
        let mut conn = sweep_connection(addr, config.timeout_ms, config.connect_settle_ms, false);
        if let Err(e) = conn.connect().await {
            tlog!("[ModbusScan] Probe unit {}: connect failed: {}", unit_id, e);
            results.push(FcProbeEntry {
                unit_id,
                holding: FcVerdict::Silent,
                input: FcVerdict::Silent,
                coil: FcVerdict::Silent,
                discrete: FcVerdict::Silent,
                responded: false,
                supported_types: Vec::new(),
            });
            continue;
        }
        let mut verdicts = Vec::new();
        for rt in [
            RegisterType::Holding,
            RegisterType::Input,
            RegisterType::Coil,
            RegisterType::Discrete,
        ] {
            let outcome = conn
                .read(read_request(&rt, config.test_register, 1, unit_id))
                .await;
            verdicts.push((rt, verdict_for(outcome)));
        }

        let supported_types: Vec<RegisterType> = verdicts
            .iter()
            .filter(|(_, v)| v.supported())
            .map(|(rt, _)| rt.clone())
            .collect();
        let responded = !supported_types.is_empty();

        let mut it = verdicts.into_iter().map(|(_, v)| v);
        let entry = FcProbeEntry {
            unit_id,
            holding: it.next().unwrap(),
            input: it.next().unwrap(),
            coil: it.next().unwrap(),
            discrete: it.next().unwrap(),
            responded,
            supported_types,
        };

        tlog!(
            "[ModbusScan] Probe unit {}: {}",
            unit_id,
            if entry.responded {
                entry.supported_types.iter().map(|rt| rt.catalog().as_str()).collect::<Vec<_>>().join(", ")
            } else {
                "no response".to_string()
            }
        );
        results.push(entry);
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use wiretap_io::modbus::testing::{self, device, Reply};
    use super::*;
    use tokio::time::timeout;
    use wiretap_io::modbus::{ExceptionCode, TransportError};

    #[test]
    fn a_config_without_an_address_falls_back_to_the_documented_defaults() {
        // The Discovery tools name a session instead of an address, so the address
        // fields are absent from the payload entirely.
        let cfg: ModbusScanConfig = serde_json::from_str(
            r#"{"register_type":"holding","start_register":0,"end_register":9,
                "chunk_size":10,"inter_request_delay_ms":50}"#,
        )
        .expect("a config with no address should still deserialise");
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 502);
        assert_eq!(cfg.unit_id, 1);
    }

    #[test]
    fn an_explicit_address_still_wins_over_the_defaults() {
        // MCP keeps sending an explicit address; defaulting must not touch it.
        let cfg: ModbusScanConfig = serde_json::from_str(
            r#"{"host":"10.0.1.50","port":5020,"unit_id":7,"register_type":"input",
                "start_register":0,"end_register":9,"chunk_size":10,
                "inter_request_delay_ms":50}"#,
        )
        .expect("an explicit address should deserialise unchanged");
        assert_eq!(cfg.host, "10.0.1.50");
        assert_eq!(cfg.port, 5020);
        assert_eq!(cfg.unit_id, 7);
    }

    fn payload() -> ScanCompletePayload {
        ScanCompletePayload {
            found_count: 1,
            total_scanned: 1,
            duration_ms: 0,
            requests: 1,
            blocks: Vec::new(),
            gaps: Vec::new(),
            notes: Vec::new(),
            truncated: false,
            devices: Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_result_already_stored_returns_without_waiting() {
        clear_scan_state("await-ready");
        store_scan_result("await-ready", Ok(payload()));
        let got = await_scan_result("await-ready", Duration::from_millis(50)).await;
        assert!(got.is_some());
        clear_scan_state("await-ready");
    }

    #[tokio::test]
    async fn a_result_stored_while_waiting_wakes_the_waiter() {
        clear_scan_state("await-later");
        let waiter = tokio::spawn(async {
            await_scan_result("await-later", Duration::from_secs(5)).await
        });
        // Give the waiter time to park, so this exercises the wakeup rather
        // than the already-stored fast path.
        tokio::time::sleep(Duration::from_millis(20)).await;
        store_scan_result("await-later", Ok(payload()));
        assert!(waiter.await.unwrap().is_some(), "waiter missed the notification");
        clear_scan_state("await-later");
    }

    #[tokio::test]
    async fn a_scan_result_survives_a_stop_before_its_waiter_reads_it() {
        for (sid, outcome) in [
            ("await-then-stop-ok", Ok(payload())),
            ("await-then-stop-err", Err("Failed to connect".to_string())),
        ] {
            clear_scan_state(sid);
            let waiter = tokio::spawn(await_scan_result(sid, Duration::from_millis(500)));
            tokio::time::sleep(Duration::from_millis(20)).await;
            store_scan_result(sid, outcome.clone());
            clear_scan_state(sid);
            let got = waiter.await.unwrap().expect("the waiter was never given the result");
            assert_eq!(got.map(|p| p.found_count), outcome.map(|p| p.found_count));
        }
    }

    #[tokio::test]
    async fn a_result_that_never_arrives_times_out() {
        clear_scan_state("await-never");
        let got = await_scan_result("await-never", Duration::from_millis(30)).await;
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn another_session_s_result_does_not_satisfy_the_wait() {
        clear_scan_state("await-mine");
        clear_scan_state("await-theirs");
        let waiter = tokio::spawn(async {
            await_scan_result("await-mine", Duration::from_millis(120)).await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        // Wakes every waiter; ours must re-check, find nothing, and park again.
        store_scan_result("await-theirs", Ok(payload()));
        assert!(waiter.await.unwrap().is_none());
        clear_scan_state("await-theirs");
    }

    #[test]
    fn a_silent_read_is_not_evidence_the_device_replied() {
        let silent = RequestError::Transport(TransportError::Timeout {
            after: Duration::from_millis(100),
        });
        assert!(!verdict_for(Err(silent)).supported());
        let refused = RequestError::Exception {
            code: ExceptionCode::IllegalDataAddress,
            latency: Duration::ZERO,
        };
        assert!(verdict_for(Err(refused)).supported());
    }

    fn register_sweep(port: u16, start: u16, end: u16) -> ModbusScanConfig {
        let mut config: ModbusScanConfig = serde_json::from_value(serde_json::json!({
            "port": port, "register_type": "holding", "start_register": start,
            "end_register": end, "chunk_size": 8, "inter_request_delay_ms": 0,
        }))
        .unwrap();
        config.timeout_ms = 100;
        config.max_consecutive_timeouts = 2;
        config
    }

    async fn sweep(config: ModbusScanConfig) -> ScanCompletePayload {
        let cancel = Arc::new(AtomicBool::new(false));
        timeout(
            Duration::from_secs(5),
            scan_registers(config, cancel, None, &FrameSink::Discard),
        )
        .await
        .expect("the sweep hung")
        .unwrap()
    }

    #[tokio::test]
    async fn a_device_that_never_replies_ends_the_sweep_at_the_timeout_budget() {
        let device = device(|_| Reply::Silent).await;
        let result = sweep(register_sweep(device.port, 0, 99)).await;
        assert!(result.truncated);
        assert_eq!(result.requests, 2);
        assert_eq!(result.found_count, 0);
    }

    #[tokio::test]
    async fn an_exception_is_bisected_down_to_the_missing_register() {
        let device = device(|request| match request.start()..request.start() + request.count() {
            range if range.contains(&3) => Reply::Exception(0x02),
            _ => testing::registers(request),
        })
        .await;
        let result = sweep(register_sweep(device.port, 0, 7)).await;
        assert_eq!(
            result.blocks.iter().map(|b| (b.start, b.end)).collect::<Vec<_>>(),
            [(0, 2), (4, 7)]
        );
        assert_eq!(
            result.gaps.iter().map(|b| (b.start, b.end)).collect::<Vec<_>>(),
            [(3, 3)]
        );
    }

    #[tokio::test]
    async fn a_gateway_target_failure_is_silence_not_bisected() {
        let device = device(|request| match request.start()..request.start() + request.count() {
            range if range.contains(&3) => Reply::Exception(0x0B),
            _ => testing::registers(request),
        })
        .await;
        let result = sweep(register_sweep(device.port, 0, 15)).await;
        assert_eq!(result.requests, 2);
        assert!(!result.truncated);
        assert_eq!(
            result.blocks.iter().map(|b| (b.start, b.end)).collect::<Vec<_>>(),
            [(8, 15)]
        );
        assert_eq!(
            result.gaps.iter().map(|b| (b.start, b.end)).collect::<Vec<_>>(),
            [(0, 7)]
        );
    }

    #[tokio::test]
    async fn gateway_target_failures_stop_the_sweep_and_say_so() {
        let device = device(|_| Reply::Exception(0x0B)).await;
        let result = sweep(register_sweep(device.port, 0, 99)).await;
        assert!(result.truncated);
        assert_eq!(result.requests, 2);
        let note = &result.notes[0];
        assert!(
            note.contains("the gateway reported no response from the device 2 times in a row")
                && note.contains("exception 0x0B"),
            "{note}"
        );
        assert!(!note.contains("timeouts"), "{note}");
    }

    /// Unit 1 identifies itself; unit 2 refuses FC43 and answers a register read.
    fn gateway(request: &testing::Request) -> Reply {
        match (request.unit, request.function()) {
            (1, 0x2B) => {
                let mut pdu = vec![0x2B, 0x0E, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 4];
                pdu.extend(b"Acme");
                Reply::Pdu(pdu)
            }
            (_, 0x2B) => Reply::Exception(0x01),
            _ => testing::registers(request),
        }
    }

    #[tokio::test]
    async fn a_unit_scan_asks_each_unit_over_one_connection() {
        let device = device(gateway).await;
        let config: UnitIdScanConfig = serde_json::from_value(serde_json::json!({
            "port": device.port, "start_unit_id": 1, "end_unit_id": 2, "test_register": 0,
            "register_type": "holding", "inter_request_delay_ms": 0, "timeout_ms": 500,
        }))
        .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let result = timeout(
            Duration::from_secs(5),
            scan_unit_ids(config, cancel, None, &FrameSink::Discard),
        )
        .await
        .expect("the unit scan hung")
        .unwrap();

        assert_eq!(result.found_count, 2);
        assert_eq!(result.devices.len(), 1);
        assert_eq!(result.devices[0].vendor.as_deref(), Some("Acme"));
        let asked: Vec<(usize, u8, u8)> = device
            .requests()
            .iter()
            .map(|r| (r.connection, r.unit, r.function()))
            .collect();
        assert_eq!(asked, [(1, 1, 0x2B), (2, 2, 0x2B), (2, 2, 0x03)]);
    }
}
