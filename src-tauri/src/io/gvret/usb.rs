// ui/src-tauri/src/io/gvret/usb.rs
//
// GVRET USB serial protocol implementation for devices like ESP32-RET, M2RET, CANDue
// and other GVRET-compatible hardware over USB serial.
//
// Protocol reference: https://github.com/collin80/GVRET

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::io::error::IoError;
use crate::io::types::{SourceMessage, TransmitRequest};
use super::common::{
    apply_bus_mappings_gvret, parse_gvret_frames, parse_numbuses_response, BusMapping,
    BINARY_MODE_ENABLE, DEVICE_INFO_PROBE, GVRET_CMD_NUMBUSES, GvretDeviceInfo,
};

// ============================================================================
// Configuration
// ============================================================================

/// GVRET USB reader configuration
#[allow(unused)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GvretUsbConfig {
    /// Serial port path (e.g., "/dev/cu.usbmodem1101", "COM3")
    pub port: String,
    /// Serial baud rate (typically 115200 or 1000000)
    pub baud_rate: u32,
    /// Maximum number of frames to read (None = unlimited)
    pub limit: Option<i64>,
    /// Display name for the reader (used in buffer names)
    pub display_name: Option<String>,
    /// Bus number override - if set, all frames will use this bus number
    /// instead of the device-reported bus number
    #[serde(default)]
    pub bus_override: Option<u8>,
}

// ============================================================================
// Device Probing
// ============================================================================

