// io/multi_source/merge.rs
//
// Merge task that spawns sub-readers and combines their frames/bytes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::mpsc;

use super::spawner::run_source_reader;
use super::types::{SourceConfig, TransmitChannels};
use crate::buffer_store::{self, TimestampedByte};
use crate::io::types::{RawBytesPayload, SourceMessage};
use crate::io::{emit_device_connected, emit_frames, emit_session_error, emit_stream_ended, emit_to_session, FrameMessage};

/// Main merge task that spawns sub-readers and combines their frames/bytes
pub(super) async fn run_merge_task(
    app: AppHandle,
    session_id: String,
    sources: Vec<SourceConfig>,
    _emits_raw_bytes: bool,
    bytes_buffer_id: Option<String>,
    stop_flag: Arc<AtomicBool>,
    mut rx: mpsc::Receiver<SourceMessage>,
    tx: mpsc::Sender<SourceMessage>,
    transmit_channels: TransmitChannels,
) {
    use crate::settings;

    // Load settings to get profile configurations
    let settings = match settings::load_settings(app.clone()).await {
        Ok(s) => s,
        Err(e) => {
            tlog!("[MultiSourceReader] Failed to load settings: {}", e);
            emit_stream_ended(&app, &session_id, "error", "MultiSourceReader");
            return;
        }
    };

    // Spawn a sub-reader task for each source
    let mut source_handles = Vec::new();
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

        let app_clone = app.clone();
        let session_id_clone = session_id.clone();
        let stop_flag_clone = stop_flag.clone();
        let tx_clone = tx.clone();
        let bus_mappings = source_config.bus_mappings.clone();
        let display_name = source_config.display_name.clone();
        let framing_encoding = source_config.framing_encoding.clone();
        let delimiter = source_config.delimiter.clone();
        let max_frame_length = source_config.max_frame_length;
        let min_frame_length = source_config.min_frame_length;
        let emit_raw_bytes = source_config.emit_raw_bytes;
        // Frame ID extraction config from session options
        let frame_id_start_byte = source_config.frame_id_start_byte;
        let frame_id_bytes = source_config.frame_id_bytes;
        let frame_id_big_endian = source_config.frame_id_big_endian;
        let source_address_start_byte = source_config.source_address_start_byte;
        let source_address_bytes = source_config.source_address_bytes;
        let source_address_big_endian = source_config.source_address_big_endian;

        let handle = tokio::spawn(async move {
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
                stop_flag_clone,
                tx_clone,
            )
            .await;
        });

        source_handles.push(handle);
    }

    // Track which sources are still active
    let mut active_sources = sources.len();
    let mut pending_frames: Vec<FrameMessage> = Vec::new();
    let mut pending_bytes: Vec<TimestampedByte> = Vec::new();
    let mut last_emit = std::time::Instant::now();

    // Track frames per bus for periodic logging
    let mut frames_per_bus: std::collections::HashMap<u8, usize> = std::collections::HashMap::new();
    let mut last_bus_log = std::time::Instant::now();

    // Main merge loop
    while !stop_flag.load(Ordering::SeqCst) && active_sources > 0 {
        // Use timeout to allow periodic emission even with slow sources
        match tokio::time::timeout(std::time::Duration::from_millis(50), rx.recv()).await {
            Ok(Some(msg)) => match msg {
                SourceMessage::Frames(_source_idx, frames) => {
                    // Track frames per bus
                    for frame in &frames {
                        *frames_per_bus.entry(frame.bus).or_insert(0) += 1;
                    }
                    pending_frames.extend(frames);
                }
                SourceMessage::Bytes(_source_idx, raw_entries) => {
                    for entry in raw_entries {
                        pending_bytes.push(TimestampedByte {
                            byte: entry.byte,
                            timestamp_us: entry.timestamp_us,
                            bus: entry.bus,
                        });
                    }
                }
                SourceMessage::Ended(source_idx, reason) => {
                    tlog!(
                        "[MultiSourceReader] Source {} ended: {}",
                        source_idx, reason
                    );
                    // Remove transmit channel for this source
                    if let Ok(mut channels) = transmit_channels.lock() {
                        channels.remove(&source_idx);
                    }
                    active_sources = active_sources.saturating_sub(1);
                }
                SourceMessage::Error(source_idx, error) => {
                    tlog!(
                        "[MultiSourceReader] Source {} error: {}",
                        source_idx, error
                    );
                    // Remove transmit channel for this source
                    if let Ok(mut channels) = transmit_channels.lock() {
                        channels.remove(&source_idx);
                    }
                    emit_session_error(&app, &session_id, error);
                    active_sources = active_sources.saturating_sub(1);
                }
                SourceMessage::TransmitReady(source_idx, tx_sender) => {
                    tlog!(
                        "[MultiSourceReader] Source {} transmit channel ready",
                        source_idx
                    );
                    if let Ok(mut channels) = transmit_channels.lock() {
                        channels.insert(source_idx, tx_sender);
                    }
                }
                SourceMessage::Connected(source_idx, device_type, address, bus_number) => {
                    tlog!(
                        "[MultiSourceReader] Source {} connected: {} at {}",
                        source_idx, device_type, address
                    );
                    emit_device_connected(&app, &session_id, &device_type, &address, bus_number);
                }
            },
            Ok(None) => {
                // Channel closed
                break;
            }
            Err(_) => {
                // Timeout - emit any pending frames
            }
        }

        // Periodically log frames per bus (every 5 seconds)
        if last_bus_log.elapsed().as_secs() >= 5 && !frames_per_bus.is_empty() {
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
        let should_emit = last_emit.elapsed().as_millis() >= 50
            || pending_frames.len() >= 100
            || pending_bytes.len() >= 256;

        if should_emit {
            // Emit frames if we have any
            if !pending_frames.is_empty() {
                // Sort by timestamp for proper ordering
                pending_frames.sort_by_key(|f| f.timestamp_us);

                // Append to buffer
                buffer_store::append_frames(pending_frames.clone());

                // Emit to frontend
                emit_frames(&app, &session_id, pending_frames);
                pending_frames = Vec::new();
            }

            // Emit raw bytes if we have any
            if !pending_bytes.is_empty() {
                // Sort by timestamp for proper ordering
                pending_bytes.sort_by_key(|b| b.timestamp_us);

                // Append to buffer (use specific bytes buffer if we have one)
                if let Some(ref buf_id) = bytes_buffer_id {
                    buffer_store::append_raw_bytes_to_buffer(buf_id, pending_bytes.clone());
                } else {
                    buffer_store::append_raw_bytes(pending_bytes.clone());
                }

                // Emit to frontend
                let payload = RawBytesPayload {
                    bytes: pending_bytes,
                    source: "multi-source".to_string(),
                };
                emit_to_session(&app, "serial-raw-bytes", &session_id, payload);
                pending_bytes = Vec::new();
            }

            last_emit = std::time::Instant::now();
        }
    }

    // Emit any remaining frames
    if !pending_frames.is_empty() {
        pending_frames.sort_by_key(|f| f.timestamp_us);
        buffer_store::append_frames(pending_frames.clone());
        emit_frames(&app, &session_id, pending_frames);
    }

    // Emit any remaining bytes
    if !pending_bytes.is_empty() {
        pending_bytes.sort_by_key(|b| b.timestamp_us);
        // Append to buffer (use specific bytes buffer if we have one)
        if let Some(ref buf_id) = bytes_buffer_id {
            buffer_store::append_raw_bytes_to_buffer(buf_id, pending_bytes.clone());
        } else {
            buffer_store::append_raw_bytes(pending_bytes.clone());
        }
        let payload = RawBytesPayload {
            bytes: pending_bytes,
            source: "multi-source".to_string(),
        };
        emit_to_session(&app, "serial-raw-bytes", &session_id, payload);
    }

    // Wait for all source tasks to finish
    for handle in source_handles {
        let _ = handle.await;
    }

    // Emit stream ended (uses helper from gvret_common which finalizes the buffer)
    let reason = if stop_flag.load(Ordering::SeqCst) {
        "stopped"
    } else {
        "complete"
    };
    emit_stream_ended(&app, &session_id, reason, "MultiSourceReader");
}
