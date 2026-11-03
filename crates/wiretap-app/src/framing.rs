// ui/crates/wiretap-app/src/framing.rs
//
// Tauri commands for backend framing operations.
// Converts raw serial bytes into structured frames using various protocols.
// Only available on desktop (serial not supported on iOS).

/// `FramingState` (0x25): how far a session's framing of its byte capture has got.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FramingStateMsg {
    pub framed_capture_id: String,
    pub frame_count: usize,
    pub filtered_capture_id: Option<String>,
    pub filtered_count: usize,
    /// The protocol the framer stamped on the first frame.
    pub protocol: Option<String>,
}

// ============================================================================
// iOS stub - serial framing not available
// ============================================================================

#[cfg(target_os = "ios")]
mod ios_stub {
    /// Untyped, deliberately: the command only ever errors here, and stub structs
    /// mirroring the desktop shapes are two more things to keep in step — which
    /// they were not, having missed the last two fields added opposite.
    #[tauri::command(rename_all = "snake_case")]
    pub async fn set_capture_framing(
        _session_id: String,
        _config: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        Err("Framing is not available on iOS".to_string())
    }

    #[tauri::command(rename_all = "snake_case")]
    pub fn extract_serial_ids(
        _frames: serde_json::Value,
        _frame_id_config: serde_json::Value,
        _source_address_config: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        Err("Framing is not available on iOS".to_string())
    }

    pub fn follow(_session_id: &str) {}
    pub fn finish(_session_id: &str) {}
    pub fn drop_follower(_session_id: &str) {}
}

#[cfg(target_os = "ios")]
pub use ios_stub::*;

// ============================================================================
// Desktop implementation
// ============================================================================

#[cfg(not(target_os = "ios"))]
mod desktop {
    use std::collections::{hash_map::Entry, HashMap, VecDeque};
    use std::sync::{Arc, Mutex, PoisonError};

    use once_cell::sync::Lazy;

    use super::FramingStateMsg;
    use crate::{
        capture_store::{self, CaptureKind, TimestampedByte},
        io::{serial::utils::framed_serial, FrameMessage, FramingMode, IOState},
    };
    use wslib_wiretap_catalogue::serial_framing::{
        DelimiterOptions, FrameIdConfig, FramingEncoding, SerialFrame, SerialFramer,
    };
    use wslib_wiretap_catalogue::Catalogue;

    /// Per-interface framing configuration (overrides default for specific bus)
    #[derive(Clone, serde::Deserialize)]
    #[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
    pub struct InterfaceFramingConfig {
        pub mode: FramingMode,
        /// For delimiter mode: delimiter bytes as hex string (e.g., "0D0A")
        pub delimiter: Option<String>,
        /// For delimiter mode: max frame length before forced split
        pub max_length: Option<usize>,
        /// For modbus_rtu mode: the RTU settings. Re-framing has to agree with
        /// the live framer or the Framed tab changes on stop.
        #[serde(default)]
        pub modbus: Option<wslib_wiretap_catalogue::RtuSettings>,
    }

    /// Configuration for backend framing
    #[derive(Clone, serde::Deserialize)]
    #[cfg_attr(test, derive(ts_rs::TS), ts(optional_fields = nullable))]
    pub struct BackendFramingConfig {
        /// The default framing, in the same shape a per-interface override takes.
        /// Flattened, so the wire stays the flat keys the frontend has always sent.
        #[serde(flatten)]
        pub framing: InterfaceFramingConfig,
        /// Minimum frame length to accept (frames shorter are discarded)
        pub min_length: Option<usize>,
        /// Frame ID extraction config
        pub frame_id_config: Option<FrameIdConfig>,
        /// Source address extraction config
        pub source_address_config: Option<FrameIdConfig>,
        /// Per-interface framing overrides (bus number -> config)
        pub per_interface: Option<HashMap<u8, InterfaceFramingConfig>>,
    }

