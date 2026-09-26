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
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

use tokio::sync::mpsc;
use wiretap_io::can::slcan::{open as open_slcan, SlcanOptions};
use wiretap_io::can::{CanError, CanEvent};
use wiretap_io::serial::LineSettings;

use crate::io::bus_mapping::BusMapping;
use crate::io::can_task::{can_options, mapped_frames, open_failed, port_lost, serve};
use crate::io::error::IoError;
use crate::io::serial::utils::{self as serial_utils, probe_serial_presence};
use crate::io::types::SourceMessage;
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

/// What the broker is told of `event`, or the loss that ends the source.
fn on_event(
    source_idx: usize,
    port: &str,
    mappings: &[BusMapping],
    event: CanEvent,
) -> Result<Vec<SourceMessage>, CanError> {
    match event {
        CanEvent::Connected(info) => {
            tlog!(
                "[slcan] Source {} connected to {} (firmware: {:?}, fd: {})",
                source_idx,
                port,
                info.firmware,
                info.fd
            );
            Ok(vec![SourceMessage::Connected(
                source_idx,
                "slcan".to_string(),
                port.to_string(),
                None,
            )])
        }
        CanEvent::Read(reads) => Ok(mapped_frames(source_idx, reads, mappings)
            .into_iter()
            .collect()),
        CanEvent::Disconnected { error, .. } => Err(error),
    }
}

/// Run slcan source and send frames to merge task
pub async fn run_source(
    source_idx: usize,
    port: String,
    line: LineSettings,
    bitrate: u32,
    silent_mode: bool,
    data_bitrate: Option<u32>,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let device = format!("slcan({})", port);
    let options = SlcanOptions {
        path: port.clone(),
        line,
        bitrate,
        data_bitrate,
    };
    let task = match open_slcan(options, can_options(silent_mode)).await {
        Ok(task) => task,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(source_idx, open_failed(&device, e)))
                .await;
            return;
        }
    };

    serve(
        task,
        source_idx,
        silent_mode,
        &stop_flag,
        &tx,
        |event| on_event(source_idx, &port, &bus_mappings, event),
        |error| port_lost(source_idx, &device, &port, error, probe_serial_presence),
    )
    .await;
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;
    use wiretap_io::can::{CanFrame, CanRead, DeviceInfo, Direction};
    use wiretap_io::serial::Parity;

    fn mapping(enabled: bool, output_bus: u8) -> BusMapping {
        BusMapping {
            device_bus: 0,
            enabled,
            output_bus,
            ..BusMapping::default()
        }
    }

    fn read(frame: CanFrame) -> CanRead {
        CanRead {
            frame,
            direction: Direction::Rx,
            at: UNIX_EPOCH + Duration::from_micros(1_000),
            device_us: None,
        }
    }

    #[test]
    fn a_connect_is_announced_as_slcan_on_its_port() {
        let messages = on_event(
            3,
            "/dev/cu.x",
            &[],
            CanEvent::Connected(DeviceInfo::default()),
        )
        .unwrap();
        let [SourceMessage::Connected(3, kind, port, None)] = messages.as_slice() else {
            panic!("expected Connected alone");
        };
        assert_eq!((kind.as_str(), port.as_str()), ("slcan", "/dev/cu.x"));
    }

    /// SLCAN has no bus number: every frame is bus 0 until the mapping moves it.
    #[test]
    fn a_read_lands_on_the_mapped_bus_at_its_read_time() {
        let frames = vec![read(CanFrame::data(
            0,
            0x123,
            false,
            false,
            false,
            vec![1, 2],
        ))];
        let messages = on_event(3, "p", &[mapping(true, 4)], CanEvent::Read(frames)).unwrap();
        let [SourceMessage::Frames(3, frames)] = messages.as_slice() else {
            panic!("expected one Frames");
        };
        assert_eq!((frames[0].bus, frames[0].timestamp_us), (4, 1_000));

        let muted = vec![read(CanFrame::data(0, 0x123, false, false, false, vec![]))];
        let muted = on_event(3, "p", &[mapping(false, 4)], CanEvent::Read(muted)).unwrap();
        assert!(muted.is_empty());
    }

    /// `FrameMessage` has no RTR flag, so a remote request arrives as an empty
    /// data frame, as it did before the library read it.
    #[test]
    fn a_remote_request_arrives_as_an_empty_frame() {
        let remote = vec![read(CanFrame::remote(0, 0x123, false, 3))];
        let messages = on_event(3, "p", &[mapping(true, 0)], CanEvent::Read(remote)).unwrap();
        let [SourceMessage::Frames(3, frames)] = messages.as_slice() else {
            panic!("expected one Frames");
        };
        assert_eq!((frames[0].dlc, frames[0].bytes.len()), (0, 0));
    }

    #[test]
    fn a_loss_ends_the_stream() {
        let lost = on_event(
            3,
            "p",
            &[],
            CanEvent::Disconnected {
                error: CanError::Closed,
                consecutive: 1,
                retry_in: None,
            },
        );
        assert!(matches!(lost, Err(CanError::Closed)));
    }

    async fn first_message(bitrate: u32) -> SourceMessage {
        let (tx, mut rx) = mpsc::channel(8);
        run_source(
            3,
            "/nonexistent/wiretap-slcan".to_string(),
            LineSettings {
                baud: 115_200,
                data_bits: 8,
                parity: Parity::None,
                stop_bits: 1,
            },
            bitrate,
            false,
            None,
            vec![],
            Arc::new(AtomicBool::new(false)),
            tx,
        )
        .await;
        rx.recv().await.expect("a message")
    }

    #[tokio::test]
    async fn a_port_that_will_not_open_is_named() {
        let SourceMessage::Error(3, error) = first_message(500_000).await else {
            panic!("expected an error");
        };
        assert!(error.contains("/nonexistent/wiretap-slcan"), "got: {error}");
    }

    #[tokio::test]
    async fn a_bitrate_slcan_cannot_name_says_which_ones_it_can() {
        let SourceMessage::Error(3, error) = first_message(300_000).await else {
            panic!("expected an error");
        };
        assert!(
            error.contains("300000"),
            "should name what was asked: {error}"
        );
        assert!(
            error.contains("500000"),
            "and what it could have been: {error}"
        );
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
