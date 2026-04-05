// src-tauri/src/io/virtual_device/mod.rs
//
// Virtual device — generates synthetic traffic for testing without real hardware.
// Supports CAN, CAN-FD, Modbus, and Serial traffic types.
// Loopback: transmitted frames/bytes are optionally echoed back as received data.
//
// Configuration (via profile.connection):
//   traffic_type       — "can" | "canfd" | "modbus" | "serial" (default "can")
//   loopback           — whether to echo transmitted data back (default true)
//   interfaces         — per-bus config array:
//     [{ bus: 0, signal_generator: true, frame_rate_hz: 10.0 }, ...]
//   If interfaces is absent, a single bus is created with defaults.

use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tauri::AppHandle;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::time::{interval, Duration};

use crate::capture_store::{self, CaptureKind, TimestampedByte};
use crate::io::{
    emit_device_connected, emit_stream_ended, now_us, signal_bytes_ready, signal_frames_ready,
    CanTransmitFrame, FrameMessage, IOCapabilities, IODevice, IOState, Protocol, SignalThrottle,
    TransmitPayload, TransmitResult, VirtualBusState,
};

// ============================================================================
// Configuration
// ============================================================================

/// Traffic type for the virtual device
#[derive(Clone, Debug, PartialEq)]
pub enum VirtualTrafficType {
    /// Classic CAN — 8-byte frames, standard IDs
    Can,
    /// CAN FD — up to 64-byte frames
    CanFd,
    /// Modbus — synthetic register frames
    Modbus,
    /// Serial — raw byte stream
    Serial,
}

/// Per-bus interface configuration
#[derive(Clone, Debug)]
pub struct VirtualInterfaceConfig {
    /// Bus number (0-7)
    pub bus: u8,
    /// Whether the signal generator is on for this bus
    pub signal_generator: bool,
    /// Frames/bytes per second to generate on this bus (default 10.0)
    pub frame_rate_hz: f64,
}

/// Virtual device configuration
#[derive(Clone, Debug)]
pub struct VirtualDeviceConfig {
    /// Type of traffic to generate
    pub traffic_type: VirtualTrafficType,
    /// Whether to echo transmitted data back as received (loopback)
    pub loopback: bool,
    /// Per-bus interface configurations
    pub interfaces: Vec<VirtualInterfaceConfig>,
}

impl Default for VirtualDeviceConfig {
    fn default() -> Self {
        Self {
            traffic_type: VirtualTrafficType::Can,
            loopback: true,
            interfaces: vec![VirtualInterfaceConfig {
                bus: 0,
                signal_generator: true,
                frame_rate_hz: 10.0,
            }],
        }
    }
}