    /// Build framing encoding from mode and options
    fn build_encoding(cfg: &InterfaceFramingConfig) -> Result<FramingEncoding, String> {
        match cfg.mode {
            FramingMode::Slip => Ok(FramingEncoding::Slip {
                max_frame_len: cfg.max_length.unwrap_or(1024),
            }),
            FramingMode::ModbusRtu => Ok(FramingEncoding::ModbusRtu(
                cfg.modbus.clone().unwrap_or_default(),
            )),
            FramingMode::Delimiter => {
                let delimiter = match cfg.delimiter.as_deref() {
                    Some(hex) => {
                        wslib_bits::hex::parse_bytes(hex).map_err(|e| e.to_string())?
                    }
                    None => vec![0x0A], // Default LF
                };
                Ok(FramingEncoding::Delimiter(DelimiterOptions {
                    delimiter,
                    max_length: cfg.max_length.unwrap_or(1024),
                    include_delimiter: false,
                }))
            }
            FramingMode::Raw => {
                Err("Raw is the unframed byte stream; choose a framing to apply".to_string())
            }
        }
    }

    /// Clear `reuse` if it is a derived capture of this session, otherwise
    /// derive a fresh one. The session's *own* capture is never reusable —
    /// clearing it would destroy what it is still recording.
    async fn clear_or_derive(session_id: &str, reuse: &str, name: String) -> String {
        if capture_store::get_capture_kind(reuse) == Some(CaptureKind::Frames)
            && capture_store::is_derived_capture(reuse, session_id)
        {
            capture_store::clear_and_refill_capture(reuse, Vec::new()).await;
            return reuse.to_string();
        }
        capture_store::create_derived_capture(session_id, CaptureKind::Frames, name)
    }

    /// Remove a derived capture this run no longer produces, rather than leaving
    /// it behind showing the previous run's rows.
    fn drop_derived_capture(session_id: &str, id: Option<&str>) {
        let Some(id) = id.filter(|id| capture_store::is_derived_capture(id, session_id)) else {
            return;
        };
        if let Err(e) = capture_store::delete_capture(id) {
            tlog!("[framing] Could not delete stale capture '{}': {}", id, e);
        }
    }

    /// A frame, with the capture index and stamp of its last byte.
    struct Released {
        frame: SerialFrame,
        end_idx: usize,
        timestamp_us: u64,
        bus: u8,
    }

    /// No framer holds a candidate this long; the cap bounds a line that never frames.
    const MAX_HELD_STAMPS: usize = 1 << 20;

    /// One bus's framer, with the capture index and stamp of each byte it may still release.
    struct BusFramer {
        framer: SerialFramer,
        held: VecDeque<(usize, u64)>,
        /// Bytes fed before `held[0]`, in `SerialFrame::end_offset`'s count.
        released_to: u64,
        abandoned: u64,
    }

    impl BusFramer {
        fn new(framer: SerialFramer) -> Self {
            Self { framer, held: VecDeque::new(), released_to: 0, abandoned: 0 }
        }

        fn feed(&mut self, bus: u8, bytes: &[(usize, &TimestampedByte)]) -> Vec<Released> {
            self.held.extend(bytes.iter().map(|(i, b)| (*i, b.timestamp_us)));
            let line: Vec<u8> = bytes.iter().map(|(_, b)| b.byte).collect();
            let frames = self.framer.feed(&line);
            self.release(bus, frames)
        }

        /// Modbus RTU can still recover whole messages at the flush, so it is
        /// a list, not one residue.
        fn flush(&mut self, bus: u8) -> Vec<Released> {
            let frames = self.framer.flush();
            self.release(bus, frames)
        }

        fn release(&mut self, bus: u8, frames: Vec<SerialFrame>) -> Vec<Released> {
            if self.framer.abandoned_frames() > self.abandoned {
                self.abandoned = self.framer.abandoned_frames();
                tlog!(
                    "[serial] SLIP frame outgrew the frame cap without an END ({} abandoned)",
                    self.abandoned
                );
            }
            let released_through = frames.iter().map(|f| f.end_offset).max().unwrap_or(0);
            // Each frame's last byte, not the one that released it: a sync
            // releases the RTU messages it buffered on a later byte.
            let released = frames
                .into_iter()
                .map(|frame| {
                    let at = frame.end_offset.saturating_sub(self.released_to + 1) as usize;
                    let (end_idx, timestamp_us) = self.held.get(at).copied().unwrap_or_default();
                    Released { frame, end_idx, timestamp_us, bus }
                })
                .collect();
            let done = (released_through.saturating_sub(self.released_to) as usize)
                .max(self.held.len().saturating_sub(MAX_HELD_STAMPS))
                .min(self.held.len());
            self.held.drain(..done);
            self.released_to += done as u64;
            released
        }
    }

