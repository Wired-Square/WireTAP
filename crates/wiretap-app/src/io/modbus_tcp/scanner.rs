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
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock,
};
use tokio::time::{sleep, Duration};

use super::conn::{ReadOutcome, ScanConn};
use super::poll::{modbus_frame, per_register_frames, register_type_name, FrameSink, ReadData};
use super::reader::RegisterType;
use wiretap_catalog::modbus::{coils_to_bytes, registers_to_bytes};
use crate::io::SignalThrottle;

/// Device identification info discovered via FC43 (Read Device Identification)
#[derive(Clone, Debug, Serialize, Deserialize)]
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
static SCAN_RESULTS: Lazy<RwLock<HashMap<String, ScanCompletePayload>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

fn store_scan_state(session_id: &str, state: ModbusScanState) {
    if let Ok(mut states) = SCAN_STATES.write() {
        states.insert(session_id.to_string(), state);
    }
}

pub fn get_scan_state(session_id: &str) -> Option<ModbusScanState> {
    SCAN_STATES.read().ok().and_then(|s| s.get(session_id).cloned())
}

/// Wakes anything waiting on a sweep to finish. Broadcast rather than
/// per-session: each waiter re-checks its own id, and the number of concurrent
/// sweeps is tiny.
static SCAN_RESULT_READY: Lazy<tokio::sync::Notify> = Lazy::new(tokio::sync::Notify::new);

pub fn store_scan_result(session_id: &str, payload: ScanCompletePayload) {
    if let Ok(mut results) = SCAN_RESULTS.write() {
        results.insert(session_id.to_string(), payload);
    }
    SCAN_RESULT_READY.notify_waiters();
}

pub fn get_scan_result(session_id: &str) -> Option<ScanCompletePayload> {
    SCAN_RESULTS.read().ok().and_then(|s| s.get(session_id).cloned())
}

