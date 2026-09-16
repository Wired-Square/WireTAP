// ui/crates/wiretap-app/src/io/gvret/usb.rs
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

use super::common::{
    absorb_num_buses_reply, decode_mapped, resolve_source_mappings, GvretDeviceInfo,
    NumBusesOutcome, NUMBUSES_TIMEOUT,
};
use crate::io::bus_mapping::{apply_bus_mappings_batch, BusMapping};
use crate::io::error::IoError;
use crate::io::types::{EndReason, SourceMessage, TransmitRequest};
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
        let mut port = serial_port
            .lock()
            .map_err(|e| format!("Port lock poisoned: {}", e))?;
        let _ = port.clear(serialport::ClearBuffer::All);

        // Enable binary mode
        port.write_all(&gvret::SYNC)
            .map_err(|e| format!("Failed to enable binary mode: {}", e))?;
        let _ = port.flush();
        Ok(())
    })();

    if let Err(e) = init_result {
        let _ = tx.send(SourceMessage::Error(source_idx, e)).await;
        return;
    }

    std::thread::sleep(Duration::from_millis(100));

    // Send the device-info probe and ask how many buses the device has. Both are
    // blocking serial reads that can take the full enumeration timeout against a
    // device that never answers, so they go to the blocking pool rather than
    // holding a runtime worker — every source starts on its own worker, so a
    // handful of silent adapters would otherwise stall the whole executor.
    let probe_port = serial_port.clone();
    let probe = tokio::task::spawn_blocking(move || match probe_port.lock() {
        Ok(mut port) => {
            let _ = port.write_all(&gvret::REQ_DEV_INFO);
            let _ = port.flush();
            let mut decoder = gvret::DeviceDecoder::new();
            let mut pending = Vec::new();
            let outcome =
                query_num_buses(&mut **port, &mut decoder, &mut pending, NUMBUSES_TIMEOUT);
            Ok((outcome, decoder, pending))
        }
        Err(e) => Err(format!("Port lock poisoned: {}", e)),
    })
    .await;

    let (outcome, mut decoder, pending) = match probe {
        Ok(Ok(probe)) => probe,
        Ok(Err(msg)) => {
            let _ = tx.send(SourceMessage::Error(source_idx, msg)).await;
            return;
        }
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Enumeration task failed: {}", e),
                ))
                .await;
            return;
        }
    };

    // The mappings we were handed came off the profile before this connection
    // existed, so they can carry a bus this device does not have — or, more
    // expensively, miss one it does.
    let Some(bus_mappings) = resolve_source_mappings(
        outcome,
        &bus_mappings,
        &gvret_usb_device(&port),
        source_idx,
        &tx,
    )
    .await
    else {
        return;
    };

    // Whatever arrived during the exchange above can only be mapped now.
    let pending = apply_bus_mappings_batch(pending, &bus_mappings);
    if !pending.is_empty() {
        let _ = tx.send(SourceMessage::Frames(source_idx, pending)).await;
    }

    // Create transmit channel and send it to the merge task
    let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
    let _ = tx
        .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
        .await;

    tlog!(
        "[gvret_usb] Source {} connected to {}, transmit channel ready",
        source_idx,
        port
    );

    // Emit device-connected event
    let _ = tx
        .send(SourceMessage::Connected(
            source_idx,
            "gvret_usb".to_string(),
            port.clone(),
            None,
        ))
        .await;

    // Read loop (blocking, so we run it in a blocking task)
    let tx_clone = tx.clone();
    let stop_flag_clone = stop_flag.clone();
    let serial_port_clone = serial_port.clone();
    let port_name = port.clone();

    // Spawn blocking task for serial reading
    let blocking_handle = tokio::task::spawn_blocking(move || {
        // `decoder` carries over from the enumeration above, so a message that
        // straddled the end of it is completed rather than re-read.
        let mut read_buf = [0u8; 2048];

        while !stop_flag_clone.load(Ordering::SeqCst) {
            // Check for transmit requests (non-blocking)
            while let Ok(req) = transmit_rx.try_recv() {
                let result = match serial_port_clone.lock() {
                    Ok(mut port) => port
                        .write_all(&req.data)
                        .and_then(|_| port.flush())
                        .map_err(|e| format!("Write error: {}", e)),
                    Err(e) => Err(format!("Port lock poisoned: {}", e)),
                };
                let _ = req.result_tx.send(result);
            }

            // Read data
            let read_result = match serial_port_clone.lock() {
                Ok(mut port) => port.read(&mut read_buf),
                Err(_) => {
                    let _ = tx_clone.blocking_send(SourceMessage::Error(
                        source_idx,
                        "Port lock poisoned during read".to_string(),
                    ));
                    return;
                }
            };

            match read_result {
                Ok(0) => {
                    // No data
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(n) => {
                    let frames = decode_mapped(&mut decoder, &read_buf[..n], &bus_mappings);
                    if !frames.is_empty() {
                        let _ = tx_clone.blocking_send(SourceMessage::Frames(source_idx, frames));
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // Timeout - continue
                }
                Err(e) => {
                    crate::io::serial::utils::send_serial_read_error(
                        &tx_clone, source_idx, &port_name, &e,
                    );
                    return;
                }
            }
        }

        let _ = tx_clone.blocking_send(SourceMessage::Ended(source_idx, EndReason::Stopped));
    });

    // Wait for the blocking task
    let _ = blocking_handle.await;
}
