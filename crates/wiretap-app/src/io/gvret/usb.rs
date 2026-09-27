// ui/crates/wiretap-app/src/io/gvret/usb.rs
//
// GVRET USB serial protocol implementation for devices like ESP32-RET, M2RET, CANDue
// and other GVRET-compatible hardware over USB serial.
//
// Protocol reference: https://github.com/collin80/GVRET

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use wiretap_io::can::gvret::{open as open_gvret, GvretOptions, Link};
use wiretap_io::serial::LineSettings;

use super::common::{
    absorb_num_buses_reply, handshake_failed, GvretDeviceInfo, NumBusesOutcome, Stream,
};
use crate::io::bus_mapping::BusMapping;
use crate::io::can_task::{can_options, link_lost, serve, PortOutage, PORT_REOPEN};
use crate::io::error::IoError;
use crate::io::serial::utils::probe_serial_presence;
use crate::io::types::SourceMessage;
use wiretap_protocol::gvret;

/// A probe may wait longer than a streaming reader: it is a deliberate user
/// action against a device that may still be booting, and nothing streams until
/// it answers.
const PROBE_NUMBUSES_TIMEOUT: Duration = Duration::from_secs(2);

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
    /// Display name for the reader (used in capture names)
    pub display_name: Option<String>,
    /// Bus number override - if set, all frames will use this bus number
    /// instead of the device-reported bus number
    #[serde(default)]
    pub bus_override: Option<u8>,
}

// ============================================================================
// Device Probing
// ============================================================================

/// The device label both the probe and the streaming path identify themselves by.
fn gvret_usb_device(port: &str) -> String {
    format!("gvret_usb({})", port)
}

/// Ask a connected device how many buses it has.
///
/// The serial counterpart of the TCP query — same outcomes, and the same reason
/// for collecting into `pending`: a device already streaming interleaves frames
/// with the reply, and dropping them would lose traffic the session is meant to
/// capture.
fn query_num_buses(
    port: &mut dyn serialport::SerialPort,
    decoder: &mut gvret::DeviceDecoder,
    pending: &mut Vec<crate::io::FrameMessage>,
    timeout: Duration,
) -> NumBusesOutcome {
    if let Err(e) = port.write_all(&gvret::REQ_NUM_BUSES) {
        return NumBusesOutcome::Failed(e.to_string());
    }
    let _ = port.flush();

    let deadline = std::time::Instant::now() + timeout;
    let mut read_buf = [0u8; 2048];
    while std::time::Instant::now() < deadline {
        match port.read(&mut read_buf) {
            // An idle port reports its own read timeout, below — so a zero-length
            // read here is a real end of stream, not the quiet case.
            Ok(0) => return NumBusesOutcome::Closed,
            Ok(n) => {
                if let Some(count) = absorb_num_buses_reply(decoder, &read_buf[..n], pending) {
                    return NumBusesOutcome::Answered(count);
                }
            }
            // The port's own timeout paces this loop; nothing arrived this round.
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return NumBusesOutcome::Failed(e.to_string()),
        }
    }
    NumBusesOutcome::Silent
}

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
        port,
        baud_rate
    );

    let device = gvret_usb_device(port);

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
        .write_all(&gvret::SYNC)
        .map_err(|e| IoError::protocol(&device, format!("enable binary mode: {}", e)))?;
    let _ = serial_port.flush();

    // Wait for device to process
    std::thread::sleep(Duration::from_millis(100));

    let mut decoder = gvret::DeviceDecoder::new();
    match query_num_buses(
        &mut *serial_port,
        &mut decoder,
        &mut Vec::new(),
        PROBE_NUMBUSES_TIMEOUT,
    ) {
        NumBusesOutcome::Answered(bus_count) => {
            tlog!(
                "[probe_gvret_usb] SUCCESS: Device at {} has {} buses available",
                port,
                bus_count
            );
            Ok(GvretDeviceInfo { bus_count })
        }
        NumBusesOutcome::Failed(e) => Err(IoError::read(&device, e)),
        // A probe reports what it can rather than refusing — see the TCP probe.
        NumBusesOutcome::Closed | NumBusesOutcome::Silent => {
            tlog!("[probe_gvret_usb] No NUMBUSES response received, defaulting to 1 bus");
            Ok(GvretDeviceInfo { bus_count: 1 })
        }
    }
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

