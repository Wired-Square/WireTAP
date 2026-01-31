// src-tauri/src/io/gs_usb/nusb_driver.rs
//
// gs_usb reader implementation using nusb crate (Windows and macOS).
//
// On Windows and macOS, there's no kernel driver for gs_usb devices, so we access
// the USB device directly using nusb for control and bulk transfers.

use async_trait::async_trait;
use nusb::transfer::{ControlIn, ControlOut, ControlType, Recipient};
use nusb::{Interface, MaybeFuture};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

use super::{
    can_id_flags, can_mode, get_bittiming_for_bitrate, GsDeviceBittiming, GsDeviceConfig,
    GsDeviceMode, GsHostFrame, GsUsbBreq, GsUsbConfig, GsUsbDeviceInfo, GsUsbProbeResult,
    GS_USB_HOST_FORMAT, GS_USB_PIDS, GS_USB_VID,
};
use tokio::sync::mpsc;

use crate::buffer_store::{self, BufferType};
use crate::io::error::IoError;
use crate::io::gvret::{apply_bus_mapping, BusMapping};
use crate::io::types::{SourceMessage, TransmitRequest, TransmitSender};
use crate::io::{
    emit_frames, emit_session_error, emit_stream_ended, now_us, CanTransmitFrame, FrameMessage,
    IOCapabilities, IODevice, IOState, TransmitPayload, TransmitResult,
};

/// Encode a CAN frame into gs_usb GsHostFrame format (20 bytes)
pub fn encode_frame(frame: &CanTransmitFrame, channel: u8) -> Vec<u8> {
    let mut buf = vec![0u8; GsHostFrame::SIZE];

    // echo_id: non-0xFFFFFFFF for TX (using 0 for simplicity)
    buf[0..4].copy_from_slice(&0u32.to_le_bytes());

    // can_id with flags
    let mut can_id = frame.frame_id;
    if frame.is_extended {
        can_id |= can_id_flags::EXTENDED;
    }
    if frame.is_rtr {
        can_id |= can_id_flags::RTR;
    }
    buf[4..8].copy_from_slice(&can_id.to_le_bytes());

    // can_dlc
    buf[8] = frame.data.len() as u8;

    // channel
    buf[9] = channel;

    // flags (0 for standard CAN)
    buf[10] = 0;

    // reserved
    buf[11] = 0;

    // data (up to 8 bytes)
    let len = frame.data.len().min(8);
    buf[12..12 + len].copy_from_slice(&frame.data[..len]);

    buf
}

/// Timeout for USB control transfers
const CONTROL_TIMEOUT: Duration = Duration::from_millis(1000);

// ============================================================================
// Device Matching
// ============================================================================

/// Check if a USB device matches by serial number (preferred) or bus:address (fallback).
/// Returns true if:
/// - serial is Some and matches the device's serial number, OR
/// - serial is None and bus:address matches
fn device_matches(dev: &nusb::DeviceInfo, serial: Option<&str>, bus: u8, address: u8) -> bool {
    // Must be a gs_usb device
    if dev.vendor_id() != GS_USB_VID || !GS_USB_PIDS.contains(&dev.product_id()) {
        return false;
    }

    // Prefer serial number matching when available
    if let Some(target_serial) = serial {
        if let Some(dev_serial) = dev.serial_number() {
            return dev_serial == target_serial;
        }
    }

    // Fall back to bus:address matching
    let dev_bus = dev.bus_id().parse::<u8>().unwrap_or(0);
    dev_bus == bus && dev.device_address() == address
}

// ============================================================================
// Device Enumeration
// ============================================================================

