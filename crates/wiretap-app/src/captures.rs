// ui/crates/wiretap-app/src/captures.rs
//
// Tauri commands for capture management.
// Handles CSV import, capture CRUD, pagination, and multi-capture registry.
//
// NOTE: Tauri command names and their snake_case parameter names (e.g.
// `list_captures`, `capture_id`) are preserved in Stage 1 of the Buffer →
// Capture rename — they are the IPC contract and change atomically in Stage 2.
//
// Schema changes to buffers.db MUST be recorded migrations — see
// docs/capture-db-migrations.md. Never issue ad-hoc DDL from this file.

use tauri::{AppHandle, Emitter};

use crate::{
    blocking::off_runtime,
    capture_store::{self, CaptureMetadata, CaptureFrameInfo, FrameSelection, ProtocolFrames, TimestampedByte, TailResponse},
    io::{self, FrameMessage},
};

/// Result of a CSV import, including capture metadata and any sequence gap diagnostics.
#[derive(Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CsvImportResult {
    pub metadata: CaptureMetadata,
    pub sequence_gaps: Vec<io::SequenceGap>,
    /// Total number of dropped frames estimated from sequence gaps
    pub total_dropped: u64,
    /// Detected sequence wraparound points (raw sequence value at each wrap)
    pub wrap_points: Vec<u64>,
}

/// Response for paginated capture frames
#[derive(Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PaginatedFramesResponse {
    pub frames: Vec<FrameMessage>,
    pub total_count: usize,
    pub offset: usize,
    pub limit: usize,
    /// 1-based original capture position (rowid) for each frame.
    /// Parallel to `frames` — `capture_indices[i]` is the position of `frames[i]`.
    pub capture_indices: Vec<usize>,
}

/// Response for paginated capture bytes
#[derive(Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PaginatedBytesResponse {
    pub bytes: Vec<TimestampedByte>,
    pub total_count: usize,
    pub offset: usize,
    pub limit: usize,
    /// Indices into `bytes` where an idle-gap chunk begins; empty unless a gap was asked for.
    pub chunk_starts: Vec<usize>,
}

/// Where each chunk starts: a byte more than `gap_us` after the byte before it opens one.
fn chunk_starts(bytes: &[TimestampedByte], gap_us: Option<u64>) -> Vec<usize> {
    let Some(gap_us) = gap_us else { return Vec::new() };
    (0..bytes.len())
        .filter(|&i| i == 0 || bytes[i].timestamp_us.saturating_sub(bytes[i - 1].timestamp_us) > gap_us)
        .collect()
}

fn bytes_page(capture_id: &str, offset: usize, limit: usize, chunk_gap_us: Option<u64>) -> Result<PaginatedBytesResponse, String> {
    let (bytes, total_count) = capture_store::get_capture_bytes_paginated(capture_id, offset, limit)?;
    Ok(PaginatedBytesResponse {
        chunk_starts: chunk_starts(&bytes, chunk_gap_us),
        bytes,
        total_count,
        offset,
        limit,
    })
}

// ============================================================================
// CSV Import Commands
// ============================================================================

#[derive(Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CandumpImportResult {
    pub metadata: CaptureMetadata,
    pub skipped: Vec<io::SkippedLine>,
    pub skipped_count: usize,
}

/// Whether every file is a candump log, for the dedicated import.
#[tauri::command(rename_all = "snake_case")]
pub async fn detect_candump(file_paths: Vec<String>) -> Result<bool, String> {
    for path in &file_paths {
        if !io::is_candump_file(path)? {
            return Ok(false);
        }
    }
    Ok(!file_paths.is_empty())
}

/// Import candump logs into one session-owned capture, merged in time order.
#[tauri::command(rename_all = "snake_case")]
pub async fn import_candump(session_id: String, file_paths: Vec<String>) -> Result<CandumpImportResult, String> {
    off_runtime(move || import_candump_files(&session_id, &file_paths)).await
}