/// Wait for a sweep's summary, or `None` if it doesn't arrive within `timeout`.
///
/// For callers that can't subscribe to the session's WebSocket channel — MCP is
/// in-process Rust, so the transport migration doesn't reach it.
pub async fn await_scan_result(
    session_id: &str,
    timeout: Duration,
) -> Option<ScanCompletePayload> {
    // The loop is needed because the notification is a broadcast: a wakeup may
    // belong to another sweep, so this one re-checks its own key and re-parks.
    tokio::time::timeout(timeout, async {
        loop {
            // Register interest *before* reading the store. `Notified` only
            // enrols the waiter when first polled, so without `enable()` a
            // result stored between the read and the await is a lost wakeup —
            // which would hang until the timeout, strictly worse than the poll
            // this replaces.
            let notified = SCAN_RESULT_READY.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            if let Some(payload) = get_scan_result(session_id) {
                return payload;
            }
            notified.await;
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
    // Wake anyone waiting: a sweep that errored or was destroyed without storing
    // a result would otherwise hold its waiter until the timeout.
    SCAN_RESULT_READY.notify_waiters();
}

// ============================================================================
// Configuration
// ============================================================================

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
pub struct ModbusScanConfig {
    /// Server hostname or IP. Defaulted rather than required because a caller may
    /// name a session instead and let the command resolve the device; the command
    /// errors when that resolution fails, so the default is a backstop, never a
    /// silent fallback to localhost.
    #[serde(default = "default_host")]
    pub host: String,
    /// Server port (default 502)
    #[serde(default = "default_port")]
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
    pub timeout_ms: u64,
    /// Pause after connecting before the first request on that socket.
    #[serde(default = "default_settle_ms")]
    pub connect_settle_ms: u64,
    /// Open a fresh connection per request, for stacks that serve one
    /// conversation per socket.
    #[serde(default)]
    pub reconnect_per_request: bool,
    /// Give up on this register type after this many silent requests in a row.
    #[serde(default = "default_max_consecutive_timeouts")]
    pub max_consecutive_timeouts: u32,
    /// Refuse a sweep wider than this.
    #[serde(default = "default_max_registers")]
    pub max_registers: u32,
    /// Hard ceiling on requests issued. This, not `max_registers`, is what
    /// actually bounds how long a scan can take.
    #[serde(default = "default_max_requests")]
    pub max_requests: u32,
    /// Number of passes. Two or more samples the same registers repeatedly, so
    /// the Changes tool can separate live telemetry from static configuration.
    #[serde(default = "default_repeat")]
    pub repeat: u32,
    /// Gap between passes when `repeat > 1`.
    #[serde(default = "default_repeat_delay_ms")]
    pub repeat_delay_ms: u64,
}

/// Configuration for unit ID scanning
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnitIdScanConfig {
    /// Server hostname or IP. See `ModbusScanConfig::host`.
    #[serde(default = "default_host")]
    pub host: String,
    /// Server port (default 502)
    #[serde(default = "default_port")]
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
    pub timeout_ms: u64,
    #[serde(default = "default_settle_ms")]
    pub connect_settle_ms: u64,
}

/// Configuration for the function-code probe.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FcProbeConfig {
    /// Server hostname or IP. See `ModbusScanConfig::host`.
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// Slave addresses to try. Defaults to the common suspects.
    #[serde(default = "default_probe_units")]
    pub unit_ids: Vec<u8>,
    /// Address read on each function code. 0 is almost always safe.
    #[serde(default)]
    pub test_register: u16,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_settle_ms")]
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
pub struct RegisterBlock {
    pub start: u16,
    pub end: u16,
    pub count: u32,
}

/// Completion summary returned when scan finishes
#[derive(Clone, Debug, Serialize, Deserialize)]
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
    pub supported_types: Vec<String>,
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

/// Turn a sorted list of addresses into contiguous runs.
fn to_blocks(mut addrs: Vec<u16>) -> Vec<RegisterBlock> {
    addrs.sort_unstable();
    addrs.dedup();
    let mut blocks: Vec<RegisterBlock> = Vec::new();
    for a in addrs {
        match blocks.last_mut() {
            Some(b) if a == b.end + 1 => {
                b.end = a;
                b.count += 1;
            }
            _ => blocks.push(RegisterBlock {
                start: a,
                end: a,
                count: 1,
            }),
        }
    }
    blocks
}

/// The complement of `blocks` within `start..=end`, as contiguous runs.
///
/// Derived from the blocks rather than by walking the address space, so a wide
/// sweep costs one pass over a handful of runs instead of 65k set lookups.
fn gaps_between(blocks: &[RegisterBlock], start: u16, end: u16) -> Vec<RegisterBlock> {
    let mut gaps = Vec::new();
    let mut push = |from: u16, to: u16| {
        if from <= to {
            gaps.push(RegisterBlock {
                start: from,
                end: to,
                count: (to as u32) - (from as u32) + 1,
            });
        }
    };
    let mut cursor = start;
    for b in blocks {
        // `checked_sub`, not `saturating_sub`: a block starting at address 0 has
        // nothing before it, and saturating would report a phantom gap at 0.
        if let Some(before) = b.start.checked_sub(1) {
            push(cursor, before);
        }
        // `end + 1` can overflow at the top of the address space; there is no
        // gap beyond the last block in that case anyway.
        match b.end.checked_add(1) {
            Some(next) => cursor = next,
            None => return gaps,
        }
    }
    push(cursor, end);
    gaps
}

/// Scan a range of Modbus registers.
///
/// Strategy:
/// 1. Read in `chunk_size` blocks.
/// 2. Success → one frame per register.
/// 3. **Exception** → subdivide and retry each half; a single register that
///    excepts does not exist. The reply told us the address was the problem,
///    so bisecting it is worth the requests.
/// 4. **Silence** → mark the whole chunk absent and move on. Do *not* subdivide:
///    a timeout says nothing about which address was at fault, and a device that
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

    if config.start_register > config.end_register {
        return Err("Start register must be <= end register".to_string());
    }
    if config.chunk_size == 0 {
        return Err("Chunk size must be > 0".to_string());
    }
    // Clamp rather than reject: a caller asking for more than one request can
    // carry gets the scan it wanted, in requests the device will answer. Only
    // the frontend clamped before, so an MCP caller could ask for 500 holding
    // registers in one read and get a truncated block or an exception back.
    let chunk_size = config
        .chunk_size
        .min(config.register_type.catalog().max_per_read());

    let total_registers = (config.end_register as u32) - (config.start_register as u32) + 1;
    if total_registers > config.max_registers {
        return Err(format!(
            "Range covers {} registers, over the {} limit — narrow the range or raise max_registers",
            total_registers, config.max_registers
        ));
    }

    let type_name = register_type_name(&config.register_type);
    let passes = config.repeat.max(1);

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

    let mut conn = ScanConn::connect(
        &config.host,
        config.port,
        config.unit_id,
        config.timeout_ms,
        config.connect_settle_ms,
        config.reconnect_per_request,
    )
    .await?;

    tlog!(
        "[ModbusScan] Connected to {} (unit {})",
        conn.addr(),
        config.unit_id
    );

    let mut found_addrs: Vec<u16> = Vec::with_capacity(total_registers as usize);
    let mut found_count: u32 = 0;
    let mut requests: u32 = 0;
    let mut truncated = false;

    'passes: for pass in 1..=passes {
        if pass > 1 {
            if config.repeat_delay_ms > 0 {
                sleep(Duration::from_millis(config.repeat_delay_ms)).await;
            }
            if cancel_flag.load(Ordering::Relaxed) {
                truncated = true;
                break;
            }
            tlog!("[ModbusScan] Pass {}/{}", pass, passes);
        }

        let mut scanned_count: u32 = 0;
        let mut consecutive_timeouts: u32 = 0;

        // Chunk the range, then treat it as a stack so a subdivided chunk's halves
        // are processed before moving on — hence the reverse, which is the only
        // thing separating this from the identical walk in `ranges.rs`.
        let mut work_queue: Vec<(u16, u16)> = Vec::new();
        let mut pos = config.start_register;
        loop {
            let count = (config.end_register - pos + 1).min(chunk_size);
            work_queue.push((pos, count));
            match pos.checked_add(count) {
                Some(next) if next <= config.end_register => pos = next,
                _ => break,
            }
        }
        work_queue.reverse();

        while let Some((start, count)) = work_queue.pop() {
            if cancel_flag.load(Ordering::Relaxed) {
                tlog!("[ModbusScan] Cancelled by user");
                truncated = true;
                break 'passes;
            }
            if requests >= config.max_requests {
                reporter.note(format!(
                    "{}: stopped at the {}-request budget with {} of {} registers swept",
                    type_name, config.max_requests, scanned_count, total_registers
                ));
                truncated = true;
                break 'passes;
            }

            let outcome = conn
                .read(&config.register_type, start, count)
                .await;
            requests += 1;

            if outcome.device_replied() {
                consecutive_timeouts = 0;
            }

            match outcome {
                ReadOutcome::Registers(_) | ReadOutcome::Coils(_) => {
                    let data = match outcome {
                        ReadOutcome::Registers(d) => ReadData::Registers(d),
                        ReadOutcome::Coils(d) => ReadData::Coils(d),
                        _ => unreachable!("matched a success arm"),
                    };
                    let frames = per_register_frames(start, config.unit_id, data);
                    if pass == 1 {
                        found_addrs.extend(frames.iter().map(|f| f.frame_id as u16));
                    }
                    found_count += frames.len() as u32;
                    sink.frames(frames, &mut frame_throttle).await;
                }
                ReadOutcome::Exception(_) => {
                    // The device answered, so the address is the problem —
                    // bisect to find exactly which ones are illegal.
                    if count > 1 {
                        let half = count / 2;
                        work_queue.push((start + half, count - half));
                        work_queue.push((start, half));
                        continue;
                    }
                    // A single register that excepts simply doesn't exist.
                }
                ReadOutcome::Silent(reason) => {
                    consecutive_timeouts += 1;
                    tlog!(
                        "[ModbusScan] {} {}..{} silent: {} ({}/{})",
                        type_name,
                        start,
                        start + count - 1,
                        reason,
                        consecutive_timeouts,
                        config.max_consecutive_timeouts
                    );
                    if config.max_consecutive_timeouts > 0
                        && consecutive_timeouts >= config.max_consecutive_timeouts
                    {
                        reporter.note(format!(
                            "{}: no response after {} consecutive timeouts ({}) — the device likely \
                             does not implement this function code",
                            type_name, consecutive_timeouts, reason
                        ));
                        truncated = true;
                        break 'passes;
                    }
                }
            }

            scanned_count += count as u32;
            reporter.update(ScanProgressPayload {
                current: scanned_count,
                total: total_registers,
                found_count,
                pass,
                total_passes: passes,
            });

            if config.inter_request_delay_ms > 0 {
                sleep(Duration::from_millis(config.inter_request_delay_ms)).await;
            }
        }
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;
    let blocks = to_blocks(found_addrs);
    let gaps = gaps_between(&blocks, config.start_register, config.end_register);

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
    use tokio_modbus::prelude::*;

    let start_time = std::time::Instant::now();
    let mut reporter = ProgressReporter::new(session_id);
    let mut frame_throttle = SignalThrottle::new();

    if config.start_unit_id > config.end_unit_id {
        return Err("Start unit ID must be <= end unit ID".to_string());
    }

    let total = (config.end_unit_id as u32) - (config.start_unit_id as u32) + 1;
    let type_name = register_type_name(&config.register_type);

    tlog!(
        "[ModbusScan] Unit ID scan: {}-{}, FC43 + {} reg {} fallback (delay={}ms)",
        config.start_unit_id,
        config.end_unit_id,
        type_name,
        config.test_register,
        config.inter_request_delay_ms
    );

    let addr = crate::io::net::resolve_host_port(&config.host, config.port)
        .await
        .map_err(|e| e.user_message())?;

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

        if fc43_supported {
            // FC43 has no wrapper on ScanConn — it's the one request the sweep
            // makes that isn't a register read.
            let ident = tokio::time::timeout(
                Duration::from_millis(config.timeout_ms),
                async {
                    tcp::connect_slave(addr, Slave(unit_id))
                        .await
                        .map_err(|e| e.to_string())?
                        .read_device_identification(ReadCode::Basic, 0x00)
                        .await
                        .map_err(|e| e.to_string())
                },
            )
            .await;
            requests += 1;

            match ident {
                Ok(Ok(Ok(response))) => {
                    fc43_tested = true;
                    unit_found = true;

                    let mut vendor = None;
                    let mut product_code = None;
                    let mut revision = None;
                    for obj in &response.device_id_objects {
                        let text = obj.value_as_str().map(String::from);
                        match obj.id {
                            0x00 => vendor = text,
                            0x01 => product_code = text,
                            0x02 => revision = text,
                            _ => {}
                        }
                    }

                    let summary = [
                        vendor.as_deref().unwrap_or(""),
                        product_code.as_deref().unwrap_or(""),
                        revision.as_deref().unwrap_or(""),
                    ]
                    .iter()
                    .filter(|s| !s.is_empty())
                    .copied()
                    .collect::<Vec<&str>>()
                    .join(" | ");

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
                Ok(Ok(Err(_exc))) => {
                    // Alive, but doesn't serve FC43 — fall through to the probe.
                    fc43_tested = true;
                }
                _ => {
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
            let Ok(mut conn) = ScanConn::connect(
                &config.host,
                config.port,
                unit_id,
                config.timeout_ms,
                config.connect_settle_ms,
                false,
            )
            .await
            else {
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
            };
            let outcome = conn
                .read(&config.register_type, config.test_register, 1)
                .await;
            requests += 1;

            match outcome {
                ReadOutcome::Registers(data) => {
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
                ReadOutcome::Coils(data) => {
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
                ReadOutcome::Exception(_) => {
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
                ReadOutcome::Silent(_) => {}
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

fn verdict_for(outcome: ReadOutcome) -> FcVerdict {
    match outcome {
        ReadOutcome::Registers(values) => FcVerdict::Values { values },
        ReadOutcome::Coils(values) => FcVerdict::Bits { values },
        ReadOutcome::Exception(message) => FcVerdict::Exception { message },
        ReadOutcome::Silent(_) => FcVerdict::Silent,
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

    let mut results = Vec::new();

    for unit_id in config.unit_ids {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }

        // A fresh connection per unit: a device that rejects an unknown slave
        // may drop the socket, and we don't want that to taint the next unit.
        let mut conn = match ScanConn::connect(
            &config.host,
            config.port,
            unit_id,
            config.timeout_ms,
            config.connect_settle_ms,
            false,
        )
        .await
        {
            Ok(c) => c,
            Err(e) => {
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
        };
        let mut verdicts = Vec::new();
        for rt in [
            RegisterType::Holding,
            RegisterType::Input,
            RegisterType::Coil,
            RegisterType::Discrete,
        ] {
            let outcome = conn.read(&rt, config.test_register, 1).await;
            verdicts.push((rt, verdict_for(outcome)));
        }

        let supported_types: Vec<String> = verdicts
            .iter()
            .filter(|(_, v)| v.supported())
            .map(|(rt, _)| register_type_name(rt).to_string())
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
                entry.supported_types.join(", ")
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
    use super::*;

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

    #[test]
    fn contiguous_addresses_collapse_into_one_block() {
        let blocks = to_blocks(vec![0, 1, 2, 3]);
        assert_eq!(blocks.len(), 1);
        assert_eq!((blocks[0].start, blocks[0].end, blocks[0].count), (0, 3, 4));
    }

    #[test]
    fn a_hole_splits_the_run() {
        let blocks = to_blocks(vec![0, 1, 5, 6, 7]);
        assert_eq!(
            blocks.iter().map(|b| (b.start, b.end)).collect::<Vec<_>>(),
            vec![(0, 1), (5, 7)]
        );
    }

    #[test]
    fn a_wide_sparse_sweep_still_summarises_small() {
        // 0..24 and 40..62 present, as the Megatec's telemetry block looked.
        let addrs: Vec<u16> = (0..=24).chain(40..=62).collect();
        assert_eq!(to_blocks(addrs).len(), 2);
    }

    #[test]
    fn gaps_are_the_inverse_of_the_found_set() {
        let gaps = gaps_between(&to_blocks(vec![0, 1, 2, 6, 7]), 0, 7);
        assert_eq!(
            gaps.iter().map(|b| (b.start, b.end)).collect::<Vec<_>>(),
            vec![(3, 5)]
        );
    }

    #[test]
    fn nothing_found_is_one_gap_spanning_the_range() {
        let gaps = gaps_between(&[], 10, 19);
        assert_eq!(gaps.len(), 1);
        assert_eq!((gaps[0].start, gaps[0].end, gaps[0].count), (10, 19, 10));
    }

    #[test]
    fn gaps_at_both_ends_are_reported() {
        let gaps = gaps_between(&to_blocks(vec![4, 5]), 0, 9);
        assert_eq!(
            gaps.iter().map(|b| (b.start, b.end)).collect::<Vec<_>>(),
            vec![(0, 3), (6, 9)]
        );
    }

    #[test]
    fn a_fully_covered_range_has_no_gaps() {
        assert!(gaps_between(&to_blocks(vec![0, 1, 2]), 0, 2).is_empty());
    }

    #[test]
    fn a_block_ending_at_the_top_of_the_address_space_terminates() {
        let gaps = gaps_between(&to_blocks(vec![65534, 65535]), 65530, 65535);
        assert_eq!(
            gaps.iter().map(|b| (b.start, b.end)).collect::<Vec<_>>(),
            vec![(65530, 65533)]
        );
    }

    #[test]
    fn duplicate_addresses_from_repeat_passes_do_not_inflate_blocks() {
        let blocks = to_blocks(vec![5, 5, 6, 6, 7]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].count, 3);
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
        store_scan_result("await-ready", payload());
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
        store_scan_result("await-later", payload());
        assert!(waiter.await.unwrap().is_some(), "waiter missed the notification");
        clear_scan_state("await-later");
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
        store_scan_result("await-theirs", payload());
        assert!(waiter.await.unwrap().is_none());
        clear_scan_state("await-theirs");
    }

    #[test]
    fn a_silent_read_is_not_evidence_the_device_replied() {
        assert!(!ReadOutcome::Silent("timeout".into()).device_replied());
        assert!(ReadOutcome::Exception("illegal".into()).device_replied());
        assert!(ReadOutcome::Registers(vec![1]).device_replied());
    }
}
