// ui/src-tauri/src/io/timeline/postgres.rs
//
// PostgreSQL Reader - streams historical CAN data from a PostgreSQL database.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use std::collections::VecDeque;
use std::time::Duration;
use tauri::AppHandle;
use tokio_postgres::{NoTls, Row};

use super::base::{TimelineControl, TimelineReaderState};
use crate::io::{
    emit_frames, emit_to_session, FrameMessage, IOCapabilities, IODevice, IOState,
    PlaybackPosition, StreamEndedPayload,
};
use crate::buffer_store::{self, BufferType};

/// PostgreSQL connection configuration
#[derive(Clone, Debug)]
pub struct PostgresConfig {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: Option<String>,
    pub sslmode: Option<String>,
}

impl PostgresConfig {
    /// Build connection string for tokio-postgres
    pub fn to_connection_string(&self) -> String {
        let mut parts = vec![
            format!("host={}", self.host),
            format!("port={}", self.port),
            format!("dbname={}", self.database),
            format!("user={}", self.username),
        ];

        if let Some(ref pw) = self.password {
            parts.push(format!("password={}", pw));
        }

        if let Some(ref ssl) = self.sslmode {
            parts.push(format!("sslmode={}", ssl));
        }

        parts.join(" ")
    }
}

/// Source type for PostgreSQL queries
#[derive(Clone, Debug, Default, PartialEq)]
pub enum PostgresSourceType {
    #[default]
    CanFrame,
    ModbusFrame,
    SerialFrame,
    SerialRaw,
}

impl PostgresSourceType {
    pub fn from_str(s: &str) -> Self {
        match s {
            "modbus_frame" => Self::ModbusFrame,
            "serial_frame" => Self::SerialFrame,
            "serial_raw" => Self::SerialRaw,
            _ => Self::CanFrame, // Default
        }
    }
}

/// PostgreSQL reader options for filtering and pacing
#[derive(Clone, Debug)]
pub struct PostgresReaderOptions {
    pub source_type: PostgresSourceType, // Which table/schema to query
    pub start: Option<String>,           // ISO-8601 start time
    pub end: Option<String>,             // ISO-8601 end time
    pub limit: Option<i64>,              // Maximum frames to read
    pub speed: f64,                      // Playback speed multiplier (0 = no limit, 1.0 = realtime)
    pub batch_size: i32,                 // Cursor fetch size
}

impl Default for PostgresReaderOptions {
    fn default() -> Self {
        Self {
            source_type: PostgresSourceType::CanFrame,
            start: None,
            end: None,
            limit: None,
            speed: 0.0, // 0 = no limit (no pacing)
            batch_size: 1000,
        }
    }
}

/// PostgreSQL Reader - streams historical CAN data from a PostgreSQL database
pub struct PostgresReader {
    app: AppHandle,
    config: PostgresConfig,
    options: PostgresReaderOptions,
    /// Common timeline reader state (control, state, session_id, task_handle)
    reader_state: TimelineReaderState,
}

impl PostgresReader {
    pub fn new(
        app: AppHandle,
        session_id: String,
        config: PostgresConfig,
        options: PostgresReaderOptions,
    ) -> Self {
        let speed = options.speed;
        Self {
            app,
            config,
            options,
            reader_state: TimelineReaderState::new(session_id, speed),
        }
    }
}

#[async_trait]
impl IODevice for PostgresReader {
    fn capabilities(&self) -> IOCapabilities {
        IOCapabilities::timeline_can().with_time_range(true)
    }

    async fn start(&mut self) -> Result<(), String> {
        self.reader_state.check_can_start()?;
        self.reader_state.prepare_start();

        let app = self.app.clone();
        let session_id = self.reader_state.session_id.clone();
        let config = self.config.clone();
        let options = self.options.clone();
        let control = self.reader_state.control.clone();

        let handle = spawn_postgres_stream(app, session_id, config, options, control);
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
        self.reader_state.set_speed(speed, "PostgreSQL")
    }

