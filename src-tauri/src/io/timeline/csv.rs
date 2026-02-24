// ui/src-tauri/src/io/timeline/csv.rs
//
// CSV File Reader - streams CAN data from CSV files (GVRET/SavvyCAN format)
// Format: Time Stamp,ID,Extended,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8

use async_trait::async_trait;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::time::Duration;
use tauri::AppHandle;

use super::base::{TimelineControl, TimelineReaderState};
use crate::io::{emit_frames, emit_to_session, FrameMessage, IOCapabilities, IODevice, IOState, PlaybackPosition};

/// CSV reader options for playback control
#[derive(Clone, Debug)]
pub struct CsvReaderOptions {
    pub file_path: String,
    pub speed: f64, // Playback speed multiplier (0 = no limit, 1.0 = realtime)
}

impl Default for CsvReaderOptions {
    fn default() -> Self {
        Self {
            file_path: String::new(),
            speed: 0.0, // 0 = no limit (no pacing)
        }
    }
}

/// CSV File Reader - streams historical CAN data from a CSV file
pub struct CsvReader {
    app: AppHandle,
    options: CsvReaderOptions,
    /// Common timeline reader state (control, state, session_id, task_handle)
    reader_state: TimelineReaderState,
}

impl CsvReader {
    pub fn new(app: AppHandle, session_id: String, options: CsvReaderOptions) -> Self {
        let speed = options.speed;
        Self {
            app,
            options,
            reader_state: TimelineReaderState::new(session_id, speed),
        }
    }
}

#[async_trait]
impl IODevice for CsvReader {
    fn capabilities(&self) -> IOCapabilities {
        IOCapabilities::timeline_can()
    }

    async fn start(&mut self) -> Result<(), String> {
        self.reader_state.check_can_start()?;
        self.reader_state.prepare_start();

        let app = self.app.clone();
        let session_id = self.reader_state.session_id.clone();
        let options = self.options.clone();
        let control = self.reader_state.control.clone();

        let handle = spawn_csv_stream(app, session_id, options, control);
        self.reader_state.mark_running(handle);

        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.reader_state.stop().await;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        self.reader_state.pause()
    }

    async fn resume(&mut self) -> Result<(), String> {
        self.reader_state.resume()
    }

    fn set_speed(&mut self, speed: f64) -> Result<(), String> {
        self.reader_state.set_speed(speed, "CSV")
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        // Could implement time filtering in the future
        Err("CSV reader does not yet support time range filtering".to_string())
    }

    fn state(&self) -> IOState {
        self.reader_state.state()
    }

    fn session_id(&self) -> &str {
        self.reader_state.session_id()
    }
}

// ============================================================================
// Flexible CSV column mapping types (for user-driven import)
// ============================================================================

/// Column role assignment for flexible CSV import
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CsvColumnRole {
    Ignore,
    FrameId,
    Timestamp,
    /// Space-separated hex bytes in one column (e.g., "62 6E 60 77 A9 01 22 35")
    DataBytes,
    /// Individual hex byte column (position determined by column order)
    DataByte,
    Dlc,
    Extended,
    Bus,
    Direction,
}

/// A single column mapping: column index to its assigned role
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CsvColumnMapping {
    pub column_index: usize,
    pub role: CsvColumnRole,
}

/// Timestamp unit for CSV import — determines how raw integer timestamps
/// are converted to microseconds.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimestampUnit {
    Seconds,
    Milliseconds,
    Microseconds,
    Nanoseconds,
}

impl TimestampUnit {
    /// Convert a normalised (non-negative) timestamp in this unit to microseconds.
    /// Returns `None` on overflow.
    fn to_microseconds(self, value: u64) -> Option<u64> {
        match self {
            TimestampUnit::Seconds => value.checked_mul(1_000_000),
            TimestampUnit::Milliseconds => value.checked_mul(1_000),
            TimestampUnit::Microseconds => Some(value),
            TimestampUnit::Nanoseconds => Some(value / 1_000),
        }
    }
}

/// Result of previewing a CSV file
#[derive(Clone, Debug, serde::Serialize)]
pub struct CsvPreview {
    /// Raw header strings (if first row is a header)
    pub headers: Option<Vec<String>>,
    /// First N rows of raw string values
    pub rows: Vec<Vec<String>>,
    /// Total number of data rows in the file (excluding header)
    pub total_rows: usize,
    /// Auto-detected column mappings (user can override)
    pub suggested_mappings: Vec<CsvColumnMapping>,
    /// Whether the first row appears to be a header
    pub has_header: bool,
    /// Auto-detected timestamp unit based on sample data heuristics
    pub suggested_timestamp_unit: TimestampUnit,
    /// Whether the sample timestamps are all negative (suggests negate fix)
    pub has_negative_timestamps: bool,
}

// ============================================================================
// Legacy column indices (for GVRET/SavvyCAN auto-detect path)
// ============================================================================