// CAN frame patterns — matching canfd_test.py test signal generator
pub const CAN_PATTERNS: &[(u32, &[u8])] = &[
    (0x100, &[0xC0, 0xFF, 0xEE, 0x42, 0xC0, 0xFF, 0xEE, 0x42]),
    (0x200, &[0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    (0x300, &[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    (0x400, &[0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55]),
    (0x0F0, &[0xCA, 0xFE, 0xF0, 0x0D, 0xCA, 0xFE, 0xF0, 0x0D]),
    (0x500, &[0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]),
    (0x600, &[0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    (0x7FF, &[0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42]),
];

// Modbus register numbers to cycle through (holding registers)
pub const MODBUS_REGISTERS: &[u32] = &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/// Loopback message — either a CAN frame or raw bytes
enum LoopbackMessage {
    CanFrame(CanTransmitFrame),
    RawBytes(Vec<u8>),
}

// ============================================================================
// Virtual Device Reader
// ============================================================================

/// Virtual device — emits synthetic frames/bytes and optionally echoes transmits
pub struct VirtualDeviceReader {
    app: AppHandle,
    session_id: String,
    config: VirtualDeviceConfig,
    state: IOState,
    cancel_flag: Arc<AtomicBool>,
    /// Per-bus signal generator enable flags (shared with background tasks)
    bus_traffic_flags: Vec<Arc<AtomicBool>>,
    /// Per-bus cadence intervals in microseconds (shared with background tasks)
    bus_cadence_intervals: Vec<Arc<AtomicU64>>,
    task_handles: Vec<tauri::async_runtime::JoinHandle<()>>,
    /// Sender into the loopback task (None if loopback is disabled)
    loopback_tx: std::sync::Mutex<Option<UnboundedSender<LoopbackMessage>>>,
}

impl VirtualDeviceReader {
    pub fn new(app: AppHandle, session_id: String, config: VirtualDeviceConfig) -> Self {
        let bus_traffic_flags: Vec<Arc<AtomicBool>> = config
            .interfaces
            .iter()
            .map(|iface| Arc::new(AtomicBool::new(iface.signal_generator)))
            .collect();
        let bus_cadence_intervals: Vec<Arc<AtomicU64>> = config
            .interfaces
            .iter()
            .map(|iface| {
                let hz = iface.frame_rate_hz.clamp(0.1, 1000.0);
                Arc::new(AtomicU64::new((1_000_000.0 / hz) as u64))
            })
            .collect();
        Self {
            app,
            session_id,
            config,
            state: IOState::Stopped,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            bus_traffic_flags,
            bus_cadence_intervals,
            task_handles: Vec::new(),
            loopback_tx: std::sync::Mutex::new(None),
        }
    }
}

#[async_trait]
impl IODevice for VirtualDeviceReader {
    fn capabilities(&self) -> IOCapabilities {
        let buses: Vec<u8> = self.config.interfaces.iter().map(|i| i.bus).collect();
        let loopback = self.config.loopback;
        match self.config.traffic_type {
            VirtualTrafficType::Can => IOCapabilities::realtime_can()
                .with_buses(buses)
                .with_tx(loopback, false),
            VirtualTrafficType::CanFd => IOCapabilities::realtime_can()
                .with_buses(buses)
                .with_protocols(vec![Protocol::Can, Protocol::CanFd])
                .with_tx(loopback, false),
            VirtualTrafficType::Modbus => {
                let mut caps = IOCapabilities::realtime_can()
                    .with_buses(buses)
                    .with_protocols(vec![Protocol::Modbus]);
                caps.supports_extended_id = false;
                caps.supports_rtr = false;
                caps
            }
            VirtualTrafficType::Serial => {
                let mut caps = IOCapabilities::realtime_can()
                    .with_buses(buses)
                    .with_protocols(vec![Protocol::Serial])
                    .with_tx(false, loopback)
                    .with_data_streams(false, true);
                caps.supports_extended_id = false;
                caps.supports_rtr = false;
                caps
            }
        }
    }

    fn device_type(&self) -> &'static str {
        "virtual"
    }

    async fn start(&mut self) -> Result<(), String> {
        if self.state == IOState::Running {
            return Err("Virtual device is already running".to_string());
        }

        self.state = IOState::Starting;
        self.cancel_flag.store(false, Ordering::Relaxed);

        // Create loopback channel if loopback is enabled
        let loopback_rx = if self.config.loopback {
            let (tx, rx) = unbounded_channel::<LoopbackMessage>();
            if let Ok(mut guard) = self.loopback_tx.lock() {
                *guard = Some(tx);
            }
            Some(rx)
        } else {
            if let Ok(mut guard) = self.loopback_tx.lock() {
                *guard = None;
            }
            None
        };

        // Create capture for this session (kind depends on traffic mode)
        let kind = match self.config.traffic_type {
            VirtualTrafficType::Serial => CaptureKind::Bytes,
            _ => CaptureKind::Frames,
        };
        let capture_id = capture_store::create_capture(kind, self.session_id.clone());
        let _ = capture_store::set_capture_owner(&capture_id, &self.session_id);

        let traffic_type_name = match self.config.traffic_type {
            VirtualTrafficType::Can => "CAN",
            VirtualTrafficType::CanFd => "CAN-FD",
            VirtualTrafficType::Modbus => "Modbus",
            VirtualTrafficType::Serial => "Serial",
        };

        // Emit connected event
        emit_device_connected(
            &self.session_id,
            "virtual",
            &format!("virtual://{}", traffic_type_name.to_lowercase()),
            None,
        );

        let iface_summary: Vec<String> = self
            .config
            .interfaces
            .iter()
            .map(|i| {
                let gen = if i.signal_generator { "ON" } else { "OFF" };
                format!("bus{}({:.1}Hz,gen={})", i.bus, i.frame_rate_hz, gen)
            })
            .collect();
        tlog!(
            "[Virtual:{}] Started — {} loopback={} [{}]",
            self.session_id,
            traffic_type_name,
            self.config.loopback,
            iface_summary.join(", ")
        );

        // Spawn one generator task per bus interface
        for (idx, iface) in self.config.interfaces.iter().enumerate() {
            let traffic_flag = self.bus_traffic_flags[idx].clone();
            let cadence_interval = self.bus_cadence_intervals[idx].clone();
            let handle = spawn_bus_generator(
                self.app.clone(),
                self.session_id.clone(),
                self.config.traffic_type.clone(),
                iface.clone(),
                self.cancel_flag.clone(),
                traffic_flag,
                cadence_interval,
            );
            self.task_handles.push(handle);
        }

        // Spawn loopback task if enabled
        if let Some(rx) = loopback_rx {
            let handle = spawn_loopback_handler(
                self.app.clone(),
                self.session_id.clone(),
                self.config.traffic_type.clone(),
                self.cancel_flag.clone(),
                rx,
            );
            self.task_handles.push(handle);
        }

        self.state = IOState::Running;
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.cancel_flag.store(true, Ordering::Relaxed);

        // Drop the loopback sender so the loopback task exits
        if let Ok(mut guard) = self.loopback_tx.lock() {
            *guard = None;
        }

        for handle in self.task_handles.drain(..) {
            let _ = handle.await;
        }

        tlog!("[Virtual:{}] Stream ended", self.session_id);
        emit_stream_ended(&self.session_id, "stopped", "Virtual");

        self.state = IOState::Stopped;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        Err("Virtual device is a live stream and cannot be paused.".to_string())
    }

    async fn resume(&mut self) -> Result<(), String> {
        Err("Virtual device is a live stream and does not support pause/resume.".to_string())
    }

    fn set_speed(&mut self, _speed: f64) -> Result<(), String> {
        Err("Virtual device does not support speed control.".to_string())
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("Virtual device does not support time range filtering.".to_string())
    }

    fn transmit(&self, payload: &TransmitPayload) -> Result<TransmitResult, String> {
        if !self.config.loopback {
            return Err("Loopback is disabled on this virtual device.".to_string());
        }
        match (&self.config.traffic_type, payload) {
            // CAN / CAN-FD: echo frame as loopback
            (VirtualTrafficType::Can | VirtualTrafficType::CanFd, TransmitPayload::CanFrame(frame)) => {
                if let Ok(guard) = self.loopback_tx.lock() {
                    if let Some(sender) = guard.as_ref() {
                        let _ = sender.send(LoopbackMessage::CanFrame(frame.clone()));
                    }
                }
                Ok(TransmitResult::success())
            }
            // Serial: echo bytes as loopback
            (VirtualTrafficType::Serial, TransmitPayload::RawBytes(bytes)) => {
                if let Ok(guard) = self.loopback_tx.lock() {
                    if let Some(sender) = guard.as_ref() {
                        let _ = sender.send(LoopbackMessage::RawBytes(bytes.clone()));
                    }
                }
                Ok(TransmitResult::success())
            }
            // Modbus: no transmit support
            (VirtualTrafficType::Modbus, _) => {
                Err("Virtual Modbus device does not support transmission.".to_string())
            }
            // Mismatched payload type
            (VirtualTrafficType::Can | VirtualTrafficType::CanFd, TransmitPayload::RawBytes(_)) => {
                Err("Virtual CAN device does not support raw byte transmission.".to_string())
            }
            (VirtualTrafficType::Serial, TransmitPayload::CanFrame(_)) => {
                Err("Virtual Serial device does not support CAN frame transmission.".to_string())
            }
        }
    }

    fn set_traffic_enabled(&mut self, enabled: bool) -> Result<(), String> {
        for flag in &self.bus_traffic_flags {
            flag.store(enabled, Ordering::Relaxed);
        }
        let state = if enabled { "ON" } else { "OFF" };
        tlog!("[Virtual:{}] Signal generator {} (all buses)", self.session_id, state);
        Ok(())
    }

    fn set_bus_traffic_enabled(&mut self, bus: u8, enabled: bool) -> Result<(), String> {
        let idx = self.config.interfaces.iter().position(|i| i.bus == bus)
            .ok_or_else(|| format!("No virtual interface for bus {}", bus))?;
        self.bus_traffic_flags[idx].store(enabled, Ordering::Relaxed);
        let state = if enabled { "ON" } else { "OFF" };
        tlog!("[Virtual:{}] Signal generator {} (bus {})", self.session_id, state, bus);
        Ok(())
    }

    fn set_bus_cadence(&mut self, bus: u8, frame_rate_hz: f64) -> Result<(), String> {
        let idx = self.config.interfaces.iter().position(|i| i.bus == bus)
            .ok_or_else(|| format!("No virtual interface for bus {}", bus))?;
        let hz = frame_rate_hz.clamp(0.1, 1000.0);
        let interval_us = (1_000_000.0 / hz) as u64;
        self.bus_cadence_intervals[idx].store(interval_us, Ordering::Relaxed);
        tlog!("[Virtual:{}] Cadence set to {:.1} Hz (bus {})", self.session_id, hz, bus);
        Ok(())
    }

    fn virtual_bus_states(&self) -> Result<Vec<VirtualBusState>, String> {
        let states: Vec<VirtualBusState> = self.config.interfaces.iter().enumerate().map(|(i, iface)| {
            let interval_us = self.bus_cadence_intervals[i].load(Ordering::Relaxed) as f64;
            let frame_rate_hz = if interval_us > 0.0 { 1_000_000.0 / interval_us } else { 0.0 };
            VirtualBusState {
                bus: iface.bus,
                enabled: self.bus_traffic_flags[i].load(Ordering::Relaxed),
                frame_rate_hz,
            }
        }).collect();
        Ok(states)
    }

    fn state(&self) -> IOState {
        self.state.clone()
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }
}

// ============================================================================
// CAN-FD frame patterns — matching canfd_test.py
// ============================================================================

/// Build a 64-byte CAN-FD payload by repeating a pattern
pub fn repeat_to_64(pattern: &[u8]) -> Vec<u8> {
    pattern.iter().cycle().take(64).copied().collect()
}

/// Get the CAN-FD patterns (64-byte payloads)
pub fn canfd_patterns() -> Vec<(u32, Vec<u8>)> {
    vec![
        (0x100, repeat_to_64(&[0xC0, 0xFF, 0xEE, 0x42])),
        (0x200, (0u8..64).collect()),
        (0x300, vec![0xFF; 64]),
        (0x400, repeat_to_64(&[0xAA, 0x55])),
        (0x0F0, repeat_to_64(&[0xCA, 0xFE, 0xF0, 0x0D])),
        (0x500, repeat_to_64(&[0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80])),
        (0x600, vec![0x00; 8]),   // Classic-size zeros
        (0x7FF, vec![0x42; 48]),  // 48-byte payload
    ]
}

// ============================================================================
// Per-Bus Generator Task
// ============================================================================

/// Spawn a background task that generates traffic for a single bus interface
fn spawn_bus_generator(
    _app: AppHandle,
    session_id: String,
    traffic_type: VirtualTrafficType,
    iface: VirtualInterfaceConfig,
    cancel_flag: Arc<AtomicBool>,
    traffic_enabled: Arc<AtomicBool>,
    cadence_interval_us: Arc<AtomicU64>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let hz = iface.frame_rate_hz.clamp(0.1, 1000.0);
        let mut current_interval_us = (1_000_000.0 / hz) as u64;
        let mut ticker = interval(Duration::from_micros(current_interval_us));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut throttle = SignalThrottle::new();

        // Pre-compute CAN-FD patterns (heap-allocated, done once)
        let canfd_pats = if traffic_type == VirtualTrafficType::CanFd {
            canfd_patterns()
        } else {
            Vec::new()
        };

        let bus = iface.bus;
        let mut counter: u64 = 0;

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }

            ticker.tick().await;

            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }

            // Check if cadence changed at runtime
            let new_interval_us = cadence_interval_us.load(Ordering::Relaxed);
            if new_interval_us != current_interval_us {
                current_interval_us = new_interval_us;
                ticker = interval(Duration::from_micros(current_interval_us));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                // Consume the immediate first tick
                ticker.tick().await;
            }

            // Only generate traffic if signal generator is enabled for this bus
            if !traffic_enabled.load(Ordering::Relaxed) {
                continue;
            }

            let ts = now_us();

            match traffic_type {
                VirtualTrafficType::Can => {
                    let pattern_idx = (counter as usize) % (CAN_PATTERNS.len() + 1);
                    let (frame_id, data) = if pattern_idx < CAN_PATTERNS.len() {
                        let (id, pat) = CAN_PATTERNS[pattern_idx];
                        (id, pat.to_vec())
                    } else {
                        // Counter frame (0x7E0)
                        let cycle = (counter / (CAN_PATTERNS.len() as u64 + 1)) + 1;
                        let c = (cycle as u16).to_be_bytes();
                        (0x7E0, vec![c[0], c[1], c[0], c[1], c[0], c[1], c[0], c[1]])
                    };

                    let frame = FrameMessage {
                        protocol: "can".to_string(),
                        timestamp_us: ts,
                        frame_id,
                        bus,
                        dlc: data.len() as u8,
                        bytes: data,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };

                    capture_store::append_frames_to_session(&session_id, vec![frame]);
                    if throttle.should_signal("frames-ready") {
                        signal_frames_ready(&session_id);
                    }
                }
                VirtualTrafficType::CanFd => {
                    let pattern_idx = (counter as usize) % (canfd_pats.len() + 1);
                    let (frame_id, data) = if pattern_idx < canfd_pats.len() {
                        let (id, ref pat) = canfd_pats[pattern_idx];
                        (id, pat.clone())
                    } else {
                        // Counter frame (0x7E0) — 64 bytes
                        let cycle = (counter / (canfd_pats.len() as u64 + 1)) + 1;
                        let c = (cycle as u16).to_be_bytes();
                        (0x7E0, vec![c[0], c[1]].into_iter().cycle().take(64).collect())
                    };

                    let frame = FrameMessage {
                        protocol: "can".to_string(),
                        timestamp_us: ts,
                        frame_id,
                        bus,
                        dlc: data.len() as u8,
                        bytes: data,
                        is_extended: false,
                        is_fd: true,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };

                    capture_store::append_frames_to_session(&session_id, vec![frame]);
                    if throttle.should_signal("frames-ready") {
                        signal_frames_ready(&session_id);
                    }
                }
                VirtualTrafficType::Modbus => {
                    let reg_idx = (counter as usize) % MODBUS_REGISTERS.len();
                    let register = MODBUS_REGISTERS[reg_idx];
                    let value = ((counter / MODBUS_REGISTERS.len() as u64) & 0xFFFF) as u16;
                    let bytes = value.to_be_bytes().to_vec();

                    let frame = FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: ts,
                        frame_id: register,
                        bus,
                        dlc: bytes.len() as u8,
                        bytes,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };

                    capture_store::append_frames_to_session(&session_id, vec![frame]);
                    if throttle.should_signal("frames-ready") {
                        signal_frames_ready(&session_id);
                    }
                }
                VirtualTrafficType::Serial => {
                    let byte_val = (counter & 0xFF) as u8;
                    let entries: Vec<TimestampedByte> = (0..8)
                        .map(|i| TimestampedByte {
                            byte: byte_val.wrapping_add(i),
                            timestamp_us: ts + i as u64,
                            bus,
                        })
                        .collect();

                    capture_store::append_raw_bytes_to_session(&session_id, entries);
                    if throttle.should_signal("bytes-ready") {
                        signal_bytes_ready(&session_id);
                    }
                }
            }

            counter = counter.wrapping_add(1);
        }
    })
}