    fn set_time_range(
        &mut self,
        start: Option<String>,
        end: Option<String>,
    ) -> Result<(), String> {
        let state = self.reader_state.state();
        let session_id = self.reader_state.session_id();
        eprintln!(
            "[PostgreSQL:{}] set_time_range called - state: {:?}, start: {:?}, end: {:?}",
            session_id,
            state,
            start,
            end
        );
        if state == IOState::Running || state == IOState::Paused {
            eprintln!(
                "[PostgreSQL:{}] Cannot change time range while streaming (state: {:?})",
                session_id,
                state
            );
            return Err("Cannot change time range while streaming".to_string());
        }
        self.options.start = start.clone();
        self.options.end = end.clone();
        eprintln!(
            "[PostgreSQL:{}] Time range updated - start: {:?}, end: {:?}",
            session_id,
            start,
            end
        );
        Ok(())
    }

    fn state(&self) -> IOState {
        self.reader_state.state()
    }

    fn session_id(&self) -> &str {
        self.reader_state.session_id()
    }

    fn device_type(&self) -> &'static str {
        "postgres"
    }
}

/// Spawn a PostgreSQL reader task with scoped events and pause support.
fn spawn_postgres_stream(
    app_handle: AppHandle,
    session_id: String,
    config: PostgresConfig,
    options: PostgresReaderOptions,
    control: TimelineControl,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            run_postgres_stream(app_handle.clone(), session_id.clone(), config, options, control)
                .await
        {
            emit_to_session(
                &app_handle,
                "can-bytes-error",
                &session_id,
                format!("PostgreSQL error: {}", e),
            );
            // Ensure stream-ended is emitted on error (run_postgres_stream may have already emitted it)
            // Check if streaming flag is still set (indicates stream-ended wasn't emitted yet)
            if buffer_store::is_streaming() {
                emit_stream_ended(&app_handle, &session_id, "error");
            }
        }
    })
}

/// Helper to emit stream-ended event with buffer info
fn emit_stream_ended(app_handle: &AppHandle, session_id: &str, reason: &str) {
    // Finalize the buffer and get metadata
    let metadata = buffer_store::finalize_buffer();

    let (buffer_id, buffer_type, count, time_range, buffer_available) = match metadata {
        Some(ref m) => {
            let type_str = match m.buffer_type {
                BufferType::Frames => "frames",
                BufferType::Bytes => "bytes",
            };
            (
                Some(m.id.clone()),
                Some(type_str.to_string()),
                m.count,
                match (m.start_time_us, m.end_time_us) {
                    (Some(start), Some(end)) => Some((start, end)),
                    _ => None,
                },
                m.count > 0,
            )
        }
        None => (None, None, 0, None, false),
    };

    emit_to_session(
        app_handle,
        "stream-ended",
        session_id,
        StreamEndedPayload {
            reason: reason.to_string(),
            buffer_available,
            buffer_id,
            buffer_type,
            count,
            time_range,
        },
    );
    eprintln!(
        "[PostgreSQL:{}] Stream ended (reason: {}, count: {})",
        session_id,
        reason,
        count
    );
}