/// List all gs_usb devices on the system
pub fn list_devices() -> Result<Vec<GsUsbDeviceInfo>, String> {
    // nusb 0.2 list_devices() returns MaybeFuture - use .wait() for sync blocking
    let devices: Vec<GsUsbDeviceInfo> = nusb::list_devices()
        .wait()
        .map_err(|e| format!("Failed to list USB devices: {}", e))?
        .filter(|dev| {
            dev.vendor_id() == GS_USB_VID && GS_USB_PIDS.contains(&dev.product_id())
        })
        .map(|dev| {
            // bus_id() returns &str, but for our purposes we use device_address as primary identifier
            // Parse bus_id as u8 if possible (works on Linux), otherwise use 0
            let bus = dev.bus_id().parse::<u8>().unwrap_or(0);
            GsUsbDeviceInfo {
                bus,
                address: dev.device_address(),
                product: dev.product_string().unwrap_or_default().to_string(),
                serial: dev.serial_number().map(|s| s.to_string()),
                interface_name: None, // Windows/macOS don't have SocketCAN
                interface_up: None,
            }
        })
        .collect();

    Ok(devices)
}

/// Probe a specific gs_usb device to get its capabilities
pub fn probe_device(bus: u8, address: u8) -> Result<GsUsbProbeResult, IoError> {
    let device = format!("gs_usb({}:{})", bus, address);

    // Find the device using blocking .wait()
    let device_info = nusb::list_devices()
        .wait()
        .map_err(|e| IoError::other(&device, format!("list USB devices: {}", e)))?
        .find(|dev| device_matches(dev, None, bus, address))
        .ok_or_else(|| IoError::not_found(&device))?;

    // Open the device (also returns MaybeFuture)
    let dev_handle = device_info
        .open()
        .wait()
        .map_err(|e| IoError::connection(&device, e.to_string()))?;

    // Claim interface 0 (also returns MaybeFuture)
    let interface = dev_handle
        .claim_interface(0)
        .wait()
        .map_err(|_| IoError::busy(&device))?;

    // Query device config (blocking via wait)
    let config = get_device_config_sync(&interface)
        .map_err(|e| IoError::protocol(&device, e))?;

    // icount is 0-indexed (number of interfaces - 1), so add 1 to get count
    Ok(GsUsbProbeResult {
        success: true,
        channel_count: Some(config.icount + 1),
        sw_version: Some(config.sw_version),
        hw_version: Some(config.hw_version),
        can_clock: None, // Would need to query BT_CONST
        supports_fd: None,
        error: None,
    })
}

/// Get device configuration via USB control transfer (sync version)
fn get_device_config_sync(interface: &Interface) -> Result<GsDeviceConfig, String> {
    let data = interface
        .control_in(ControlIn {
            control_type: ControlType::Vendor,
            recipient: Recipient::Interface,
            request: GsUsbBreq::DeviceConfig as u8,
            value: 1,
            index: 0,
            length: GsDeviceConfig::SIZE as u16,
        }, CONTROL_TIMEOUT)
        .wait()
        .map_err(|e| format!("Control transfer failed: {:?}", e))?;

    GsDeviceConfig::from_bytes(&data).ok_or_else(|| {
        format!(
            "Incomplete response: got {} bytes, expected {}",
            data.len(),
            GsDeviceConfig::SIZE
        )
    })
}

// ============================================================================
// GsUsbReader Implementation
// ============================================================================

/// gs_usb reader for Windows/macOS with transmit support
pub struct GsUsbReader {
    app: AppHandle,
    session_id: String,
    config: GsUsbConfig,
    state: IOState,
    cancel_flag: Arc<AtomicBool>,
    task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Channel sender for transmit requests (allows sync transmit_frame calls)
    transmit_tx: Arc<Mutex<Option<TransmitSender>>>,
}

impl GsUsbReader {
    pub fn new(app: AppHandle, session_id: String, config: GsUsbConfig) -> Self {
        Self {
            app,
            session_id,
            config,
            state: IOState::Stopped,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            task_handle: None,
            transmit_tx: Arc::new(Mutex::new(None)),
        }
    }
}

#[async_trait]
impl IODevice for GsUsbReader {
    fn capabilities(&self) -> IOCapabilities {
        IOCapabilities::realtime_can()
            .with_transmit(!self.config.listen_only)
            .with_buses(vec![self.config.channel])
    }

