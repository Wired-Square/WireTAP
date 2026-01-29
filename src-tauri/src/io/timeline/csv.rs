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
    eprintln!(
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
            eprintln!("[CSV:{}] Detected header: {:?}", session_id, indices);
            continue;
        }

        let col_indices = indices.as_ref().cloned().unwrap_or_default();
        if let Some(frame) = parse_csv_line_with_indices(&line, &col_indices) {
            frames.push_back(frame);
        } else {
            eprintln!("[CSV:{}] Failed to parse line {}: {}", session_id, line_number, line);
        }
    }

    if frames.is_empty() {
        eprintln!("[CSV:{}] No frames found in file", session_id);
        return Ok(());
    }

    eprintln!(
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

    eprintln!(
        "[CSV:{}] Starting stream (frames: {}, speed: {}x)",
        session_id, frames.len(), options.speed
    );

    while let Some(frame) = frames.pop_front() {
        // Check if cancelled
        if control.is_cancelled() {
            eprintln!(
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
            eprintln!(
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
            });
        }
    }

    // Emit any remaining frames in batch buffer with active listener filtering
    if !batch_buffer.is_empty() {
        emit_frames(&app_handle, &session_id, batch_buffer);
    }

    eprintln!(
        "[CSV:{}] Stream ended (reason: complete, count: {})",
        session_id, total_emitted
    );

    Ok(())
}
