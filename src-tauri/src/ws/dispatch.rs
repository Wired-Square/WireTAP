// Copyright 2026 Wired Square Pty Ltd

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};

use once_cell::sync::Lazy;

use crate::io::post_session::StreamEndedInfo;
use crate::io::{FrameMessage, IOState, PlaybackPosition};
use crate::transmit::{RepeatStartedEvent, RepeatStoppedEvent};
use crate::ws::protocol::{self, MsgType};
use crate::ws::server::ws_server;
use crate::ws::tunnel_signals;

// ============================================================================
// Frame offset tracking
// ============================================================================

/// Tracks how many frames have been sent over WS per session.
static FRAME_OFFSETS: Lazy<RwLock<HashMap<String, usize>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Catalogues attached to sessions for live decode. When a session has one,
/// [`send_new_frames`] also decodes the batch (once, in Rust) and pushes a
/// `DecodedSignals` message — raw `FrameData` still flows for the apps that
/// need bytes. `Arc` so we decode outside the lock. Keyed by session id. The
/// stored path (when known) is the session's authoritative decoder path, which
/// the frontend mirrors one-way via `ActiveSessionInfo.catalog_path`.
static ATTACHED_CATALOGS: Lazy<
    RwLock<HashMap<String, (Option<String>, Arc<wiretap_catalog::Catalog>)>>,
> = Lazy::new(|| RwLock::new(HashMap::new()));

/// Live `mirror_of` comparison state, one tracker per session. Built from the
/// catalogue at attach and dropped at detach, so a verdict — and the inherited
/// byte set behind it — can never outlive the catalogue that produced it.
/// Sessions whose catalogue declares no comparable mirrors get no entry.
///
/// `Arc<Mutex<_>>` for the same reason `ATTACHED_CATALOGS` holds an `Arc`: the
/// per-batch work happens outside the map's lock, so one session's frame batch
/// never blocks another's.
type SharedMirrorTracker = Arc<Mutex<wiretap_catalog::MirrorTracker>>;
static MIRROR_TRACKERS: Lazy<RwLock<HashMap<String, SharedMirrorTracker>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// How a session's serial port is RTU-framed, for the `interpret` path below.
///
/// The framer's device-address filter needs no repeating here — it already
/// rejected what it rejected. The vendor list does: `interpret` refuses an
/// unmodelled function code outright, so without the same declaration a vendor
/// message would be framed on the wire and then dropped before the Modbus tab.
/// One filter is subtractive, the other additive.
static SERIAL_RTU_OPTIONS: Lazy<RwLock<HashMap<String, crate::io::ModbusRtuOptions>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Publish how a serial session is framed. Called when the source resolves its
/// framing, which may be before or after the catalogue is attached.
pub fn set_serial_rtu_options(session_id: &str, mut options: crate::io::ModbusRtuOptions) {
    // Dropped on the way in, so the invariant holds by construction rather than
    // being restored at every read.
    options.device_address = None;
    if let Ok(mut m) = SERIAL_RTU_OPTIONS.write() {
        m.insert(session_id.to_string(), options);
    }
}

/// Reassembly state for the tunnel frames a session's catalogue declares. A
/// tunnel's payloads concatenate into a byte stream, so unlike every other
/// decode this one is order-dependent and cannot be re-run over frames it has
/// already seen — [`reset_tunnels`] exists for exactly the moments where that
/// would happen.
///
/// Held and locked like [`MIRROR_TRACKERS`], for the same reason: the per-batch
/// work happens outside the map's lock.
struct SessionTunnels {
    /// What the catalogue declares, by frame id. Immutable after attach, so it
    /// sits outside the lock — a non-tunnel frame costs one lookup, no mutex.
    declared: HashMap<u32, wiretap_catalog::FrameTunnel>,
    /// Live reassembly, one buffer per **(bus, frame id)**.
    ///
    /// Per bus, not per id: a multi-bus capture carries the same tunnel id on
    /// each bus, and those are separate serial lines. Sharing one buffer
    /// corrupts whichever messages happen to interleave — on a two-bus SBR
    /// capture (1497 frames of 0x1E0 across two buses) it loses 3 of 499
    /// responses, where a buffer per bus recovers all 499 and leaves no
    /// unconsumed bytes.
    active: Mutex<HashMap<(u8, u32), wiretap_catalog::ModbusRtuStream>>,
    /// The same, for a serial port that is already RTU-framed — one stream per
    /// bus. `Some` only when the attached catalogue is a Modbus one, which is
    /// what says these frames are Modbus messages rather than some other
    /// serial framing that happens to parse as one.
    ///
    /// Nothing is reassembled here: the reader framed the port, so each frame
    /// is one whole message and `interpret` reads it as such. The stream is
    /// still per-session state, because pairing a read response with the
    /// register address it answers needs the request that came before it.
    serial: Option<Mutex<HashMap<u8, wiretap_catalog::ModbusRtuStream>>>,
}

