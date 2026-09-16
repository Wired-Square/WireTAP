// io/modbus_tcp/scan_source.rs
//
// A discovery sweep as an IOSource.
//
// "Scan without a session" is the requirement; "produce no session" is not. A
// sweep that owns a session gets, for nothing:
//
//   - a frame capture, so results survive the panel closing and can be replayed
//   - the Discovery analysis tools, which work on captures — including Changes,
//     which is what turns two scan passes into "these registers are live"
//   - `get_capture_frames` paging, so an agent reads a wide sweep in pages
//     instead of one enormous tool response
//   - TOML export via the existing Save flow
//   - cancellation as `stop_session`, which also means the session id *is* the
//     scan id, so two scans against different devices can run at once
//
// The alternative — writing to a bare capture with no session — would mean
// reimplementing capture ownership and the WebSocket channel lookup, and the
// results would be invisible until something forced a refresh.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock,
};
use tauri::AppHandle;

use super::poll::FrameSink;
use super::scanner::{
    clear_scan_state, scan_registers, scan_unit_ids, store_scan_result, ModbusScanConfig,
    UnitIdScanConfig,
};
use crate::capture_store::{self, CaptureKind};
use crate::io::{
    emit_device_connected, emit_session_error, emit_stream_ended, lifecycle::SourceLifecycle,
    IOCapabilities, IOSource, IOState, Protocol,
};

// ============================================================================
// In-flight sweep registry
// ============================================================================

/// session_id → `host:port` for every sweep currently holding a connection.
///
/// `ActiveSessionInfo` carries no device address, and the thing worth guarding
/// is the endpoint rather than the session, so scans track their own.
static ACTIVE_SCANS: Lazy<RwLock<HashMap<String, String>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// The session already sweeping `endpoint`, if any.
pub fn scan_holding(endpoint: &str) -> Option<String> {
    ACTIVE_SCANS
        .read()
        .ok()?
        .iter()
        .find(|(_, e)| e.as_str() == endpoint)
        .map(|(sid, _)| sid.clone())
}

fn register_scan(session_id: &str, endpoint: &str) {
    if let Ok(mut scans) = ACTIVE_SCANS.write() {
        scans.insert(session_id.to_string(), endpoint.to_string());
    }
}

fn unregister_scan(session_id: &str) {
    if let Ok(mut scans) = ACTIVE_SCANS.write() {
        scans.remove(session_id);
    }
}

/// Which sweep this session runs.
///
/// The function-code probe is deliberately absent: it makes at most four
/// requests, produces no frames and needs no capture, so it runs as a plain
/// call rather than dragging a session along behind it.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScanJob {
    Registers { config: ModbusScanConfig },
    UnitIds { config: UnitIdScanConfig },
}

impl ScanJob {
    /// `host:port` — used both for the connected event and to detect two scans
    /// contending for one device's connection.
    pub fn endpoint(&self) -> String {
        match self {
            ScanJob::Registers { config } => format!("{}:{}", config.host, config.port),
            ScanJob::UnitIds { config } => format!("{}:{}", config.host, config.port),
        }
    }

    /// Point this job at a device resolved from elsewhere — the Discovery tools
    /// scan the current session's device rather than an address you type.
    ///
    /// Address only. The slave is the caller's: a register sweep may deliberately
    /// target a unit other than the session's — that is what the unit-id sweep
    /// finds them for — and a unit-id sweep supplies its own.
    ///
    /// Retargeting happens before `endpoint()` is ever read, which is what keeps
    /// `endpoint()` infallible and sync for the contention registry.
    pub fn retarget(&mut self, host: String, port: u16) {
        match self {
            ScanJob::Registers { config } => {
                config.host = host;
                config.port = port;
            }
            ScanJob::UnitIds { config } => {
                config.host = host;
                config.port = port;
            }
        }
    }

    fn describe(&self) -> String {
        match self {
            ScanJob::Registers { config } => format!(
                "registers {}..{} on unit {}",
                config.start_register, config.end_register, config.unit_id
            ),
            ScanJob::UnitIds { config } => {
                format!("unit IDs {}..{}", config.start_unit_id, config.end_unit_id)
            }
        }
    }
}

