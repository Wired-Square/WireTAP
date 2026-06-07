// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

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

/// Catalogues attached to sessions for live decode. When a session has one,
/// [`send_new_frames`] also decodes the batch (once, in Rust) and pushes a
/// `DecodedSignals` message — raw `FrameData` still flows for the apps that
/// need bytes. `Arc` so we decode outside the lock. Keyed by session id.
static ATTACHED_CATALOGS: Lazy<RwLock<HashMap<String, Arc<wiretap_catalog::Catalog>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Attach a parsed catalogue to a session, enabling the decoded stream.
pub fn attach_catalog(session_id: &str, catalog: wiretap_catalog::Catalog) {
    if let Ok(mut m) = ATTACHED_CATALOGS.write() {
        m.insert(session_id.to_string(), Arc::new(catalog));
    }
}

/// Detach a session's catalogue (decoded stream stops). Called explicitly and
/// on final unsubscribe.
pub fn detach_catalog(session_id: &str) {
    if let Ok(mut m) = ATTACHED_CATALOGS.write() {
        m.remove(session_id);
    }
}

fn attached_catalog(session_id: &str) -> Option<Arc<wiretap_catalog::Catalog>> {
    ATTACHED_CATALOGS
        .read()
        .ok()
        .and_then(|m| m.get(session_id).cloned())
}

/// Decode a frame batch against `catalog` into the `DecodedSignals` JSON
/// payload (one entry per frame that has a matching catalogue frame). Returns
/// an empty vec when nothing decoded, so the caller can skip the send.
fn encode_decoded_batch(frames: &[FrameMessage], catalog: &wiretap_catalog::Catalog) -> Vec<u8> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for f in frames {
        let Some(frame) = catalog.frame(f.frame_id) else {
            continue;
        };
        let decoded = wiretap_catalog::decode::decode_frame(catalog, frame, &f.bytes);
        if decoded.signals.is_empty() && decoded.selectors.is_empty() {
            continue;
        }
        let signals: Vec<_> = decoded
            .signals
            .iter()
            .map(|s| {
                serde_json::json!({
                    "name": s.name,
                    "value": s.value,
                    "scaled": s.scaled,
                    "display": s.display,
                    "unit": s.unit,
                })
            })
            .collect();
        let selectors: Vec<_> = decoded
            .selectors
            .iter()
            .map(|s| {
                serde_json::json!({
                    "name": s.name,
                    "value": s.value,
                    "matchedCase": s.matched_case,
                    "startBit": s.start_bit,
                    "bitLength": s.bit_length,
                })
            })
            .collect();
        out.push(serde_json::json!({
            "frameId": f.frame_id,
            "bus": f.bus,
            "t": f.timestamp_us,
            "signals": signals,
            "selectors": selectors,
        }));
    }
    if out.is_empty() {
        return Vec::new();
    }
    serde_json::to_vec(&out).unwrap_or_default()
}

/// Read new frames from capture_store since the last send, encode as binary, and send via WS.
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

    let capture_id = match crate::capture_store::get_session_frame_capture_id(session_id) {
        Some(id) => id,
        None => return,
    };

    let offset = FRAME_OFFSETS
        .read()
        .ok()
        .and_then(|m| m.get(session_id).copied())
        .unwrap_or(0);

    // Check how many new frames exist before reading — avoids unbounded allocation
    let total = crate::capture_store::get_capture_count(&capture_id);
    let new_count = total.saturating_sub(offset);
    if new_count == 0 {
        return;
    }

    let (frames, _indices, _total) =
        crate::capture_store::get_capture_frames_paginated(&capture_id, offset, new_count);

    if frames.is_empty() {
        return;
    }

    let new_offset = offset + frames.len();

    let payload = protocol::encode_frame_batch(&frames);
    let msg = protocol::encode_message(MsgType::FrameData, channel, &payload);
    server.send_to_channel(channel, msg);

    // If a catalogue is attached, decode the same batch once (in Rust) and push
    // it as a parallel DecodedSignals message — the frontend stops re-decoding.
    if let Some(catalog) = attached_catalog(session_id) {
        let decoded = encode_decoded_batch(&frames, &catalog);
        if !decoded.is_empty() {
            let dmsg = protocol::encode_message(MsgType::DecodedSignals, channel, &decoded);
            server.send_to_channel(channel, dmsg);
        }
    }

    // Update offset — use total as a ceiling so we never fall behind a cleared capture.
    let next = new_offset.max(total);
    if let Ok(mut offsets) = FRAME_OFFSETS.write() {
        offsets.insert(session_id.to_string(), next);
    }
}

/// Reset frame offset for a session to the current capture length.
/// Called on subscribe so that only frames arriving after subscription are sent.
pub fn reset_frame_offset(session_id: &str) {
    let count = crate::capture_store::get_session_frame_capture_id(session_id)
        .map(|id| crate::capture_store::get_capture_count(&id))
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
        info.capture_available,
        info.capture_id.as_deref(),
        info.capture_kind.as_deref(),
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

/// Send capture-changed signal.
pub fn send_capture_changed(session_id: &str) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    // Empty payload — the frontend fetches capture state via command
    let msg = protocol::encode_message(MsgType::CaptureChanged, channel, &[]);
    server.send_to_channel(channel, msg);
}

/// Send session info (speed + subscriber count).
pub fn send_session_info(session_id: &str, speed: f64, subscriber_count: u16) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };
    let payload = protocol::encode_session_info(speed, subscriber_count);
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
        name if name.starts_with("smp.") => {
            crate::ws::smp::dispatch(name, params).await
        }
        name if name.starts_with("catalog.") => {
            crate::catalog::dispatch_catalog_command(name, params).await
        }
        _ => Err(format!("Unknown command: {op_name}")),
    }
}

/// Push an OTA event payload to all connected WS clients on the global
/// channel. Payload is opaque JSON — the frontend decodes the
/// discriminated union by `type` field.
pub fn send_ota_event(event: &serde_json::Value) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let payload = match serde_json::to_vec(event) {
        Ok(p) => p,
        Err(_) => return,
    };
    let msg = protocol::encode_message(MsgType::OtaEvent, 0, &payload);
    server.send_global(msg);
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

/// Send Test Pattern state update (global, channel 0).
pub fn send_io_test_state(test_id: &str) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let state = match crate::io_test::get_io_test_state(test_id.to_string()) {
        Some(s) => s,
        None => return,
    };
    let payload = match serde_json::to_vec(&state) {
        Ok(p) => p,
        Err(_) => return,
    };
    let msg = protocol::encode_message(MsgType::TestPatternState, 0, &payload);
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
        payload.source_type.as_deref(),
        state_byte,
        payload.subscriber_count as u16,
    );
    let msg = protocol::encode_message(MsgType::SessionLifecycle, 0, &encoded);
    server.send_global(msg);
}

/// Send scoped session-lifecycle signal with inline state + capabilities.
/// Used for suspend, resume, switch-to-capture, and device-replaced transitions.
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