type SharedTunnels = Arc<SessionTunnels>;
static TUNNEL_DECODERS: Lazy<RwLock<HashMap<String, SharedTunnels>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Attach a parsed catalogue to a session, enabling the decoded stream. `path` is
/// the source file path when known — the authoritative decoder path for the session.
pub fn attach_catalog(session_id: &str, path: Option<String>, catalog: wiretap_catalog::Catalog) {
    let tracker = wiretap_catalog::MirrorTracker::new(&catalog);
    let declared: HashMap<u32, wiretap_catalog::FrameTunnel> = catalog
        .frames
        .iter()
        .filter_map(|f| Some((f.frame_id, f.tunnel.clone()?)))
        .collect();
    let modbus_catalog = matches!(catalog.protocol, wiretap_catalog::Protocol::Modbus);
    // Catalogue first, then tracker: a batch landing between the two writes
    // should see the old pair, not a new tracker judging against the old
    // catalogue.
    if let Ok(mut m) = ATTACHED_CATALOGS.write() {
        m.insert(session_id.to_string(), (path, Arc::new(catalog)));
    }
    if let Ok(mut m) = MIRROR_TRACKERS.write() {
        // Replace wholesale: re-attaching is how the decoder rebinds a changed
        // catalogue, and the old verdicts describe a catalogue that is gone.
        if tracker.is_empty() {
            m.remove(session_id);
        } else {
            m.insert(session_id.to_string(), Arc::new(Mutex::new(tracker)));
        }
    }
    if let Ok(mut m) = TUNNEL_DECODERS.write() {
        // Replaced wholesale for the same reason as the mirror tracker: a
        // half-reassembled message describes a catalogue that is gone.
        let serial = modbus_catalog.then(|| Mutex::new(HashMap::new()));
        if declared.is_empty() && serial.is_none() {
            m.remove(session_id);
        } else {
            let tunnels = SessionTunnels {
                declared,
                active: Mutex::new(HashMap::new()),
                serial,
            };
            m.insert(session_id.to_string(), Arc::new(tunnels));
        }
    }
}

fn mirror_tracker(session_id: &str) -> Option<SharedMirrorTracker> {
    MIRROR_TRACKERS
        .read()
        .ok()
        .and_then(|m| m.get(session_id).cloned())
}

fn tunnel_decoders(session_id: &str) -> Option<SharedTunnels> {
    TUNNEL_DECODERS
        .read()
        .ok()
        .and_then(|m| m.get(session_id).cloned())
}

/// Drop every tunnel's part-reassembled message. Call wherever the frame stream
/// restarts or rewinds — a tunnel fed the same bytes twice, or fed a jump in the
/// middle of a message, desyncs and takes a message or two to recover.
fn reset_tunnels(session_id: &str) {
    if let Some(tunnels) = tunnel_decoders(session_id) {
        if let Ok(mut active) = tunnels.active.lock() {
            // Dropped, not emptied in place: a bus that no longer appears
            // should not keep a buffer, and the next frame on one that does
            // rebuilds it.
            active.clear();
        }
        // The serial streams hold no part-reassembled bytes, but they do hold
        // the outstanding request a read response is paired against, which is
        // just as stale after a rewind.
        if let Some(Ok(mut streams)) = tunnels.serial.as_ref().map(|s| s.lock()) {
            streams.clear();
        }
    }
}

/// Detach a session's catalogue (decoded stream stops). Called explicitly and
/// on final unsubscribe.
pub fn detach_catalog(session_id: &str) {
    if let Ok(mut m) = ATTACHED_CATALOGS.write() {
        m.remove(session_id);
    }
    if let Ok(mut m) = MIRROR_TRACKERS.write() {
        m.remove(session_id);
    }
    if let Ok(mut m) = TUNNEL_DECODERS.write() {
        m.remove(session_id);
    }
    if let Ok(mut m) = SERIAL_RTU_OPTIONS.write() {
        m.remove(session_id);
    }
}