fn import_candump_files(session_id: &str, file_paths: &[String]) -> Result<CandumpImportResult, String> {
    let import = io::parse_candump_files(file_paths)?;
    let name = match file_paths {
        [path] => extract_filename(path),
        paths => build_batch_name(paths),
    };
    capture_store::create_session_capture(session_id, capture_store::CaptureKind::Frames, name);
    capture_store::append_frames_to_session(session_id, import.frames);
    let metadata = capture_store::finalize_session_captures(session_id)
        .into_iter()
        .next()
        .ok_or_else(|| "Failed to store frames in capture".to_string())?;
    Ok(CandumpImportResult {
        metadata,
        skipped: import.skipped,
        skipped_count: import.skipped_count,
    })
}

/// Preview a data file: read first N rows, detect delimiter/headers, suggest column mappings
#[tauri::command(rename_all = "snake_case")]
pub async fn preview_csv(
    file_path: String,
    max_rows: Option<usize>,
    delimiter: Option<io::Delimiter>,
) -> Result<io::CsvPreview, String> {
    let max = max_rows.unwrap_or(20);
    off_runtime(move || io::preview_csv_file(&file_path, max, delimiter)).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn preview_csv_timestamps(
    cells: Vec<String>,
    timestamp_unit: io::TimestampUnit,
    negate_timestamps: bool,
) -> io::CsvTimestampPreview {
    io::preview_timestamps(&cells, timestamp_unit, negate_timestamps)
}

/// Import a data file with user-provided column mappings
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "snake_case")]
pub async fn import_csv_with_mapping(
    session_id: String,
    file_path: String,
    mappings: Vec<io::CsvColumnMapping>,
    skip_first_row: bool,
    timestamp_unit: io::TimestampUnit,
    negate_timestamps: bool,
    delimiter: io::Delimiter,
    protocol: Option<io::Protocol>,
) -> Result<CsvImportResult, String> {
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    off_runtime(move || {
        let result = io::parse_csv_with_mapping(&file_path, &mappings, skip_first_row, timestamp_unit, negate_timestamps, delimiter, protocol.unwrap_or_default())?;

        if result.frames.is_empty() {
            return Err("File contains no valid frames with the given column mapping".to_string());
        }

        let sequence_gaps = result.sequence_gaps;
        let total_dropped = sequence_gaps.iter().map(|g| g.dropped).sum();
        let wrap_points = detect_wrap_points(&sequence_gaps);

        capture_store::create_session_capture(&session_id, capture_store::CaptureKind::Frames, filename);
        capture_store::append_frames_to_session(&session_id, result.frames);
        let finalized = capture_store::finalize_session_captures(&session_id);
        let metadata = finalized.into_iter().next()
            .ok_or_else(|| "Failed to store frames in capture".to_string())?;

        Ok(CsvImportResult {
            metadata,
            sequence_gaps,
            total_dropped,
            wrap_points,
        })
    })
    .await
}

/// Import multiple data files with shared column mappings into a single capture.
/// Files are parsed sequentially and concatenated in order.
#[allow(clippy::too_many_arguments)]
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
    protocol: Option<io::Protocol>,
) -> Result<CsvImportResult, String> {
    off_runtime(move || {
        let layout = CsvLayout {
            mappings: &mappings,
            timestamp_unit,
            negate_timestamps,
            delimiter,
            protocol: protocol.unwrap_or_default(),
        };
        import_csv_batch(&session_id, &file_paths, &skip_first_row_per_file, &layout, |progress| {
            let _ = app_handle.emit("csv-import-progress", progress);
        })
    })
    .await
}

/// How every file of a batch is read.
pub struct CsvLayout<'a> {
    pub mappings: &'a [io::CsvColumnMapping],
    pub timestamp_unit: io::TimestampUnit,
    pub negate_timestamps: bool,
    pub delimiter: io::Delimiter,
    pub protocol: io::Protocol,
}

/// The file of a batch about to be parsed.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CsvImportProgress {
    pub file_index: usize,
    pub total_files: usize,
    pub filename: String,
}

