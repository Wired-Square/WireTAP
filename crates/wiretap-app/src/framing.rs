// ui/crates/wiretap-app/src/framing.rs
//
// Tauri commands for backend framing operations.
// Converts raw serial bytes into structured frames using various protocols.
// Only available on desktop (serial not supported on iOS).

// ============================================================================
// iOS stub - serial framing not available
// ============================================================================

#[cfg(target_os = "ios")]
mod ios_stub {
    /// Untyped, deliberately: the command only ever errors here, and stub structs
    /// mirroring the desktop shapes are two more things to keep in step — which
    /// they were not, having missed the last two fields added opposite.
    #[tauri::command(rename_all = "snake_case")]
    pub async fn apply_framing_to_capture(
        _config: serde_json::Value,
        _reuse_capture_id: Option<String>,
        _reuse_filtered_capture_id: Option<String>,
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
}

#[cfg(target_os = "ios")]
pub use ios_stub::*;

// ============================================================================
// Desktop implementation
// ============================================================================

#[cfg(not(target_os = "ios"))]
mod desktop {
    use crate::{
        capture_store,
        io::FrameMessage,
        io::serial::{DelimiterOptions, FrameIdConfig, FramingEncoding, SerialFramer},
    };

    /// Per-interface framing configuration (overrides default for specific bus)
    #[derive(Clone, serde::Deserialize)]
    pub struct InterfaceFramingConfig {
        /// Framing mode: "raw", "slip", "modbus_rtu"
        pub mode: String,
        /// For raw mode: delimiter bytes as hex string (e.g., "0D0A")
        pub delimiter: Option<String>,
        /// For raw mode: max frame length before forced split
        pub max_length: Option<usize>,
        /// For modbus_rtu mode: the RTU settings. Re-framing has to agree with
        /// the live framer or the Framed tab changes on stop.
        #[serde(default)]
        pub modbus: Option<crate::io::ModbusRtuOptions>,
    }

    /// Configuration for backend framing
    #[derive(Clone, serde::Deserialize)]
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
        pub per_interface: Option<std::collections::HashMap<u8, InterfaceFramingConfig>>,
    }

    /// Result from backend framing operation
    #[derive(Clone, serde::Serialize)]
    pub struct FramingResult {
        /// Number of frames extracted
        pub frame_count: usize,
        /// ID of the new frame capture
        pub capture_id: String,
        /// Number of frames excluded by min_length filter
        pub filtered_count: usize,
        /// ID of the filtered frames capture (frames that were too short)
        pub filtered_capture_id: Option<String>,
    }

    /// Build framing encoding from mode and options
    fn build_encoding(cfg: &InterfaceFramingConfig) -> Result<FramingEncoding, String> {
        match cfg.mode.as_str() {
            "slip" => Ok(FramingEncoding::Slip {
                max_frame_len: cfg.max_length.unwrap_or(1024),
            }),
            "modbus_rtu" => Ok(FramingEncoding::ModbusRtu(
                cfg.modbus.clone().unwrap_or_default(),
            )),
            "raw" => {
                let delimiter = match cfg.delimiter.as_deref() {
                    Some(hex) => {
                        wiretap_decode::hex::parse_bytes(hex).map_err(|e| e.to_string())?
                    }
                    None => vec![0x0A], // Default LF
                };
                Ok(FramingEncoding::Delimiter(DelimiterOptions {
                    delimiter,
                    max_length: cfg.max_length.unwrap_or(1024),
                    include_delimiter: false,
                }))
            }
            mode => Err(format!("Unknown framing mode: {}", mode)),
        }
    }