fn attached_catalog(session_id: &str) -> Option<Arc<wiretap_catalog::Catalog>> {
    ATTACHED_CATALOGS
        .read()
        .ok()
        .and_then(|m| m.get(session_id).map(|(_, cat)| cat.clone()))
}

/// The source file path of the catalogue attached to `session_id`, if known.
/// Authoritative for the frontend (surfaced via `ActiveSessionInfo.catalog_path`).
pub fn attached_catalog_path(session_id: &str) -> Option<String> {
    ATTACHED_CATALOGS
        .read()
        .ok()
        .and_then(|m| m.get(session_id).and_then(|(path, _)| path.clone()))
}

/// Result of running a frame batch through the session's mirror tracker: the
/// batch-final verdict per mirror, keyed by **masked** frame id and pre-encoded
/// so a mirror seen many times in the batch is serialised once.
struct MirrorVerdicts {
    tracker: SharedMirrorTracker,
    by_masked_id: HashMap<u32, serde_json::Value>,
}

impl MirrorVerdicts {
    fn get(&self, raw_frame_id: u32) -> Option<&serde_json::Value> {
        if self.by_masked_id.is_empty() {
            return None;
        }
        let masked = self.tracker.lock().ok()?.mask_id(raw_frame_id);
        self.by_masked_id.get(&masked)
    }
}

/// Run a frame batch through the session's mirror tracker and collect the
/// resulting verdicts.
///
/// Every frame is observed, including the ones [`encode_decoded_batch`] goes on
/// to skip: a mirror can only be judged when its source is seen too, and the
/// source may carry no signals the UI has asked for. Reading the verdicts back
/// costs one entry per mirror, not one per frame.
fn mirror_verdicts(session_id: &str, frames: &[FrameMessage]) -> Option<MirrorVerdicts> {
    let shared = mirror_tracker(session_id)?;
    let by_masked_id = {
        let mut tracker = shared.lock().ok()?;
        for f in frames {
            let seconds = f.timestamp_us as f64 / 1_000_000.0;
            tracker.observe(f.frame_id, &f.bytes, seconds);
        }
        tracker
            .verdicts()
            .filter_map(|(id, v)| Some((id, serde_json::to_value(v).ok()?)))
            .collect()
    };
    Some(MirrorVerdicts {
        tracker: shared,
        by_masked_id,
    })
}

/// Feed one frame's payload to its tunnel, if it has one, and return whatever
/// messages that completed. Non-tunnel frames cost one hash lookup.
///
/// `masked_id` is the catalogue-lookup id, not the raw one: a catalogue keyed
/// by message type (a `frame_id_mask`) declares its tunnel under the masked id,
/// which no raw id on the wire would ever equal.
///
/// A serial frame under a Modbus catalogue takes the other path: the port was
/// framed by the reader, so the frame is a whole message and the boundary is
/// taken as given rather than searched for. So does a `modbus_rtu` frame — an
/// archive row that is one whole message already.
fn feed_tunnels(
    tunnels: Option<&SharedTunnels>,
    session_id: &str,
    frame: &FrameMessage,
    masked_id: u32,
) -> Vec<wiretap_catalog::ModbusRtuMessage> {
    let Some(tunnels) = tunnels else {
        return Vec::new();
    };
    if frame.protocol == "serial" || frame.protocol == "modbus_rtu" {
        let Some(serial) = tunnels.serial.as_ref() else {
            return Vec::new();
        };
        let Ok(mut streams) = serial.lock() else {
            return Vec::new();
        };
        // The device address is left open: whatever filtering the profile asked
        // for was already applied by the framer that produced this frame. The
        // vendor codes are not — see `SERIAL_RTU_OPTIONS`. An archive message
        // was judged by whatever tapped the line, so it interprets under every
        // code and address: refusing one here would only drop it.
        return streams
            .entry(frame.bus)
            .or_insert_with(|| {
                SERIAL_RTU_OPTIONS
                    .read()
                    .ok()
                    .and_then(|m| m.get(session_id).cloned())
                    .unwrap_or_else(|| {
                        if frame.protocol == "modbus_rtu" {
                            crate::io::ModbusRtuOptions {
                                any_function: true,
                                allow_broadcast: true,
                                ..Default::default()
                            }
                        } else {
                            Default::default()
                        }
                    })
                    .stream()
            })
            .interpret(&frame.bytes)
            .into_iter()
            .collect();
    }
    let Some(declared) = tunnels.declared.get(&masked_id) else {
        return Vec::new();
    };
    let Ok(mut active) = tunnels.active.lock() else {
        return Vec::new();
    };
    active
        .entry((frame.bus, masked_id))
        .or_insert_with(|| wiretap_catalog::ModbusRtuStream::new(declared))
        .push(&frame.bytes)
}

