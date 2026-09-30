// ui/crates/wiretap-app/src/io/gvret/common.rs
//
// The GVRET driver's half of the protocol: everything that is a session
// concern rather than a wire concern.
//
// The wire itself is `wiretap_protocol::gvret`, shared with WireTAP-Server,
// which speaks the device end of the same protocol. What is left here is bus
// mapping and the enumeration policy.

use std::time::Duration;

use wiretap_io::can::{CanError, CanEvent, DeviceInfo};

use crate::io::bus_mapping::{gvret_protocols, BusMapping};
use crate::io::can_task::{mapped_frames, open_failed};
use crate::io::types::SourceMessage;

// ============================================================================
// Constants
// ============================================================================

/// Most CAN buses a GVRET device reports. The NUMBUSES sanity check and any
/// bus list synthesised from a bare count share this bound.
pub const MAX_BUSES: u8 = 5;

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

// ============================================================================
// Device Info Types
// ============================================================================

/// Information about a GVRET device, obtained by probing
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GvretDeviceInfo {
    /// Number of CAN buses available on this device (1-5)
    pub bus_count: u8,
}

/// A probe reports what it can rather than refusing: a device that stays silent
/// or hangs up is still worth adding as single-bus, which is what the picker has
/// always shown. A link that never came up is a failure.
pub fn probed_bus_count(probed: Result<DeviceInfo, CanError>) -> Result<GvretDeviceInfo, CanError> {
    let bus_count = match probed {
        Ok(info) => info.buses.map_or(1, clamp_bus_count),
        Err(CanError::Closed) => 1,
        Err(e) => return Err(e),
    };
    Ok(GvretDeviceInfo { bus_count })
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

/// How long a source waits for GET_NUMBUSES: `GvretOptions::probe_timeout`'s default.
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

/// A link lost during the handshake reads as it did when the desktop asked
/// GET_NUMBUSES itself.
pub fn handshake_failed(device: &str, error: CanError) -> String {
    let outcome = match error {
        CanError::Closed => NumBusesOutcome::Closed,
        CanError::Read(e) => NumBusesOutcome::Failed(e.to_string()),
        other => return open_failed(device, other),
    };
    mappings_from_num_buses(outcome, &[], device)
        .err()
        .unwrap_or_default()
}

/// A GVRET source on either link, as the broker sees it.
pub struct Stream {
    source_idx: usize,
    kind: &'static str,
    device: String,
    address: String,
    profile_mappings: Vec<BusMapping>,
    mappings: Vec<BusMapping>,
}

impl Stream {
    pub fn new(
        source_idx: usize,
        kind: &'static str,
        device: String,
        address: String,
        bus_mappings: Vec<BusMapping>,
    ) -> Self {
        Self {
            source_idx,
            kind,
            device,
            address,
            mappings: bus_mappings.clone(),
            profile_mappings: bus_mappings,
        }
    }

    /// What the broker is told of `event`, or the loss that ends the source.
    ///
    /// Every connect re-resolves the mappings from the bus count, since
    /// `MappingsResolved` is what feeds `available_buses` and transmit routing.
    pub fn on_event(&mut self, event: CanEvent) -> Result<Vec<SourceMessage>, CanError> {
        match event {
            CanEvent::Connected(info) => {
                if !info.keepalive {
                    tlog!(
                        "[gvret] {} does not answer keepalives, so a silent drop will not be seen",
                        self.device
                    );
                }
                let outcome = info.buses.map_or(NumBusesOutcome::Silent, |n| {
                    NumBusesOutcome::Answered(clamp_bus_count(n))
                });
                if let Ok(mappings) =
                    mappings_from_num_buses(outcome, &self.profile_mappings, &self.device)
                {
                    self.mappings = mappings;
                }
                Ok(vec![
                    SourceMessage::MappingsResolved(self.source_idx, self.mappings.clone()),
                    SourceMessage::Connected(
                        self.source_idx,
                        self.kind.to_string(),
                        self.address.clone(),
                        None,
                    ),
                ])
            }
            CanEvent::Read(reads) => Ok(mapped_frames(self.source_idx, reads, &self.mappings)
                .into_iter()
                .collect()),
            CanEvent::Disconnected { error, .. } => Err(error),
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;
    use wiretap_io::can::{CanFrame, CanRead, Direction, TransportError};

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
    #[test]
    fn a_reported_bus_count_is_clamped_to_what_a_device_can_have() {
        assert_eq!(clamp_bus_count(3), 3);
        assert_eq!(clamp_bus_count(0), MAX_BUSES);
        assert_eq!(clamp_bus_count(16), MAX_BUSES);
    }

    fn probed(buses: Option<u8>) -> Result<DeviceInfo, CanError> {
        let mut info = DeviceInfo::default();
        info.buses = buses;
        Ok(info)
    }

    fn bus_count(probed: Result<DeviceInfo, CanError>) -> Option<u8> {
        probed_bus_count(probed).ok().map(|info| info.bus_count)
    }

    #[test]
    fn a_probe_that_heard_a_count_reports_it_clamped() {
        assert_eq!(bus_count(probed(Some(3))), Some(3));
        assert_eq!(bus_count(probed(Some(0))), Some(MAX_BUSES));
    }

    #[test]
    fn a_silent_or_departed_device_probes_as_one_bus() {
        assert_eq!(bus_count(probed(None)), Some(1));
        assert_eq!(bus_count(Err(CanError::Closed)), Some(1));
    }

    #[test]
    fn a_link_that_never_came_up_is_a_failed_probe() {
        let unreachable = CanError::Connect(TransportError::ConnectTimeout {
            addr: "10.0.0.9:23".parse().unwrap(),
            after: Duration::from_secs(1),
        });
        assert!(matches!(
            probed_bus_count(Err(unreachable)),
            Err(CanError::Connect(_))
        ));
        let reset = CanError::Read(std::io::Error::other("connection reset"));
        assert!(probed_bus_count(Err(reset)).is_err());
    }

    // --- a source on wiretap_io --------------------------------------------

    const DEVICE: &str = "gvret_tcp(10.0.0.9:23)";

    fn stream(profile_mappings: Vec<BusMapping>) -> Stream {
        Stream::new(
            3,
            "gvret_tcp",
            DEVICE.to_string(),
            "10.0.0.9:23".to_string(),
            profile_mappings,
        )
    }

    fn connected(buses: Option<u8>) -> CanEvent {
        let mut info = DeviceInfo::default();
        info.buses = buses;
        info.keepalive = true;
        CanEvent::Connected(info)
    }

    fn resolved(messages: &[SourceMessage]) -> &[BusMapping] {
        match messages {
            [SourceMessage::MappingsResolved(3, mappings), SourceMessage::Connected(3, kind, address, None)] =>
            {
                assert_eq!(
                    (kind.as_str(), address.as_str()),
                    ("gvret_tcp", "10.0.0.9:23")
                );
                mappings
            }
            _ => panic!("expected MappingsResolved then Connected"),
        }
    }

    #[test]
    fn a_connect_reconciles_the_profile_to_the_reported_bus_count() {
        let mut s = stream(vec![reconcile_mapping(0, true, 0)]);
        let messages = s.on_event(connected(Some(2))).unwrap();
        let mappings = resolved(&messages);
        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[1].device_bus, 1);
    }

    #[test]
    fn an_implausible_bus_count_is_clamped() {
        let mut s = stream(vec![reconcile_mapping(0, true, 0)]);
        let messages = s.on_event(connected(Some(0))).unwrap();
        assert_eq!(resolved(&messages).len(), MAX_BUSES as usize);
    }

    #[test]
    fn a_device_that_never_says_keeps_the_profiles_buses() {
        let mut s = stream(vec![reconcile_mapping(2, true, 5)]);
        let messages = s.on_event(connected(None)).unwrap();
        let mappings = resolved(&messages);
        assert_eq!(mappings.len(), 1);
        assert_eq!((mappings[0].device_bus, mappings[0].output_bus), (2, 5));
    }

    #[test]
    fn a_read_is_mapped_onto_the_sessions_buses() {
        let mut s = stream(vec![
            reconcile_mapping(0, true, 7),
            reconcile_mapping(1, false, 1),
        ]);
        let read = |bus, at_us| {
            let mut read = CanRead::new(
                CanFrame::data(bus, 0x100, false, false, false, vec![bus]),
                Direction::Rx,
                UNIX_EPOCH + Duration::from_micros(at_us),
            );
            read.device_us = Some(at_us);
            read
        };
        let messages = s
            .on_event(CanEvent::Read(vec![read(0, 10), read(1, 20)]))
            .unwrap();
        let [SourceMessage::Frames(3, frames)] = messages.as_slice() else {
            panic!("expected one Frames");
        };
        assert_eq!(frames.len(), 1, "the muted bus is dropped");
        assert_eq!((frames[0].bus, frames[0].timestamp_us), (7, 10));

        let muted = s.on_event(CanEvent::Read(vec![read(1, 30)])).unwrap();
        assert!(muted.is_empty(), "no empty Frames");
    }

    #[test]
    fn a_loss_ends_the_stream_with_its_kind() {
        let mut s = stream(vec![]);
        let lost = s.on_event(CanEvent::Disconnected {
            error: CanError::Unresponsive,
            consecutive: 1,
            retry_in: None,
        });
        assert!(matches!(lost, Err(CanError::Unresponsive)));
    }

    #[test]
    fn a_link_lost_in_the_handshake_says_how() {
        let closed = handshake_failed(DEVICE, CanError::Closed);
        assert!(closed.contains("closed the connection"), "got: {closed}");
        let reset = handshake_failed(
            DEVICE,
            CanError::Read(std::io::Error::other("connection reset")),
        );
        assert!(reset.contains("connection reset"), "got: {reset}");
    }
}