/// Import `file_paths` into one capture owned by `session_id`, in order.
/// A file's header flag falls back to false when `skip_first_row_per_file` is shorter.
pub fn import_csv_batch(
    session_id: &str,
    file_paths: &[String],
    skip_first_row_per_file: &[bool],
    layout: &CsvLayout,
    progress: impl Fn(CsvImportProgress),
) -> Result<CsvImportResult, String> {
    if file_paths.is_empty() {
        return Err("No files provided".to_string());
    }

    // Build display name from filenames
    let name = if file_paths.len() == 1 {
        extract_filename(&file_paths[0])
    } else {
        build_batch_name(file_paths)
    };

    // Create a single capture for all files, owned by the session
    let capture_id = capture_store::create_session_capture(session_id, capture_store::CaptureKind::Frames, name);

    let total_files = file_paths.len();
    let mut total_frames: usize = 0;
    let mut all_sequence_gaps: Vec<io::SequenceGap> = Vec::new();
    let mut prev_file_last_seq: Option<u64> = None;
    let mut prev_file_name: Option<String> = None;

    for (i, file_path) in file_paths.iter().enumerate() {
        let fname = extract_filename(file_path);

        progress(CsvImportProgress { file_index: i, total_files, filename: fname.clone() });

        let skip_row = skip_first_row_per_file.get(i).copied().unwrap_or(false);

        let result = io::parse_csv_with_mapping(
            file_path, layout.mappings, skip_row, layout.timestamp_unit, layout.negate_timestamps,
            layout.delimiter, layout.protocol,
        )?;

        total_frames += result.frames.len();

        // Detect inter-file sequence gap (between previous file's last seq and this file's first)
        if let (Some(prev_last), Some(cur_first)) = (prev_file_last_seq, result.first_seq) {
            let gap = inter_file_gap(prev_last, cur_first);
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

        capture_store::append_frames_to_session(session_id, result.frames);
    }

    if total_frames == 0 {
        let _ = capture_store::delete_capture(&capture_id);
        return Err("No valid frames found in any of the selected files".to_string());
    }

    tlog!(
        "[Captures] Batch imported {} files ({} frames) into capture '{}'",
        total_files, total_frames, capture_id
    );

    let total_dropped = all_sequence_gaps.iter().map(|g| g.dropped).sum();
    let wrap_points = detect_wrap_points(&all_sequence_gaps);

    let finalized = capture_store::finalize_session_captures(session_id);
    let metadata = finalized.into_iter().next()
        .ok_or_else(|| "Failed to finalise capture".to_string())?;

    Ok(CsvImportResult {
        metadata,
        sequence_gaps: all_sequence_gaps,
        total_dropped,
        wrap_points,
    })
}

fn inter_file_gap(prev_last: u64, cur_first: u64) -> u64 {
    if cur_first > prev_last {
        cur_first - prev_last - 1
    } else if prev_last > 0 && cur_first < prev_last / 2 {
        // Wraparound
        cur_first
    } else {
        0
    }
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
// Capture Query Commands
// ============================================================================

/// Get the current capture metadata (if any data is loaded)
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_metadata(capture_id: String) -> Result<Option<CaptureMetadata>, String> {
    Ok(capture_store::get_capture_metadata(&capture_id))
}

/// Get all frames from a capture
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_frames(capture_id: String) -> Result<Vec<FrameMessage>, String> {
    all_frames(capture_id).await
}

async fn all_frames(capture_id: String) -> Result<Vec<FrameMessage>, String> {
    off_runtime(move || {
        capture_store::get_capture_frames(&capture_id)?
            .ok_or_else(|| format!("Capture '{}' not found or is not a frame capture", capture_id))
    })
    .await
}

/// Get a page of frames from a capture (for large datasets)
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_frames_paginated(
    capture_id: String,
    offset: usize,
    limit: usize,
) -> Result<PaginatedFramesResponse, String> {
    let (frames, capture_indices, total_count) = capture_store::get_capture_frames_paginated(&capture_id, offset, limit)?;
    Ok(PaginatedFramesResponse {
        frames,
        total_count,
        offset,
        limit,
        capture_indices,
    })
}

/// Get a page of frames from a capture, filtered by selected frames
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_frames_paginated_filtered(
    capture_id: String,
    offset: usize,
    limit: usize,
    selection: Vec<ProtocolFrames>,
) -> Result<PaginatedFramesResponse, String> {
    let selection = FrameSelection::from_groups(selection);
    let (frames, capture_indices, total_count) = capture_store::get_capture_frames_paginated_filtered(&capture_id, offset, limit, &selection)?;
    Ok(PaginatedFramesResponse {
        frames,
        total_count,
        offset,
        limit,
        capture_indices,
    })
}

/// Get the most recent N frames from a capture, optionally filtered by selected frames.
/// Used for "tail mode" during streaming.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_frames_tail(
    capture_id: String,
    limit: usize,
    selection: Vec<ProtocolFrames>,
) -> Result<TailResponse, String> {
    let selection = FrameSelection::from_groups(selection);
    capture_store::get_capture_frames_tail(&capture_id, limit, &selection)
}

/// Get unique frame IDs and their metadata from a capture
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_frame_info(capture_id: String) -> Result<Vec<CaptureFrameInfo>, String> {
    capture_store::get_capture_frame_info(&capture_id)
}

/// Find the offset in the filtered capture for a given timestamp
#[tauri::command(rename_all = "snake_case")]
pub async fn find_capture_offset_for_timestamp(
    capture_id: String,
    timestamp_us: u64,
    selection: Vec<ProtocolFrames>,
) -> Result<usize, String> {
    let selection = FrameSelection::from_groups(selection);
    capture_store::find_capture_offset_for_timestamp(&capture_id, timestamp_us, &selection)
}

// ============================================================================
// Multi-Capture Registry Commands
// ============================================================================

/// List all captures in the registry
#[tauri::command(rename_all = "snake_case")]
pub async fn list_captures() -> Result<Vec<CaptureMetadata>, String> {
    Ok(capture_store::list_captures())
}

/// Delete a specific capture by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn delete_capture(capture_id: String) -> Result<(), String> {
    capture_store::delete_capture(&capture_id)
}

