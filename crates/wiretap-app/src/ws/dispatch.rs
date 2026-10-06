// Copyright 2026 Wired Square Pty Ltd

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};

use once_cell::sync::Lazy;

use crate::capture_store::CaptureKind;
use crate::io::post_session::StreamEndedInfo;
use crate::io::{FrameMessage, IOState, PlaybackPosition};
use crate::transmit::{RepeatGroupStartedEvent, RepeatStartedEvent, RepeatStoppedEvent};
use crate::ws::protocol::{self, MsgType};
use crate::ws::server::ws_server;
use crate::ws::decoded::{
    ChecksumVerdict, DecodedFrameMsg, DecodedHeaderField, DecodedMirrorVerdict, DecodedMuxSelector,
    DecodedSignalValue, DecodedSignalsEntry, UnroutedFrameMsg, UnroutedKind,
};
use crate::ws::tunnel_signals::{self, DecodedTunnelMessage};

// ============================================================================
// Frame offset tracking
// ============================================================================

/// Tracks how many frames have been sent over WS per session.
static FRAME_OFFSETS: Lazy<RwLock<HashMap<String, usize>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Held from reading a session's offset to sending what it covers: a live batch
/// straddling an attach's backlog, which replaces Modbus rows, would be lost or doubled.
static DELIVERY_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn delivery_lock(session_id: &str) -> Arc<Mutex<()>> {
    DELIVERY_LOCKS
        .lock()
        .map(|mut locks| locks.entry(session_id.to_string()).or_default().clone())
        .unwrap_or_default()
}

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
    /// The stamp of the last request per (bus, masked id, device, function). An
    /// unanswered request is superseded by the next rather than queued.
    requests: Mutex<HashMap<(u8, u32, u8, u8), u64>>,
}

impl SessionTunnels {
    fn new(declared: HashMap<u32, wiretap_catalog::FrameTunnel>, modbus_catalog: bool) -> Self {
        Self {
            declared,
            active: Mutex::new(HashMap::new()),
            serial: modbus_catalog.then(|| Mutex::new(HashMap::new())),
            requests: Mutex::new(HashMap::new()),
        }
    }