/// Column indices for CSV parsing - detected from header
#[derive(Debug, Clone)]
struct CsvColumnIndices {
    timestamp: usize,
    id: usize,
    extended: usize,
    dir: Option<usize>,
    bus: usize,
    dlc: usize,
    data_start: usize,
}

impl Default for CsvColumnIndices {
    fn default() -> Self {
        // Default: Time Stamp,ID,Extended,Dir,Bus,LEN,D1,...
        // Matches SavvyCAN/GVRET export format with Dir column
        Self {
            timestamp: 0,
            id: 1,
            extended: 2,
            dir: Some(3),
            bus: 4,
            dlc: 5,
            data_start: 6,
        }
    }
}

/// Parse CSV header and return column indices
fn parse_csv_header(header: &str) -> CsvColumnIndices {
    let parts: Vec<String> = header.split(',').map(|s| s.trim().to_lowercase()).collect();

    let mut indices = CsvColumnIndices::default();

    for (i, col) in parts.iter().enumerate() {
        match col.as_str() {
            "time stamp" | "timestamp" | "time" => indices.timestamp = i,
            "id" => indices.id = i,
            "extended" | "ext" => indices.extended = i,
            "dir" | "direction" => indices.dir = Some(i),
            "bus" => indices.bus = i,
            "len" | "dlc" | "length" => indices.dlc = i,
            "d1" | "data1" | "byte1" => indices.data_start = i,
            _ => {}
        }
    }

    indices
}

/// Parse a GVRET CSV line into a FrameMessage using detected column indices
fn parse_csv_line_with_indices(line: &str, indices: &CsvColumnIndices) -> Option<FrameMessage> {
    let parts: Vec<&str> = line.split(',').collect();

    // Need at least enough columns for data_start
    if parts.len() <= indices.data_start {
        return None;
    }

    let timestamp_us: u64 = parts.get(indices.timestamp)?.trim().parse().ok()?;

    // ID can be hex (with or without 0x prefix) or decimal
    let id_str = parts.get(indices.id)?.trim();
    let frame_id: u32 = if id_str.starts_with("0x") || id_str.starts_with("0X") {
        u32::from_str_radix(&id_str[2..], 16).ok()?
    } else if id_str.chars().all(|c| c.is_ascii_hexdigit()) && id_str.len() == 8 {
        // 8-char hex without prefix (GVRET format)
        u32::from_str_radix(id_str, 16).ok()?
    } else {
        // Try decimal
        id_str.parse().ok()?
    };

    let is_extended = parts.get(indices.extended)
        .map(|s| s.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let bus: u8 = parts.get(indices.bus)
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    let dlc: u8 = parts.get(indices.dlc)
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    // Parse direction if present
    let direction = indices.dir.and_then(|dir_idx| {
        parts.get(dir_idx).map(|s| {
            let dir = s.trim().to_lowercase();
            if dir == "tx" { "tx".to_string() } else { "rx".to_string() }
        })
    });

    // Parse data bytes (D1-D8)
    let mut bytes = Vec::with_capacity(dlc as usize);
    for i in 0..dlc as usize {
        if let Some(byte_str) = parts.get(indices.data_start + i) {
            let byte_str = byte_str.trim();
            if byte_str.is_empty() {
                break;
            }
            // Parse hex byte (with or without 0x)
            let byte_val = if byte_str.starts_with("0x") || byte_str.starts_with("0X") {
                u8::from_str_radix(&byte_str[2..], 16).unwrap_or(0)
            } else {
                u8::from_str_radix(byte_str, 16).unwrap_or(0)
            };
            bytes.push(byte_val);
        }
    }

    Some(FrameMessage {
        protocol: "can".to_string(),
        timestamp_us,
        frame_id,
        bus,
        dlc,
        bytes,
        is_extended,
        is_fd: dlc > 8,
        source_address: None,
        incomplete: None,
        direction,
    })
}


/// Parse an entire CSV file and return all frames
pub fn parse_csv_file(file_path: &str) -> Result<Vec<FrameMessage>, String> {
    let file = File::open(file_path)
        .map_err(|e| format!("Failed to open CSV file '{}': {}", file_path, e))?;
    let reader = BufReader::new(file);

    let mut frames: Vec<FrameMessage> = Vec::new();
    let mut line_number = 0;
    let mut indices: Option<CsvColumnIndices> = None;

    for line_result in reader.lines() {
        line_number += 1;
        let line = line_result.map_err(|e| format!("Failed to read line {}: {}", line_number, e))?;

        // Skip empty lines
        if line.trim().is_empty() {
            continue;
        }

        // Detect header and parse column indices
        if line_number == 1 && (line.to_lowercase().contains("time") || line.to_lowercase().contains("id,")) {
            indices = Some(parse_csv_header(&line));
            continue;
        }

        let col_indices = indices.as_ref().cloned().unwrap_or_default();
        if let Some(frame) = parse_csv_line_with_indices(&line, &col_indices) {
            frames.push(frame);
        }
    }

    Ok(frames)
}

// ============================================================================
// Flexible CSV import (user-driven column mapping)
// ============================================================================

/// Preview a CSV file: read first N rows, detect headers, suggest column mappings.
pub fn preview_csv_file(file_path: &str, max_rows: usize) -> Result<CsvPreview, String> {
    let file = File::open(file_path)
        .map_err(|e| format!("Failed to open CSV file '{}': {}", file_path, e))?;
    let reader = BufReader::new(file);

    let mut all_rows: Vec<Vec<String>> = Vec::new();
    let mut total_lines = 0usize;

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| format!("Read error: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }
        total_lines += 1;
        // Collect preview rows (up to max_rows + 1 for potential header)
        if all_rows.len() <= max_rows {
            let cells: Vec<String> = line.split(',').map(|s| s.trim().to_string()).collect();
            all_rows.push(cells);
        }
    }

    if all_rows.is_empty() {
        return Err("CSV file is empty".to_string());
    }

    let has_header = detect_has_header(&all_rows[0]);

    let (headers, data_rows, total_data_rows) = if has_header {
        let h = all_rows[0].clone();
        let data: Vec<Vec<String>> = all_rows[1..].to_vec();
        (Some(h), data, total_lines - 1)
    } else {
        (None, all_rows.clone(), total_lines)
    };

    // Truncate data_rows to max_rows
    let preview_rows: Vec<Vec<String>> = data_rows.into_iter().take(max_rows).collect();

    // Suggest mappings
    let num_columns = all_rows[0].len();
    let header_slice = if has_header {
        all_rows[0].as_slice()
    } else {
        &[]
    };
    let suggested = suggest_column_mappings(header_slice, &preview_rows, num_columns);

    let ts_col = suggested
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::Timestamp))
        .map(|m| m.column_index);
    let suggested_unit = suggest_timestamp_unit(&preview_rows, ts_col);

    // Detect whether sample timestamps are all negative
    let has_negative_timestamps = ts_col
        .map(|col| {
            let parsed: Vec<i64> = preview_rows
                .iter()
                .filter_map(|row| row.get(col))
                .filter_map(|s| s.parse::<i64>().ok())
                .collect();
            !parsed.is_empty() && parsed.iter().all(|&v| v < 0)
        })
        .unwrap_or(false);

    Ok(CsvPreview {
        headers,
        rows: preview_rows,
        total_rows: total_data_rows,
        suggested_mappings: suggested,
        has_header,
        suggested_timestamp_unit: suggested_unit,
        has_negative_timestamps,
    })
}