/// Run GVRET USB source and send frames to merge task
pub async fn run_source(
    source_idx: usize,
    port: String,
    line: LineSettings,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    let device = gvret_usb_device(&port);
    let link = Link::Serial {
        path: port.clone(),
        line,
    };
    let task = match open_gvret(
        link,
        GvretOptions::default(),
        can_options(false, PORT_REOPEN),
    )
    .await
    {
        Ok(task) => task,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    handshake_failed(&device, e),
                ))
                .await;
            return;
        }
    };

    let mut stream = Stream::new(
        source_idx,
        "gvret_usb",
        device.clone(),
        port.clone(),
        bus_mappings,
    );
    let mut outage = PortOutage::new(source_idx, &port);
    serve(
        task,
        source_idx,
        false,
        &stop_flag,
        &tx,
        |event| outage.on_event(event, probe_serial_presence, |e| stream.on_event(e)),
        |error| link_lost(source_idx, &device, error),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::super::common::MAX_BUSES;
    use super::*;
    use crate::io::can_task::{lost, reopen_failed};
    use crate::io::error::DevicePresence;
    use wiretap_io::can::{CanError, CanEvent, DeviceInfo};
    use wiretap_io::serial::Parity;

    const PORT: &str = "/dev/cu.usbmodem1";

    fn connected(buses: u8) -> CanEvent {
        let mut info = DeviceInfo::default();
        info.buses = Some(buses);
        CanEvent::Connected(info)
    }

    /// The composition `run_source` serves.
    fn source() -> impl FnMut(CanEvent) -> Vec<SourceMessage> {
        let mut stream = Stream::new(3, "gvret_usb", gvret_usb_device(PORT), PORT.into(), vec![]);
        let mut outage = PortOutage::new(3, PORT);
        move |event| {
            outage
                .on_event(event, |_| DevicePresence::Absent, |e| stream.on_event(e))
                .expect("an outage never ends the source")
        }
    }

    fn buses(messages: &[SourceMessage]) -> usize {
        match messages {
            [SourceMessage::MappingsResolved(3, mappings), SourceMessage::Connected(3, ..)] => {
                mappings.len()
            }
            _ => panic!("expected MappingsResolved then Connected"),
        }
    }

    #[test]
    fn an_unplug_interrupts_once_and_a_replug_resolves_the_buses_again() {
        let mut source = source();
        assert_eq!(buses(&source(connected(2))), 2);

        let unplugged = source(lost(CanError::Closed));
        let [SourceMessage::Interrupted(3, message)] = unplugged.as_slice() else {
            panic!("expected one interruption and no ending");
        };
        assert_eq!(
            message,
            &format!("{PORT}: device disconnected, waiting for it to return")
        );
        assert!(source(reopen_failed(PORT)).is_empty());

        assert_eq!(
            buses(&source(connected(0))),
            MAX_BUSES as usize,
            "another device's count, clamped"
        );
        assert_eq!(source(lost(CanError::Unresponsive)).len(), 1);
    }

    #[tokio::test]
    async fn a_port_that_will_not_open_is_named() {
        let (tx, mut rx) = mpsc::channel(8);
        let line = LineSettings {
            baud: 115_200,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: 1,
        };
        let path = "/nonexistent/wiretap-gvret".to_string();
        let stop = Arc::new(AtomicBool::new(false));
        run_source(3, path, line, vec![], stop, tx).await;
        let Some(SourceMessage::Error(3, error)) = rx.recv().await else {
            panic!("expected an error");
        };
        assert!(error.contains("/nonexistent/wiretap-gvret"), "got: {error}");
    }
}
