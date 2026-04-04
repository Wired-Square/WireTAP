// ui/src-tauri/src/io/slcan/reader.rs
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

use crate::io::error::IoError;
use crate::io::gvret::{apply_bus_mapping, BusMapping};
use crate::io::serial::utils as serial_utils;
use crate::io::types::{SourceMessage, TransmitRequest};
use crate::io::{now_us, CanTransmitFrame, FrameMessage};

// ============================================================================
// Constants
// ============================================================================

/// slcan bitrate commands (S0-S8)
const SLCAN_BITRATES: [(u32, &str); 9] = [
    (10_000, "S0"),     // 10 Kbit/s
    (20_000, "S1"),     // 20 Kbit/s
    (50_000, "S2"),     // 50 Kbit/s
    (100_000, "S3"),    // 100 Kbit/s
    (125_000, "S4"),    // 125 Kbit/s
    (250_000, "S5"),    // 250 Kbit/s
    (500_000, "S6"),    // 500 Kbit/s
    (750_000, "S7"),    // 750 Kbit/s
    (1_000_000, "S8"),  // 1 Mbit/s
];

/// slcan CAN FD data phase bitrate commands (Y0-Y8, ELMUE firmware extension)
const SLCAN_DATA_BITRATES: [(u32, &str); 6] = [
    (500_000,   "Y0"),  // 500 Kbit/s
    (1_000_000, "Y1"),  // 1 Mbit/s
    (2_000_000, "Y2"),  // 2 Mbit/s
    (4_000_000, "Y4"),  // 4 Mbit/s
    (5_000_000, "Y5"),  // 5 Mbit/s
    (8_000_000, "Y8"),  // 8 Mbit/s
];

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
    /// Display name for the reader (used in buffer names)
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
fn default_data_bits() -> u8 { 8 }
#[allow(dead_code)]
fn default_stop_bits() -> u8 { 1 }
#[allow(dead_code)]
fn default_parity() -> String { "none".to_string() }
#[allow(dead_code)]
fn default_data_bitrate() -> u32 { 2_000_000 }

// ============================================================================
// Utility Functions
// ============================================================================

/// Find the slcan bitrate command for a given bitrate
pub fn find_bitrate_command(bitrate: u32) -> Result<&'static str, IoError> {
    SLCAN_BITRATES
        .iter()
        .find(|(rate, _)| *rate == bitrate)
        .map(|(_, cmd)| *cmd)
        .ok_or_else(|| {
            let valid: Vec<String> = SLCAN_BITRATES.iter().map(|(r, _)| format!("{}", r)).collect();
            IoError::configuration(format!(
                "Invalid CAN bitrate {}. Valid bitrates: {}",
                bitrate,
                valid.join(", ")
            ))
        })
}

/// Find the slcan data phase bitrate command for a given bitrate (ELMUE FD extension)
pub fn find_data_bitrate_command(bitrate: u32) -> Result<&'static str, IoError> {
    SLCAN_DATA_BITRATES
        .iter()
        .find(|(rate, _)| *rate == bitrate)
        .map(|(_, cmd)| *cmd)
        .ok_or_else(|| {
            let valid: Vec<String> = SLCAN_DATA_BITRATES.iter().map(|(r, _)| format!("{}", r)).collect();
            IoError::configuration(format!(
                "Invalid CAN FD data bitrate {}. Valid bitrates: {}",
                bitrate,
                valid.join(", ")
            ))
        })
}

