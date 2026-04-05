// ui/src-tauri/src/captures.rs
//
// Tauri commands for capture management.
// Handles CSV import, capture CRUD, pagination, and multi-capture registry.
//
// NOTE: Tauri command names and their snake_case parameter names (e.g.
// `list_buffers`, `buffer_id`) are preserved in Stage 1 of the Buffer →
// Capture rename — they are the IPC contract and change atomically in Stage 2.

use tauri::{AppHandle, Emitter};

use crate::{
    capture_store::{self, CaptureMetadata, CaptureFrameInfo, TimestampedByte, TailResponse},
    io::{self, FrameMessage},
};

/// Result of a CSV import, including buffer metadata and any sequence gap diagnostics.
#[derive(Clone, serde::Serialize)]
pub struct CsvImportResult {
    pub metadata: CaptureMetadata,
    pub sequence_gaps: Vec<io::SequenceGap>,
    /// Total number of dropped frames estimated from sequence gaps
    pub total_dropped: u64,
    /// Detected sequence wraparound points (raw sequence value at each wrap)
    pub wrap_points: Vec<u64>,
}

/// Response for paginated buffer frames
#[derive(Clone, serde::Serialize)]
pub struct PaginatedFramesResponse {
    pub frames: Vec<FrameMessage>,
    pub total_count: usize,
    pub offset: usize,
    pub limit: usize,
    /// 1-based original buffer position (rowid) for each frame.
    /// Parallel to `frames` — `buffer_indices[i]` is the position of `frames[i]`.
    pub buffer_indices: Vec<usize>,
}

/// Response for paginated buffer bytes
#[derive(Clone, serde::Serialize)]
pub struct PaginatedBytesResponse {
    pub bytes: Vec<TimestampedByte>,
    pub total_count: usize,
    pub offset: usize,
    pub limit: usize,
}

// ============================================================================
// CSV Import Commands
// ============================================================================

/// Import a CSV file into a session-owned buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn import_csv_to_buffer(session_id: String, file_path: String) -> Result<CaptureMetadata, String> {
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.csv")
        .to_string();

    let frames = io::parse_csv_file(&file_path)?;

    if frames.is_empty() {
        return Err("CSV file contains no valid frames".to_string());
    }

    let buffer_id = capture_store::create_capture(capture_store::CaptureKind::Frames, filename);
    let _ = capture_store::set_capture_owner(&buffer_id, &session_id);
    capture_store::append_frames_to_session(&session_id, frames);
    let finalized = capture_store::finalize_session_captures(&session_id);
    finalized.into_iter().next()
        .ok_or_else(|| "Failed to store frames in buffer".to_string())
}

/// Preview a data file: read first N rows, detect delimiter/headers, suggest column mappings
#[tauri::command(rename_all = "snake_case")]
pub async fn preview_csv(
    file_path: String,
    max_rows: Option<usize>,
    delimiter: Option<io::Delimiter>,
) -> Result<io::CsvPreview, String> {
    let max = max_rows.unwrap_or(20);
    io::preview_csv_file(&file_path, max, delimiter)
}

/// Import a data file with user-provided column mappings
#[tauri::command(rename_all = "snake_case")]
pub async fn import_csv_with_mapping(
    session_id: String,
    file_path: String,
    mappings: Vec<io::CsvColumnMapping>,
    skip_first_row: bool,
    timestamp_unit: io::TimestampUnit,
    negate_timestamps: bool,
    delimiter: io::Delimiter,
) -> Result<CsvImportResult, String> {
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let result = io::parse_csv_with_mapping(&file_path, &mappings, skip_first_row, timestamp_unit, negate_timestamps, delimiter)?;

    if result.frames.is_empty() {
        return Err("File contains no valid frames with the given column mapping".to_string());
    }

    let sequence_gaps = result.sequence_gaps;
    let total_dropped = sequence_gaps.iter().map(|g| g.dropped).sum();
    let wrap_points = detect_wrap_points(&sequence_gaps);

    let buffer_id = capture_store::create_capture(capture_store::CaptureKind::Frames, filename);
    let _ = capture_store::set_capture_owner(&buffer_id, &session_id);
    capture_store::append_frames_to_session(&session_id, result.frames);
    let finalized = capture_store::finalize_session_captures(&session_id);
    let metadata = finalized.into_iter().next()
        .ok_or_else(|| "Failed to store frames in buffer".to_string())?;

    Ok(CsvImportResult {
        metadata,
        sequence_gaps,
        total_dropped,
        wrap_points,
    })
}