    /// Frames at or above the minimum length, then those below it.
    type Messages = (Vec<FrameMessage>, Vec<FrameMessage>);

    /// One byte stream's framing, fed in order in any number of steps. Each
    /// message is stamped at its last byte, as a live line and the gateway
    /// archive do.
    struct Framing {
        config: BackendFramingConfig,
        default_encoding: FramingEncoding,
        overrides: HashMap<u8, FramingEncoding>,
        catalog: Option<Arc<Catalogue>>,
        buses: HashMap<u8, BusFramer>,
        /// The fallback frame id: the frame's position in the framed stream.
        next_index: u32,
    }

    impl Framing {
        fn new(config: BackendFramingConfig, catalog: Option<Arc<Catalogue>>) -> Result<Self, String> {
            let checked = |cfg: &InterfaceFramingConfig| {
                build_encoding(cfg)?.checked().map_err(|e| e.to_string())
            };
            let default_encoding = checked(&config.framing)?;
            let overrides = config
                .per_interface
                .iter()
                .flatten()
                .map(|(bus, cfg)| Ok((*bus, checked(cfg)?)))
                .collect::<Result<_, String>>()?;
            Ok(Self { config, default_encoding, overrides, catalog, buses: HashMap::new(), next_index: 0 })
        }

        fn restart(&mut self) {
            self.buses.clear();
            self.next_index = 0;
        }

        /// Feed the stream's bytes from capture index `start`. Each interface
        /// has its own framer, so their byte streams never mix.
        fn feed(&mut self, start: usize, bytes: &[TimestampedByte]) -> Messages {
            let mut by_bus: HashMap<u8, Vec<(usize, &TimestampedByte)>> = HashMap::new();
            for (i, byte) in bytes.iter().enumerate() {
                by_bus.entry(byte.bus).or_default().push((start + i, byte));
            }
            let mut released = Vec::new();
            for (bus, bus_bytes) in by_bus {
                if let Some(framer) = self.bus(bus) {
                    released.extend(framer.feed(bus, &bus_bytes));
                }
            }
            self.messages(released)
        }

        fn flush(&mut self) -> Messages {
            let released = self.buses.iter_mut().flat_map(|(bus, framer)| framer.flush(*bus)).collect();
            self.messages(released)
        }

        fn bus(&mut self, bus: u8) -> Option<&mut BusFramer> {
            match self.buses.entry(bus) {
                Entry::Occupied(e) => Some(e.into_mut()),
                Entry::Vacant(e) => {
                    let encoding = self.overrides.get(&bus).unwrap_or(&self.default_encoding).clone();
                    let framer = SerialFramer::with_catalogue(encoding, self.catalog.as_deref())?;
                    Some(e.insert(BusFramer::new(framer)))
                }
            }
        }

        fn messages(&mut self, mut released: Vec<Released>) -> Messages {
            released.sort_by_key(|r| r.end_idx);
            let min_length = self.config.min_length.unwrap_or(1);
            let extract = |cfg: &Option<FrameIdConfig>, bytes: &[u8]| cfg.as_ref()?.extract(bytes);
            let (mut passed, mut filtered) = (Vec::new(), Vec::new());
            for Released { frame, timestamp_us, bus, .. } in released {
                let index = self.next_index;
                self.next_index += 1;
                let short = frame.bytes.len() < min_length;
                let message = FrameMessage {
                    timestamp_us,
                    bus,
                    source_address: extract(&self.config.source_address_config, &frame.bytes).map(|v| v as u16),
                    incomplete: frame.incomplete.then_some(true),
                    ..framed_serial(frame.bytes, frame.crc_valid, |bytes| {
                        extract(&self.config.frame_id_config, bytes).unwrap_or(index)
                    })
                };
                if short { filtered.push(message) } else { passed.push(message) }
            }
            (passed, filtered)
        }
    }

    /// A session's framing of its byte capture, kept up as bytes arrive.
    struct Follower {
        framing: Framing,
        bytes_capture_id: String,
        consumed: usize,
        flushed: bool,
        state: FramingStateMsg,
    }