    /// Microseconds since the request a response answers; records a request.
    fn latency_us(
        &self,
        bus: u8,
        masked_id: u32,
        msg: &wiretap_catalog::ModbusRtuMessage,
        t: u64,
    ) -> Option<u64> {
        let mut requests = self.requests.lock().ok()?;
        // An exception response carries its request's function code with the high bit set.
        let key = (bus, masked_id, msg.device_address, msg.function & 0x7F);
        match msg.direction {
            wiretap_catalog::Direction::Request => {
                requests.insert(key, t);
                None
            }
            wiretap_catalog::Direction::Response => {
                requests.get(&key).map(|sent| t.saturating_sub(*sent))
            }
        }
    }
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
        if declared.is_empty() && !modbus_catalog {
            m.remove(session_id);
        } else {
            let tunnels = SessionTunnels::new(declared, modbus_catalog);
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
        if let Ok(mut requests) = tunnels.requests.lock() {
            requests.clear();
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

pub(crate) fn attached_catalog(session_id: &str) -> Option<Arc<wiretap_catalog::Catalog>> {
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
/// batch-final verdict per mirror, keyed by **masked** frame id.
struct MirrorVerdicts {
    tracker: SharedMirrorTracker,
    by_masked_id: HashMap<u32, wiretap_catalog::MirrorVerdict>,
}

impl MirrorVerdicts {
    fn get(&self, raw_frame_id: u32) -> Option<&wiretap_catalog::MirrorVerdict> {
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
        tracker.verdicts().collect()
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
    catalog: &wiretap_catalog::Catalog,
    session_id: &str,
    frame: &FrameMessage,
    masked_id: u32,
) -> Vec<wiretap_catalog::ModbusRtuMessage> {
    let Some(tunnels) = tunnels else {
        return Vec::new();
    };
    let archive = frame.protocol == "modbus_rtu";
    if archive || frame.protocol == "serial" {
        let Some(serial) = tunnels.serial.as_ref() else {
            return Vec::new();
        };
        let Ok(mut streams) = serial.lock() else {
            return Vec::new();
        };
        // The device address is left open: whatever filtering the profile asked
        // for was already applied by the framer that produced this frame. The
        // vendor codes are not — see `SERIAL_RTU_OPTIONS`.
        let fallback = if archive {
            crate::io::ModbusRtuOptions::tapped()
        } else {
            Default::default()
        };
        return streams
            .entry(frame.bus)
            .or_insert_with(|| {
                SERIAL_RTU_OPTIONS
                    .read()
                    .ok()
                    .and_then(|m| m.get(session_id).cloned())
                    .unwrap_or(fallback)
                    .with_catalog(Some(catalog))
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
        .or_insert_with(|| catalog.tunnel_stream(declared))
        .push(&frame.bytes)
}

/// How many reassembled tunnel messages one batch will render. Mirrors the
/// frontend's `MAX_TUNNEL_TRANSACTIONS`, which is all it keeps — and a backlog
/// redecode can complete tens of thousands, each ~1 KB of JSON, so without this
/// `redecode_delivered` over a long capture builds a message nobody reads.
const MAX_RENDERED_TUNNEL_MESSAGES: usize = 500;

/// A completed tunnel message and, for a response, the time since its request.
pub(crate) type TunnelMessage = (wiretap_catalog::ModbusRtuMessage, Option<u64>);

/// Encode a frame batch against `catalog` into the `DecodedSignals` JSON
/// payload. `with_unrouted` adds an entry for every frame the catalogue did not
/// decode, saying why; without it only decoded frames are sent. Returns an
/// empty vec when there is nothing to send.
fn encode_decoded_batch(
    session_id: &str,
    frames: &[FrameMessage],
    catalog: &wiretap_catalog::Catalog,
    verdicts: Option<&MirrorVerdicts>,
    tunnels: Option<&SharedTunnels>,
    with_unrouted: bool,
) -> Vec<u8> {
    let mask = wiretap_catalog::decode::frame_id_mask(catalog);

    // Tunnels first, over the whole batch: a payload is a slice of a byte
    // stream, so every frame must be fed in order whether or not it decodes to
    // anything — a skipped frame is a hole that desyncs everything after it.
    // Only the newest messages are then rendered, and the ring bounds what is
    // held while the rest of the batch is still being fed.
    let mut completed: VecDeque<(usize, TunnelMessage)> = VecDeque::new();
    if let Some(shared) = tunnels {
        for (i, f) in frames.iter().enumerate() {
            let masked_id = mask.map_or(f.frame_id, |m| f.frame_id & m);
            for msg in feed_tunnels(tunnels, catalog, session_id, f, masked_id) {
                let latency = shared.latency_us(f.bus, masked_id, &msg, f.timestamp_us);
                if completed.len() == MAX_RENDERED_TUNNEL_MESSAGES {
                    completed.pop_front();
                }
                completed.push_back((i, (msg, latency)));
            }
        }
    }

    let mut per_frame: Vec<Vec<TunnelMessage>> = frames.iter().map(|_| Vec::new()).collect();
    for (i, message) in completed {
        per_frame[i].push(message);
    }

    let mut out = Vec::new();
    for (f, tunnel_messages) in frames.iter().zip(&per_frame) {
        let entry = if tunnel_messages.is_empty() && below_min_length(catalog, f) {
            with_unrouted.then(|| unrouted_entry(UnroutedKind::Short, f))
        } else {
            let verdict = verdicts.and_then(|v| v.get(f.frame_id));
            decode_entry(catalog, f, verdict, tunnel_messages)
                .map(DecodedSignalsEntry::Decoded)
                .or_else(|| with_unrouted.then(|| unrouted_entry(UnroutedKind::Unmatched, f)))
        };
        out.extend(entry);
    }
    if out.is_empty() {
        return Vec::new();
    }
    serde_json::to_vec(&out).unwrap_or_default()
}

/// The catalogue's serial `min_frame_length` says this is no frame of its own.
fn below_min_length(catalog: &wiretap_catalog::Catalog, f: &FrameMessage) -> bool {
    catalog
        .serial
        .as_ref()
        .and_then(|s| s.min_frame_length)
        .is_some_and(|min| f.bytes.len() < min as usize)
}

fn unrouted_entry(kind: UnroutedKind, f: &FrameMessage) -> DecodedSignalsEntry<'_> {
    DecodedSignalsEntry::Unrouted(UnroutedFrameMsg {
        bus: f.bus,
        bytes: &f.bytes,
        dlc: f.dlc,
        frame_id: f.frame_id,
        is_brs: f.is_brs,
        is_fd: f.is_fd,
        is_rtr: f.is_rtr,
        kind,
        protocol: &f.protocol,
        source_address: f.source_address,
        t: f.timestamp_us,
    })
}

/// One frame's entry in the `DecodedSignals` payload, or `None` when the
/// catalogue says nothing about it or it is a remote request, which carries no
/// data to decode. Shared by the live stream and the MCP
/// `get_decoded_signals` tool, so both describe a frame alike.
pub(crate) fn decode_entry<'a>(
    catalog: &'a wiretap_catalog::Catalog,
    f: &'a FrameMessage,
    verdict: Option<&'a wiretap_catalog::MirrorVerdict>,
    tunnel_messages: &'a [TunnelMessage],
) -> Option<DecodedFrameMsg<'a>> {
    if f.is_rtr {
        return None;
    }
    // decode_by_id applies frame_id_mask, looks up the frame, decodes
    // signals/mux, and extracts header fields (CAN id / serial bytes).
    // Defaulted, not skipped, when the catalogue has no frame for this id:
    // a serial RTU message has no frame layout of its own — its registers
    // are decoded from the message — so a frame that decoded nothing still
    // has something to render when it carried a message.
    let decoded =
        wiretap_catalog::decode::decode_by_id(catalog, f.frame_id, &f.bytes).unwrap_or_default();
    if tunnel_messages.is_empty()
        && decoded.signals.is_empty()
        && decoded.selectors.is_empty()
        && decoded.header_fields.is_empty()
    {
        return None;
    }
    let masked_id =
        wiretap_catalog::decode::frame_id_mask(catalog).map_or(f.frame_id, |m| f.frame_id & m);
    let mismatches = verdict.zip(catalog.frame(masked_id)).map_or_else(Vec::new, |(v, frame)| {
        mirror_mismatches(v, frame, &decoded.selectors)
    });
    let mut signals: Vec<_> = decoded
        .signals
        .into_iter()
        .enumerate()
        .map(|(i, s)| DecodedSignalValue {
            mirror_mismatch: mismatches.get(i).copied().flatten(),
            ..s.into()
        })
        .collect();
    // Messages this frame completed. They belong to the frame that finished
    // them, not the one that started them, so the UI's timestamp is when the
    // exchange was actually readable.
    let tunnel: Vec<_> = tunnel_messages
        .iter()
        .map(|(msg, latency_us)| {
            let decoded = tunnel_signals::decode_message(msg, catalog);
            signals.extend(decoded.signals.into_iter().map(DecodedSignalValue::from));
            DecodedTunnelMessage { latency_us: *latency_us, ..decoded.transaction }
        })
        .collect();
    Some(DecodedFrameMsg {
        bus: f.bus,
        bytes: &f.bytes,
        checksum: catalog
            .serial
            .as_ref()
            .and_then(|s| s.checksum.as_ref())
            .and_then(|c| crate::checksums::validate_serial_checksum(c, &f.bytes))
            .map(ChecksumVerdict::from),
        dlc: f.dlc,
        frame_id: f.frame_id,
        header_fields: decoded.header_fields.into_iter().map(DecodedHeaderField::from).collect(),
        is_brs: f.is_brs,
        is_fd: f.is_fd,
        masked_frame_id: masked_id,
        mirror: verdict.map(DecodedMirrorVerdict::from),
        selectors: decoded.selectors.into_iter().map(DecodedMuxSelector::from).collect(),
        signals,
        source_address: decoded.source_address,
        t: f.timestamp_us,
        tunnel: (!tunnel.is_empty()).then_some(tunnel),
    })
}

/// Each decoded signal's mirror verdict, index-aligned with the decode: whether
/// the bytes it covers differed from the source, or `None` where the tracker
/// did not compare them — a signal the mirror declares itself, or a mux case
/// signal outside the inherited plain signals' bytes.
fn mirror_mismatches(
    verdict: &wiretap_catalog::MirrorVerdict,
    frame: &wiretap_catalog::Frame,
    selectors: &[wiretap_catalog::decode::MuxSelector],
) -> Vec<Option<bool>> {
    let Some(is_valid) = verdict.is_valid else {
        return Vec::new();
    };
    let compared = wiretap_catalog::mirror::inherited_byte_indices(frame);
    decoded_signal_defs(frame, selectors)
        .into_iter()
        .map(|def| {
            let span = byte_span(def)
                .filter(|span| def.inherited && span.clone().all(|i| compared.contains(&i)))?;
            // Per-signal crosses only once the frame has latched Mismatch.
            Some(!is_valid && span.into_iter().any(|i| verdict.mismatched_byte_indices.contains(&i)))
        })
        .collect()
}

/// The catalogue signals behind a frame's decode, in the order `decode_frame`
/// emits them: the plain signals, then each matched mux case's, outermost first.
fn decoded_signal_defs<'a>(
    frame: &'a wiretap_catalog::Frame,
    selectors: &[wiretap_catalog::decode::MuxSelector],
) -> Vec<&'a wiretap_catalog::Signal> {
    let mut defs: Vec<_> = frame.signals.iter().collect();
    let mut mux = frame.mux.as_ref();
    for selector in selectors {
        let Some(case) = mux.zip(selector.matched_case.as_deref()).and_then(|(m, k)| m.cases.get(k))
        else {
            break;
        };
        defs.extend(&case.signals);
        mux = case.mux.as_deref();
    }
    defs
}

fn byte_span(signal: &wiretap_catalog::Signal) -> Option<std::ops::RangeInclusive<usize>> {
    let (start_bit, bit_length) = (signal.start_bit?, signal.bit_length?);
    (bit_length > 0).then(|| (start_bit / 8) as usize..=((start_bit + bit_length - 1) / 8) as usize)
}

/// Read new frames from capture_store since the last send, encode as binary, and send via WS.
/// Called from signal_frames_ready at the 2Hz throttle cadence.
pub fn send_new_frames(session_id: &str) {
    let Some(server) = ws_server() else { return };
    let Some(channel) = server.channel_for_session(session_id) else { return };

    let capture_id = match crate::capture_store::get_session_frame_capture_id(session_id) {
        Some(id) => id,
        None => return,
    };

    let lock = delivery_lock(session_id);
    let _delivering = lock.lock();
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

    send_frames(session_id, &frames);

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
    let Some(server) = ws_server() else { return };
    let Some(channel) = server.channel_for_session(session_id) else { return };

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

    reset_decode_state(session_id);
}

/// Drop the order-dependent decode state — mirror samples and part-built tunnel
/// messages — wherever the frame stream restarts or jumps. Without this the
/// tracker keeps its pre-clear samples and latch, so the next batch re-asserts
/// the verdict the user just cleared (and after a rewind, timestamps jump
/// backwards past the fuzz window and it can never be re-compared away).
pub fn reset_decode_state(session_id: &str) {
    if let Some(tracker) = mirror_tracker(session_id) {
        if let Ok(mut tracker) = tracker.lock() {
            tracker.reset();
        }
    }
    reset_tunnels(session_id);
    crate::adhoc::reset_toggles(session_id);
}

/// Clear frame offset for a session.
/// Called on unsubscribe or when the channel is released.
pub fn clear_frame_offset(session_id: &str) {
    if let Ok(mut offsets) = FRAME_OFFSETS.write() {
        offsets.remove(session_id);
    }
    if let Ok(mut locks) = DELIVERY_LOCKS.lock() {
        locks.remove(session_id);
    }
    crate::adhoc::forget_session(session_id);
}

/// Decode the frames already delivered to this session's client (everything up to the
/// current send offset) against the attached catalogue and push DecodedSignals — without
/// re-sending the FrameData. `send_new_frames` only decodes frames *past* the offset, so a
/// catalogue attached after frames were delivered (e.g. a capture replay that started
/// streaming before the decoder bound its catalogue) would otherwise leave those frames
/// undecoded. Called right after `attach_catalog`, and sent only to `conn_id`, the window
/// that attached, as a `DecodedBacklog` for `subscriber`, the app in it that attached, to
/// replace what it holds with — sent even when empty, so rows from the previous catalogue
/// go too.
pub fn redecode_delivered(session_id: &str, conn_id: usize, subscriber: &str) {
    let Some(catalog) = attached_catalog(session_id) else { return };
    let Some(server) = ws_server() else { return };
    let Some(channel) = server.channel_for_session(session_id) else { return };
    let Some(capture_id) = crate::capture_store::get_session_frame_capture_id(session_id) else {
        return;
    };
    let lock = delivery_lock(session_id);
    let _delivering = lock.lock();
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
    let decoded = encode_decoded_batch(session_id, &frames, &catalog, verdicts.as_ref(), tunnels.as_ref(), false);
    let Ok(name_len) = u16::try_from(subscriber.len()) else { return };
    let payload = [&name_len.to_be_bytes(), subscriber.as_bytes(), &decoded].concat();
    server.send_to_conn(conn_id, protocol::encode_message(MsgType::DecodedBacklog, channel, &payload));
}

/// Send a batch of frames to all WebSocket subscribers for this session.
pub fn send_frames(session_id: &str, frames: &[FrameMessage]) {
    let Some(server) = ws_server() else { return };
    let Some(channel) = server.channel_for_session(session_id) else { return };
    for (kind, payload) in frame_batch_messages(session_id, frames) {
        server.send_to_channel(channel, protocol::encode_message(kind, channel, &payload));
    }
    let mask = attached_catalog(session_id).and_then(|c| wiretap_catalog::decode::frame_id_mask(&c));
    for (conn_id, payload) in crate::adhoc::batch_messages(session_id, frames, mask) {
        server.send_to_conn(conn_id, protocol::encode_message(MsgType::AdhocSignals, channel, &payload));
    }
}

/// Live capture and playback both deliver through here, so neither can skip the decode.
fn frame_batch_messages(session_id: &str, frames: &[FrameMessage]) -> Vec<(MsgType, Vec<u8>)> {
    let mut messages = vec![(MsgType::FrameData, protocol::encode_frame_batch(frames))];
    if let Some(catalog) = attached_catalog(session_id) {
        let verdicts = mirror_verdicts(session_id, frames);
        let tunnels = tunnel_decoders(session_id);
        let decoded = encode_decoded_batch(session_id, frames, &catalog, verdicts.as_ref(), tunnels.as_ref(), true);
        if !decoded.is_empty() {
            messages.push((MsgType::DecodedSignals, decoded));
        }
    }
    messages
}

/// Send on a session's own channel. The payload is built only once a subscriber
/// is known to exist, so a headless session never pays for it; `None` sends nothing.
fn send_to_session<P: Into<Option<Vec<u8>>>>(session_id: &str, msg_type: MsgType, payload: impl FnOnce() -> P) {
    let Some(server) = ws_server() else { return };
    let Some(channel) = server.channel_for_session(session_id) else { return };
    let Some(payload) = payload().into() else { return };
    server.send_to_channel(channel, protocol::encode_message(msg_type, channel, &payload));
}

/// Send on the global channel, to every connected client; `None` sends nothing.
fn send_to_all<P: Into<Option<Vec<u8>>>>(msg_type: MsgType, payload: impl FnOnce() -> P) {
    let Some(server) = ws_server() else { return };
    let Some(payload) = payload().into() else { return };
    server.send_global(protocol::encode_message(msg_type, 0, &payload));
}

fn send_json_to_all<T: serde::Serialize + ?Sized>(msg_type: MsgType, value: &T) {
    send_to_all(msg_type, || serde_json::to_vec(value).ok());
}

/// Send session state change.
pub fn send_session_state(session_id: &str, current: &IOState) {
    let error_msg = match current {
        IOState::Error(msg) => Some(msg.as_str()),
        _ => None,
    };
    send_to_session(session_id, MsgType::SessionState, || protocol::encode_session_state(current.code(), error_msg));
}

/// Send stream-ended info.
pub fn send_stream_ended(session_id: &str, info: &StreamEndedInfo) {
    send_to_session(session_id, MsgType::StreamEnded, || stream_ended_payload(info));
}

fn stream_ended_payload(info: &StreamEndedInfo) -> Vec<u8> {
    protocol::encode_stream_ended(
        info.reason.code(),
        info.capture_available,
        info.capture_id.as_deref(),
        info.capture_kind.as_ref().map(CaptureKind::as_str),
        info.count as u32,
        info.time_range,
    )
}

/// Send session error.
pub fn send_session_error(session_id: &str, severity: crate::io::ErrorSeverity, error: &str) {
    send_to_session(session_id, MsgType::SessionError, || protocol::encode_session_error(severity.code(), error));
}

/// Send playback position update.
pub fn send_playback_position(session_id: &str, pos: &PlaybackPosition) {
    send_to_session(session_id, MsgType::PlaybackPosition, || {
        protocol::encode_playback_position(
            pos.timestamp_us as u64,
            pos.frame_index as u32,
            pos.frame_count.unwrap_or(0) as u32,
        )
    });
}

/// Send device-connected info.
pub fn send_device_connected(
    session_id: &str,
    device_type: &str,
    address: &str,
    bus: Option<u8>,
) {
    send_to_session(session_id, MsgType::DeviceConnected, || {
        protocol::encode_device_connected(device_type, address, bus)
    });
}

/// Send capture-changed, carrying the session's frames capture id (empty: none).
pub fn send_capture_changed(session_id: &str) {
    send_to_session(session_id, MsgType::CaptureChanged, || {
        let capture_id = crate::capture_store::get_session_frame_capture_id(session_id).unwrap_or_default();
        protocol::encode_capture_changed(&capture_id)
    });
}

/// Send session info (speed + subscriber count).
pub fn send_session_info(session_id: &str, speed: f64, subscriber_count: u16) {
    send_to_session(session_id, MsgType::SessionInfo, || protocol::encode_session_info(speed, subscriber_count));
}

/// Send session-reconfigured signal.
pub fn send_reconfigured(session_id: &str) {
    // Empty payload — the frontend clears stale frames on receipt
    send_to_session(session_id, MsgType::Reconfigured, Vec::new);
}

/// Send transmit-updated signal with the history revision (global, channel 0).
pub fn send_transmit_updated(revision: i64) {
    send_to_all(MsgType::TransmitUpdated, || revision.to_le_bytes().to_vec());
}

// ============================================================================
// Command dispatch (0x20 → 0x21)
// ============================================================================

/// Route a WS command to the appropriate handler.
/// Returns Ok(json_value) on success, Err(error_string) on failure.
pub async fn dispatch_command(
    op_name: &str,
    params: &[u8],
    conn_id: usize,
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
        name if name.starts_with("adhoc.") => crate::adhoc::dispatch_adhoc_command(name, params, conn_id),
        name if name.starts_with("catalog.") => {
            crate::catalog::dispatch_catalog_command(name, params, conn_id).await
        }
        "app.startup_notices" => Ok(serde_json::json!(crate::startup_notices())),
        _ => Err(format!("Unknown command: {op_name}")),
    }
}

/// Push an OTA event payload to all connected WS clients on the global
/// channel. Payload is opaque JSON — the frontend decodes the
/// discriminated union by `type` field.
pub fn send_ota_event(event: &serde_json::Value) {
    send_json_to_all(MsgType::OtaEvent, event);
}

/// Push the open-app roster snapshot to all connected WS clients on the global
/// channel. Payload is opaque JSON (`Vec<AppInstanceInfo>`); the frontend replaces
/// its roster state. Mirrors `send_ota_event` / `send_replay_state`.
pub fn send_open_apps_changed(roster: &[crate::io::AppInstanceInfo]) {
    send_json_to_all(MsgType::OpenAppsChanged, roster);
}

/// Signal all connected WS clients that the decoder-catalogue list changed.
/// Payload is the fresh list as JSON; the frontend treats this as a "re-sync"
/// trigger and reconciles via `list_catalogs`. Mirrors `send_open_apps_changed`.
pub fn send_catalog_list_changed(catalogs: &[crate::catalog::CatalogFile]) {
    send_json_to_all(MsgType::CatalogListChanged, catalogs);
}

/// Signal all connected WS clients that the capture list changed.
pub fn send_capture_list_changed() {
    send_to_all(MsgType::CaptureListChanged, Vec::new);
}

pub fn send_session_log_entry(entry: &crate::io::session_log::SessionLogEntry) {
    if let Some(server) = ws_server() {
        server.send_global(session_log_message(entry));
    }
}

fn session_log_message(entry: &crate::io::session_log::SessionLogEntry) -> Vec<u8> {
    protocol::encode_message(MsgType::SessionLogAppended, 0, &serde_json::to_vec(entry).unwrap_or_default())
}

/// Send replay state update (global, channel 0).
pub fn send_replay_state(state: &crate::replay::ReplayState) {
    send_json_to_all(MsgType::ReplayState, state);
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
    GroupStarted(&'a RepeatGroupStartedEvent),
}

fn send_repeat_event(payload: &RepeatEventPayload<'_>) {
    send_json_to_all(MsgType::RepeatEvent, payload);
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

pub fn send_repeat_group_started(event: &RepeatGroupStartedEvent) {
    send_repeat_event(&RepeatEventPayload::GroupStarted(event));
}

#[derive(serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AttachToPanelMsg<'a> {
    pub panel: &'a str,
    pub session_id: &'a str,
}

/// Ask the frontend to surface a session in a source-aware tab (open/focus the
/// panel and point it at the session).
pub fn send_attach_to_panel(panel: &str, session_id: &str) {
    send_json_to_all(MsgType::AttachToPanel, &AttachToPanelMsg { panel, session_id });
}

/// Send Test Pattern state update (global, channel 0).
///
/// Takes the state rather than an id: the caller is about to store this very
/// value, so reading it back out of the map would copy the whole thing again.
pub fn send_io_test_state(state: &crate::io_test::IOTestState) {
    send_json_to_all(MsgType::TestPatternState, state);
}

/// Send a JSON-payload message on a session's own channel.
pub fn send_session_json<T: serde::Serialize>(
    session_id: &str,
    msg_type: MsgType,
    value: &T,
) {
    send_to_session(session_id, msg_type, || serde_json::to_vec(value).ok());
}

/// Send session lifecycle event (global, channel 0).
pub fn send_session_lifecycle(payload: &crate::io::SessionLifecyclePayload) {
    send_to_all(MsgType::SessionLifecycle, || session_lifecycle_payload(payload));
}

fn session_lifecycle_payload(payload: &crate::io::SessionLifecyclePayload) -> Vec<u8> {
    protocol::encode_session_lifecycle(
        payload.event_type.code(),
        &payload.session_id,
        payload.source_type.as_deref(),
        payload.state.as_ref().map(IOState::code),
        payload.subscriber_count as u16,
    )
}

/// Send a session's transition on its own channel.
pub fn send_session_transition(session_id: &str, payload: &crate::io::SessionTransitionPayload) {
    send_to_session(session_id, MsgType::SessionLifecycle, || session_transition_payload(payload));
}

fn session_transition_payload(payload: &crate::io::SessionTransitionPayload) -> Vec<u8> {
    protocol::encode_session_transition(
        payload.state.code(),
        payload.transition.code(),
        payload.mode.code(),
        &serde_json::to_string(&payload.capabilities).unwrap_or_default(),
        payload.capture_id.as_deref(),
        payload.capture_count as u32,
    )
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

    #[test]
    fn a_created_session_sends_its_state_byte() {
        use crate::io::{LifecycleEvent, SessionLifecyclePayload};
        let created = |event_type, state| SessionLifecyclePayload {
            session_id: "f_1".into(),
            event_type,
            source_type: None,
            state,
            subscriber_count: 1,
            source_profile_ids: vec![],
            subscriber_id: None,
            reset: false,
        };
        let running = session_lifecycle_payload(&created(LifecycleEvent::Created, Some(IOState::Running)));
        assert_eq!(running, [0, 1, 0, 3, 0, b'f', b'_', b'1', 2, IOState::Running.code()]);
        let destroyed = session_lifecycle_payload(&created(LifecycleEvent::Destroyed, None));
        assert_eq!(destroyed, [1, 1, 0, 3, 0, b'f', b'_', b'1', 0]);
    }

    #[test]
    fn a_session_log_entry_goes_out_globally_as_json() {
        use crate::io::session_log::{SessionLogEntry, SessionLogEvent};
        let entry = SessionLogEntry {
            id: 9,
            timestamp_ms: 1_700_000_000_000,
            session_id: Some("f_1".into()),
            profile_ids: vec!["p1".into()],
            subscriber_id: Some("decoder_1".into()),
            app_name: Some("decoder".into()),
            event: SessionLogEvent::Joined { subscriber_count: 2 },
        };
        let message = session_log_message(&entry);
        let header = protocol::Header::decode(&message).unwrap();
        assert_eq!((header.msg_type, header.channel), (MsgType::SessionLogAppended, 0));
        let body: serde_json::Value = serde_json::from_slice(&message[protocol::HEADER_SIZE..]).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "id": 9, "timestamp_ms": 1_700_000_000_000u64, "session_id": "f_1", "profile_ids": ["p1"],
                "subscriber_id": "decoder_1", "app_name": "decoder",
                "event": { "kind": "joined", "subscriber_count": 2 },
            })
        );
    }