/// Import multiple data files with shared column mappings into a single buffer.
/// Files are parsed sequentially and concatenated in order.
#[tauri::command(rename_all = "snake_case")]
pub async fn import_csv_batch_with_mapping(
    app_handle: AppHandle,
    session_id: String,
    file_paths: Vec<String>,
    mappings: Vec<io::CsvColumnMapping>,
    skip_first_row_per_file: Vec<bool>,
    timestamp_unit: io::TimestampUnit,
    negate_timestamps: bool,
    delimiter: io::Delimiter,
) -> Result<CsvImportResult, String> {
    if file_paths.is_empty() {
        return Err("No files provided".to_string());
    }

    // Build display name from filenames
    let name = if file_paths.len() == 1 {
        extract_filename(&file_paths[0])
    } else {
        build_batch_name(&file_paths)
    };

    // Create a single buffer for all files, owned by the session
    let buffer_id = capture_store::create_capture(capture_store::CaptureKind::Frames, name);
    let _ = capture_store::set_capture_owner(&buffer_id, &session_id);

    let total_files = file_paths.len();
    let mut total_frames: usize = 0;
    let mut all_sequence_gaps: Vec<io::SequenceGap> = Vec::new();
    let mut prev_file_last_seq: Option<u64> = None;
    let mut prev_file_name: Option<String> = None;

    for (i, file_path) in file_paths.iter().enumerate() {
        let fname = extract_filename(file_path);

        // Emit progress event for frontend
        let _ = app_handle.emit(
            "csv-import-progress",
            serde_json::json!({
                "file_index": i,
                "total_files": total_files,
                "filename": fname,
            }),
        );

        // Per-file header flag; falls back to false if array is shorter
        let skip_row = skip_first_row_per_file.get(i).copied().unwrap_or(false);

        let result = io::parse_csv_with_mapping(
            file_path, &mappings, skip_row, timestamp_unit, negate_timestamps, delimiter,
        )?;

        total_frames += result.frames.len();

        // Detect inter-file sequence gap (between previous file's last seq and this file's first)
        if let (Some(prev_last), Some(cur_first)) = (prev_file_last_seq, result.first_seq) {
            let gap = if cur_first > prev_last {
                cur_first - prev_last - 1
            } else if prev_last > 0 && cur_first < prev_last / 2 {
                // Wraparound
                cur_first
            } else {
                0
            };
            if gap > 0 {
                all_sequence_gaps.push(io::SequenceGap {
                    line: 1,
                    from_seq: prev_last,
                    to_seq: cur_first,
                    dropped: gap,
                    filename: Some(format!(
                        "{} → {}",
                        prev_file_name.as_deref().unwrap_or("?"),
                        fname
                    )),
                });
            }
        }

        // Tag intra-file gaps with the filename
        for mut gap in result.sequence_gaps {
            gap.filename = Some(fname.clone());
            all_sequence_gaps.push(gap);
        }

        if result.last_seq.is_some() {
            prev_file_last_seq = result.last_seq;
            prev_file_name = Some(fname);
        }

        capture_store::append_frames_to_session(&session_id, result.frames);
    }

    if total_frames == 0 {
        let _ = capture_store::delete_capture(&buffer_id);
        return Err("No valid frames found in any of the selected files".to_string());
    }

    tlog!(
        "[Buffers] Batch imported {} files ({} frames) into buffer '{}'",
        total_files, total_frames, buffer_id
    );

    let total_dropped = all_sequence_gaps.iter().map(|g| g.dropped).sum();
    let wrap_points = detect_wrap_points(&all_sequence_gaps);

    let finalized = capture_store::finalize_session_captures(&session_id);
    let metadata = finalized.into_iter().next()
        .ok_or_else(|| "Failed to finalise buffer".to_string())?;

    Ok(CsvImportResult {
        metadata,
        sequence_gaps: all_sequence_gaps,
        total_dropped,
        wrap_points,
    })
}

