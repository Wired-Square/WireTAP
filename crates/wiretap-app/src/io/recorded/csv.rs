// ui/crates/wiretap-app/src/io/recorded/csv.rs
//
// CSV file parsing and import functions.
// Used by the capture import system to parse CSV/CAN dump files into FrameMessages.

use std::fs::File;
use std::io::{BufRead, BufReader};

use wiretap_protocol::candump;

use super::candump::interface_bus;
use crate::io::{FrameMessage, Protocol};

// ============================================================================
// Delimiter type for flexible column splitting
// ============================================================================

/// Column delimiter for splitting lines into fields
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
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
    #[cfg_attr(test, ts(optional))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CsvColumnMapping {
    pub column_index: usize,
    pub role: CsvColumnRole,
}

/// Timestamp unit for CSV import — determines how raw integer timestamps
/// are converted to microseconds.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
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
#[cfg_attr(test, derive(ts_rs::TS))]
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
    pub suggested_protocol: Protocol,
}

// ============================================================================
// Flexible CSV import (user-driven column mapping)
// ============================================================================

/// The SavvyCAN columns have nowhere to carry a protocol, so an export names it
/// as the file stem's last `-` token (`20261001-1243-modbus_rtu.csv`).
fn protocol_named_by_filename(file_path: &str) -> Protocol {
    let stem = std::path::Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    match stem.rsplit('-').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "serial" => Protocol::Serial,
        "modbus" => Protocol::Modbus,
        "modbus_rtu" => Protocol::ModbusRtu,
        _ => Protocol::Can,
    }
}