    #[test]
    fn a_transition_carries_its_codes_capabilities_and_capture() {
        use crate::io::{IOCapabilities, SessionMode, SessionTransition, SessionTransitionPayload};
        let capabilities = IOCapabilities::realtime_can();
        let json = serde_json::to_string(&capabilities).unwrap();
        let bytes = session_transition_payload(&SessionTransitionPayload {
            transition: SessionTransition::SwitchedToCapture,
            state: IOState::Stopped,
            capabilities,
            mode: SessionMode::Replaying,
            capture_id: Some("c1".into()),
            capture_count: 42,
        });
        let mut want = vec![IOState::Stopped.code(), SessionTransition::SwitchedToCapture.code(), SessionMode::Replaying.code()];
        want.extend((json.len() as u16).to_le_bytes());
        want.extend(json.as_bytes());
        want.extend([2, 0, b'c', b'1', 42, 0, 0, 0]);
        assert_eq!(bytes, want);
    }

    #[test]
    fn stream_ended_keeps_its_wire_and_json() {
        use crate::io::StreamEndReason;
        let cases = [
            (
                StreamEndedInfo {
                    reason: StreamEndReason::Paused,
                    capture_available: true,
                    capture_id: Some("buf1".into()),
                    capture_kind: Some(CaptureKind::Frames),
                    count: 42,
                    time_range: None,
                },
                vec![4, 7, 42, 0, 0, 0, 4, 0, 98, 117, 102, 49, 6, 0, 102, 114, 97, 109, 101, 115],
                r#"{"reason":"paused","capture_available":true,"capture_id":"buf1","capture_kind":"frames","count":42,"time_range":null}"#,
            ),
            (
                StreamEndedInfo {
                    reason: StreamEndReason::Error,
                    capture_available: true,
                    capture_id: Some("b_2".into()),
                    capture_kind: Some(CaptureKind::Bytes),
                    count: 42,
                    time_range: Some((1000, 2000)),
                },
                vec![
                    2, 15, 42, 0, 0, 0, 3, 0, 98, 95, 50, 5, 0, 98, 121, 116, 101, 115, 232, 3, 0, 0, 0, 0, 0, 0,
                    208, 7, 0, 0, 0, 0, 0, 0,
                ],
                r#"{"reason":"error","capture_available":true,"capture_id":"b_2","capture_kind":"bytes","count":42,"time_range":[1000,2000]}"#,
            ),
            (
                StreamEndedInfo {
                    reason: StreamEndReason::Complete,
                    capture_available: false,
                    capture_id: None,
                    capture_kind: None,
                    count: 42,
                    time_range: None,
                },
                vec![0, 0, 42, 0, 0, 0],
                r#"{"reason":"complete","capture_available":false,"capture_id":null,"capture_kind":null,"count":42,"time_range":null}"#,
            ),
        ];
        for (info, wire, json) in cases {
            assert_eq!(stream_ended_payload(&info), wire);
            assert_eq!(serde_json::to_string(&info).unwrap(), json);
        }
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
            dlc: bytes.len() as u16,
            bytes,
            is_extended: false,
            is_fd: false,
            source_address: None,
            incomplete: None,
            direction: None,
            ..Default::default()
        }
    }

    fn bare() -> wiretap_catalog::Catalog {
        wiretap_catalog::Catalog::parse("[meta]\nname = \"bare\"\n").expect("catalogue parses")
    }

    /// A 0x60 of 19 bytes whose first 18 also pass their CRC.
    fn dispatch_short_by_one() -> Vec<u8> {
        let msg = rtu(&[
            0x00, 0x60, 0x12, 0x34, 0x00, 0x01, 0x0A, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
            0x00, 0x00, 0x64,
        ]);
        assert_eq!(rtu(&msg[..16]), msg[..18], "the fixture is not ambiguous");
        msg
    }

    fn tunnel_catalogue(function_code: &str) -> wiretap_catalog::Catalog {
        wiretap_catalog::Catalog::parse(&tunnel_catalogue_toml(function_code)).expect("catalogue parses")
    }

    fn tunnel_catalogue_toml(function_code: &str) -> String {
        format!(
            r#"
[meta]
name = "tunnel"
{function_code}
[frame.can."0x1E0"]
length = 8
[frame.can."0x1E0".tunnel]
protocol = "modbus_rtu"
vendor_functions = [0x60]
allow_broadcast = true
"#
        )
    }

    /// The tunnel's own table declares 0x60, which only a CRC search can frame
    /// and which stops a byte short; the catalogue's length rule frames it whole.
    #[test]
    fn a_tunnel_frames_a_vendor_code_by_its_catalogue_rule() {
        let msg = dispatch_short_by_one();
        let framed_by = |catalog: wiretap_catalog::Catalog| -> Vec<usize> {
            let session = "tunnel-catalogue-rule";
            attach_catalog(session, None, catalog.clone());
            let tunnels = tunnel_decoders(session);
            let lengths = msg
                .chunks(8)
                .map(|chunk| framed("can", 0x1E0, chunk.to_vec()))
                .flat_map(|f| feed_tunnels(tunnels.as_ref(), &catalog, session, &f, 0x1E0))
                .map(|m| m.raw.len())
                .collect();
            detach_catalog(session);
            lengths
        };
        assert_eq!(framed_by(tunnel_catalogue("")), [18]);
        let ruled = "[meta.modbus.function_code.0x60]\nlengths = [{ len = { count_at = 6, overhead = 9 } }]";
        assert_eq!(framed_by(tunnel_catalogue(ruled)), [19]);
    }

    fn modbus_session() -> SessionTunnels {
        SessionTunnels::new(HashMap::new(), true)
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

        let out = feed_tunnels(Some(&tunnels), &bare(), "test", &request, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].direction, wiretap_catalog::Direction::Request);
        assert_eq!(out[0].start_register, Some(0x6B));
        assert_eq!(out[0].quantity, Some(3));
        assert!(out[0].crc_valid);

        let out = feed_tunnels(Some(&tunnels), &bare(), "test", &response, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].direction, wiretap_catalog::Direction::Response);
        // Carried over from the request: a read response has no address of its own.
        assert_eq!(out[0].start_register, Some(0x6B));
        assert_eq!(out[0].registers(), [0x022B, 0x0000, 0x0064]);
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

        assert_eq!(
            feed_tunnels(Some(&tunnels), &catalog, "test", &request, 0).len(),
            1
        );
        let out = feed_tunnels(Some(&tunnels), &catalog, "test", &response, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].start_register, Some(7815));
        let decoded = tunnel_signals::decode_message(&out[0], &catalog);
        assert!(decoded.signals.iter().any(|s| s.name == "First" && s.value == 0x1234 as f64));
        assert_eq!(decoded.transaction.frame, Some("block"));

        let out = feed_tunnels(Some(&tunnels), &catalog, "test", &vendor, 0);
        assert_eq!(out.len(), 1, "a vendor code frames without being declared");
        let decoded = tunnel_signals::decode_message(&out[0], &catalog);
        assert_eq!(decoded.transaction.register, None);
        assert!(!decoded.transaction.data.is_empty());

        assert_eq!(feed_tunnels(Some(&tunnels), &catalog, "test", &broadcast, 0).len(), 1, "a broadcast is a message");
    }

    /// A message whose CRC disagrees is still reported, flagged — that flag is
    /// the whole of what a lenient policy has to be honest with.
    #[test]
    fn a_bad_crc_is_flagged_rather_than_dropped() {
        let tunnels = Arc::new(modbus_session());
        let mut bytes = rtu(&[0x01, 0x03, 0x00, 0x6B, 0x00, 0x03]);
        *bytes.last_mut().expect("crc appended") ^= 0xFF;

        let out = feed_tunnels(Some(&tunnels), &bare(), "test", &serial_frame(bytes), 0);
        assert_eq!(out.len(), 1);
        assert!(!out[0].crc_valid);
    }

    /// Only a Modbus catalogue opens this path. Without it a serial frame that
    /// happens to parse as Modbus must not be reported as a message.
    #[test]
    fn a_non_modbus_catalogue_interprets_nothing() {
        let tunnels = Arc::new(SessionTunnels::new(HashMap::new(), false));
        let frame = serial_frame(rtu(&[0x01, 0x03, 0x00, 0x6B, 0x00, 0x03]));
        assert!(feed_tunnels(Some(&tunnels), &bare(), "test", &frame, 0).is_empty());
    }

    /// Serial bytes that are not a whole RTU message yield nothing rather than
    /// being buffered — the reader owns framing on this path.
    #[test]
    fn a_frame_that_is_not_a_whole_message_yields_nothing() {
        let tunnels = Arc::new(modbus_session());
        for bytes in [vec![0x01, 0x03], vec![0x01, 0x03, 0x00, 0x6B, 0x00]] {
            assert!(
                feed_tunnels(Some(&tunnels), &bare(), "test", &serial_frame(bytes), 0).is_empty()
            );
        }
    }

    /// `interpret` refuses a code nothing declares, so a catalogue's code has to
    /// reach it too or the framed message never reaches the Modbus tab.
    #[test]
    fn a_framed_serial_port_interprets_the_catalogues_vendor_codes() {
        let tunnels = Arc::new(modbus_session());
        let vendor = serial_frame(rtu(&[0x01, 0x60, 0x00, 0x01, 0x0A]));
        assert!(feed_tunnels(Some(&tunnels), &bare(), "test", &vendor, 0).is_empty());
        let catalog = wiretap_catalog::Catalog::parse(
            "[meta]\nname = \"x\"\n[meta.modbus.function_code.0x60]\n",
        )
        .expect("catalogue parses");
        let tunnels = Arc::new(modbus_session());
        assert_eq!(
            feed_tunnels(Some(&tunnels), &catalog, "test", &vendor, 0).len(),
            1
        );
    }

    fn can(frame_id: u32, t: u64, bytes: Vec<u8>) -> FrameMessage {
        FrameMessage {
            timestamp_us: t,
            ..framed("can", frame_id, bytes)
        }
    }

    fn entries(
        catalog: &wiretap_catalog::Catalog,
        frames: &[FrameMessage],
        with_unrouted: bool,
    ) -> Vec<serde_json::Value> {
        let json = encode_decoded_batch("routing", frames, catalog, None, None, with_unrouted);
        if json.is_empty() {
            return Vec::new();
        }
        serde_json::from_slice(&json).expect("batch is a JSON array")
    }

    const ROUTED: &str = r#"