/// Detect sequence wraparound points from gaps.
/// A wrap is when `to_seq` is much smaller than `from_seq` (large backward jump).
fn detect_wrap_points(gaps: &[io::SequenceGap]) -> Vec<u64> {
    let mut wraps = Vec::new();
    for gap in gaps {
        if gap.from_seq > 0 && gap.to_seq < gap.from_seq / 2 {
            // This gap is a wraparound — the sequence wrapped at from_seq
            if !wraps.contains(&gap.from_seq) {
                wraps.push(gap.from_seq);
            }
        }
    }
    wraps
}

/// Extract filename from a full path
fn extract_filename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string()
}

/// Build a display name for a batch of files.
/// Tries to find a common prefix; falls back to "N files merged".
fn build_batch_name(paths: &[String]) -> String {
    let filenames: Vec<String> = paths.iter().map(|p| extract_filename(p)).collect();

    // Find longest common prefix among filenames
    if let Some(first) = filenames.first() {
        let prefix_len = first
            .char_indices()
            .take_while(|&(i, c)| filenames.iter().all(|f| f.get(i..i + c.len_utf8()) == Some(&first[i..i + c.len_utf8()])))
            .map(|(i, c)| i + c.len_utf8())
            .last()
            .unwrap_or(0);

        if prefix_len > 3 {
            let prefix = &first[..prefix_len];
            // Trim trailing separators/underscores
            let trimmed = prefix.trim_end_matches(|c: char| c == '_' || c == '-' || c == '.');
            return format!("{} ({} files)", trimmed, paths.len());
        }
    }

    format!("{} files merged", paths.len())
}

// ============================================================================
// Buffer Query Commands
// ============================================================================

/// Get the current buffer metadata (if any data is loaded)
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_metadata(buffer_id: String) -> Result<Option<CaptureMetadata>, String> {
    Ok(capture_store::get_capture_metadata(&buffer_id))
}

/// Get all frames from a buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames(buffer_id: String) -> Result<Vec<FrameMessage>, String> {
    capture_store::get_capture_frames(&buffer_id)
        .ok_or_else(|| format!("Buffer '{}' not found or is not a frame buffer", buffer_id))
}

/// Get a page of frames from a buffer (for large datasets)
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_paginated(
    buffer_id: String,
    offset: usize,
    limit: usize,
) -> Result<PaginatedFramesResponse, String> {
    let (frames, buffer_indices, total_count) = capture_store::get_capture_frames_paginated(&buffer_id, offset, limit);
    Ok(PaginatedFramesResponse {
        frames,
        total_count,
        offset,
        limit,
        buffer_indices,
    })
}

/// Get a page of frames from a buffer, filtered by selected frame IDs
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_paginated_filtered(
    buffer_id: String,
    offset: usize,
    limit: usize,
    selected_ids: Vec<u32>,
) -> Result<PaginatedFramesResponse, String> {
    let selected_set: std::collections::HashSet<u32> = selected_ids.into_iter().collect();
    let (frames, buffer_indices, total_count) = capture_store::get_capture_frames_paginated_filtered(&buffer_id, offset, limit, &selected_set);
    Ok(PaginatedFramesResponse {
        frames,
        total_count,
        offset,
        limit,
        buffer_indices,
    })
}

/// Get the most recent N frames from a buffer, optionally filtered by frame IDs.
/// Used for "tail mode" during streaming.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_tail(
    buffer_id: String,
    limit: usize,
    selected_ids: Vec<u32>,
) -> Result<TailResponse, String> {
    let selected_set: std::collections::HashSet<u32> = selected_ids.into_iter().collect();
    Ok(capture_store::get_capture_frames_tail(&buffer_id, limit, &selected_set))
}

