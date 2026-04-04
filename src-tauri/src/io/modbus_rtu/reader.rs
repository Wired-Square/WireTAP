// io/modbus_rtu/reader.rs
//
// Modbus RTU Reader - actively polls registers over a serial port.
//
// Architecture:
//   - Opens a serial port directly (using serialport crate)
//   - Sends Modbus RTU requests (function codes 1-4) with CRC-16
//   - Reads responses with timeout, validates CRC
//   - Emits FrameMessage with protocol="modbus" (identical to TCP reader output)
//   - Uses a single sequential poll loop (RTU is half-duplex)
//
// Request frame format: [unit_id, func_code, start_hi, start_lo, count_hi, count_lo, crc_lo, crc_hi]
// Response frame format: [unit_id, func_code, byte_count, data..., crc_lo, crc_hi]

use async_trait::async_trait;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::buffer_store::{self, BufferType};
use crate::checksums::crc16_modbus_checksum;
use crate::io::modbus_tcp::{PollGroup, RegisterType};
use crate::io::serial::utils::{to_serialport_data_bits, to_serialport_parity, to_serialport_stop_bits, Parity};
use crate::io::{
    emit_device_connected, emit_session_error, emit_stream_ended, now_us, signal_frames_ready,
    FrameMessage, IOCapabilities, IODevice, IOState, Protocol, SignalThrottle,
};

// ============================================================================
// Configuration
// ============================================================================

/// Modbus RTU reader configuration
#[derive(Clone, Debug)]
pub struct ModbusRtuConfig {
    /// Serial port path (e.g. "/dev/ttyUSB0", "COM3")
    pub port_name: String,
    /// Baud rate (e.g. 9600, 19200, 115200)
    pub baud_rate: u32,
    /// Data bits (typically 8)
    pub data_bits: u8,
    /// Stop bits (1 or 2)
    pub stop_bits: u8,
    /// Parity (None, Even, Odd)
    pub parity: Parity,
    /// Modbus unit/slave ID (1-247)
    pub unit_id: u8,
    /// Poll groups derived from catalog
    pub polls: Vec<PollGroup>,
    /// Response timeout per request in milliseconds
    pub response_timeout_ms: u64,
    /// Delay between consecutive requests in milliseconds (inter-frame gap)
    pub inter_request_delay_ms: u64,
    /// Stop polling a register group after this many consecutive errors (0 = never stop)
    pub max_register_errors: u32,
}

// ============================================================================
// Modbus RTU Reader
// ============================================================================

pub struct ModbusRtuReader {
    _app: AppHandle,
    session_id: String,
    config: ModbusRtuConfig,
    state: IOState,
    cancel_flag: Arc<AtomicBool>,
    task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl ModbusRtuReader {
    pub fn new(app: AppHandle, session_id: String, config: ModbusRtuConfig) -> Self {
        Self {
            _app: app,
            session_id,
            config,
            state: IOState::Stopped,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            task_handle: None,
        }
    }
}

#[async_trait]
impl IODevice for ModbusRtuReader {
    fn capabilities(&self) -> IOCapabilities {
        let mut caps = IOCapabilities::realtime_can()
            .with_buses(vec![])
            .with_protocols(vec![Protocol::Modbus]);
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

        // Open serial port
        let sp_data_bits = to_serialport_data_bits(self.config.data_bits);
        let sp_stop_bits = to_serialport_stop_bits(self.config.stop_bits);
        let sp_parity = to_serialport_parity(&self.config.parity);

        let port = serialport::new(&self.config.port_name, self.config.baud_rate)
            .data_bits(sp_data_bits)
            .stop_bits(sp_stop_bits)
            .parity(sp_parity)
            .timeout(Duration::from_millis(self.config.response_timeout_ms))
            .open()
            .map_err(|e| format!("Failed to open {}: {}", self.config.port_name, e))?;

        let port = Arc::new(Mutex::new(port));

        // Create frame buffer
        let buffer_id = buffer_store::create_buffer(BufferType::Frames, self.session_id.clone());
        let _ = buffer_store::set_buffer_owner(&buffer_id, &self.session_id);

        // Emit connected event
        emit_device_connected(
            &self.session_id,
            "modbus_rtu",
            &self.config.port_name,
            None,
        );

        tlog!(
            "[ModbusRTU:{}] Opened {} @ {} baud (unit {}), {} poll group(s)",
            self.session_id,
            self.config.port_name,
            self.config.baud_rate,
            self.config.unit_id,
            self.config.polls.len()
        );

        // Spawn a single sequential poll task (RTU is half-duplex)
        let session_id = self.session_id.clone();
        let config = self.config.clone();
        let cancel_flag = self.cancel_flag.clone();

        let handle = tauri::async_runtime::spawn(async move {
            run_poll_loop(session_id, config, port, cancel_flag).await;
        });

        self.task_handle = Some(handle);
        self.state = IOState::Running;
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.cancel_flag.store(true, Ordering::Relaxed);

        if let Some(handle) = self.task_handle.take() {
            let _ = handle.await;
        }

        tlog!("[ModbusRTU:{}] Stopped", self.session_id);
        emit_stream_ended(&self.session_id, "stopped", "ModbusRTU");

        self.state = IOState::Stopped;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        Err("Modbus RTU is a live polling session and cannot be paused.".to_string())
    }