async fn run_postgres_stream(
    app_handle: AppHandle,
    session_id: String,
    config: PostgresConfig,
    options: PostgresReaderOptions,
    control: TimelineControl,
) -> Result<(), Box<dyn std::error::Error>> {
    // Create a new frame buffer for this PostgreSQL session
    let buffer_name = format!("PostgreSQL {}:{}/{}", config.host, config.port, config.database);
    let _buffer_id = buffer_store::create_buffer(BufferType::Frames, buffer_name);

    // Track stream end reason
    let mut stream_reason = "complete";

    // Connect to PostgreSQL
    let conn_str = config.to_connection_string();
    eprintln!(
        "[PostgreSQL:{}] Connecting to {}:{}/{}",
        session_id, config.host, config.port, config.database
    );

    let (mut client, connection) = match tokio_postgres::connect(&conn_str, NoTls).await {
        Ok(conn) => conn,
        Err(e) => {
            stream_reason = "error";
            emit_stream_ended(&app_handle, &session_id, stream_reason);
            return Err(format!(
                "Failed to connect to PostgreSQL at {}:{}/{}: {}",
                config.host, config.port, config.database, e
            ).into());
        }
    };

    // Spawn connection handler
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    // Build query based on source type
    let query = build_query(&options);

    eprintln!(
        "[PostgreSQL:{}] Executing query with cursor: {}",
        session_id, query
    );

    // Start a transaction for the cursor
    let transaction = match client.transaction().await {
        Ok(tx) => tx,
        Err(e) => {
            stream_reason = "error";
            emit_stream_ended(&app_handle, &session_id, stream_reason);
            return Err(format!("Failed to start transaction: {}", e).into());
        }
    };

    // Create a portal (cursor) for streaming results
    let portal = match transaction.bind(&query, &[]).await {
        Ok(p) => p,
        Err(e) => {
            stream_reason = "error";
            emit_stream_ended(&app_handle, &session_id, stream_reason);
            return Err(format!("Failed to bind query: {}", e).into());
        }
    };

    eprintln!(
        "[PostgreSQL:{}] Cursor created, starting frame-by-frame streaming...",
        session_id
    );

    // Buffer settings
    const BUFFER_SIZE: usize = 2000; // Keep 2000 frames in buffer
    const REFILL_THRESHOLD: usize = 200; // Refill when buffer drops below this
    const HIGH_SPEED_BATCH_SIZE: usize = 50; // Max batch size for high-speed emission
    const MIN_DELAY_MS: f64 = 1.0; // Below this, batch frames instead of sleeping
    const PACING_INTERVAL_MS: u64 = 50; // Check pacing every 50ms of wall-clock time
    const NO_LIMIT_BATCH_SIZE: usize = 50; // Batch size for no-limit mode (matches frontend throttling threshold)
    const NO_LIMIT_YIELD_MS: u64 = 2; // Yield to UI event loop in no-limit mode (2ms per 50 frames)

    let mut frame_queue: VecDeque<FrameMessage> = VecDeque::new();
    let mut total_fetched = 0i64;
    let mut total_emitted = 0i64;
    let mut db_exhausted = false;

    // Helper to refill the buffer from database
    async fn refill_buffer(
        transaction: &tokio_postgres::Transaction<'_>,
        portal: &tokio_postgres::Portal,
        frame_queue: &mut VecDeque<FrameMessage>,
        total_fetched: &mut i64,
        db_exhausted: &mut bool,
        batch_size: i32,
        target_size: usize,
        source_type: &PostgresSourceType,
    ) -> Result<(), Box<dyn std::error::Error>> {
        while frame_queue.len() < target_size && !*db_exhausted {
            let rows = transaction
                .query_portal(portal, batch_size)
                .await
                .map_err(|e| format!("Failed to fetch from cursor: {}", e))?;

            if rows.is_empty() {
                *db_exhausted = true;
                break;
            }

            for row in rows.iter() {
                match parse_row_for_source_type(row, source_type) {
                    Ok(frame) => {
                        frame_queue.push_back(frame);
                        *total_fetched += 1;
                    }
                    Err(e) => {
                        eprintln!("[PostgreSQL] Failed to parse row: {}", e);
                    }
                }
            }
        }
        Ok(())
    }

    // Initial buffer fill
    eprintln!("[PostgreSQL:{}] Initial buffer fill...", session_id);
    if let Err(e) = refill_buffer(
        &transaction,
        &portal,
        &mut frame_queue,
        &mut total_fetched,
        &mut db_exhausted,
        options.batch_size,
        BUFFER_SIZE,
        &options.source_type,
    )
    .await
    {
        stream_reason = "error";
        emit_stream_ended(&app_handle, &session_id, stream_reason);
        return Err(e);
    }

    if frame_queue.is_empty() {
        eprintln!("[PostgreSQL:{}] No frames to emit", session_id);
        emit_stream_ended(&app_handle, &session_id, stream_reason);
        return Ok(());
    }

    eprintln!(
        "[PostgreSQL:{}] Initial fill complete: {} frames buffered",
        session_id,
        frame_queue.len()
    );

    // Get stream start time from first frame (absolute timestamp in seconds)
    let stream_start_secs = frame_queue
        .front()
        .map(|f| f.timestamp_us as f64 / 1_000_000.0)
        .unwrap_or(0.0);

    // Track the last frame's timestamp for calculating inter-frame delays
    let mut last_frame_time_secs: Option<f64> = None;

    // High-speed batch buffer for when delays are < 1ms
    let mut batch_buffer: Vec<FrameMessage> = Vec::new();

    // Track wall-clock time vs playback time for proper pacing
    // These are reset when speed changes to avoid a flood of frames
    let mut wall_clock_baseline = std::time::Instant::now();
    let mut playback_baseline_secs = stream_start_secs;
    let mut last_speed = control.read_speed();
    let mut last_pacing_check = std::time::Instant::now();

    eprintln!(
        "[PostgreSQL:{}] Starting stream (limit: {:?}, speed: {}x, frames buffered: {})",
        session_id, options.limit, options.speed, frame_queue.len()
    );

    loop {
        // Check if cancelled - break immediately, don't drain buffer
        // Draining buffered frames during cancellation can race with window close
        // and cause crashes on macOS 26.2+ (WebKit::WebPageProxy::dispatchSetObscuredContentInsets)
        if control.is_cancelled() {
            eprintln!("[PostgreSQL:{}] Stream cancelled, stopping immediately (discarding {} buffered frames)", session_id, frame_queue.len());
            break;
        }

        // Check if paused - sleep briefly and check again
        if control.is_paused() {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }

        // Check if pacing is enabled (speed > 0)
        let is_pacing = control.is_pacing_enabled();
        let current_speed = control.read_speed();

        // Log pacing state changes periodically (every 1000 frames)
        if total_emitted % 1000 == 0 {
            eprintln!("[PostgreSQL:{}] frame {} - is_pacing: {}, speed: {}x", session_id, total_emitted, is_pacing, current_speed);
        }

        // Check for speed change and reset timing baseline if needed
        if is_pacing && (current_speed - last_speed).abs() > 0.001 {
            // Speed changed - reset baseline to current position
            if let Some(last_time) = last_frame_time_secs {
                playback_baseline_secs = last_time;
                wall_clock_baseline = std::time::Instant::now();
            }
            last_speed = current_speed;
        }

        // Proactive pacing: before processing more frames, check if we're ahead of schedule
        // This prevents runaway frame accumulation at high speeds
        // Skip entirely if pacing is disabled (no limit mode)
        if is_pacing {
            if let Some(last_time) = last_frame_time_secs {
                let playback_elapsed_secs = last_time - playback_baseline_secs;
                let expected_wall_time_ms = (playback_elapsed_secs * 1000.0 / current_speed) as u64;
                let actual_wall_time_ms = wall_clock_baseline.elapsed().as_millis() as u64;

                // If we're more than 100ms ahead of schedule, wait to catch up
                if expected_wall_time_ms > actual_wall_time_ms + 100 {
                    let wait_ms = expected_wall_time_ms - actual_wall_time_ms;
                    tokio::time::sleep(Duration::from_millis(wait_ms.min(500))).await;
                }
            }
        }

        // Refill buffer if running low
        if frame_queue.len() < REFILL_THRESHOLD && !db_exhausted {
            refill_buffer(
                &transaction,
                &portal,
                &mut frame_queue,
                &mut total_fetched,
                &mut db_exhausted,
                options.batch_size,
                BUFFER_SIZE,
                &options.source_type,
            )
            .await?;
        }

        // Get next frame
        let frame = match frame_queue.pop_front() {
            Some(f) => f,
            None => {
                if db_exhausted {
                    eprintln!("[PostgreSQL:{}] All frames emitted", session_id);
                    break;
                }
                // Buffer empty but DB not exhausted - wait and try again
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
        };

        // Calculate this frame's timestamp in seconds
        let frame_time_secs = frame.timestamp_us as f64 / 1_000_000.0;

        // Calculate playback time as absolute epoch microseconds
        // (frontend expects absolute time, not relative to stream start)
        let playback_time_us = (frame_time_secs * 1_000_000.0) as i64;

        // When pacing is disabled, use maximum batch size and emit without delays
        if !is_pacing {
            batch_buffer.push(frame);
            total_emitted += 1;
            last_frame_time_secs = Some(frame_time_secs);

            // Emit batch when full (use larger batch for no-limit mode)
            if batch_buffer.len() >= NO_LIMIT_BATCH_SIZE {
                // Buffer frames for replay
                buffer_store::append_frames(batch_buffer.clone());

                emit_frames(&app_handle, &session_id, batch_buffer.clone());
                batch_buffer.clear();

                // Emit playback time with the batch
                emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: (total_emitted - 1) as usize, // Index of last emitted frame
                });

                // Brief delay to allow UI event loop to process button clicks
                // 2ms per 1000 frames = 2 seconds total for 1M frames
                tokio::time::sleep(Duration::from_millis(NO_LIMIT_YIELD_MS)).await;
            }
            continue;
        }

        // Calculate delay to this frame based on inter-frame timing (pacing enabled)
        let delay_ms = if let Some(last_time) = last_frame_time_secs {
            let delta_secs = frame_time_secs - last_time;
            (delta_secs * 1000.0 / current_speed).max(0.0)
        } else {
            // First frame - no delay
            0.0
        };

        // Update last frame time
        last_frame_time_secs = Some(frame_time_secs);

        if delay_ms < MIN_DELAY_MS {
            // High-speed mode: batch frames without sleeping
            batch_buffer.push(frame);
            total_emitted += 1;

            // Check if we should emit the batch:
            // 1. Batch is full, OR
            // 2. It's been long enough since last pacing check (time-based pacing)
            let time_since_pacing = last_pacing_check.elapsed().as_millis() as u64;
            let should_emit = batch_buffer.len() >= HIGH_SPEED_BATCH_SIZE
                || time_since_pacing >= PACING_INTERVAL_MS;

            if should_emit && !batch_buffer.is_empty() {
                // Calculate where we should be in wall-clock time (using baseline for speed changes)
                let playback_elapsed_secs = frame_time_secs - playback_baseline_secs;
                let expected_wall_time_ms = (playback_elapsed_secs * 1000.0 / current_speed) as u64;
                let actual_wall_time_ms = wall_clock_baseline.elapsed().as_millis() as u64;

                // If we're ahead of schedule, wait to catch up
                if expected_wall_time_ms > actual_wall_time_ms {
                    let wait_ms = expected_wall_time_ms - actual_wall_time_ms;
                    if wait_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(wait_ms.min(1000))).await;
                    }
                }

                last_pacing_check = std::time::Instant::now();

                // Buffer frames for replay
                buffer_store::append_frames(batch_buffer.clone());

                emit_frames(&app_handle, &session_id, batch_buffer.clone());
                batch_buffer.clear();

                // Emit playback time with the batch
                emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                    timestamp_us: playback_time_us,
                    frame_index: (total_emitted - 1) as usize,
                });

                // Yield to allow event processing (prevents app from becoming unresponsive)
                tokio::task::yield_now().await;

                // Pause check (cancel is handled at loop start)
                if control.is_paused() {
                    // Will be handled at start of next loop iteration
                    continue;
                }
            }
        } else {
            // Normal speed: emit any pending batch first
            if !batch_buffer.is_empty() {
                // Buffer frames for replay
                buffer_store::append_frames(batch_buffer.clone());

                emit_frames(&app_handle, &session_id, batch_buffer.clone());
                batch_buffer.clear();
            }

            // Sleep for the inter-frame delay (cap at 10 seconds to avoid long waits)
            let capped_delay_ms = delay_ms.min(10000.0);
            if capped_delay_ms >= 1.0 {
                tokio::time::sleep(Duration::from_millis(capped_delay_ms as u64)).await;
            }

            // Re-check pause after sleeping (cancel handled at loop start)
            if control.is_paused() {
                // Put frame back and continue (will be re-processed after unpause)
                frame_queue.push_front(frame);
                continue;
            }

            // Emit single frame with active listener filtering
            // Buffer frames for replay
            buffer_store::append_frames(vec![frame.clone()]);

            emit_frames(&app_handle, &session_id, vec![frame]);
            total_emitted += 1;

            // Emit playback time
            emit_to_session(&app_handle, "playback-time", &session_id, PlaybackPosition {
                timestamp_us: playback_time_us,
                frame_index: (total_emitted - 1) as usize,
            });
        }
    }

    // Emit any remaining frames in batch buffer with active listener filtering
    if !batch_buffer.is_empty() {
        // Buffer frames for replay
        buffer_store::append_frames(batch_buffer.clone());

        emit_frames(&app_handle, &session_id, batch_buffer);
    }

    // Check if we were stopped by user
    if control.is_cancelled() {
        stream_reason = "stopped";
    }

    eprintln!(
        "[PostgreSQL:{}] Stream ended (reason: {}, fetched: {}, emitted: {})",
        session_id, stream_reason, total_fetched, total_emitted
    );

    // Emit stream-ended event
    emit_stream_ended(&app_handle, &session_id, stream_reason);

    Ok(())
}

