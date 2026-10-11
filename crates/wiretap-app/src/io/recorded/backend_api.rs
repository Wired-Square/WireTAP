// ui/crates/wiretap-app/src/io/recorded/backend_api.rs
//
// Backend API Source — streams one protocol's archive from the WireTAP backend
// gateway over HTTP (the GET /v1/db/{db}/frames keyset cursor). This is the only
// database-backed source; it paces with capture playback's `Pacer`, batching
// less at unlimited speed since its frames arrive a page at a time over HTTP.
//
// A CAN row is a CAN frame. A Modbus row is one whole RTU message, CRC and all,
// with `id` = unit << 8 | function — delivered as `modbus_rtu`, never `modbus`,
// which this app reserves for register polls.

use async_trait::async_trait;
use std::collections::VecDeque;
use std::time::Duration;
use wiretap_gateway::{FrameBatch, FrameBatchRow, Protocol as ArchiveProtocol};

use super::base::{publish_position, Pacer, PlaybackControl, Playout, RecordedSourceState, Unlimited};
use crate::apiclient::{frame_tag, protocol_query};
use crate::capture_store::{self, CaptureKind};
use crate::io::{
    emit_capture_changed, emit_session_error, emit_stream_ended, signal_frames_ready,
    FrameMessage, IOCapabilities, IOSource, IOState, PlaybackPosition, Protocol, SignalThrottle,
    StreamEndReason,
};

/// Connection details for a backend-API source.
#[derive(Clone, Debug)]
pub struct BackendApiConfig {
    pub base_url: String, // e.g. http://gateway:8423 (no trailing slash)
    pub api_key: String,
    pub database: String,
    pub protocol: ArchiveProtocol,
}

/// Filtering / pacing options (pacing and time bounds for a recorded source).
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
    config: BackendApiConfig,
    options: BackendApiSourceOptions,
    reader_state: RecordedSourceState,
}

impl BackendApiSource {
    pub fn new(
        session_id: String,
        config: BackendApiConfig,
        options: BackendApiSourceOptions,
    ) -> Self {
        let speed = options.speed;
        Self { config, options, reader_state: RecordedSourceState::new(session_id, speed) }
    }
}

#[async_trait]
impl IOSource for BackendApiSource {
    fn capabilities(&self) -> IOCapabilities {
        let caps = IOCapabilities::recorded_can().with_time_range(true);
        match self.config.protocol {
            ArchiveProtocol::Can => caps,
            ArchiveProtocol::Modbus => caps.with_protocols(vec![Protocol::ModbusRtu]),
            ArchiveProtocol::Serial => unreachable!("archive_protocol refuses serial"),
        }
    }

    async fn start(&mut self) -> Result<(), String> {
        self.reader_state.check_can_start()?;
        self.reader_state.prepare_start();

        let session_id = self.reader_state.session_id.clone();

        // Create capture synchronously before spawning (recorded sources create theirs in start())
        let _orphaned = capture_store::orphan_captures_for_session(&session_id);
        capture_store::create_session_capture(&session_id, CaptureKind::Frames, session_id.clone());
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

/// Owns the HTTP cursor state for one stream (no lifetime coupling — just
/// owned strings — unlike the DB portal, hence a separate loop is cheap).
struct CursorFetcher {
    client: reqwest::Client,
    base_url: String,
    api_key: String,
    database: String,
    protocol: ArchiveProtocol,
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
            "{}/v1/db/{}/frames?limit={}{}",
            self.base_url,
            self.database,
            self.page_size,
            protocol_query(self.protocol, false)
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
            .map_err(|e| format!("frame fetch failed: {}", crate::apiclient::describe(&e)))?;
        let batch: FrameBatch = crate::apiclient::parse(resp)
            .await
            .map_err(|e| format!("frame fetch failed: {e}"))?;

        self.cursor = batch.next_cursor;
        if self.cursor.is_none() {
            self.exhausted = true;
        }

        let mut frames = batch
            .frames
            .into_iter()
            .map(|row| frame_from_row(self.protocol, row))
            .collect::<Result<Vec<_>, _>>()?;
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

/// The row's `dlc` is the archive's CAN length code, and an older gateway serves
/// no `len`, so the length comes from the payload instead — but for an RTR,
/// whose code is the length it asks for.
fn frame_from_row(protocol: ArchiveProtocol, row: FrameBatchRow) -> Result<FrameMessage, String> {
    let bytes =
        hex::decode(&row.data_hex).map_err(|e| format!("bad data_hex '{}': {e}", row.data_hex))?;
    let dlc = if row.is_rtr {
        wiretap_protocol::dlc_to_len(row.dlc as u8, false)
    } else {
        bytes.len()
    };
    Ok(FrameMessage {
        protocol: frame_tag(protocol).to_string(),
        timestamp_us: row.ts_us as u64,
        frame_id: row.id,
        bus: row.bus,
        dlc: dlc as u16,
        bytes,
        is_extended: row.extended,
        is_fd: row.is_fd,
        is_rtr: row.is_rtr,
        is_brs: row.is_brs,
        is_esi: row.is_esi,
        source_address: None,
        incomplete: None,
        direction: None,
        ..Default::default()
    })
}

/// Played frames land in the session's capture, the position counting them.
struct IntoCapture<'a> {
    session_id: &'a str,
    throttle: SignalThrottle,
}

impl Playout for IntoCapture<'_> {
    fn frames(&mut self, frames: Vec<FrameMessage>) {
        capture_store::append_frames_to_session(self.session_id, frames);
        if self.throttle.should_signal("frames-ready") {
            signal_frames_ready(self.session_id);
        }
    }

    fn position(&mut self, timestamp_us: i64, emitted: i64) {
        let position = PlaybackPosition {
            timestamp_us,
            frame_index: (emitted - 1) as usize,
            frame_count: Some(emitted as usize),
        };
        publish_position(self.session_id, position, &mut self.throttle);
    }
}

// ---------------------------------------------------------------------------
// Stream loop
// ---------------------------------------------------------------------------

async fn run_api_stream(
    session_id: String,
    config: BackendApiConfig,
    options: BackendApiSourceOptions,
    control: PlaybackControl,
) -> Result<(), Box<dyn std::error::Error>> {
    const BUFFER_SIZE: usize = 2000;
    const REFILL_THRESHOLD: usize = 200;
    const UNLIMITED: Unlimited = Unlimited { batch: 50, yield_ms: 2 };

    let mut fetcher = CursorFetcher {
        // The same client the query path uses — one pool for one gateway, and it
        // carries `net::CONNECT_TIMEOUT`, which reqwest needs because it resolves
        // inside itself where `resolve_host_port` cannot reach. Connect only: a
        // page of frames may legitimately take a while to come back.
        client: crate::apiclient::http().clone(),
        base_url: config.base_url.clone(),
        api_key: config.api_key.clone(),
        database: config.database.clone(),
        protocol: config.protocol,
        start: options.start.clone(),
        end: options.end.clone(),
        page_size: options.batch_size.clamp(1, 5000) as u32,
        cursor: None,
        exhausted: false,
        remaining: options.limit,
    };

    let mut frame_queue: VecDeque<FrameMessage> = VecDeque::new();

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
        emit_stream_ended(&session_id, StreamEndReason::Error, "BackendAPI");
        return Err(e.into());
    }