/// Parse an entire CSV file using user-provided column mappings.
pub fn parse_csv_with_mapping(
    file_path: &str,
    mappings: &[CsvColumnMapping],
    skip_first_row: bool,
    timestamp_unit: TimestampUnit,
    negate_timestamps: bool,
) -> Result<Vec<FrameMessage>, String> {
    let file = File::open(file_path)
        .map_err(|e| format!("Failed to open CSV file '{}': {}", file_path, e))?;
    let reader = BufReader::new(file);

    // Build role -> column index lookups
    let frame_id_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::FrameId))
        .map(|m| m.column_index);
    let timestamp_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::Timestamp))
        .map(|m| m.column_index);
    let data_bytes_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::DataBytes))
        .map(|m| m.column_index);
    let dlc_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::Dlc))
        .map(|m| m.column_index);
    let extended_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::Extended))
        .map(|m| m.column_index);
    let bus_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::Bus))
        .map(|m| m.column_index);
    let direction_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::Direction))
        .map(|m| m.column_index);

    // Collect individual data byte columns sorted by column index
    let mut data_byte_cols: Vec<usize> = mappings
        .iter()
        .filter(|m| matches!(m.role, CsvColumnRole::DataByte))
        .map(|m| m.column_index)
        .collect();
    data_byte_cols.sort();

    if frame_id_col.is_none() {
        return Err("Column mapping must include at least a Frame ID column".to_string());
    }

    let mut frames: Vec<FrameMessage> = Vec::new();
    let mut line_number = 0usize;
    let mut synthetic_timestamp: u64 = 0;
    // Collect raw i64 timestamps so we can normalise after the loop
    let mut raw_i64_timestamps: Vec<i64> = Vec::new();

    for line_result in reader.lines() {
        line_number += 1;
        let line = line_result
            .map_err(|e| format!("Read error at line {}: {}", line_number, e))?;
        if line.trim().is_empty() {
            continue;
        }
        if line_number == 1 && skip_first_row {
            continue;
        }

        let parts: Vec<&str> = line.split(',').collect();

        // Parse frame ID (required)
        let id_str = match parts.get(frame_id_col.unwrap()) {
            Some(s) => s.trim(),
            None => continue,
        };
        let frame_id = match parse_hex_or_decimal_u32(id_str) {
            Some(id) => id,
            None => continue,
        };

        // Parse timestamp — store as i64 to preserve ordering for negative values.
        // We'll normalise to u64 after collecting all frames.
        let raw_timestamp = if let Some(ts_col) = timestamp_col {
            parts
                .get(ts_col)
                .and_then(|s| s.trim().parse::<i64>().ok())
                .unwrap_or_else(|| {
                    synthetic_timestamp += 1000;
                    synthetic_timestamp as i64
                })
        } else {
            synthetic_timestamp += 1000;
            synthetic_timestamp as i64
        };
        raw_i64_timestamps.push(raw_timestamp);
        // Placeholder — will be corrected after the loop
        let timestamp_us = 0u64;

        // Parse data bytes
        let bytes = if let Some(db_col) = data_bytes_col {
            parts
                .get(db_col)
                .map(|s| parse_space_separated_hex(s.trim()))
                .unwrap_or_default()
        } else if !data_byte_cols.is_empty() {
            data_byte_cols
                .iter()
                .filter_map(|&col| {
                    parts.get(col).and_then(|s| {
                        let s = s.trim();
                        if s.is_empty() {
                            None
                        } else {
                            let stripped = s
                                .strip_prefix("0x")
                                .or_else(|| s.strip_prefix("0X"))
                                .unwrap_or(s);
                            u8::from_str_radix(stripped, 16).ok()
                        }
                    })
                })
                .collect()
        } else {
            Vec::new()
        };

        let dlc = if let Some(dlc_c) = dlc_col {
            parts
                .get(dlc_c)
                .and_then(|s| s.trim().parse::<u8>().ok())
                .unwrap_or(bytes.len() as u8)
        } else {
            bytes.len() as u8
        };

        let is_extended = extended_col
            .and_then(|c| parts.get(c))
            .map(|s| s.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        let bus = bus_col
            .and_then(|c| parts.get(c))
            .and_then(|s| s.trim().parse::<u8>().ok())
            .unwrap_or(0);

        let direction = direction_col.and_then(|c| parts.get(c)).map(|s| {
            if s.trim().eq_ignore_ascii_case("tx") {
                "tx".to_string()
            } else {
                "rx".to_string()
            }
        });

        frames.push(FrameMessage {
            protocol: "can".to_string(),
            timestamp_us,
            frame_id,
            bus,
            dlc,
            bytes,
            is_extended,
            is_fd: dlc > 8,
            source_address: None,
            incomplete: None,
            direction,
        });
    }

    // Normalise timestamps, then convert to microseconds.
    if !raw_i64_timestamps.is_empty() && frames.len() == raw_i64_timestamps.len() {
        if negate_timestamps {
            // Negative timestamps: take the absolute value to recover the real epoch time.
            // Logs that store negative epoch values (e.g., -1767062175875212 for 2025-12-30)
            // simply need their sign stripped — the magnitude IS the epoch timestamp.
            for (i, frame) in frames.iter_mut().enumerate() {
                let raw_us = raw_i64_timestamps[i].unsigned_abs();
                frame.timestamp_us = timestamp_unit
                    .to_microseconds(raw_us)
                    .unwrap_or(u64::MAX);
            }
        } else {
            // Positive/mixed timestamps: offset so the minimum becomes 0.
            let min_ts = raw_i64_timestamps.iter().copied().min().unwrap_or(0);
            for (frame, &raw_ts) in frames.iter_mut().zip(raw_i64_timestamps.iter()) {
                let normalised = (raw_ts - min_ts) as u64;
                frame.timestamp_us = timestamp_unit
                    .to_microseconds(normalised)
                    .unwrap_or(u64::MAX);
            }
        }

        // Sort frames by timestamp to ensure chronological order in the buffer.
        // CSV files may have rows in arbitrary order (e.g., reverse chronological),
        // but the buffer expects ascending timestamp order for correct playback.
        frames.sort_by_key(|f| f.timestamp_us);
    }

    Ok(frames)
}

