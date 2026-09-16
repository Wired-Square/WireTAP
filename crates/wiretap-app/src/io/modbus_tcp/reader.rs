// io/modbus_tcp/reader.rs
//
// Modbus TCP Source - polls registers from a Modbus TCP server.
//
// Architecture:
//   - Connects to a Modbus TCP server (PLC, sensor, etc.)
//   - Spawns one poll task per PollGroup, each with its own interval timer
//   - Each poll response becomes a FrameMessage with protocol="modbus"
//   - frame_id = register_number from the catalog
//   - bytes = raw register data (big-endian, 2 bytes per register)
//
// Catalog-driven: the frontend extracts poll groups from [frame.modbus.*]
// catalog entries and passes them as JSON when creating the session.

use async_trait::async_trait;
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;
use tokio::sync::Mutex;
use tokio_modbus::client::{self, tcp};
use tokio_modbus::prelude::*;

use super::poll::{run_poll_task, FrameSink};
use crate::capture_store::{self, CaptureKind};
use crate::io::{
    emit_device_connected, emit_stream_ended, IOCapabilities, IOSource, IOState, Protocol,
};

// ============================================================================
// Configuration
// ============================================================================

/// Register type for Modbus polling
#[derive(Clone, Debug, serde::Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RegisterType {
    Holding,
    Input,
    Coil,
    Discrete,
}

impl RegisterType {
    /// The catalogue library's equivalent, which owns the protocol facts —
    /// read/write caps, the function-code mapping, coil packing.
    ///
    /// The two enums stay separate because this one is the serde shape of an
    /// IO profile and the MCP API, and the catalogue's is part of a published
    /// crate. The numbers behind them should not be duplicated as well, so
    /// everything that needs a Modbus fact crosses over here to ask for it.
    pub fn catalog(&self) -> wiretap_catalog::RegisterType {
        match self {
            RegisterType::Holding => wiretap_catalog::RegisterType::Holding,
            RegisterType::Input => wiretap_catalog::RegisterType::Input,
            RegisterType::Coil => wiretap_catalog::RegisterType::Coil,
            RegisterType::Discrete => wiretap_catalog::RegisterType::Discrete,
        }
    }
}

/// How a poll response becomes frames.
#[derive(Clone, Copy, Debug, Default, serde::Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PollEmitMode {
    /// One frame per group, bytes = the whole block. Required for catalogue
    /// polls: their signals are bit offsets into the entire block.
    #[default]
    Block,
    /// One frame per register, frame_id = the register address. Used by
    /// discovery sweeps so per-register change analysis works.
    PerRegister,
}

/// A single poll group - one register read operation on a timer
#[derive(Clone, Debug, serde::Serialize, Deserialize)]
pub struct PollGroup {
    /// Register type (determines Modbus function code)
    pub register_type: RegisterType,
    /// Protocol-level start address (0-based, 0-65535)
    pub start_register: u16,
    /// Number of registers (or coils) to read
    pub count: u16,
    /// Poll interval in milliseconds
    pub interval_ms: u64,
    /// frame_id to emit (= catalog register_number)
    pub frame_id: u32,
    /// Device (slave) address to poll — resolved from the register's node.
    /// Defaults to 1 so older poll payloads without this field still load.
    #[serde(default = "default_device_address")]
    pub device_address: u8,
    /// Defaults to `Block` so catalogue-derived poll payloads — including any
    /// already persisted without this field — keep their existing shape.
    #[serde(default)]
    pub emit_mode: PollEmitMode,
}

fn default_device_address() -> u8 {
    1
}

/// Modbus TCP source configuration
#[derive(Clone, Debug)]
pub struct ModbusTcpConfig {
    /// Server hostname or IP
    pub host: String,
    /// Server port (default 502)
    pub port: u16,
    /// Modbus unit/slave ID (1-247)
    pub unit_id: u8,
    /// Poll groups derived from catalog
    pub polls: Vec<PollGroup>,
    /// Stop polling a register group after this many consecutive errors (0 = never stop)
    pub max_register_errors: u32,
}

// ============================================================================
// Modbus TCP Source
// ============================================================================

/// Modbus TCP Source - polls registers from a Modbus TCP server
pub struct ModbusTcpSource {
    session_id: String,
    config: ModbusTcpConfig,
    state: IOState,
    cancel_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    task_handles: Vec<tauri::async_runtime::JoinHandle<()>>,
}