    async fn start(&mut self) -> Result<(), String> {
        if self.state == IOState::Running {
            return Err("Reader is already running".to_string());
        }

        self.state = IOState::Starting;
        self.cancel_flag.store(false, Ordering::Relaxed);

        // Create transmit channel (only if not in listen-only mode)
        let transmit_rx = if !self.config.listen_only {
            let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
            // Store the sender for transmit_frame calls
            {
                let mut guard = self
                    .transmit_tx
                    .lock()
                    .map_err(|e| format!("Failed to lock transmit_tx: {}", e))?;
                *guard = Some(transmit_tx);
            }
            Some(transmit_rx)
        } else {
            None
        };

        let app = self.app.clone();
        let session_id = self.session_id.clone();
        let config = self.config.clone();
        let cancel_flag = self.cancel_flag.clone();

        let handle = spawn_gs_usb_stream(app, session_id, config, cancel_flag, transmit_rx);
        self.task_handle = Some(handle);
        self.state = IOState::Running;

        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.cancel_flag.store(true, Ordering::Relaxed);

        // Clear the transmit sender
        if let Ok(mut guard) = self.transmit_tx.lock() {
            *guard = None;
        }

        if let Some(handle) = self.task_handle.take() {
            let _ = handle.await;
        }

        self.state = IOState::Stopped;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        Err("gs_usb is a live stream and cannot be paused.".to_string())
    }

    async fn resume(&mut self) -> Result<(), String> {
        Err("gs_usb is a live stream and does not support pause/resume.".to_string())
    }

    fn set_speed(&mut self, _speed: f64) -> Result<(), String> {
        Err("gs_usb is a live stream and does not support speed control.".to_string())
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("gs_usb is a live stream and does not support time range filtering.".to_string())
    }

    fn state(&self) -> IOState {
        self.state.clone()
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn transmit(&self, payload: &TransmitPayload) -> Result<TransmitResult, String> {
        let frame = match payload {
            TransmitPayload::CanFrame(f) => f,
            TransmitPayload::RawBytes(_) => {
                return Err("gs_usb devices do not support raw byte transmission".to_string());
            }
        };

        if self.config.listen_only {
            return Err(
                "Cannot transmit in listen-only mode. Disable listen-only in profile settings."
                    .to_string(),
            );
        }

        // Validate frame
        if frame.data.len() > 8 {
            return Ok(TransmitResult::error("Data length exceeds 8 bytes".to_string()));
        }

        // Encode frame as GsHostFrame
        let data = encode_frame(frame, self.config.channel);

        // Get the transmit sender
        let tx = {
            let guard = self
                .transmit_tx
                .lock()
                .map_err(|e| format!("Failed to lock transmit channel: {}", e))?;
            guard.clone().ok_or("Not connected (no transmit channel)")?
        };

        // Create a sync channel to receive the result
        let (result_tx, result_rx) = std_mpsc::sync_channel(1);

        // Send the transmit request
        tx.try_send(TransmitRequest { data, result_tx })
            .map_err(|e| format!("Failed to queue transmit request: {}", e))?;

        // Wait for the result with a timeout
        let result = result_rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .map_err(|e| format!("Transmit timeout or channel closed: {}", e))?;

        result?;

        Ok(TransmitResult::success())
    }
}

// ============================================================================
// Stream Implementation
// ============================================================================

fn spawn_gs_usb_stream(
    app_handle: AppHandle,
    session_id: String,
    config: GsUsbConfig,
    cancel_flag: Arc<AtomicBool>,
    transmit_rx: Option<std_mpsc::Receiver<TransmitRequest>>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        run_gs_usb_stream(app_handle, session_id, config, cancel_flag, transmit_rx).await;
    })
}

