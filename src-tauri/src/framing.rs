// ui/src-tauri/src/framing.rs
//
// Tauri commands for backend framing operations.
// Converts raw serial bytes into structured frames using various protocols.

use crate::{
    buffer_store,
    io::FrameMessage,
    io::serial::{extract_frame_id, FrameIdConfig, FramingEncoding, SerialFramer},
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
    /// For modbus_rtu mode: whether to validate CRC
    pub validate_crc: Option<bool>,
}

/// Configuration for backend framing
#[derive(Clone, serde::Deserialize)]
pub struct BackendFramingConfig {
    /// Default framing mode: "raw", "slip", "modbus_rtu"
    pub mode: String,
    /// For raw mode: delimiter bytes as hex string (e.g., "0D0A")
    pub delimiter: Option<String>,
    /// For raw mode: max frame length before forced split
    pub max_length: Option<usize>,
    /// For modbus_rtu mode: whether to validate CRC
    pub validate_crc: Option<bool>,
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
    /// ID of the new frame buffer
    pub buffer_id: String,
    /// Number of frames excluded by min_length filter
    pub filtered_count: usize,
    /// ID of the filtered frames buffer (frames that were too short)
    pub filtered_buffer_id: Option<String>,
}

/// Parse hex string to bytes (e.g., "0D0A" -> [0x0D, 0x0A])
fn parse_hex_delimiter(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("Hex string must have even length".to_string());
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for i in (0..hex.len()).step_by(2) {
        let byte_str = &hex[i..i + 2];
        let byte = u8::from_str_radix(byte_str, 16)
            .map_err(|_| format!("Invalid hex byte: {}", byte_str))?;
        bytes.push(byte);
    }
    Ok(bytes)
}

/// Build framing encoding from mode and options
fn build_encoding(
    mode: &str,
    delimiter: Option<&String>,
    max_length: Option<usize>,
    validate_crc: Option<bool>,
) -> Result<FramingEncoding, String> {
    match mode {
        "slip" => Ok(FramingEncoding::Slip),
        "modbus_rtu" => Ok(FramingEncoding::ModbusRtu {
            device_address: None,
            validate_crc: validate_crc.unwrap_or(true),
        }),
        "raw" => {
            let delimiter_bytes = if let Some(hex) = delimiter {
                parse_hex_delimiter(hex)?
            } else {
                vec![0x0A] // Default LF
            };
            Ok(FramingEncoding::Delimiter {
                delimiter: delimiter_bytes,
                max_length: max_length.unwrap_or(1024),
                include_delimiter: false,
            })
        }
        _ => Err(format!("Unknown framing mode: {}", mode)),
    }
}

