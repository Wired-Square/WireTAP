// src-tauri/src/io/virtual_device/mod.rs
//
// Virtual CAN device — generates synthetic CAN frames for testing without
// real hardware. Supports loopback: transmitted frames are echoed back as
// received frames so the transmit path can be exercised end-to-end.
//
// Configuration (via profile.connection):
//   frame_rate_hz  — frames per second to generate (default 10.0, max 1000.0)
//   bus_count      — number of CAN buses to simulate (default 1, max 8)

use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::time::{interval, Duration};

use crate::io::{
    emit_device_connected, emit_frames, emit_stream_ended, now_us, CanTransmitFrame, FrameMessage,
    IOCapabilities, IODevice, IOState, TransmitPayload, TransmitResult,
};
use crate::buffer_store::{self, BufferType};

// ============================================================================
// Configuration
// ============================================================================

/// Virtual CAN device configuration
#[derive(Clone, Debug)]
pub struct VirtualDeviceConfig {
    /// Frames per second to generate (default 10.0)
    pub frame_rate_hz: f64,
    /// Number of simulated CAN buses (default 1)
    pub bus_count: u8,
}

impl Default for VirtualDeviceConfig {
    fn default() -> Self {
        Self {
            frame_rate_hz: 10.0,
            bus_count: 1,
        }
    }
}

// Frame IDs to cycle through during generation
const SYNTHETIC_FRAME_IDS: &[u32] = &[
    0x100, 0x200, 0x300, 0x123, 0x456, 0x700, 0x1FF, 0x7FF,
];

// ============================================================================
// Virtual Device Reader
// ============================================================================

/// Virtual CAN device — emits synthetic frames and echoes transmits as loopback
pub struct VirtualDeviceReader {
    app: AppHandle,
    session_id: String,
    config: VirtualDeviceConfig,
    state: IOState,
    cancel_flag: Arc<AtomicBool>,
    task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Sender into the background task for loopback transmit
    loopback_tx: std::sync::Mutex<Option<UnboundedSender<CanTransmitFrame>>>,
}

impl VirtualDeviceReader {
    pub fn new(app: AppHandle, session_id: String, config: VirtualDeviceConfig) -> Self {
        Self {
            app,
            session_id,
            config,
            state: IOState::Stopped,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            task_handle: None,
            loopback_tx: std::sync::Mutex::new(None),
        }
    }
}

#[async_trait]
impl IODevice for VirtualDeviceReader {
    fn capabilities(&self) -> IOCapabilities {
        let buses: Vec<u8> = (0..self.config.bus_count).collect();
        IOCapabilities {
            can_transmit: true,
            ..IOCapabilities::realtime_can().with_buses(buses)
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

        // Create loopback channel — sender stored in self, receiver goes to the task
        let (tx, rx) = unbounded_channel::<CanTransmitFrame>();
        if let Ok(mut guard) = self.loopback_tx.lock() {
            *guard = Some(tx);
        }

        let handle = spawn_virtual_stream(
            self.app.clone(),
            self.session_id.clone(),
            self.config.clone(),
            self.cancel_flag.clone(),
            rx,
        );

        self.task_handle = Some(handle);
        self.state = IOState::Running;

        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.cancel_flag.store(true, Ordering::Relaxed);

        // Drop the sender so the background task's recv returns None
        if let Ok(mut guard) = self.loopback_tx.lock() {
            *guard = None;
        }

        if let Some(handle) = self.task_handle.take() {
            let _ = handle.await;
        }

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
        match payload {
            TransmitPayload::CanFrame(frame) => {
                // Echo the transmitted frame back as a received frame (loopback)
                if let Ok(guard) = self.loopback_tx.lock() {
                    if let Some(sender) = guard.as_ref() {
                        let _ = sender.send(frame.clone());
                    }
                }
                Ok(TransmitResult::success())
            }
            TransmitPayload::RawBytes(_) => {
                Err("Virtual CAN device does not support raw byte transmission.".to_string())
            }
        }
    }

    fn state(&self) -> IOState {
        self.state.clone()
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }
}

// ============================================================================
// Background Stream Task
// ============================================================================

fn spawn_virtual_stream(
    app: AppHandle,
    session_id: String,
    config: VirtualDeviceConfig,
    cancel_flag: Arc<AtomicBool>,
    mut loopback_rx: tokio::sync::mpsc::UnboundedReceiver<CanTransmitFrame>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        // Create a buffer for this session
        let buffer_id = buffer_store::create_buffer(BufferType::Frames, session_id.clone());
        let _ = buffer_store::set_buffer_owner(&buffer_id, &session_id);

        // Clamp frame rate to a sane range
        let hz = config.frame_rate_hz.clamp(0.1, 1000.0);
        let interval_us = (1_000_000.0 / hz) as u64;
        let mut ticker = interval(Duration::from_micros(interval_us));
        // Skip the immediate first tick so we don't emit before Connected
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Emit connected event
        emit_device_connected(
            &app,
            &session_id,
            "virtual",
            "virtual://internal",
            None,
        );

        tlog!(
            "[Virtual:{}] Started — {:.1} Hz, {} bus(es)",
            session_id, hz, config.bus_count
        );

        let mut counter: u64 = 0;

        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }

            tokio::select! {
                _ = ticker.tick() => {
                    // Generate synthetic frame
                    let frame_id = SYNTHETIC_FRAME_IDS[(counter as usize) % SYNTHETIC_FRAME_IDS.len()];
                    let bus = (counter as u8) % config.bus_count;

                    // Data: first 4 bytes = counter (big-endian), last 4 = timestamp low bits
                    let ts = now_us();
                    let data = vec![
                        ((counter >> 24) & 0xFF) as u8,
                        ((counter >> 16) & 0xFF) as u8,
                        ((counter >> 8) & 0xFF) as u8,
                        (counter & 0xFF) as u8,
                        ((ts >> 24) & 0xFF) as u8,
                        ((ts >> 16) & 0xFF) as u8,
                        ((ts >> 8) & 0xFF) as u8,
                        (ts & 0xFF) as u8,
                    ];

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

                    buffer_store::append_frames(vec![frame.clone()]);
                    emit_frames(&app, &session_id, vec![frame]);
                    counter = counter.wrapping_add(1);
                }

                // Loopback: echo transmitted frames back as received
                loopback = loopback_rx.recv() => {
                    match loopback {
                        Some(tx_frame) => {
                            let ts = now_us();
                            let frame = FrameMessage {
                                protocol: "can".to_string(),
                                timestamp_us: ts,
                                frame_id: tx_frame.frame_id,
                                bus: tx_frame.bus,
                                dlc: tx_frame.data.len() as u8,
                                bytes: tx_frame.data,
                                is_extended: tx_frame.is_extended,
                                is_fd: tx_frame.is_fd,
                                source_address: None,
                                incomplete: None,
                                direction: Some("rx".to_string()),
                            };
                            buffer_store::append_frames(vec![frame.clone()]);
                            emit_frames(&app, &session_id, vec![frame]);
                        }
                        None => {
                            // Sender dropped (device stopped) — exit loop
                            break;
                        }
                    }
                }
            }

            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }
        }

        tlog!("[Virtual:{}] Stream ended", session_id);
        emit_stream_ended(&app, &session_id, "stopped", "Virtual");
    })
}