/// Get unique frame IDs and their metadata from a buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frame_info(buffer_id: String) -> Result<Vec<CaptureFrameInfo>, String> {
    Ok(capture_store::get_capture_frame_info(&buffer_id))
}

/// Find the offset in the filtered buffer for a given timestamp
#[tauri::command(rename_all = "snake_case")]
pub async fn find_buffer_offset_for_timestamp(
    buffer_id: String,
    timestamp_us: u64,
    selected_ids: Vec<u32>,
) -> Result<usize, String> {
    let selected_set: std::collections::HashSet<u32> = selected_ids.into_iter().collect();
    Ok(capture_store::find_capture_offset_for_timestamp(&buffer_id, timestamp_us, &selected_set))
}

// ============================================================================
// Multi-Buffer Registry Commands
// ============================================================================

/// List all buffers in the registry
#[tauri::command(rename_all = "snake_case")]
pub async fn list_buffers() -> Result<Vec<CaptureMetadata>, String> {
    Ok(capture_store::list_captures())
}

/// List all buffer IDs (lightweight — no metadata)
#[tauri::command(rename_all = "snake_case")]
pub async fn list_buffer_ids() -> Vec<String> {
    capture_store::list_capture_ids()
}

/// Delete a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn delete_buffer(buffer_id: String) -> Result<(), String> {
    capture_store::delete_capture(&buffer_id)
}

/// Clear a buffer's data without deleting the buffer.
/// The session keeps its reference and can continue writing new frames.
#[tauri::command(rename_all = "snake_case")]
pub async fn clear_buffer(buffer_id: String) -> Result<(), String> {
    capture_store::clear_capture(&buffer_id)
}

/// Get metadata for a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_metadata_by_id(buffer_id: String) -> Result<Option<CaptureMetadata>, String> {
    Ok(capture_store::get_capture_metadata(&buffer_id))
}

/// Get frames from a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_by_id(buffer_id: String) -> Result<Vec<FrameMessage>, String> {
    capture_store::get_capture_frames(&buffer_id)
        .ok_or_else(|| format!("Buffer '{}' not found or is not a frame buffer", buffer_id))
}

/// Get raw bytes from a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_bytes_by_id(buffer_id: String) -> Result<Vec<TimestampedByte>, String> {
    capture_store::get_capture_bytes(&buffer_id)
        .ok_or_else(|| format!("Buffer '{}' not found or is not a byte buffer", buffer_id))
}

/// Mark a buffer as active (being rendered by a UI panel)
#[tauri::command(rename_all = "snake_case")]
pub async fn set_active_buffer(buffer_id: String) -> Result<(), String> {
    capture_store::mark_capture_active(&buffer_id)
}

/// Create a new frame buffer from frames passed from the frontend.
/// Used when accepting client-side framing to persist the framed data.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_frame_buffer_from_frames(
    session_id: String,
    name: String,
    frames: Vec<FrameMessage>,
) -> Result<CaptureMetadata, String> {
    if frames.is_empty() {
        return Err("No frames to create buffer from".to_string());
    }

    let buffer_id = capture_store::create_capture(capture_store::CaptureKind::Frames, name);
    let _ = capture_store::set_capture_owner(&buffer_id, &session_id);
    capture_store::append_frames_to_session(&session_id, frames);
    let finalized = capture_store::finalize_session_captures(&session_id);
    finalized.into_iter().next()
        .ok_or_else(|| format!("Failed to finalize buffer '{}'", buffer_id))
}

/// Get a page of frames from a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_paginated_by_id(
    buffer_id: String,
    offset: usize,
    limit: usize,
) -> Result<PaginatedFramesResponse, String> {
    let (frames, buffer_indices, total_count) = capture_store::get_capture_frames_paginated(&buffer_id, offset, limit);
    Ok(PaginatedFramesResponse {
        frames,
        total_count,
        offset,
        limit,
        buffer_indices,
    })
}