// ============================================================================
// Auto-detection helpers
// ============================================================================

/// Detect whether the first row looks like a header
fn detect_has_header(first_row: &[String]) -> bool {
    let header_keywords = [
        "id", "time", "timestamp", "stamp", "dlc", "len", "length", "bus", "dir", "direction",
        "ext", "extended", "data", "byte", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8",
    ];
    let lower: Vec<String> = first_row.iter().map(|s| s.to_lowercase()).collect();
    let matches = lower
        .iter()
        .filter(|cell| header_keywords.iter().any(|kw| cell.contains(kw)))
        .count();
    matches >= 2
}

/// Suggest column role mappings based on headers and sample data
fn suggest_column_mappings(
    headers: &[String],
    sample_rows: &[Vec<String>],
    num_columns: usize,
) -> Vec<CsvColumnMapping> {
    let mut mappings = Vec::with_capacity(num_columns);

    // First pass: detect roles per column independently
    for col_idx in 0..num_columns {
        let header = headers.get(col_idx).map(|h| h.to_lowercase());
        let samples: Vec<&str> = sample_rows
            .iter()
            .filter_map(|row| row.get(col_idx).map(|s| s.as_str()))
            .collect();

        let role = guess_column_role(header.as_deref(), &samples);
        mappings.push(CsvColumnMapping {
            column_index: col_idx,
            role,
        });
    }

    // Second pass: disambiguate Bus and DLC from DataByte columns using context.
    // Bus/DLC values ("0", "8") look like hex bytes to the first pass, but they
    // have low cardinality and specific value ranges that distinguish them.

    // Only run Bus/DLC disambiguation when we haven't already detected them via headers
    let mut has_bus = mappings.iter().any(|m| m.role == CsvColumnRole::Bus);
    let mut has_dlc = mappings.iter().any(|m| m.role == CsvColumnRole::Dlc);

    if !has_bus || !has_dlc {
        // Determine expected data length from already-detected columns.
        // If we have a DataBytes column (space-separated hex), count its values.
        let data_bytes_len = mappings.iter()
            .find(|m| m.role == CsvColumnRole::DataBytes)
            .and_then(|m| {
                sample_rows.iter()
                    .filter_map(|row| row.get(m.column_index))
                    .find(|s| !s.is_empty())
                    .map(|s| s.split_whitespace().count())
            });

        // For individual DataByte columns, the raw count includes Bus/DLC
        // candidates. Pre-count metadata candidates (all-decimal, low cardinality,
        // ≤64) so we can subtract them to get the true data byte count.
        let data_byte_indices: Vec<usize> = mappings.iter()
            .filter(|m| m.role == CsvColumnRole::DataByte)
            .map(|m| m.column_index)
            .collect();
        let mut metadata_candidate_count = 0usize;
        for &col_idx in &data_byte_indices {
            let samples: Vec<&str> = sample_rows
                .iter()
                .filter_map(|row| row.get(col_idx).map(|s| s.as_str()))
                .filter(|s| !s.is_empty())
                .collect();
            let parsed: Vec<u64> = samples.iter().filter_map(|s| s.parse::<u64>().ok()).collect();
            if parsed.len() == samples.len() && !parsed.is_empty() {
                let unique: std::collections::HashSet<u64> = parsed.iter().copied().collect();
                if unique.len() <= 3 && parsed.iter().all(|&v| v <= 64) {
                    metadata_candidate_count += 1;
                }
            }
        }
        let actual_data_byte_count = data_byte_indices.len().saturating_sub(metadata_candidate_count);
        let expected_data_len = data_bytes_len.unwrap_or(actual_data_byte_count);

        for mapping in mappings.iter_mut() {
            if mapping.role != CsvColumnRole::DataByte {
                continue;
            }
            let samples: Vec<&str> = sample_rows
                .iter()
                .filter_map(|row| row.get(mapping.column_index).map(|s| s.as_str()))
                .filter(|s| !s.is_empty())
                .collect();
            if samples.is_empty() {
                continue;
            }

            // Parse all values as decimal integers
            let parsed: Vec<u64> = samples.iter().filter_map(|s| s.parse::<u64>().ok()).collect();
            if parsed.len() != samples.len() {
                // Not all values are decimal — likely a real data byte (hex like "A6")
                continue;
            }

            let unique: std::collections::HashSet<u64> = parsed.iter().copied().collect();

            // DLC: values match expected data length (e.g., all "8" when there are 8 data byte cols)
            if !has_dlc && expected_data_len > 0
                && parsed.iter().all(|&v| v <= 64)
                && unique.len() <= 3
                && unique.contains(&(expected_data_len as u64))
            {
                mapping.role = CsvColumnRole::Dlc;
                has_dlc = true;
                continue;
            }

            // Bus: all values 0-3, very low cardinality
            if !has_bus && parsed.iter().all(|&v| v <= 3) && unique.len() <= 3 {
                mapping.role = CsvColumnRole::Bus;
                has_bus = true;
            }
        }
    }

    mappings
}