/// A Modbus discovery sweep, driven as a session.
pub struct ModbusScanSource {
    session_id: String,
    job: ScanJob,
    state: IOState,
    /// The sweep runs on a detached task, so `state` alone would report `Running`
    /// for a sweep that finished — which is what Discovery's poller latch was
    /// compensating for.
    lifecycle: SourceLifecycle,
    cancel_flag: Arc<AtomicBool>,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl ModbusScanSource {
    /// `app` is unused — kept so the constructor matches every other source in
    /// the session-creation match arms.
    pub fn new(_app: AppHandle, session_id: String, job: ScanJob) -> Self {
        Self {
            session_id,
            job,
            state: IOState::Stopped,
            lifecycle: SourceLifecycle::new(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            handle: None,
        }
    }
}

#[async_trait]
impl IOSource for ModbusScanSource {
    fn capabilities(&self) -> IOCapabilities {
        let mut caps = IOCapabilities::realtime_can()
            .with_buses(vec![])
            .with_protocols(vec![Protocol::Modbus]);
        // A sweep runs to completion or is stopped; there is no coherent
        // half-way state to pause into.
        caps.can_pause = false;
        caps.supports_extended_id = false;
        caps.supports_rtr = false;
        caps
    }

    async fn start(&mut self) -> Result<(), String> {
        if self.state == IOState::Running {
            return Err("Scan is already running".to_string());
        }

        self.state = IOState::Starting;
        self.cancel_flag.store(false, Ordering::Relaxed);

        capture_store::create_session_capture(&self.session_id, CaptureKind::Frames, self.session_id.clone());

        let endpoint = self.job.endpoint();
        register_scan(&self.session_id, &endpoint);
        emit_device_connected(&self.session_id, "modbus_scan", &endpoint, None);

        tlog!(
            "[ModbusScan:{}] Sweeping {} on {}",
            self.session_id,
            self.job.describe(),
            endpoint
        );

        let session_id = self.session_id.clone();
        let job = self.job.clone();
        let cancel = self.cancel_flag.clone();
        let ended = self.lifecycle.guard(IOState::Stopped);

        self.handle = Some(tauri::async_runtime::spawn(async move {
            let _ended = ended;
            let sink = FrameSink::SessionCapture { session_id: session_id.clone() };
            let outcome = match job {
                ScanJob::Registers { config } => {
                    scan_registers(config, cancel.clone(), Some(session_id.clone()), &sink).await
                }
                ScanJob::UnitIds { config } => {
                    scan_unit_ids(config, cancel.clone(), Some(session_id.clone()), &sink).await
                }
            };

            let reason = match outcome {
                Ok(payload) => {
                    let truncated = payload.truncated;
                    // Park the summary so a caller that didn't await the sweep —
                    // an MCP client that passed wait=false, say — can still
                    // collect the block/gap breakdown afterwards.
                    store_scan_result(&session_id, payload);
                    match (truncated, cancel.load(Ordering::Relaxed)) {
                        (false, _) => "complete".to_string(),
                        (true, true) => "cancelled".to_string(),
                        (true, false) => "stopped".to_string(),
                    }
                }
                Err(e) => {
                    emit_session_error(&session_id, format!("Modbus scan failed: {e}"));
                    format!("error: {e}")
                }
            };

            // Release the device before announcing the end, so a follow-up sweep
            // queued off the completion event isn't rejected by the guard.
            unregister_scan(&session_id);
            // Finalises the capture, so the results are queryable the moment the
            // sweep ends rather than only after the session is torn down.
            emit_stream_ended(&session_id, &reason, "ModbusScan");
        }));

        self.state = IOState::Running;
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.cancel_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
        unregister_scan(&self.session_id);
        clear_scan_state(&self.session_id);
        tlog!("[ModbusScan:{}] Stopped", self.session_id);
        self.state = IOState::Stopped;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        Err("A Modbus scan cannot be paused — stop it and start a new sweep.".to_string())
    }

    async fn resume(&mut self) -> Result<(), String> {
        Err("A Modbus scan cannot be paused.".to_string())
    }

    fn set_speed(&mut self, _speed: f64) -> Result<(), String> {
        Err("A Modbus scan runs at the device's pace; use the inter-request delay.".to_string())
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("A Modbus scan does not support time range filtering.".to_string())
    }

    fn state(&self) -> IOState {
        self.lifecycle.state_or(&self.state)
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn source_type(&self) -> &'static str {
        "modbus_scan"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn register_job() -> ScanJob {
        serde_json::from_str(
            r#"{"kind":"registers","config":{"host":"127.0.0.1","port":502,"unit_id":1,
                "register_type":"holding","start_register":0,"end_register":9,
                "chunk_size":10,"inter_request_delay_ms":50}}"#,
        )
        .unwrap()
    }

    fn unit_job() -> ScanJob {
        serde_json::from_str(
            r#"{"kind":"unit_ids","config":{"host":"127.0.0.1","port":502,
                "start_unit_id":1,"end_unit_id":5,"test_register":0,
                "register_type":"holding","inter_request_delay_ms":50}}"#,
        )
        .unwrap()
    }

    #[test]
    fn retargeting_moves_the_address_but_never_the_slave() {
        // The caller's unit is deliberate — a register sweep may target a slave
        // the unit-id sweep just found, not the session's own.
        let mut job = register_job();
        job.retarget("10.0.1.50".into(), 5020);
        assert_eq!(job.endpoint(), "10.0.1.50:5020");
        match job {
            ScanJob::Registers { config } => assert_eq!(config.unit_id, 1),
            _ => panic!("kind changed"),
        }
    }

    #[test]
    fn retargeting_a_unit_sweep_leaves_its_range_alone() {
        let mut job = unit_job();
        job.retarget("10.0.1.50".into(), 5020);
        assert_eq!(job.endpoint(), "10.0.1.50:5020");
        match job {
            ScanJob::UnitIds { config } => {
                assert_eq!(config.start_unit_id, 1);
                assert_eq!(config.end_unit_id, 5);
            }
            _ => panic!("kind changed"),
        }
    }
}