/// Raw byte chunk for serial_raw re-framing
#[derive(Clone, Debug)]
pub struct RawByteChunk {
    pub timestamp_us: u64,
    pub data: Vec<u8>,
}

fn build_where_clause(options: &PostgresReaderOptions) -> String {
    let mut clauses = vec!["1=1".to_string()];

    if let Some(ref start) = options.start {
        clauses.push(format!("ts >= '{}'::timestamptz", start));
    }

    if let Some(ref end) = options.end {
        clauses.push(format!("ts < '{}'::timestamptz", end));
    }

    clauses.join(" AND ")
}

/// Build SQL query based on source type
fn build_query(options: &PostgresReaderOptions) -> String {
    let where_clause = build_where_clause(options);
    let limit_clause = match options.limit {
        Some(n) if n > 0 => format!(" LIMIT {}", n),
        _ => String::new(),
    };

    let (table, columns) = match options.source_type {
        PostgresSourceType::CanFrame => (
            "public.can_frame",
            "ts, id, extended, dlc, is_fd, data_bytes, bus, dir",
        ),
        PostgresSourceType::ModbusFrame => (
            "public.modbus_frame",
            "ts, device_address, function_code, data_bytes, source",
        ),
        PostgresSourceType::SerialFrame => (
            "public.serial_frame",
            "ts, frame_id, data_bytes, framing, source",
        ),
        PostgresSourceType::SerialRaw => (
            "public.serial_raw",
            "ts, data, source",
        ),
    };

    format!(
        "SELECT {} FROM {} WHERE {} ORDER BY ts ASC{}",
        columns, table, where_clause, limit_clause
    )
}