/// Apply framing to the active byte buffer.
/// If `reuse_buffer_id` is provided and valid, that buffer will be cleared and reused.
/// Otherwise, a new frame buffer is created.
/// This avoids buffer proliferation during live framing.
#[tauri::command(rename_all = "snake_case")]
pub async fn apply_framing_to_buffer(
    config: BackendFramingConfig,
    reuse_buffer_id: Option<String>,
) -> Result<FramingResult, String> {
    eprintln!("[framing] apply_framing_to_buffer called with min_length={:?}", config.min_length);

    // Get active byte buffer
    let buffer_id = buffer_store::get_active_buffer_id()
        .ok_or_else(|| "No active buffer".to_string())?;

    let bytes = buffer_store::get_buffer_bytes(&buffer_id)
        .ok_or_else(|| format!("Buffer '{}' not found or is not a byte buffer", buffer_id))?;

    if bytes.is_empty() {
        return Err("No bytes in buffer".to_string());
    }

    // Build default framing encoding from config
    let default_encoding = build_encoding(
        &config.mode,
        config.delimiter.as_ref(),
        config.max_length,
        config.validate_crc,
    )?;

    // Group bytes by bus/interface for per-interface framing
    // This prevents bytes from different interfaces from being mixed during framing
    use std::collections::HashMap;
    let mut bytes_by_bus: HashMap<u8, Vec<(usize, &buffer_store::TimestampedByte)>> = HashMap::new();
    for (i, byte) in bytes.iter().enumerate() {
        bytes_by_bus
            .entry(byte.bus)
            .or_default()
            .push((i, byte));
    }

    // Apply framing separately per interface
    // Each interface gets its own framer (potentially with different encoding) to avoid mixing byte streams
    let mut frame_data: Vec<(Vec<u8>, usize, bool, Option<bool>, u8)> = Vec::new(); // (bytes, start_idx, incomplete, crc_valid, bus)

    for (bus, bus_bytes) in bytes_by_bus.iter() {
        // Check for per-interface framing override
        let encoding = if let Some(ref per_interface) = config.per_interface {
            if let Some(interface_config) = per_interface.get(bus) {
                // Use per-interface config
                build_encoding(
                    &interface_config.mode,
                    interface_config.delimiter.as_ref(),
                    interface_config.max_length,
                    interface_config.validate_crc,
                )?
            } else {
                // Fall back to default
                default_encoding.clone()
            }
        } else {
            // No per-interface configs, use default
            default_encoding.clone()
        };

        let mut framer = SerialFramer::new(encoding);
        let mut current_frame_start_idx = bus_bytes.first().map(|(i, _)| *i).unwrap_or(0);

        for (original_idx, byte) in bus_bytes.iter() {
            let frames = framer.feed(&[byte.byte]);
            for frame in frames {
                frame_data.push((frame.bytes, current_frame_start_idx, frame.incomplete, frame.crc_valid, *bus));
                // Next frame starts after this byte
                current_frame_start_idx = *original_idx + 1;
            }
        }

        // Handle flushed frame for this interface
        if let Some(frame) = framer.flush() {
            frame_data.push((frame.bytes, current_frame_start_idx, frame.incomplete, frame.crc_valid, *bus));
        }
    }

    // Sort frames by their start index (original byte order) for consistent ordering
    frame_data.sort_by_key(|(_, start_idx, _, _, _)| *start_idx);

    // Apply minimum length filter - separate into passed and filtered
    let min_length = config.min_length.unwrap_or(1);
    let (passed_frames, filtered_frames): (Vec<_>, Vec<_>) = frame_data
        .iter()
        .enumerate()
        .partition(|(_, (frame_bytes, _, _, _, _))| frame_bytes.len() >= min_length);

    // Convert passed frames to FrameMessage format
    let frame_messages: Vec<FrameMessage> = passed_frames
        .into_iter()
        .map(|(idx, (frame_bytes, start_idx, incomplete, _crc_valid, bus))| {
            // Get timestamp from first byte of frame
            let timestamp = bytes.get(*start_idx).map(|b| b.timestamp_us).unwrap_or(0);

            // Extract frame ID if configured
            let frame_id = if let Some(ref id_config) = config.frame_id_config {
                extract_frame_id(frame_bytes, id_config).unwrap_or(idx as u32)
            } else {
                idx as u32
            };

            // Extract source address if configured
            let source_address = if let Some(ref src_config) = config.source_address_config {
                extract_frame_id(frame_bytes, src_config).map(|v| v as u16)
            } else {
                None
            };

            FrameMessage {
                protocol: "serial".to_string(),
                timestamp_us: timestamp,
                frame_id,
                bus: *bus,
                dlc: frame_bytes.len() as u8,
                bytes: frame_bytes.clone(),
                is_extended: false,
                is_fd: false,
                source_address,
                incomplete: if *incomplete { Some(true) } else { None },
                direction: None,
            }
        })
        .collect();

    let frame_count = frame_messages.len();
    let filtered_count = filtered_frames.len();

    // Convert filtered frames to FrameMessage format (for display in Filtered tab)
    let filtered_messages: Vec<FrameMessage> = filtered_frames
        .into_iter()
        .map(|(idx, (frame_bytes, start_idx, incomplete, _crc_valid, bus))| {
            // Get timestamp from first byte of frame
            let timestamp = bytes.get(*start_idx).map(|b| b.timestamp_us).unwrap_or(0);

            // Extract frame ID if configured
            let frame_id = if let Some(ref id_config) = config.frame_id_config {
                extract_frame_id(frame_bytes, id_config).unwrap_or(idx as u32)
            } else {
                idx as u32
            };

            // Extract source address if configured
            let source_address = if let Some(ref src_config) = config.source_address_config {
                extract_frame_id(frame_bytes, src_config).map(|v| v as u16)
            } else {
                None
            };

            FrameMessage {
                protocol: "serial".to_string(),
                timestamp_us: timestamp,
                frame_id,
                bus: *bus,
                dlc: frame_bytes.len() as u8,
                bytes: frame_bytes.clone(),
                is_extended: false,
                is_fd: false,
                source_address,
                incomplete: if *incomplete { Some(true) } else { None },
                direction: None,
            }
        })
        .collect();

    if frame_count == 0 && filtered_count == 0 {
        return Err("No frames extracted".to_string());
    }

    // Reuse existing buffer if provided and valid, otherwise create a new one.
    // This avoids buffer proliferation during live streaming.
    let target_buffer_id = if let Some(ref existing_id) = reuse_buffer_id {
        // Check if the buffer exists and is a frames buffer
        if buffer_store::get_buffer_type(existing_id) == Some(buffer_store::BufferType::Frames) {
            // Clear the existing buffer and reuse it
            buffer_store::clear_and_refill_buffer(existing_id, frame_messages);
            existing_id.clone()
        } else {
            // Buffer doesn't exist or is wrong type - create a new one
            let new_id = buffer_store::create_buffer_inactive(
                buffer_store::BufferType::Frames,
                format!("Framed from {}", buffer_id),
            );
            buffer_store::append_frames_to_buffer(&new_id, frame_messages);
            new_id
        }
    } else {
        // No buffer to reuse - create a new one
        let new_id = buffer_store::create_buffer_inactive(
            buffer_store::BufferType::Frames,
            format!("Framed from {}", buffer_id),
        );
        buffer_store::append_frames_to_buffer(&new_id, frame_messages);
        new_id
    };

    // Create filtered frames buffer if there are any filtered frames
    let filtered_buffer_id = if !filtered_messages.is_empty() {
        let filtered_id = buffer_store::create_buffer_inactive(
            buffer_store::BufferType::Frames,
            format!("Filtered from {}", buffer_id),
        );
        buffer_store::append_frames_to_buffer(&filtered_id, filtered_messages);
        Some(filtered_id)
    } else {
        None
    };

    // Note: We don't finalize here - the bytes buffer stays active for HexDump,
    // and the frames buffer is just a derived view that FramedDataView fetches by ID.

    Ok(FramingResult {
        frame_count,
        buffer_id: target_buffer_id,
        filtered_count,
        filtered_buffer_id,
    })
}
