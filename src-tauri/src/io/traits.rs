// src-tauri/src/io/traits.rs
//
// Interface trait validation and session trait inheritance.

use super::bus_mapping::BusMapping;
use super::{InterfaceTraits, Protocol, TemporalMode};

/// Result of validating multiple interface traits for a session
#[derive(Clone, Debug)]
pub struct SessionTraitsValidation {
    /// Whether the combination is valid
    pub valid: bool,
    /// Error message if invalid
    pub error: Option<String>,
    /// Derived session traits if valid
    pub session_traits: Option<InterfaceTraits>,
}

/// Check if two protocol sets are compatible.
/// All realtime protocol combinations are now valid — SessionDataStreams
/// handles the distinction between frame and byte data streams.
#[allow(dead_code)]
pub fn protocols_compatible(_a: &[Protocol], _b: &[Protocol]) -> bool {
    true
}

/// Validate and derive session traits from multiple interface traits.
///
/// Rules:
/// 1. Temporal mode must match across all interfaces
/// 2. Timeline sessions are limited to 1 interface
/// 3. Protocols must be compatible (same group)
/// 4. tx_frames/tx_bytes = true if ANY interface can transmit that type
pub fn validate_session_traits(interface_traits: &[InterfaceTraits]) -> SessionTraitsValidation {
    if interface_traits.is_empty() {
        return SessionTraitsValidation {
            valid: false,
            error: Some("At least one interface is required".to_string()),
            session_traits: None,
        };
    }

    // Single interface: directly use its traits
    if interface_traits.len() == 1 {
        return SessionTraitsValidation {
            valid: true,
            error: None,
            session_traits: Some(interface_traits[0].clone()),
        };
    }

    // Multiple interfaces: validate compatibility
    let first = &interface_traits[0];

    // Rule 1: Temporal mode must match
    let temporal_mode = first.temporal_mode.clone();
    for (i, traits) in interface_traits.iter().enumerate().skip(1) {
        if traits.temporal_mode != temporal_mode {
            return SessionTraitsValidation {
                valid: false,
                error: Some(format!(
                    "Interface {} has temporal mode {:?}, but interface 0 has {:?}. All interfaces must have the same temporal mode.",
                    i, traits.temporal_mode, temporal_mode
                )),
                session_traits: None,
            };
        }
    }

    // Rule 2: Sources with multi_source: false cannot be combined
    if interface_traits.iter().any(|t| !t.multi_source) {
        return SessionTraitsValidation {
            valid: false,
            error: Some(
                "One or more sources do not support multi-source sessions".to_string(),
            ),
            session_traits: None,
        };
    }

    // Rule 3: Merge protocols from all interfaces (union).
    // All realtime protocol combinations are valid — SessionDataStreams
    // handles the distinction between frame and byte data streams.
    let mut all_protocols: Vec<Protocol> = first.protocols.clone();
    for traits in interface_traits.iter().skip(1) {
        for p in &traits.protocols {
            if !all_protocols.contains(p) {
                all_protocols.push(*p);
            }
        }
    }

    // Rule 4: tx_frames/tx_bytes = true if ANY interface can transmit
    let tx_frames = interface_traits.iter().any(|t| t.tx_frames);
    let tx_bytes = interface_traits.iter().any(|t| t.tx_bytes);

    // Rule 5: multi_source = ALL inputs must be multi_source (already validated above)
    let multi_source = interface_traits.iter().all(|t| t.multi_source);

    SessionTraitsValidation {
        valid: true,
        error: None,
        session_traits: Some(InterfaceTraits {
            temporal_mode,
            protocols: all_protocols,
            tx_frames,
            tx_bytes,
            multi_source,
        }),
    }
}