[meta]
name = "routed"
[meta.can]
frame_id_mask = 0xFF00
[frame.can."0x100"]
length = 8
[[frame.can."0x100".signals]]
name = "Level"
start_bit = 0
bit_length = 8
"#;

    #[test]
    fn every_frame_is_routed_and_a_backlog_carries_decoded_only() {
        let catalog = wiretap_catalog::Catalog::parse(ROUTED).expect("catalogue parses");
        let frames = [can(0x1A5, 10, vec![7; 8]), can(0x2A5, 20, vec![1, 2])];

        let live = entries(&catalog, &frames, true);
        assert_eq!(live.len(), 2);
        assert!(live[0].get("kind").is_none(), "absent kind means decoded");
        assert_eq!(live[0]["frameId"], 0x1A5);
        assert_eq!(live[0]["maskedFrameId"], 0x100);
        assert_eq!(live[1]["kind"], "unmatched");
        assert_eq!(live[1]["frameId"], 0x2A5);
        assert_eq!(live[1]["t"], 20);
        assert_eq!(live[1]["bytes"], serde_json::json!([1, 2]));
        assert_eq!(live[1]["protocol"], "can");

        let backlog = entries(&catalog, &frames, false);
        assert_eq!(backlog.len(), 1);
        assert!(backlog[0].get("kind").is_none());
    }

    #[test]
    fn a_decoded_frame_carries_no_rtr_flag() {
        let value = golden_mirror_entry(|entry| serde_json::to_value(entry).unwrap());
        assert!(value.get("isRtr").is_none(), "{value}");
    }

    #[test]
    fn a_remote_frame_does_not_decode_signals() {
        let catalog = wiretap_catalog::Catalog::parse(ROUTED).expect("catalogue parses");
        let rtr = FrameMessage { is_rtr: true, dlc: 8, ..can(0x1A5, 10, vec![]) };
        let decoded = decode_entry(&catalog, &rtr, None, &[]).map(|e| serde_json::to_value(e).unwrap());
        assert_eq!(decoded, None);
        assert_eq!(entries(&catalog, &[rtr], true)[0]["kind"], "unmatched");
    }

    const SERIAL: &str = r#"
