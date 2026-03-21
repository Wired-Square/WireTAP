// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashMap;
use std::sync::RwLock;

use once_cell::sync::Lazy;

use crate::io::post_session::StreamEndedInfo;
use crate::io::{FrameMessage, IOState, PlaybackPosition};
use crate::ws::protocol::{self, MsgType};
use crate::ws::server::ws_server;

// ============================================================================
// Frame offset tracking
// ============================================================================

/// Tracks how many frames have been sent over WS per session.
static FRAME_OFFSETS: Lazy<RwLock<HashMap<String, usize>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Read new frames from buffer_store since the last send, encode as binary, and send via WS.
/// Called from signal_frames_ready at the 2Hz throttle cadence.
pub fn send_new_frames(session_id: &str) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };

    let buffer_id = match crate::buffer_store::get_session_frame_buffer_id(session_id) {
        Some(id) => id,
        None => return,
    };

    let offset = FRAME_OFFSETS
        .read()
        .ok()
        .and_then(|m| m.get(session_id).copied())
        .unwrap_or(0);

    // Check how many new frames exist before reading — avoids unbounded allocation
    let total = crate::buffer_store::get_buffer_count(&buffer_id);
    let new_count = total.saturating_sub(offset);
    if new_count == 0 {
        return;
    }

    let (frames, _indices, _total) =
        crate::buffer_store::get_buffer_frames_paginated(&buffer_id, offset, new_count);

    if frames.is_empty() {
        return;
    }

    let new_offset = offset + frames.len();

    let payload = protocol::encode_frame_batch(&frames);
    let msg = protocol::encode_message(MsgType::FrameData, channel, &payload);
    server.send_to_channel(channel, msg);

    // Update offset — use total as a ceiling so we never fall behind a cleared buffer.
    let next = new_offset.max(total);
    if let Ok(mut offsets) = FRAME_OFFSETS.write() {
        offsets.insert(session_id.to_string(), next);
    }
}

/// Reset frame offset for a session to the current buffer length.
/// Called on subscribe so that only frames arriving after subscription are sent.
pub fn reset_frame_offset(session_id: &str) {
    let count = crate::buffer_store::get_session_frame_buffer_id(session_id)
        .map(|id| crate::buffer_store::get_buffer_count(&id))
        .unwrap_or(0);

    if let Ok(mut offsets) = FRAME_OFFSETS.write() {
        offsets.insert(session_id.to_string(), count);
    }
}

/// Clear frame offset for a session.
/// Called on unsubscribe or when the channel is released.
pub fn clear_frame_offset(session_id: &str) {
    if let Ok(mut offsets) = FRAME_OFFSETS.write() {
        offsets.remove(session_id);
    }
}

/// Send a batch of frames to all WebSocket subscribers for this session.
pub fn send_frames(session_id: &str, frames: &[FrameMessage]) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    let payload = protocol::encode_frame_batch(frames);
    let msg = protocol::encode_message(MsgType::FrameData, channel, &payload);
    server.send_to_channel(channel, msg);
}

/// Send session state change.
pub fn send_session_state(session_id: &str, current: &IOState) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    let state_byte = match current {
        IOState::Stopped => 0u8,
        IOState::Starting => 1,
        IOState::Running => 2,
        IOState::Paused => 3,
        IOState::Error(_) => 4,
    };
    let error_msg = match current {
        IOState::Error(msg) => Some(msg.as_str()),
        _ => None,
    };
    let payload = protocol::encode_session_state(state_byte, error_msg);
    let msg = protocol::encode_message(MsgType::SessionState, channel, &payload);
    server.send_to_channel(channel, msg);
}

/// Send stream-ended info.
pub fn send_stream_ended(session_id: &str, info: &StreamEndedInfo) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    let reason = match info.reason.as_str() {
        "complete" => 0u8,
        "disconnected" => 1,
        "error" => 2,
        "stopped" => 3,
        "paused" => 4,
        _ => 0,
    };
    let payload = protocol::encode_stream_ended(
        reason,
        info.buffer_available,
        info.buffer_id.as_deref(),
        info.buffer_type.as_deref(),
        info.count as u32,
        info.time_range,
    );
    let msg = protocol::encode_message(MsgType::StreamEnded, channel, &payload);
    server.send_to_channel(channel, msg);
}

/// Send session error.
pub fn send_session_error(session_id: &str, error: &str) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    let payload = protocol::encode_session_error(error);
    let msg = protocol::encode_message(MsgType::SessionError, channel, &payload);
    server.send_to_channel(channel, msg);
}