/// The traits a bus inherits from the protocol it carries.
///
/// The single protocol→traits derivation. Everything that builds a `BusMapping`
/// goes through here rather than writing the struct out, and
/// `resolve_source_config` re-derives with it on the way in — so a `traits` blob
/// from the frontend can never contradict the protocol beside it. Seven copies
/// of this match had accumulated across `sessions.rs` and `gvret/common.rs`
/// before it existed.
///
/// `CanFd` reports both protocols because an FD interface still carries classic
/// CAN frames; the frontend gates its FD controls on `CanFd` being present.
pub fn traits_for_protocol(protocol: Protocol) -> InterfaceTraits {
    let (protocols, tx_frames, tx_bytes) = match protocol {
        Protocol::Can => (vec![Protocol::Can], true, false),
        Protocol::CanFd => (vec![Protocol::Can, Protocol::CanFd], true, false),
        Protocol::Modbus => (vec![Protocol::Modbus], false, false),
        Protocol::ModbusRtu => (vec![Protocol::ModbusRtu], false, false),
        Protocol::Serial => (vec![Protocol::Serial], false, true),
    };
    InterfaceTraits {
        temporal_mode: TemporalMode::Realtime,
        protocols,
        tx_frames,
        tx_bytes,
        multi_source: true,
    }
}

/// Every profile kind, plus the capture pseudo-kind the kind table has no entry
/// for. Derived from `device_kinds::KINDS` rather than restated, so a kind added
/// there cannot quietly go missing from the picker's protocol options.
pub fn profile_kinds() -> impl Iterator<Item = &'static str> {
    super::device_kinds::kinds().chain(std::iter::once("capture"))
}

/// What a bus of this kind may be set to, for the source picker to offer.
///
/// A single entry means the choice is already made and the picker renders no
/// dropdown — which is most kinds. Only the GVRETs and FrameLink's CAN
/// interfaces have a genuine CAN-versus-FD choice to make.
///
/// **Modbus is deliberately absent.** A serial port is read as Modbus by way of
/// its framing encoding (`framing_encoding: "modbus_rtu"`) and the attached
/// catalogue's protocol — see `io/serial/utils.rs` and `ws/dispatch.rs`. Adding
/// it here would be a third way to say the same thing, free to disagree with the
/// other two.
pub fn supported_protocols_for_kind(kind: &str) -> &'static [Protocol] {
    match super::device_kinds::canonical_kind(kind) {
        "gvret_tcp" | "gvret_usb" | "framelink" | "slcan" | "gs_usb" | "socketcan" => {
            &[Protocol::Can, Protocol::CanFd]
        }
        "modbus_tcp" => &[Protocol::Modbus],
        "serial" => &[Protocol::Serial],
        "mqtt" | "wiretap" | "capture" | "virtual" => &[Protocol::Can],
        _ => &[],
    }
}