/// CAN FD DLC-to-payload-length mapping (ISO 11898-2:2015).
const DLC_LEN: [usize; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

/// Parse a single slcan frame line (classic CAN or CAN FD).
///
/// Format examples:
///   t1234AABBCCDD  -> Standard frame, ID=0x123, DLC=4, data=AA BB CC DD
///   T123456788AABBCCDD112233445566 -> Extended frame, ID=0x12345678, DLC=8
///   r1230          -> Standard RTR, ID=0x123, DLC=0
///   d7E09112233445566778899AABBCC -> FD frame, ID=0x7E0, 12 bytes
///   b7E0F...64 hex bytes... -> FD+BRS frame, ID=0x7E0, 64 bytes
pub fn parse_slcan_frame(line: &str) -> Option<FrameMessage> {
    let bytes = line.as_bytes();
    if bytes.is_empty() {
        return None;
    }

    // Determine frame type from first character
    let (is_extended, is_rtr, is_fd) = match bytes[0] {
        b't' => (false, false, false),
        b'T' => (true,  false, false),
        b'r' => (false, true,  false),
        b'R' => (true,  true,  false),
        b'd' => (false, false, true),
        b'D' => (true,  false, true),
        b'b' => (false, false, true),
        b'B' => (true,  false, true),
        _ => return None, // Not a frame (could be response like 'z', '\r', etc.)
    };

    let id_len = if is_extended { 8 } else { 3 };
    let min_len = 1 + id_len + 1; // prefix + ID + DLC

    if bytes.len() < min_len {
        return None;
    }

    // Parse frame ID (hex ASCII)
    let id_str = std::str::from_utf8(&bytes[1..1 + id_len]).ok()?;
    let frame_id = u32::from_str_radix(id_str, 16).ok()?;

    // Parse DLC (single hex digit: 0-8 classic, 0-F for FD)
    let dlc_char = bytes[1 + id_len] as char;
    let dlc_code = dlc_char.to_digit(16)? as u8;

    let max_dlc = if is_fd { 15 } else { 8 };
    if dlc_code > max_dlc {
        return None;
    }

    let data_len = if is_fd {
        DLC_LEN[dlc_code as usize]
    } else {
        dlc_code as usize
    };

    // Parse data bytes (pairs of hex characters)
    let mut data = Vec::with_capacity(data_len);
    if !is_rtr && data_len > 0 {
        let data_start = 1 + id_len + 1;
        let expected_len = data_start + (data_len * 2);

        if bytes.len() < expected_len {
            return None;
        }

        for i in 0..data_len {
            let byte_str = std::str::from_utf8(&bytes[data_start + i * 2..data_start + i * 2 + 2]).ok()?;
            let byte = u8::from_str_radix(byte_str, 16).ok()?;
            data.push(byte);
        }
    }

    Some(FrameMessage {
        protocol: "can".to_string(),
        timestamp_us: now_us(),
        frame_id,
        bus: 0,
        dlc: data_len as u8,
        bytes: data,
        is_extended,
        is_fd,
        source_address: None,
        incomplete: None,
        direction: None,
    })
}

/// Encode a CAN frame to slcan format for transmission
///
/// Returns the ASCII command string including trailing \r
#[cfg(test)]
fn encode_slcan_frame(frame: &FrameMessage) -> String {
    let mut cmd = String::with_capacity(32);

    // Frame type prefix
    if frame.is_extended {
        cmd.push('T');
        cmd.push_str(&format!("{:08X}", frame.frame_id));
    } else {
        cmd.push('t');
        cmd.push_str(&format!("{:03X}", frame.frame_id & 0x7FF));
    }

    // DLC
    cmd.push_str(&format!("{:X}", frame.dlc.min(8)));

    // Data bytes
    for byte in &frame.bytes {
        cmd.push_str(&format!("{:02X}", byte));
    }

    cmd.push('\r');
    cmd
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
    let parity = serial_utils::parity_str_to_serialport(&parity.unwrap_or_else(|| "none".to_string()));

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
    let _ = serial_port.write_all(b"C\r");
    let _ = serial_port.flush();
    std::thread::sleep(Duration::from_millis(50));

    // Clear again after close
    let _ = serial_port.clear(serialport::ClearBuffer::All);

    let mut version: Option<String> = None;
    let mut hardware_version: Option<String> = None;
    let mut serial_number: Option<String> = None;
    let mut is_elmue_firmware = false;
    let mut got_any_response = false;

    // Query firmware version (V command)
    // The Elmue CANable 2.5 firmware returns an extended multi-line response:
    //   V+Board: MultiboardMCU: STM32G431DevID: 1128Firmware: 2490643Slcan: 100Clock: 160Limits: ...
    // Standard slcan firmware returns a short response: "V1013"
    if let Some(response) = send_and_read_all(&mut serial_port, b"V\r") {
        got_any_response = true;
        let trimmed = response.trim();
        if !trimmed.is_empty() && trimmed != "\x07" {
            // Try to parse Elmue extended format (contains "Firmware:" field)
            // Elmue CANable 2.5 firmware supports CAN FD on STM32G431
            if let Some(fw_pos) = trimmed.find("Firmware:") {
                is_elmue_firmware = true;
                let after_fw = &trimmed[fw_pos + 9..];
                // Extract digits until next non-digit character
                let fw_digits: String = after_fw.chars().take_while(|c| c.is_ascii_digit()).collect();
                if !fw_digits.is_empty() {
                    version = Some(format_version(&fw_digits));
                }
                // Extract board info for hardware_version
                if let Some(board_pos) = trimmed.find("Board:") {
                    let after_board = &trimmed[board_pos + 6..];
                    // Take until "MCU:" or end
                    let board = if let Some(mcu_pos) = after_board.find("MCU:") {
                        after_board[..mcu_pos].trim()
                    } else {
                        after_board.split_whitespace().next().unwrap_or("")
                    };
                    if !board.is_empty() {
                        // Also grab MCU if present
                        if let Some(mcu_pos) = trimmed.find("MCU:") {
                            let after_mcu = &trimmed[mcu_pos + 4..];
                            let mcu: String = after_mcu.chars().take_while(|c| *c != 'D' && *c != '\r' && *c != '\n').collect();
                            let mcu = mcu.trim();
                            if !mcu.is_empty() {
                                hardware_version = Some(format!("{} {}", board.trim_start_matches('+').trim(), mcu));
                            } else {
                                hardware_version = Some(board.trim_start_matches('+').trim().to_string());
                            }
                        } else {
                            hardware_version = Some(board.trim_start_matches('+').trim().to_string());
                        }
                    }
                }
            } else {
                // Standard slcan format: "V1013" or "v1013"
                let raw = if trimmed.starts_with('V') || trimmed.starts_with('v') {
                    &trimmed[1..]
                } else {
                    trimmed
                };
                version = Some(format_version(raw));
            }
        }
    }

    // Query hardware version (v command) - some devices support this
    // Skip if we already got hardware info from the extended V response
    if hardware_version.is_none() {
        if let Some(response) = send_and_read(&mut serial_port, b"v\r") {
            got_any_response = true;
            let trimmed = response.trim();
            if !trimmed.is_empty() && trimmed != "\x07" {
                hardware_version = Some(if trimmed.starts_with('v') {
                    trimmed[1..].to_string()
                } else {
                    trimmed.to_string()
                });
            }
        }
    }

    // Query serial number (N command) - some devices support this
    if let Some(response) = send_and_read(&mut serial_port, b"N\r") {
        got_any_response = true;
        let trimmed = response.trim();
        if !trimmed.is_empty() && trimmed != "\x07" {
            serial_number = Some(if trimmed.starts_with('N') {
                trimmed[1..].to_string()
            } else {
                trimmed.to_string()
            });
        }
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

/// Format a version string (e.g., "1013" -> "1.0.13" or keep as-is if format unclear)
fn format_version(s: &str) -> String {
    let s = s.trim();
    // Common CANable format: 4 digits like "1013" -> "1.0.13"
    if s.len() == 4 && s.chars().all(|c| c.is_ascii_digit()) {
        let chars: Vec<char> = s.chars().collect();
        format!("{}.{}.{}{}", chars[0], chars[1], chars[2], chars[3])
    } else {
        s.to_string()
    }
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
                    if b == 0x07 {
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

    if response.is_empty() { None } else { Some(response) }
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
                    if b == 0x07 {
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

/// Encode a CAN transmit frame to slcan format for transmission
pub fn encode_transmit_frame(frame: &CanTransmitFrame) -> Vec<u8> {
    let mut cmd = String::with_capacity(32);

    // Frame type prefix
    if frame.is_extended {
        cmd.push('T');
        cmd.push_str(&format!("{:08X}", frame.frame_id));
    } else {
        cmd.push('t');
        cmd.push_str(&format!("{:03X}", frame.frame_id & 0x7FF));
    }

    // DLC
    cmd.push_str(&format!("{:X}", frame.data.len().min(8)));

    // Data bytes
    for byte in &frame.data {
        cmd.push_str(&format!("{:02X}", byte));
    }

    cmd.push('\r');
    cmd.into_bytes()
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

        // Close any existing channel
        let _ = port.write_all(b"C\r");
        let _ = port.flush();
        std::thread::sleep(Duration::from_millis(50));

        // Set nominal bitrate
        let bitrate_cmd = find_bitrate_command(bitrate).map_err(String::from)?;
        port.write_all(format!("{}\r", bitrate_cmd).as_bytes())
            .map_err(|e| IoError::protocol(&device, format!("set bitrate: {}", e)).to_string())?;
        let _ = port.flush();
        std::thread::sleep(Duration::from_millis(50));

        // Set data phase bitrate (ELMUE FD extension) — implicitly enables FD mode
        if enable_fd {
            let data_cmd = find_data_bitrate_command(data_bitrate).map_err(String::from)?;
            port.write_all(format!("{}\r", data_cmd).as_bytes())
                .map_err(|e| IoError::protocol(&device, format!("set data bitrate: {}", e)).to_string())?;
            let _ = port.flush();
            std::thread::sleep(Duration::from_millis(50));
        }

        // Set mode: M0 = normal, M1 = silent
        let mode_cmd = if silent_mode { "M1" } else { "M0" };
        port.write_all(format!("{}\r", mode_cmd).as_bytes())
            .map_err(|e| IoError::protocol(&device, format!("set mode: {}", e)).to_string())?;
        let _ = port.flush();
        std::thread::sleep(Duration::from_millis(50));

        // Open channel
        port.write_all(b"O\r")
            .map_err(|e| IoError::protocol(&device, format!("open channel: {}", e)).to_string())?;
        let _ = port.flush();

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
        source_idx, port_path, bitrate, silent_mode, enable_fd,
        if enable_fd { format!(", data_bitrate: {}", data_bitrate) } else { String::new() }
    );

    // Emit device-connected event
    let _ = tx
        .send(SourceMessage::Connected(source_idx, "slcan".to_string(), port_path.clone(), None))
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

    let blocking_handle = tokio::task::spawn_blocking(move || {
        let mut line_buf = String::with_capacity(256);
        let mut read_buf = [0u8; 256];

        while !stop_flag_clone.load(Ordering::SeqCst) {
            // Read data — no mutex, we own this handle
            let read_result = serial_port.read(&mut read_buf);

            match read_result {
                Ok(n) if n > 0 => {
                    let mut pending_frames: Vec<FrameMessage> = Vec::new();

                    for &byte in &read_buf[..n] {
                        if byte == b'\r' || byte == b'\n' {
                            if !line_buf.is_empty() {
                                if let Some(mut frame) = parse_slcan_frame(&line_buf) {
                                    // Apply bus mapping
                                    if apply_bus_mapping(&mut frame, &bus_mappings) {
                                        pending_frames.push(frame);
                                    }
                                }
                                line_buf.clear();
                            }
                        } else if byte == 0x07 {
                            // Bell = error
                            line_buf.clear();
                        } else if byte.is_ascii() && !byte.is_ascii_control() {
                            line_buf.push(byte as char);
                            if line_buf.len() > 512 {
                                tlog!("[slcan] Line buffer exceeded 512 bytes, discarding");
                                line_buf.clear();
                            }
                        }
                    }

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
                    let _ = tx_clone.blocking_send(SourceMessage::Error(
                        source_idx,
                        format!("Read error: {}", e),
                    ));
                    return;
                }
            }
        }

        // Close channel
        let _ = serial_port.write_all(b"C\r");
        let _ = serial_port.flush();

        let _ = tx_clone.blocking_send(SourceMessage::Ended(source_idx, "stopped".to_string()));
    });

    let _ = blocking_handle.await;
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_standard_frame() {
        let frame = parse_slcan_frame("t1234AABBCCDD").unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 4);
        assert_eq!(frame.bytes, vec![0xAA, 0xBB, 0xCC, 0xDD]);
        assert!(!frame.is_extended);
        assert!(!frame.is_fd);
    }

    #[test]
    fn test_parse_extended_frame() {
        let frame = parse_slcan_frame("T123456782AABB").unwrap();
        assert_eq!(frame.frame_id, 0x12345678);
        assert_eq!(frame.dlc, 2);
        assert_eq!(frame.bytes, vec![0xAA, 0xBB]);
        assert!(frame.is_extended);
    }

    #[test]
    fn test_parse_standard_frame_zero_dlc() {
        let frame = parse_slcan_frame("t1230").unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 0);
        assert!(frame.bytes.is_empty());
    }

    #[test]
    fn test_parse_standard_frame_max_dlc() {
        let frame = parse_slcan_frame("t1238AABBCCDD11223344").unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 8);
        assert_eq!(frame.bytes.len(), 8);
    }

    #[test]
    fn test_parse_rtr_frame() {
        let frame = parse_slcan_frame("r1234").unwrap();
        assert_eq!(frame.frame_id, 0x123);
        assert_eq!(frame.dlc, 4);
        assert!(frame.bytes.is_empty()); // RTR has no data
    }

    #[test]
    fn test_parse_extended_rtr() {
        let frame = parse_slcan_frame("R123456780").unwrap();
        assert_eq!(frame.frame_id, 0x12345678);
        assert_eq!(frame.dlc, 0);
        assert!(frame.is_extended);
    }

    #[test]
    fn test_parse_invalid_prefix() {
        assert!(parse_slcan_frame("x1234AABB").is_none());
        assert!(parse_slcan_frame("z").is_none());
        assert!(parse_slcan_frame("").is_none());
    }

    #[test]
    fn test_parse_invalid_dlc() {
        // DLC > 8 is invalid for classic CAN
        assert!(parse_slcan_frame("t123FAABBCCDD").is_none());
    }

    #[test]
    fn test_parse_truncated_frame() {
        // Not enough data bytes for DLC
        assert!(parse_slcan_frame("t1234AA").is_none());
    }

    #[test]
    fn test_encode_standard_frame() {
        let frame = FrameMessage {
            protocol: "can".to_string(),
            timestamp_us: 0,
            frame_id: 0x123,
            bus: 0,
            dlc: 3,
            bytes: vec![0x01, 0x02, 0x03],
            is_extended: false,
            is_fd: false,
            source_address: None,
            incomplete: None,
            direction: None,
        };
        assert_eq!(encode_slcan_frame(&frame), "t1233010203\r");
    }

    #[test]
    fn test_encode_extended_frame() {
        let frame = FrameMessage {
            protocol: "can".to_string(),
            timestamp_us: 0,
            frame_id: 0x12345678,
            bus: 0,
            dlc: 2,
            bytes: vec![0xAA, 0xBB],
            is_extended: true,
            is_fd: false,
            source_address: None,
            incomplete: None,
            direction: None,
        };
        assert_eq!(encode_slcan_frame(&frame), "T123456782AABB\r");
    }

    #[test]
    fn test_encode_decode_roundtrip() {
        let original = FrameMessage {
            protocol: "can".to_string(),
            timestamp_us: 0,
            frame_id: 0x7FF,
            bus: 0,
            dlc: 4,
            bytes: vec![0xDE, 0xAD, 0xBE, 0xEF],
            is_extended: false,
            is_fd: false,
            source_address: None,
            incomplete: None,
            direction: None,
        };

        let encoded = encode_slcan_frame(&original);
        // Remove trailing \r for parsing
        let decoded = parse_slcan_frame(&encoded[..encoded.len() - 1]).unwrap();

        assert_eq!(decoded.frame_id, original.frame_id);
        assert_eq!(decoded.dlc, original.dlc);
        assert_eq!(decoded.bytes, original.bytes);
        assert_eq!(decoded.is_extended, original.is_extended);
    }

    #[test]
    fn test_bitrate_mapping() {
        assert_eq!(find_bitrate_command(500_000).unwrap(), "S6");
        assert_eq!(find_bitrate_command(125_000).unwrap(), "S4");
        assert_eq!(find_bitrate_command(1_000_000).unwrap(), "S8");
        assert_eq!(find_bitrate_command(10_000).unwrap(), "S0");
        assert!(find_bitrate_command(123_456).is_err());
    }
}
