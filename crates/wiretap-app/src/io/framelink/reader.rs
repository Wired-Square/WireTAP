// Copyright (c) 2026, Wired Square Pty Ltd
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
use framelink::protocol::types::{IFACE_CAN, IFACE_CANFD, IFACE_RS232, IFACE_RS485};

use crate::io::error::IoError;
use crate::io::bus_mapping::BusMapping;
use crate::io::types::{EndReason, SourceMessage, TransmitRequest};
use crate::io::Protocol;

/// Frames buffered before a flush, independent of the 1 ms tick.
const MAX_PENDING_FRAMES: usize = 256;

/// How long to wait for the device to acknowledge STREAM_STOP on teardown.
const STOP_STREAM_TIMEOUT: Duration = Duration::from_millis(500);

/// Run a FrameLink source reader for a single interface (or set of interfaces).
///
/// Acquires the shared connection for the device (creating it if this is the
/// first source), receives stream frames, and forwards those that match this
/// source's bus mappings to the merge task.
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

    // The lease lives as long as this reader; dropping it starts the pool's
    // idle linger, which is what finally closes the socket.
    let conn = match shared::get_connection(&device_id, timeout_sec).await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx
                .send(SourceMessage::Error(source_idx, e))
                .await;
            return;
        }
    };

    // The mappings handed to us were built before any connection existed, from
    // an `interfaces[]` array the profile may never have been given. Reconcile
    // against what the device actually reports, and tell the broker, so
    // `available_buses` and transmit routing agree with what we stream.
    let bus_mappings = reconcile_bus_mappings(&bus_mappings, &conn.iface_types);
    let _ = tx
        .send(SourceMessage::MappingsResolved(
            source_idx,
            bus_mappings.clone(),
        ))
        .await;

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

    // Frames are accumulated and flushed on the tick below rather than sent one
    // at a time. The device batches its FRAME_RX messages and the library hands
    // them over individually, so a per-frame send would allocate a Vec, wake the
    // merge task and take a channel slot thousands of times a second — every
    // other high-rate driver flushes once per read. The merge task only emits
    // every 50 ms, so this costs no latency.
    let mut pending: Vec<crate::io::FrameMessage> = Vec::new();
    let mut poll_interval = tokio::time::interval(Duration::from_millis(1));

    loop {
        tokio::select! {
            result = conn.session.recv_stream_frame() => {
                match result {
                    Some(sf) => {
                        if !my_interfaces.contains(&sf.iface_index) {
                            continue;
                        }
                        if let Some(msg) =
                            convert_stream_frame(&sf, &bus_mappings, &conn.iface_types)
                        {
                            pending.push(msg);
                            if pending.len() >= MAX_PENDING_FRAMES {
                                let _ = tx
                                    .send(SourceMessage::Frames(source_idx, std::mem::take(&mut pending)))
                                    .await;
                            }
                        }
                    }
                    None => {
                        // An unasked-for close is a fault, not an ending. Ended
                        // reaches the merge task and stops there, so reporting
                        // one here meant a device that dropped mid-session was
                        // invisible until every other source had gone too.
                        let _ = tx
                            .send(SourceMessage::Error(
                                source_idx,
                                IoError::DeviceDisconnected { device: device_id.clone() }
                                    .user_message(),
                            ))
                            .await;
                        return;
                    }
                }
            }
            _ = poll_interval.tick() => {
                if !pending.is_empty() {
                    let _ = tx
                        .send(SourceMessage::Frames(source_idx, std::mem::take(&mut pending)))
                        .await;
                }
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

    if !pending.is_empty() {
        let _ = tx
            .send(SourceMessage::Frames(source_idx, pending))
            .await;
    }

    // Tell the device to stop sending before letting go: the connection may
    // linger for another consumer, and nothing here would read those frames.
    // Bounded, because STREAM_STOP is sent without an ACK flag and the library
    // still waits out its 15s command timeout for a reply that never comes —
    // unbounded, that would stall session stop by 15s per interface.
    for iface in &my_interfaces {
        let _ = tokio::time::timeout(STOP_STREAM_TIMEOUT, conn.session.stop_stream(*iface)).await;
    }

    let _ = tx
        .send(SourceMessage::Ended(source_idx, EndReason::Stopped))
        .await;
}
/// Build the bus mappings a session actually streams, from the interfaces the
/// device reports plus whatever the profile has to say about them.
///
/// `create_default_bus_mapping` runs before a connection exists, so it can only
/// read the profile's `interfaces[]` — an array the frontend populates from a
/// probe. When that probe never succeeded the array is absent and the mapping
/// falls back to a single hardcoded `can0`, which is how a two-interface device
/// came up with one CAN bus. The device is the authority on which interfaces
/// exist; the profile only says what to do with them.
fn reconcile_bus_mappings(
    profile_mappings: &[BusMapping],
    iface_types: &std::collections::HashMap<u8, u8>,
) -> Vec<BusMapping> {
    // Nothing to reconcile against — the device told us nothing, so honour the
    // profile as-is rather than silently streaming nothing.
    if iface_types.is_empty() {
        return profile_mappings.to_vec();
    }

    let mut indices: Vec<u8> = iface_types.keys().copied().collect();
    indices.sort_unstable();

    indices
        .into_iter()
        .enumerate()
        .map(|(slot, device_bus)| {
            let iface_type = iface_types.get(&device_bus).copied().unwrap_or(IFACE_CAN);
            let protocol = protocol_for_iface_type(iface_type);
            let override_for = profile_mappings.iter().find(|m| m.device_bus == device_bus);
            BusMapping {
                device_bus,
                // An interface the profile has never heard of streams by default;
                // one it has been told to mute stays muted.
                enabled: override_for.map(|m| m.enabled).unwrap_or(true),
                output_bus: override_for
                    .map(|m| m.output_bus)
                    .unwrap_or(slot as u8),
                interface_id: interface_id_for(device_bus, iface_type),
                // The device's interface type wins over anything the profile or
                // the picker said — an RS485 port cannot be talked into CAN.
                supported_protocols: vec![protocol],
                ..BusMapping::default().with_protocol(protocol)
            }
        })
        .collect()
}

/// `can0` / `serial1` — the identifier shape the session picker displays.
fn interface_id_for(index: u8, iface_type: u8) -> String {
    match iface_type {
        IFACE_RS485 | IFACE_RS232 => format!("serial{index}"),
        _ => format!("can{index}"),
    }
}

/// The protocol a FrameLink interface type carries. The device reports the type,
/// so this is not a choice the session gets to make.
///
/// Shared with `sessions::framelink_bus_mapping`, which reads the same types out
/// of the saved profile: the two disagreeing is how an RS232 port came up as a
/// CAN bus before the profile side had the named constants to hand.
pub fn protocol_for_iface_type(iface_type: u8) -> Protocol {
    match iface_type {
        IFACE_RS485 | IFACE_RS232 => Protocol::Serial,
        IFACE_CANFD => Protocol::CanFd,
        _ => Protocol::Can,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn mapping(device_bus: u8, enabled: bool, output_bus: u8) -> BusMapping {
        BusMapping {
            device_bus,
            enabled,
            output_bus,
            interface_id: String::new(),
            traits: None,
            ..BusMapping::default()
        }
    }

    /// The case this whole change exists for: a profile whose probe never ran
    /// carries one hardcoded can0, and the device has two interfaces.
    #[test]
    fn a_device_interface_the_profile_never_saw_still_streams() {
        let iface_types = HashMap::from([(0u8, IFACE_CAN), (1u8, IFACE_CAN)]);
        let mappings = reconcile_bus_mappings(&[mapping(0, true, 0)], &iface_types);

        assert_eq!(mappings.len(), 2, "both device interfaces should be mapped");
        assert!(mappings.iter().all(|m| m.enabled));
        assert_eq!(mappings[1].device_bus, 1);
        assert_eq!(mappings[1].interface_id, "can1");
    }

    #[test]
    fn the_profile_still_decides_enabled_and_output_bus() {
        let iface_types = HashMap::from([(0u8, IFACE_CAN), (1u8, IFACE_CAN)]);
        let mappings =
            reconcile_bus_mappings(&[mapping(0, false, 7), mapping(1, true, 9)], &iface_types);

        assert!(!mappings[0].enabled, "a muted interface stays muted");
        assert_eq!(mappings[0].output_bus, 7);
        assert_eq!(mappings[1].output_bus, 9);
    }

    #[test]
    fn an_interface_the_device_does_not_have_is_dropped() {
        let iface_types = HashMap::from([(0u8, IFACE_CAN)]);
        let mappings =
            reconcile_bus_mappings(&[mapping(0, true, 0), mapping(3, true, 3)], &iface_types);

        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].device_bus, 0);
    }

    /// An RS-485 interface must come back as a serial bus, not a CAN one, or the
    /// session advertises the wrong protocol for it.
    #[test]
    fn interface_type_decides_the_id_and_traits() {
        let iface_types = HashMap::from([(0u8, IFACE_CAN), (1u8, IFACE_RS485)]);
        let mappings = reconcile_bus_mappings(&[], &iface_types);

        assert_eq!(mappings[1].interface_id, "serial1");
        let traits = mappings[1].traits.as_ref().unwrap();
        assert_eq!(traits.protocols, vec![Protocol::Serial]);
        assert!(traits.tx_bytes && !traits.tx_frames);
    }

    /// A device that reported nothing must not silently zero the session.
    #[test]
    fn no_device_interfaces_leaves_the_profile_alone() {
        let mappings = reconcile_bus_mappings(&[mapping(2, true, 5)], &HashMap::new());
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].device_bus, 2);
        assert_eq!(mappings[0].output_bus, 5);
    }
}