// ============================================================================
// Protocol-Specific Row Parsers
// ============================================================================

fn parse_can_frame_row(row: &Row) -> Result<FrameMessage, Box<dyn std::error::Error>> {
    let ts: DateTime<Utc> = row
        .try_get(0)
        .map_err(|e| format!("Failed to get timestamp (column 0): {}", e))?;
    let arb_id: i32 = row
        .try_get(1)
        .map_err(|e| format!("Failed to get id (column 1): {}", e))?;
    let is_extended: bool = row
        .try_get(2)
        .map_err(|e| format!("Failed to get extended (column 2): {}", e))?;
    let dlc: i16 = row
        .try_get(3)
        .map_err(|e| format!("Failed to get dlc (column 3): {}", e))?;
    let is_fd: bool = row
        .try_get(4)
        .map_err(|e| format!("Failed to get is_fd (column 4): {}", e))?;
    let data_bytes: Vec<u8> = row
        .try_get(5)
        .map_err(|e| format!("Failed to get data_bytes (column 5): {}", e))?;
    let bus: Option<i32> = row
        .try_get(6)
        .map_err(|e| format!("Failed to get bus (column 6): {}", e))?;
    let _dir: Option<String> = row
        .try_get(7)
        .map_err(|e| format!("Failed to get dir (column 7): {}", e))?;

    let timestamp_us = ts.timestamp() as u64 * 1_000_000 + ts.timestamp_subsec_micros() as u64;

    Ok(FrameMessage {
        protocol: "can".to_string(),
        timestamp_us,
        frame_id: arb_id as u32,
        bus: bus.unwrap_or(0) as u8,
        dlc: dlc as u8,
        bytes: data_bytes,
        is_extended,
        is_fd,
        source_address: None,
        incomplete: None,
        direction: None,
    })
}

