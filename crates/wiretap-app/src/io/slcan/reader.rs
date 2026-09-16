// ui/crates/wiretap-app/src/io/slcan/reader.rs
//
// slcan (Serial Line CAN) protocol device for CANable, CANable Pro, and other
// USB-CAN adapters using the Lawicel/slcan ASCII protocol.
//
// Protocol reference: http://www.can232.com/docs/can232_v3.pdf
//
// Frame formats:
//   Standard: t<ID:3hex><DLC:1hex><DATA:2hex*DLC>\r
//   Extended: T<ID:8hex><DLC:1hex><DATA:2hex*DLC>\r
//   RTR:      r<ID:3hex><DLC:1hex>\r / R<ID:8hex><DLC:1hex>\r

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::io::bus_mapping::{apply_bus_mapping, BusMapping};
use crate::io::error::IoError;
use crate::io::serial::utils as serial_utils;
use crate::io::types::{EndReason, SourceMessage, TransmitRequest};
use crate::io::{now_us, CanTransmitFrame, FrameMessage};
use wiretap_protocol::slcan;

// ============================================================================
// Types and Configuration
// ============================================================================

/// slcan reader configuration
#[allow(unused)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SlcanConfig {
    /// Serial port path (e.g., "/dev/cu.usbmodem1101", "COM3")
    pub port: String,
    /// Serial baud rate (typically 115200 for CANable)
    pub baud_rate: u32,
    /// CAN bus bitrate in bits/second (e.g., 500000 for 500 Kbit/s)
    pub bitrate: u32,
    /// Silent mode (M1) - does not ACK frames or participate in bus arbitration
    pub silent_mode: bool,
    /// Maximum number of frames to read (None = unlimited)
    pub limit: Option<i64>,
    /// Display name for the reader (used in capture names)
    pub display_name: Option<String>,
    /// Data bits (5, 6, 7, 8) - defaults to 8
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    /// Stop bits (1, 2) - defaults to 1
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    /// Parity ("none", "odd", "even") - defaults to "none"
    #[serde(default = "default_parity")]
    pub parity: String,
    /// Bus number override - assigns a specific bus number to all frames from this device.
    /// Used for multi-bus capture where multiple single-bus devices are combined.
    /// If None, defaults to bus 0.
    #[serde(default)]
    pub bus_override: Option<u8>,
    /// Enable CAN FD mode (ELMUE firmware extension).
    /// Sends a Y command for data phase bitrate, which implicitly enables FD.
    #[serde(default)]
    pub enable_fd: bool,
    /// CAN FD data phase bitrate in bits/second (default 2 Mbit/s)
    #[serde(default = "default_data_bitrate")]
    pub data_bitrate: u32,
}

#[allow(dead_code)]
fn default_data_bits() -> u8 {
    8
}
#[allow(dead_code)]
fn default_stop_bits() -> u8 {
    1
}
#[allow(dead_code)]
fn default_parity() -> String {
    "none".to_string()
}
#[allow(dead_code)]
fn default_data_bitrate() -> u32 {
    2_000_000
}

// ============================================================================
// Utility Functions
// ============================================================================

/// Name a bitrate as an `S` command, or say which ones this protocol can name.
///
/// The protocol has no way to ask for a rate outside its table, so an
/// unsupported one is a configuration error rather than a device failure.
pub fn find_bitrate_command(bitrate: u32) -> Result<&'static str, IoError> {
    slcan::bitrate_command(bitrate).ok_or_else(|| {
        IoError::configuration(format!(
            "Invalid CAN bitrate {}. Valid bitrates: {}",
            bitrate,
            rate_list(&slcan::NOMINAL_BITRATES)
        ))
    })
}

/// The same for a CAN FD data-phase bitrate (`Y`).
pub fn find_data_bitrate_command(bitrate: u32) -> Result<&'static str, IoError> {
    slcan::data_bitrate_command(bitrate).ok_or_else(|| {
        IoError::configuration(format!(
            "Invalid CAN FD data bitrate {}. Valid bitrates: {}",
            bitrate,
            rate_list(&slcan::DATA_BITRATES)
        ))
    })
}

