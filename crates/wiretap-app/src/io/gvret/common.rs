// ui/crates/wiretap-app/src/io/gvret/common.rs
//
// The GVRET driver's half of the protocol: everything that is a session
// concern rather than a wire concern.
//
// The wire itself is `wiretap_protocol::gvret`, shared with WireTAP-Server,
// which speaks the device end of the same protocol. What is left here is bus
// mapping, the enumeration policy, and the adapter from the codec's scalars to
// `FrameMessage`.

use std::time::Duration;

use wiretap_protocol::gvret::{self, DeviceMessage};

use crate::io::bus_mapping::{apply_bus_mapping, gvret_protocols, BusMapping};
use crate::io::types::SourceMessage;
use crate::io::{now_us, CanTransmitFrame, FrameMessage, TransmitResult};

// ============================================================================
// Constants
// ============================================================================

/// Most CAN buses a GVRET device reports. The NUMBUSES sanity check and any
/// bus list synthesised from a bare count share this bound.
pub const MAX_BUSES: u8 = 5;

// ============================================================================
// Codec Adapters
// ============================================================================

/// Turn a decoded frame into a `FrameMessage`, or `None` for anything else the
/// device said.
///
/// The device's own timestamp is discarded for the host clock: it counts from
/// the connection rather than from an epoch and wraps every 71 minutes, so it
/// cannot be compared with a frame from any other source. The cost is that
/// inter-frame timing is limited by host scheduling rather than by the adapter.
///
/// GVRET has no CAN FD flag, so FD is inferred from the payload length — the
/// only thing that distinguishes the two.
pub fn frame_from(msg: DeviceMessage) -> Option<FrameMessage> {
    let DeviceMessage::Frame {
        bus,
        arb_id,
        extended,
        data,
        ..
    } = msg
    else {
        return None;
    };
    Some(FrameMessage {
        protocol: "can".to_string(),
        timestamp_us: now_us(),
        frame_id: arb_id,
        bus,
        dlc: data.len() as u8,
        is_fd: data.len() > 8,
        bytes: data,
        is_extended: extended,
        source_address: None,
        incomplete: None,
        direction: None, // Received frames don't have direction set
    })
}

/// What to believe about a bus count a device reported.
///
/// The protocol puts no bound on the field, and a bridge that does not really
/// implement `GET_NUMBUSES` can answer with anything. An implausible count is
/// read as "as many as a GVRET device has" rather than as a fact, which is the
/// same answer as before and is policy rather than protocol.
pub fn clamp_bus_count(reported: u8) -> u8 {
    if reported == 0 || reported > MAX_BUSES {
        MAX_BUSES
    } else {
        reported
    }
}

/// Feed a read into `decoder` while enumerating, appending every frame it
/// completed to `pending` and answering with the bus count if the reply was
/// among them.
///
/// Frames are kept rather than discarded: a device that is already streaming
/// interleaves them with the reply, and dropping them would lose traffic the
/// session is meant to capture. They stay unmapped because the enumeration is
/// what decides the mapping — the caller maps `pending` once it has one.
///
/// Both transports enumerate through the decoder they go on to stream with, so
/// a message straddling the end of the probe is not seen twice or lost.
pub fn absorb_num_buses_reply(
    decoder: &mut gvret::DeviceDecoder,
    chunk: &[u8],
    pending: &mut Vec<FrameMessage>,
) -> Option<u8> {
    let mut count = None;
    for msg in decoder.feed(chunk) {
        match msg {
            DeviceMessage::NumBuses(n) => count = count.or(Some(clamp_bus_count(n))),
            other => pending.extend(frame_from(other)),
        }
    }
    count
}

/// Decode a read and apply the session's bus mappings — the streaming loop of
/// both transports, so they cannot drift in what they do with a frame.
pub fn decode_mapped(
    decoder: &mut gvret::DeviceDecoder,
    chunk: &[u8],
    mappings: &[BusMapping],
) -> Vec<FrameMessage> {
    decoder
        .feed(chunk)
        .into_iter()
        .filter_map(frame_from)
        .filter_map(|mut f| apply_bus_mapping(&mut f, mappings).then_some(f))
        .collect()
}

// ============================================================================
// Device Info Types
// ============================================================================

/// Information about a GVRET device, obtained by probing
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GvretDeviceInfo {
    /// Number of CAN buses available on this device (1-5)
    pub bus_count: u8,
}