/// Clear a capture's data without deleting the capture.
/// The session keeps its reference and can continue writing new frames.
#[tauri::command(rename_all = "snake_case")]
pub async fn clear_capture(capture_id: String) -> Result<(), String> {
    capture_store::clear_capture(&capture_id)
}

/// Get metadata for a specific capture by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_metadata_by_id(capture_id: String) -> Result<Option<CaptureMetadata>, String> {
    Ok(capture_store::get_capture_metadata(&capture_id))
}

/// Get frames from a specific capture by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_frames_by_id(capture_id: String) -> Result<Vec<FrameMessage>, String> {
    all_frames(capture_id).await
}

/// Get the newest frame per identity from a specific capture by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_latest_frames(capture_id: String) -> Result<Vec<FrameMessage>, String> {
    capture_store::get_capture_latest_frames(&capture_id)?
        .ok_or_else(|| format!("Capture '{}' not found or is not a frame capture", capture_id))
}

/// Get raw bytes from a specific capture by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_bytes_by_id(capture_id: String) -> Result<Vec<TimestampedByte>, String> {
    off_runtime(move || {
        capture_store::get_capture_bytes(&capture_id)?
            .ok_or_else(|| format!("Capture '{}' not found or is not a byte capture", capture_id))
    })
    .await
}

/// Mark a capture as active (being rendered by a UI panel)
#[tauri::command(rename_all = "snake_case")]
pub async fn set_active_capture(capture_id: String) -> Result<(), String> {
    capture_store::mark_capture_active(&capture_id)
}

