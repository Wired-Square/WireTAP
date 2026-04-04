// io/modbus_tcp/reader.rs
//
// Modbus TCP Reader - polls registers from a Modbus TCP server.
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
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;
use tokio::sync::Mutex;
use tokio::time::{Duration, interval};
use tokio_modbus::client::{self, tcp};
use tokio_modbus::prelude::*;

use crate::buffer_store::{self, BufferType};
use crate::io::{
    emit_device_connected, emit_session_error, emit_stream_ended, now_us, signal_frames_ready,
    FrameMessage, IOCapabilities, IODevice, IOState, Protocol, SignalThrottle,
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
}

/// Modbus TCP reader configuration
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
// Modbus TCP Reader
// ============================================================================

/// Modbus TCP Reader - polls registers from a Modbus TCP server
pub struct ModbusTcpReader {
    app: AppHandle,
    session_id: String,
    config: ModbusTcpConfig,
    state: IOState,
    cancel_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    task_handles: Vec<tauri::async_runtime::JoinHandle<()>>,
}

impl ModbusTcpReader {
    pub fn new(app: AppHandle, session_id: String, config: ModbusTcpConfig) -> Self {
        Self {
            app,
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
impl IODevice for ModbusTcpReader {
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
            return Err("Reader is already running".to_string());
        }

        if self.config.polls.is_empty() {
            return Err(
                "No poll groups configured. Load a catalog with [frame.modbus.*] entries."
                    .to_string(),
            );
        }

        self.state = IOState::Starting;
        self.cancel_flag.store(false, Ordering::Relaxed);

        // Resolve server address
        let addr: SocketAddr = format!("{}:{}", self.config.host, self.config.port)
            .parse()
            .map_err(|e| format!("Invalid server address: {}", e))?;

        // Connect to the Modbus TCP server
        let slave = Slave(self.config.unit_id);
        let ctx = tcp::connect_slave(addr, slave)
            .await
            .map_err(|e| format!("Failed to connect to Modbus TCP server at {}: {}", addr, e))?;

        // Wrap the context in an Arc<Mutex> so poll tasks can share it
        let ctx: Arc<Mutex<client::Context>> = Arc::new(Mutex::new(ctx));

        // Create frame buffer
        let buffer_id = buffer_store::create_buffer(BufferType::Frames, self.session_id.clone());
        let _ = buffer_store::set_buffer_owner(&buffer_id, &self.session_id);

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
            let handle = spawn_poll_task(
                self.app.clone(),
                self.session_id.clone(),
                self.config.unit_id,
                poll.clone(),
                ctx.clone(),
                self.cancel_flag.clone(),
                self.pause_flag.clone(),
                self.config.max_register_errors,
            );
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
            return Err("Reader is not running".to_string());
        }
        self.pause_flag.store(true, Ordering::Relaxed);
        self.state = IOState::Paused;
        tlog!("[ModbusTCP:{}] Polling paused", self.session_id);
        Ok(())
    }