fn parse_modbus_frame_row(row: &Row) -> Result<FrameMessage, Box<dyn std::error::Error>> {
    let ts: DateTime<Utc> = row
        .try_get(0)
        .map_err(|e| format!("Failed to get timestamp (column 0): {}", e))?;
    let device_address: i16 = row
        .try_get(1)
        .map_err(|e| format!("Failed to get device_address (column 1): {}", e))?;
    let function_code: i16 = row
        .try_get(2)
        .map_err(|e| format!("Failed to get function_code (column 2): {}", e))?;
    let data_bytes: Vec<u8> = row
        .try_get(3)
        .map_err(|e| format!("Failed to get data_bytes (column 3): {}", e))?;
    let _source: Option<String> = row
        .try_get(4)
        .map_err(|e| format!("Failed to get source (column 4): {}", e))?;

    let timestamp_us = ts.timestamp() as u64 * 1_000_000 + ts.timestamp_subsec_micros() as u64;

    // For Modbus, frame_id encodes device_address in high byte and function_code in low byte
    let frame_id = ((device_address as u32) << 8) | (function_code as u32 & 0xFF);

    Ok(FrameMessage {
        protocol: "modbus".to_string(),
        timestamp_us,
        frame_id,
        bus: device_address as u8, // Use device_address as bus for grouping
        dlc: data_bytes.len() as u8,
        bytes: data_bytes,
        is_extended: false,
        is_fd: false,
        source_address: None,
        incomplete: None,
        direction: None,
    })
}

