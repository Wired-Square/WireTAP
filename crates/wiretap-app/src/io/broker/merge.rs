// io/broker/merge.rs
//
// Merge task that spawns sub-readers and combines their frames/bytes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

use std::collections::HashMap;
use std::sync::Mutex;
use super::spawner::run_source_reader;
use super::types::{ControlChannels, SourceConfig, SourcePauseFlags, TransmitChannels};
use super::{MergeCommand, ProfileLoader, VirtualBusCommand, VirtualBusControls, VirtualCmdTx};
use crate::capture_store::{self, TimestampedByte};
use crate::io::error::IoError;
use crate::io::bus_mapping::BusMapping;
use crate::io::types::SourceMessage;
use crate::io::{emit_device_connected, emit_session_error, emit_stream_ended, signal_bytes_ready, signal_frames_ready, take_startup_error, FrameMessage, SignalThrottle, StreamEndReason};

/// Who a source index belongs to, for the two things that have to name a source
/// after it has started: reconciled bus mappings (by profile) and a disconnect
/// error (by the name the user gave the device).
struct SourceIdentity {
    profile_id: String,
    display_name: String,
}

impl SourceIdentity {
    fn of(config: &SourceConfig) -> Self {
        Self {
            profile_id: config.profile_id.clone(),
            display_name: config.display_name.clone(),
        }
    }
}

/// Make a source's pause flag and publish it in the shared map, so the broker can
/// report whether the source is paused without reaching into this task.
fn register_pause_flag(flags: &SourcePauseFlags, profile_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = flags.lock() {
        map.insert(profile_id.to_string(), flag.clone());
    }
    flag
}

/// Set or clear one source's pause flag, logging what happened either way.
fn set_pause_flag(flags: &SourcePauseFlags, profile_id: &str, paused: bool) {
    let verb = if paused { "Paused" } else { "Resumed" };
    match flags.lock().ok().and_then(|map| map.get(profile_id).cloned()) {
        Some(flag) => {
            flag.store(paused, Ordering::Relaxed);
            tlog!("[IOBroker] {} source polling (profile '{}')", verb, profile_id);
        }
        None => tlog!("[IOBroker] {}: profile '{}' has no pause flag", verb, profile_id),
    }
}

/// Forget a departing source's pause flag.
///
/// The map is published through `ActiveSessionInfo` and rendered by the poll
/// switch, so a hot-removed source left in it reports a device that is no longer
/// there as paused.
fn forget_pause_flag(flags: &SourcePauseFlags, profile_id: &str) {
    if let Ok(mut map) = flags.lock() {
        map.remove(profile_id);
    }
}

/// Minimum pending frames before emission.
const FRAME_BATCH_THRESHOLD: usize = 100;
/// Minimum pending bytes before emission.
const BYTE_BATCH_THRESHOLD: usize = 256;
/// Maximum time (ms) between forced emissions.
const MERGE_EMIT_INTERVAL_MS: u64 = 50;
/// Interval (s) between per-bus frame count log messages.
const BUS_LOG_INTERVAL_SECS: u64 = 5;

