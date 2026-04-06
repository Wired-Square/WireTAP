// ui/src-tauri/src/io/recorded/csv.rs
//
// CSV File Source - streams CAN data from CSV files (GVRET/SavvyCAN format)
// Format: Time Stamp,ID,Extended,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8

use async_trait::async_trait;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::time::Duration;
use tauri::AppHandle;

use super::base::{PlaybackControl, RecordedSourceState};
use crate::io::{emit_session_error, signal_frames_ready, signal_playback_position, FrameMessage, IOCapabilities, IOSource, IOState, PlaybackPosition, SignalThrottle};
use crate::capture_store;

/// CSV source options for playback control
#[derive(Clone, Debug)]
pub struct CsvSourceOptions {
    pub file_path: String,
    pub speed: f64, // Playback speed multiplier (0 = no limit, 1.0 = realtime)
}

impl Default for CsvSourceOptions {
    fn default() -> Self {
        Self {
            file_path: String::new(),
            speed: 0.0, // 0 = no limit (no pacing)
        }
    }
}

/// CSV File Source - streams historical CAN data from a CSV file
pub struct CsvSource {
    app: AppHandle,
    options: CsvSourceOptions,
    /// Common recorded source state (control, state, session_id, task_handle)
    reader_state: RecordedSourceState,
}

impl CsvSource {
    pub fn new(app: AppHandle, session_id: String, options: CsvSourceOptions) -> Self {
        let speed = options.speed;
        Self {
            app,
            options,
            reader_state: RecordedSourceState::new(session_id, speed),
        }
    }
}

#[async_trait]
impl IOSource for CsvSource {
    fn capabilities(&self) -> IOCapabilities {
        IOCapabilities::recorded_can()
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
// Delimiter type for flexible column splitting
// ============================================================================

/// Column delimiter for splitting lines into fields
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delimiter {
    Comma,
    Tab,
    Space,
    Semicolon,
}

impl Delimiter {
    /// Return the character used for splitting
    pub fn as_char(self) -> char {
        match self {
            Delimiter::Comma => ',',
            Delimiter::Tab => '\t',
            Delimiter::Space => ' ',
            Delimiter::Semicolon => ';',
        }
    }
}

/// Split a line by the given delimiter.
/// For `Space` delimiter, consecutive spaces are collapsed (like split_whitespace).
fn split_line<'a>(line: &'a str, delimiter: Delimiter) -> Vec<&'a str> {
    if delimiter == Delimiter::Space {
        line.split_whitespace().collect()
    } else {
        line.split(delimiter.as_char()).collect()
    }
}

/// Detect the most likely delimiter from the first few lines of a file.
/// Tries comma, tab, semicolon, space in priority order.
/// Picks the delimiter that produces a consistent column count > 1.
pub fn detect_delimiter(lines: &[&str]) -> Delimiter {
    let candidates = [
        Delimiter::Comma,
        Delimiter::Tab,
        Delimiter::Semicolon,
        Delimiter::Space,
    ];

    for &delim in &candidates {
        let counts: Vec<usize> = lines
            .iter()
            .filter(|l| !l.trim().is_empty())
            .take(10)
            .map(|l| split_line(l, delim).len())
            .collect();

        if counts.is_empty() {
            continue;
        }

        let first = counts[0];
        // All lines must have the same column count, and more than 1 column
        if first > 1 && counts.iter().all(|&c| c == first) {
            return delim;
        }
    }

    // Default to comma
    Delimiter::Comma
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
    /// Combined frame ID and data in one column, separated by # (candump format)
    /// e.g., "689#DEADBEEF0102"
    FrameIdData,
    /// Frame sequence number — used for import ordering only (not stored on the frame)
    Sequence,
}

