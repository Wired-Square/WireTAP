// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

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

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenSessionParams {
    /// IO profile id to open a session for (as listed by `list_io_profiles`).
    pub profile_id: String,
    /// Optional explicit session id; generated (prefixed by data type) if omitted.
    #[serde(default)]
    pub session_id: Option<String>,
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

// ── Analysis levers (work against a capture OR a postgres profile) ───────────

fn default_sample_limit() -> u32 {
    5000
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

/// Per-frame-id rollup (count, first/last, dlc) for a capture or postgres source.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct FrameInventoryParams {
    /// Capture ID (mutually exclusive with `profile_id`).
    #[serde(default)]
    pub capture_id: Option<String>,
    /// PostgreSQL profile ID (mutually exclusive with `capture_id`).
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
    /// Restrict to standard (false) or extended (true) frames; omit for both.
    #[serde(default)]
    pub is_extended: Option<bool>,
    /// Max payloads to sample (default 5000).
    #[serde(default = "default_sample_limit")]
    pub sample_limit: u32,
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

// ── Exposed analytical engines (capture OR postgres) ─────────────────────────

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