/// Build the bus mappings a session actually streams, from the bus count the
/// device reported plus whatever the profile has to say about them.
///
/// The GVRET counterpart of FrameLink's `reconcile_bus_mappings`: GVRET reports
/// a *count* rather than an interface list, so device buses are `0..count`. The
/// same rule applies either way — the device decides which buses exist, the
/// profile only decides which to stream and where they land.
///
/// Only ever called with a count the device reported, which
/// [`parse_numbuses_response`] clamps to `1..=MAX_BUSES`. "The device told us
/// nothing" is not spelled as a count here — it is [`NumBusesOutcome::Silent`],
/// and the decision to honour the profile lives in `mappings_from_num_buses`.
fn reconcile_to_bus_count(profile_mappings: &[BusMapping], bus_count: u8) -> Vec<BusMapping> {
    (0..bus_count)
        .enumerate()
        .map(|(slot, device_bus)| {
            let override_for = profile_mappings.iter().find(|m| m.device_bus == device_bus);
            BusMapping {
                device_bus,
                // A bus the profile has never heard of streams by default; one
                // it has been told to mute stays muted.
                enabled: override_for.map(|m| m.enabled).unwrap_or(true),
                output_bus: override_for.map(|m| m.output_bus).unwrap_or(slot as u8),
                interface_id: override_for
                    .map(|m| m.interface_id.clone())
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| format!("can{}", device_bus)),
                supported_protocols: gvret_protocols(),
                // The protocol is the session's to choose, not the device's —
                // GVRET reports a bus *count* and says nothing about FD. So it
                // survives the reconcile, and the traits follow from it.
                ..BusMapping::default()
                    .with_protocol(override_for.map(|m| m.protocol).unwrap_or_default())
            }
        })
        .collect()
}

/// How long a streaming reader waits for the device to answer GET_NUMBUSES.
/// Shared, so the two transports cannot drift in how patient they are.
pub const NUMBUSES_TIMEOUT: Duration = Duration::from_millis(1500);

/// What happened when we asked a device how many buses it has.
///
/// Kept as four cases rather than an `Option` because they call for different
/// answers: a link that is up but quiet is a device we can still stream, while a
/// link that closed or errored is not a device at all. Collapsing them is what
/// let a dead endpoint be reported as a device that ignores a command.
#[derive(Debug)]
pub enum NumBusesOutcome {
    Answered(u8),
    /// The peer closed the connection before answering.
    Closed,
    /// The link errored while we asked or waited.
    Failed(String),
    /// The link stayed up, and nothing arrived in time.
    Silent,
}

/// Resolve the bus mappings a source should stream from an enumeration attempt,
/// or the error that should fail it.
///
/// One policy for both transports. A device that simply did not answer keeps the
/// profile's mappings — the same rule FrameLink follows when a device reports no
/// interfaces, though it still states that separately in its own reader — because
/// a GVRET-compatible bridge need not implement `GET_NUMBUSES` to be worth
/// streaming. A connection that closed or errored is
/// fatal, and says which of the two happened: naming one cause for every
/// condition sends a network fault to the firmware.
pub fn mappings_from_num_buses(
    outcome: NumBusesOutcome,
    profile_mappings: &[BusMapping],
    label: &str,
) -> Result<Vec<BusMapping>, String> {
    match outcome {
        NumBusesOutcome::Answered(count) => Ok(reconcile_to_bus_count(profile_mappings, count)),
        NumBusesOutcome::Silent => {
            tlog!(
                "[gvret] {} did not answer GET_NUMBUSES within {:?} — streaming the {} bus(es) the profile declares",
                label,
                NUMBUSES_TIMEOUT,
                profile_mappings.len()
            );
            Ok(profile_mappings.to_vec())
        }
        NumBusesOutcome::Closed => Err(format!(
            "{} closed the connection before answering GET_NUMBUSES — check that a GVRET server is listening there",
            label
        )),
        NumBusesOutcome::Failed(e) => Err(format!(
            "{} connection error while asking GET_NUMBUSES: {}",
            label, e
        )),
    }
}

/// Settle a source's bus mappings from an enumeration attempt and tell the
/// broker, or report the failure that ends the source.
///
/// `None` means the caller should return. Both transports go through here so the
/// announce cannot be forgotten in one of them — `MappingsResolved` is what feeds
/// `available_buses` and transmit routing, so a source that streams without
/// sending it looks single-bus to everything downstream.
pub async fn resolve_source_mappings(
    outcome: NumBusesOutcome,
    profile_mappings: &[BusMapping],
    label: &str,
    source_idx: usize,
    tx: &tokio::sync::mpsc::Sender<SourceMessage>,
) -> Option<Vec<BusMapping>> {
    match mappings_from_num_buses(outcome, profile_mappings, label) {
        Ok(mappings) => {
            let _ = tx
                .send(SourceMessage::MappingsResolved(
                    source_idx,
                    mappings.clone(),
                ))
                .await;
            Some(mappings)
        }
        Err(e) => {
            let _ = tx.send(SourceMessage::Error(source_idx, e)).await;
            None
        }
    }
}

// ============================================================================
// Frame Validation
// ============================================================================