[meta]
name = "serial"
[meta.serial]
encoding = "slip"
min_frame_length = 4
[meta.serial.checksum]
algorithm = "xor"
start_byte = -1
byte_length = 1
[frame.serial."0x01"]
length = 4
[[frame.serial."0x01".signals]]
name = "Value"
start_bit = 8
bit_length = 8
"#;

    #[test]
    fn a_frame_under_the_catalogues_minimum_length_is_short_not_decoded() {
        let catalog = wiretap_catalog::Catalog::parse(SERIAL).expect("catalogue parses");
        let live = entries(&catalog, &[framed("serial", 1, vec![0x01, 0x02])], true);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0]["kind"], "short");
        assert_eq!(live[0]["protocol"], "serial");
        assert!(entries(&catalog, &[framed("serial", 1, vec![0x01, 0x02])], false).is_empty());
    }

    #[test]
    fn a_framed_serial_frame_carries_its_checksum_verdict() {
        let catalog = wiretap_catalog::Catalog::parse(SERIAL).expect("catalogue parses");
        let good = framed("serial", 1, vec![0x01, 0x02, 0x03, 0x01 ^ 0x02 ^ 0x03]);
        let bad = framed("serial", 1, vec![0x01, 0x02, 0x03, 0xFF]);
        let live = entries(&catalog, &[good, bad], true);
        assert_eq!(live[0]["checksum"]["valid"], true);
        assert_eq!(live[0]["checksum"]["extracted"], 0x00);
        assert_eq!(live[1]["checksum"]["valid"], false);
        assert_eq!(live[1]["checksum"]["extracted"], 0xFF);

        let can_catalog = wiretap_catalog::Catalog::parse(ROUTED).expect("catalogue parses");
        let live = entries(&can_catalog, &[can(0x100, 0, vec![0; 8])], true);
        assert!(live[0].get("checksum").is_none(), "no serial checksum, no verdict");
    }

    const MIRRORED_MUX: &str = r#"
