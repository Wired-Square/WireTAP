// ui/src-tauri/src/buffers.rs
//
// Tauri commands for buffer management.
// Handles CSV import, buffer CRUD, pagination, and multi-buffer registry.

use crate::{
    buffer_store::{self, BufferMetadata, BufferFrameInfo, TimestampedByte, TailResponse},
    io::{self, FrameMessage},
};

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

/// Import a CSV file into the shared buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn import_csv_to_buffer(file_path: String) -> Result<BufferMetadata, String> {
    // Extract filename from path
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.csv")
        .to_string();

    // Parse the CSV file
    let frames = io::parse_csv_file(&file_path)?;

    if frames.is_empty() {
        return Err("CSV file contains no valid frames".to_string());
    }

    // Store in the shared buffer
    buffer_store::set_buffer(frames, filename);

    // Return the metadata
    buffer_store::get_metadata()
        .ok_or_else(|| "Failed to store frames in buffer".to_string())
}

/// Preview a CSV file: read first N rows, detect headers, suggest column mappings
#[tauri::command(rename_all = "snake_case")]
pub async fn preview_csv(
    file_path: String,
    max_rows: Option<usize>,
) -> Result<io::CsvPreview, String> {
    let max = max_rows.unwrap_or(20);
    io::preview_csv_file(&file_path, max)
}

/// Import a CSV file with user-provided column mappings
#[tauri::command(rename_all = "snake_case")]
pub async fn import_csv_with_mapping(
    file_path: String,
    mappings: Vec<io::CsvColumnMapping>,
    skip_first_row: bool,
    timestamp_unit: io::TimestampUnit,
    negate_timestamps: bool,
) -> Result<BufferMetadata, String> {
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.csv")
        .to_string();

    let frames = io::parse_csv_with_mapping(&file_path, &mappings, skip_first_row, timestamp_unit, negate_timestamps)?;

    if frames.is_empty() {
        return Err("CSV file contains no valid frames with the given column mapping".to_string());
    }

    buffer_store::set_buffer(frames, filename);

    buffer_store::get_metadata()
        .ok_or_else(|| "Failed to store frames in buffer".to_string())
}

// ============================================================================
// Active Buffer Commands (Legacy Single-Buffer API)
// ============================================================================

/// Get the current buffer metadata (if any data is loaded)
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_metadata() -> Result<Option<BufferMetadata>, String> {
    Ok(buffer_store::get_metadata())
}

/// Clear the shared buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn clear_buffer() -> Result<(), String> {
    buffer_store::clear_buffer()
}

/// Get all frames from the shared buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames() -> Result<Vec<FrameMessage>, String> {
    Ok(buffer_store::get_frames())
}

/// Get a page of frames from the shared buffer (for large datasets)
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_paginated(
    offset: usize,
    limit: usize,
) -> Result<PaginatedFramesResponse, String> {
    let (frames, buffer_indices, total_count) = buffer_store::get_frames_paginated(offset, limit);
    Ok(PaginatedFramesResponse {
        frames,
        total_count,
        offset,
        limit,
        buffer_indices,
    })
}

/// Get a page of frames from the shared buffer, filtered by selected frame IDs
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_paginated_filtered(
    offset: usize,
    limit: usize,
    selected_ids: Vec<u32>,
) -> Result<PaginatedFramesResponse, String> {
    let selected_set: std::collections::HashSet<u32> = selected_ids.into_iter().collect();
    let (frames, buffer_indices, total_count) = buffer_store::get_frames_paginated_filtered(offset, limit, &selected_set);
    Ok(PaginatedFramesResponse {
        frames,
        total_count,
        offset,
        limit,
        buffer_indices,
    })
}

/// Get the most recent N frames from the active buffer, optionally filtered by frame IDs.
/// Used for "tail mode" during streaming - shows latest frames without frontend accumulation.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_tail(
    limit: usize,
    selected_ids: Vec<u32>,
) -> Result<TailResponse, String> {
    let buffer_id = buffer_store::get_active_buffer_id()
        .ok_or_else(|| "No active buffer".to_string())?;

    let selected_set: std::collections::HashSet<u32> = selected_ids.into_iter().collect();
    Ok(buffer_store::get_buffer_frames_tail(&buffer_id, limit, &selected_set))
}

/// Get unique frame IDs and their metadata from the buffer
/// Used to build the frame picker after a large ingest
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frame_info() -> Result<Vec<BufferFrameInfo>, String> {
    Ok(buffer_store::get_frame_info_map())
}

/// Find the offset in the filtered buffer for a given timestamp
/// Used for timeline scrubber navigation in buffer mode
#[tauri::command(rename_all = "snake_case")]
pub async fn find_buffer_offset_for_timestamp(
    timestamp_us: u64,
    selected_ids: Vec<u32>,
) -> Result<usize, String> {
    let selected_set: std::collections::HashSet<u32> = selected_ids.into_iter().collect();
    Ok(buffer_store::find_offset_for_timestamp(timestamp_us, &selected_set))
}