/// A gap detected in the sequence column during CSV import.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SequenceGap {
    /// Line number in the CSV file where the gap starts (1-based, after header)
    pub line: usize,
    /// Sequence value before the gap
    pub from_seq: u64,
    /// Sequence value after the gap
    pub to_seq: u64,
    /// Estimated number of dropped frames
    pub dropped: u64,
    /// Filename (set by the caller for multi-file imports)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

/// Result of parsing a CSV file with column mappings.
pub struct CsvParseResult {
    pub frames: Vec<FrameMessage>,
    pub sequence_gaps: Vec<SequenceGap>,
    /// First raw sequence value in sorted order (for inter-file gap detection)
    pub first_seq: Option<u64>,
    /// Last raw sequence value in sorted order (for inter-file gap detection)
    pub last_seq: Option<u64>,
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
    /// Detected or user-specified delimiter
    pub delimiter: Delimiter,
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
pub fn preview_csv_file(file_path: &str, max_rows: usize, delimiter: Option<Delimiter>) -> Result<CsvPreview, String> {
    let file = File::open(file_path)
        .map_err(|e| format!("Failed to open file '{}': {}", file_path, e))?;
    let reader = BufReader::new(file);

    // Read all lines first (we need a few to auto-detect delimiter)
    let mut raw_lines: Vec<String> = Vec::new();
    let mut total_lines = 0usize;

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| format!("Read error: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }
        total_lines += 1;
        if raw_lines.len() <= max_rows {
            raw_lines.push(line);
        }
    }

    if raw_lines.is_empty() {
        return Err("File is empty".to_string());
    }

    // Auto-detect delimiter if not specified
    let delim = delimiter.unwrap_or_else(|| {
        let line_refs: Vec<&str> = raw_lines.iter().map(|s| s.as_str()).collect();
        detect_delimiter(&line_refs)
    });

    // Split lines into cells using the detected delimiter
    let all_rows: Vec<Vec<String>> = raw_lines
        .iter()
        .map(|line| split_line(line, delim).iter().map(|s| s.trim().to_string()).collect())
        .collect();

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
                .filter_map(|s| parse_timestamp_string(s).map(|f| f as i64))
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
        delimiter: delim,
    })
}

