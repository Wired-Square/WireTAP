// ui/crates/wiretap-app/src/io/gvret/tcp.rs
//
// GVRET TCP protocol implementation for streaming CAN data over TCP.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use super::common::{
    absorb_num_buses_reply, decode_mapped, resolve_source_mappings, GvretDeviceInfo,
    NumBusesOutcome, NUMBUSES_TIMEOUT,
};
use crate::io::bus_mapping::{apply_bus_mappings_batch, BusMapping};
use crate::io::error::IoError;
use crate::io::types::{EndReason, SourceMessage, TransmitRequest};
use wiretap_protocol::gvret;

/// Ask a connected device how many buses it has.
///
/// Frames read while waiting are collected into `pending` rather than discarded
/// — a device that is already streaming will interleave them with the reply,
/// and dropping them would lose traffic the session is meant to capture. They
/// are still unmapped: this exchange is what decides the mapping.
///
/// Generic over the halves so the probe, which has a borrowed split rather than
/// an owned one, asks the question the same way the streaming path does.
async fn query_num_buses<W: AsyncWrite + Unpin, R: AsyncRead + Unpin>(
    write_half: &mut W,
    read_half: &mut R,
    decoder: &mut gvret::DeviceDecoder,
    pending: &mut Vec<crate::io::FrameMessage>,
    timeout: Duration,
) -> NumBusesOutcome {
    if let Err(e) = write_half.write_all(&gvret::REQ_NUM_BUSES).await {
        return NumBusesOutcome::Failed(e.to_string());
    }
    let _ = write_half.flush().await;

    let read = async {
        let mut read_buf = [0u8; 2048];
        loop {
            match read_half.read(&mut read_buf).await {
                Ok(0) => return NumBusesOutcome::Closed,
                Err(e) => return NumBusesOutcome::Failed(e.to_string()),
                Ok(n) => {
                    if let Some(count) = absorb_num_buses_reply(decoder, &read_buf[..n], pending) {
                        return NumBusesOutcome::Answered(count);
                    }
                }
            }
        }
    };

    tokio::time::timeout(timeout, read)
        .await
        .unwrap_or(NumBusesOutcome::Silent)
}

// ============================================================================
// Device Probing
// ============================================================================

/// Probe a GVRET TCP device to discover its capabilities
///
/// This function connects to the device, queries the number of available buses,
/// and returns device information. The connection is closed after probing.
///
/// The device label both the probe and the streaming path identify themselves by.
fn gvret_tcp_device(host: &str, port: u16) -> String {
    format!("gvret_tcp({}:{})", host, port)
}

/// Resolve, then connect within `timeout_sec`.
///
/// Resolving separately is what keeps a DNS failure distinguishable from an
/// unreachable host — see [`crate::io::net::resolve_host_port`]. Shared by the probe
/// and the streaming path so the two cannot drift in how they classify or label a
/// connect failure; they previously reported the same failure differently.
async fn connect_gvret_tcp(host: &str, port: u16, timeout_sec: f64) -> Result<TcpStream, IoError> {
    let addr = crate::io::net::resolve_host_port(host, port).await?;

    match tokio::time::timeout(
        Duration::from_secs_f64(timeout_sec),
        TcpStream::connect(addr),
    )
    .await
    {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(e)) => Err(IoError::connection(
            gvret_tcp_device(host, port),
            e.to_string(),
        )),
        Err(_) => Err(IoError::timeout(gvret_tcp_device(host, port), "connect")),
    }
}