fn rate_list(table: &[(u32, &str)]) -> String {
    table
        .iter()
        .map(|(rate, _)| rate.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

// ============================================================================
// Device Probing
// ============================================================================

/// Result of probing an slcan device
#[derive(Clone, Debug, Serialize)]
pub struct SlcanProbeResult {
    /// Whether the probe was successful (device responded)
    pub success: bool,
    /// Firmware version string (if available)
    pub version: Option<String>,
    /// Hardware version string (if available)
    pub hardware_version: Option<String>,
    /// Serial number (if available)
    pub serial_number: Option<String>,
    /// Whether the device supports CAN FD (None if couldn't determine)
    pub supports_fd: Option<bool>,
    /// Error message (if probe failed)
    pub error: Option<String>,
}

/// Probe an slcan device to check if it's responding and get version info.
///
/// This opens the port briefly, sends version query commands, and closes it.
/// The slcan protocol defines:
/// - V: Firmware version
/// - v: Hardware version
/// - N: Serial number
///
/// CANable devices typically respond to V with something like "V1013\r"
///
/// Optional serial framing parameters (defaults: 8N1):
/// - data_bits: 5, 6, 7, or 8 (default: 8)
/// - stop_bits: 1 or 2 (default: 1)
/// - parity: "none", "odd", "even" (default: "none")
#[tauri::command]
pub fn probe_slcan_device(
    port: String,
    baud_rate: u32,
    data_bits: Option<u8>,
    stop_bits: Option<u8>,
    parity: Option<String>,
) -> SlcanProbeResult {
    // Convert serial framing parameters with defaults
    let data_bits = serial_utils::to_serialport_data_bits(data_bits.unwrap_or(8));
    let stop_bits = serial_utils::to_serialport_stop_bits(stop_bits.unwrap_or(1));
    let parity =
        serial_utils::parity_str_to_serialport(&parity.unwrap_or_else(|| "none".to_string()));

    let device = format!("slcan({})", port);

    // Open the port with a short timeout
    let mut serial_port = match serialport::new(&port, baud_rate)
        .data_bits(data_bits)
        .stop_bits(stop_bits)
        .parity(parity)
        .timeout(Duration::from_millis(500))
        .open()
    {
        Ok(p) => p,
        Err(e) => {
            return SlcanProbeResult {
                success: false,
                version: None,
                hardware_version: None,
                serial_number: None,
                supports_fd: None,
                error: Some(IoError::connection(&device, e.to_string()).to_string()),
            };
        }
    };

    // Wait for USB device to be ready
    std::thread::sleep(Duration::from_millis(200));

    // Clear any pending data
    let _ = serial_port.clear(serialport::ClearBuffer::All);

    // Close any existing channel first (in case device is in open state)
    let _ = serial_port.write_all(slcan::CLOSE.as_bytes());
    let _ = serial_port.flush();
    std::thread::sleep(Duration::from_millis(50));

    // Clear again after close
    let _ = serial_port.clear(serialport::ClearBuffer::All);

    let mut version: Option<String> = None;
    let mut hardware_version: Option<String> = None;
    let mut serial_number: Option<String> = None;
    let mut is_elmue_firmware = false;
    let mut got_any_response = false;

    // Firmware version. Two shapes of answer, and the extended one is also the
    // only evidence a device speaks CAN FD — SLCAN has no capability query.
    if let Some(response) = send_and_read_all(&mut serial_port, slcan::QUERY_VERSION.as_bytes()) {
        got_any_response = true;
        if let Some(reply) = meaningful(&response) {
            let v = slcan::parse_version(reply);
            is_elmue_firmware = v.elmue;
            version = v.firmware;
            hardware_version = match (v.board, v.mcu) {
                (Some(board), Some(mcu)) => Some(format!("{} {}", board, mcu)),
                (board, mcu) => board.or(mcu),
            };
        }
    }

    // Hardware version, for devices that answer it — skipped when the extended
    // V reply already said.
    if hardware_version.is_none() {
        if let Some(response) = send_and_read(&mut serial_port, slcan::QUERY_HW_VERSION.as_bytes())
        {
            got_any_response = true;
            hardware_version = meaningful(&response).map(|r| strip_echo(r, 'v'));
        }
    }

    // Serial number, likewise optional.
    if let Some(response) = send_and_read(&mut serial_port, slcan::QUERY_SERIAL.as_bytes()) {
        got_any_response = true;
        serial_number = meaningful(&response).map(|r| strip_echo(r, 'N'));
    }

    // Detect CAN FD support from firmware identification.
    // The Elmue CANable 2.5 firmware (identified by extended V response with "Firmware:" field)
    // supports CAN FD on STM32G4xx MCUs. Standard slcan firmware does not support FD.
    let supports_fd = if got_any_response {
        Some(is_elmue_firmware)
    } else {
        None
    };

    // Close the port
    drop(serial_port);

    if got_any_response {
        SlcanProbeResult {
            success: true,
            version,
            hardware_version,
            serial_number,
            supports_fd,
            error: None,
        }
    } else {
        SlcanProbeResult {
            success: false,
            version: None,
            hardware_version: None,
            serial_number: None,
            supports_fd: None,
            error: Some("No response from device".to_string()),
        }
    }
}

/// A reply worth reading: neither empty nor the device's bell.
fn meaningful(response: &str) -> Option<&str> {
    let t = response.trim();
    (!t.is_empty() && t.as_bytes() != [slcan::BELL]).then_some(t)
}

/// Drop the command letter a device echoes back before its answer.
fn strip_echo(reply: &str, cmd: char) -> String {
    reply.strip_prefix(cmd).unwrap_or(reply).to_string()
}

/// Send a command and read the full response (larger buffer, longer wait).
/// Used for V command which may return extended multi-line responses from Elmue firmware.
fn send_and_read_all(port: &mut Box<dyn serialport::SerialPort>, cmd: &[u8]) -> Option<String> {
    if port.write_all(cmd).is_err() {
        return None;
    }
    let _ = port.flush();

    // Longer wait for extended responses
    std::thread::sleep(Duration::from_millis(200));

    let mut buf = [0u8; 512];
    let mut response = String::new();

    // Read until timeout — collect everything the device sends
    for _ in 0..10 {
        match port.read(&mut buf) {
            Ok(n) if n > 0 => {
                for &b in &buf[..n] {
                    if b == slcan::BELL {
                        return Some("\x07".to_string());
                    }
                    if b.is_ascii() && (b >= 0x20 || b == b'\r' || b == b'\n') {
                        response.push(b as char);
                    }
                }
            }
            _ => break,
        }
    }

    if response.is_empty() {
        None
    } else {
        Some(response)
    }
}

/// Send a command and read the response
fn send_and_read(port: &mut Box<dyn serialport::SerialPort>, cmd: &[u8]) -> Option<String> {
    // Send command
    if port.write_all(cmd).is_err() {
        return None;
    }
    let _ = port.flush();

    // Wait for response
    std::thread::sleep(Duration::from_millis(100));

    // Read response
    let mut buf = [0u8; 64];
    let mut response = String::new();

    // Try to read with a few attempts
    for _ in 0..3 {
        match port.read(&mut buf) {
            Ok(n) if n > 0 => {
                // Filter out non-printable characters except CR/LF
                for &b in &buf[..n] {
                    if b == slcan::BELL {
                        // Bell character indicates error
                        return Some("\x07".to_string());
                    }
                    if b.is_ascii() && (b >= 0x20 || b == b'\r' || b == b'\n') {
                        response.push(b as char);
                    }
                }
                if response.contains('\r') || response.contains('\n') {
                    break;
                }
            }
            Ok(_) => break,
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => break,
            Err(_) => break,
        }
    }

    if response.is_empty() {
        None
    } else {
        Some(response)
    }
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

/// Turn a decoded SLCAN frame into a `FrameMessage`.
///
/// SLCAN carries no timestamp and no bus number, so both come from here: the
/// host clock, and bus 0 for the session's mapping to renumber. BRS survives
/// the decode but has nowhere to go — `FrameMessage` has no field for it.
fn frame_message(f: slcan::Frame) -> FrameMessage {
    FrameMessage {
        protocol: "can".to_string(),
        timestamp_us: now_us(),
        frame_id: f.arb_id,
        bus: 0,
        dlc: f.data.len() as u8,
        bytes: f.data,
        is_extended: f.extended,
        is_fd: f.fd,
        source_address: None,
        incomplete: None,
        direction: None,
    }
}

/// Encode a frame as the SLCAN line that transmits it.
pub fn encode_transmit_frame(frame: &CanTransmitFrame) -> Vec<u8> {
    slcan::encode_frame(&slcan::Frame::data(
        frame.frame_id,
        frame.is_extended,
        frame.is_fd,
        frame.is_brs,
        frame.data.clone(),
    ))
}

/// Run slcan source and send frames to merge task
pub async fn run_source(
    source_idx: usize,
    port_path: String,
    baud_rate: u32,
    bitrate: u32,
    silent_mode: bool,
    enable_fd: bool,
    data_bitrate: u32,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let device = format!("slcan({})", port_path);

    // Open serial port
    let serial_port = match serialport::new(&port_path, baud_rate)
        .timeout(Duration::from_millis(2))
        .open()
    {
        Ok(p) => p,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    IoError::connection(&device, e.to_string()).to_string(),
                ))
                .await;
            return;
        }
    };

    // Clone the serial port handle so read and write can run concurrently
    // without mutex contention. try_clone() duplicates the OS file descriptor.
    let write_port = match serial_port.try_clone() {
        Ok(p) => Some(p),
        Err(e) => {
            tlog!("[slcan] Failed to clone serial port for write thread: {} — falling back to shared mutex", e);
            None
        }
    };

    // Initialize slcan (serial_port is exclusively ours before spawning threads)
    let mut serial_port = serial_port;
    let init_result: Result<(), String> = (|| {
        let port = &mut serial_port;
        let _ = port.clear(serialport::ClearBuffer::All);

        // Wait for device to be ready
        std::thread::sleep(Duration::from_millis(200));

        // Each command is answered, and some firmware is unhappy being written
        // to mid-reply, so every step pauses before the next.
        let mut send = |what: &str, cmd: &str| -> Result<(), String> {
            port.write_all(cmd.as_bytes())
                .map_err(|e| IoError::protocol(&device, format!("{}: {}", what, e)).to_string())?;
            let _ = port.flush();
            std::thread::sleep(Duration::from_millis(50));
            Ok(())
        };

        send("close channel", slcan::CLOSE)?;
        send(
            "set bitrate",
            find_bitrate_command(bitrate).map_err(String::from)?,
        )?;
        // A data-phase bitrate is what puts the device into FD mode; there is
        // no separate command for it.
        if enable_fd {
            send(
                "set data bitrate",
                find_data_bitrate_command(data_bitrate).map_err(String::from)?,
            )?;
        }
        send(
            "set mode",
            if silent_mode {
                slcan::MODE_SILENT
            } else {
                slcan::MODE_NORMAL
            },
        )?;
        send("open channel", slcan::OPEN)?;

        Ok(())
    })();

    if let Err(e) = init_result {
        let _ = tx.send(SourceMessage::Error(source_idx, e)).await;
        return;
    }

    // Create transmit channel (only if not in silent mode)
    let (transmit_tx, transmit_rx) = std::sync::mpsc::sync_channel::<TransmitRequest>(32);
    if !silent_mode {
        let _ = tx
            .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
            .await;
    }

    tlog!(
        "[slcan] Source {} connected to {} (bitrate: {}, silent: {}, fd: {}{})",
        source_idx,
        port_path,
        bitrate,
        silent_mode,
        enable_fd,
        if enable_fd {
            format!(", data_bitrate: {}", data_bitrate)
        } else {
            String::new()
        }
    );

    // Emit device-connected event
    let _ = tx
        .send(SourceMessage::Connected(
            source_idx,
            "slcan".to_string(),
            port_path.clone(),
            None,
        ))
        .await;

    // Spawn dedicated write thread if we have a cloned port handle.
    // This runs independently of the read loop — no mutex contention.
    let stop_flag_write = stop_flag.clone();
    if let Some(mut w_port) = write_port {
        if !silent_mode {
            std::thread::Builder::new()
                .name(format!("slcan-tx-{}", source_idx))
                .spawn(move || {
                    while !stop_flag_write.load(Ordering::SeqCst) {
                        match transmit_rx.recv_timeout(Duration::from_millis(50)) {
                            Ok(req) => {
                                let result = w_port
                                    .write_all(&req.data)
                                    .and_then(|_| w_port.flush())
                                    .map_err(|e| format!("Write error: {}", e));
                                let _ = req.result_tx.send(result);
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                })
                .ok();
        }
    } else {
        // Fallback: no clone available — transmit handled inline in read loop (old path)
        // This shouldn't happen on supported platforms but keeps things working.
        tlog!("[slcan] Write thread not available, transmit will be handled in read loop");
    }

    // Read loop (blocking) — owns the original serial port handle directly
    let tx_clone = tx.clone();
    let stop_flag_clone = stop_flag.clone();
    let port_name = port_path.clone();

    let blocking_handle = tokio::task::spawn_blocking(move || {
        let mut decoder = slcan::LineDecoder::new();
        let mut read_buf = [0u8; 256];

        while !stop_flag_clone.load(Ordering::SeqCst) {
            // Read data — no mutex, we own this handle
            let read_result = serial_port.read(&mut read_buf);

            match read_result {
                Ok(n) if n > 0 => {
                    // A device's replies come down the same wire as its frames;
                    // only the frames are traffic.
                    let pending_frames: Vec<FrameMessage> = decoder
                        .feed(&read_buf[..n])
                        .into_iter()
                        .filter_map(|line| match line {
                            slcan::Line::Frame(f) => Some(frame_message(f)),
                            slcan::Line::Reply(_) => None,
                        })
                        .filter_map(|mut f| apply_bus_mapping(&mut f, &bus_mappings).then_some(f))
                        .collect();

                    if !pending_frames.is_empty() {
                        let _ = tx_clone
                            .blocking_send(SourceMessage::Frames(source_idx, pending_frames));
                    }
                }
                Ok(0) => {
                    std::thread::sleep(Duration::from_millis(1));
                }
                Ok(_) => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // Timeout — continue
                }
                Err(e) => {
                    serial_utils::send_serial_read_error(&tx_clone, source_idx, &port_name, &e);
                    return;
                }
            }
        }

        // Close channel
        let _ = serial_port.write_all(slcan::CLOSE.as_bytes());
        let _ = serial_port.flush();

        let _ = tx_clone.blocking_send(SourceMessage::Ended(source_idx, EndReason::Stopped));
    });

    let _ = blocking_handle.await;
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(frame_id: u32, is_extended: bool, is_fd: bool, is_brs: bool, data: Vec<u8>) -> Vec<u8> {
        encode_transmit_frame(&CanTransmitFrame {
            frame_id,
            data,
            bus: 0,
            is_extended,
            is_fd,
            is_brs,
            is_rtr: false,
        })
    }

    fn line(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).expect("ascii")
    }

    #[test]
    fn a_classic_transmit_is_a_t_line() {
        assert_eq!(
            line(tx(0x123, false, false, false, vec![0xAA, 0xBB])),
            "t1232AABB\r"
        );
        assert_eq!(
            line(tx(0x12345678, true, false, false, vec![0x11])),
            "T12345678111\r"
        );
    }

    /// The regression this move exists to fix: a CAN FD transmit used to go out
    /// as `t<id>8<hex>`, which is a classic frame claiming eight bytes and
    /// carrying twelve — malformed, and silently so.
    #[test]
    fn an_fd_transmit_uses_an_fd_prefix_and_a_length_code() {
        assert_eq!(
            line(tx(0x7E0, false, true, false, vec![0x11; 12])),
            format!("d7E09{}\r", "11".repeat(12)),
            "code 9 is twelve bytes"
        );
    }

    #[test]
    fn a_bit_rate_switch_changes_the_prefix() {
        assert!(line(tx(0x7E0, false, true, true, vec![0x22; 8])).starts_with('b'));
        assert!(line(tx(0x7E0, true, true, true, vec![0x22; 8])).starts_with('B'));
        assert!(line(tx(0x7E0, false, true, false, vec![0x22; 8])).starts_with('d'));
    }

    #[test]
    fn a_full_fd_payload_is_the_longest_line() {
        assert_eq!(tx(0x1FFFFFFF, true, true, true, vec![0; 64]).len(), 139);
    }

    #[test]
    fn a_received_frame_becomes_a_frame_message() {
        let f = slcan::parse_frame("t1234AABBCCDD").expect("a frame");
        let m = frame_message(f);
        assert_eq!((m.frame_id, m.bus, m.dlc), (0x123, 0, 4));
        assert_eq!(m.bytes, vec![0xAA, 0xBB, 0xCC, 0xDD]);
        assert!(!m.is_extended && !m.is_fd);
    }

    /// `dlc` on a `FrameMessage` is a byte count, not the code the line carried.
    #[test]
    fn an_fd_frame_message_carries_the_length_not_the_code() {
        let f = slcan::parse_frame(&format!("d7E09{}", "11".repeat(12))).expect("a frame");
        let m = frame_message(f);
        assert!(m.is_fd);
        assert_eq!(m.dlc, 12);
        assert_eq!(m.bytes.len(), 12);
    }

    #[test]
    fn a_bitrate_that_slcan_cannot_name_says_which_ones_it_can() {
        assert_eq!(find_bitrate_command(500_000).unwrap(), "S6\r");
        assert_eq!(find_bitrate_command(1_000_000).unwrap(), "S8\r");
        assert_eq!(find_data_bitrate_command(2_000_000).unwrap(), "Y2\r");

        let err = find_bitrate_command(300_000)
            .expect_err("not a valid rate")
            .to_string();
        assert!(err.contains("300000"), "should name what was asked: {err}");
        assert!(err.contains("500000"), "and what it could have been: {err}");
    }

    #[test]
    fn a_bell_is_not_a_reply() {
        assert_eq!(meaningful("V1013\r"), Some("V1013"));
        assert_eq!(meaningful("\x07"), None);
        assert_eq!(meaningful("  \r\n"), None);
    }

    #[test]
    fn an_echoed_command_letter_is_dropped() {
        assert_eq!(strip_echo("N0012", 'N'), "0012");
        assert_eq!(strip_echo("0012", 'N'), "0012");
    }
}