// ============================================================================
// Multi-Buffer Registry Commands
// ============================================================================

/// List all buffers in the registry
#[tauri::command(rename_all = "snake_case")]
pub async fn list_buffers() -> Result<Vec<BufferMetadata>, String> {
    Ok(buffer_store::list_buffers())
}

/// Delete a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn delete_buffer(buffer_id: String) -> Result<(), String> {
    buffer_store::delete_buffer(&buffer_id)
}

/// Get metadata for a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_metadata_by_id(buffer_id: String) -> Result<Option<BufferMetadata>, String> {
    Ok(buffer_store::get_buffer_metadata(&buffer_id))
}

/// Get frames from a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_by_id(buffer_id: String) -> Result<Vec<FrameMessage>, String> {
    buffer_store::get_buffer_frames(&buffer_id)
        .ok_or_else(|| format!("Buffer '{}' not found or is not a frame buffer", buffer_id))
}

/// Get raw bytes from a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_bytes_by_id(buffer_id: String) -> Result<Vec<TimestampedByte>, String> {
    buffer_store::get_buffer_bytes(&buffer_id)
        .ok_or_else(|| format!("Buffer '{}' not found or is not a byte buffer", buffer_id))
}

/// Set a specific buffer as active (for legacy single-buffer compatibility)
#[tauri::command(rename_all = "snake_case")]
pub async fn set_active_buffer(buffer_id: String) -> Result<(), String> {
    buffer_store::set_active_buffer(&buffer_id)
}

/// Create a new frame buffer from frames passed from the frontend.
/// Used when accepting client-side framing to persist the framed data.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_frame_buffer_from_frames(
    name: String,
    frames: Vec<FrameMessage>,
) -> Result<BufferMetadata, String> {
    if frames.is_empty() {
        return Err("No frames to create buffer from".to_string());
    }

    // Create a new frame buffer
    let buffer_id = buffer_store::create_buffer(buffer_store::BufferType::Frames, name);

    // Append the frames
    buffer_store::append_frames(frames);

    // Finalize and return metadata
    buffer_store::finalize_buffer()
        .ok_or_else(|| format!("Failed to finalize buffer '{}'", buffer_id))
}

/// Get a page of frames from a specific buffer by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_frames_paginated_by_id(
    buffer_id: String,
    offset: usize,
    limit: usize,
) -> Result<PaginatedFramesResponse, String> {
    let (frames, buffer_indices, total_count) = buffer_store::get_buffer_frames_paginated(&buffer_id, offset, limit);
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

/// Get a page of bytes from the active buffer (for serial discovery)
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_bytes_paginated(
    offset: usize,
    limit: usize,
) -> Result<PaginatedBytesResponse, String> {
    let buffer_id = buffer_store::get_active_buffer_id()
        .ok_or_else(|| "No active buffer".to_string())?;

    let (bytes, total_count) = buffer_store::get_buffer_bytes_paginated(&buffer_id, offset, limit);
    Ok(PaginatedBytesResponse {
        bytes,
        total_count,
        offset,
        limit,
    })
}

/// Get the total byte count from the active buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_bytes_count() -> Result<usize, String> {
    let buffer_id = buffer_store::get_active_buffer_id()
        .ok_or_else(|| "No active buffer".to_string())?;

    Ok(buffer_store::get_buffer_count(&buffer_id))
}

/// Get bytes from a specific buffer by ID with pagination
#[tauri::command(rename_all = "snake_case")]
pub async fn get_buffer_bytes_paginated_by_id(
    buffer_id: String,
    offset: usize,
    limit: usize,
) -> Result<PaginatedBytesResponse, String> {
    let (bytes, total_count) = buffer_store::get_buffer_bytes_paginated(&buffer_id, offset, limit);
    Ok(PaginatedBytesResponse {
        bytes,
        total_count,
        offset,
        limit,
    })
}

/// Find the byte offset at or after the given timestamp in the active byte buffer.
/// Uses binary search for O(log n) performance.
#[tauri::command(rename_all = "snake_case")]
pub async fn find_buffer_bytes_offset_for_timestamp(
    target_time_us: u64,
) -> Result<usize, String> {
    // Use buffer_store's efficient in-place binary search (no data copy)
    Ok(buffer_store::find_buffer_bytes_offset_for_timestamp(target_time_us))
}

// ============================================================================
// Session-Aware Buffer Commands
// ============================================================================

/// List only orphaned buffers (no owning session).
/// These are buffers available for standalone selection in the IO picker.
/// Includes CSV imports and buffers from destroyed sessions.
#[tauri::command(rename_all = "snake_case")]
pub async fn list_orphaned_buffers() -> Vec<BufferMetadata> {
    buffer_store::list_orphaned_buffers()
}
