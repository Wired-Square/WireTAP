// ui/src-tauri/src/io/recorded/backend_api.rs
//
// Backend API Source — streams historical CAN data from the WireTAP backend
// gateway over HTTP (the GET /v1/db/{db}/frames keyset cursor) instead of a
// direct PostgreSQL connection. The pacing / batching / emit loop mirrors
// PostgresSource::run_postgres_stream; the only difference is the fetch path
// (HTTP cursor vs DB portal). The two loops are intentionally kept parallel
// — a future refactor could extract the shared pacing engine (see plan).

use async_trait::async_trait;
use serde::Deserialize;
use std::collections::VecDeque;
use std::time::Duration;
use tauri::AppHandle;

use super::base::{PlaybackControl, RecordedSourceState};
use crate::capture_store::{self, CaptureKind};
use crate::io::{
    emit_capture_changed, emit_session_error, emit_stream_ended, signal_frames_ready,
    signal_playback_position, FrameMessage, IOCapabilities, IOSource, IOState, PlaybackPosition,
    SignalThrottle,
};

/// Connection details for a backend-API source.
#[derive(Clone, Debug)]
pub struct BackendApiConfig {
    pub base_url: String, // e.g. http://gateway:8423 (no trailing slash)
    pub api_key: String,
    pub database: String,
}

/// Filtering / pacing options (parallels PostgresSourceOptions).
#[derive(Clone, Debug)]
pub struct BackendApiSourceOptions {
    pub start: Option<String>,
    pub end: Option<String>,
    pub limit: Option<i64>,
    pub speed: f64,
    pub batch_size: i32,
}

impl Default for BackendApiSourceOptions {
    fn default() -> Self {
        Self { start: None, end: None, limit: None, speed: 0.0, batch_size: 1000 }
    }
}

pub struct BackendApiSource {
    app: AppHandle,
    config: BackendApiConfig,
    options: BackendApiSourceOptions,
    reader_state: RecordedSourceState,
}

impl BackendApiSource {
    pub fn new(
        app: AppHandle,
        session_id: String,
        config: BackendApiConfig,
        options: BackendApiSourceOptions,
    ) -> Self {
        let speed = options.speed;
        Self { app, config, options, reader_state: RecordedSourceState::new(session_id, speed) }
    }
}

#[async_trait]
impl IOSource for BackendApiSource {
    fn capabilities(&self) -> IOCapabilities {
        IOCapabilities::recorded_can().with_time_range(true)
    }

    async fn start(&mut self) -> Result<(), String> {
        self.reader_state.check_can_start()?;
        self.reader_state.prepare_start();

        let session_id = self.reader_state.session_id.clone();

        // Create capture synchronously before spawning (matches PostgresSource)
        let _orphaned = capture_store::orphan_captures_for_session(&session_id);
        let capture_id = capture_store::create_capture(CaptureKind::Frames, session_id.clone());
        let _ = capture_store::set_capture_owner(&capture_id, &session_id);
        emit_capture_changed(&session_id);

        let config = self.config.clone();
        let options = self.options.clone();
        let control = self.reader_state.control.clone();
        let session = session_id.clone();

        let handle = tauri::async_runtime::spawn(async move {
            if let Err(e) = run_api_stream(session.clone(), config, options, control).await {
                emit_session_error(&session, format!("Backend API error: {}", e));
            }
        });
        self.reader_state.mark_running(handle);
        // app handle currently unused beyond construction parity with PostgresSource
        let _ = &self.app;
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
        self.reader_state.set_speed(speed, "BackendAPI")
    }

    fn set_time_range(&mut self, start: Option<String>, end: Option<String>) -> Result<(), String> {
        let state = self.reader_state.state();
        if state == IOState::Running || state == IOState::Paused {
            return Err("Cannot change time range while streaming".to_string());
        }
        self.options.start = start;
        self.options.end = end;
        Ok(())
    }

    fn state(&self) -> IOState {
        self.reader_state.state()
    }

    fn session_id(&self) -> &str {
        self.reader_state.session_id()
    }

    fn source_type(&self) -> &'static str {
        "wiretap"
    }

    async fn prepare_reconfigure(
        &mut self,
        start: Option<String>,
        end: Option<String>,
    ) -> Result<(), String> {
        self.reader_state.stop().await;
        self.options.start = start;
        self.options.end = end;
        Ok(())
    }

    async fn complete_reconfigure(&mut self) -> Result<(), String> {
        self.start().await
    }
}

// ---------------------------------------------------------------------------
// HTTP cursor fetcher
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ApiFrameRow {
    ts_us: i64,
    id: u32,
    extended: bool,
    dlc: u8,
    is_fd: bool,
    bus: u8,
    #[allow(dead_code)]
    dir: String,
    data_hex: String,
}

