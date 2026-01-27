// ui/src-tauri/src/io/gvret/tcp.rs
//
// GVRET TCP protocol implementation for streaming CAN data over TCP.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::io::error::IoError;
use crate::io::types::{SourceMessage, TransmitRequest};
use super::common::{
    apply_bus_mappings_gvret, parse_gvret_frames, parse_numbuses_response, BusMapping,
    BINARY_MODE_ENABLE, DEVICE_INFO_PROBE, GVRET_CMD_NUMBUSES, GvretDeviceInfo,
};

// ============================================================================
// Device Probing
// ============================================================================

/// Probe a GVRET TCP device to discover its capabilities
///
/// This function connects to the device, queries the number of available buses,
/// and returns device information. The connection is closed after probing.
///
/// Returns `IoError` for typed error handling. Use `.map_err(String::from)` if
/// you need a String error for backwards compatibility.
pub async fn probe_gvret_tcp(
    host: &str,
    port: u16,
    timeout_sec: f64,
) -> Result<GvretDeviceInfo, IoError> {
    eprintln!(
        "[probe_gvret_tcp] Probing GVRET device at {}:{} (timeout: {}s)",
        host, port, timeout_sec
    );

    // Connect with timeout
    let connect_res = tokio::time::timeout(
        Duration::from_secs_f64(timeout_sec),
        TcpStream::connect((host, port)),
    )
    .await;

    let device = format!("gvret_tcp({}:{})", host, port);

    let mut stream = match connect_res {
        Ok(Ok(s)) => {
            eprintln!("[probe_gvret_tcp] Connected to {}:{}", host, port);
            s
        }
        Ok(Err(e)) => return Err(IoError::connection(&device, e.to_string())),
        Err(_) => return Err(IoError::timeout(&device, "connect")),
    };

    // Enter binary mode
    stream
        .write_all(&BINARY_MODE_ENABLE)
        .await
        .map_err(|e| IoError::protocol(&device, format!("enable binary mode: {}", e)))?;

    // Wait a moment for the device to process
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Query number of buses
    stream
        .write_all(&GVRET_CMD_NUMBUSES)
        .await
        .map_err(|e| IoError::protocol(&device, format!("send NUMBUSES command: {}", e)))?;

    stream
        .flush()
        .await
        .map_err(|e| IoError::protocol(&device, format!("flush: {}", e)))?;

    // Read response with timeout
    // Response format: [0xF1][0x0C][bus_count]
    let mut buf = vec![0u8; 256];
    let mut total_read = 0;
    let read_timeout = Duration::from_millis((timeout_sec * 1000.0) as u64);

    let deadline = tokio::time::Instant::now() + read_timeout;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }

        match tokio::time::timeout(
            remaining.min(Duration::from_millis(100)),
            stream.read(&mut buf[total_read..]),
        )
        .await
        {
            Ok(Ok(0)) => break, // EOF
            Ok(Ok(n)) => {
                total_read += n;

                // Check for NUMBUSES response
                if let Some(bus_count) = parse_numbuses_response(&buf[..total_read]) {
                    eprintln!(
                        "[probe_gvret_tcp] SUCCESS: Device at {}:{} has {} buses available",
                        host, port, bus_count
                    );
                    return Ok(GvretDeviceInfo { bus_count });
                }

                // If we've read enough data without finding the response, give up
                if total_read > 128 {
                    break;
                }
            }
            Ok(Err(e)) => {
                return Err(IoError::read(&device, e.to_string()));
            }
            Err(_) => {
                // Timeout on this read, continue if we still have time
            }
        }
    }

    // If we didn't get a response, assume 1 bus (safer default)
    eprintln!("[probe_gvret_tcp] No NUMBUSES response received, defaulting to 1 bus");
    Ok(GvretDeviceInfo { bus_count: 1 })
}

// ============================================================================
// Multi-Source Streaming
// ============================================================================