/// Validate a CAN frame for GVRET transmission
///
/// Returns Ok(()) if valid, or an error TransmitResult if invalid.
pub fn validate_gvret_frame(frame: &CanTransmitFrame) -> Result<(), TransmitResult> {
    // Validate data length
    if !frame.is_fd && frame.data.len() > 8 {
        return Err(TransmitResult::error(format!(
            "Classic CAN frame data too long: {} bytes (max 8)",
            frame.data.len()
        )));
    }

    if frame.is_fd && frame.data.len() > 64 {
        return Err(TransmitResult::error(format!(
            "CAN FD frame data too long: {} bytes (max 64)",
            frame.data.len()
        )));
    }

    // Validate bus number (GVRET supports buses 0-4)
    if frame.bus > 4 {
        return Err(TransmitResult::error(format!(
            "Invalid bus number: {} (valid: 0-4)",
            frame.bus
        )));
    }

    Ok(())
}

// ============================================================================
// Stream Helpers
// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_validate_classic_can_too_long() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0; 9], // 9 bytes - too long for classic CAN
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let result = validate_gvret_frame(&frame);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_canfd_too_long() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0; 65], // 65 bytes - too long for CAN FD
            bus: 0,
            is_extended: false,
            is_fd: true,
            is_brs: false,
            is_rtr: false,
        };

        let result = validate_gvret_frame(&frame);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_invalid_bus() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0x11],
            bus: 5, // Invalid - max is 4
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let result = validate_gvret_frame(&frame);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_valid_frame() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0x11, 0x22, 0x33, 0x44],
            bus: 2,
            is_extended: false,
            is_fd: false,
            is_brs: false,
            is_rtr: false,
        };

        let result = validate_gvret_frame(&frame);
        assert!(result.is_ok());
    }

    fn reconcile_mapping(device_bus: u8, enabled: bool, output_bus: u8) -> BusMapping {
        BusMapping {
            device_bus,
            enabled,
            output_bus,
            interface_id: String::new(),
            traits: None,
            ..BusMapping::default()
        }
    }

    /// The case this exists for: the profile was never probed and carries one
    /// bus 0, while the device in front of us has two.
    #[test]
    fn a_device_bus_the_profile_never_saw_still_streams() {
        let mappings = reconcile_to_bus_count(&[reconcile_mapping(0, true, 0)], 2);
        assert_eq!(mappings.len(), 2);
        assert!(mappings.iter().all(|m| m.enabled));
        assert_eq!(mappings[1].device_bus, 1);
        assert_eq!(mappings[1].interface_id, "can1");
    }

    #[test]
    fn the_profile_still_decides_enabled_and_output_bus() {
        let mappings = reconcile_to_bus_count(
            &[
                reconcile_mapping(0, false, 7),
                reconcile_mapping(1, true, 9),
            ],
            2,
        );
        assert!(!mappings[0].enabled, "a muted bus stays muted");
        assert_eq!(mappings[0].output_bus, 7);
        assert_eq!(mappings[1].output_bus, 9);
    }

    #[test]
    fn a_bus_the_device_does_not_have_is_dropped() {
        let mappings = reconcile_to_bus_count(
            &[reconcile_mapping(0, true, 0), reconcile_mapping(3, true, 3)],
            1,
        );
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].device_bus, 0);
    }

    /// A profile carrying a bus the device would never synthesise, so honouring
    /// it is distinguishable from reconciling against a count.
    fn resolve(outcome: NumBusesOutcome) -> Result<Vec<BusMapping>, String> {
        let profile = [reconcile_mapping(2, true, 5)];
        mappings_from_num_buses(outcome, &profile, "gvret_tcp(10.0.0.9:23)")
    }

    #[test]
    fn an_answered_enumeration_reconciles_to_the_reported_count() {
        let mappings = resolve(NumBusesOutcome::Answered(2)).expect("should stream");
        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[1].device_bus, 1);
    }

    /// A live link that simply did not answer is still a device worth streaming
    /// — a GVRET-compatible bridge need not implement GET_NUMBUSES.
    #[test]
    fn a_silent_device_keeps_the_profiles_buses() {
        let mappings = resolve(NumBusesOutcome::Silent).expect("should stream");
        assert_eq!(mappings.len(), 1);
        // A synthesised mapping would be bus 0; only the profile has bus 2.
        assert_eq!(mappings[0].device_bus, 2);
        assert_eq!(mappings[0].output_bus, 5);
    }

    /// The distinction the collapsed diagnostic used to lose: a closed socket is
    /// not a device that ignores a command.
    #[test]
    fn a_closed_connection_fails_and_says_so() {
        let err = resolve(NumBusesOutcome::Closed).expect_err("should fail the source");
        assert!(err.contains("closed the connection"), "got: {err}");
        assert!(err.contains("10.0.0.9:23"), "should name it: {err}");
    }

    #[test]
    fn a_link_error_fails_and_carries_the_cause() {
        let err = resolve(NumBusesOutcome::Failed("connection reset by peer".into()))
            .expect_err("should fail the source");
        assert!(err.contains("connection reset by peer"), "got: {err}");
    }
    // --- codec adapters ----------------------------------------------------

    fn wire(arb: u32, extended: bool, bus: u8, data: &[u8], fd: bool) -> Vec<u8> {
        gvret::encode_frame(0x1234, arb, extended, bus, data, fd)
    }

    #[test]
    fn a_decoded_frame_becomes_a_frame_message() {
        let msgs = gvret::DeviceDecoder::new().feed(&wire(0x123, false, 2, &[1, 2, 3, 4], false));
        let f = frame_from(msgs.into_iter().next().expect("a message")).expect("a frame");
        assert_eq!((f.frame_id, f.bus, f.dlc), (0x123, 2, 4));
        assert_eq!(f.bytes, vec![1, 2, 3, 4]);
        assert!(!f.is_extended && !f.is_fd);
        assert_eq!(f.protocol, "can");
    }

    #[test]
    fn an_extended_frame_keeps_its_id_without_the_flag_bit() {
        let msgs = gvret::DeviceDecoder::new().feed(&wire(0x12345678, true, 0, &[0xAA], false));
        let f = frame_from(msgs.into_iter().next().unwrap()).expect("a frame");
        assert_eq!(f.frame_id, 0x12345678);
        assert!(f.is_extended);
    }

    /// GVRET carries no FD flag, so the payload length is the only evidence —
    /// and `dlc` here is the length, not the code the wire carried.
    #[test]
    fn fd_is_inferred_from_the_payload_length() {
        let msgs = gvret::DeviceDecoder::new().feed(&wire(0x100, false, 0, &[0xAB; 32], true));
        let f = frame_from(msgs.into_iter().next().unwrap()).expect("a frame");
        assert!(f.is_fd);
        assert_eq!(f.dlc, 32, "the length, not code 13");
        assert_eq!(f.bytes.len(), 32);
    }

    #[test]
    fn a_control_reply_is_not_a_frame() {
        for msg in gvret::DeviceDecoder::new().feed(&gvret::encode_keepalive()) {
            assert!(frame_from(msg).is_none());
        }
    }

    #[test]
    fn a_reported_bus_count_is_clamped_to_what_a_device_can_have() {
        assert_eq!(clamp_bus_count(3), 3);
        assert_eq!(clamp_bus_count(0), MAX_BUSES);
        assert_eq!(clamp_bus_count(16), MAX_BUSES);
    }

    /// Frames that arrive while the device is being enumerated are traffic the
    /// session is meant to capture, not noise to drop on the way past.
    #[test]
    fn enumeration_keeps_the_frames_that_arrive_with_the_reply() {
        let mut wire_bytes = wire(0x123, false, 0, &[1], false);
        wire_bytes.extend(gvret::encode_num_buses(2));
        wire_bytes.extend(wire(0x124, false, 0, &[2], false));

        let mut decoder = gvret::DeviceDecoder::new();
        let mut pending = Vec::new();
        assert_eq!(
            absorb_num_buses_reply(&mut decoder, &wire_bytes, &mut pending),
            Some(2)
        );
        assert_eq!(pending.len(), 2, "both frames, either side of the reply");
        assert_eq!(pending[1].frame_id, 0x124);
    }

    /// The decoder carries over from enumeration into streaming, so a message
    /// split across that boundary is neither lost nor seen twice.
    #[test]
    fn a_message_straddling_the_end_of_the_probe_survives_it() {
        let bytes = wire(0x321, false, 0, &[9], false);
        let (first, rest) = bytes.split_at(5);

        let mut decoder = gvret::DeviceDecoder::new();
        let mut pending = Vec::new();
        assert_eq!(
            absorb_num_buses_reply(&mut decoder, first, &mut pending),
            None
        );
        assert!(pending.is_empty());

        let frames = decode_mapped(&mut decoder, rest, &[]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].frame_id, 0x321);
    }

    #[test]
    fn streaming_applies_the_bus_mappings() {
        let mappings = [
            reconcile_mapping(0, true, 7),
            reconcile_mapping(1, false, 1),
        ];
        let mut bytes = wire(0x100, false, 0, &[1], false);
        bytes.extend(wire(0x200, false, 1, &[2], false));

        let frames = decode_mapped(&mut gvret::DeviceDecoder::new(), &bytes, &mappings);
        assert_eq!(frames.len(), 1, "the muted bus is dropped");
        assert_eq!(frames[0].bus, 7, "and the other is renumbered");
    }
}