    /// Bytes read from the capture per step of a catch-up.
    const CATCH_UP_CHUNK: usize = 1 << 16;

    impl Follower {
        /// Frame from byte 0 again, into the same derived captures.
        async fn restart(&mut self, session_id: &str, bytes_capture_id: String) {
            self.framing.restart();
            self.consumed = 0;
            self.flushed = false;
            let framed_capture_id = clear_or_derive(
                session_id,
                &self.state.framed_capture_id,
                format!("Framed from {bytes_capture_id}"),
            )
            .await;
            drop_derived_capture(session_id, self.state.filtered_capture_id.as_deref());
            self.state = FramingStateMsg { framed_capture_id, ..Default::default() };
            self.bytes_capture_id = bytes_capture_id;
        }

        /// Frame the bytes stored since the last catch-up, then the residue
        /// when `flush`. A cleared or replaced byte capture, or bytes after a
        /// flush (a reconnect), restart the framing.
        async fn catch_up(&mut self, session_id: &str, flush: bool) {
            // A destroyed session has orphaned its capture; the finish still owes it the residue.
            let bytes_capture_id = capture_store::get_session_bytes_capture_id(session_id)
                .unwrap_or_else(|| self.bytes_capture_id.clone());
            let total = capture_store::get_capture_count(&bytes_capture_id);
            if bytes_capture_id != self.bytes_capture_id
                || total < self.consumed
                || (self.flushed && total > self.consumed)
            {
                self.restart(session_id, bytes_capture_id.clone()).await;
            }
            while self.consumed < total {
                let limit = (total - self.consumed).min(CATCH_UP_CHUNK);
                let bytes = match capture_store::get_capture_bytes_paginated(&bytes_capture_id, self.consumed, limit).await {
                    Ok((bytes, _)) if !bytes.is_empty() => bytes,
                    Ok(_) => break,
                    Err(e) => {
                        tlog!("[framing] {session_id}: bytes not read, retrying on the next count: {e}");
                        break;
                    }
                };
                let messages = self.framing.feed(self.consumed, &bytes);
                self.consumed += bytes.len();
                self.store(session_id, messages).await;
            }
            if flush && !self.flushed {
                let messages = self.framing.flush();
                self.store(session_id, messages).await;
                self.flushed = true;
            }
        }

        async fn store(&mut self, session_id: &str, (passed, filtered): Messages) {
            if self.state.protocol.is_none() {
                self.state.protocol = passed.first().map(|m| m.protocol.clone());
            }
            self.state.frame_count += passed.len();
            self.state.filtered_count += filtered.len();
            capture_store::append_frames_to_capture(&self.state.framed_capture_id, passed).await;
            if filtered.is_empty() {
                return;
            }
            let filtered_capture_id = self
                .state
                .filtered_capture_id
                .get_or_insert_with(|| {
                    capture_store::create_derived_capture(
                        session_id,
                        CaptureKind::Frames,
                        format!("Filtered from {}", self.bytes_capture_id),
                    )
                })
                .clone();
            capture_store::append_frames_to_capture(&filtered_capture_id, filtered).await;
        }
    }

    /// Held across a whole catch-up, so two never interleave.
    type FollowerSlot = Arc<tokio::sync::Mutex<Option<Follower>>>;

    static FOLLOWERS: Lazy<Mutex<HashMap<String, FollowerSlot>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    fn followers() -> std::sync::MutexGuard<'static, HashMap<String, FollowerSlot>> {
        FOLLOWERS.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn follower_slot(session_id: &str) -> Option<FollowerSlot> {
        followers().get(session_id).cloned()
    }

    /// The slot is taken before the task runs, so a finish spawned at stream end
    /// still frames the tail when the session is destroyed before it gets the lock.
    async fn step(slot: FollowerSlot, session_id: &str, flush: bool) {
        let mut held = slot.lock().await;
        let Some(follower) = held.as_mut() else { return };
        let before = follower.state.clone();
        follower.catch_up(session_id, flush).await;
        if follower.state != before {
            crate::ws::dispatch::send_framing_state(session_id, Some(&follower.state));
        }
    }

