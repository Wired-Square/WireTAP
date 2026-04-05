// io/multi_source/merge.rs
//
// Merge task that spawns sub-readers and combines their frames/bytes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::mpsc;

use std::collections::HashMap;
use std::sync::Mutex;
use super::spawner::run_source_reader;
use super::types::{SourceConfig, TransmitChannels};
use super::{MergeCommand, VirtualBusCommand, VirtualBusControls, VirtualCmdTx};
use crate::settings;
use crate::capture_store::{self, TimestampedByte};
use crate::io::types::SourceMessage;
use crate::io::{emit_device_connected, emit_session_error, emit_stream_ended, signal_bytes_ready, signal_frames_ready, FrameMessage, SignalThrottle};

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
    app: AppHandle,
    session_id: String,
    sources: Vec<SourceConfig>,
    _emits_raw_bytes: bool,
    _bytes_buffer_id: Option<String>,
    stop_flag: Arc<AtomicBool>,
    _pause_flag: Arc<AtomicBool>,
    mut rx: mpsc::Receiver<SourceMessage>,
    tx: mpsc::Sender<SourceMessage>,
    transmit_channels: TransmitChannels,
    virtual_bus_controls: VirtualBusControls,
    mut merge_cmd_rx: mpsc::UnboundedReceiver<MergeCommand>,
    virtual_cmd_txs: Arc<Mutex<HashMap<usize, VirtualCmdTx>>>,
) {
    // Load settings to get profile configurations
    let settings = match settings::load_settings(app.clone()).await {
        Ok(s) => s,
        Err(e) => {
            tlog!("[MultiSourceReader] Failed to load settings: {}", e);
            emit_stream_ended(&session_id, "error", "MultiSourceReader");
            return;
        }
    };

    // Spawn a sub-reader task for each source
    let mut source_handles = Vec::new();
    let mut next_source_idx = sources.len();
    // Per-source stop flags for hot-remove
    let mut source_stop_flags: HashMap<String, Arc<AtomicBool>> = HashMap::new();
    // Per-source pause flags for pause/resume polling
    let mut source_pause_flags: HashMap<String, Arc<AtomicBool>> = HashMap::new();
    for (index, source_config) in sources.iter().enumerate() {
        let profile = match settings.io_profiles.iter().find(|p| p.id == source_config.profile_id) {
            Some(p) => p.clone(),
            None => {
                tlog!(
                    "[MultiSourceReader] Profile '{}' not found",
                    source_config.profile_id
                );
                continue;
            }
        };

        let source_stop = Arc::new(AtomicBool::new(false));
        source_stop_flags.insert(source_config.profile_id.clone(), source_stop.clone());
        let source_pause = Arc::new(AtomicBool::new(false));
        source_pause_flags.insert(source_config.profile_id.clone(), source_pause.clone());

        let handle = spawn_source(
            index,
            source_config,
            &profile,
            source_stop,
            source_pause,
            &app,
            &session_id,
            &stop_flag,
            &tx,
            &virtual_bus_controls,
            &virtual_cmd_txs,
        );

        source_handles.push(handle);
    }

    // Track which sources are still active
    let mut active_sources = sources.len();
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
        // All sources ended and no commands pending
        if active_sources == 0 {
            break;
        }

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
                        tlog!("[MultiSourceReader] Source {} ended: {}", source_idx, reason);
                        if let Ok(mut channels) = transmit_channels.lock() {
                            channels.remove(&source_idx);
                        }
                        active_sources = active_sources.saturating_sub(1);
                    }
                    Some(SourceMessage::Error(source_idx, error)) => {
                        tlog!("[MultiSourceReader] Source {} error: {}", source_idx, error);
                        if let Ok(mut channels) = transmit_channels.lock() {
                            channels.remove(&source_idx);
                        }
                        emit_session_error(&session_id, error);
                        active_sources = active_sources.saturating_sub(1);
                    }
                    Some(SourceMessage::TransmitReady(source_idx, tx_sender)) => {
                        tlog!("[MultiSourceReader] Source {} transmit channel ready", source_idx);
                        if let Ok(mut channels) = transmit_channels.lock() {
                            channels.insert(source_idx, tx_sender);
                        }
                    }
                    Some(SourceMessage::Connected(source_idx, device_type, address, bus_number)) => {
                        tlog!("[MultiSourceReader] Source {} connected: {} at {}", source_idx, device_type, address);
                        emit_device_connected(&session_id, &device_type, &address, bus_number);
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
                        let idx = next_source_idx;
                        next_source_idx += 1;
                        let profile = match settings.io_profiles.iter().find(|p| p.id == source_config.profile_id) {
                            Some(p) => p.clone(),
                            None => {
                                tlog!("[MultiSourceReader] Hot-add: profile '{}' not found", source_config.profile_id);
                                continue;
                            }
                        };
                        let source_stop = Arc::new(AtomicBool::new(false));
                        source_stop_flags.insert(source_config.profile_id.clone(), source_stop.clone());
                        let source_pause = Arc::new(AtomicBool::new(false));
                        source_pause_flags.insert(source_config.profile_id.clone(), source_pause.clone());
                        let handle = spawn_source(
                            idx,
                            &source_config,
                            &profile,
                            source_stop,
                            source_pause,
                            &app,
                            &session_id,
                            &stop_flag,
                            &tx,
                            &virtual_bus_controls,
                            &virtual_cmd_txs,
                        );
                        source_handles.push(handle);
                        active_sources += 1;
                        tlog!("[MultiSourceReader] Hot-added source {} (profile '{}')", idx, source_config.profile_id);
                    }
                    Some(MergeCommand::RemoveSource(profile_id)) => {
                        if let Some(flag) = source_stop_flags.get(&profile_id) {
                            flag.store(true, Ordering::SeqCst);
                            tlog!("[MultiSourceReader] Hot-removing source (profile '{}')", profile_id);
                        } else {
                            tlog!("[MultiSourceReader] Hot-remove: profile '{}' not found in stop flags", profile_id);
                        }
                        // The source reader will send Ended, which decrements active_sources
                    }
                    Some(MergeCommand::PauseSource(profile_id)) => {
                        if let Some(flag) = source_pause_flags.get(&profile_id) {
                            flag.store(true, Ordering::Relaxed);
                            tlog!("[MultiSourceReader] Paused source polling (profile '{}')", profile_id);
                        }
                    }
                    Some(MergeCommand::ResumeSource(profile_id)) => {
                        if let Some(flag) = source_pause_flags.get(&profile_id) {
                            flag.store(false, Ordering::Relaxed);
                            tlog!("[MultiSourceReader] Resumed source polling (profile '{}')", profile_id);
                        }
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

        // Periodically log frames per bus (every 5 seconds)
        if last_bus_log.elapsed().as_secs() >= BUS_LOG_INTERVAL_SECS && !frames_per_bus.is_empty() {
            let mut bus_counts: Vec<_> = frames_per_bus.iter().collect();
            bus_counts.sort_by_key(|(bus, _)| *bus);
            let counts_str: Vec<String> = bus_counts
                .iter()
                .map(|(bus, count)| format!("bus {}: {}", bus, count))
                .collect();
            tlog!(
                "[MultiSourceReader] Frame counts per bus: {}",
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

    // Emit stream ended
    let reason = if stop_flag.load(Ordering::SeqCst) {
        "stopped"
    } else {
        "complete"
    };
    emit_stream_ended(&session_id, reason, "MultiSourceReader");
}

/// Spawn a single source reader task. Creates a virtual command channel for virtual sources.
#[allow(clippy::too_many_arguments)]
fn spawn_source(
    index: usize,
    source_config: &SourceConfig,
    profile: &crate::settings::IOProfile,
    source_stop: Arc<AtomicBool>,
    source_pause: Arc<AtomicBool>,
    app: &AppHandle,
    session_id: &str,
    stop_flag: &Arc<AtomicBool>,
    tx: &mpsc::Sender<SourceMessage>,
    virtual_bus_controls: &VirtualBusControls,
    virtual_cmd_txs: &Arc<Mutex<HashMap<usize, VirtualCmdTx>>>,
) -> tokio::task::JoinHandle<()> {
    let app_clone = app.clone();
    let session_id_clone = session_id.to_string();
    let stop_flag_clone = stop_flag.clone();
    let source_stop_clone = source_stop;
    let source_pause_clone = source_pause;
    let tx_clone = tx.clone();
    let bus_mappings = source_config.bus_mappings.clone();
    let display_name = source_config.display_name.clone();
    let framing_encoding = source_config.framing_encoding.clone();
    let delimiter = source_config.delimiter.clone();
    let max_frame_length = source_config.max_frame_length;
    let min_frame_length = source_config.min_frame_length;
    let emit_raw_bytes = source_config.emit_raw_bytes;
    let frame_id_start_byte = source_config.frame_id_start_byte;
    let frame_id_bytes = source_config.frame_id_bytes;
    let frame_id_big_endian = source_config.frame_id_big_endian;
    let source_address_start_byte = source_config.source_address_start_byte;
    let source_address_bytes = source_config.source_address_bytes;
    let source_address_big_endian = source_config.source_address_big_endian;
    let modbus_polls = source_config.modbus_polls.clone();
    let modbus_role = source_config.modbus_role.clone();
    let max_register_errors = source_config.max_register_errors;
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
            app_clone,
            session_id_clone,
            index,
            profile,
            bus_mappings,
            display_name,
            framing_encoding,
            delimiter,
            max_frame_length,
            min_frame_length,
            emit_raw_bytes,
            frame_id_start_byte,
            frame_id_bytes,
            frame_id_big_endian,
            source_address_start_byte,
            source_address_bytes,
            source_address_big_endian,
            modbus_polls,
            modbus_role,
            max_register_errors,
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