#[derive(Deserialize)]
struct ApiFrameBatch {
    frames: Vec<ApiFrameRow>,
    next_cursor: Option<String>,
}

/// Owns the HTTP cursor state for one stream (no lifetime coupling — just
/// owned strings — unlike the DB portal, hence a separate loop is cheap).
struct CursorFetcher {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    database: String,
    start: Option<String>,
    end: Option<String>,
    page_size: u32,
    cursor: Option<String>,
    exhausted: bool,
    remaining: Option<i64>, // honours options.limit across pages
}

impl CursorFetcher {
    fn frames_url(&self) -> String {
        let mut url = format!(
            "{}/v1/db/{}/frames?limit={}",
            self.base_url, self.database, self.page_size
        );
        if let Some(s) = &self.start {
            url.push_str(&format!("&start={}", crate::apiclient::urlencoding(s)));
        }
        if let Some(e) = &self.end {
            url.push_str(&format!("&end={}", crate::apiclient::urlencoding(e)));
        }
        if let Some(c) = &self.cursor {
            url.push_str(&format!("&after={}", crate::apiclient::urlencoding(c)));
        }
        url
    }

    /// Fetch the next page; returns parsed frames (empty once exhausted).
    async fn next_page(&mut self) -> Result<Vec<FrameMessage>, String> {
        if self.exhausted || self.remaining == Some(0) {
            return Ok(Vec::new());
        }
        let resp = self
            .client
            .get(self.frames_url())
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| format!("frame fetch failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("frame fetch HTTP {}", resp.status()));
        }
        let batch: ApiFrameBatch =
            resp.json().await.map_err(|e| format!("frame decode failed: {e}"))?;

        self.cursor = batch.next_cursor;
        if self.cursor.is_none() {
            self.exhausted = true;
        }

        let mut frames = Vec::with_capacity(batch.frames.len());
        for row in batch.frames {
            let bytes = hex::decode(&row.data_hex)
                .map_err(|e| format!("bad data_hex '{}': {e}", row.data_hex))?;
            frames.push(FrameMessage {
                protocol: "can".to_string(),
                timestamp_us: row.ts_us as u64,
                frame_id: row.id,
                bus: row.bus,
                dlc: row.dlc,
                bytes,
                is_extended: row.extended,
                is_fd: row.is_fd,
                source_address: None,
                incomplete: None,
                direction: None,
            });
        }
        if let Some(rem) = self.remaining.as_mut() {
            if frames.len() as i64 > *rem {
                frames.truncate(*rem as usize);
                self.exhausted = true;
            }
            *rem -= frames.len() as i64;
        }
        Ok(frames)
    }
}

/// Store the latest playback position and signal it (throttled). Shared by the
/// three emit points in the stream loop below.
fn emit_playback_position(
    session_id: &str,
    playback_time_us: i64,
    total_emitted: i64,
    throttle: &mut SignalThrottle,
) {
    crate::io::store_playback_position(
        session_id,
        PlaybackPosition {
            timestamp_us: playback_time_us,
            frame_index: (total_emitted - 1) as usize,
            frame_count: Some(total_emitted as usize),
        },
    );
    if throttle.should_signal("playback-position") {
        signal_playback_position(session_id);
    }
}

// ---------------------------------------------------------------------------
// Stream loop (parallels run_postgres_stream)
// ---------------------------------------------------------------------------