// ============================================================================
// Loopback Handler Task
// ============================================================================

/// Spawn a task that handles loopback: echoes transmitted frames/bytes back as received
fn spawn_loopback_handler(
    _app: AppHandle,
    session_id: String,
    traffic_type: VirtualTrafficType,
    cancel_flag: Arc<AtomicBool>,
    mut loopback_rx: tokio::sync::mpsc::UnboundedReceiver<LoopbackMessage>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut throttle = SignalThrottle::new();
        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }

            match loopback_rx.recv().await {
                Some(LoopbackMessage::CanFrame(tx_frame)) => {
                    let ts = now_us();
                    let is_fd = matches!(traffic_type, VirtualTrafficType::CanFd) || tx_frame.is_fd;
                    let frame = FrameMessage {
                        protocol: "can".to_string(),
                        timestamp_us: ts,
                        frame_id: tx_frame.frame_id,
                        bus: tx_frame.bus,
                        dlc: tx_frame.data.len() as u8,
                        bytes: tx_frame.data,
                        is_extended: tx_frame.is_extended,
                        is_fd,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };
                    capture_store::append_frames_to_session(&session_id, vec![frame]);
                    if throttle.should_signal("frames-ready") {
                        signal_frames_ready(&session_id);
                    }
                }
                Some(LoopbackMessage::RawBytes(bytes)) => {
                    let ts = now_us();
                    let entries: Vec<TimestampedByte> = bytes
                        .into_iter()
                        .enumerate()
                        .map(|(i, byte)| TimestampedByte {
                            byte,
                            timestamp_us: ts + i as u64,
                            bus: 0,
                        })
                        .collect();
                    capture_store::append_raw_bytes_to_session(&session_id, entries);
                    if throttle.should_signal("bytes-ready") {
                        signal_bytes_ready(&session_id);
                    }
                }
                None => {
                    // Sender dropped (device stopped) — exit
                    break;
                }
            }
        }
    })
}