/// Main merge task that spawns sub-readers and combines their frames/bytes
pub(super) async fn run_merge_task(
    profiles: ProfileLoader,
    session_id: String,
    sources: Vec<SourceConfig>,
    _bytes_capture_id: Option<String>,
    stop_flag: Arc<AtomicBool>,
    _pause_flag: Arc<AtomicBool>,
    mut rx: mpsc::Receiver<SourceMessage>,
    tx: mpsc::Sender<SourceMessage>,
    transmit_channels: TransmitChannels,
    control_channels: ControlChannels,
    virtual_bus_controls: VirtualBusControls,
    mut merge_cmd_rx: mpsc::UnboundedReceiver<MergeCommand>,
    virtual_cmd_txs: Arc<Mutex<HashMap<usize, VirtualCmdTx>>>,
    fatal_error: Arc<Mutex<Option<String>>>,
    resolved_mappings: Arc<Mutex<HashMap<String, Vec<BusMapping>>>>,
    source_pause_flags: SourcePauseFlags,
    started: oneshot::Sender<Result<(), String>>,
) {
    let mut start = StartReport::new(started, 0..sources.len());
    // Profiles for the initial spawn only — hot-adds re-read, since they exist
    // to pick up a profile that has changed. Dropped after the loop so a
    // long-lived session does not retain them.
    let io_profiles = match profiles() {
        Ok(p) => p,
        Err(e) => {
            tlog!("[IOBroker] Failed to load settings: {}", e);
            start.send(Err(e));
            emit_stream_ended(&session_id, StreamEndReason::Error, "IOBroker");
            return;
        }
    };

    // Spawn a sub-reader task for each source
    let mut source_handles = Vec::new();
    let mut next_source_idx = sources.len();
    // Per-source stop flags for hot-remove
    let mut source_stop_flags: HashMap<String, Arc<AtomicBool>> = HashMap::new();
    // A reader identifies itself by source index; everything that has to
    // survive a hot add/remove is keyed by profile id, because `next_source_idx`
    // only ever grows while the broker's `sources` vec is compacted on removal.
    // The display name rides along because `sources` cannot be indexed by a
    // hot-added source's index.
    let mut source_profiles: HashMap<usize, SourceIdentity> = HashMap::new();
    for (index, source_config) in sources.iter().enumerate() {
        let profile = match io_profiles.iter().find(|p| p.id == source_config.profile_id) {
            Some(p) => p.clone(),
            None => {
                let error = format!("Profile '{}' not found", source_config.profile_id);
                tlog!("[IOBroker] {}", error);
                start.failed(index, error);
                continue;
            }
        };

        let source_stop = Arc::new(AtomicBool::new(false));
        source_stop_flags.insert(source_config.profile_id.clone(), source_stop.clone());
        let source_pause = register_pause_flag(&source_pause_flags, &source_config.profile_id);
        source_profiles.insert(index, SourceIdentity::of(source_config));

        let handle = spawn_source(
            index,
            source_config,
            &profile,
            source_stop,
            source_pause,
            &session_id,
            &stop_flag,
            &tx,
            &virtual_bus_controls,
            &virtual_cmd_txs,
        );

        source_handles.push(handle);
    }

    let mut live = LiveSources::new(source_profiles.keys().copied());
    let mut pending_readds = PendingReadds::default();
    // The last error a source reported, kept so the session can end as "error"
    // rather than "complete" when every source has failed.
    let mut last_source_error: Option<String> = None;
    let mut interrupted: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut pending_frames: Vec<FrameMessage> = Vec::new();
    let mut pending_bytes: Vec<TimestampedByte> = Vec::new();
    let mut last_emit = std::time::Instant::now();
    let mut throttle = SignalThrottle::new();

    // Track frames per bus for periodic logging
    let mut frames_per_bus: std::collections::HashMap<u8, usize> = std::collections::HashMap::new();
    let mut last_bus_log = std::time::Instant::now();

    // Main merge loop — uses select! to handle both source messages and commands
    let emit_interval = std::time::Duration::from_millis(MERGE_EMIT_INTERVAL_MS);
    loop {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }
        if live.is_empty() {
            break;
        }

        let mut ready_to_add: Option<SourceConfig> = None;
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Some(SourceMessage::Frames(_source_idx, frames)) => {
                        for frame in &frames {
                            *frames_per_bus.entry(frame.bus).or_insert(0) += 1;
                        }
                        pending_frames.extend(frames);
                    }
                    Some(SourceMessage::Bytes(_source_idx, raw_entries)) => {
                        for entry in raw_entries {
                            pending_bytes.push(TimestampedByte {
                                byte: entry.byte,
                                timestamp_us: entry.timestamp_us,
                                bus: entry.bus,
                            });
                        }
                    }
                    Some(SourceMessage::Ended(source_idx, reason)) => {
                        tlog!("[IOBroker] Source {} ended: {}", source_idx, reason);
                        if let Ok(mut channels) = transmit_channels.lock() {
                            channels.remove(&source_idx);
                        }
                        // An ending nobody asked for is a fault, and has to be
                        // reported like one — a device pulled mid-session used to
                        // finish the run as "complete".
                        if reason.is_fault() {
                            let device = source_profiles
                                .get(&source_idx)
                                .map(|s| s.display_name.clone())
                                .unwrap_or_else(|| format!("source {}", source_idx));
                            let error = IoError::DeviceDisconnected { device }.to_string();
                            last_source_error = Some(error.clone());
                            emit_session_error(&session_id, error.clone());
                            start.failed(source_idx, error);
                        } else {
                            start.ready(source_idx);
                        }
                        live.end(source_idx);
                        ready_to_add = pending_readds.source_ended(source_idx);
                    }
                    Some(SourceMessage::Error(source_idx, error)) => {
                        tlog!("[IOBroker] Source {} error: {}", source_idx, error);
                        if let Ok(mut channels) = transmit_channels.lock() {
                            channels.remove(&source_idx);
                        }
                        last_source_error = Some(error.clone());
                        emit_session_error(&session_id, error.clone());
                        start.failed(source_idx, error);
                        live.end(source_idx);
                        ready_to_add = pending_readds.source_ended(source_idx);
                    }
                    Some(SourceMessage::Interrupted(source_idx, error)) => {
                        tlog!("[IOBroker] Source {} interrupted: {}", source_idx, error);
                        interrupted.insert(source_idx);
                        emit_session_error(&session_id, error);
                        start.ready(source_idx);
                    }
                    Some(SourceMessage::TransmitReady(source_idx, tx_sender)) => {
                        tlog!("[IOBroker] Source {} transmit channel ready", source_idx);
                        if let Ok(mut channels) = transmit_channels.lock() {
                            channels.insert(source_idx, tx_sender);
                        }
                        start.ready(source_idx);
                    }
                    Some(SourceMessage::ControlReady(source_idx, control_sender)) => {
                        tlog!("[IOBroker] Source {} control channel ready", source_idx);
                        if let Ok(mut channels) = control_channels.lock() {
                            channels.insert(source_idx, control_sender);
                        }
                    }
                    Some(SourceMessage::Connected(source_idx, device_type, address, bus_number)) => {
                        tlog!("[IOBroker] Source {} connected: {} at {}", source_idx, device_type, address);
                        emit_device_connected(&session_id, &device_type, &address, bus_number);
                        start.ready(source_idx);
                        // The session error left the frontend in its error state;
                        // the session never left its own, so send that again.
                        if interrupted.remove(&source_idx) {
                            let session_id = session_id.clone();
                            tokio::spawn(async move {
                                take_startup_error(&session_id);
                                if let Some(state) = crate::io::get_session_state(&session_id).await {
                                    crate::ws::dispatch::send_session_state(&session_id, &state);
                                }
                            });
                        }
                    }
                    Some(SourceMessage::MappingsResolved(source_idx, mappings)) => {
                        tlog!(
                            "[IOBroker] Source {} resolved {} bus mapping(s) from the device: {:?}",
                            source_idx,
                            mappings.len(),
                            mappings
                                .iter()
                                .filter(|m| m.enabled)
                                .map(|m| (m.device_bus, m.output_bus))
                                .collect::<Vec<_>>()
                        );
                        // Compare on what capabilities and routing actually read,
                        // so a re-send of the same set does not churn the frontend.
                        let routable = |ms: &[BusMapping]| -> Vec<(u8, u8)> {
                            ms.iter().filter(|m| m.enabled).map(|m| (m.device_bus, m.output_bus)).collect()
                        };
                        let Some(profile_id) =
                            source_profiles.get(&source_idx).map(|s| s.profile_id.clone())
                        else {
                            tlog!("[IOBroker] Source {} resolved mappings but is unknown", source_idx);
                            continue;
                        };
                        let changed = resolved_mappings
                            .lock()
                            .map(|mut resolved| {
                                let before = resolved.get(&profile_id).map(|ms| routable(ms));
                                let after = routable(&mappings);
                                resolved.insert(profile_id, mappings);
                                before.as_ref() != Some(&after)
                            })
                            .unwrap_or(false);
                        // Capabilities are read off the session, which this task
                        // does not hold — and taking that lock here could sit
                        // behind a command waiting on this very loop. Hand the
                        // re-emit to a detached task instead.
                        if changed {
                            let session_id = session_id.clone();
                            tokio::spawn(async move {
                                crate::io::refresh_session_capabilities(&session_id).await;
                            });
                        }
                    }
                    None => {
                        // Channel closed
                        break;
                    }
                }
            }
            cmd = merge_cmd_rx.recv() => {
                match cmd {
                    Some(MergeCommand::AddSource(source_config)) => {
                        ready_to_add = pending_readds.add(source_config);
                    }
                    Some(MergeCommand::RemoveSource(profile_id)) => {
                        let running = source_profiles
                            .iter()
                            .find(|(idx, s)| s.profile_id == profile_id && live.contains(**idx));
                        if let Some((&idx, _)) = running {
                            pending_readds.removing(idx, profile_id.clone());
                        }
                        if let Some(flag) = source_stop_flags.remove(&profile_id) {
                            flag.store(true, Ordering::SeqCst);
                            tlog!("[IOBroker] Hot-removing source (profile '{}')", profile_id);
                        } else {
                            tlog!("[IOBroker] Hot-remove: profile '{}' not found in stop flags", profile_id);
                        }
                        forget_pause_flag(&source_pause_flags, &profile_id);
                        // The source reader will send Ended, which counts it out
                    }
                    Some(MergeCommand::PauseSource(profile_id)) => {
                        set_pause_flag(&source_pause_flags, &profile_id, true);
                    }
                    Some(MergeCommand::ResumeSource(profile_id)) => {
                        set_pause_flag(&source_pause_flags, &profile_id, false);
                    }
                    None => {
                        // Command channel closed — session ending
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(emit_interval) => {
                // Periodic wakeup for batch emission
            }
        }

        if let Some(source_config) = ready_to_add {
            let idx = next_source_idx;
            next_source_idx += 1;
            // Re-read rather than using the profiles loaded at task
            // start: a source is hot-added to pick up a profile that
            // has *changed* — reconfiguring a live device's bitrate
            // or baud rate is a remove-then-add of that source — so
            // the original copy would respawn the device on exactly
            // the settings the user just replaced.
            let fresh = match profiles() {
                Ok(p) => p,
                Err(e) => {
                    tlog!("[IOBroker] Hot-add: failed to reload settings: {}", e);
                    continue;
                }
            };
            let Some(profile) = fresh
                .into_iter()
                .find(|p| p.id == source_config.profile_id)
            else {
                tlog!("[IOBroker] Hot-add: profile '{}' not found", source_config.profile_id);
                continue;
            };
            let source_stop = Arc::new(AtomicBool::new(false));
            source_stop_flags.insert(source_config.profile_id.clone(), source_stop.clone());
            let source_pause =
                register_pause_flag(&source_pause_flags, &source_config.profile_id);
            source_profiles.insert(idx, SourceIdentity::of(&source_config));
            // A re-added source re-reconciles once it connects; drop
            // the previous answer so a stale one is never served.
            if let Ok(mut resolved) = resolved_mappings.lock() {
                resolved.remove(&source_config.profile_id);
            }
            let handle = spawn_source(
                idx,
                &source_config,
                &profile,
                source_stop,
                source_pause,
                &session_id,
                &stop_flag,
                &tx,
                &virtual_bus_controls,
                &virtual_cmd_txs,
            );
            source_handles.push(handle);
            live.add(idx);
            tlog!("[IOBroker] Hot-added source {} (profile '{}')", idx, source_config.profile_id);
        }

        // Periodically log frames per bus (every 5 seconds)
        if last_bus_log.elapsed().as_secs() >= BUS_LOG_INTERVAL_SECS && !frames_per_bus.is_empty() {
            let mut bus_counts: Vec<_> = frames_per_bus.iter().collect();
            bus_counts.sort_by_key(|(bus, _)| *bus);
            let counts_str: Vec<String> = bus_counts
                .iter()
                .map(|(bus, count)| format!("bus {}: {}", bus, count))
                .collect();
            tlog!(
                "[IOBroker] Frame counts per bus: {}",
                counts_str.join(", ")
            );
            last_bus_log = std::time::Instant::now();
        }

        // Emit data if we have any and either:
        // - We have a decent batch (>= 100 items)
        // - It's been more than 50ms since last emit
        let should_emit = last_emit.elapsed().as_millis() >= MERGE_EMIT_INTERVAL_MS as u128
            || pending_frames.len() >= FRAME_BATCH_THRESHOLD
            || pending_bytes.len() >= BYTE_BATCH_THRESHOLD;

        if should_emit {
            if !pending_frames.is_empty() {
                pending_frames.sort_by_key(|f| f.timestamp_us);
                capture_store::append_frames_to_session(&session_id, pending_frames);
                pending_frames = Vec::new();
                if throttle.should_signal("frames-ready") {
                    signal_frames_ready(&session_id);
                }
            }

            if !pending_bytes.is_empty() {
                pending_bytes.sort_by_key(|b| b.timestamp_us);
                capture_store::append_raw_bytes_to_session(&session_id, pending_bytes);
                pending_bytes = Vec::new();
                if throttle.should_signal("bytes-ready") {
                    signal_bytes_ready(&session_id);
                }
            }

            last_emit = std::time::Instant::now();
        }
    }

    // Store and signal any remaining frames
    if !pending_frames.is_empty() {
        pending_frames.sort_by_key(|f| f.timestamp_us);
        capture_store::append_frames_to_session(&session_id, pending_frames);
        throttle.flush();
        signal_frames_ready(&session_id);
    }

    // Store and signal any remaining bytes
    if !pending_bytes.is_empty() {
        pending_bytes.sort_by_key(|b| b.timestamp_us);
        capture_store::append_raw_bytes_to_session(&session_id, pending_bytes);
        throttle.flush();
        signal_bytes_ready(&session_id);
    }

    // Wait for all source tasks to finish
    for handle in source_handles {
        let _ = handle.await;
    }

    // Emit stream ended. A run that lost every source to an error is not
    // "complete" — that reported a clean finish for a session which may never
    // have carried a frame, and left the backend claiming Running while only
    // the frontend knew otherwise.
    let reason = stream_ended_reason(stop_flag.load(Ordering::SeqCst), last_source_error.is_some());
    // Only a run that *ended* in error is a failed session. A source that
    // dropped hours ago must not turn a deliberate stop into one — it was
    // reported at the time, via emit_session_error.
    if reason == StreamEndReason::Error {
        if let (Some(error), Ok(mut slot)) = (last_source_error, fatal_error.lock()) {
            slot.get_or_insert(error);
        }
    }
    emit_stream_ended(&session_id, reason, "IOBroker");
}