/// Re-derive every mapping's traits from the protocol beside it.
///
/// The single point where a `BusMapping` crossing in from the frontend is made
/// self-consistent — both the session-create path and the running-session
/// hot-swap go through here, so the two cannot come to different answers.
///
/// `traits` is output, never input: the caller sends a protocol (the picker's
/// per-bus dropdown, or the one the profile declared) and the traits that follow
/// are computed here, so a stale or hand-written blob cannot claim a capability
/// the protocol does not imply.
///
/// The protocol itself is taken as given rather than checked against the kind.
/// The kind table is a *default* — what the picker offers — and it is coarser
/// than the truth: it answers per kind, while a FrameLink RS485 port or a
/// virtual Modbus adaptor carries a protocol its kind's list does not mention.
/// Clamping to that list rewrote exactly those buses to CAN.
///
/// `supported_protocols` is only filled where the builder left it empty, so a
/// mapping that knows its own narrower list (an RS485 port that cannot be
/// talked into CAN) keeps it.
pub fn normalise_bus_traits(mappings: &mut [BusMapping], profile_kind: &str) {
    let supported = supported_protocols_for_kind(profile_kind);
    for m in mappings.iter_mut() {
        m.traits = Some(traits_for_protocol(m.protocol));
        if m.supported_protocols.is_empty() {
            m.supported_protocols = supported.to_vec();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_interface_valid() {
        let traits = vec![InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            tx_frames: true,
            tx_bytes: false,
            multi_source: true,
        }];
        let result = validate_session_traits(&traits);
        assert!(result.valid);
        assert!(result.session_traits.is_some());
    }

    #[test]
    fn test_multiple_realtime_can_valid() {
        let traits = vec![
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Can],
                tx_frames: true,
                tx_bytes: false,
                multi_source: true,
            },
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::CanFd],
                tx_frames: false,
                tx_bytes: false,
                multi_source: true,
            },
        ];
        let result = validate_session_traits(&traits);
        assert!(result.valid);
        let session = result.session_traits.unwrap();
        assert_eq!(session.temporal_mode, TemporalMode::Realtime);
        assert!(session.tx_frames); // Any interface can transmit
        assert!(session.multi_source);
        assert!(session.protocols.contains(&Protocol::Can));
        assert!(session.protocols.contains(&Protocol::CanFd));
    }

    #[test]
    fn test_temporal_mode_mismatch_invalid() {
        let traits = vec![
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Can],
                tx_frames: true,
                tx_bytes: false,
                multi_source: true,
            },
            InterfaceTraits {
                temporal_mode: TemporalMode::Recorded,
                protocols: vec![Protocol::Can],
                tx_frames: false,
                tx_bytes: false,
                multi_source: false,
            },
        ];
        let result = validate_session_traits(&traits);
        assert!(!result.valid);
        assert!(result.error.unwrap().contains("temporal mode"));
    }

    #[test]
    fn test_non_multi_source_rejected() {
        // Two realtime sources where one has multi_source: false
        let traits = vec![
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Can],
                tx_frames: true,
                tx_bytes: false,
                multi_source: true,
            },
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Can],
                tx_frames: false,
                tx_bytes: false,
                multi_source: false,
            },
        ];
        let result = validate_session_traits(&traits);
        assert!(!result.valid);
        assert!(result
            .error
            .unwrap()
            .contains("do not support multi-source"));
    }

    #[test]
    fn test_timeline_multiple_interfaces_invalid() {
        let traits = vec![
            InterfaceTraits {
                temporal_mode: TemporalMode::Recorded,
                protocols: vec![Protocol::Can],
                tx_frames: false,
                tx_bytes: false,
                multi_source: false,
            },
            InterfaceTraits {
                temporal_mode: TemporalMode::Recorded,
                protocols: vec![Protocol::Can],
                tx_frames: false,
                tx_bytes: false,
                multi_source: false,
            },
        ];
        let result = validate_session_traits(&traits);
        assert!(!result.valid);
        // Now rejected by multi_source: false rule instead of timeline-specific rule
        assert!(result
            .error
            .unwrap()
            .contains("do not support multi-source"));
    }

    #[test]
    fn test_mixed_protocols_valid() {
        // CAN + Serial is now valid (e.g., CAN bus + serial debug port)
        let traits = vec![
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Can],
                tx_frames: true,
                tx_bytes: false,
                multi_source: true,
            },
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Serial],
                tx_frames: false,
                tx_bytes: true,
                multi_source: true,
            },
        ];
        let result = validate_session_traits(&traits);
        assert!(result.valid);
        let session = result.session_traits.unwrap();
        assert!(session.protocols.contains(&Protocol::Can));
        assert!(session.protocols.contains(&Protocol::Serial));
    }

    #[test]
    fn test_protocol_compatibility() {
        // All protocol combinations are compatible
        assert!(protocols_compatible(
            &[Protocol::Can],
            &[Protocol::CanFd]
        ));
        assert!(protocols_compatible(
            &[Protocol::Can],
            &[Protocol::Serial]
        ));
        assert!(protocols_compatible(&[], &[Protocol::Can]));
    }
}