async fn run_api_stream(
    session_id: String,
    config: BackendApiConfig,
    options: BackendApiSourceOptions,
    control: PlaybackControl,
) -> Result<(), Box<dyn std::error::Error>> {
    const BUFFER_SIZE: usize = 2000;
    const REFILL_THRESHOLD: usize = 200;
    const HIGH_SPEED_BATCH_SIZE: usize = 50;
    const MIN_DELAY_MS: f64 = 1.0;
    const PACING_INTERVAL_MS: u64 = 50;
    const NO_LIMIT_BATCH_SIZE: usize = 50;
    const NO_LIMIT_YIELD_MS: u64 = 2;

    let mut fetcher = CursorFetcher {
        client: reqwest::Client::new(),
        base_url: config.base_url.clone(),
        api_key: config.api_key.clone(),
        database: config.database.clone(),
        start: options.start.clone(),
        end: options.end.clone(),
        page_size: options.batch_size.clamp(1, 5000) as u32,
        cursor: None,
        exhausted: false,
        remaining: options.limit,
    };

    let mut frame_queue: VecDeque<FrameMessage> = VecDeque::new();
    let mut total_emitted = 0i64;

    // Refill helper: pull pages until the buffer reaches target or exhausted
    async fn refill(
        fetcher: &mut CursorFetcher,
        queue: &mut VecDeque<FrameMessage>,
        target: usize,
    ) -> Result<(), String> {
        while queue.len() < target && !fetcher.exhausted {
            let page = fetcher.next_page().await?;
            if page.is_empty() {
                break;
            }
            queue.extend(page);
        }
        Ok(())
    }

    if let Err(e) = refill(&mut fetcher, &mut frame_queue, BUFFER_SIZE).await {
        emit_stream_ended(&session_id, "error", "BackendAPI");
        return Err(e.into());
    }

    if frame_queue.is_empty() {
        tlog!("[BackendAPI:{}] No frames returned from query", session_id);
        emit_stream_ended(&session_id, "complete", "BackendAPI");
        return Ok(());
    }

    let stream_start_secs =
        frame_queue.front().map(|f| f.timestamp_us as f64 / 1_000_000.0).unwrap_or(0.0);
    let mut last_frame_time_secs: Option<f64> = None;
    let mut batch_buffer: Vec<FrameMessage> = Vec::new();
    let mut throttle = SignalThrottle::new();
    let mut wall_clock_baseline = std::time::Instant::now();
    let mut playback_baseline_secs = stream_start_secs;
    let mut last_speed = control.read_speed();
    let mut last_pacing_check = std::time::Instant::now();

    tlog!("[BackendAPI:{}] Streaming (speed: {}x)", session_id, options.speed);

    loop {
        if control.is_cancelled() {
            break;
        }
        if control.is_paused() {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }

        let is_pacing = control.is_pacing_enabled();
        let current_speed = control.read_speed();

        if is_pacing && (current_speed - last_speed).abs() > 0.001 {
            if let Some(last_time) = last_frame_time_secs {
                playback_baseline_secs = last_time;
                wall_clock_baseline = std::time::Instant::now();
            }
            last_speed = current_speed;
        }

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

        if frame_queue.len() < REFILL_THRESHOLD && !fetcher.exhausted {
            refill(&mut fetcher, &mut frame_queue, BUFFER_SIZE).await?;
        }

        let frame = match frame_queue.pop_front() {
            Some(f) => f,
            None => {
                if fetcher.exhausted {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
        };

        let frame_time_secs = frame.timestamp_us as f64 / 1_000_000.0;
        let playback_time_us = (frame_time_secs * 1_000_000.0) as i64;

        if !is_pacing {
            batch_buffer.push(frame);
            total_emitted += 1;
            last_frame_time_secs = Some(frame_time_secs);

            if batch_buffer.len() >= NO_LIMIT_BATCH_SIZE {
                capture_store::append_frames_to_session(&session_id, std::mem::take(&mut batch_buffer));
                if throttle.should_signal("frames-ready") {
                    signal_frames_ready(&session_id);
                }
                emit_playback_position(&session_id, playback_time_us, total_emitted, &mut throttle);
                tokio::time::sleep(Duration::from_millis(NO_LIMIT_YIELD_MS)).await;
            }
            continue;
        }

        let delay_ms = if let Some(last_time) = last_frame_time_secs {
            let delta_secs = frame_time_secs - last_time;
            (delta_secs * 1000.0 / current_speed).max(0.0)
        } else {
            0.0
        };
        last_frame_time_secs = Some(frame_time_secs);

        if delay_ms < MIN_DELAY_MS {
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
                emit_playback_position(&session_id, playback_time_us, total_emitted, &mut throttle);
                tokio::task::yield_now().await;
                if control.is_paused() {
                    continue;
                }
            }
        } else {
            if !batch_buffer.is_empty() {
                capture_store::append_frames_to_session(&session_id, std::mem::take(&mut batch_buffer));
                if throttle.should_signal("frames-ready") {
                    signal_frames_ready(&session_id);
                }
            }
            let capped_delay_ms = delay_ms.min(10000.0);
            if capped_delay_ms >= 1.0 {
                tokio::time::sleep(Duration::from_millis(capped_delay_ms as u64)).await;
            }
            if control.is_paused() {
                frame_queue.push_front(frame);
                continue;
            }
            capture_store::append_frames_to_session(&session_id, vec![frame]);
            total_emitted += 1;
            if throttle.should_signal("frames-ready") {
                signal_frames_ready(&session_id);
            }
            emit_playback_position(&session_id, playback_time_us, total_emitted, &mut throttle);
        }
    }

    if !batch_buffer.is_empty() {
        capture_store::append_frames_to_session(&session_id, batch_buffer);
        throttle.flush();
        signal_frames_ready(&session_id);
    }

    if control.is_cancelled() {
        tlog!("[BackendAPI:{}] Stream cancelled by user (emitted: {})", session_id, total_emitted);
    } else {
        tlog!("[BackendAPI:{}] Stream ended (emitted: {})", session_id, total_emitted);
        emit_stream_ended(&session_id, "complete", "BackendAPI");
    }
    Ok(())
}