    /// Clear and refill `reuse` if it is a derived capture of this session,
    /// otherwise derive a fresh one. The session's *own* capture is never
    /// reusable — clearing it would destroy what it is still recording.
    fn refill_or_derive(
        session_id: &str,
        reuse: Option<&str>,
        name: String,
        frames: Vec<crate::io::FrameMessage>,
    ) -> String {
        let reusable = reuse.filter(|id| {
            capture_store::get_capture_kind(id) == Some(capture_store::CaptureKind::Frames)
                && capture_store::is_derived_capture(id, session_id)
        });
        match reusable {
            Some(existing_id) => {
                capture_store::clear_and_refill_capture(existing_id, frames);
                existing_id.to_string()
            }
            None => {
                let new_id = capture_store::create_derived_capture(
                    session_id,
                    capture_store::CaptureKind::Frames,
                    name,
                );
                capture_store::append_frames_to_capture(&new_id, frames);
                new_id
            }
        }
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

    /// Apply framing to the active byte capture.
    ///
    /// `reuse_capture_id` and `reuse_filtered_capture_id` name the previous run's
    /// two outputs. Both are cleared and refilled when they are still this
    /// session's derived captures, so re-framing does not leave a trail of them —
    /// which is what happened to the filtered one, on every stop.
    #[tauri::command(rename_all = "snake_case")]
    pub async fn apply_framing_to_capture(
        session_id: String,
        config: BackendFramingConfig,
        reuse_capture_id: Option<String>,
        reuse_filtered_capture_id: Option<String>,
    ) -> Result<FramingResult, String> {
        tlog!("[framing] apply_framing_to_capture called with min_length={:?}", config.min_length);

        // Get session's byte capture
        let capture_id = capture_store::get_session_bytes_capture_id(&session_id)
            .ok_or_else(|| "No byte capture found for session".to_string())?;

        let bytes = capture_store::get_capture_bytes(&capture_id)
            .ok_or_else(|| format!("Capture '{}' not found or is not a byte capture", capture_id))?;

        if bytes.is_empty() {
            return Err("No bytes in capture".to_string());
        }

        let catalog = crate::ws::dispatch::attached_catalog(&session_id);
        let (frame_messages, filtered_messages) =
            frame_messages(&bytes, &config, catalog.as_deref())?;

        let frame_count = frame_messages.len();
        let filtered_count = filtered_messages.len();

        if frame_count == 0 && filtered_count == 0 {
            return Err("No frames extracted".to_string());
        }

        let target_capture_id = refill_or_derive(
            &session_id,
            reuse_capture_id.as_deref(),
            format!("Framed from {}", capture_id),
            frame_messages,
        );

        // The filtered capture gets the same treatment. It used to be created
        // fresh every call and never reused or deleted, so with a min-length
        // filter set, each re-frame left another session-owned capture behind —
        // and framing runs on every stop.
        let filtered_capture_id = if filtered_messages.is_empty() {
            drop_derived_capture(&session_id, reuse_filtered_capture_id.as_deref());
            None
        } else {
            Some(refill_or_derive(
                &session_id,
                reuse_filtered_capture_id.as_deref(),
                format!("Filtered from {}", capture_id),
                filtered_messages,
            ))
        };

        // Note: We don't finalize here - the bytes capture stays active for HexDump,
        // and the frames capture is just a derived view that FramedDataView fetches by ID.

        Ok(FramingResult {
            frame_count,
            capture_id: target_capture_id,
            filtered_count,
            filtered_capture_id,
        })
    }

    #[derive(serde::Serialize)]
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

    /// Frame a byte capture, stamping each message at its last byte as a live
    /// line and the gateway archive do. Returns the messages at or above the
    /// minimum length, then those below it.
    fn frame_messages(
        bytes: &[capture_store::TimestampedByte],
        config: &BackendFramingConfig,
        catalog: Option<&wiretap_catalog::Catalog>,
    ) -> Result<(Vec<FrameMessage>, Vec<FrameMessage>), String> {
        // Build default framing encoding from config
        let default_encoding = build_encoding(&config.framing)?;

        // Group bytes by bus/interface for per-interface framing
        // This prevents bytes from different interfaces from being mixed during framing
        use std::collections::HashMap;
        let mut bytes_by_bus: HashMap<u8, Vec<(usize, &capture_store::TimestampedByte)>> = HashMap::new();
        for (i, byte) in bytes.iter().enumerate() {
            bytes_by_bus
                .entry(byte.bus)
                .or_default()
                .push((i, byte));
        }

        // Apply framing separately per interface
        // Each interface gets its own framer (potentially with different encoding) to avoid mixing byte streams
        let mut frame_data: Vec<(Vec<u8>, usize, bool, Option<bool>, u8)> = Vec::new(); // (bytes, end_idx, incomplete, crc_valid, bus)

        for (bus, bus_bytes) in bytes_by_bus.iter() {
            // A per-interface override for this bus, else the session default.
            let encoding = match config.per_interface.as_ref().and_then(|m| m.get(bus)) {
                Some(interface_config) => build_encoding(interface_config)?,
                None => default_encoding.clone(),
            }
            .checked()?;

            let Some(mut framer) = SerialFramer::with_catalog(encoding, catalog) else {
                continue;
            };
            let line: Vec<u8> = bus_bytes.iter().map(|(_, byte)| byte.byte).collect();
            // Modbus RTU can still recover whole messages at the flush, so it is
            // a list, not one residue.
            let mut released = framer.feed(&line);
            released.extend(framer.flush());

            // Each frame's last byte, not the one that released it: a sync
            // releases the RTU messages it buffered on a later byte.
            for frame in released {
                let (end_idx, _) = bus_bytes[frame.end_offset as usize - 1];
                frame_data.push((frame.bytes, end_idx, frame.incomplete, frame.crc_valid, *bus));
            }
        }

        // Sort frames by their last byte (original byte order) for consistent ordering
        frame_data.sort_by_key(|(_, end_idx, _, _, _)| *end_idx);

        // Apply minimum length filter - separate into passed and filtered.
        // Partition the owned tuples, not references, so each payload moves into
        // its FrameMessage instead of being cloned once per frame.
        let min_length = config.min_length.unwrap_or(1);
        let (passed_frames, filtered_frames): (Vec<_>, Vec<_>) = frame_data
            .into_iter()
            .enumerate()
            .partition(|(_, (frame_bytes, _, _, _, _))| frame_bytes.len() >= min_length);

        // One builder for both lists. They were byte-for-byte duplicates, which
        // is how the live and flush paths in the serial reader had drifted apart
        // on `incomplete`; the only thing separating these two is which side of
        // the length filter the frame fell on.
        //
        // `crc_valid` is dropped here, and nothing is lost by it: the decode
        // path recomputes the same verdict from the same bytes when it
        // interprets the message, so the Decoder's Modbus tab reports it
        // whether the frames are live or out of a capture. Persisting it would
        // only matter to a view that wants the verdict without decoding.
        let to_message = |(idx, (frame_bytes, end_idx, incomplete, _crc_valid, bus)): (
            usize,
            (Vec<u8>, usize, bool, Option<bool>, u8),
        )| {
            let extract = |cfg: &Option<FrameIdConfig>| cfg.as_ref()?.extract(&frame_bytes);
            let frame_id = extract(&config.frame_id_config).unwrap_or(idx as u32);
            let source_address = extract(&config.source_address_config).map(|v| v as u16);
            let dlc = frame_bytes.len() as u16;

            FrameMessage {
                protocol: "serial".to_string(),
                timestamp_us: bytes.get(end_idx).map(|b| b.timestamp_us).unwrap_or(0),
                frame_id,
                bus,
                dlc,
                bytes: frame_bytes,
                is_extended: false,
                is_fd: false,
                source_address,
                incomplete: incomplete.then_some(true),
                direction: None,
            }
        };

        Ok((
            passed_frames.into_iter().map(&to_message).collect(),
            filtered_frames.into_iter().map(&to_message).collect(),
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use capture_store::TimestampedByte;

        fn config(mode: &str) -> BackendFramingConfig {
            BackendFramingConfig {
                framing: InterfaceFramingConfig {
                    mode: mode.to_string(),
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
            let mut out = wiretap_decode::hex::parse_bytes(hex).unwrap();
            out.extend(wiretap_checksum::algorithms::crc16_modbus_checksum(&out).to_le_bytes());
            out
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
            let mut empty = config("raw");
            empty.framing.delimiter = Some(String::new());
            let err = frame_messages(&line, &empty, None).unwrap_err();
            assert!(err.contains("delimiter"), "{err}");

            for mode in ["raw", "slip"] {
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
            assert_eq!(stamps(&stamped(b"AB\nCDE\n"), &config("raw")), vec![1_020, 1_060]);
        }
    }
}

#[cfg(not(target_os = "ios"))]
pub use desktop::*;