/// Guess the role of a single column from its header name and sample values
fn guess_column_role(header: Option<&str>, samples: &[&str]) -> CsvColumnRole {
    // 1. Header-based matching (strongest signal)
    if let Some(h) = header {
        if h == "id" || h == "frame_id" || h == "can_id" || h == "arb_id" || h == "arbitration_id"
        {
            return CsvColumnRole::FrameId;
        }
        if h.contains("time") || h.contains("stamp") {
            return CsvColumnRole::Timestamp;
        }
        if h == "dlc" || h == "len" || h == "length" {
            return CsvColumnRole::Dlc;
        }
        if h == "extended" || h == "ext" {
            return CsvColumnRole::Extended;
        }
        if h == "bus" {
            return CsvColumnRole::Bus;
        }
        if h == "dir" || h == "direction" {
            return CsvColumnRole::Direction;
        }
        // "data bytes", "data", "payload"
        if h.contains("data") && (h.contains("byte") || h.contains("payload")) {
            return CsvColumnRole::DataBytes;
        }
        // d1, d2... or byte1, byte2... or data1, data2...
        if h.starts_with('d') && h.len() <= 3 && h[1..].chars().all(|c| c.is_ascii_digit()) {
            return CsvColumnRole::DataByte;
        }
        if (h.starts_with("byte") || h.starts_with("data"))
            && h.chars()
                .skip_while(|c| c.is_alphabetic())
                .all(|c| c.is_ascii_digit())
        {
            return CsvColumnRole::DataByte;
        }
    }

    // 2. Content-based matching
    if samples.is_empty() {
        return CsvColumnRole::Ignore;
    }

    let non_empty: Vec<&&str> = samples.iter().filter(|s| !s.is_empty()).collect();
    if non_empty.is_empty() {
        return CsvColumnRole::Ignore;
    }

    // Space-separated hex bytes (e.g., "62 6E 60 77 A9 01 22 35")
    let space_hex_count = non_empty
        .iter()
        .filter(|s| {
            let parts: Vec<&str> = s.split_whitespace().collect();
            parts.len() >= 2
                && parts
                    .iter()
                    .all(|p| p.len() <= 2 && u8::from_str_radix(p, 16).is_ok())
        })
        .count();
    if space_hex_count > non_empty.len() / 2 {
        return CsvColumnRole::DataBytes;
    }

    // Frame ID: 3-8 char hex strings (e.g., "00000286", "142", "1A3")
    // Must be all hex digits, 3-8 chars, and parseable as u32
    let frame_id_count = non_empty
        .iter()
        .filter(|s| {
            let s = s.trim_start_matches("0x").trim_start_matches("0X");
            s.len() >= 3
                && s.len() <= 8
                && s.chars().all(|c| c.is_ascii_hexdigit())
                && u32::from_str_radix(s, 16).is_ok()
        })
        .count();
    if frame_id_count > non_empty.len() / 2 {
        return CsvColumnRole::FrameId;
    }

    // Boolean (true/false) → Extended
    let bool_count = non_empty
        .iter()
        .filter(|s| s.eq_ignore_ascii_case("true") || s.eq_ignore_ascii_case("false"))
        .count();
    if bool_count > non_empty.len() / 2 {
        return CsvColumnRole::Extended;
    }

    // Direction (tx/rx)
    let dir_count = non_empty
        .iter()
        .filter(|s| s.eq_ignore_ascii_case("tx") || s.eq_ignore_ascii_case("rx"))
        .count();
    if dir_count > non_empty.len() / 2 {
        return CsvColumnRole::Direction;
    }

    // Single hex byte (1-2 hex chars, e.g., "A6", "00", "FF")
    let hex_byte_count = non_empty
        .iter()
        .filter(|s| s.len() <= 2 && u8::from_str_radix(s, 16).is_ok())
        .count();
    if hex_byte_count > non_empty.len() / 2 {
        return CsvColumnRole::DataByte;
    }

    // Large numbers → Timestamp
    let large_num_count = non_empty
        .iter()
        .filter(|s| {
            // Handle negative timestamps too
            let s = s.trim_start_matches('-');
            s.parse::<u64>().map(|n| n > 1_000_000).unwrap_or(false)
        })
        .count();
    if large_num_count > non_empty.len() / 2 {
        return CsvColumnRole::Timestamp;
    }

    CsvColumnRole::Ignore
}