/// One decoded signal in the `DecodedSignals` wire shape. The frontend's
/// `DecodedSignalValue` is parsed straight from this, so tunnelled registers and
/// ordinary ones must go through the same function or the two drift.
fn signal_json(s: &wiretap_catalog::decode::Decoded) -> serde_json::Value {
    serde_json::json!({
        "name": s.name,
        "value": s.value,
        "scaled": s.scaled,
        "display": s.display,
        "unit": s.unit,
        "muxValue": s.mux_value,
        "format": s.format,
    })
}

/// How many reassembled tunnel messages one batch will render. Mirrors the
/// frontend's `MAX_TUNNEL_TRANSACTIONS`, which is all it keeps — and a backlog
/// redecode can complete tens of thousands, each ~1 KB of JSON, so without this
/// `redecode_delivered` over a long capture builds a message nobody reads.
const MAX_RENDERED_TUNNEL_MESSAGES: usize = 500;

/// Decode a frame batch against `catalog` into the `DecodedSignals` JSON
/// payload (one entry per frame that has a matching catalogue frame). Returns
/// an empty vec when nothing decoded, so the caller can skip the send.
fn encode_decoded_batch(
    session_id: &str,
    frames: &[FrameMessage],
    catalog: &wiretap_catalog::Catalog,
    verdicts: Option<&MirrorVerdicts>,
    tunnels: Option<&SharedTunnels>,
) -> Vec<u8> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mask = wiretap_catalog::decode::frame_id_mask(catalog);

    // Tunnels first, over the whole batch: a payload is a slice of a byte
    // stream, so every frame must be fed in order whether or not it decodes to
    // anything — a skipped frame is a hole that desyncs everything after it.
    // Only the newest messages are then rendered, and the ring bounds what is
    // held while the rest of the batch is still being fed.
    let mut completed: VecDeque<(usize, wiretap_catalog::ModbusRtuMessage)> = VecDeque::new();
    if tunnels.is_some() {
        for (i, f) in frames.iter().enumerate() {
            let masked_id = mask.map_or(f.frame_id, |m| f.frame_id & m);
            for msg in feed_tunnels(tunnels, session_id, f, masked_id) {
                if completed.len() == MAX_RENDERED_TUNNEL_MESSAGES {
                    completed.pop_front();
                }
                completed.push_back((i, msg));
            }
        }
    }

    for (i, f) in frames.iter().enumerate() {
        let tunnel_messages: Vec<_> = {
            let mut taken = Vec::new();
            while completed.front().is_some_and(|(idx, _)| *idx == i) {
                taken.push(completed.pop_front().expect("front checked").1);
            }
            taken
        };

        // decode_by_id applies frame_id_mask, looks up the frame, decodes
        // signals/mux, and extracts header fields (CAN id / serial bytes).
        // Defaulted, not skipped, when the catalogue has no frame for this id:
        // a serial RTU message has no frame layout of its own — its registers
        // are decoded from the message — so a frame that decoded nothing still
        // has something to render when it carried a message.
        let decoded = wiretap_catalog::decode::decode_by_id(catalog, f.frame_id, &f.bytes)
            .unwrap_or_default();
        if tunnel_messages.is_empty()
            && decoded.signals.is_empty()
            && decoded.selectors.is_empty()
            && decoded.header_fields.is_empty()
        {
            continue;
        }
        let mut signals: Vec<_> = decoded.signals.iter().map(signal_json).collect();
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
        // Messages this frame completed. They belong to the frame that finished
        // them, not the one that started them, so the UI's timestamp is when the
        // exchange was actually readable.
        let mut transactions: Vec<serde_json::Value> = Vec::new();
        for msg in &tunnel_messages {
            let decoded = tunnel_signals::decode_message(msg, catalog);
            signals.extend(decoded.signals.iter().map(signal_json));
            transactions.push(decoded.transaction);
        }
        let header_fields: Vec<_> = decoded
            .header_fields
            .iter()
            .map(|h| {
                serde_json::json!({
                    "name": h.name,
                    "value": h.value,
                    "display": h.display,
                    "format": h.format,
                })
            })
            .collect();
        let mut entry = serde_json::json!({
            "frameId": f.frame_id,
            "bus": f.bus,
            "t": f.timestamp_us,
            "signals": signals,
            "selectors": selectors,
            "headerFields": header_fields,
            "sourceAddress": decoded.source_address,
            // Raw payload this decode came from, so the frontend can show a
            // hex/ASCII byte row per mux group (each mux occurrence has its own
            // payload; a single per-frame rawBytes would be last-writer-wins).
            "bytes": f.bytes,
        });
        // Only mirrors carry this key, so the frontend can treat its absence as
        // "not a mirror" rather than "no verdict yet".
        if let Some(verdict) = verdicts.and_then(|v| v.get(f.frame_id)) {
            entry["mirror"] = verdict.clone();
        }
        if !transactions.is_empty() {
            entry["tunnel"] = serde_json::Value::Array(transactions);
        }
        out.push(entry);
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
        let verdicts = mirror_verdicts(session_id, &frames);
        let tunnels = tunnel_decoders(session_id);
        let decoded = encode_decoded_batch(session_id, &frames, &catalog, verdicts.as_ref(), tunnels.as_ref());
        if !decoded.is_empty() {
            let dmsg = protocol::encode_message(MsgType::DecodedSignals, channel, &decoded);
            server.send_to_channel(channel, dmsg);
        }
    }

    // Push live counts so the frontend renders Frames/Unique straight from the
    // backend (no TS-side counting). total is the capture count; unique is the
    // distinct (bus, frame_id) count maintained as frames are appended.
    let unique = crate::capture_store::get_capture_unique_count(&capture_id);
    let counts = protocol::encode_frame_counts(total as u64, unique as u32);
    server.send_to_channel(channel, protocol::encode_message(MsgType::FrameCounts, channel, &counts));

    // Update offset — use total as a ceiling so we never fall behind a cleared capture.
    let next = new_offset.max(total);
    if let Ok(mut offsets) = FRAME_OFFSETS.write() {
        offsets.insert(session_id.to_string(), next);
    }
}