async fn run_gs_usb_stream(
    app_handle: AppHandle,
    session_id: String,
    config: GsUsbConfig,
    cancel_flag: Arc<AtomicBool>,
    transmit_rx: Option<std_mpsc::Receiver<TransmitRequest>>,
) {
    let buffer_name = config
        .display_name
        .clone()
        .unwrap_or_else(|| format!("gs_usb {}:{}", config.bus, config.address));
    let _buffer_id = buffer_store::create_buffer(BufferType::Frames, buffer_name);
    let device_name = format!("gs_usb({}:{})", config.bus, config.address);

    #[allow(unused_assignments)]
    let mut stream_reason = "disconnected";
    let mut total_frames: i64 = 0;

    // Find and open device - use .await in async context
    // Prefer serial number matching when available, fall back to bus:address
    let device_info = match nusb::list_devices().await {
        Ok(mut devices) => devices
            .find(|dev| device_matches(dev, config.serial.as_deref(), config.bus, config.address))
            .ok_or_else(|| IoError::not_found(&device_name).to_string()),
        Err(e) => Err(IoError::other(&device_name, format!("list devices: {}", e)).to_string()),
    };

    let device_info = match device_info {
        Ok(d) => d,
        Err(e) => {
            emit_session_error(&app_handle, &session_id, e);
            emit_stream_ended(&app_handle, &session_id, "error", "gs_usb");
            return;
        }
    };

    let usb_device = match device_info.open().await {
        Ok(d) => d,
        Err(e) => {
            emit_session_error(&app_handle, &session_id, IoError::connection(&device_name, e.to_string()).to_string());
            emit_stream_ended(&app_handle, &session_id, "error", "gs_usb");
            return;
        }
    };

    let interface = match usb_device.claim_interface(0).await {
        Ok(i) => i,
        Err(_) => {
            emit_session_error(&app_handle, &session_id, IoError::busy(&device_name).to_string());
            emit_stream_ended(&app_handle, &session_id, "error", "gs_usb");
            return;
        }
    };

    eprintln!(
        "[gs_usb:{}] Opened device at {}:{} (bitrate: {}, listen_only: {})",
        session_id, config.bus, config.address, config.bitrate, config.listen_only
    );

    // Initialize device
    if let Err(e) = initialize_device(&interface, &config).await {
        emit_session_error(&app_handle, &session_id, IoError::protocol(&device_name, format!("initialize: {}", e)).to_string());
        emit_stream_ended(&app_handle, &session_id, "error", "gs_usb");
        return;
    }

    eprintln!("[gs_usb:{}] Device initialized, starting stream", session_id);

    // Bulk IN endpoint (usually 0x81 = EP1 IN)
    let mut bulk_in = match interface.endpoint::<nusb::transfer::Bulk, nusb::transfer::In>(0x81) {
        Ok(ep) => ep,
        Err(e) => {
            emit_session_error(&app_handle, &session_id, IoError::protocol(&device_name, format!("open bulk IN endpoint: {}", e)).to_string());
            emit_stream_ended(&app_handle, &session_id, "error", "gs_usb");
            return;
        }
    };

    // Spawn a dedicated transmit task if we have a transmit channel.
    // This ensures transmits are processed immediately without waiting for reads.
    let transmit_task = if let Some(rx) = transmit_rx {
        // Bulk OUT endpoint for transmit (0x02 = EP2 OUT)
        match interface.endpoint::<nusb::transfer::Bulk, nusb::transfer::Out>(0x02) {
            Ok(ep) => {
                eprintln!("[gs_usb:{}] Bulk OUT endpoint opened for transmit", session_id);
                let mut writer = ep.writer(64);
                let cancel_flag_for_transmit = cancel_flag.clone();

                // Spawn blocking task for transmit handling (writer uses blocking I/O)
                let handle = tokio::task::spawn_blocking(move || {
                    while !cancel_flag_for_transmit.load(Ordering::Relaxed) {
                        match rx.recv_timeout(std::time::Duration::from_millis(10)) {
                            Ok(req) => {
                                let result = match writer.write_all(&req.data) {
                                    Ok(_) => match writer.flush() {
                                        Ok(_) => Ok(()),
                                        Err(e) => Err(format!("Flush failed: {}", e)),
                                    },
                                    Err(e) => Err(format!("Write failed: {}", e)),
                                };
                                // Send result back (ignore errors - caller may have timed out)
                                let _ = req.result_tx.try_send(result);
                            }
                            Err(std_mpsc::RecvTimeoutError::Timeout) => {
                                // No request, continue loop
                            }
                            Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                                // Channel closed, exit
                                break;
                            }
                        }
                    }
                });
                Some(handle)
            }
            Err(e) => {
                eprintln!("[gs_usb:{}] Warning: could not open bulk OUT endpoint: {} (transmit disabled)", session_id, e);
                None
            }
        }
    } else {
        None
    };

    let mut pending_frames: Vec<FrameMessage> = Vec::with_capacity(32);
    let mut last_emit_time = std::time::Instant::now();
    let emit_interval = Duration::from_millis(25);

    // Pre-submit multiple read requests for better throughput
    for _ in 0..4 {
        bulk_in.submit(bulk_in.allocate(64));
    }

    // Read loop - only handles reading, transmit is handled by the dedicated task
    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            stream_reason = "stopped";
            break;
        }

        // Check frame limit
        if let Some(limit) = config.limit {
            if total_frames >= limit {
                eprintln!(
                    "[gs_usb:{}] Reached limit of {} frames",
                    session_id, limit
                );
                stream_reason = "complete";
                break;
            }
        }

        // Wait for next transfer completion with timeout
        let read_result = tokio::time::timeout(
            Duration::from_millis(50),
            bulk_in.next_complete(),
        )
        .await;

        match read_result {
            Ok(completion) => {
                match completion.status {
                    Ok(()) => {
                        let len = completion.actual_len;
                        let data = &completion.buffer[..len];
                        if let Some(gs_frame) = GsHostFrame::from_bytes(data) {
                            // Only process RX frames (not TX echoes)
                            if gs_frame.is_rx() {
                                let frame_msg = FrameMessage {
                                    protocol: "can".to_string(),
                                    timestamp_us: now_us(),
                                    frame_id: gs_frame.get_can_id(),
                                    // Use bus_override if configured, otherwise use device channel
                                    bus: config.bus_override.unwrap_or(gs_frame.channel),
                                    dlc: gs_frame.can_dlc,
                                    bytes: gs_frame.get_data().to_vec(),
                                    is_extended: gs_frame.is_extended(),
                                    is_fd: false,
                                    source_address: None,
                                    incomplete: None,
                                    direction: None,
                                };
                                pending_frames.push(frame_msg);
                                total_frames += 1;
                            }
                        }
                        // Resubmit for continuous reading
                        bulk_in.submit(bulk_in.allocate(64));
                    }
                    Err(e) => {
                        eprintln!("[gs_usb:{}] Bulk transfer error: {:?}", session_id, e);
                        stream_reason = "error";
                        break;
                    }
                }
            }
            Err(_) => {
                // Timeout - this is normal for live streams with no traffic
            }
        }

        // Emit batched frames periodically
        if last_emit_time.elapsed() >= emit_interval && !pending_frames.is_empty() {
            let frames = std::mem::take(&mut pending_frames);
            buffer_store::append_frames(frames.clone());
            emit_frames(&app_handle, &session_id, frames);
            last_emit_time = std::time::Instant::now();
        }
    }

    // Abort the transmit task when the read loop exits
    if let Some(task) = transmit_task {
        task.abort();
    }

    // Emit remaining frames
    if !pending_frames.is_empty() {
        buffer_store::append_frames(pending_frames.clone());
        emit_frames(&app_handle, &session_id, pending_frames);
    }

    // Stop the device
    let _ = stop_device(&interface, &config).await;

    emit_stream_ended(&app_handle, &session_id, stream_reason, "gs_usb");
}

