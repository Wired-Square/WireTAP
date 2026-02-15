// ui/src-tauri/src/io/serial/reader.rs
//
// Serial port reader for multi-source sessions.
// Can emit raw bytes and/or framed messages (SLIP, Modbus RTU, delimiter-based).
// Provides cross-platform serial communication for CANdor.

use serde::Serialize;
use std::io::{Read, Write};
use std::sync::mpsc as std_mpsc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::io::gvret::{apply_bus_mapping, BusMapping};
use crate::io::types::{ByteEntry, SourceMessage, TransmitRequest};
use crate::io::{now_us, FrameMessage};

// Re-export Parity for external use
pub use super::utils::Parity;
use super::framer::{extract_frame_id, FrameIdConfig, FramingEncoding, SerialFramer};

// ============================================================================
// Types
// ============================================================================

/// Information about an available serial port
#[derive(Clone, Serialize)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

/// Run serial source and send frames/bytes to merge task.
/// Can emit raw bytes and/or framed data depending on configuration.
pub async fn run_source(
    source_idx: usize,
    port_path: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: Parity,
    framing_encoding: FramingEncoding,
    frame_id_config: Option<FrameIdConfig>,
    source_address_config: Option<FrameIdConfig>,
    min_frame_length: usize,
    emit_raw_bytes: bool,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    // Convert config to serialport types
    let sp_data_bits = super::utils::to_serialport_data_bits(data_bits);
    let sp_stop_bits = super::utils::to_serialport_stop_bits(stop_bits);
    let sp_parity = super::utils::to_serialport_parity(&parity);

    // Open serial port
    let serial_port = match serialport::new(&port_path, baud_rate)
        .data_bits(sp_data_bits)
        .stop_bits(sp_stop_bits)
        .parity(sp_parity)
        .timeout(Duration::from_millis(50))
        .open()
    {
        Ok(p) => p,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Failed to open {}: {}", port_path, e),
                ))
                .await;
            return;
        }
    };

    // Wrap in Arc<Mutex> for shared access between read and transmit
    let serial_port = Arc::new(Mutex::new(serial_port));

    // Create transmit channel
    let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
    let _ = tx
        .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
        .await;

    // Get the output bus from the first enabled mapping (for raw bytes)
    let output_bus = bus_mappings
        .iter()
        .find(|m| m.enabled)
        .map(|m| m.output_bus)
        .unwrap_or(0);

    eprintln!(
        "[serial] Source {} connected to {} (baud: {}, framing: {:?}, emit_raw: {}, bus: {})",
        source_idx, port_path, baud_rate, framing_encoding, emit_raw_bytes, output_bus
    );

    // Emit device-connected event
    let _ = tx
        .send(SourceMessage::Connected(source_idx, "serial".to_string(), port_path.clone(), Some(output_bus)))
        .await;

    // Read loop (blocking)
    let tx_clone = tx.clone();
    let stop_flag_clone = stop_flag.clone();
    let serial_port_clone = serial_port.clone();

    // Check if we have actual framing (not Raw mode)
    let has_framing = !matches!(framing_encoding, FramingEncoding::Raw);

    let blocking_handle = tokio::task::spawn_blocking(move || {
        let mut framer = SerialFramer::new(framing_encoding);
        let mut buf = [0u8; 256];

        while !stop_flag_clone.load(Ordering::SeqCst) {
            // Check for transmit requests (non-blocking)
            while let Ok(req) = transmit_rx.try_recv() {
                let result = match serial_port_clone.lock() {
                    Ok(mut port) => port
                        .write_all(&req.data)
                        .and_then(|_| port.flush())
                        .map_err(|e| format!("Write error: {}", e)),
                    Err(e) => {
                        eprintln!("[serial] Mutex poisoned in transmit: {}", e);
                        Err(format!("Port mutex poisoned: {}", e))
                    }
                };
                let _ = req.result_tx.send(result);
            }

            // Read data
            let read_result = match serial_port_clone.lock() {
                Ok(mut port) => port.read(&mut buf),
                Err(e) => {
                    eprintln!("[serial] Mutex poisoned in read loop: {}", e);
                    let _ = tx_clone.blocking_send(SourceMessage::Error(
                        source_idx,
                        format!("Port mutex poisoned: {}", e),
                    ));
                    return;
                }
            };

            match read_result {
                Ok(n) if n > 0 => {
                    let base_ts = now_us();
                    let read_bytes = &buf[..n];

                    // Emit raw bytes if requested
                    if emit_raw_bytes {
                        let raw_entries: Vec<ByteEntry> = read_bytes
                            .iter()
                            .map(|&byte| ByteEntry {
                                byte,
                                timestamp_us: base_ts,
                                bus: output_bus,
                            })
                            .collect();
                        let _ = tx_clone.blocking_send(SourceMessage::Bytes(source_idx, raw_entries));
                    }

                    // Only process through framer if we have actual framing
                    if has_framing {
                        let mut pending_frames: Vec<FrameMessage> = Vec::new();

                        // Feed bytes to framer and process resulting frames
                        let frames = framer.feed(read_bytes);
                        for frame in frames {
                            // Skip frames that are too short
                            if frame.bytes.len() < min_frame_length {
                                continue;
                            }

                            // Extract frame ID
                            let frame_id = frame_id_config
                                .as_ref()
                                .and_then(|cfg| extract_frame_id(&frame.bytes, cfg))
                                .unwrap_or(0);

                            // Extract source address
                            let source_address = source_address_config
                                .as_ref()
                                .and_then(|cfg| extract_frame_id(&frame.bytes, cfg))
                                .map(|v| v as u16);

                            let mut msg = FrameMessage {
                                protocol: "serial".to_string(),
                                timestamp_us: base_ts,
                                frame_id,
                                bus: 0,
                                dlc: frame.bytes.len() as u8,
                                bytes: frame.bytes,
                                is_extended: false,
                                is_fd: false,
                                source_address,
                                incomplete: None,
                                direction: None,
                            };

                            // Apply bus mapping
                            if apply_bus_mapping(&mut msg, &bus_mappings) {
                                pending_frames.push(msg);
                            }
                        }

                        if !pending_frames.is_empty() {
                            let _ = tx_clone
                                .blocking_send(SourceMessage::Frames(source_idx, pending_frames));
                        }
                    }
                }
                Ok(0) => {
                    // EOF - port disconnected
                    let _ = tx_clone.blocking_send(SourceMessage::Ended(
                        source_idx,
                        "disconnected".to_string(),
                    ));
                    return;
                }
                Ok(_) => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // Timeout - continue
                }
                Err(e) => {
                    let _ = tx_clone.blocking_send(SourceMessage::Error(
                        source_idx,
                        format!("Read error: {}", e),
                    ));
                    return;
                }
            }
        }

        // Flush framer for any remaining partial frame (only if we have actual framing)
        if has_framing {
            if let Some(frame) = framer.flush() {
                if frame.bytes.len() >= min_frame_length {
                    let frame_id = frame_id_config
                        .as_ref()
                        .and_then(|cfg| extract_frame_id(&frame.bytes, cfg))
                        .unwrap_or(0);

                    let source_address = source_address_config
                        .as_ref()
                        .and_then(|cfg| extract_frame_id(&frame.bytes, cfg))
                        .map(|v| v as u16);

                    let mut msg = FrameMessage {
                        protocol: "serial".to_string(),
                        timestamp_us: now_us(),
                        frame_id,
                        bus: 0,
                        dlc: frame.bytes.len() as u8,
                        bytes: frame.bytes,
                        is_extended: false,
                        is_fd: false,
                        source_address,
                        incomplete: None,
                        direction: None,
                    };

                    if apply_bus_mapping(&mut msg, &bus_mappings) {
                        let _ = tx_clone.blocking_send(SourceMessage::Frames(source_idx, vec![msg]));
                    }
                }
            }
        }

        let _ = tx_clone.blocking_send(SourceMessage::Ended(source_idx, "stopped".to_string()));
    });

    let _ = blocking_handle.await;
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// List available serial ports
///
/// On macOS, filters out /dev/tty.* devices and only shows /dev/cu.* devices.
/// The cu (calling unit) devices are non-blocking and preferred for outgoing connections.
/// The tty (terminal) devices block on open waiting for carrier detect.
#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| format!("Failed to enumerate ports: {}", e))?;

    Ok(ports
        .into_iter()
        // On macOS, filter out /dev/tty.* devices - only show /dev/cu.* (calling unit)
        .filter(|_p| {
            #[cfg(target_os = "macos")]
            {
                !_p.port_name.starts_with("/dev/tty.")
            }
            #[cfg(not(target_os = "macos"))]
            {
                true
            }
        })
        .map(|p| {
            let (port_type, manufacturer, product, serial_number, vid, pid) = match p.port_type {
                serialport::SerialPortType::UsbPort(info) => (
                    "USB".to_string(),
                    info.manufacturer,
                    info.product,
                    info.serial_number,
                    Some(info.vid),
                    Some(info.pid),
                ),
                serialport::SerialPortType::BluetoothPort => {
                    ("Bluetooth".to_string(), None, None, None, None, None)
                }
                serialport::SerialPortType::PciPort => {
                    ("PCI".to_string(), None, None, None, None, None)
                }
                serialport::SerialPortType::Unknown => {
                    ("Unknown".to_string(), None, None, None, None, None)
                }
            };
            SerialPortInfo {
                port_name: p.port_name,
                port_type,
                manufacturer,
                product,
                serial_number,
                vid,
                pid,
            }
        })
        .collect())
}