/// Send playback position update.
pub fn send_playback_position(session_id: &str, pos: &PlaybackPosition) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    let payload = protocol::encode_playback_position(
        pos.timestamp_us as u64,
        pos.frame_index as u32,
        pos.frame_count.unwrap_or(0) as u32,
    );
    let msg = protocol::encode_message(MsgType::PlaybackPosition, channel, &payload);
    server.send_to_channel(channel, msg);
}

/// Send device-connected info.
pub fn send_device_connected(
    session_id: &str,
    device_type: &str,
    address: &str,
    bus: Option<u8>,
) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    let payload = protocol::encode_device_connected(device_type, address, bus);
    let msg = protocol::encode_message(MsgType::DeviceConnected, channel, &payload);
    server.send_to_channel(channel, msg);
}

/// Send buffer-changed signal.
pub fn send_buffer_changed(session_id: &str) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    // Empty payload — the frontend fetches buffer state via command
    let msg = protocol::encode_message(MsgType::BufferChanged, channel, &[]);
    server.send_to_channel(channel, msg);
}

/// Send session info (speed + listener count).
pub fn send_session_info(session_id: &str, speed: f64, listener_count: u16) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    let payload = protocol::encode_session_info(speed, listener_count);
    let msg = protocol::encode_message(MsgType::SessionInfo, channel, &payload);
    server.send_to_channel(channel, msg);
}

/// Send session-reconfigured signal.
pub fn send_reconfigured(session_id: &str) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    // Empty payload — the frontend clears stale frames on receipt
    let msg = protocol::encode_message(MsgType::Reconfigured, channel, &[]);
    server.send_to_channel(channel, msg);
}

/// Send transmit-updated signal with history count (global, channel 0).
pub fn send_transmit_updated(count: i64) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let msg = protocol::encode_message(MsgType::TransmitUpdated, 0, &count.to_le_bytes());
    server.send_global(msg);
}

// ============================================================================
// Command dispatch (0x20 → 0x21)
// ============================================================================

/// Route a WS command to the appropriate handler.
/// Returns Ok(json_value) on success, Err(error_string) on failure.
pub async fn dispatch_command(
    op_name: &str,
    params: &[u8],
) -> Result<serde_json::Value, String> {
    let params: serde_json::Value = if params.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(params).map_err(|e| format!("Invalid JSON params: {e}"))?
    };

    match op_name {
        name if name.starts_with("framelink.") => {
            crate::io::framelink::rules::dispatch_framelink_command(name, params).await
        }
        _ => Err(format!("Unknown command: {op_name}")),
    }
}

/// Send replay state update (global, channel 0).
pub fn send_replay_state(state: &crate::replay::ReplayState) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    // Encode replay state as JSON bytes for now; a dedicated binary encoder
    // can be added in a future task if needed.
    let payload = match serde_json::to_vec(state) {
        Ok(p) => p,
        Err(_) => return,
    };
    let msg = protocol::encode_message(MsgType::ReplayState, 0, &payload);
    server.send_global(msg);
}

/// Send session lifecycle event (global, channel 0).
pub fn send_session_lifecycle(payload: &crate::io::SessionLifecyclePayload) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let state_byte = payload.state.as_deref().map(|s| match s {
        "stopped" => 0u8,
        "starting" => 1,
        "running" => 2,
        "paused" => 3,
        "error" => 4,
        _ => 0,
    });
    let event_type = match payload.event_type.as_str() {
        "created" => 0u8,
        "destroyed" => 1,
        _ => 0,
    };
    let encoded = protocol::encode_session_lifecycle(
        event_type,
        &payload.session_id,
        payload.device_type.as_deref(),
        state_byte,
        payload.listener_count as u16,
    );
    let msg = protocol::encode_message(MsgType::SessionLifecycle, 0, &encoded);
    server.send_global(msg);
}

/// Send scoped session-lifecycle signal with inline state + capabilities.
/// Used for suspend, resume, switch-to-buffer, and device-replaced transitions.
pub fn send_session_lifecycle_scoped(
    session_id: &str,
    state: &crate::io::IOState,
    capabilities: &crate::io::IOCapabilities,
) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };

    let state_byte: u8 = match state {
        crate::io::IOState::Stopped => 0,
        crate::io::IOState::Starting => 1,
        crate::io::IOState::Running => 2,
        crate::io::IOState::Paused => 3,
        crate::io::IOState::Error(_) => 4,
    };

    let json_bytes = serde_json::to_vec(capabilities).unwrap_or_default();
    let json_len = json_bytes.len() as u16;

    let mut payload = Vec::with_capacity(1 + 2 + json_bytes.len());
    payload.push(state_byte);
    payload.extend_from_slice(&json_len.to_le_bytes());
    payload.extend_from_slice(&json_bytes);

    let msg = protocol::encode_message(MsgType::SessionLifecycle, channel, &payload);
    server.send_to_channel(channel, msg);
}