    if frame_queue.is_empty() {
        tlog!("[BackendAPI:{}] No frames returned from query", session_id);
        emit_stream_ended(&session_id, StreamEndReason::Complete, "BackendAPI");
        return Ok(());
    }

    let stream_start_secs =
        frame_queue.front().map(|f| f.timestamp_us as f64 / 1_000_000.0).unwrap_or(0.0);
    let mut pacer = Pacer::new(stream_start_secs, &control, UNLIMITED);
    let mut out = IntoCapture { session_id: &session_id, throttle: SignalThrottle::new() };

    tlog!("[BackendAPI:{}] Streaming (speed: {}x)", session_id, options.speed);

    loop {
        if control.is_cancelled() {
            break;
        }
        if control.is_paused() {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        }

        pacer.keep_time(&control).await;

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

        if let Some(paused) = pacer.play(frame, &control, &mut out).await {
            frame_queue.push_front(paused);
        }
    }

    if !pacer.batch.is_empty() {
        capture_store::append_frames_to_session(&session_id, std::mem::take(&mut pacer.batch));
        out.throttle.flush();
        signal_frames_ready(&session_id);
    }

    if control.is_cancelled() {
        tlog!("[BackendAPI:{}] Stream cancelled by user (emitted: {})", session_id, pacer.emitted);
    } else {
        tlog!("[BackendAPI:{}] Stream ended (emitted: {})", session_id, pacer.emitted);
        emit_stream_ended(&session_id, StreamEndReason::Complete, "BackendAPI");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(json: serde_json::Value) -> FrameBatchRow {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn an_fd_row_takes_its_length_from_the_payload_not_the_length_code() {
        let frame = frame_from_row(
            ArchiveProtocol::Can,
            row(serde_json::json!({
                "ts_us": 1, "id": 0x123, "extended": false, "dlc": 15, "is_fd": true,
                "bus": 0, "dir": "rx", "data_hex": "ab".repeat(64),
            })),
        )
        .unwrap();
        assert_eq!(frame.dlc, 64);
        assert_eq!(frame.bytes.len(), 64);
    }

    fn can_row(extra: serde_json::Value) -> FrameMessage {
        let mut json = serde_json::json!({
            "ts_us": 1, "id": 0x123, "extended": false, "dlc": 0, "is_fd": false,
            "bus": 0, "dir": "rx", "data_hex": "",
        });
        json.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        frame_from_row(ArchiveProtocol::Can, row(json)).unwrap()
    }

    #[test]
    fn a_remote_row_asks_for_its_length_code_with_no_payload() {
        let frame = can_row(serde_json::json!({ "dlc": 4, "is_rtr": true }));
        assert!(frame.is_rtr);
        assert_eq!(frame.dlc, 4);
        assert!(frame.bytes.is_empty());
    }

    #[test]
    fn an_fd_row_keeps_its_brs_and_esi() {
        let frame = can_row(serde_json::json!({
            "dlc": 9, "is_fd": true, "is_brs": true, "is_esi": true, "data_hex": "00".repeat(12),
        }));
        assert!(frame.is_brs && frame.is_esi && !frame.is_rtr);
        assert_eq!(frame.dlc, 12);
    }

    #[test]
    fn a_row_from_an_older_gateway_has_no_flags() {
        let frame = can_row(serde_json::json!({ "dlc": 2, "data_hex": "abcd" }));
        assert!(!frame.is_rtr && !frame.is_brs && !frame.is_esi);
        assert_eq!(frame.dlc, 2);
    }

    /// A gateway serving `pages` in turn, each `(rows, next_cursor)`, that
    /// records the path of every request.
    async fn fake_gateway(
        pages: Vec<(Vec<serde_json::Value>, Option<&'static str>)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        tokio::spawn(async move {
            let mut pages = pages.into_iter();
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0u8; 1];
                    if sock.read(&mut byte).await.unwrap() == 0 {
                        break;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_string();
                let path = head.split(' ').nth(1).unwrap_or_default().to_string();
                seen.lock().unwrap().push(path);
                let (frames, next_cursor) = pages.next().unwrap_or_default();
                let body = serde_json::json!({ "frames": frames, "next_cursor": next_cursor }).to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                sock.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (base_url, requests)
    }

    fn rows(ids: std::ops::Range<u32>, spacing_us: i64) -> Vec<serde_json::Value> {
        ids.map(|id| {
            serde_json::json!({
                "ts_us": 1_000 + id as i64 * spacing_us, "id": id, "extended": false, "dlc": 1,
                "is_fd": false, "bus": 0, "dir": "rx", "data_hex": "ab",
            })
        })
        .collect()
    }

    struct Streamed {
        frames: Vec<FrameMessage>,
        requests: Vec<String>,
        position: Option<PlaybackPosition>,
        elapsed: Duration,
    }

    async fn stream(
        session_id: &str,
        pages: Vec<(Vec<serde_json::Value>, Option<&'static str>)>,
        speed: f64,
    ) -> Streamed {
        crate::capture_db::use_in_memory_database();
        let (base_url, requests) = fake_gateway(pages).await;
        let config = BackendApiConfig {
            base_url,
            api_key: "key".into(),
            database: "site".into(),
            protocol: ArchiveProtocol::Can,
        };
        let options = BackendApiSourceOptions { speed, batch_size: 40, ..Default::default() };
        let source = BackendApiSource::new(session_id.into(), config, options);
        crate::io::create_session(session_id.into(), Box::new(source), None, None, None, vec![]).await;
        let started = std::time::Instant::now();
        crate::io::start_session(session_id).await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(5), async {
            while crate::io::post_session::get_stream_ended(session_id).is_none() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        let elapsed = started.elapsed();
        let position = crate::io::get_playback_position(session_id);
        let capture = capture_store::get_session_frame_capture_id(session_id).unwrap();
        let frames = capture_store::get_capture_frames(&capture).unwrap_or_default();
        crate::io::destroy_session(session_id, false).await.ok();
        ended.expect("the stream ended");
        let requests = requests.lock().unwrap().clone();
        Streamed { frames, requests, position, elapsed }
    }

    fn two_pages() -> Vec<(Vec<serde_json::Value>, Option<&'static str>)> {
        vec![(rows(0..40, 10), Some("p2")), (rows(40..60, 10), None)]
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_gateway_stream_follows_the_cursor_and_lands_every_row_in_order() {
        let streamed = stream("f_backend_cursor", two_pages(), 0.0).await;

        let ids: Vec<u32> = streamed.frames.iter().map(|f| f.frame_id).collect();
        assert_eq!(ids, (0..60).collect::<Vec<_>>());
        assert_eq!(
            streamed.requests,
            ["/v1/db/site/frames?limit=40", "/v1/db/site/frames?limit=40&after=p2"]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn at_unlimited_speed_the_position_is_published_per_full_batch_only() {
        let streamed = stream("f_backend_position", two_pages(), 0.0).await;

        let position = streamed.position.expect("a position was published");
        assert_eq!(
            (position.timestamp_us, position.frame_index, position.frame_count),
            (1_000 + 49 * 10, 49, Some(50))
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn at_1x_a_gateway_stream_takes_as_long_as_its_rows_span() {
        let streamed = stream("f_backend_paced", vec![(rows(0..30, 13_000), None)], 1.0).await;

        assert_eq!(streamed.frames.len(), 30);
        assert!(streamed.elapsed >= Duration::from_millis(350), "finished in {:?}", streamed.elapsed);
    }

    #[test]
    fn a_modbus_message_over_255_bytes_counts_every_byte() {
        let frame = frame_from_row(
            ArchiveProtocol::Modbus,
            row(serde_json::json!({
                "ts_us": 1, "id": 0x0103, "extended": false, "dlc": 256, "is_fd": false,
                "bus": 0, "dir": "rx", "data_hex": "00".repeat(256),
            })),
        )
        .unwrap();
        assert_eq!(frame.protocol, "modbus_rtu");
        assert_eq!(frame.dlc, 256);
    }
}
