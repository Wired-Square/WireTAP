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
use wiretap_gateway::client::{ArchiveFrame, ClientError, FrameCursor};
use wiretap_gateway::{FramesQuery, Protocol as ArchiveProtocol};

use wiretap_io::replay::{Pacer, PlaybackControl, Playout, Unlimited};

use super::base::{publish_position, RecordedSourceState};
use crate::apiclient::{frame_tag, gateway};
use crate::capture_store::{self, CaptureKind, SessionAppender};
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
// Gateway pages
// ---------------------------------------------------------------------------

struct Pages {
    cursor: FrameCursor,
    protocol: ArchiveProtocol,
}

impl Pages {
    fn new(config: &BackendApiConfig, options: &BackendApiSourceOptions) -> Self {
        let query = FramesQuery {
            start: options.start.clone(),
            end: options.end.clone(),
            after: None,
            limit: Some(options.batch_size.clamp(1, 5000) as u32),
            protocol: None,
        };
        let cursor = gateway()
            .with_endpoint(&config.base_url, &config.api_key)
            .db(&config.database, config.protocol)
            .frames(query);
        let cursor = match options.limit {
            Some(limit) => cursor.at_most(limit.max(0) as usize),
            None => cursor,
        };
        Self {
            cursor,
            protocol: config.protocol,
        }
    }

    async fn next_page(&mut self) -> Result<Vec<FrameMessage>, String> {
        let page = self.cursor.next_page().await.map_err(fetch_error)?;
        Ok(page
            .into_iter()
            .map(|f| frame_message(self.protocol, f))
            .collect())
    }
}

fn fetch_error(e: ClientError) -> String {
    match e {
        ClientError::Transport(cause) => format!("frame fetch failed: {cause}"),
        ClientError::BadHex(_) => e.to_string(),
        e => format!("frame fetch failed: {e}"),
    }
}

fn frame_message(protocol: ArchiveProtocol, f: ArchiveFrame) -> FrameMessage {
    FrameMessage {
        protocol: frame_tag(protocol).to_string(),
        timestamp_us: f.ts_us as u64,
        frame_id: f.id,
        bus: f.bus,
        dlc: f.len,
        bytes: f.data,
        is_extended: f.extended,
        is_fd: f.is_fd,
        is_rtr: f.is_rtr,
        is_brs: f.is_brs,
        is_esi: f.is_esi,
        crc_valid: f.crc_valid,
        ..Default::default()
    }
}

/// Played frames land in the session's capture, the position counting them.
struct IntoCapture<'a> {
    session_id: &'a str,
    throttle: SignalThrottle,
    appender: SessionAppender,
}

impl Playout<FrameMessage> for IntoCapture<'_> {
    fn frames(&mut self, frames: Vec<FrameMessage>) {
        self.appender.append(frames);
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

    let mut fetcher = Pages::new(&config, &options);

    let mut frame_queue: VecDeque<FrameMessage> = VecDeque::new();

    // Refill helper: pull pages until the buffer reaches target or exhausted
    async fn refill(
        fetcher: &mut Pages,
        queue: &mut VecDeque<FrameMessage>,
        target: usize,
    ) -> Result<(), String> {
        while queue.len() < target && !fetcher.cursor.is_done() {
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
    let mut frames_ready = SignalThrottle::new();
    let appender = SessionAppender::spawn(session_id.clone(), move |session_id| {
        if frames_ready.should_signal("frames-ready") {
            signal_frames_ready(session_id);
        }
    });
    let mut out = IntoCapture { session_id: &session_id, throttle: SignalThrottle::new(), appender };

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

        if frame_queue.len() < REFILL_THRESHOLD && !fetcher.cursor.is_done() {
            refill(&mut fetcher, &mut frame_queue, BUFFER_SIZE).await?;
        }

        let frame = match frame_queue.pop_front() {
            Some(f) => f,
            None => {
                if fetcher.cursor.is_done() {
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

    let rest = pacer.take_batch();
    let flush = !rest.is_empty();
    out.appender.append(rest);
    out.appender.finish().await;
    if flush {
        out.throttle.flush();
        signal_frames_ready(&session_id);
    }

    if control.is_cancelled() {
        tlog!(
            "[BackendAPI:{}] Stream cancelled by user (emitted: {})",
            session_id,
            pacer.stats().emitted
        );
    } else {
        tlog!(
            "[BackendAPI:{}] Stream ended (emitted: {})",
            session_id,
            pacer.stats().emitted
        );
        emit_stream_ended(&session_id, StreamEndReason::Complete, "BackendAPI");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let frames = capture_store::get_capture_frames(&capture).await.unwrap().unwrap_or_default();
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
    fn an_archive_rows_crc_verdict_is_carried() {
        let row = |crc_valid| ArchiveFrame {
            ts_us: 1,
            id: 0x0103,
            extended: false,
            len: 4,
            data: vec![0x01, 0x03, 0xAA, 0xBB],
            is_fd: false,
            is_rtr: false,
            is_brs: false,
            is_esi: false,
            crc_valid,
            bus: 0,
            dir: "rx".into(),
        };
        for crc_valid in [Some(false), Some(true), None] {
            assert_eq!(frame_message(ArchiveProtocol::Modbus, row(crc_valid)).crc_valid, crc_valid);
        }
    }
}