/// Spawn a single source reader task. Creates a virtual command channel for virtual sources.
#[allow(clippy::too_many_arguments)]
fn spawn_source(
    index: usize,
    source_config: &SourceConfig,
    profile: &crate::settings::IOProfile,
    source_stop: Arc<AtomicBool>,
    source_pause: Arc<AtomicBool>,
    session_id: &str,
    stop_flag: &Arc<AtomicBool>,
    tx: &mpsc::Sender<SourceMessage>,
    virtual_bus_controls: &VirtualBusControls,
    virtual_cmd_txs: &Arc<Mutex<HashMap<usize, VirtualCmdTx>>>,
) -> tokio::task::JoinHandle<()> {
    let session_id_clone = session_id.to_string();
    let stop_flag_clone = stop_flag.clone();
    let source_stop_clone = source_stop;
    let source_pause_clone = source_pause;
    let tx_clone = tx.clone();
    let config = source_config.clone();
    let virtual_bus_controls_clone = virtual_bus_controls.clone();
    let profile = profile.clone();

    // Create virtual command channel for virtual sources
    let virtual_cmd_rx = if profile.kind == "virtual" {
        let (vtx, vrx) = mpsc::unbounded_channel::<VirtualBusCommand>();
        if let Ok(mut txs) = virtual_cmd_txs.lock() {
            txs.insert(index, vtx);
        }
        Some(vrx)
    } else {
        None
    };

    tokio::spawn(async move {
        // Combine global stop flag with per-source stop flag
        let combined_stop = Arc::new(AtomicBool::new(false));
        let combined = combined_stop.clone();
        let global = stop_flag_clone.clone();
        let source = source_stop_clone.clone();
        // Spawn a tiny monitor task that sets combined_stop when either flag is set
        let monitor = tokio::spawn(async move {
            loop {
                if global.load(Ordering::Relaxed) || source.load(Ordering::Relaxed) {
                    combined.store(true, Ordering::SeqCst);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        });

        run_source_reader(
            session_id_clone,
            index,
            profile,
            config,
            combined_stop,
            source_pause_clone,
            tx_clone,
            virtual_bus_controls_clone,
            virtual_cmd_rx,
        )
        .await;

        monitor.abort();
    })
}

/// Why a session's stream ended, from the two facts the merge loop knows when
/// it exits: whether a stop was asked for, and whether any source failed.
///
/// A run in which every source errored used to report `complete` — a clean
/// finish for a session that never carried a frame.
fn stream_ended_reason(stopped: bool, had_error: bool) -> StreamEndReason {
    match (stopped, had_error) {
        (true, _) => StreamEndReason::Stopped,
        (false, true) => StreamEndReason::Error,
        (false, false) => StreamEndReason::Complete,
    }
}

/// What `IOBroker::start` waits for: the first source to come up, or every
/// source it began with failing. Hot-added sources are not waited on.
struct StartReport {
    reply: Option<oneshot::Sender<Result<(), String>>>,
    waiting: std::collections::HashSet<usize>,
    failures: Vec<String>,
}

impl StartReport {
    fn new(reply: oneshot::Sender<Result<(), String>>, indices: impl IntoIterator<Item = usize>) -> Self {
        Self { reply: Some(reply), waiting: indices.into_iter().collect(), failures: Vec::new() }
    }

    fn ready(&mut self, index: usize) {
        if self.waiting.contains(&index) {
            self.send(Ok(()));
        }
    }

    fn failed(&mut self, index: usize, error: String) {
        if self.waiting.remove(&index) {
            self.failures.push(error);
            if self.waiting.is_empty() {
                self.send(Err(self.failures.join("; ")));
            }
        }
    }

    fn send(&mut self, outcome: Result<(), String>) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(outcome);
        }
    }
}

