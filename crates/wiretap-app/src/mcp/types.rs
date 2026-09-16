// Copyright 2026 Wired Square Pty Ltd

//! Parameter structs for the MCP tools. Each derives `Deserialize` (rmcp parses
//! the tool-call arguments into it) and `JsonSchema` (rmcp publishes the schema
//! in `tools/list`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

fn default_count() -> usize {
    100
}
fn default_lines() -> usize {
    200
}
fn default_speed() -> f64 {
    1.0
}
fn default_register_type() -> String {
    "holding".to_string()
}
fn default_one() -> u16 {
    1
}

// ── Tier 1 (Rust-native) ────────────────────────────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SessionIdParams {
    /// Session ID (as returned by `list_sessions`).
    pub session_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AttachSourceParams {
    /// Session ID (as returned by `list_sessions`).
    pub session_id: String,
    /// Which source-aware tab to attach the session to, e.g. `discovery`,
    /// `decoder`, `transmit`, `query`, or `dashboard` (the tabs declaring
    /// `sessionAware` in the app registry).
    pub panel: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CaptureIdParams {
    /// Capture ID (as returned by `list_captures`).
    pub capture_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetFramesParams {
    /// Capture ID (as returned by `list_captures`).
    pub capture_id: String,
    /// Zero-based index of the first frame to return.
    #[serde(default)]
    pub offset: usize,
    /// Maximum number of frames to return (default 100).
    #[serde(default = "default_count")]
    pub count: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct QueryFramesParams {
    /// Capture ID (as returned by `list_captures`).
    pub capture_id: String,
    /// Only return frames with this CAN/Modbus frame id (decimal).
    #[serde(default)]
    pub frame_id: Option<u32>,
    /// Restrict `frame_id` to one protocol ("can", "modbus", "serial"). Frame identity is
    /// (protocol, frame_id), so CAN 0x100 and Modbus register 256 share a numeric id.
    /// Omit to match that id under every protocol in the capture.
    #[serde(default)]
    pub protocol: Option<String>,
    /// Zero-based offset into the (filtered) result set.
    #[serde(default)]
    pub offset: usize,
    /// Maximum number of frames to return (default 100).
    #[serde(default = "default_count")]
    pub count: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TailLogParams {
    /// Number of trailing log lines to return (default 200).
    #[serde(default = "default_lines")]
    pub lines: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadCatalogParams {
    /// Catalog filename (e.g. `sungrow_shx.toml`) or display name, as listed by `list_catalogs`.
    pub name: String,
}

// ── Tier 2 (frontend bridge) ─────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DiscoveryAnalysisParams {
    /// Optional: restrict to a single session.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Optional: restrict to specific frame keys (e.g. `"can:256"`).
    #[serde(default)]
    pub frame_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct DecodedSignalsParams {
    /// Optional: restrict to a single session.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Optional: restrict to a single frame key (e.g. `"can:256"`).
    #[serde(default)]
    pub frame_id: Option<String>,
}

// ── Control (gated behind `mcp_allow_control`) ───────────────────────────────

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TransmitFrameParams {
    /// Session ID to transmit through (must be a transmit-capable session).
    pub session_id: String,
    /// CAN frame id (decimal).
    pub frame_id: u32,
    /// Payload bytes (0-8 for classic CAN, up to 64 for CAN-FD).
    pub data: Vec<u8>,
    /// Extended (29-bit) frame id.
    #[serde(default)]
    pub is_extended: bool,
    /// Bus number (0 for single-bus adapters).
    #[serde(default)]
    pub bus: u8,
    /// CAN-FD frame.
    #[serde(default)]
    pub is_fd: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RepeatTransmitStartParams {
    /// Session ID to transmit through (must be a transmit-capable session).
    pub session_id: String,
    /// CAN frame id (decimal).
    pub frame_id: u32,
    /// Payload bytes (0-8 for classic CAN, up to 64 for CAN-FD).
    pub data: Vec<u8>,
    /// Extended (29-bit) frame id.
    #[serde(default)]
    pub is_extended: bool,
    /// Bus number. A frame sent to a serial bus is framed onto that interface,
    /// matching the one-shot `transmit_frame` behaviour.
    #[serde(default)]
    pub bus: u8,
    /// CAN-FD frame.
    #[serde(default)]
    pub is_fd: bool,
    /// Repeat interval in milliseconds (>= 1). 250 ≈ 4 Hz.
    pub interval_ms: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RepeatTransmitStopParams {
    /// The `queue_id` returned by `repeat_transmit_start`.
    pub queue_id: String,
}

/// Bytes to put into a byte capture, as a serial port would have produced them.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct IngestBytesParams {
    /// The bytes, as hex. Whitespace, commas and `0x` prefixes are ignored, so
    /// `01 04 4D E2` and `01044de2` are the same input.
    pub bytes: String,
    /// Name for the capture, shown in the picker. Defaults to "Ingested bytes".
    #[serde(default)]
    pub name: Option<String>,
    /// Interface number to record the bytes against (default 0).
    #[serde(default)]
    pub bus: Option<u8>,
    /// Microseconds between consecutive bytes (default 1). Only affects the
    /// timestamps in the hex dump — framing is byte-order driven, never timing.
    #[serde(default)]
    pub interval_us: Option<u64>,
    /// Append to this existing byte capture instead of creating one, so a line
    /// can be built up across several calls.
    #[serde(default)]
    pub capture_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReplayCaptureParams {
    /// Session ID to replay through (must be transmit-capable).
    pub session_id: String,
    /// Capture ID to replay frames from.
    pub capture_id: String,
    /// Replay speed multiplier (1.0 = realtime; default 1.0).
    #[serde(default = "default_speed")]
    pub speed: f64,
    /// Loop the replay until stopped.
    #[serde(default)]
    pub loop_replay: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReplayIdParams {
    /// Replay ID (returned by `replay_capture`).
    pub replay_id: String,
}

/// One contiguous span of Modbus registers to poll.
///
/// Mirrors `crate::io::ModbusRange`. Kept separate so the IO layer doesn't grow
/// a `schemars` dependency just to be describable over MCP.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ModbusRangeParam {
    /// `holding`, `input`, `coil`, or `discrete`.
    #[serde(default = "default_register_type")]
    pub register_type: String,
    /// Protocol-level start address (0-based).
    pub start: u16,
    /// Last address, inclusive.
    pub end: u16,
    /// Poll interval for this range, overriding the spec-level one.
    #[serde(default)]
    pub interval_ms: Option<u64>,
    /// Slave address for this range, overriding the spec-level one.
    #[serde(default)]
    pub device_address: Option<u8>,
}

/// A catalogue-free poll plan — what to poll on a device you have no decoder for.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ModbusRangeSpecParam {
    /// The spans to poll. At least one is required.
    pub ranges: Vec<ModbusRangeParam>,
    /// Default slave address (default 1).
    #[serde(default)]
    pub device_address: Option<u8>,
    /// Default poll interval in ms (default 1000).
    #[serde(default)]
    pub interval_ms: Option<u64>,
    /// Registers per request; clamped to 125 (holding/input) or 2000 (coils).
    #[serde(default)]
    pub block_size: Option<u16>,
    /// Refuse a plan wider than this many registers (default 4096).
    #[serde(default)]
    pub max_registers: Option<u32>,
}

impl ModbusRangeSpecParam {
    /// Convert to the IO layer's spec, defaulting anything the caller omitted.
    pub fn to_spec(&self) -> Result<crate::io::ModbusRangeSpec, String> {
        let mut spec = crate::io::ModbusRangeSpec {
            ranges: Vec::with_capacity(self.ranges.len()),
            ..Default::default()
        };
        for r in &self.ranges {
            spec.ranges.push(crate::io::ModbusRange {
                register_type: parse_register_type(&r.register_type)?,
                start: r.start,
                end: r.end,
                interval_ms: r.interval_ms,
                device_address: r.device_address,
            });
        }
        if let Some(v) = self.device_address {
            spec.device_address = v;
        }
        if let Some(v) = self.interval_ms {
            spec.interval_ms = v;
        }
        if let Some(v) = self.block_size {
            spec.block_size = v;
        }
        if let Some(v) = self.max_registers {
            spec.max_registers = v;
        }
        Ok(spec)
    }
}

/// Parse a register-type string into the IO layer's enum.
pub fn parse_register_type(s: &str) -> Result<crate::io::RegisterType, String> {
    use crate::io::RegisterType;
    match s.to_ascii_lowercase().as_str() {
        "holding" => Ok(RegisterType::Holding),
        "input" => Ok(RegisterType::Input),
        "coil" => Ok(RegisterType::Coil),
        "discrete" => Ok(RegisterType::Discrete),
        other => Err(format!(
            "Unknown register type '{other}' — use holding, input, coil, or discrete"
        )),
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenSessionParams {
    /// IO profile id to open a session for (as listed by `list_io_profiles`).
    pub profile_id: String,
    /// Optional explicit session id; generated (prefixed by data type) if omitted.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Recorded sources only: RFC3339 lower bound (inclusive). Without one the
    /// source replays from the start of its archive. Overrides the profile's
    /// own `start` without modifying the profile.
    #[serde(default)]
    pub start_time: Option<String>,
    /// Recorded sources only: RFC3339 upper bound (exclusive).
    #[serde(default)]
    pub end_time: Option<String>,
    /// Recorded sources only: replay speed multiplier. `0` (the default) means
    /// as fast as the source allows — pace it to watch a window unfold.
    #[serde(default)]
    pub speed: Option<f64>,
    /// Recorded sources only: stop after this many frames.
    #[serde(default)]
    pub limit: Option<i64>,
    /// Modbus profiles only: poll these register ranges instead of a catalogue's,
    /// so a device with no decoder can still be opened. Takes precedence over the
    /// profile's `preferred_catalog` when both are present, which is how you
    /// re-sweep a device you already have a partial catalogue for.
    #[serde(default)]
    pub register_ranges: Option<ModbusRangeSpecParam>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ModbusReadParams {
    /// Session whose configured Modbus device (host/port/unit) to read from.
    pub session_id: String,
    /// Register type: `holding`, `input`, `coil`, or `discrete` (default holding).
    #[serde(default = "default_register_type")]
    pub register_type: String,
    /// Protocol-level start address (0-based).
    pub address: u16,
    /// Number of registers/coils to read (default 1).
    #[serde(default = "default_one")]
    pub count: u16,
}

/// Where to reach a Modbus device — either a saved profile, or an address.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ModbusTargetParams {
    /// Modbus profile to take host/port/unit from (as listed by `list_io_profiles`).
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Explicit hostname or IP, if not using a profile.
    #[serde(default)]
    pub host: Option<String>,
    /// Explicit port (default 502).
    #[serde(default)]
    pub port: Option<u16>,
    /// Explicit unit/slave id (default 1).
    #[serde(default)]
    pub unit_id: Option<u8>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ModbusScanParams {
    #[serde(flatten)]
    pub target: ModbusTargetParams,
    /// `holding`, `input`, `coil`, or `discrete` (default holding). Run
    /// `modbus_probe_function_codes` first if you don't know which the device serves.
    #[serde(default = "default_register_type")]
    pub register_type: String,
    /// First address to sweep (protocol-level, 0-based).
    pub start: u16,
    /// Last address to sweep, inclusive.
    pub end: u16,
    /// Registers per request (default 125 / 2000 for coils).
    #[serde(default)]
    pub chunk_size: Option<u16>,
    /// Per-request timeout in ms (default 2000).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Pause after connecting before the first request (default 0; try 150 for
    /// cheap single-connection devices).
    #[serde(default)]
    pub connect_settle_ms: Option<u64>,
    /// Delay between requests in ms (default 50).
    #[serde(default)]
    pub inter_request_delay_ms: Option<u64>,
    /// Open a fresh connection per request, for stacks that serve one
    /// conversation per socket (default false).
    #[serde(default)]
    pub reconnect_per_request: Option<bool>,
    /// Abandon this register type after this many silent requests (default 3).
    #[serde(default)]
    pub max_consecutive_timeouts: Option<u32>,
    /// Refuse a sweep wider than this (default 4096).
    #[serde(default)]
    pub max_registers: Option<u32>,
    /// Hard ceiling on requests issued (default 2000). This, not max_registers,
    /// is what bounds how long the sweep can take.
    #[serde(default)]
    pub max_requests: Option<u32>,
    /// Number of passes (default 1). Use 2 to sample each register twice so the
    /// Changes tool can separate live telemetry from static configuration.
    #[serde(default)]
    pub repeat: Option<u32>,
    /// Gap between passes in ms (default 6000).
    #[serde(default)]
    pub repeat_delay_ms: Option<u64>,
    /// Wait for the sweep to finish before returning (default true).
    #[serde(default = "default_true")]
    pub wait: bool,
    /// How long to wait before returning early with status "scanning" (default 60000).
    #[serde(default = "default_max_wait_ms")]
    pub max_wait_ms: u64,
    /// Explicit session id for the scan; generated if omitted.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ModbusUnitScanParams {
    #[serde(flatten)]
    pub target: ModbusTargetParams,
    /// First unit id to probe (default 1).
    #[serde(default = "default_first_unit")]
    pub start_unit_id: u8,
    /// Last unit id to probe (default 247).
    #[serde(default = "default_last_unit")]
    pub end_unit_id: u8,
    /// Address read as the liveness probe when FC43 isn't served (default 0).
    #[serde(default)]
    pub test_register: u16,
    /// Register type for that fallback probe (default holding).
    #[serde(default = "default_register_type")]
    pub register_type: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub inter_request_delay_ms: Option<u64>,
    #[serde(default = "default_true")]
    pub wait: bool,
    #[serde(default = "default_max_wait_ms")]
    pub max_wait_ms: u64,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ModbusProbeParams {
    #[serde(flatten)]
    pub target: ModbusTargetParams,
    /// Slave addresses to try (default [1, 0, 255, 2, 3]).
    #[serde(default)]
    pub unit_ids: Option<Vec<u8>>,
    /// Address read on each function code (default 0).
    #[serde(default)]
    pub test_register: u16,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub connect_settle_ms: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetProfileCatalogParams {
    /// Profile to bind the catalogue to (as listed by `list_io_profiles`).
    pub profile_id: String,
    /// Catalogue filename or display name; must already exist in the decoder
    /// directory. Pass null to unbind.
    #[serde(default)]
    pub catalog: Option<String>,
}

fn default_true() -> bool {
    true
}
fn default_max_wait_ms() -> u64 {
    60_000
}
fn default_first_unit() -> u8 {
    1
}
fn default_last_unit() -> u8 {
    247
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ModbusWriteParams {
    /// Session whose configured Modbus device (host/port/unit) to write to.
    pub session_id: String,
    /// Writable register type: `holding` or `coil` (default holding).
    #[serde(default = "default_register_type")]
    pub register_type: String,
    /// Protocol-level start address (0-based).
    pub address: u16,
    /// Values to write — registers 0-65535; coils use 0/1. One value → single write, many → multi.
    pub values: Vec<u16>,
}

// ── Catalog write/validate ───────────────────────────────────────────────────

/// Validate catalog TOML without writing it (read-only dry run).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ValidateCatalogParams {
    /// Full catalog TOML to validate.
    pub content: String,
}

/// Create a new catalog file (gated by the catalog-write permission).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateCatalogParams {
    /// Target filename within the decoder directory (a `.toml` suffix is added
    /// if missing). Must be a bare name — no path separators.
    pub filename: String,
    /// Full catalog TOML to write.
    pub content: String,
}

/// Overwrite an existing catalog file (gated by the catalog-modify permission).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateCatalogParams {
    /// Existing catalog filename (or display name) to overwrite.
    pub filename: String,
    /// Full catalog TOML to write.
    pub content: String,
}

/// Write a dashboard artifact (gated by the dashboard-write permission).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct DashboardParams {
    /// Target filename in the dashboards dir (a `.dashboard.json` suffix is added
    /// if missing). Must be a bare name — no path separators.
    pub filename: String,
    /// Full dashboard JSON (schema `wiretap.dashboard/1`).
    pub content: String,
}

/// Open (or focus) an app/panel in the running window (gated by the ui-control permission).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenAppParams {
    /// App/panel id, e.g. "dashboard", "discovery", "decoder", "query".
    pub panel_id: String,
    /// Optional args passed to the frontend handler (e.g. `{ "dashboardPath": "…" }`
    /// to load a dashboard before opening the panel).
    #[serde(default)]
    pub args: Option<serde_json::Value>,
}

// ── Analysis levers (work against a capture OR a WireTAP backend) ───────────

fn default_sample_limit() -> u32 {
    crate::checksum_discovery::DEFAULT_SAMPLE_LIMIT
}
fn default_coverage_sample() -> u32 {
    2000
}
fn default_payload_length() -> u8 {
    8
}
fn default_bucket_ms() -> u32 {
    1000
}

/// Per-frame-id rollup (count, first/last, dlc) for a capture or WireTAP backend source.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct FrameInventoryParams {
    /// Capture ID (mutually exclusive with `profile_id`).
    #[serde(default)]
    pub capture_id: Option<String>,
    /// WireTAP backend profile ID (mutually exclusive with `capture_id`).
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Optional RFC3339 lower time bound (inclusive).
    #[serde(default)]
    pub start_time: Option<String>,
    /// Optional RFC3339 upper time bound (exclusive).
    #[serde(default)]
    pub end_time: Option<String>,
}

/// Per-byte static/counter/sensor roles for one frame id.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ByteProfileParams {
    #[serde(default)]
    pub capture_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Frame id (decimal) to profile.
    pub frame_id: u32,
    /// Restrict to one protocol ("can", "modbus", "serial"); omit for any. In a
    /// mixed capture, omitting it profiles every protocol's rows together.
    #[serde(default)]
    pub protocol: Option<String>,
    /// Restrict to standard (false) or extended (true) frames; omit for both.
    #[serde(default)]
    pub is_extended: Option<bool>,
    /// Max payloads to sample (default 5000).
    #[serde(default = "default_sample_limit")]
    pub sample_limit: u32,
}

fn default_min_likeness() -> u8 {
    wiretap_analysis::DEFAULT_MIN_LIKENESS
}

/// Scan a source for checksums, frame id by frame id.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ChecksumScanParams {
    #[serde(default)]
    pub capture_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Restrict the scan to these frame ids (decimal); omit to scan every id.
    #[serde(default)]
    pub frame_ids: Option<Vec<u32>>,
    /// Max payloads to sample per frame id (default 5000).
    #[serde(default = "default_sample_limit")]
    pub sample_limit: u32,
    /// Recover arbitrary CRC polynomials, not only the eleven named algorithms.
    /// Costs a few milliseconds per candidate byte; off by default.
    #[serde(default)]
    pub search_custom_polynomials: bool,
    /// How checksum-shaped a byte must look before the solver is asked about it
    /// (0-100, default 50). Lower it to widen the search.
    #[serde(default = "default_min_likeness")]
    pub min_likeness: u8,
}

/// Diff a decoder catalog against a data source + confidence rollup.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct CatalogCoverageParams {
    #[serde(default)]
    pub capture_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Catalog filename or display name (as listed by `list_catalogs`).
    pub catalog: String,
    /// Attach per-byte static/varying roles for each present frame (default false
    /// — this samples payloads per frame, which is heavy on a large archive).
    #[serde(default)]
    pub include_byte_roles: bool,
    /// Payloads to sample per frame when byte roles are enabled (default 2000).
    #[serde(default = "default_coverage_sample")]
    pub sample_limit: u32,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
}

// ── Exposed analytical engines (capture OR WireTAP backend) ─────────────────────────

/// Base params for a per-frame analytical query (frame_changes, first_last).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct FrameQueryParams {
    #[serde(default)]
    pub capture_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Frame id (decimal).
    pub frame_id: u32,
    #[serde(default)]
    pub is_extended: Option<bool>,
    /// RFC3339 lower bound (inclusive).
    #[serde(default)]
    pub start_time: Option<String>,
    /// RFC3339 upper bound (exclusive).
    #[serde(default)]
    pub end_time: Option<String>,
    /// Max rows to return.
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Per-byte query (byte_changes, distribution).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ByteQueryParams {
    #[serde(default)]
    pub capture_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    pub frame_id: u32,
    /// Byte index (0-based) within the payload.
    pub byte_index: u8,
    #[serde(default)]
    pub is_extended: Option<bool>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Mux statistics query.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct MuxQueryParams {
    #[serde(default)]
    pub capture_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    pub frame_id: u32,
    /// Byte index used as the mux selector.
    pub mux_selector_byte: u8,
    /// Also compute 16-bit word stats (LE & BE) per offset.
    #[serde(default)]
    pub include_16bit: bool,
    /// Payload length to analyse (default 8).
    #[serde(default = "default_payload_length")]
    pub payload_length: u8,
    #[serde(default)]
    pub is_extended: Option<bool>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Gap analysis query.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct GapQueryParams {
    #[serde(default)]
    pub capture_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    pub frame_id: u32,
    /// Report gaps longer than this many milliseconds.
    pub gap_threshold_ms: f64,
    #[serde(default)]
    pub is_extended: Option<bool>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Frequency query.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct FrequencyQueryParams {
    #[serde(default)]
    pub capture_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    pub frame_id: u32,
    /// Time bucket width in milliseconds (default 1000).
    #[serde(default = "default_bucket_ms")]
    pub bucket_size_ms: u32,
    #[serde(default)]
    pub is_extended: Option<bool>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}