    fn spawn_step(session_id: &str, flush: bool) {
        let Some(slot) = follower_slot(session_id) else { return };
        let following = slot.try_lock().map_or(true, |follower| follower.is_some());
        if following {
            let session_id = session_id.to_string();
            tauri::async_runtime::spawn(async move { step(slot, &session_id, flush).await });
        }
    }

    /// Frame the bytes that arrived since the last call, on the byte cadence.
    pub fn follow(session_id: &str) {
        spawn_step(session_id, false);
    }

    /// The stream ended: frame the rest and write the residue.
    pub fn finish(session_id: &str) {
        spawn_step(session_id, true);
    }

    /// Forget the session's follower. Its captures are the session's and follow
    /// the orphan rules.
    pub fn drop_follower(session_id: &str) {
        followers().remove(session_id);
    }

    /// Frame the session's byte capture with `config` from byte 0 and keep
    /// framing it as bytes arrive, into derived captures reused across calls;
    /// `None` stops and deletes them.
    #[tauri::command(rename_all = "snake_case")]
    pub async fn set_capture_framing(
        session_id: String,
        config: Option<BackendFramingConfig>,
    ) -> Result<Option<FramingStateMsg>, String> {
        let replacement = match config {
            Some(config) => {
                let bytes_capture_id = capture_store::get_session_bytes_capture_id(&session_id)
                    .ok_or_else(|| "No byte capture found for session".to_string())?;
                let framing = Framing::new(config, crate::ws::dispatch::attached_catalog(&session_id))?;
                let live = matches!(
                    crate::io::get_session_state(&session_id).await,
                    Some(IOState::Starting | IOState::Running | IOState::Paused)
                );
                Some((framing, bytes_capture_id, live))
            }
            None => None,
        };

        let slot = followers().entry(session_id.clone()).or_default().clone();
        let mut held = slot.lock().await;
        let previous = held.take().map(|f| f.state);

        let Some((framing, bytes_capture_id, live)) = replacement else {
            if let Some(previous) = previous {
                drop_derived_capture(&session_id, Some(&previous.framed_capture_id));
                drop_derived_capture(&session_id, previous.filtered_capture_id.as_deref());
            }
            crate::ws::dispatch::send_framing_state(&session_id, None);
            return Ok(None);
        };

        let mut follower = Follower {
            framing,
            bytes_capture_id: String::new(),
            consumed: 0,
            flushed: false,
            state: previous.unwrap_or_default(),
        };
        follower.restart(&session_id, bytes_capture_id).await;
        follower.catch_up(&session_id, !live).await;
        let state = follower.state.clone();
        *held = Some(follower);
        crate::ws::dispatch::send_framing_state(&session_id, Some(&state));
        Ok(Some(state))
    }

    #[derive(serde::Serialize)]
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub struct SerialIds {
        pub frame_id: Option<u32>,
        pub source_address: Option<u16>,
    }