/// Run GVRET TCP source and send frames to merge task
pub async fn run_source(
    source_idx: usize,
    host: String,
    port: u16,
    timeout_sec: f64,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    // Connect with timeout
    let connect_result = tokio::time::timeout(
        Duration::from_secs_f64(timeout_sec),
        TcpStream::connect((host.as_str(), port)),
    )
    .await;

    let stream = match connect_result {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    format!("Connection failed: {}", e),
                ))
                .await;
            return;
        }
        Err(_) => {
            let _ = tx
                .send(SourceMessage::Error(
                    source_idx,
                    "Connection timed out".to_string(),
                ))
                .await;
            return;
        }
    };

    // Split into read/write halves
    let (mut read_half, mut write_half) = stream.into_split();

    // Enable binary mode
    if let Err(e) = write_half.write_all(&BINARY_MODE_ENABLE).await {
        let _ = tx
            .send(SourceMessage::Error(
                source_idx,
                format!("Failed to enable binary mode: {}", e),
            ))
            .await;
        return;
    }
    let _ = write_half.flush().await;

    tokio::time::sleep(Duration::from_millis(100)).await;

    // Send device info probe
    let _ = write_half.write_all(&DEVICE_INFO_PROBE).await;
    let _ = write_half.flush().await;

    // Create transmit channel and send it to the merge task
    let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
    let _ = tx
        .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
        .await;

    eprintln!(
        "[gvret_tcp] Source {} connected to {}:{}, transmit channel ready",
        source_idx, host, port
    );

    // Wrap write_half in Arc<Mutex> so it can be shared with transmit handling
    let write_half = Arc::new(tokio::sync::Mutex::new(write_half));
    let write_half_for_transmit = write_half.clone();

    // Spawn a dedicated task for handling transmit requests
    // This ensures transmits are processed immediately without waiting for read timeouts
    let stop_flag_for_transmit = stop_flag.clone();
    let transmit_task = tokio::spawn(async move {
        while !stop_flag_for_transmit.load(Ordering::SeqCst) {
            // Check for transmit requests with a short sleep to avoid busy loop
            match transmit_rx.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(req) => {
                    let mut writer = write_half_for_transmit.lock().await;
                    let result = writer
                        .write_all(&req.data)
                        .await
                        .map_err(|e| format!("Write error: {}", e));
                    let _ = writer.flush().await;
                    let _ = req.result_tx.send(result);
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

    // Read loop - now only handles reading, transmit is handled by separate task
    let mut buffer = Vec::with_capacity(4096);
    let mut read_buf = [0u8; 2048];

    while !stop_flag.load(Ordering::SeqCst) {
        // Read with timeout
        match tokio::time::timeout(Duration::from_millis(50), read_half.read(&mut read_buf)).await {
            Ok(Ok(0)) => {
                // Connection closed
                let _ = tx
                    .send(SourceMessage::Ended(source_idx, "disconnected".to_string()))
                    .await;
                return;
            }
            Ok(Ok(n)) => {
                buffer.extend_from_slice(&read_buf[..n]);

                // Parse GVRET frames and apply bus mappings
                let frames = parse_gvret_frames(&mut buffer);
                let mapped_frames = apply_bus_mappings_gvret(frames, &bus_mappings);

                if !mapped_frames.is_empty() {
                    let _ = tx
                        .send(SourceMessage::Frames(source_idx, mapped_frames))
                        .await;
                }
            }
            Ok(Err(e)) => {
                let _ = tx
                    .send(SourceMessage::Error(
                        source_idx,
                        format!("Read error: {}", e),
                    ))
                    .await;
                return;
            }
            Err(_) => {
                // Timeout - continue
            }
        }
    }

    // Abort the transmit task when the read loop exits
    transmit_task.abort();

    let _ = tx
        .send(SourceMessage::Ended(source_idx, "stopped".to_string()))
        .await;
}