// ============================================================================
// Byte Buffer Commands (Serial Discovery)
// ============================================================================

/// Get a page of bytes from a buffer (for serial discovery)
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_bytes_paginated(
    buffer_id: String,
    offset: usize,
    limit: usize,
) -> Result<PaginatedBytesResponse, String> {
    let (bytes, total_count) = capture_store::get_capture_bytes_paginated(&buffer_id, offset, limit);
    Ok(PaginatedBytesResponse {
        bytes,
        total_count,
        offset,
        limit,
    })
}

/// Get the total byte count from a buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_bytes_count(buffer_id: String) -> Result<usize, String> {
    Ok(capture_store::get_capture_count(&buffer_id))
}

/// Get bytes from a specific buffer by ID with pagination
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_bytes_paginated_by_id(
    buffer_id: String,
    offset: usize,
    limit: usize,
) -> Result<PaginatedBytesResponse, String> {
    let (bytes, total_count) = capture_store::get_capture_bytes_paginated(&buffer_id, offset, limit);
    Ok(PaginatedBytesResponse {
        bytes,
        total_count,
        offset,
        limit,
    })
}

/// Find the byte offset at or after the given timestamp in a byte buffer.
/// Uses binary search for O(log n) performance.
#[tauri::command(rename_all = "snake_case")]
pub async fn find_buffer_bytes_offset_for_timestamp(
    buffer_id: String,
    target_time_us: u64,
) -> Result<usize, String> {
    Ok(capture_store::find_capture_bytes_offset_for_timestamp_by_id(&buffer_id, target_time_us))
}

/// Search a specific buffer for frames matching a query string.
/// Returns 0-based offsets in the selected-ID-filtered result set.
/// `query` should have whitespace stripped before calling.
#[tauri::command(rename_all = "snake_case")]
pub async fn search_buffer_frames(
    buffer_id: String,
    query: String,
    search_id: bool,
    search_data: bool,
    selected_ids: Vec<u32>,
) -> Result<Vec<usize>, String> {
    crate::capture_db::search_frames(&buffer_id, &query, search_id, search_data, &selected_ids)
}

/// Response for tail-mode byte buffer queries
#[derive(Clone, serde::Serialize)]
pub struct BytesTailResponse {
    pub bytes: Vec<TimestampedByte>,
    pub total_count: usize,
}

/// Get the most recent bytes from a buffer (tail view for serial discovery).
#[tauri::command(rename_all = "snake_case")]
pub fn get_buffer_bytes_tail(buffer_id: String, tail_size: usize) -> BytesTailResponse {
    let total_count = capture_store::get_capture_count(&buffer_id);
    let offset = total_count.saturating_sub(tail_size);
    let limit = tail_size.min(total_count);
    let (bytes, _) = capture_store::get_capture_bytes_paginated(&buffer_id, offset, limit);
    BytesTailResponse { bytes, total_count }
}

// ============================================================================
// Session-Aware Buffer Commands
// ============================================================================

/// Rename a buffer.
#[tauri::command(rename_all = "snake_case")]
pub async fn rename_buffer(buffer_id: String, new_name: String) -> Result<CaptureMetadata, String> {
    capture_store::rename_capture(&buffer_id, &new_name)
}

/// Set a buffer's persistent flag.
/// Persistent buffers survive app restart when 'clear buffers on start' is enabled.
#[tauri::command(rename_all = "snake_case")]
pub async fn set_buffer_persistent(buffer_id: String, persistent: bool) -> Result<CaptureMetadata, String> {
    capture_store::set_capture_persistent(&buffer_id, persistent)
}

/// List only orphaned buffers (no owning session).
/// These are buffers available for standalone selection in the IO picker.
/// Includes CSV imports and buffers from destroyed sessions.
#[tauri::command(rename_all = "snake_case")]
pub async fn list_orphaned_buffers() -> Vec<CaptureMetadata> {
    capture_store::list_orphaned_captures()
}