    async fn resume(&mut self) -> Result<(), String> {
        Err("Modbus RTU does not support pause/resume.".to_string())
    }

    fn set_speed(&mut self, _speed: f64) -> Result<(), String> {
        Err("Modbus RTU is a live polling session and does not support speed control.".to_string())
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("Modbus RTU does not support time range filtering.".to_string())
    }

    fn state(&self) -> IOState {
        self.state.clone()
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn device_type(&self) -> &'static str {
        "modbus_rtu"
    }
}

// ============================================================================
// Poll Loop (sequential — RTU is half-duplex)
// ============================================================================

async fn run_poll_loop(
    session_id: String,
    config: ModbusRtuConfig,
    port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    cancel_flag: Arc<AtomicBool>,
) {
    let mut throttle = SignalThrottle::new();
    let mut consecutive_errors: Vec<u32> = vec![0; config.polls.len()];
    let mut disabled: Vec<bool> = vec![false; config.polls.len()];
    let mut next_poll_time: Vec<Instant> = config
        .polls
        .iter()
        .map(|_| Instant::now())
        .collect();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }

        // Find the next poll that is due
        let now = Instant::now();
        let mut earliest_idx: Option<usize> = None;
        let mut earliest_time = now + Duration::from_secs(60);

        for (i, _poll) in config.polls.iter().enumerate() {
            if disabled[i] {
                continue;
            }
            if next_poll_time[i] <= now {
                // This poll is due — execute it immediately
                earliest_idx = Some(i);
                break;
            }
            if next_poll_time[i] < earliest_time {
                earliest_time = next_poll_time[i];
                earliest_idx = Some(i);
            }
        }

        let Some(poll_idx) = earliest_idx else {
            // All polls disabled
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };

        // Wait until the poll is due
        if next_poll_time[poll_idx] > now {
            let wait = next_poll_time[poll_idx] - now;
            tokio::time::sleep(wait).await;
            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }
        }

        let poll = &config.polls[poll_idx];

        // Schedule next poll
        next_poll_time[poll_idx] = Instant::now() + Duration::from_millis(poll.interval_ms);

        // Build and send request
        let request = build_rtu_request(config.unit_id, poll);
        let result = execute_rtu_request(
            &port,
            &request,
            poll,
            config.response_timeout_ms,
        );

        match result {
            Ok(bytes) => {
                consecutive_errors[poll_idx] = 0;

                let frame = FrameMessage {
                    protocol: "modbus".to_string(),
                    timestamp_us: now_us(),
                    frame_id: poll.frame_id,
                    bus: config.unit_id,
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
                consecutive_errors[poll_idx] += 1;

                let type_name = register_type_name(&poll.register_type);
                emit_session_error(
                    &session_id,
                    format!(
                        "RTU read error ({} @ {}): {}",
                        type_name, poll.start_register, e
                    ),
                );

                if config.max_register_errors > 0
                    && consecutive_errors[poll_idx] >= config.max_register_errors
                {
                    tlog!(
                        "[ModbusRTU:{}] Stopped polling {} reg {} after {} consecutive errors",
                        session_id, type_name, poll.start_register, consecutive_errors[poll_idx]
                    );
                    disabled[poll_idx] = true;
                }
            }
        }

        // Inter-request delay (important for bus timing)
        if config.inter_request_delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(config.inter_request_delay_ms)).await;
        }
    }
}

// ============================================================================
// RTU Request/Response
// ============================================================================