/// Returns `IoError` for typed error handling. Use `.map_err(String::from)` if
/// you need a String error for backwards compatibility.
pub async fn probe_gvret_tcp(
    host: &str,
    port: u16,
    timeout_sec: f64,
) -> Result<GvretDeviceInfo, IoError> {
    tlog!(
        "[probe_gvret_tcp] Probing GVRET device at {}:{} (timeout: {}s)",
        host,
        port,
        timeout_sec
    );

    let device = gvret_tcp_device(host, port);

    let mut stream = connect_gvret_tcp(host, port, timeout_sec).await?;
    tlog!("[probe_gvret_tcp] Connected to {}:{}", host, port);

    // Enter binary mode
    stream
        .write_all(&gvret::SYNC)
        .await
        .map_err(|e| IoError::protocol(&device, format!("enable binary mode: {}", e)))?;

    // Wait a moment for the device to process
    tokio::time::sleep(Duration::from_millis(50)).await;

    let read_timeout = Duration::from_millis((timeout_sec * 1000.0) as u64);
    let (mut read_half, mut write_half) = stream.split();
    let mut decoder = gvret::DeviceDecoder::new();
    let outcome = query_num_buses(
        &mut write_half,
        &mut read_half,
        &mut decoder,
        &mut Vec::new(),
        read_timeout,
    )
    .await;

    match outcome {
        NumBusesOutcome::Answered(bus_count) => {
            tlog!(
                "[probe_gvret_tcp] SUCCESS: Device at {}:{} has {} buses available",
                host,
                port,
                bus_count
            );
            Ok(GvretDeviceInfo { bus_count })
        }
        NumBusesOutcome::Failed(e) => Err(IoError::read(&device, e)),
        // A probe reports what it can rather than refusing: a device that never
        // answers is still worth adding as single-bus, which is what the picker
        // has always shown. The streaming path is where the distinction between
        // quiet and dead has to be made, because that is where it costs traffic.
        NumBusesOutcome::Closed | NumBusesOutcome::Silent => {
            tlog!("[probe_gvret_tcp] No NUMBUSES response received, defaulting to 1 bus");
            Ok(GvretDeviceInfo { bus_count: 1 })
        }
    }
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
    let stream = match connect_gvret_tcp(&host, port, timeout_sec).await {
        Ok(stream) => stream,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(source_idx, e.user_message()))
                .await;
            return;
        }
    };

    // Split into read/write halves
    let (mut read_half, mut write_half) = stream.into_split();

    // Enable binary mode
    if let Err(e) = write_half.write_all(&gvret::SYNC).await {
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
    let _ = write_half.write_all(&gvret::REQ_DEV_INFO).await;
    let _ = write_half.flush().await;

    // Ask the device how many buses it has, and keep the answer. The mappings
    // we were handed came off the profile before this connection existed, so
    // they can carry a bus this device does not have — or, expensively, miss
    // one it does. Anything read while waiting is kept: it is frame traffic.
    let mut decoder = gvret::DeviceDecoder::new();
    let mut pending = Vec::new();
    let outcome = query_num_buses(
        &mut write_half,
        &mut read_half,
        &mut decoder,
        &mut pending,
        NUMBUSES_TIMEOUT,
    )
    .await;
    let Some(bus_mappings) = resolve_source_mappings(
        outcome,
        &bus_mappings,
        &gvret_tcp_device(&host, port),
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
        "[gvret_tcp] Source {} connected to {}:{}, transmit channel ready",
        source_idx,
        host,
        port
    );

    // Emit device-connected event
    let address = format!("{}:{}", host, port);
    let _ = tx
        .send(SourceMessage::Connected(
            source_idx,
            "gvret_tcp".to_string(),
            address,
            None,
        ))
        .await;

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

    // Read loop - now only handles reading, transmit is handled by separate task.
    // `decoder` carries over from the NUMBUSES exchange, so a message that
    // straddled the end of it is completed rather than re-read.
    let mut read_buf = [0u8; 2048];

    while !stop_flag.load(Ordering::SeqCst) {
        // Read with timeout
        match tokio::time::timeout(Duration::from_millis(50), read_half.read(&mut read_buf)).await {
            Ok(Ok(0)) => {
                // Connection closed
                let _ = tx
                    .send(SourceMessage::Ended(source_idx, EndReason::Disconnected))
                    .await;
                return;
            }
            Ok(Ok(n)) => {
                let frames = decode_mapped(&mut decoder, &read_buf[..n], &bus_mappings);
                if !frames.is_empty() {
                    let _ = tx.send(SourceMessage::Frames(source_idx, frames)).await;
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
        .send(SourceMessage::Ended(source_idx, EndReason::Stopped))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// Serve one connection, handing it to `serve`, and ask the listener what
    /// `query_num_buses` made of it.
    async fn outcome_against<F, Fut>(serve: F) -> NumBusesOutcome
    where
        F: FnOnce(TcpStream) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.expect("accept");
            serve(sock).await;
        });

        let stream = TcpStream::connect(addr).await.expect("connect");
        let (mut read_half, mut write_half) = stream.into_split();
        query_num_buses(
            &mut write_half,
            &mut read_half,
            &mut gvret::DeviceDecoder::new(),
            &mut Vec::new(),
            NUMBUSES_TIMEOUT,
        )
        .await
    }

    #[tokio::test]
    async fn a_device_that_answers_reports_its_bus_count() {
        let outcome = outcome_against(|mut sock| async move {
            let _ = sock.write_all(&gvret::encode_num_buses(2)).await;
            // Hold the connection open so the reply is not also a close.
            tokio::time::sleep(Duration::from_millis(200)).await;
        })
        .await;
        assert!(
            matches!(outcome, NumBusesOutcome::Answered(2)),
            "got {outcome:?}"
        );
    }

    /// The reported failure: an SSH tunnel accepts locally while nothing serves
    /// the far end, so the peer goes away before any command is answered. This
    /// must not read as a device that ignores GET_NUMBUSES.
    ///
    /// A peer that drops the socket with our command still unread resets it, so
    /// this arrives as an error rather than a clean end-of-stream — the two
    /// halves of "there is no device there" are split across `Failed` and
    /// `Closed` by whether the far end drained us first, not by anything the
    /// user did. Both are immediate and both name the connection.
    #[tokio::test]
    async fn a_peer_that_vanishes_on_connect_is_not_a_silent_device() {
        let outcome = outcome_against(|sock| async move { drop(sock) }).await;
        assert!(
            matches!(outcome, NumBusesOutcome::Failed(_)),
            "got {outcome:?}"
        );
    }

    /// The same situation where the far end reads before hanging up: a clean
    /// end-of-stream rather than a reset.
    #[tokio::test]
    async fn a_peer_that_closes_cleanly_is_not_a_silent_device() {
        let outcome = outcome_against(|mut sock| async move {
            let mut sink = [0u8; 8];
            let _ = sock.read(&mut sink).await;
            let _ = sock.shutdown().await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        })
        .await;
        assert!(
            matches!(outcome, NumBusesOutcome::Closed),
            "got {outcome:?}"
        );
    }

    /// A GVRET-compatible bridge that does not implement GET_NUMBUSES holds the
    /// connection open and says nothing. That is the one case worth waiting for.
    #[tokio::test]
    async fn a_live_but_quiet_link_is_silent_not_closed() {
        let outcome = outcome_against(|sock| async move {
            tokio::time::sleep(NUMBUSES_TIMEOUT + Duration::from_millis(500)).await;
            drop(sock);
        })
        .await;
        assert!(
            matches!(outcome, NumBusesOutcome::Silent),
            "got {outcome:?}"
        );
    }
}