/// Push the live byte total for a session's byte capture, with the capture's id.
/// Called from signal_bytes_ready at the 2Hz throttle cadence.
///
/// Unlike frames, the bytes themselves are never sent: the frontend reads rows from the
/// capture on demand. That keeps the wire cost independent of baud rate — one small
/// message twice a second, whether the link is 9600 or 921600 — and avoids a second copy
/// of data the capture already holds durably.
pub fn send_new_bytes(session_id: &str) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let channel = match server.channel_for_session(session_id) {
        Some(c) => c,
        None => return,
    };

    let capture_id = match crate::capture_store::get_session_bytes_capture_id(session_id) {
        Some(id) => id,
        None => return,
    };

    let total = crate::capture_store::get_capture_count(&capture_id);
    if total == 0 {
        return;
    }

    let counts = protocol::encode_byte_counts(total as u64, &capture_id);
    server.send_to_channel(channel, protocol::encode_message(MsgType::ByteCounts, channel, &counts));
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

    // Same moment, same meaning — start from here. Without this the tracker
    // keeps its pre-clear samples and latch, so the next batch re-asserts the
    // verdict the user just cleared (and on a replay restart, timestamps jump
    // backwards past the fuzz window and it can never be re-compared away).
    if let Some(tracker) = mirror_tracker(session_id) {
        if let Ok(mut tracker) = tracker.lock() {
            tracker.reset();
        }
    }
    reset_tunnels(session_id);
}

/// Clear frame offset for a session.
/// Called on unsubscribe or when the channel is released.
pub fn clear_frame_offset(session_id: &str) {
    if let Ok(mut offsets) = FRAME_OFFSETS.write() {
        offsets.remove(session_id);
    }
}

