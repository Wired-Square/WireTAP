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