/// Parse a hex string (with or without 0x prefix) or decimal into u32
fn parse_hex_or_decimal_u32(s: &str) -> Option<u32> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if s.starts_with("0x") || s.starts_with("0X") {
        u32::from_str_radix(&s[2..], 16).ok()
    } else if s.len() == 8 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        // 8-char hex without prefix (GVRET format)
        u32::from_str_radix(s, 16).ok()
    } else if s.len() <= 4
        && s.chars().all(|c| c.is_ascii_hexdigit())
        && s.chars().any(|c| c.is_ascii_alphabetic())
    {
        // Short hex like "1A3" - has non-decimal chars so must be hex
        u32::from_str_radix(s, 16).ok()
    } else {
        s.parse().ok()
    }
}

/// Parse space-separated hex bytes: "62 6E 60 77" -> [0x62, 0x6E, 0x60, 0x77]
fn parse_space_separated_hex(s: &str) -> Vec<u8> {
    s.split_whitespace()
        .filter_map(|b| {
            let stripped = b
                .strip_prefix("0x")
                .or_else(|| b.strip_prefix("0X"))
                .unwrap_or(b);
            u8::from_str_radix(stripped, 16).ok()
        })
        .collect()
}

/// Analyse sample timestamp values and suggest the most likely unit.
///
/// Computes the median absolute diff between consecutive parsed timestamps,
/// then picks the unit whose implied frame rate falls in the typical CAN bus
/// range (1 Hz – 100 kHz). Iterates finest-to-coarsest to prefer the more
/// granular unit when ambiguous. Defaults to `Microseconds` if no unit fits.
fn suggest_timestamp_unit(
    sample_rows: &[Vec<String>],
    timestamp_col: Option<usize>,
) -> TimestampUnit {
    let col = match timestamp_col {
        Some(c) => c,
        None => return TimestampUnit::Microseconds,
    };

    let timestamps: Vec<i64> = sample_rows
        .iter()
        .filter_map(|row| row.get(col)?.trim().parse::<i64>().ok())
        .collect();

    if timestamps.len() < 2 {
        return TimestampUnit::Microseconds;
    }

    // Absolute differences between consecutive timestamps (skip zero-diff duplicates)
    let mut diffs: Vec<u64> = timestamps
        .windows(2)
        .map(|w| (w[1] - w[0]).unsigned_abs())
        .filter(|&d| d > 0)
        .collect();

    if diffs.is_empty() {
        return TimestampUnit::Microseconds;
    }

    diffs.sort_unstable();
    let median_diff = diffs[diffs.len() / 2];

    // Candidate units from finest to coarsest
    let candidates = [
        (TimestampUnit::Nanoseconds, 1_000_000_000.0),
        (TimestampUnit::Microseconds, 1_000_000.0),
        (TimestampUnit::Milliseconds, 1_000.0),
        (TimestampUnit::Seconds, 1.0),
    ];

    const MIN_RATE: f64 = 1.0;
    const MAX_RATE: f64 = 100_000.0;

    for &(unit, divisor) in &candidates {
        let interval_secs = median_diff as f64 / divisor;
        if interval_secs <= 0.0 {
            continue;
        }
        let rate = 1.0 / interval_secs;
        if rate >= MIN_RATE && rate <= MAX_RATE {
            return unit;
        }
    }

    TimestampUnit::Microseconds
}

