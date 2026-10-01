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
use std::sync::{atomic::AtomicBool, Arc};

use tokio::sync::mpsc;
use wiretap_io::can::slcan::{open as open_slcan, probe, SlcanOptions};
use wiretap_io::can::{CanError, CanEvent, DeviceInfo};
use wiretap_io::serial::LineSettings;
use wiretap_protocol::slcan::{bitrate_command, data_bitrate_command, DATA_BITRATES, NOMINAL_BITRATES};

use crate::io::bus_mapping::BusMapping;
use crate::io::device_kinds::{req_bool, req_i64};
use crate::io::can_task::{
    can_options, link_lost, mapped_frames, open_failed, serve, PortOutage, PORT_REOPEN,
    PROBE_TIMEOUT,
};
use crate::io::serial::utils::probe_serial_presence;
use crate::io::types::SourceMessage;
use crate::settings::IOProfile;

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

/// Opens the port, asks `V`, `v` and `N`, and closes it, within [`PROBE_TIMEOUT`].
pub async fn probe_slcan(port: &str, line: LineSettings) -> SlcanProbeResult {
    probe_result(
        &format!("slcan({})", port),
        probe(port, line, PROBE_TIMEOUT).await,
    )
}

fn probe_result(device: &str, probed: Result<DeviceInfo, CanError>) -> SlcanProbeResult {
    match probed {
        Ok(info) => SlcanProbeResult {
            success: true,
            version: info.firmware,
            hardware_version: info.hardware,
            serial_number: info.serial,
            supports_fd: Some(info.fd),
            error: None,
        },
        Err(e) => SlcanProbeResult {
            success: false,
            version: None,
            hardware_version: None,
            serial_number: None,
            supports_fd: None,
            error: Some(match e {
                CanError::Handshake(_) => "No response from device".to_string(),
                other => open_failed(device, other),
            }),
        },
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

/// The nominal and CAN FD data rates a profile asks for, refused when SLCAN has
/// no command for one. The library refuses the same at open, but only once the
/// session has already reported Running.
pub fn slcan_rates(profile: &IOProfile) -> Result<(u32, Option<u32>), String> {
    let bitrate = req_i64(profile, "bitrate")? as u32;
    let data_bitrate = req_bool(profile, "enable_fd")?
        .then(|| req_i64(profile, "data_bitrate").map(|bps| bps as u32))
        .transpose()?;
    nameable(bitrate, bitrate_command, &NOMINAL_BITRATES)?;
    if let Some(bps) = data_bitrate {
        nameable(bps, data_bitrate_command, &DATA_BITRATES)?;
    }
    Ok((bitrate, data_bitrate))
}

fn nameable(bps: u32, lookup: fn(u32) -> Option<&'static str>, table: &[(u32, &str)]) -> Result<(), String> {
    lookup(bps).map(drop).ok_or_else(|| {
        let rates: Vec<String> = table.iter().map(|(rate, _)| rate.to_string()).collect();
        format!("{bps} bit/s is not an SLCAN rate; it takes {}", rates.join(", "))
    })
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
    let task = match open_slcan(options, can_options(silent_mode, PORT_REOPEN)).await {
        Ok(task) => task,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(source_idx, open_failed(&device, e)))
                .await;
            return;
        }
    };

    let mut outage = PortOutage::new(source_idx, &port);
    serve(
        task,
        source_idx,
        silent_mode,
        &stop_flag,
        &tx,
        |event| {
            outage.on_event(event, probe_serial_presence, |e| {
                on_event(source_idx, &port, &bus_mappings, e)
            })
        },
        |error| link_lost(source_idx, &device, error),
    )
    .await;
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::can_task::{lost, reopen_failed};
    use crate::io::error::DevicePresence;
    use std::time::{Duration, UNIX_EPOCH};
    use wiretap_io::can::{CanFrame, CanRead, Direction};
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
        CanRead::new(
            frame,
            Direction::Rx,
            UNIX_EPOCH + Duration::from_micros(1_000),
        )
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
    fn an_unplug_interrupts_once_and_a_replug_resumes() {
        let mut outage = PortOutage::new(3, "/dev/cu.x");
        let mut source = |event| {
            outage
                .on_event(
                    event,
                    |_| DevicePresence::Absent,
                    |e| on_event(3, "/dev/cu.x", &[], e),
                )
                .expect("an outage never ends the source")
        };
        let unplugged = source(lost(CanError::Closed));
        let [SourceMessage::Interrupted(3, message)] = unplugged.as_slice() else {
            panic!("expected one interruption and no ending");
        };
        assert_eq!(
            message,
            "/dev/cu.x: device disconnected, waiting for it to return"
        );
        assert!(source(reopen_failed("/dev/cu.x")).is_empty());

        let replugged = source(CanEvent::Connected(DeviceInfo::default()));
        assert!(matches!(
            replugged[..],
            [SourceMessage::Connected(3, _, _, None)]
        ));
        assert_eq!(source(lost(CanError::Closed)).len(), 1, "a new outage");
    }

    const LINE_8N1: LineSettings = LineSettings {
        baud: 115_200,
        data_bits: 8,
        parity: Parity::None,
        stop_bits: 1,
    };

    async fn first_message(bitrate: u32) -> SourceMessage {
        let (tx, mut rx) = mpsc::channel(8);
        run_source(
            3,
            "/nonexistent/wiretap-slcan".to_string(),
            LINE_8N1,
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
    fn a_device_that_answered_reports_what_it_said() {
        let mut info = DeviceInfo::default();
        info.firmware = Some("1013".into());
        info.hardware = Some("CANable2 STM32G431".into());
        info.serial = Some("0012".into());
        info.fd = true;
        let result = probe_result("slcan(p)", Ok(info));
        assert!(result.success);
        assert_eq!(result.version.as_deref(), Some("1013"));
        assert_eq!(
            result.hardware_version.as_deref(),
            Some("CANable2 STM32G431")
        );
        assert_eq!(result.serial_number.as_deref(), Some("0012"));
        assert_eq!(result.supports_fd, Some(true));
    }

    #[test]
    fn silence_is_no_response() {
        let result = probe_result(
            "slcan(p)",
            Err(CanError::Handshake("no answer to V, v or N")),
        );
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("No response from device"));
        assert_eq!(result.supports_fd, None);
    }

    #[tokio::test]
    async fn a_port_that_will_not_open_fails_the_probe_and_is_named() {
        let result = probe_slcan("/nonexistent/wiretap-slcan", LINE_8N1).await;
        assert!(!result.success);
        let error = result.error.expect("an error");
        assert!(error.contains("/nonexistent/wiretap-slcan"), "got: {error}");
    }
}