/// Initialize the gs_usb device
pub async fn initialize_device(interface: &Interface, config: &GsUsbConfig) -> Result<(), String> {
    // 1. Send HOST_FORMAT
    let host_format = GS_USB_HOST_FORMAT.to_le_bytes();
    interface
        .control_out(ControlOut {
            control_type: ControlType::Vendor,
            recipient: Recipient::Interface,
            request: GsUsbBreq::HostFormat as u8,
            value: 1,
            index: 0,
            data: &host_format,
        }, CONTROL_TIMEOUT)
        .await
        .map_err(|e| format!("HOST_FORMAT failed: {:?}", e))?;

    // 2. Set bit timing
    let timing = get_bittiming_for_bitrate(config.bitrate).ok_or_else(|| {
        format!(
            "Unsupported bitrate {}. Supported: 10K, 20K, 50K, 100K, 125K, 250K, 500K, 750K, 1M.",
            config.bitrate
        )
    })?;

    let timing_bytes = unsafe {
        std::slice::from_raw_parts(
            &timing as *const GsDeviceBittiming as *const u8,
            GsDeviceBittiming::SIZE,
        )
    };

    interface
        .control_out(ControlOut {
            control_type: ControlType::Vendor,
            recipient: Recipient::Interface,
            request: GsUsbBreq::Bittiming as u8,
            value: config.channel as u16,
            index: 0,
            data: timing_bytes,
        }, CONTROL_TIMEOUT)
        .await
        .map_err(|e| format!("BITTIMING failed: {:?}", e))?;

    // 3. Set mode and start
    let mode_flags = if config.listen_only {
        can_mode::LISTEN_ONLY
    } else {
        can_mode::NORMAL
    };

    let mode = GsDeviceMode {
        mode: 1, // Start
        flags: mode_flags,
    };

    let mode_bytes = unsafe {
        std::slice::from_raw_parts(
            &mode as *const GsDeviceMode as *const u8,
            GsDeviceMode::SIZE,
        )
    };

    interface
        .control_out(ControlOut {
            control_type: ControlType::Vendor,
            recipient: Recipient::Interface,
            request: GsUsbBreq::Mode as u8,
            value: config.channel as u16,
            index: 0,
            data: mode_bytes,
        }, CONTROL_TIMEOUT)
        .await
        .map_err(|e| format!("MODE failed: {:?}", e))?;

    Ok(())
}