/// FD is a flag on a CAN frame, not a protocol a frame carries.
fn frame_protocol_name(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Can | Protocol::CanFd => "can",
        Protocol::Modbus => "modbus",
        Protocol::ModbusRtu => "modbus_rtu",
        Protocol::Serial => "serial",
    }
}

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
        suggested_protocol: protocol_named_by_filename(file_path),
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
    protocol: Protocol,
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
        let (frame_id, id_data_frame) = if let Some(fid_col) = frame_id_data_col {
            let Some(cell) = parts.get(fid_col) else {
                continue;
            };
            match candump::parse_frame(cell.trim(), 0) {
                Ok(frame) => (frame.arb_id, Some(frame)),
                Err(_) => continue,
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
        let bytes = if let Some(frame) = &id_data_frame {
            frame.data.clone()
        } else if let Some(db_col) = data_bytes_col {
            parts
                .get(db_col)
                .map(|s| wiretap_decode::hex::parse_bytes_lenient(s))
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
                .and_then(|s| s.trim().parse::<u16>().ok())
                .unwrap_or(bytes.len() as u16)
        } else {
            bytes.len() as u16
        };

        let is_extended = if let Some(ext_c) = extended_col {
            parts
                .get(ext_c)
                .map(|s| s.trim().eq_ignore_ascii_case("true"))
                .unwrap_or(false)
        } else {
            id_data_frame.as_ref().map_or(frame_id > 0x7FF, |f| f.extended)
        };

        let bus = bus_col
            .and_then(|c| parts.get(c))
            .map_or(0, |s| interface_bus(s.trim()));

        let direction = direction_col.and_then(|c| parts.get(c)).map(|s| {
            if s.trim().eq_ignore_ascii_case("tx") {
                "tx".to_string()
            } else {
                "rx".to_string()
            }
        });

        frame_line_numbers.push(line_number);
        frames.push(FrameMessage {
            protocol: frame_protocol_name(protocol).to_string(),
            timestamp_us,
            frame_id,
            bus,
            dlc,
            bytes,
            is_extended,
            is_fd: matches!(protocol, Protocol::Can | Protocol::CanFd)
                && (dlc > 8 || id_data_frame.as_ref().is_some_and(|f| f.fd)),
            source_address: None,
            incomplete: None,
            direction,
            ..Default::default()
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
        if h.starts_with('d') && h[1..].chars().all(|c| c.is_ascii_digit()) {
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

    let frame_id_data_count = non_empty
        .iter()
        .filter(|s| candump::parse_frame(s.trim(), 0).is_ok())
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

/// Parse a timestamp string that may be an integer or a float (with optional parentheses stripped).
/// Returns the value as f64.
fn parse_timestamp_string(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    s.parse::<f64>().ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_numbered_data_header_past_d99_is_a_data_byte_by_its_name() {
        let rising = ["10", "11", "12", "13"];
        for header in ["d99", "d100", "d255"] {
            assert_eq!(guess_column_role(Some(header), &rising), CsvColumnRole::DataByte, "{header}");
        }
    }

    #[test]
    fn a_row_longer_than_255_bytes_keeps_its_length() {
        let path = std::env::temp_dir().join(format!("wiretap-csv-{}.csv", std::process::id()));
        std::fs::write(&path, format!("1,{}\n", "AB".repeat(256))).unwrap();
        let mappings = [
            CsvColumnMapping { column_index: 0, role: CsvColumnRole::FrameId },
            CsvColumnMapping { column_index: 1, role: CsvColumnRole::DataBytes },
        ];

        let parsed = parse_csv_with_mapping(
            path.to_str().unwrap(),
            &mappings,
            false,
            TimestampUnit::Microseconds,
            false,
            Delimiter::Comma,
            Protocol::Can,
        );
        std::fs::remove_file(&path).ok();

        let frame = &parsed.unwrap().frames[0];
        assert_eq!((frame.bytes.len(), frame.dlc), (256, 256));
    }

    fn temp_csv(name: &str, body: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wiretap-csv-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn an_imported_row_carries_the_chosen_protocol() {
        let path = temp_csv(
            "rows.csv",
            "Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8,D9,D10\n\
             100,00000103,false,Rx,0,10,01,03,00,00,00,02,C4,0B,00,00\n",
        );
        let preview = preview_csv_file(path.to_str().unwrap(), 20, None).unwrap();

        let parsed = parse_csv_with_mapping(
            path.to_str().unwrap(),
            &preview.suggested_mappings,
            true,
            TimestampUnit::Microseconds,
            false,
            Delimiter::Comma,
            Protocol::ModbusRtu,
        )
        .unwrap();

        let frame = &parsed.frames[0];
        assert_eq!(frame.protocol, "modbus_rtu");
        assert!(!frame.is_fd, "only a CAN frame is FD");
    }

    #[test]
    fn a_mapped_candump_cell_reads_extended_by_width_and_fd_by_its_flags() {
        let path = temp_csv(
            "mapped.log",
            "(1.000000) can0 00000123#0102\n\
             (1.000100) can1 123##1A5A5A5A5A5A5A5A5A5A5A5A5\n\
             (1.000200) can0 7FF#R\n",
        );
        let preview = preview_csv_file(path.to_str().unwrap(), 20, None).unwrap();
        assert!(preview
            .suggested_mappings
            .iter()
            .any(|m| m.role == CsvColumnRole::FrameIdData));

        let parsed = parse_csv_with_mapping(
            path.to_str().unwrap(),
            &preview.suggested_mappings,
            false,
            TimestampUnit::Microseconds,
            false,
            Delimiter::Space,
            Protocol::Can,
        )
        .unwrap();

        let frames: Vec<_> = parsed
            .frames
            .iter()
            .map(|f| (f.frame_id, f.bus, f.is_extended, f.is_fd, f.bytes.len()))
            .collect();
        assert_eq!(frames, [(0x123, 0, true, false, 2), (0x123, 1, false, true, 12), (0x7FF, 0, false, false, 0)]);
    }

    #[test]
    fn the_preview_seeds_the_protocol_from_the_file_name() {
        let header = "Time Stamp,ID,Extended,Dir,Bus,LEN,D1\n1,00000001,false,Rx,0,1,00\n";
        let seeded = |name: &str| {
            let path = temp_csv(name, header);
            preview_csv_file(path.to_str().unwrap(), 20, None).unwrap().suggested_protocol
        };

        assert_eq!(seeded("20261001-1243-serial.csv"), Protocol::Serial);
        assert_eq!(seeded("20261001-1243-modbus_rtu.csv"), Protocol::ModbusRtu);
        assert_eq!(seeded("pump-MODBUS.csv"), Protocol::Modbus);
        assert_eq!(seeded("trace.csv"), Protocol::Can);
        assert_eq!(seeded("serial-trace.csv"), Protocol::Can);
    }
}