/// Parse an entire CSV file using user-provided column mappings.
pub fn parse_csv_with_mapping(
    file_path: &str,
    mappings: &[CsvColumnMapping],
    skip_first_row: bool,
    timestamp_unit: TimestampUnit,
    negate_timestamps: bool,
    delimiter: Delimiter,
) -> Result<CsvParseResult, String> {
    let file = File::open(file_path)
        .map_err(|e| format!("Failed to open file '{}': {}", file_path, e))?;
    let reader = BufReader::new(file);

    // Build role -> column index lookups
    let frame_id_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::FrameId))
        .map(|m| m.column_index);
    let frame_id_data_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::FrameIdData))
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
    let sequence_col = mappings
        .iter()
        .find(|m| matches!(m.role, CsvColumnRole::Sequence))
        .map(|m| m.column_index);

    // Collect individual data byte columns sorted by column index
    let mut data_byte_cols: Vec<usize> = mappings
        .iter()
        .filter(|m| matches!(m.role, CsvColumnRole::DataByte))
        .map(|m| m.column_index)
        .collect();
    data_byte_cols.sort();

    if frame_id_col.is_none() && frame_id_data_col.is_none() {
        return Err("Column mapping must include a Frame ID or Frame ID + Data column".to_string());
    }

    let mut frames: Vec<FrameMessage> = Vec::new();
    let mut line_number = 0usize;
    let mut synthetic_timestamp: u64 = 0;
    // Collect raw f64 timestamps so we can normalise after the loop (supports float seconds)
    let mut raw_f64_timestamps: Vec<f64> = Vec::new();
    // Collect raw sequence numbers for sort ordering (handles wraparound)
    let mut raw_sequences: Vec<Option<u64>> = Vec::new();
    // Track CSV line numbers per frame (for gap reporting)
    let mut frame_line_numbers: Vec<usize> = Vec::new();
    // Whether timestamps are float seconds (auto-detected from first parsed timestamp)
    let mut ts_is_float = false;
    let mut ts_float_detected = false;

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

        let parts: Vec<&str> = split_line(&line, delimiter);

        // Parse frame ID and data — either from separate columns or combined FrameIdData
        let (frame_id, frame_id_data_bytes) = if let Some(fid_col) = frame_id_data_col {
            // Combined id#data column (candump format)
            let combined = match parts.get(fid_col) {
                Some(s) => s.trim(),
                None => continue,
            };
            match parse_frame_id_data(combined) {
                Some(result) => result,
                None => continue,
            }
        } else {
            // Separate frame ID column
            let id_str = match parts.get(frame_id_col.unwrap()) {
                Some(s) => s.trim(),
                None => continue,
            };
            match parse_hex_or_decimal_u32(id_str) {
                Some(id) => (id, None),
                None => continue,
            }
        };

        // Parse timestamp — supports both integer and float (e.g., candump seconds with decimals).
        // Strip surrounding parentheses for candump format: (0000000000.005000)
        let raw_timestamp = if let Some(ts_col) = timestamp_col {
            let raw_str = parts.get(ts_col).map(|s| s.trim()).unwrap_or("");
            // Strip parentheses: "(1234.567)" -> "1234.567"
            let cleaned = raw_str
                .strip_prefix('(')
                .and_then(|s| s.strip_suffix(')'))
                .unwrap_or(raw_str);

            if let Some(ts) = parse_timestamp_string(cleaned) {
                // Detect if this is a float timestamp on first successful parse
                if !ts_float_detected {
                    ts_is_float = cleaned.contains('.');
                    ts_float_detected = true;
                }
                ts
            } else {
                synthetic_timestamp += 1000;
                synthetic_timestamp as f64
            }
        } else {
            synthetic_timestamp += 1000;
            synthetic_timestamp as f64
        };
        raw_f64_timestamps.push(raw_timestamp);
        // Parse sequence number (used for sort ordering only)
        let seq_value = sequence_col
            .and_then(|col| parts.get(col))
            .and_then(|s| s.trim().parse::<u64>().ok());
        raw_sequences.push(seq_value);
        // Placeholder — will be corrected after the loop
        let timestamp_us = 0u64;

        // Parse data bytes — FrameIdData provides bytes directly, otherwise use other columns
        let bytes = if let Some(ref fid_bytes) = frame_id_data_bytes {
            fid_bytes.clone()
        } else if let Some(db_col) = data_bytes_col {
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

        let is_extended = if let Some(ext_c) = extended_col {
            parts
                .get(ext_c)
                .map(|s| s.trim().eq_ignore_ascii_case("true"))
                .unwrap_or(false)
        } else {
            // For candump: extended if frame_id > 0x7FF
            frame_id > 0x7FF
        };

        let bus = bus_col
            .and_then(|c| parts.get(c))
            .and_then(|s| {
                let trimmed = s.trim();
                // Try parsing as number first, then extract trailing digits from interface name (e.g., "vcan0" -> 0)
                trimmed.parse::<u8>().ok().or_else(|| {
                    trimmed
                        .chars()
                        .rev()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                        .parse::<u8>()
                        .ok()
                })
            })
            .unwrap_or(0);

        let direction = direction_col.and_then(|c| parts.get(c)).map(|s| {
            if s.trim().eq_ignore_ascii_case("tx") {
                "tx".to_string()
            } else {
                "rx".to_string()
            }
        });

        frame_line_numbers.push(line_number);
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
    if !raw_f64_timestamps.is_empty() && frames.len() == raw_f64_timestamps.len() {
        if ts_is_float {
            // Float seconds (e.g., candump format: 0000000000.005000)
            // Offset so minimum becomes 0, then convert to microseconds.
            let min_ts = raw_f64_timestamps.iter().cloned().fold(f64::INFINITY, f64::min);
            for (frame, &raw_ts) in frames.iter_mut().zip(raw_f64_timestamps.iter()) {
                let offset_secs = if negate_timestamps {
                    raw_ts.abs() - min_ts.abs()
                } else {
                    raw_ts - min_ts
                };
                frame.timestamp_us = (offset_secs * 1_000_000.0).round() as u64;
            }
        } else if negate_timestamps {
            // Negative integer timestamps: take the absolute value to recover the real epoch time.
            for (i, frame) in frames.iter_mut().enumerate() {
                let raw_us = (raw_f64_timestamps[i].abs()) as u64;
                frame.timestamp_us = timestamp_unit
                    .to_microseconds(raw_us)
                    .unwrap_or(u64::MAX);
            }
        } else {
            // Positive/mixed integer timestamps: offset so the minimum becomes 0.
            let min_ts = raw_f64_timestamps.iter().cloned().fold(f64::INFINITY, f64::min);
            for (frame, &raw_ts) in frames.iter_mut().zip(raw_f64_timestamps.iter()) {
                let normalised = (raw_ts - min_ts) as u64;
                frame.timestamp_us = timestamp_unit
                    .to_microseconds(normalised)
                    .unwrap_or(u64::MAX);
            }
        }

        // Sort frames to ensure correct order in the capture.
        // When a sequence column is mapped, use unwrapped sequence as the primary sort key
        // (handles counter wraparound, e.g. 16-bit: 65534, 65535, 0, 1, 2) with timestamp
        // as a tiebreaker. Otherwise, sort by timestamp alone.
        if raw_sequences.iter().any(|s| s.is_some()) {
            // Unwrap sequence numbers: detect wraparound and add epoch offsets.
            let mut unwrapped: Vec<u64> = Vec::with_capacity(raw_sequences.len());
            let mut epoch: u64 = 0;
            let mut prev: Option<u64> = None;
            for seq in &raw_sequences {
                match (*seq, prev) {
                    (Some(cur), Some(p)) if cur < p / 2 => {
                        // Wraparound detected — advance epoch
                        epoch += p + 1;
                        unwrapped.push(epoch + cur);
                        prev = Some(cur);
                    }
                    (Some(cur), _) => {
                        unwrapped.push(epoch + cur);
                        prev = Some(cur);
                    }
                    (None, _) => {
                        unwrapped.push(u64::MAX); // no sequence → sort last
                    }
                }
            }

            let mut indices: Vec<usize> = (0..frames.len()).collect();
            indices.sort_by(|&a, &b| {
                unwrapped[a]
                    .cmp(&unwrapped[b])
                    .then(frames[a].timestamp_us.cmp(&frames[b].timestamp_us))
            });
            frames = indices.iter().map(|&i| frames[i].clone()).collect();
            raw_sequences = indices.iter().map(|&i| raw_sequences[i]).collect();
            frame_line_numbers = indices.iter().map(|&i| frame_line_numbers[i]).collect();
        } else {
            frames.sort_by_key(|f| f.timestamp_us);
        }
    }

    // Detect sequence gaps (dropped frames) by walking consecutive raw sequence values.
    // After sorting, sequences are in order (possibly with wraparound boundaries).
    let mut sequence_gaps = Vec::new();
    {
        let mut prev_seq: Option<u64> = None;
        for (i, seq) in raw_sequences.iter().enumerate() {
            if let Some(cur) = *seq {
                if let Some(p) = prev_seq {
                    let gap = if cur > p {
                        // Normal increase — gap if more than 1 step
                        cur - p - 1
                    } else if p > 0 && cur < p / 2 {
                        // Wraparound (e.g. 65535 → 0): expect next after wrap is 0
                        // Dropped = cur (since 0 would be no gap, 2 means 0 and 1 were dropped)
                        cur
                    } else {
                        0 // duplicate or minor reorder
                    };

                    if gap > 0 {
                        sequence_gaps.push(SequenceGap {
                            line: frame_line_numbers[i],
                            from_seq: p,
                            to_seq: cur,
                            dropped: gap,
                            filename: None,
                        });
                    }
                }
                prev_seq = Some(cur);
            }
        }
    }

    let first_seq = raw_sequences.iter().find_map(|s| *s);
    let last_seq = raw_sequences.iter().rev().find_map(|s| *s);

    Ok(CsvParseResult {
        frames,
        sequence_gaps,
        first_seq,
        last_seq,
    })
}