/// Decode the frames already delivered to this session's client (everything up to the
/// current send offset) against the attached catalogue and push DecodedSignals — without
/// re-sending the FrameData. `send_new_frames` only decodes frames *past* the offset, so a
/// catalogue attached after frames were delivered (e.g. a capture replay that started
/// streaming before the decoder bound its catalogue) would otherwise leave those frames
/// undecoded. Called right after `attach_catalog`.
pub fn redecode_delivered(session_id: &str) {
    let Some(catalog) = attached_catalog(session_id) else { return };
    let Some(server) = ws_server() else { return };
    let Some(channel) = server.channel_for_session(session_id) else { return };
    let Some(capture_id) = crate::capture_store::get_session_frame_capture_id(session_id) else {
        return;
    };
    let offset = FRAME_OFFSETS
        .read()
        .ok()
        .and_then(|m| m.get(session_id).copied())
        .unwrap_or(0);
    if offset == 0 {
        return; // nothing delivered yet — send_new_frames will decode going forward
    }

    let (frames, _indices, _total) =
        crate::capture_store::get_capture_frames_paginated(&capture_id, 0, offset);
    let verdicts = mirror_verdicts(session_id, &frames);
    // These frames are about to be replayed through the tunnels. Attaching a
    // catalogue builds them fresh, so they are already empty in practice — the
    // reset keeps that true for any future caller.
    reset_tunnels(session_id);
    let tunnels = tunnel_decoders(session_id);
    let decoded = encode_decoded_batch(session_id, &frames, &catalog, verdicts.as_ref(), tunnels.as_ref());
    if !decoded.is_empty() {
        let dmsg = protocol::encode_message(MsgType::DecodedSignals, channel, &decoded);
        server.send_to_channel(channel, dmsg);
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
        name if name.starts_with("registry.") => {
            crate::io::framelink::registry::dispatch_registry_command(name, params).await
        }
        name if name.starts_with("smp.") => {
            crate::ws::smp::dispatch(name, params).await
        }
        name if name.starts_with("catalog.") => {
            crate::catalog::dispatch_catalog_command(name, params).await
        }
        "app.startup_notices" => Ok(serde_json::json!(crate::startup_notices())),
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

/// Push the open-app roster snapshot to all connected WS clients on the global
/// channel. Payload is opaque JSON (`Vec<AppInstanceInfo>`); the frontend replaces
/// its roster state. Mirrors `send_ota_event` / `send_replay_state`.
pub fn send_open_apps_changed(roster: &[crate::io::AppInstanceInfo]) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let payload = match serde_json::to_vec(roster) {
        Ok(p) => p,
        Err(_) => return,
    };
    let msg = protocol::encode_message(MsgType::OpenAppsChanged, 0, &payload);
    server.send_global(msg);
}

/// Signal all connected WS clients that the decoder-catalogue list changed.
/// Payload is the fresh list as JSON; the frontend treats this as a "re-sync"
/// trigger and reconciles via `list_catalogs`. Mirrors `send_open_apps_changed`.
pub fn send_catalog_list_changed(catalogs: &[crate::catalog::CatalogFile]) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let payload = match serde_json::to_vec(catalogs) {
        Ok(p) => p,
        Err(_) => return,
    };
    let msg = protocol::encode_message(MsgType::CatalogListChanged, 0, &payload);
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

/// Repeat-transmit lifecycle payload, pushed on the global channel as
/// kind-discriminated JSON: `started` carries the full queue row, `stopped`
/// carries the queue id and reason. The frontend decodes the union by `kind`,
/// mirroring how `OtaEvent` discriminates its union.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RepeatEventPayload<'a> {
    Started(&'a RepeatStartedEvent),
    Stopped(&'a RepeatStoppedEvent),
}

fn send_repeat_event(payload: &RepeatEventPayload<'_>) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let bytes = match serde_json::to_vec(payload) {
        Ok(p) => p,
        Err(_) => return,
    };
    let msg = protocol::encode_message(MsgType::RepeatEvent, 0, &bytes);
    server.send_global(msg);
}

/// Announce a repeat transmit that started outside the Transmit UI (e.g. an MCP
/// agent) so it appears as a queue row.
pub fn send_repeat_started(event: &RepeatStartedEvent) {
    send_repeat_event(&RepeatEventPayload::Started(event));
}

/// Announce a repeat transmit that stopped (agent stop or permanent error).
pub fn send_repeat_stopped(event: &RepeatStoppedEvent) {
    send_repeat_event(&RepeatEventPayload::Stopped(event));
}

/// Ask the frontend to surface a session in a source-aware tab (open/focus the
/// panel and point it at the session). Payload is JSON `{ "panel": …, "session_id": … }`.
pub fn send_attach_to_panel(panel: &str, session_id: &str) {
    let server = match ws_server() {
        Some(s) => s,
        None => return,
    };
    let payload =
        match serde_json::to_vec(&serde_json::json!({ "panel": panel, "session_id": session_id })) {
            Ok(p) => p,
            Err(_) => return,
        };
    let msg = protocol::encode_message(MsgType::AttachToPanel, 0, &payload);
    server.send_global(msg);
}

/// Send Test Pattern state update (global, channel 0).
///
/// Takes the state rather than an id: the caller is about to store this very
/// value, so reading it back out of the map would copy the whole thing again.
pub fn send_io_test_state(state: &crate::io_test::IOTestState) {
    let Some(server) = ws_server() else { return };
    let Ok(payload) = serde_json::to_vec(state) else { return };
    server.send_global(protocol::encode_message(MsgType::TestPatternState, 0, &payload));
}

/// Send a JSON-payload message on a session's own channel.
///
/// Silently drops when the server is down or nobody is subscribed, like every
/// other session sender here. The payload is only serialised once a subscriber
/// is known to exist, so a headless session never pays for it.
pub fn send_session_json<T: serde::Serialize>(
    session_id: &str,
    msg_type: MsgType,
    value: &T,
) {
    let Some(server) = ws_server() else { return };
    let Some(channel) = server.channel_for_session(session_id) else { return };
    let Ok(payload) = serde_json::to_vec(value) else { return };
    server.send_to_channel(channel, protocol::encode_message(msg_type, channel, &payload));
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
    // "updated" (a source paused or resumed) rides the "created" code: every
    // global consumer re-fetches the roster on any lifecycle push and reads the
    // answer from there, so a third code would be one nothing branches on.
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

#[cfg(test)]
mod tests {
    use super::*;
    use wiretap_checksum::algorithms::crc16_modbus_checksum;

    /// A Modbus RTU message: the body plus the CRC a device would append.
    fn rtu(body: &[u8]) -> Vec<u8> {
        let mut m = body.to_vec();
        m.extend(crc16_modbus_checksum(body).to_le_bytes());
        m
    }

    fn serial_frame(bytes: Vec<u8>) -> FrameMessage {
        framed("serial", 0, bytes)
    }

    /// An archive row: one whole message, `frame_id` = unit << 8 | function.
    fn archive_frame(bytes: Vec<u8>) -> FrameMessage {
        let id = (u32::from(bytes[0]) << 8) | u32::from(bytes[1]);
        framed("modbus_rtu", id, bytes)
    }

    fn framed(protocol: &str, frame_id: u32, bytes: Vec<u8>) -> FrameMessage {
        FrameMessage {
            protocol: protocol.to_string(),
            timestamp_us: 0,
            frame_id,
            bus: 2,
            dlc: bytes.len() as u8,
            bytes,
            is_extended: false,
            is_fd: false,
            source_address: None,
            incomplete: None,
            direction: None,
        }
    }

    fn modbus_session() -> SessionTunnels {
        SessionTunnels {
            declared: HashMap::new(),
            active: Mutex::new(HashMap::new()),
            serial: Some(Mutex::new(HashMap::new())),
        }
    }

    /// The serial port is already framed, so each frame is one whole message —
    /// and the response inherits its register address from the request before
    /// it, which only works because the stream is kept per session.
    #[test]
    fn a_framed_serial_port_yields_one_message_per_frame() {
        let tunnels = Arc::new(modbus_session());
        let request = serial_frame(rtu(&[0x01, 0x03, 0x00, 0x6B, 0x00, 0x03]));
        let response = serial_frame(rtu(&[
            0x01, 0x03, 0x06, 0x02, 0x2B, 0x00, 0x00, 0x00, 0x64,
        ]));

        let out = feed_tunnels(Some(&tunnels), "test", &request, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].direction, wiretap_catalog::Direction::Request);
        assert_eq!(out[0].start_register, Some(0x6B));
        assert_eq!(out[0].quantity, Some(3));
        assert!(out[0].crc_valid);

        let out = feed_tunnels(Some(&tunnels), "test", &response, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].direction, wiretap_catalog::Direction::Response);
        // Carried over from the request: a read response has no address of its own.
        assert_eq!(out[0].start_register, Some(0x6B));
        assert_eq!(out[0].registers, vec![0x022B, 0x0000, 0x0064]);
    }

    /// An archive row takes the same path, and interprets under codes and
    /// addresses a stock stream would refuse: the Sungrow line is 90% vendor
    /// codes and unit-0 broadcasts, and a tap already decided they were messages.
    /// The FC04 pair still decodes through a catalogue frame at its register.
    #[test]
    fn an_archive_message_interprets_whole_and_decodes_by_register() {
        let tunnels = Arc::new(modbus_session());
        let catalog = wiretap_catalog::Catalog::parse(
            r#"
[meta]
name = "line"

[frame.modbus.block]
register_number = 7815
register_type = "input"
length = 2

[[frame.modbus.block.signals]]
name = "First"
start_bit = 0
bit_length = 16
"#,
        )
        .expect("catalogue parses");

        let request = archive_frame(rtu(&[0x01, 0x04, 0x1E, 0x87, 0x00, 0x02]));
        let response = archive_frame(rtu(&[0x01, 0x04, 0x04, 0x12, 0x34, 0x00, 0x01]));
        let vendor = archive_frame(rtu(&[0x02, 0x65, 0x03, 0x00, 0x2E, 0x00, 0x0E]));
        let broadcast = archive_frame(rtu(&[0x00, 0x60, 0x00, 0x00, 0x00, 0x05]));

        assert_eq!(feed_tunnels(Some(&tunnels), "test", &request, 0).len(), 1);
        let out = feed_tunnels(Some(&tunnels), "test", &response, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].start_register, Some(7815));
        let decoded = tunnel_signals::decode_message(&out[0], &catalog);
        assert!(decoded.signals.iter().any(|s| s.name == "First" && s.value == 0x1234 as f64));
        assert_eq!(decoded.transaction["frame"], "block");

        let out = feed_tunnels(Some(&tunnels), "test", &vendor, 0);
        assert_eq!(out.len(), 1, "a vendor code frames without being declared");
        let decoded = tunnel_signals::decode_message(&out[0], &catalog);
        assert_eq!(decoded.transaction["register"], serde_json::Value::Null);
        assert!(!decoded.transaction["data"].as_array().unwrap().is_empty());

        assert_eq!(feed_tunnels(Some(&tunnels), "test", &broadcast, 0).len(), 1, "a broadcast is a message");
    }

    /// A message whose CRC disagrees is still reported, flagged — that flag is
    /// the whole of what a lenient policy has to be honest with.
    #[test]
    fn a_bad_crc_is_flagged_rather_than_dropped() {
        let tunnels = Arc::new(modbus_session());
        let mut bytes = rtu(&[0x01, 0x03, 0x00, 0x6B, 0x00, 0x03]);
        *bytes.last_mut().expect("crc appended") ^= 0xFF;

        let out = feed_tunnels(Some(&tunnels), "test", &serial_frame(bytes), 0);
        assert_eq!(out.len(), 1);
        assert!(!out[0].crc_valid);
    }

    /// Only a Modbus catalogue opens this path. Without it a serial frame that
    /// happens to parse as Modbus must not be reported as a message.
    #[test]
    fn a_non_modbus_catalogue_interprets_nothing() {
        let tunnels = Arc::new(SessionTunnels {
            declared: HashMap::new(),
            active: Mutex::new(HashMap::new()),
            serial: None,
        });
        let frame = serial_frame(rtu(&[0x01, 0x03, 0x00, 0x6B, 0x00, 0x03]));
        assert!(feed_tunnels(Some(&tunnels), "test", &frame, 0).is_empty());
    }

    /// Serial bytes that are not a whole RTU message yield nothing rather than
    /// being buffered — the reader owns framing on this path.
    #[test]
    fn a_frame_that_is_not_a_whole_message_yields_nothing() {
        let tunnels = Arc::new(modbus_session());
        for bytes in [vec![0x01, 0x03], vec![0x01, 0x03, 0x00, 0x6B, 0x00]] {
            assert!(feed_tunnels(Some(&tunnels), "test", &serial_frame(bytes), 0).is_empty());
        }
    }
}