/// Create a new frame capture from frames passed from the frontend.
/// Used when accepting client-side framing to persist the framed data.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_frame_capture_from_frames(
    session_id: String,
    name: String,
    frames: Vec<FrameMessage>,
) -> Result<CaptureMetadata, String> {
    if frames.is_empty() {
        return Err("No frames to create capture from".to_string());
    }

    let capture_id = capture_store::create_session_capture(&session_id, capture_store::CaptureKind::Frames, name);
    capture_store::append_frames_to_session(&session_id, frames);
    let finalized = capture_store::finalize_session_captures(&session_id);
    finalized.into_iter().next()
        .ok_or_else(|| format!("Failed to finalize capture '{}'", capture_id))
}

/// Get a page of frames from a specific capture by ID
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_frames_paginated_by_id(
    capture_id: String,
    offset: usize,
    limit: usize,
) -> Result<PaginatedFramesResponse, String> {
    let (frames, capture_indices, total_count) = capture_store::get_capture_frames_paginated(&capture_id, offset, limit)?;
    Ok(PaginatedFramesResponse {
        frames,
        total_count,
        offset,
        limit,
        capture_indices,
    })
}

// ============================================================================
// Byte Capture Commands (Serial Discovery)
// ============================================================================

/// Get a page of bytes from a capture (for serial discovery)
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_bytes_paginated(
    capture_id: String,
    offset: usize,
    limit: usize,
    chunk_gap_us: Option<u64>,
) -> Result<PaginatedBytesResponse, String> {
    bytes_page(&capture_id, offset, limit, chunk_gap_us)
}

/// Get the total byte count from a capture
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_bytes_count(capture_id: String) -> Result<usize, String> {
    Ok(capture_store::get_capture_count(&capture_id))
}

/// Get bytes from a specific capture by ID with pagination
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_bytes_paginated_by_id(
    capture_id: String,
    offset: usize,
    limit: usize,
) -> Result<PaginatedBytesResponse, String> {
    bytes_page(&capture_id, offset, limit, None)
}

/// Find the byte offset at or after the given timestamp in a byte capture.
/// Uses binary search for O(log n) performance.
#[tauri::command(rename_all = "snake_case")]
pub async fn find_capture_bytes_offset_for_timestamp(
    capture_id: String,
    target_time_us: u64,
) -> Result<usize, String> {
    capture_store::find_capture_bytes_offset_for_timestamp_by_id(&capture_id, target_time_us)
}

/// Search a specific capture for frames matching a query string.
/// Returns 0-based offsets in the filtered result set.
/// `query` should have whitespace stripped before calling.
#[tauri::command(rename_all = "snake_case")]
pub async fn search_capture_frames(
    capture_id: String,
    query: String,
    search_id: bool,
    search_data: bool,
    selection: Vec<ProtocolFrames>,
) -> Result<Vec<usize>, String> {
    let selection = FrameSelection::from_groups(selection);
    off_runtime(move || crate::capture_db::search_frames(&capture_id, &query, search_id, search_data, &selection)).await
}

/// Response for tail-mode byte capture queries
#[derive(Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct BytesTailResponse {
    pub bytes: Vec<TimestampedByte>,
    pub total_count: usize,
    /// Indices into `bytes` where an idle-gap chunk begins; empty unless a gap was asked for.
    pub chunk_starts: Vec<usize>,
}

/// Get the most recent bytes from a capture (tail view for serial discovery).
///
/// The live view calls this on every byte-count signal, so it must not scan the
/// capture: the rows come from a `ORDER BY rowid DESC LIMIT n` tail and the total
/// from the registry's O(1) counter.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_capture_bytes_tail(
    capture_id: String,
    tail_size: usize,
    chunk_gap_us: Option<u64>,
) -> Result<BytesTailResponse, String> {
    let bytes = capture_store::get_capture_bytes_tail(&capture_id, tail_size)?;
    Ok(BytesTailResponse {
        chunk_starts: chunk_starts(&bytes, chunk_gap_us),
        bytes,
        total_count: capture_store::get_capture_count(&capture_id),
    })
}

// ============================================================================
// Session-Aware Capture Commands
// ============================================================================