// ============================================================================
// Auto-detection helpers
// ============================================================================

/// Detect whether the first row looks like a header
fn detect_has_header(first_row: &[String]) -> bool {
    let header_keywords = [
        "id", "time", "timestamp", "stamp", "dlc", "len", "length", "bus", "dir", "direction",
        "ext", "extended", "data", "byte", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8",
        "seq",
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

    // Third pass: deduplicate unique roles.
    // If multiple columns are detected as FrameId (or Timestamp, Sequence),
    // keep only the first occurrence and set the rest to Ignore.
    for role in [CsvColumnRole::FrameId, CsvColumnRole::Timestamp, CsvColumnRole::Sequence] {
        let mut found = false;
        for mapping in mappings.iter_mut() {
            if mapping.role == role {
                if found {
                    mapping.role = CsvColumnRole::Ignore;
                } else {
                    found = true;
                }
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
        if h == "seq" || h == "sequence" || h == "seqno" || h == "seq_no" || h == "seq_num" {
            return CsvColumnRole::Sequence;
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

    // Combined frame ID + data (candump format: "689#DEADBEEF", "123#0102030405")
    let frame_id_data_count = non_empty
        .iter()
        .filter(|s| {
            if let Some(hash_pos) = s.find('#') {
                let id_part = &s[..hash_pos];
                let data_part = &s[hash_pos + 1..];
                // ID: 1-8 hex chars, Data: even number of hex chars (byte pairs)
                !id_part.is_empty()
                    && id_part.len() <= 8
                    && id_part.chars().all(|c| c.is_ascii_hexdigit())
                    && !data_part.is_empty()
                    && data_part.len() % 2 == 0
                    && data_part.chars().all(|c| c.is_ascii_hexdigit())
            } else {
                false
            }
        })
        .count();
    if frame_id_data_count > non_empty.len() / 2 {
        return CsvColumnRole::FrameIdData;
    }

    // Parenthesised decimal timestamps (candump format: "(0000000000.005000)")
    let paren_ts_count = non_empty
        .iter()
        .filter(|s| {
            let s = s.trim();
            if let Some(inner) = s.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
                inner.parse::<f64>().is_ok()
            } else {
                false
            }
        })
        .count();
    if paren_ts_count > non_empty.len() / 2 {
        return CsvColumnRole::Timestamp;
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

    // Sequence: monotonically increasing decimal integers (with wraparound), not timestamps.
    // Checked before Frame ID so that pure-decimal sequences like "10872" aren't mis-detected as hex IDs.
    let decimal_ints: Vec<u64> = non_empty
        .iter()
        .filter_map(|s| {
            let trimmed = s.trim();
            // Must be pure decimal (no hex letters) to distinguish from Frame ID
            if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
                trimmed.parse::<u64>().ok()
            } else {
                None
            }
        })
        .collect();
    if decimal_ints.len() > non_empty.len() / 2 && decimal_ints.len() >= 3 {
        let max_val = decimal_ints.iter().copied().max().unwrap_or(0);
        let transitions = decimal_ints.len() - 1;
        // Count strictly increasing steps and rare wraparound steps separately.
        // A true sequence has mostly increasing steps with only occasional wraps.
        let mut increasing = 0usize;
        let mut wraps = 0usize;
        for w in decimal_ints.windows(2) {
            if w[1] > w[0] {
                increasing += 1;
            } else if w[0] > 0 && w[1] < w[0] / 2 {
                wraps += 1;
            }
        }
        // >80% strictly increasing, wraps must be rare (<5% of transitions),
        // and max value under 1M (timestamps are typically >1M)
        if increasing > transitions * 8 / 10
            && wraps <= transitions / 20
            && max_val <= 1_000_000
        {
            return CsvColumnRole::Sequence;
        }
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

    // CAN interface names (can0, vcan0, slcan0, etc.) → Bus
    let interface_count = non_empty
        .iter()
        .filter(|s| {
            let s = s.to_lowercase();
            (s.starts_with("can") || s.starts_with("vcan") || s.starts_with("slcan"))
                && s.chars().last().map(|c| c.is_ascii_digit()).unwrap_or(false)
        })
        .count();
    if interface_count > non_empty.len() / 2 {
        return CsvColumnRole::Bus;
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

/// Parse a timestamp string that may be an integer or a float (with optional parentheses stripped).
/// Returns the value as f64.
fn parse_timestamp_string(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    s.parse::<f64>().ok()
}

/// Parse concatenated hex bytes: "DEADBEEF" -> [0xDE, 0xAD, 0xBE, 0xEF]
/// The input must have an even number of hex characters.
fn parse_concatenated_hex(s: &str) -> Vec<u8> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Vec::new();
    }
    (0..s.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Parse a combined frame ID + data column (candump format): "689#DEADBEEF"
/// Returns (frame_id, Some(data_bytes)) on success.
fn parse_frame_id_data(s: &str) -> Option<(u32, Option<Vec<u8>>)> {
    let s = s.trim();
    let hash_pos = s.find('#')?;
    let id_part = &s[..hash_pos];
    let data_part = &s[hash_pos + 1..];

    let frame_id = u32::from_str_radix(id_part, 16).ok()?;
    let bytes = parse_concatenated_hex(data_part);
    Some((frame_id, Some(bytes)))
}

/// Analyse sample timestamp values and suggest the most likely unit.
///
/// Two-pass heuristic:
///
/// 1. **Epoch magnitude check** — if the absolute timestamp values look like
///    Unix epoch values in a specific unit (year 2000–2036), return that unit
///    immediately. This handles the very common case of epoch-based CAN logs
///    and avoids mis-detection when CAN bus bursts produce tiny inter-frame
///    diffs.
///
/// 2. **Frame-rate check** — computes the median absolute diff between
///    consecutive timestamps and picks the unit whose implied frame rate
///    falls in the typical CAN bus range (1 Hz – 100 kHz). Iterates
///    finest-to-coarsest to prefer the more granular unit when ambiguous.
///
/// Defaults to `Microseconds` if neither heuristic matches.
fn suggest_timestamp_unit(
    sample_rows: &[Vec<String>],
    timestamp_col: Option<usize>,
) -> TimestampUnit {
    let col = match timestamp_col {
        Some(c) => c,
        None => return TimestampUnit::Microseconds,
    };

    // If timestamps look like float seconds (contain '.' or are parenthesised),
    // return Seconds immediately — the import path handles float→µs conversion.
    let has_float = sample_rows.iter().any(|row| {
        if let Some(s) = row.get(col) {
            let trimmed = s.trim();
            let inner = trimmed
                .strip_prefix('(')
                .and_then(|s| s.strip_suffix(')'))
                .unwrap_or(trimmed);
            inner.contains('.') && inner.parse::<f64>().is_ok()
        } else {
            false
        }
    });
    if has_float {
        return TimestampUnit::Seconds;
    }

    let timestamps: Vec<i64> = sample_rows
        .iter()
        .filter_map(|row| row.get(col)?.trim().parse::<i64>().ok())
        .collect();

    if timestamps.len() < 2 {
        return TimestampUnit::Microseconds;
    }

    // Candidate units from finest to coarsest
    let candidates: [(TimestampUnit, f64); 4] = [
        (TimestampUnit::Nanoseconds, 1_000_000_000.0),
        (TimestampUnit::Microseconds, 1_000_000.0),
        (TimestampUnit::Milliseconds, 1_000.0),
        (TimestampUnit::Seconds, 1.0),
    ];

    // --- Pass 1: epoch magnitude check ---
    // Plausible Unix epoch range: 2000-01-01 to 2036-01-01 in seconds.
    const EPOCH_MIN: f64 = 946_684_800.0;
    const EPOCH_MAX: f64 = 2_082_758_400.0;

    let mut abs_values: Vec<u64> = timestamps.iter().map(|t| t.unsigned_abs()).collect();
    abs_values.sort_unstable();
    let median_abs = abs_values[abs_values.len() / 2] as f64;

    let mut epoch_match: Option<TimestampUnit> = None;
    for &(unit, divisor) in &candidates {
        let as_secs = median_abs / divisor;
        if as_secs >= EPOCH_MIN && as_secs <= EPOCH_MAX {
            epoch_match = Some(unit);
            break; // Finest matching unit wins
        }
    }
    if let Some(unit) = epoch_match {
        return unit;
    }

    // --- Pass 2: frame-rate heuristic (original logic) ---
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
    options: CsvSourceOptions,
    control: PlaybackControl,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_csv_stream(app_handle.clone(), session_id.clone(), options, control)
            .await
        {
            emit_session_error(
                &session_id,
                format!("CSV error: {}", e),
            );
        }
    })
}

async fn run_csv_stream(
    _app_handle: AppHandle,
    session_id: String,
    options: CsvSourceOptions,
    control: PlaybackControl,
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

    // Pacing settings (shared with capture and PostgreSQL readers)
    use super::pacing::*;

    let mut throttle = SignalThrottle::new();
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
                capture_store::append_frames_to_session(&session_id, std::mem::take(&mut batch_buffer));

                if throttle.should_signal("frames-ready") {
                    signal_frames_ready(&session_id);
                }

                crate::io::store_playback_position(&session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: (total_emitted - 1) as usize,
                    frame_count: Some(total_emitted as usize),
                });
                if throttle.should_signal("playback-position") {
                    signal_playback_position(&session_id);
                }

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

                capture_store::append_frames_to_session(&session_id, std::mem::take(&mut batch_buffer));

                if throttle.should_signal("frames-ready") {
                    signal_frames_ready(&session_id);
                }

                crate::io::store_playback_position(&session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: (total_emitted - 1) as usize,
                    frame_count: Some(total_emitted as usize),
                });
                if throttle.should_signal("playback-position") {
                    signal_playback_position(&session_id);
                }

                tokio::task::yield_now().await;
            }
        } else {
            // Normal speed: store any pending batch first
            if !batch_buffer.is_empty() {
                capture_store::append_frames_to_session(&session_id, std::mem::take(&mut batch_buffer));
                if throttle.should_signal("frames-ready") {
                    signal_frames_ready(&session_id);
                }
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

            // Store single frame
            capture_store::append_frames_to_session(&session_id, vec![frame]);
            total_emitted += 1;

            if throttle.should_signal("frames-ready") {
                signal_frames_ready(&session_id);
            }

            crate::io::store_playback_position(&session_id, PlaybackPosition {
                timestamp_us: playback_time_us,
                frame_index: (total_emitted - 1) as usize,
                frame_count: Some(total_emitted as usize),
            });
            if throttle.should_signal("playback-position") {
                signal_playback_position(&session_id);
            }
        }
    }

    // Store and signal any remaining frames
    if !batch_buffer.is_empty() {
        capture_store::append_frames_to_session(&session_id, batch_buffer);
        throttle.flush();
        signal_frames_ready(&session_id);
    }

    tlog!(
        "[CSV:{}] Stream ended (reason: complete, count: {})",
        session_id, total_emitted
    );

    Ok(())
}