/// Spawn a CSV reader task with scoped events and pause support
fn spawn_csv_stream(
    app_handle: AppHandle,
    session_id: String,
    options: CsvReaderOptions,
    control: TimelineControl,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_csv_stream(app_handle.clone(), session_id.clone(), options, control)
            .await
        {
            emit_to_session(
                &app_handle,
                "session-error",
                &session_id,
                format!("CSV error: {}", e),
            );
        }
    })
}

async fn run_csv_stream(
    app_handle: AppHandle,
    session_id: String,
    options: CsvReaderOptions,
    control: TimelineControl,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tlog!(
        "[CSV:{}] Opening file: {}",
        session_id, options.file_path
    );

    // Open and read the file
    let file = File::open(&options.file_path).map_err(|e| {
        format!("Failed to open CSV file '{}': {}", options.file_path, e)
    })?;
    let reader = BufReader::new(file);

    // Parse all frames into memory
    let mut frames: VecDeque<FrameMessage> = VecDeque::new();
    let mut line_number = 0;
    let mut indices: Option<CsvColumnIndices> = None;

    for line_result in reader.lines() {
        line_number += 1;
        let line = line_result.map_err(|e| format!("Failed to read line {}: {}", line_number, e))?;

        // Skip empty lines
        if line.trim().is_empty() {
            continue;
        }

        // Detect header and parse column indices
        if line_number == 1 && (line.to_lowercase().contains("time") || line.to_lowercase().contains("id,")) {
            indices = Some(parse_csv_header(&line));
            tlog!("[CSV:{}] Detected header: {:?}", session_id, indices);
            continue;
        }

        let col_indices = indices.as_ref().cloned().unwrap_or_default();
        if let Some(frame) = parse_csv_line_with_indices(&line, &col_indices) {
            frames.push_back(frame);
        } else {
            tlog!("[CSV:{}] Failed to parse line {}: {}", session_id, line_number, line);
        }
    }

    if frames.is_empty() {
        tlog!("[CSV:{}] No frames found in file", session_id);
        return Ok(());
    }

    tlog!(
        "[CSV:{}] Loaded {} frames from file",
        session_id,
        frames.len()
    );

    // Buffer settings (similar to PostgreSQL reader)
    const HIGH_SPEED_BATCH_SIZE: usize = 50;
    const MIN_DELAY_MS: f64 = 1.0;
    const PACING_INTERVAL_MS: u64 = 50;
    const NO_LIMIT_BATCH_SIZE: usize = 1000;
    const NO_LIMIT_YIELD_MS: u64 = 10;

    let mut total_emitted = 0i64;

    // Get stream start time from first frame
    let stream_start_secs = frames
        .front()
        .map(|f| f.timestamp_us as f64 / 1_000_000.0)
        .unwrap_or(0.0);

    let mut last_frame_time_secs: Option<f64> = None;
    let mut batch_buffer: Vec<FrameMessage> = Vec::new();

    // Track wall-clock time vs playback time for proper pacing
    let mut wall_clock_baseline = std::time::Instant::now();
    let mut playback_baseline_secs = stream_start_secs;
    let mut last_speed = control.read_speed();
    let mut last_pacing_check = std::time::Instant::now();

    tlog!(
        "[CSV:{}] Starting stream (frames: {}, speed: {}x)",
        session_id, frames.len(), options.speed
    );

    while let Some(frame) = frames.pop_front() {
        // Check if cancelled
        if control.is_cancelled() {
            tlog!(
                "[CSV:{}] Stream cancelled, stopping immediately (discarding {} remaining frames)",
                session_id,
                frames.len()
            );
            break;
        }

        // Check if paused
        if control.is_paused() {
            // Put frame back and wait
            frames.push_front(frame);
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }

        let is_pacing = control.is_pacing_enabled();
        let current_speed = control.read_speed();

        // Log pacing state changes periodically
        if total_emitted % 1000 == 0 {
            tlog!(
                "[CSV:{}] frame {} - is_pacing: {}, speed: {}x",
                session_id, total_emitted, is_pacing, current_speed
            );
        }

        // Check for speed change and reset timing baseline
        if is_pacing && (current_speed - last_speed).abs() > 0.001 {
            if let Some(last_time) = last_frame_time_secs {
                playback_baseline_secs = last_time;
                wall_clock_baseline = std::time::Instant::now();
            }
            last_speed = current_speed;
        }

        // Proactive pacing check
        if is_pacing {
            if let Some(last_time) = last_frame_time_secs {
                let playback_elapsed_secs = last_time - playback_baseline_secs;
                let expected_wall_time_ms = (playback_elapsed_secs * 1000.0 / current_speed) as u64;
                let actual_wall_time_ms = wall_clock_baseline.elapsed().as_millis() as u64;

                if expected_wall_time_ms > actual_wall_time_ms + 100 {
                    let wait_ms = expected_wall_time_ms - actual_wall_time_ms;
                    tokio::time::sleep(Duration::from_millis(wait_ms.min(500))).await;
                }
            }
        }

        let frame_time_secs = frame.timestamp_us as f64 / 1_000_000.0;
        let playback_time_us = (frame_time_secs * 1_000_000.0) as i64;

        // When pacing is disabled, use maximum batch size
        if !is_pacing {
            batch_buffer.push(frame);
            total_emitted += 1;
            last_frame_time_secs = Some(frame_time_secs);

            if batch_buffer.len() >= NO_LIMIT_BATCH_SIZE {
                emit_frames(&app_handle, &session_id, batch_buffer.clone());
                batch_buffer.clear();

                emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: (total_emitted - 1) as usize,
                    frame_count: Some(total_emitted as usize),
                });

                tokio::time::sleep(Duration::from_millis(NO_LIMIT_YIELD_MS)).await;
            }
            continue;
        }

        // Calculate delay based on inter-frame timing (pacing enabled)
        let delay_ms = if let Some(last_time) = last_frame_time_secs {
            let delta_secs = frame_time_secs - last_time;
            (delta_secs * 1000.0 / current_speed).max(0.0)
        } else {
            0.0
        };

        last_frame_time_secs = Some(frame_time_secs);

        if delay_ms < MIN_DELAY_MS {
            // High-speed mode: batch frames
            batch_buffer.push(frame);
            total_emitted += 1;

            let time_since_pacing = last_pacing_check.elapsed().as_millis() as u64;
            let should_emit = batch_buffer.len() >= HIGH_SPEED_BATCH_SIZE
                || time_since_pacing >= PACING_INTERVAL_MS;

            if should_emit && !batch_buffer.is_empty() {
                let playback_elapsed_secs = frame_time_secs - playback_baseline_secs;
                let expected_wall_time_ms = (playback_elapsed_secs * 1000.0 / current_speed) as u64;
                let actual_wall_time_ms = wall_clock_baseline.elapsed().as_millis() as u64;

                if expected_wall_time_ms > actual_wall_time_ms {
                    let wait_ms = expected_wall_time_ms - actual_wall_time_ms;
                    if wait_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(wait_ms.min(1000))).await;
                    }
                }

                last_pacing_check = std::time::Instant::now();

                emit_frames(&app_handle, &session_id, batch_buffer.clone());
                batch_buffer.clear();

                emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: (total_emitted - 1) as usize,
                    frame_count: Some(total_emitted as usize),
                });

                tokio::task::yield_now().await;
            }
        } else {
            // Normal speed: emit any pending batch first
            if !batch_buffer.is_empty() {
                emit_frames(&app_handle, &session_id, batch_buffer.clone());
                batch_buffer.clear();
            }

            // Sleep for inter-frame delay (cap at 10 seconds)
            let capped_delay_ms = delay_ms.min(10000.0);
            if capped_delay_ms >= 1.0 {
                tokio::time::sleep(Duration::from_millis(capped_delay_ms as u64)).await;
            }

            // Re-check pause after sleeping
            if control.is_paused() {
                frames.push_front(frame);
                continue;
            }

            // Emit single frame with active listener filtering
            emit_frames(&app_handle, &session_id, vec![frame]);
            total_emitted += 1;

            emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                timestamp_us: playback_time_us,
                frame_index: (total_emitted - 1) as usize,
                frame_count: Some(total_emitted as usize),
            });
        }
    }

    // Emit any remaining frames in batch buffer with active listener filtering
    if !batch_buffer.is_empty() {
        emit_frames(&app_handle, &session_id, batch_buffer);
    }

    tlog!(
        "[CSV:{}] Stream ended (reason: complete, count: {})",
        session_id, total_emitted
    );

    Ok(())
}