/// Stop the gs_usb device
pub async fn stop_device(interface: &Interface, config: &GsUsbConfig) -> Result<(), String> {
    let channel = config.channel;
    let mode = GsDeviceMode {
        mode: 0, // Stop
        flags: 0,
    };

    let mode_bytes = unsafe {
        std::slice::from_raw_parts(
            &mode as *const GsDeviceMode as *const u8,
            GsDeviceMode::SIZE,
        )
    };

    interface
        .control_out(ControlOut {
            control_type: ControlType::Vendor,
            recipient: Recipient::Interface,
            request: GsUsbBreq::Mode as u8,
            value: channel as u16,
            index: 0,
            data: mode_bytes,
        }, CONTROL_TIMEOUT)
        .await
        .map_err(|e| format!("MODE stop failed: {:?}", e))?;

    Ok(())
}

/// Parse a gs_usb host frame from raw bytes
pub fn parse_host_frame(data: &[u8]) -> Option<FrameMessage> {
    let gs_frame = GsHostFrame::from_bytes(data)?;

    // Only process RX frames (not TX echoes)
    if !gs_frame.is_rx() {
        return None;
    }

    Some(FrameMessage {
        protocol: "can".to_string(),
        timestamp_us: now_us(),
        frame_id: gs_frame.get_can_id(),
        bus: gs_frame.channel,
        dlc: gs_frame.can_dlc,
        bytes: gs_frame.get_data().to_vec(),
        is_extended: gs_frame.is_extended(),
        is_fd: false,
        source_address: None,
        incomplete: None,
        direction: None,
    })
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

/// Run gs_usb source and send frames to merge task
pub async fn run_source(
    source_idx: usize,
    bus: u8,
    address: u8,
    serial: Option<String>,
    bitrate: u32,
    listen_only: bool,
    channel: u8,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    // Find and open device - prefer serial number matching when available
    let device_info = match nusb::list_devices().await {
        Ok(mut devices) => devices
            .find(|dev| device_matches(dev, serial.as_deref(), bus, address))
            .ok_or_else(|| "Device not found".to_string()),
        Err(e) => Err(format!("Failed to list devices: {}", e)),
    };

    let device_info = match device_info {
        Ok(d) => d,
        Err(e) => {
            let _ = tx.send(SourceMessage::Error(source_idx, e)).await;
            return;
        }
    };

    let device = match device_info.open().await {
        Ok(d) => d,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Failed to open device: {}", e),
                ))
                .await;
            return;
        }
    };

    let interface = match device.claim_interface(0).await {
        Ok(i) => i,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Failed to claim interface: {}", e),
                ))
                .await;
            return;
        }
    };

    // Build config for initialization
    let config = GsUsbConfig {
        bus,
        address,
        serial: serial.clone(),
        bitrate,
        listen_only,
        channel,
        limit: None,
        display_name: None,
        bus_override: None,
    };

    // Initialize device
    if let Err(e) = initialize_device(&interface, &config).await {
        let _ = tx
            .send(SourceMessage::Error(
                source_idx,
                format!("Failed to initialize device: {}", e),
            ))
            .await;
        return;
    }

    eprintln!(
        "[gs_usb] Source {} connected to {}:{} (bitrate: {}, listen_only: {})",
        source_idx, bus, address, bitrate, listen_only
    );

    // Bulk IN endpoint
    let mut bulk_in = match interface.endpoint::<nusb::transfer::Bulk, nusb::transfer::In>(0x81) {
        Ok(ep) => ep,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Failed to open bulk IN endpoint: {}", e),
                ))
                .await;
            return;
        }
    };

    // Setup transmit channel if not in listen-only mode
    let transmit_task = if !listen_only {
        match interface.endpoint::<nusb::transfer::Bulk, nusb::transfer::Out>(0x02) {
            Ok(ep) => {
                let (transmit_tx, transmit_rx) =
                    std_mpsc::sync_channel::<TransmitRequest>(32);
                let _ = tx
                    .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
                    .await;

                let mut writer = ep.writer(64);
                let stop_flag_for_transmit = stop_flag.clone();

                let handle = tokio::task::spawn_blocking(move || {
                    while !stop_flag_for_transmit.load(Ordering::Relaxed) {
                        match transmit_rx.recv_timeout(std::time::Duration::from_millis(10)) {
                            Ok(req) => {
                                let result = match writer.write_all(&req.data) {
                                    Ok(_) => match writer.flush() {
                                        Ok(_) => Ok(()),
                                        Err(e) => Err(format!("Flush failed: {}", e)),
                                    },
                                    Err(e) => Err(format!("Write failed: {}", e)),
                                };
                                let _ = req.result_tx.try_send(result);
                            }
                            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
                            Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                });
                Some(handle)
            }
            Err(e) => {
                eprintln!(
                    "[gs_usb] Source {} warning: could not open bulk OUT: {}",
                    source_idx, e
                );
                None
            }
        }
    } else {
        None
    };

    // Pre-submit read requests
    for _ in 0..4 {
        bulk_in.submit(bulk_in.allocate(64));
    }

    // Read loop
    while !stop_flag.load(Ordering::Relaxed) {
        let read_result =
            tokio::time::timeout(Duration::from_millis(50), bulk_in.next_complete()).await;

        match read_result {
            Ok(completion) => match completion.status {
                Ok(()) => {
                    let len = completion.actual_len;
                    let data = &completion.buffer[..len];

                    if let Some(gs_frame) = GsHostFrame::from_bytes(data) {
                        if gs_frame.is_rx() {
                            let mut frame_msg = FrameMessage {
                                protocol: "can".to_string(),
                                timestamp_us: now_us(),
                                frame_id: gs_frame.get_can_id(),
                                bus: gs_frame.channel,
                                dlc: gs_frame.can_dlc,
                                bytes: gs_frame.get_data().to_vec(),
                                is_extended: gs_frame.is_extended(),
                                is_fd: false,
                                source_address: None,
                                incomplete: None,
                                direction: None,
                            };

                            // Apply bus mapping
                            if apply_bus_mapping(&mut frame_msg, &bus_mappings) {
                                let _ = tx
                                    .send(SourceMessage::Frames(source_idx, vec![frame_msg]))
                                    .await;
                            }
                        }
                    }

                    bulk_in.submit(bulk_in.allocate(64));
                }
                Err(e) => {
                    let _ = tx
                        .send(SourceMessage::Error(
                            source_idx,
                            format!("Bulk transfer error: {:?}", e),
                        ))
                        .await;
                    break;
                }
            },
            Err(_) => {
                // Timeout - continue
            }
        }
    }

    // Cleanup
    if let Some(task) = transmit_task {
        task.abort();
    }

    let _ = stop_device(&interface, &config).await;

    let _ = tx
        .send(SourceMessage::Ended(source_idx, "stopped".to_string()))
        .await;
}