fn parse_serial_frame_row(row: &Row) -> Result<FrameMessage, Box<dyn std::error::Error>> {
    let ts: DateTime<Utc> = row
        .try_get(0)
        .map_err(|e| format!("Failed to get timestamp (column 0): {}", e))?;
    let frame_id: i32 = row
        .try_get(1)
        .map_err(|e| format!("Failed to get frame_id (column 1): {}", e))?;
    let data_bytes: Vec<u8> = row
        .try_get(2)
        .map_err(|e| format!("Failed to get data_bytes (column 2): {}", e))?;
    let _framing: Option<String> = row
        .try_get(3)
        .map_err(|e| format!("Failed to get framing (column 3): {}", e))?;
    let _source: Option<String> = row
        .try_get(4)
        .map_err(|e| format!("Failed to get source (column 4): {}", e))?;

    let timestamp_us = ts.timestamp() as u64 * 1_000_000 + ts.timestamp_subsec_micros() as u64;

    Ok(FrameMessage {
        protocol: "serial".to_string(),
        timestamp_us,
        frame_id: frame_id as u32,
        bus: 0,
        dlc: data_bytes.len() as u8,
        bytes: data_bytes,
        is_extended: false,
        is_fd: false,
        source_address: None, // Not extracted from PostgreSQL serial_frame table
        incomplete: None,
        direction: None,
    })
}

fn parse_serial_raw_row(row: &Row) -> Result<RawByteChunk, Box<dyn std::error::Error>> {
    let ts: DateTime<Utc> = row
        .try_get(0)
        .map_err(|e| format!("Failed to get timestamp (column 0): {}", e))?;
    let data: Vec<u8> = row
        .try_get(1)
        .map_err(|e| format!("Failed to get data (column 1): {}", e))?;
    let _source: Option<String> = row
        .try_get(2)
        .map_err(|e| format!("Failed to get source (column 2): {}", e))?;

    let timestamp_us = ts.timestamp() as u64 * 1_000_000 + ts.timestamp_subsec_micros() as u64;

    Ok(RawByteChunk {
        timestamp_us,
        data,
    })
}

/// Parse a row based on source type - returns FrameMessage for framed types
fn parse_row_for_source_type(
    row: &Row,
    source_type: &PostgresSourceType,
) -> Result<FrameMessage, Box<dyn std::error::Error>> {
    match source_type {
        PostgresSourceType::CanFrame => parse_can_frame_row(row),
        PostgresSourceType::ModbusFrame => parse_modbus_frame_row(row),
        PostgresSourceType::SerialFrame => parse_serial_frame_row(row),
        PostgresSourceType::SerialRaw => {
            // For serial_raw without re-framing, emit each chunk as a frame
            let chunk = parse_serial_raw_row(row)?;
            Ok(FrameMessage {
                protocol: "serial".to_string(),
                timestamp_us: chunk.timestamp_us,
                frame_id: 0, // Raw chunks don't have IDs
                bus: 0,
                dlc: chunk.data.len() as u8,
                bytes: chunk.data,
                is_extended: false,
                is_fd: false,
                source_address: None,
                incomplete: None,
                direction: None,
            })
        }
    }
}