/// Build a Modbus RTU request frame with CRC.
fn build_rtu_request(unit_id: u8, poll: &PollGroup) -> Vec<u8> {
    let func_code: u8 = match poll.register_type {
        RegisterType::Coil => 0x01,     // Read Coils
        RegisterType::Discrete => 0x02, // Read Discrete Inputs
        RegisterType::Holding => 0x03,  // Read Holding Registers
        RegisterType::Input => 0x04,    // Read Input Registers
    };

    let pdu = [
        unit_id,
        func_code,
        (poll.start_register >> 8) as u8,
        (poll.start_register & 0xFF) as u8,
        (poll.count >> 8) as u8,
        (poll.count & 0xFF) as u8,
    ];

    // Append CRC-16 (little-endian)
    let crc = crc16_modbus_checksum(&pdu);
    let mut frame = Vec::with_capacity(8);
    frame.extend_from_slice(&pdu);
    frame.push((crc & 0xFF) as u8);
    frame.push((crc >> 8) as u8);
    frame
}

/// Execute a Modbus RTU request: send, read response, validate CRC, extract data bytes.
fn execute_rtu_request(
    port: &Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    request: &[u8],
    poll: &PollGroup,
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    let mut port = port.lock().map_err(|e| format!("Port lock error: {}", e))?;

    // Flush input buffer before sending (discard stale data)
    let _ = port.clear(serialport::ClearBuffer::Input);

    // Send request
    port.write_all(request)
        .map_err(|e| format!("Write error: {}", e))?;
    port.flush()
        .map_err(|e| format!("Flush error: {}", e))?;

    // Read response with timeout
    // Expected response: [unit_id, func_code, byte_count, data..., crc_lo, crc_hi]
    // Or error response: [unit_id, func_code|0x80, exception_code, crc_lo, crc_hi]
    let expected_data_bytes = expected_response_data_len(poll);
    let max_response_len = 3 + expected_data_bytes + 2; // header + data + CRC

    let mut buf = vec![0u8; max_response_len];
    let mut total_read = 0;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);

    while total_read < max_response_len {
        if Instant::now() > deadline {
            return Err(format!(
                "Response timeout (got {} of {} bytes)",
                total_read, max_response_len
            ));
        }

        match port.read(&mut buf[total_read..]) {
            Ok(0) => {
                return Err("Port closed".to_string());
            }
            Ok(n) => {
                total_read += n;

                // Check for error response (minimum 5 bytes)
                if total_read >= 5 && buf[1] & 0x80 != 0 {
                    // Error response received
                    let response = &buf[..5];
                    let crc_data = &response[..3];
                    let received_crc =
                        (response[3] as u16) | ((response[4] as u16) << 8);
                    let calc_crc = crc16_modbus_checksum(crc_data);
                    if received_crc == calc_crc {
                        return Err(format!(
                            "Modbus exception 0x{:02X}",
                            response[2]
                        ));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                // Continue waiting
                continue;
            }
            Err(e) => {
                return Err(format!("Read error: {}", e));
            }
        }
    }

    let response = &buf[..total_read];

    // Validate CRC
    if response.len() < 4 {
        return Err(format!("Response too short: {} bytes", response.len()));
    }
    let crc_data = &response[..response.len() - 2];
    let received_crc = (response[response.len() - 2] as u16)
        | ((response[response.len() - 1] as u16) << 8);
    let calc_crc = crc16_modbus_checksum(crc_data);
    if received_crc != calc_crc {
        return Err(format!(
            "CRC mismatch: received 0x{:04X}, calculated 0x{:04X}",
            received_crc, calc_crc
        ));
    }

    // Validate unit ID and function code
    if response[0] != request[0] {
        return Err(format!(
            "Unit ID mismatch: expected {}, got {}",
            request[0], response[0]
        ));
    }
    if response[1] != request[1] {
        return Err(format!(
            "Function code mismatch: expected 0x{:02X}, got 0x{:02X}",
            request[1], response[1]
        ));
    }

    // Extract data bytes (skip header: unit_id + func_code + byte_count)
    let byte_count = response[2] as usize;
    if response.len() < 3 + byte_count + 2 {
        return Err(format!(
            "Response data truncated: expected {} data bytes, got {}",
            byte_count,
            response.len().saturating_sub(5)
        ));
    }

    let data = response[3..3 + byte_count].to_vec();
    Ok(data)
}

/// Calculate expected data byte count for a response.
fn expected_response_data_len(poll: &PollGroup) -> usize {
    match poll.register_type {
        RegisterType::Holding | RegisterType::Input => {
            // 2 bytes per register
            poll.count as usize * 2
        }
        RegisterType::Coil | RegisterType::Discrete => {
            // 1 bit per coil, packed into bytes
            (poll.count as usize + 7) / 8
        }
    }
}

fn register_type_name(rt: &RegisterType) -> &'static str {
    match rt {
        RegisterType::Holding => "holding",
        RegisterType::Input => "input",
        RegisterType::Coil => "coil",
        RegisterType::Discrete => "discrete",
    }
}