/// Rename a capture.
#[tauri::command(rename_all = "snake_case")]
pub async fn rename_capture(capture_id: String, new_name: String) -> Result<CaptureMetadata, String> {
    capture_store::rename_capture(&capture_id, &new_name)
}

/// Set a capture's persistent flag.
/// Persistent captures survive app restart when 'clear captures on start' is enabled.
#[tauri::command(rename_all = "snake_case")]
pub async fn set_capture_persistent(capture_id: String, persistent: bool) -> Result<CaptureMetadata, String> {
    capture_store::set_capture_persistent(&capture_id, persistent)
}

/// List only orphaned captures (no owning session).
/// These are captures available for standalone selection in the IO picker.
/// Includes CSV imports and captures from destroyed sessions.
#[tauri::command(rename_all = "snake_case")]
pub async fn list_orphaned_captures() -> Vec<CaptureMetadata> {
    capture_store::list_orphaned_captures()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gap_between_files_counts_the_sequence_numbers_skipped() {
        assert_eq!(inter_file_gap(10, 11), 0);
        assert_eq!(inter_file_gap(10, 15), 4);
        assert_eq!(inter_file_gap(10, 10), 0);
    }

    #[test]
    fn a_wrap_between_files_counts_only_the_numbers_after_zero() {
        assert_eq!(inter_file_gap(1000, 0), 0);
        assert_eq!(inter_file_gap(1000, 5), 5);
        assert_eq!(inter_file_gap(65_535, 3), 3);
    }

    #[test]
    fn a_short_step_back_between_files_is_no_gap() {
        assert_eq!(inter_file_gap(1000, 600), 0);
        assert_eq!(inter_file_gap(1000, 500), 0);
        assert_eq!(inter_file_gap(1000, 499), 499);
    }

    fn gap(from_seq: u64, to_seq: u64) -> io::SequenceGap {
        io::SequenceGap { line: 1, from_seq, to_seq, dropped: 0, filename: None }
    }

    #[test]
    fn a_wrap_point_is_a_jump_back_below_half_listed_once() {
        let gaps = [gap(10, 15), gap(1000, 3), gap(1000, 400), gap(1000, 600), gap(255, 2)];
        assert_eq!(detect_wrap_points(&gaps), vec![1000, 255]);
        assert!(detect_wrap_points(&[gap(0, 0)]).is_empty());
    }

    #[test]
    fn a_batch_is_named_for_the_common_prefix_of_its_filenames() {
        let paths = |names: &[&str]| names.iter().map(|n| format!("/data/{n}")).collect::<Vec<_>>();
        assert_eq!(build_batch_name(&paths(&["run_01.csv", "run_02.csv"])), "run_0 (2 files)");
        assert_eq!(build_batch_name(&paths(&["log-a.csv", "log-b.csv"])), "log (2 files)");
        assert_eq!(build_batch_name(&paths(&["abcd1.csv", "xyz.csv"])), "2 files merged");
        assert_eq!(build_batch_name(&paths(&["only.csv"])), "only.csv (1 files)");
        assert_eq!(build_batch_name(&[]), "0 files merged");
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ChunkCase {
        name: String,
        gap_us: u64,
        timestamps: Vec<u64>,
        expected_starts: Vec<usize>,
    }

    #[test]
    fn chunk_starts_match_the_byte_view_golden() {
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../frontend/wiretap-ui/src/tests/fixtures/analysis/byteChunks.json"
        );
        let cases: Vec<ChunkCase> =
            serde_json::from_str(&std::fs::read_to_string(fixture).expect("fixture")).expect("cases");
        for case in cases {
            let bytes: Vec<TimestampedByte> = case
                .timestamps
                .iter()
                .map(|&timestamp_us| TimestampedByte { byte: 0, timestamp_us, bus: 0 })
                .collect();
            assert_eq!(chunk_starts(&bytes, Some(case.gap_us)), case.expected_starts, "{}", case.name);
        }
    }

    #[test]
    fn no_gap_means_no_chunks() {
        let bytes = [TimestampedByte { byte: 0, timestamp_us: 0, bus: 0 }];
        assert!(chunk_starts(&bytes, None).is_empty());
    }

    fn csv_batch(name: &str, files: &[(&str, &str)]) -> Vec<String> {
        let dir = std::env::temp_dir().join(format!("wiretap-csv-batch-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        files
            .iter()
            .map(|(file, body)| {
                let path = dir.join(file);
                std::fs::write(&path, body).unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect()
    }

    fn layout(mappings: &[io::CsvColumnMapping]) -> CsvLayout<'_> {
        CsvLayout {
            mappings,
            timestamp_unit: io::TimestampUnit::Microseconds,
            negate_timestamps: false,
            delimiter: io::Delimiter::Comma,
            protocol: io::Protocol::Can,
        }
    }

    fn sequenced() -> Vec<io::CsvColumnMapping> {
        let roles = ["timestamp", "sequence", "frame_id", "data_bytes"];
        let mappings = roles.iter().enumerate().map(|(i, role)| serde_json::json!({ "column_index": i, "role": role }));
        serde_json::from_value(mappings.collect()).expect("mappings")
    }

    #[test]
    fn a_batch_lands_in_one_capture_with_its_gaps_named_by_file() {
        let _db = crate::capture_db::use_own_database();
        let mappings = sequenced();
        let paths = csv_batch(
            "gaps",
            &[
                ("run_a.csv", "100,1,123,01\n200,2,123,02\n300,4,123,03\n"),
                ("run_b.csv", "ts,seq,id,data\n400,7,123,04\n500,8,123,05\n"),
            ],
        );
        let seen = std::cell::RefCell::new(Vec::new());

        let result = import_csv_batch("f_csv_batch_gaps", &paths, &[false, true], &layout(&mappings), |p| seen.borrow_mut().push(p))
            .expect("imported");

        let progress = |file_index, filename: &str| CsvImportProgress { file_index, total_files: 2, filename: filename.into() };
        assert_eq!(*seen.borrow(), [progress(0, "run_a.csv"), progress(1, "run_b.csv")]);
        assert_eq!(result.metadata.count, 5);
        assert_eq!(result.metadata.name, "run (2 files)");
        let gaps: Vec<_> = result.sequence_gaps.iter().map(|g| (g.from_seq, g.to_seq, g.dropped, g.filename.clone())).collect();
        assert_eq!(
            gaps,
            [(2, 4, 1, Some("run_a.csv".into())), (4, 7, 2, Some("run_a.csv → run_b.csv".into()))]
        );
        assert_eq!(result.total_dropped, 3);
        assert!(result.wrap_points.is_empty());
    }

    #[test]
    fn a_missing_header_flag_reads_the_first_row_as_data() {
        let _db = crate::capture_db::use_own_database();
        let mappings = sequenced();
        let paths = csv_batch("flags", &[("one.csv", "100,1,123,01\n"), ("two.csv", "200,2,123,02\n")]);
        let result = import_csv_batch("f_csv_batch_flags", &paths, &[], &layout(&mappings), |_| {}).expect("imported");
        assert_eq!(result.metadata.count, 2);
    }

    #[test]
    fn a_batch_with_no_frames_leaves_no_capture() {
        let _db = crate::capture_db::use_own_database();
        let mappings = sequenced();
        let paths = csv_batch("empty", &[("csv-batch-empty.csv", "")]);
        assert_eq!(
            import_csv_batch("f_csv_batch_empty", &paths, &[false], &layout(&mappings), |_| {}).err(),
            Some("No valid frames found in any of the selected files".into())
        );
        assert!(!capture_store::list_captures().iter().any(|c| c.name == "csv-batch-empty.csv"));

        let called = std::cell::Cell::new(false);
        assert_eq!(
            import_csv_batch("f_csv_batch_none", &[], &[], &layout(&mappings), |_| called.set(true)).err(),
            Some("No files provided".into())
        );
        assert!(!called.get());
    }
}