[meta]
name = "mirror"
[meta.can]
default_interval = 100
[frame.can."0x705"]
length = 8
[[frame.can."0x705".signals]]
name = "Plain"
start_bit = 0
bit_length = 16
[[frame.can."0x705".signals]]
name = "Own"
start_bit = 32
bit_length = 8
[frame.can."0x705".mux]
start_bit = 16
bit_length = 8
[[frame.can."0x705".mux."1".signals]]
name = "Case_Over_Plain"
start_bit = 8
bit_length = 8
[[frame.can."0x705".mux."1".signals]]
name = "Case_Alone"
start_bit = 24
bit_length = 8
[frame.can."0x005"]
length = 8
mirror_of = "0x705"
[[frame.can."0x005".signals]]
name = "Own"
start_bit = 32
bit_length = 8
"#;

    fn mirror_signals(source: [u8; 8], mirror: [u8; 8]) -> HashMap<String, serde_json::Value> {
        let catalog = wiretap_catalog::Catalog::parse(MIRRORED_MUX).expect("catalogue parses");
        let mut tracker = wiretap_catalog::MirrorTracker::new(&catalog);
        for k in 0..3 {
            tracker.observe(0x705, &source, f64::from(k));
            tracker.observe(0x005, &mirror, f64::from(k) + 0.01);
        }
        let (_, verdict) = tracker.verdicts().next().expect("0x005 is tracked");
        let frame = can(0x005, 0, mirror.to_vec());
        let entry = decode_entry(&catalog, &frame, Some(&verdict), &[]).expect("mirror decodes");
        serde_json::to_value(entry.signals)
            .expect("signals serialise")
            .as_array()
            .expect("signals")
            .iter()
            .map(|s| (s["name"].as_str().expect("named").to_string(), s.clone()))
            .collect()
    }

    /// Byte 1 differs. The mux case signal reading it was compared, through the
    /// plain signal over the same byte; the one at byte 3 was not, so it has no
    /// verdict rather than the frame's; the mirror's own signal is never compared.
    #[test]
    fn a_mirror_signal_takes_the_verdict_of_the_bytes_it_covers() {
        let source = [0x10, 0x20, 0x01, 0x40, 0x50, 0, 0, 0];
        let mut mirror = source;
        mirror[1] = 0x21;
        mirror[3] = 0x41;
        let signals = mirror_signals(source, mirror);
        assert_eq!(signals["Plain"]["mirrorMismatch"], true);
        assert_eq!(signals["Case_Over_Plain"]["mirrorMismatch"], true);
        assert!(signals["Case_Alone"].get("mirrorMismatch").is_none());
        assert!(signals["Own"].get("mirrorMismatch").is_none());

        let signals = mirror_signals(source, source);
        assert_eq!(signals["Plain"]["mirrorMismatch"], false);
        assert_eq!(signals["Case_Over_Plain"]["mirrorMismatch"], false);
        assert!(signals["Case_Alone"].get("mirrorMismatch").is_none());
    }

    /// A vendor message between the request and its response neither pairs
    /// with either nor displaces the request's stamp.
    #[test]
    fn a_tunnel_response_carries_its_latency_past_an_interleaved_vendor_message() {
        let catalog = tunnel_catalogue("");
        let session = "tunnel-latency";
        attach_catalog(session, None, catalog.clone());
        let tunnels = tunnel_decoders(session);
        let mut frames = Vec::new();
        for (t, body) in [
            (1_000, vec![0x01, 0x04, 0x4D, 0xE2, 0x00, 0x02]),
            (2_000, vec![0x01, 0x60, 0x00, 0x01, 0x0A]),
            (5_000, vec![0x01, 0x04, 0x04, 0x01, 0x2C, 0x00, 0x00]),
        ] {
            frames.extend(rtu(&body).chunks(8).map(|c| can(0x1E0, t, c.to_vec())));
        }
        let json = encode_decoded_batch(session, &frames, &catalog, None, tunnels.as_ref(), true);
        detach_catalog(session);

        let batch: Vec<serde_json::Value> = serde_json::from_slice(&json).expect("JSON array");
        let transactions: Vec<_> = batch
            .iter()
            .filter_map(|e| e["tunnel"].as_array())
            .flatten()
            .map(|t| (t["function"].as_u64().expect("function"), t.get("latencyUs").cloned()))
            .collect();
        assert_eq!(
            transactions,
            [
                (0x04, None),
                (0x60, None),
                (0x04, Some(serde_json::json!(4_000))),
            ]
        );
    }

    /// The wire cost of routing every frame, on a bus where the catalogue
    /// covers a third of the ids. Run with `--nocapture` for the numbers.
    #[test]
    fn routing_every_frame_costs_less_than_doubling_the_batch() {
        let mut toml = String::from("[meta]\nname = \"third\"\n");
        for id in 0x100..0x10A {
            toml += &format!("[frame.can.\"0x{id:X}\"]\nlength = 8\n");
            for (n, name) in ["Pack_Voltage", "Pack_Current", "Cell_Temperature_Max", "State_Of_Charge"]
                .iter()
                .enumerate()
            {
                toml += &format!(
                    "[[frame.can.\"0x{id:X}\".signals]]\nname = \"{name}\"\nstart_bit = {}\nbit_length = 16\nfactor = 0.1\nunit = \"V\"\n",
                    n * 16
                );
            }
        }
        let catalog = wiretap_catalog::Catalog::parse(&toml).expect("catalogue parses");
        let frames: Vec<_> = (0..300u32)
            .map(|i| can(0x100 + (i % 30), u64::from(i) * 1_000, vec![0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]))
            .collect();
        let decoded_only = encode_decoded_batch("size", &frames, &catalog, None, None, false).len();
        let routed = encode_decoded_batch("size", &frames, &catalog, None, None, true).len();
        eprintln!(
            "DecodedSignals bytes per 300-frame batch: decoded only {decoded_only}, routed {routed} ({:.2}x)",
            routed as f64 / decoded_only as f64
        );
        assert!(routed < decoded_only * 2);
    }

    /// Capture playback delivers frames through `send_frames`, not the
    /// capture-offset path, and must reach the Decoder all the same.
    #[test]
    fn a_playback_batch_carries_its_decode_at_the_captures_stamp() {
        let session = "playback-decode";
        attach_catalog(session, None, wiretap_catalog::Catalog::parse(ROUTED).expect("catalogue parses"));
        let messages = frame_batch_messages(session, &[can(0x1A5, 1_234_567, vec![7; 8])]);
        detach_catalog(session);

        let decoded = messages
            .iter()
            .find(|(kind, _)| *kind == MsgType::DecodedSignals)
            .expect("a DecodedSignals batch");
        let batch: Vec<serde_json::Value> = serde_json::from_slice(&decoded.1).expect("JSON array");
        assert_eq!(batch[0]["t"], 1_234_567);
        assert_eq!(batch[0]["maskedFrameId"], 0x100);
    }

    #[test]
    fn a_joining_window_alone_receives_the_tunnel_backlog_addressed_to_its_subscriber() {
        use crate::ws::server::outbox::{self, Recipient};
        const JOINING: usize = 7_001;
        const CHANNEL: u8 = 201;
        let session = "joining-window-backlog";
        crate::capture_db::use_in_memory_database();
        crate::capture_store::create_session_capture(
            session,
            crate::capture_store::CaptureKind::Frames,
            session.to_string(),
        );
        let mut frames = Vec::new();
        for (t, body) in [
            (1_000, vec![0x01, 0x04, 0x4D, 0xE2, 0x00, 0x02]),
            (5_000, vec![0x01, 0x04, 0x04, 0x01, 0x2C, 0x00, 0x00]),
        ] {
            frames.extend(rtu(&body).chunks(8).map(|c| can(0x1E0, t, c.to_vec())));
        }
        crate::capture_store::append_frames_to_session(session, frames);
        outbox::subscribe(session, CHANNEL);
        send_new_frames(session);

        tauri::async_runtime::block_on(crate::catalog::dispatch_catalog_command(
            "catalog.attach",
            serde_json::json!({ "session_id": session, "content": tunnel_catalogue_toml(""), "subscriber": "main_dashboard" }),
            JOINING,
        ))
        .expect("attach");
        detach_catalog(session);

        let sent = outbox::sent(CHANNEL, MsgType::DecodedBacklog);
        let [(recipient, payload)] = sent.as_slice() else { panic!("one backlog, got {}", sent.len()) };
        assert_eq!(*recipient, Recipient::Conn(JOINING));
        assert_eq!(payload[..2], [0, 14]);
        assert_eq!(&payload[2..16], b"main_dashboard");
        assert!(serde_json::from_slice::<Vec<serde_json::Value>>(&payload[16..]).is_ok_and(|d| !d.is_empty()));
    }

    const HEADERED: &str = r#"
