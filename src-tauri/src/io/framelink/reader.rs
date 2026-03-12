// io/framelink/reader.rs
//
// FrameLink source reader — subscribes to the shared connection for a device
// and forwards frames matching this source's bus mappings to the merge task.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;

use framelink::protocol::stream::parse_frame_rx;
use tokio::sync::mpsc;

use super::convert_stream_frame;
use super::shared::{self, ConnCommand};
use crate::io::gvret::BusMapping;
use crate::io::types::{SourceMessage, TransmitRequest};

/// Run a FrameLink source reader for a single interface (or set of interfaces).
///
/// Acquires the shared connection for the device (creating it if this is the
/// first source), subscribes to the frame broadcast, and forwards frames that
/// match this source's bus mappings to the merge task.
pub async fn run_source(
    source_idx: usize,
    host: String,
    port: u16,
    timeout_sec: f64,
    bus_mappings: Vec<BusMapping>,
    stop_flag: Arc<AtomicBool>,
    tx: mpsc::Sender<SourceMessage>,
) {
    // Acquire shared connection (creates if first, reuses if exists)
    let conn = match shared::session_acquire(&host, port, timeout_sec).await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(source_idx, e))
                .await;
            return;
        }
    };

    // Subscribe to frame broadcast
    let mut frame_rx = conn.frame_tx.subscribe();

    // Request stream start for our interfaces
    for mapping in &bus_mappings {
        if mapping.enabled {
            let _ = conn
                .cmd_tx
                .send(ConnCommand::StartStream(mapping.device_bus))
                .await;
        }
    }

    // Create transmit channel
    let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
    let _ = tx
        .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
        .await;

    // Send Connected
    let _ = tx
        .send(SourceMessage::Connected(
            source_idx,
            "framelink".to_string(),
            format!("{}:{}", host, port),
            None,
        ))
        .await;

    tlog!(
        "[framelink] Source {} using shared connection to {}:{}, {} bus mappings",
        source_idx,
        host,
        port,
        bus_mappings.len()
    );

    // Build a set of interface indices this source cares about for fast filtering
    let my_interfaces: std::collections::HashSet<u8> = bus_mappings
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.device_bus)
        .collect();

    // Main loop
    loop {
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }

        // Drain pending transmit requests (non-blocking)
        while let Ok(req) = transmit_rx.try_recv() {
            let _ = conn
                .cmd_tx
                .send(ConnCommand::Transmit {
                    data: req.data,
                    result_tx: req.result_tx,
                })
                .await;
        }

        // Receive broadcast frames, filtered by our interface set
        match tokio::time::timeout(Duration::from_millis(1), frame_rx.recv()).await {
            Ok(Ok(bf)) => {
                // Skip frames for interfaces we don't handle
                if !my_interfaces.contains(&bf.iface_index) {
                    continue;
                }
                // Re-parse from raw payload and convert to WireTAP frame
                if let Ok(sf) = parse_frame_rx(&bf.payload) {
                    if let Some(msg) =
                        convert_stream_frame(&sf, &bus_mappings, &conn.iface_types)
                    {
                        let _ = tx
                            .send(SourceMessage::Frames(source_idx, vec![msg]))
                            .await;
                    }
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                tlog!("[framelink] Source {} lagged {} frames", source_idx, n);
            }
            Ok(Err(_)) => {
                // Sender dropped — connection lost
                let _ = tx
                    .send(SourceMessage::Ended(
                        source_idx,
                        "disconnected".to_string(),
                    ))
                    .await;
                shared::session_release(&host, port).await;
                return;
            }
            Err(_) => {} // timeout — loop again
        }
    }

    // Release session reference (idle timeout handles cleanup)
    shared::session_release(&host, port).await;
    let _ = tx
        .send(SourceMessage::Ended(source_idx, "stopped".to_string()))
        .await;
}