/// The sources still running. A source that reports an error and then ends is
/// counted out once, so it cannot end the session while another source is live.
struct LiveSources(std::collections::HashSet<usize>);

impl LiveSources {
    fn new(indices: impl IntoIterator<Item = usize>) -> Self {
        Self(indices.into_iter().collect())
    }

    fn add(&mut self, index: usize) {
        self.0.insert(index);
    }

    fn end(&mut self, index: usize) {
        self.0.remove(&index);
    }

    fn contains(&self, index: usize) -> bool {
        self.0.contains(&index)
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Re-adds waiting on the source they replace. A reader closes its device only
/// after it sees its stop flag, so a re-add spawned at once would open an adapter
/// the old reader still holds.
#[derive(Default)]
struct PendingReadds {
    removing: HashMap<usize, String>,
    held: HashMap<String, SourceConfig>,
}

impl PendingReadds {
    /// Only a source still running is waited on; one that has already ended
    /// will send nothing more to release its successor.
    fn removing(&mut self, index: usize, profile_id: String) {
        self.held.remove(&profile_id);
        self.removing.insert(index, profile_id);
    }

    /// The config back if it can spawn now, `None` if it is held.
    fn add(&mut self, config: SourceConfig) -> Option<SourceConfig> {
        if self.removing.values().any(|p| *p == config.profile_id) {
            self.held.insert(config.profile_id.clone(), config);
            None
        } else {
            Some(config)
        }
    }

    fn source_ended(&mut self, index: usize) -> Option<SourceConfig> {
        let profile_id = self.removing.remove(&index)?;
        self.held.remove(&profile_id)
    }
}

#[cfg(test)]
mod tests {
    use super::{stream_ended_reason, LiveSources, PendingReadds, StartReport, StreamEndReason};
    use tokio::sync::oneshot;
    use crate::io::broker::types::SourceConfig;

    fn config(profile_id: &str) -> SourceConfig {
        SourceConfig { profile_id: profile_id.to_string(), ..Default::default() }
    }

    fn start_report(sources: usize) -> (StartReport, oneshot::Receiver<Result<(), String>>) {
        let (tx, rx) = oneshot::channel();
        (StartReport::new(tx, 0..sources), rx)
    }

    #[test]
    fn the_first_source_up_starts_the_session() {
        let (mut report, mut outcome) = start_report(2);
        report.failed(0, "COM5 is missing".into());
        assert!(outcome.try_recv().is_err());
        report.ready(1);
        assert_eq!(outcome.try_recv(), Ok(Ok(())));
    }

    #[test]
    fn a_start_fails_only_when_every_source_has() {
        let (mut report, mut outcome) = start_report(2);
        report.failed(0, "COM5 is missing".into());
        report.failed(0, "COM5 is missing".into());
        assert!(outcome.try_recv().is_err());
        report.failed(1, "COM6 is missing".into());
        assert_eq!(outcome.try_recv(), Ok(Err("COM5 is missing; COM6 is missing".into())));
    }

    #[test]
    fn a_hot_added_source_does_not_settle_the_start() {
        let (mut report, mut outcome) = start_report(1);
        report.ready(1);
        report.failed(1, "late".into());
        assert!(outcome.try_recv().is_err());
    }

    #[test]
    fn a_readd_waits_for_the_removed_source_to_end() {
        let mut pending = PendingReadds::default();
        pending.removing(0, "can".into());
        assert!(pending.add(config("can")).is_none());
        assert!(pending.source_ended(1).is_none());
        assert_eq!(pending.source_ended(0).map(|c| c.profile_id), Some("can".into()));
        assert!(pending.source_ended(0).is_none());
    }

    #[test]
    fn an_add_with_no_removal_in_flight_spawns_at_once() {
        let mut pending = PendingReadds::default();
        pending.removing(0, "can".into());
        assert!(pending.add(config("serial")).is_some());
        pending.source_ended(0);
        assert!(pending.add(config("can")).is_some());
    }

    #[test]
    fn removing_again_drops_the_held_readd() {
        let mut pending = PendingReadds::default();
        pending.removing(0, "can".into());
        pending.add(config("can"));
        pending.removing(0, "can".into());
        assert!(pending.source_ended(0).is_none());
    }

    #[test]
    fn a_source_that_errors_and_then_ends_is_counted_out_once() {
        let mut live = LiveSources::new([0, 1]);
        live.end(0);
        live.end(0);
        assert!(!live.is_empty());
        live.end(1);
        assert!(live.is_empty());
    }

    #[test]
    fn a_hot_added_source_keeps_the_session_open() {
        let mut live = LiveSources::new([0]);
        live.add(1);
        live.end(0);
        assert!(!live.is_empty());
    }

    #[test]
    fn a_deliberate_stop_outranks_a_source_error() {
        assert_eq!(stream_ended_reason(true, false), StreamEndReason::Stopped);
        assert_eq!(stream_ended_reason(true, true), StreamEndReason::Stopped);
    }

    #[test]
    fn sources_ending_in_error_is_not_a_complete_run() {
        assert_eq!(stream_ended_reason(false, true), StreamEndReason::Error);
        assert_eq!(stream_ended_reason(false, false), StreamEndReason::Complete);
    }
}