[meta]
name = "headered"
[meta.can]
frame_id_mask = 0x1FFFFF00
[meta.can.fields]
pgn = { mask = 0x1FFFFF00, format = "hex" }
source_address = { mask = 0x000000FF, format = "decimal" }
[frame.can.0x18EF0000]
length = 8
[[frame.can.0x18EF0000.signals]]
name = "Mode"
start_bit = 0
bit_length = 8
format = "enum"
enum = { 1 = "run", 2 = "stop" }
[[frame.can.0x18EF0000.signals]]
name = "Volts"
start_bit = 8
bit_length = 16
factor = 0.1
unit = "V"
[[frame.can.0x18EF0000.signals]]
name = "Huge"
start_bit = 0
bit_length = 64
factor = 1e10
"#;

    fn golden_mirror_entry<R>(read: impl FnOnce(&DecodedFrameMsg) -> R) -> R {
        let catalog = wiretap_catalog::Catalog::parse(MIRRORED_MUX).expect("catalogue parses");
        let source = [0x10, 0x20, 0x01, 0x40, 0x50, 0, 0, 0];
        let mirror = [0x10, 0x21, 0x01, 0x41, 0x50, 0, 0, 0];
        let mut tracker = wiretap_catalog::MirrorTracker::new(&catalog);
        for k in 0..3 {
            tracker.observe(0x705, &source, f64::from(k));
            tracker.observe(0x005, &mirror, f64::from(k) + 0.01);
        }
        let (_, verdict) = tracker.verdicts().next().expect("0x005 is tracked");
        let frame = can(0x005, 3, mirror.to_vec());
        read(&decode_entry(&catalog, &frame, Some(&verdict), &[]).expect("mirror decodes"))
    }

    /// `DecodedSignals` bytes for every entry shape: header fields and a source
    /// address, a mux and a mirror verdict, a tunnel message with its latency,
    /// a checksum, and the unmatched and short entries.
    fn golden_batches() -> Vec<String> {
        let headered = wiretap_catalog::Catalog::parse(HEADERED).expect("catalogue parses");
        let unmatched = FrameMessage { source_address: Some(0x42), ..can(0x18EE0042, 7, vec![9]) };
        let headered_batch =
            encode_decoded_batch("golden", &[can(0x18EF0042, 5, vec![2, 0x01, 0x02, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]), unmatched], &headered, None, None, true);

        let mirror_entry = golden_mirror_entry(|entry| serde_json::to_vec(entry).unwrap());

        let tunnelled = tunnel_catalogue("");
        let session = "golden-tunnel";
        attach_catalog(session, None, tunnelled.clone());
        let tunnels = tunnel_decoders(session);
        let mut frames = Vec::new();
        for (t, body) in [
            (1_000, vec![0x01, 0x04, 0x4D, 0xE2, 0x00, 0x02]),
            (5_000, vec![0x01, 0x04, 0x04, 0x01, 0x2C, 0x00, 0x00]),
            (6_000, vec![0x01, 0x81, 0x02]),
        ] {
            frames.extend(rtu(&body).chunks(8).map(|c| can(0x1E0, t, c.to_vec())));
        }
        let tunnel_batch = encode_decoded_batch(session, &frames, &tunnelled, None, tunnels.as_ref(), true);
        detach_catalog(session);

        let serial = wiretap_catalog::Catalog::parse(SERIAL).expect("catalogue parses");
        let serial_batch = encode_decoded_batch(
            "golden",
            &[framed("serial", 1, vec![0x01, 0x02, 0x03, 0x00]), framed("serial", 1, vec![0x01])],
            &serial,
            None,
            None,
            true,
        );

        [headered_batch, mirror_entry, tunnel_batch, serial_batch]
            .into_iter()
            .map(|bytes| String::from_utf8(bytes).unwrap())
            .collect()
    }

    /// Captured from the `json!` builders these structs replaced.
    const GOLDEN: &str = include_str!("decoded-golden.jsonl");

    #[test]
    fn decoded_signals_bytes_are_unchanged() {
        assert_eq!(golden_batches(), GOLDEN.lines().collect::<Vec<_>>());
    }

    /// MCP's `get_decoded_signals` reads `decode_entry` as a JSON value.
    #[test]
    fn decode_entry_reads_as_the_same_json_value() {
        let value = golden_mirror_entry(|entry| serde_json::to_value(entry).unwrap());
        assert_eq!(value.to_string(), GOLDEN.lines().nth(1).unwrap());
    }

    #[test]
    fn decoded_and_unmatched_entries_carry_the_frames_can_flags_and_an_rtrs_requested_length() {
        let headered = wiretap_catalog::Catalog::parse(HEADERED).expect("catalogue parses");
        let fd = |id| FrameMessage { is_fd: true, is_brs: true, ..can(id, 0, vec![2, 0x01, 0x02, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]) };
        let rtr = |id| FrameMessage { is_rtr: true, dlc: 6, ..can(id, 0, vec![]) };
        let frames = [fd(0x18EF0042), fd(0x18EE0042), rtr(0x18EF0042), rtr(0x18EE0042)];
        let bytes = encode_decoded_batch("can-flags", &frames, &headered, None, None, true);
        let entries: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();

        let seen: Vec<_> =
            entries.iter().map(|e| serde_json::json!([e["kind"], e["isFd"], e["isBrs"], e["isRtr"], e["dlc"]])).collect();
        assert_eq!(
            seen,
            [
                serde_json::json!([null, true, true, null, 8]),
                serde_json::json!(["unmatched", true, true, false, 8]),
                serde_json::json!(["unmatched", false, false, true, 6]),
                serde_json::json!(["unmatched", false, false, true, 6]),
            ]
        );
    }

    #[test]
    fn an_out_of_range_signal_sends_a_null_scaled_value() {
        let catalog = wiretap_catalog::Catalog::parse(
            r#"
[meta]
name = "huge"

[frame.can.0x104]
length = 8

[[frame.can.0x104.signals]]
name = "Huge"
start_bit = 0
bit_length = 64
factor = 1e10
"#,
        )
        .expect("catalogue parses");

        let decoded = wiretap_catalog::decode::decode_by_id(&catalog, 0x104, &[0xFF; 8]).expect("decodes");
        let json = serde_json::to_value(DecodedSignalValue::from(decoded.signals[0].clone())).unwrap();

        assert_eq!(json["scaled"], serde_json::Value::Null);
        assert_eq!(json["display"], "(out of range)");
    }
}
