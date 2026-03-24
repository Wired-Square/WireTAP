// Copyright (c) 2026, Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// FrameLink source reader — subscribes to the shared connection for a device
// and forwards frames matching this source's bus mappings to the merge task.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use super::convert_stream_frame;
use super::shared;
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
    // Bootstrap: connect by address to get device_id
    let device_id = match shared::connect_by_address(&host, port, timeout_sec).await {
        Ok(id) => id,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(source_idx, e))
                .await;
            return;
        }
    };

    let conn = match shared::session_acquire(&device_id, timeout_sec).await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(source_idx, e))
                .await;
            return;
        }
    };

    let mut frame_rx = conn.session.subscribe_frames();

    for mapping in &bus_mappings {
        if mapping.enabled {
            let _ = conn.session.start_stream(mapping.device_bus).await;
        }
    }

    let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
    let _ = tx
        .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
        .await;

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

    let my_interfaces: std::collections::HashSet<u8> = bus_mappings
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.device_bus)
        .collect();

    let mut poll_interval = tokio::time::interval(Duration::from_millis(1));

    loop {
        tokio::select! {
            result = frame_rx.recv() => {
                match result {
                    Ok(sf) => {
                        if !my_interfaces.contains(&sf.iface_index) {
                            continue;
                        }
                        if let Some(msg) =
                            convert_stream_frame(&sf, &bus_mappings, &conn.iface_types)
                        {
                            let _ = tx
                                .send(SourceMessage::Frames(source_idx, vec![msg]))
                                .await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tlog!("[framelink] Source {} lagged {} frames", source_idx, n);
                    }
                    Err(_) => {
                        let _ = tx
                            .send(SourceMessage::Ended(
                                source_idx,
                                "disconnected".to_string(),
                            ))
                            .await;
                        shared::session_release(&device_id).await;
                        return;
                    }
                }
            }
            _ = poll_interval.tick() => {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                while let Ok(req) = transmit_rx.try_recv() {
                    let result = conn
                        .session
                        .transmit(&req.data)
                        .await
                        .map_err(|e| e.to_string());
                    let _ = req.result_tx.send(result);
                }
            }
        }
    }

    shared::session_release(&device_id).await;
    let _ = tx
        .send(SourceMessage::Ended(source_idx, "stopped".to_string()))
        .await;
}