    /// The ids each frame carries under these configs, as the reader and
    /// re-framing would extract them.
    #[tauri::command(rename_all = "snake_case")]
    pub fn extract_serial_ids(
        frames: Vec<Vec<u8>>,
        frame_id_config: Option<FrameIdConfig>,
        source_address_config: Option<FrameIdConfig>,
    ) -> Vec<SerialIds> {
        let extract = |cfg: &Option<FrameIdConfig>, bytes: &[u8]| cfg.as_ref()?.extract(bytes);
        frames
            .iter()
            .map(|bytes| SerialIds {
                frame_id: extract(&frame_id_config, bytes),
                source_address: extract(&source_address_config, bytes).map(|v| v as u16),
            })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::capture_db::wait;

        fn config(mode: &str) -> BackendFramingConfig {
            BackendFramingConfig {
                framing: InterfaceFramingConfig {
                    mode: crate::io::types::framing_named(mode),
                    delimiter: None,
                    max_length: None,
                    modbus: None,
                },
                min_length: None,
                frame_id_config: None,
                source_address_config: None,
                per_interface: None,
            }
        }

        /// Byte `i` is stamped `1_000 + 10 * i`.
        fn stamped(line: &[u8]) -> Vec<TimestampedByte> {
            line.iter()
                .enumerate()
                .map(|(i, &byte)| TimestampedByte {
                    byte,
                    timestamp_us: 1_000 + 10 * i as u64,
                    bus: 0,
                })
                .collect()
        }

        fn rtu(hex: &str) -> Vec<u8> {
            let mut out = wslib_bits::hex::parse_bytes(hex).unwrap();
            out.extend(wslib_checksum::algorithms::crc16_modbus_checksum(&out).to_le_bytes());
            out
        }

        /// The whole stream in one catch-up, then the flush.
        fn frame_messages(
            bytes: &[TimestampedByte],
            config: &BackendFramingConfig,
            catalog: Option<Arc<Catalogue>>,
        ) -> Result<Messages, String> {
            let mut framing = Framing::new(config.clone(), catalog)?;
            let (mut passed, mut filtered) = framing.feed(0, bytes);
            let (more, short) = framing.flush();
            passed.extend(more);
            filtered.extend(short);
            Ok((passed, filtered))
        }

        fn stamps(bytes: &[TimestampedByte], config: &BackendFramingConfig) -> Vec<u64> {
            let (passed, _) = frame_messages(bytes, config, None).unwrap();
            passed.iter().map(|m| m.timestamp_us).collect()
        }

        #[test]
        fn a_modbus_message_is_stamped_at_its_last_byte() {
            let line = [rtu("01044DE20002"), rtu("010404012C0000")].concat();
            assert_eq!(stamps(&stamped(&line), &config("modbus_rtu")), vec![1_070, 1_160]);
        }

        /// `01 03 40` opens a plausible 69-byte response, so the framer holds
        /// everything behind it until that candidate fails, then releases the
        /// messages it held all at once.
        #[test]
        fn messages_a_sync_releases_together_keep_their_own_last_bytes() {
            let exchange = [rtu("01044DE20002"), rtu("010404012C0000")];
            let mut line = vec![0x01, 0x03, 0x40];
            let mut last_bytes = Vec::new();
            for message in exchange.iter().cycle().take(8) {
                line.extend(message);
                last_bytes.push(1_000 + 10 * (line.len() as u64 - 1));
            }
            assert_eq!(stamps(&stamped(&line), &config("modbus_rtu")), last_bytes);
        }

        #[test]
        fn a_reframed_rtu_message_is_stored_as_the_archive_stores_it() {
            let (request, response) = (rtu("08044DE20002"), rtu("080404012C0000"));
            let config = BackendFramingConfig {
                frame_id_config: id_config(2, 1, true),
                source_address_config: id_config(0, 1, true),
                ..config("modbus_rtu")
            };
            let (passed, _) = frame_messages(&stamped(&[request.clone(), response.clone()].concat()), &config, None).unwrap();
            let rows: Vec<_> = passed
                .iter()
                .map(|m| (m.protocol.as_str(), m.frame_id, m.bytes.clone(), m.crc_valid, m.source_address))
                .collect();
            assert_eq!(
                rows,
                [
                    ("modbus_rtu", 0x0804, request, Some(true), Some(0x08)),
                    ("modbus_rtu", 0x0804, response, Some(true), Some(0x08)),
                ]
            );
        }

        #[test]
        fn only_rtu_framing_stores_modbus_rtu() {
            let (passed, _) = frame_messages(&stamped(&[0x08, 0x04, 0xC0]), &config("slip"), None).unwrap();
            let rows: Vec<_> = passed.iter().map(|m| (m.protocol.as_str(), m.frame_id, m.crc_valid)).collect();
            assert_eq!(rows, [("serial", 0, None)]);
        }

        fn rows(messages: &[FrameMessage]) -> Vec<(u64, Vec<u8>, u32, Option<bool>, Option<bool>)> {
            messages
                .iter()
                .map(|m| (m.timestamp_us, m.bytes.clone(), m.frame_id, m.crc_valid, m.incomplete))
                .collect()
        }

        #[test]
        fn a_stream_split_across_catch_ups_frames_as_it_does_in_one() {
            let exchange = [rtu("01044DE20002"), rtu("010404012C0000")];
            let mut line = vec![0x01, 0x03, 0x40];
            line.extend(exchange.iter().cycle().take(6).flatten());
            let line = stamped(&line);
            let one_run = frame_messages(&line, &config("modbus_rtu"), None).unwrap().0;
            assert_eq!(one_run.len(), 6);

            for split in 1..line.len() {
                let mut framing = Framing::new(config("modbus_rtu"), None).unwrap();
                let mut passed = framing.feed(0, &line[..split]).0;
                passed.extend(framing.feed(split, &line[split..]).0);
                passed.extend(framing.flush().0);
                assert_eq!(rows(&passed), rows(&one_run), "split at byte {split}");
            }
        }

        #[test]
        fn the_fallback_frame_id_counts_on_across_catch_ups() {
            let line = stamped(b"AB\nCD\nEF\n");
            let mut framing = Framing::new(config("delimiter"), None).unwrap();
            let mut passed = framing.feed(0, &line[..4]).0;
            passed.extend(framing.feed(4, &line[4..]).0);
            assert_eq!(passed.iter().map(|m| m.frame_id).collect::<Vec<_>>(), [0, 1, 2]);
        }

        fn stored(capture_id: &str) -> Vec<(Vec<u8>, Option<bool>)> {
            let (frames, _, _) = wait(capture_store::get_capture_frames_paginated(capture_id, 0, 100)).unwrap();
            frames.into_iter().map(|m| (m.bytes, m.incomplete)).collect()
        }

        #[test]
        fn a_stopped_capture_is_framed_through_its_residue_and_reframed_when_bytes_follow() {
            let _db = crate::capture_db::use_own_database();
            let session = "s_framing_follower";
            let bytes = capture_store::create_session_capture(session, CaptureKind::Bytes, "raw".into());
            wait(capture_store::append_raw_bytes_to_capture(&bytes, stamped(b"AB\nCD")));

            let state = wait(set_capture_framing(session.into(), Some(config("delimiter")))).unwrap().unwrap();
            assert_eq!((state.frame_count, state.protocol.as_deref()), (2, Some("serial")));
            assert_eq!(stored(&state.framed_capture_id), [(b"AB".to_vec(), None), (b"CD".to_vec(), Some(true))]);

            wait(capture_store::append_raw_bytes_to_capture(&bytes, stamped(b"E\n")));
            let slot = follower_slot(session).unwrap();
            wait(step(slot.clone(), session, false));
            let after = slot.try_lock().unwrap().as_ref().unwrap().state.clone();
            assert_eq!((after.framed_capture_id.as_str(), after.frame_count), (state.framed_capture_id.as_str(), 2));
            assert_eq!(stored(&after.framed_capture_id), [(b"AB".to_vec(), None), (b"CDE".to_vec(), None)]);

            assert_eq!(wait(set_capture_framing(session.into(), None)), Ok(None));
            assert!(slot.try_lock().unwrap().is_none());
            assert_eq!(capture_store::get_capture_kind(&after.framed_capture_id), None);
            drop_follower(session);
        }

        #[test]
        fn a_finish_spawned_before_the_session_is_destroyed_still_frames_the_tail() {
            let _db = crate::capture_db::use_own_database();
            let session = "s_framing_destroyed";
            let bytes = capture_store::create_session_capture(session, CaptureKind::Bytes, "raw".into());
            wait(capture_store::append_raw_bytes_to_capture(&bytes, stamped(b"AB\n")));
            let state = wait(set_capture_framing(session.into(), Some(config("delimiter")))).unwrap().unwrap();

            let slot = follower_slot(session).unwrap();
            // As on a live line, where the stream end is the first flush.
            slot.try_lock().unwrap().as_mut().unwrap().flushed = false;
            wait(capture_store::append_raw_bytes_to_capture(&bytes, stamped(b"CD\nE")));
            capture_store::orphan_captures_for_session(session);
            drop_follower(session);
            wait(step(slot, session, true));
            assert_eq!(
                stored(&state.framed_capture_id),
                [(b"AB".to_vec(), None), (b"CD".to_vec(), None), (b"E".to_vec(), Some(true))]
            );
        }

        #[test]
        fn short_frames_go_to_a_filtered_capture_derived_when_the_first_arrives() {
            let _db = crate::capture_db::use_own_database();
            let session = "s_framing_filtered";
            let bytes = capture_store::create_session_capture(session, CaptureKind::Bytes, "raw".into());
            wait(capture_store::append_raw_bytes_to_capture(&bytes, stamped(b"ABC\n")));
            let config = BackendFramingConfig { min_length: Some(2), ..config("delimiter") };

            let state = wait(set_capture_framing(session.into(), Some(config.clone()))).unwrap().unwrap();
            assert_eq!((state.frame_count, state.filtered_capture_id.as_deref()), (1, None));

            wait(capture_store::append_raw_bytes_to_capture(&bytes, stamped(b"D\n")));
            let slot = follower_slot(session).unwrap();
            wait(step(slot.clone(), session, false));
            let after = slot.try_lock().unwrap().as_ref().unwrap().state.clone();
            assert_eq!((after.frame_count, after.filtered_count), (1, 1));
            assert_eq!(stored(after.filtered_capture_id.as_deref().unwrap()), [(b"D".to_vec(), None)]);
            drop_follower(session);
        }

        fn id_config(start_byte: i32, num_bytes: u8, big_endian: bool) -> Option<FrameIdConfig> {
            Some(FrameIdConfig {
                start_byte,
                num_bytes,
                big_endian,
            })
        }

        fn frame_id(frame: &[u8], config: Option<FrameIdConfig>) -> Option<u32> {
            extract_serial_ids(vec![frame.to_vec()], config, None)[0].frame_id
        }

        #[test]
        fn serial_ids_read_both_fields_from_each_frame() {
            let ids = extract_serial_ids(
                vec![vec![0x12, 0x34, 0x56], vec![0xAB, 0xCD, 0xEF]],
                id_config(0, 2, false),
                id_config(-1, 1, true),
            );
            let pairs: Vec<_> = ids.iter().map(|i| (i.frame_id, i.source_address)).collect();
            assert_eq!(
                pairs,
                vec![(Some(0x3412), Some(0x56)), (Some(0xCDAB), Some(0xEF))]
            );
        }

        #[test]
        fn a_serial_id_the_frame_cannot_hold_is_none() {
            assert_eq!(frame_id(&[0x12], id_config(0, 2, true)), None);
            assert_eq!(frame_id(&[0x12], id_config(1, 1, true)), None);
            assert_eq!(frame_id(&[0x12], None), None);
        }

        #[test]
        fn a_serial_id_wider_than_two_bytes_is_none() {
            assert_eq!(frame_id(&[1, 2, 3, 4], id_config(0, 4, false)), None);
        }

        #[test]
        fn a_negative_start_past_the_front_reads_from_the_first_byte() {
            assert_eq!(frame_id(&[0x12, 0x34], id_config(-5, 1, true)), Some(0x12));
        }

        #[test]
        fn a_framing_that_frames_every_byte_is_refused() {
            let line = stamped(b"AB\nCD\n");
            let mut empty = config("delimiter");
            empty.framing.delimiter = Some(String::new());
            let err = frame_messages(&line, &empty, None).unwrap_err();
            assert!(err.contains("delimiter"), "{err}");

            for mode in ["delimiter", "slip"] {
                let mut zero = config(mode);
                zero.per_interface = Some([(0, InterfaceFramingConfig {
                    max_length: Some(0),
                    ..config(mode).framing
                })].into());
                let err = frame_messages(&line, &zero, None).unwrap_err();
                assert!(err.contains("max_frame_length"), "{mode}: {err}");
            }
        }

        #[test]
        fn a_delimited_message_is_stamped_at_its_delimiter() {
            assert_eq!(stamps(&stamped(b"AB\nCDE\n"), &config("delimiter")), vec![1_020, 1_060]);
        }

        /// `raw` once meant *delimiter on LF* here and *no framing* at the port.
        /// It means no framing everywhere now, which leaves nothing to apply.
        #[test]
        fn raw_is_the_byte_stream_not_a_framing_to_apply() {
            let err = frame_messages(&stamped(b"AB\n"), &config("raw"), None).unwrap_err();
            assert!(err.contains("Raw"), "{err}");
        }

        #[test]
        fn a_framing_no_framer_implements_is_refused_on_the_wire() {
            for mode in ["cobs", "length_prefixed"] {
                let wire = serde_json::json!({ "mode": mode });
                let err = serde_json::from_value::<BackendFramingConfig>(wire).err().unwrap();
                assert!(err.to_string().contains(mode), "{err}");
            }
        }
    }
}

#[cfg(not(target_os = "ios"))]
pub use desktop::*;