impl ModbusTcpSource {
    /// `app` is unused — kept so the constructor matches every other source in
    /// the `create_reader_session` match arm.
    pub fn new(_app: AppHandle, session_id: String, config: ModbusTcpConfig) -> Self {
        Self {
            session_id,
            config,
            state: IOState::Stopped,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            pause_flag: Arc::new(AtomicBool::new(false)),
            task_handles: Vec::new(),
        }
    }
}

#[async_trait]
impl IOSource for ModbusTcpSource {
    fn capabilities(&self) -> IOCapabilities {
        let mut caps = IOCapabilities::realtime_can()
            .with_buses(vec![])
            .with_protocols(vec![Protocol::Modbus]);
        caps.can_pause = true;
        caps.supports_extended_id = false;
        caps.supports_rtr = false;
        caps
    }

    async fn start(&mut self) -> Result<(), String> {
        if self.state == IOState::Running {
            return Err("Source is already running".to_string());
        }

        if self.config.polls.is_empty() {
            return Err(
                "No poll groups configured. Load a catalog with [frame.modbus.*] entries."
                    .to_string(),
            );
        }

        self.state = IOState::Starting;
        self.cancel_flag.store(false, Ordering::Relaxed);

        // Resolve server address (accepts a hostname or an IP literal)
        let addr = crate::io::net::resolve_host_port(&self.config.host, self.config.port)
            .await
            .map_err(|e| e.user_message())?;

        // Connect to the Modbus TCP server
        let slave = Slave(self.config.unit_id);
        let ctx = tcp::connect_slave(addr, slave)
            .await
            .map_err(|e| format!("Failed to connect to Modbus TCP server at {}: {}", addr, e))?;

        // Wrap the context in an Arc<Mutex> so poll tasks can share it
        let ctx: Arc<Mutex<client::Context>> = Arc::new(Mutex::new(ctx));

        // Create frame capture
        capture_store::create_session_capture(&self.session_id, CaptureKind::Frames, self.session_id.clone());

        // Emit connected event
        let address = format!("{}:{}", self.config.host, self.config.port);
        emit_device_connected(
            &self.session_id,
            "modbus_tcp",
            &address,
            None,
        );

        tlog!(
            "[ModbusTCP:{}] Connected to {} (unit {}), {} poll group(s)",
            self.session_id,
            address,
            self.config.unit_id,
            self.config.polls.len()
        );

        // Spawn one poll task per group
        for poll in &self.config.polls {
            let poll = poll.clone();
            let ctx = ctx.clone();
            let cancel = self.cancel_flag.clone();
            let pause = self.pause_flag.clone();
            let max_register_errors = self.config.max_register_errors;
            let session_id = self.session_id.clone();
            let handle = tauri::async_runtime::spawn(async move {
                run_poll_task(
                    poll,
                    ctx,
                    max_register_errors,
                    cancel,
                    pause,
                    FrameSink::SessionCapture { session_id },
                )
                .await;
            });
            self.task_handles.push(handle);
        }

        self.state = IOState::Running;
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.cancel_flag.store(true, Ordering::Relaxed);

        // Wait for all poll tasks to finish
        for handle in self.task_handles.drain(..) {
            let _ = handle.await;
        }

        // Disconnect (the context is dropped when all Arc refs are released)
        tlog!("[ModbusTCP:{}] Stopped", self.session_id);
        emit_stream_ended(&self.session_id, "stopped", "ModbusTCP");

        self.state = IOState::Stopped;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        if self.state != IOState::Running {
            return Err("Source is not running".to_string());
        }
        self.pause_flag.store(true, Ordering::Relaxed);
        self.state = IOState::Paused;
        tlog!("[ModbusTCP:{}] Polling paused", self.session_id);
        Ok(())
    }

    async fn resume(&mut self) -> Result<(), String> {
        if self.state != IOState::Paused {
            return Err("Source is not paused".to_string());
        }
        self.pause_flag.store(false, Ordering::Relaxed);
        self.state = IOState::Running;
        tlog!("[ModbusTCP:{}] Polling resumed", self.session_id);
        Ok(())
    }

    fn set_speed(&mut self, _speed: f64) -> Result<(), String> {
        Err("Modbus TCP is a live polling session and does not support speed control.".to_string())
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("Modbus TCP does not support time range filtering.".to_string())
    }

    fn state(&self) -> IOState {
        self.state.clone()
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn source_type(&self) -> &'static str {
        "modbus_tcp"
    }
}