/// Probe a GVRET USB device to discover its capabilities
///
/// This function opens the serial port, queries the number of available buses,
/// and returns device information. The connection is closed after probing.
///
/// Returns `IoError` for typed error handling. Use `.map_err(String::from)` if
/// you need a String error for backwards compatibility.
pub fn probe_gvret_usb(port: &str, baud_rate: u32) -> Result<GvretDeviceInfo, IoError> {
    tlog!(
        "[probe_gvret_usb] Probing GVRET device at {} (baud: {})",
        port, baud_rate
    );

    let device = format!("gvret_usb({})", port);

    // Open serial port
    let mut serial_port = serialport::new(port, baud_rate)
        .timeout(Duration::from_millis(500))
        .open()
        .map_err(|e| IoError::connection(&device, e.to_string()))?;

    tlog!("[probe_gvret_usb] Opened serial port {}", port);

    // Clear any pending data
    let _ = serial_port.clear(serialport::ClearBuffer::All);

    // Enter binary mode
    serial_port
        .write_all(&BINARY_MODE_ENABLE)
        .map_err(|e| IoError::protocol(&device, format!("enable binary mode: {}", e)))?;
    let _ = serial_port.flush();

    // Wait for device to process
    std::thread::sleep(Duration::from_millis(100));

    // Query number of buses
    serial_port
        .write_all(&GVRET_CMD_NUMBUSES)
        .map_err(|e| IoError::protocol(&device, format!("send NUMBUSES command: {}", e)))?;
    let _ = serial_port.flush();

    // Read response with timeout
    // Response format: [0xF1][0x0C][bus_count]
    let mut buf = vec![0u8; 256];
    let mut total_read = 0;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);

    loop {
        if std::time::Instant::now() >= deadline {
            break;
        }

        match serial_port.read(&mut buf[total_read..]) {
            Ok(0) => break, // No data
            Ok(n) => {
                total_read += n;

                // Check for NUMBUSES response
                if let Some(bus_count) = parse_numbuses_response(&buf[..total_read]) {
                    tlog!(
                        "[probe_gvret_usb] SUCCESS: Device at {} has {} buses available",
                        port, bus_count
                    );
                    return Ok(GvretDeviceInfo { bus_count });
                }

                // If we've read enough data without finding the response, give up
                if total_read > 128 {
                    break;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                // Timeout on this read, continue if we still have time
            }
            Err(e) => {
                return Err(IoError::read(&device, e.to_string()));
            }
        }
    }

    // If we didn't get a response, assume 1 bus (safer default)
    tlog!("[probe_gvret_usb] No NUMBUSES response received, defaulting to 1 bus");
    Ok(GvretDeviceInfo { bus_count: 1 })
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

/// Run GVRET USB source and send frames to merge task
pub async fn run_source(
    source_idx: usize,
    port: String,
    baud_rate: u32,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    // Open serial port
    let serial_port = match serialport::new(&port, baud_rate)
        .timeout(Duration::from_millis(10))
        .open()
    {
        Ok(p) => p,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Failed to open port: {}", e),
                ))
                .await;
            return;
        }
    };

    // Wrap in Arc<Mutex> for shared access between read and transmit
    let serial_port = Arc::new(Mutex::new(serial_port));

    // Clear buffers and initialize (do all sync work without awaiting)
    let init_result: Result<(), String> = (|| {
        let mut port = serial_port.lock().unwrap();
        let _ = port.clear(serialport::ClearBuffer::All);

        // Enable binary mode
        port.write_all(&BINARY_MODE_ENABLE)
            .map_err(|e| format!("Failed to enable binary mode: {}", e))?;
        let _ = port.flush();
        Ok(())
    })();

    if let Err(e) = init_result {
        let _ = tx.send(SourceMessage::Error(source_idx, e)).await;
        return;
    }

    std::thread::sleep(Duration::from_millis(100));

    // Send device info probe
    {
        let mut port = serial_port.lock().unwrap();
        let _ = port.write_all(&DEVICE_INFO_PROBE);
        let _ = port.flush();
    }

    // Create transmit channel and send it to the merge task
    let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
    let _ = tx
        .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
        .await;

    tlog!(
        "[gvret_usb] Source {} connected to {}, transmit channel ready",
        source_idx, port
    );

    // Emit device-connected event
    let _ = tx
        .send(SourceMessage::Connected(source_idx, "gvret_usb".to_string(), port.clone(), None))
        .await;

    // Read loop (blocking, so we run it in a blocking task)
    let tx_clone = tx.clone();
    let stop_flag_clone = stop_flag.clone();
    let serial_port_clone = serial_port.clone();

    // Spawn blocking task for serial reading
    let blocking_handle = tokio::task::spawn_blocking(move || {
        let mut buffer = Vec::with_capacity(4096);
        let mut read_buf = [0u8; 2048];

        while !stop_flag_clone.load(Ordering::SeqCst) {
            // Check for transmit requests (non-blocking)
            while let Ok(req) = transmit_rx.try_recv() {
                let result = {
                    let mut port = serial_port_clone.lock().unwrap();
                    port.write_all(&req.data)
                        .and_then(|_| port.flush())
                        .map_err(|e| format!("Write error: {}", e))
                };
                let _ = req.result_tx.send(result);
            }

            // Read data
            let read_result = {
                let mut port = serial_port_clone.lock().unwrap();
                port.read(&mut read_buf)
            };

            match read_result {
                Ok(0) => {
                    // No data
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(n) => {
                    buffer.extend_from_slice(&read_buf[..n]);

                    // Parse GVRET frames and apply bus mappings
                    let frames = parse_gvret_frames(&mut buffer);
                    let mapped_frames = apply_bus_mappings_gvret(frames, &bus_mappings);

                    if !mapped_frames.is_empty() {
                        let _ = tx_clone
                            .blocking_send(SourceMessage::Frames(source_idx, mapped_frames));
                    }
                }
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

        let _ = tx_clone.blocking_send(SourceMessage::Ended(source_idx, "stopped".to_string()));
    });

    // Wait for the blocking task
    let _ = blocking_handle.await;
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use crate::io::gvret::{encode_gvret_frame, parse_gvret_frames};
    use crate::io::CanTransmitFrame;

    #[test]
    fn test_encode_standard_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0x11, 0x22, 0x33, 0x44],
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = encode_gvret_frame(&frame);

        assert_eq!(encoded[0], 0xF1); // Sync
        assert_eq!(encoded[1], 0x00); // Command
        // Frame ID (little-endian): 0x123 = [0x23, 0x01, 0x00, 0x00]
        assert_eq!(encoded[2], 0x23);
        assert_eq!(encoded[3], 0x01);
        assert_eq!(encoded[4], 0x00);
        assert_eq!(encoded[5], 0x00);
        assert_eq!(encoded[6], 0x00); // Bus
        assert_eq!(encoded[7], 0x04); // Length
        assert_eq!(&encoded[8..], &[0x11, 0x22, 0x33, 0x44]);
    }

    #[test]
    fn test_encode_extended_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x12345678,
            data: vec![0xAA, 0xBB],
            bus: 1,
            is_extended: true,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = encode_gvret_frame(&frame);

        assert_eq!(encoded[0], 0xF1); // Sync
        assert_eq!(encoded[1], 0x00); // Command
        // Frame ID with extended flag (bit 31): 0x12345678 | 0x80000000 = 0x92345678
        // Little-endian: [0x78, 0x56, 0x34, 0x92]
        assert_eq!(encoded[2], 0x78);
        assert_eq!(encoded[3], 0x56);
        assert_eq!(encoded[4], 0x34);
        assert_eq!(encoded[5], 0x92);
        assert_eq!(encoded[6], 0x01); // Bus
        assert_eq!(encoded[7], 0x02); // Length
        assert_eq!(&encoded[8..], &[0xAA, 0xBB]);
    }

    #[test]
    fn test_encode_empty_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x7FF,
            data: vec![],
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let encoded = encode_gvret_frame(&frame);

        assert_eq!(encoded.len(), 8); // Header only, no data
        assert_eq!(encoded[0], 0xF1);
        assert_eq!(encoded[1], 0x00);
        assert_eq!(encoded[6], 0x00); // Bus
        assert_eq!(encoded[7], 0x00); // Length = 0
    }

    #[test]
    fn test_parse_single_frame() {
        // F1 00 <ts:4> <id:4> <bus_dlc:1> <data:4>
        // Timestamp: 0x00000000 (not used for host time)
        // ID: 0x123 (standard)
        // Bus+DLC: 0x04 (bus 0, dlc 4)
        // Data: AA BB CC DD
        let mut buffer = vec![
            0xF1, 0x00, // Sync + command
            0x00, 0x00, 0x00, 0x00, // Timestamp
            0x23, 0x01, 0x00, 0x00, // ID 0x123 LE
            0x04, // Bus 0, DLC 4
            0xAA, 0xBB, 0xCC, 0xDD, // Data
        ];

        let frames = parse_gvret_frames(&mut buffer);

        assert_eq!(frames.len(), 1);
        let (frame, _) = &frames[0];
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 4);
        assert_eq!(frame.bytes, vec![0xAA, 0xBB, 0xCC, 0xDD]);
        assert!(!frame.is_extended);
        assert!(buffer.is_empty()); // Buffer should be consumed
    }

    #[test]
    fn test_parse_extended_frame() {
        // Extended frame with ID 0x12345678
        let mut buffer = vec![
            0xF1, 0x00, // Sync + command
            0x00, 0x00, 0x00, 0x00, // Timestamp
            0x78, 0x56, 0x34, 0x92, // ID 0x12345678 | 0x80000000 LE
            0x02, // Bus 0, DLC 2
            0x11, 0x22, // Data
        ];

        let frames = parse_gvret_frames(&mut buffer);

        assert_eq!(frames.len(), 1);
        let (frame, _) = &frames[0];
        assert_eq!(frame.frame_id, 0x12345678);
        assert!(frame.is_extended);
        assert_eq!(frame.bytes, vec![0x11, 0x22]);
    }

    #[test]
    fn test_parse_skips_control_frames() {
        // Mix of control frames and data frame
        let mut buffer = vec![
            0xF1, 0x09, 0xDE, 0xAD, // Keepalive (4 bytes)
            0xF1, 0x00, // Data frame start
            0x00, 0x00, 0x00, 0x00, // Timestamp
            0x7F, 0x00, 0x00, 0x00, // ID 0x7F
            0x01, // Bus 0, DLC 1
            0xFF, // Data
        ];

        let frames = parse_gvret_frames(&mut buffer);

        assert_eq!(frames.len(), 1);
        let (frame, _) = &frames[0];
        assert_eq!(frame.frame_id, 0x7F);
    }

    #[test]
    fn test_parse_incomplete_frame() {
        // Incomplete frame - not enough bytes
        let mut buffer = vec![
            0xF1, 0x00, // Sync + command
            0x00, 0x00, // Only 2 timestamp bytes
        ];

        let frames = parse_gvret_frames(&mut buffer);

        assert!(frames.is_empty());
        assert_eq!(buffer.len(), 4); // Buffer should be preserved
    }
}