    async fn resume(&mut self) -> Result<(), String> {
        if self.state != IOState::Paused {
            return Err("Reader is not paused".to_string());
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

    fn device_type(&self) -> &'static str {
        "modbus_tcp"
    }
}

// ============================================================================
// Poll Task
// ============================================================================

fn spawn_poll_task(
    _app: AppHandle,
    session_id: String,
    unit_id: u8,
    poll: PollGroup,
    ctx: Arc<Mutex<client::Context>>,
    cancel_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
    max_register_errors: u32,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut timer = interval(Duration::from_millis(poll.interval_ms));
        let type_name = match poll.register_type {
            RegisterType::Holding => "holding",
            RegisterType::Input => "input",
            RegisterType::Coil => "coil",
            RegisterType::Discrete => "discrete",
        };
        let mut first_poll = true;
        let mut consecutive_errors: u32 = 0;
        let mut throttle = SignalThrottle::new();

        tlog!(
            "[ModbusTCP:{}] Poll task started: {} reg {} count {} every {}ms (frame_id={})",
            session_id, type_name, poll.start_register, poll.count, poll.interval_ms, poll.frame_id
        );

        loop {
            timer.tick().await;

            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }

            // Skip reads while paused (poll task stays alive, timer keeps ticking)
            if pause_flag.load(Ordering::Relaxed) {
                continue;
            }

            let mut ctx = ctx.lock().await;

            // tokio-modbus read methods return Result<Result<Vec<T>, Exception>>
            // Outer Result = IO error, Inner Result = Modbus exception
            let result: Result<Vec<u8>, String> = match poll.register_type {
                RegisterType::Holding => {
                    match ctx
                        .read_holding_registers(poll.start_register, poll.count)
                        .await
                    {
                        Ok(Ok(data)) => Ok(registers_to_bytes(&data)),
                        Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
                        Err(e) => Err(format!("IO error: {}", e)),
                    }
                }
                RegisterType::Input => {
                    match ctx
                        .read_input_registers(poll.start_register, poll.count)
                        .await
                    {
                        Ok(Ok(data)) => Ok(registers_to_bytes(&data)),
                        Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
                        Err(e) => Err(format!("IO error: {}", e)),
                    }
                }
                RegisterType::Coil => {
                    match ctx
                        .read_coils(poll.start_register, poll.count)
                        .await
                    {
                        Ok(Ok(data)) => Ok(coils_to_bytes(&data)),
                        Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
                        Err(e) => Err(format!("IO error: {}", e)),
                    }
                }
                RegisterType::Discrete => {
                    match ctx
                        .read_discrete_inputs(poll.start_register, poll.count)
                        .await
                    {
                        Ok(Ok(data)) => Ok(coils_to_bytes(&data)),
                        Ok(Err(exc)) => Err(format!("Modbus exception: {}", exc)),
                        Err(e) => Err(format!("IO error: {}", e)),
                    }
                }
            };

            // Release the lock before emitting
            drop(ctx);

            match result {
                Ok(bytes) => {
                    consecutive_errors = 0;

                    if first_poll {
                        tlog!(
                            "[ModbusTCP:{}] First poll OK: {} reg {} → {} bytes: {:02X?}",
                            session_id, type_name, poll.start_register, bytes.len(), &bytes[..bytes.len().min(16)]
                        );
                        first_poll = false;
                    }

                    let frame = FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: now_us(),
                        frame_id: poll.frame_id,
                        bus: unit_id,
                        dlc: bytes.len() as u8,
                        bytes,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };

                    buffer_store::append_frames_to_session(&session_id, vec![frame]);
                    if throttle.should_signal("frames-ready") {
                        signal_frames_ready(&session_id);
                    }
                }
                Err(e) => {
                    consecutive_errors += 1;

                    tlog!(
                        "[ModbusTCP:{}] Error reading {} registers at {}: {} ({}/{})",
                        session_id, type_name, poll.start_register, e,
                        consecutive_errors,
                        if max_register_errors > 0 { max_register_errors.to_string() } else { "∞".to_string() }
                    );
                    emit_session_error(
                        &session_id,
                        format!(
                            "Modbus read error ({} @ {}): {}",
                            type_name, poll.start_register, e
                        ),
                    );

                    if max_register_errors > 0 && consecutive_errors >= max_register_errors {
                        tlog!(
                            "[ModbusTCP:{}] Stopped polling {} reg {} after {} consecutive errors",
                            session_id, type_name, poll.start_register, consecutive_errors
                        );
                        emit_session_error(
                            &session_id,
                            format!(
                                "Stopped polling {} @ {} after {} consecutive errors",
                                type_name, poll.start_register, consecutive_errors
                            ),
                        );
                        break;
                    }
                }
            }
        }
    })
}

// ============================================================================
// Data Conversion Helpers
// ============================================================================

/// Convert Modbus register values (u16) to bytes in big-endian order.
/// Each register becomes 2 bytes (MSB first), matching standard Modbus byte order.
pub fn registers_to_bytes(registers: &[u16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(registers.len() * 2);
    for &reg in registers {
        bytes.push((reg >> 8) as u8); // MSB
        bytes.push((reg & 0xFF) as u8); // LSB
    }
    bytes
}

/// Convert coil/discrete input values (bool) to packed bytes.
/// 8 coils per byte, LSB first within each byte (Modbus convention).
pub fn coils_to_bytes(coils: &[bool]) -> Vec<u8> {
    let byte_count = (coils.len() + 7) / 8;
    let mut bytes = vec![0u8; byte_count];
    for (i, &coil) in coils.iter().enumerate() {
        if coil {
            bytes[i / 8] |= 1 << (i % 8);
        }
    }
    bytes
}
