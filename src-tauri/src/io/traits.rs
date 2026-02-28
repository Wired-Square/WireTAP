// src-tauri/src/io/traits.rs
//
// Interface trait validation and session trait inheritance.

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
/// 4. can_transmit = true if ANY interface can transmit
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

    // Rule 2: Timeline sessions limited to 1 interface
    if temporal_mode == TemporalMode::Timeline {
        return SessionTraitsValidation {
            valid: false,
            error: Some("Timeline sessions are limited to a single interface".to_string()),
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
                all_protocols.push(p.clone());
            }
        }
    }

    // Rule 4: can_transmit = ANY interface can transmit
    let can_transmit = interface_traits.iter().any(|t| t.can_transmit);

    SessionTraitsValidation {
        valid: true,
        error: None,
        session_traits: Some(InterfaceTraits {
            temporal_mode,
            protocols: all_protocols,
            can_transmit,
        }),
    }
}

/// Get interface traits for a profile kind.
/// Used when explicit traits are not available in IOCapabilities.
pub fn get_traits_for_profile_kind(kind: &str) -> InterfaceTraits {
    match kind {
        "gvret_tcp" | "gvret-tcp" | "gvret_usb" | "gvret-usb" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can, Protocol::CanFd],
            can_transmit: true,
        },
        "slcan" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            can_transmit: true, // Note: silent_mode overrides this at runtime
        },
        "gs_usb" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can, Protocol::CanFd],
            can_transmit: true, // Note: listen_only overrides this at runtime
        },
        "socketcan" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can, Protocol::CanFd],
            can_transmit: true,
        },
        "mqtt" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            can_transmit: false,
        },
        "modbus_tcp" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Modbus],
            can_transmit: false,
        },
        "postgres" => InterfaceTraits {
            temporal_mode: TemporalMode::Timeline,
            protocols: vec![Protocol::Can, Protocol::Modbus, Protocol::Serial],
            can_transmit: false,
        },
        "csv_file" | "csv-file" => InterfaceTraits {
            temporal_mode: TemporalMode::Timeline,
            protocols: vec![Protocol::Can],
            can_transmit: false,
        },
        "buffer" => InterfaceTraits {
            temporal_mode: TemporalMode::Timeline,
            protocols: vec![Protocol::Can],
            can_transmit: false,
        },
        "serial" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Serial],
            can_transmit: true,
        },
        _ => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![],
            can_transmit: false,
        },
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
            can_transmit: true,
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
                can_transmit: true,
            },
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::CanFd],
                can_transmit: false,
            },
        ];
        let result = validate_session_traits(&traits);
        assert!(result.valid);
        let session = result.session_traits.unwrap();
        assert_eq!(session.temporal_mode, TemporalMode::Realtime);
        assert!(session.can_transmit); // Any interface can transmit
        assert!(session.protocols.contains(&Protocol::Can));
        assert!(session.protocols.contains(&Protocol::CanFd));
    }

    #[test]
    fn test_temporal_mode_mismatch_invalid() {
        let traits = vec![
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Can],
                can_transmit: true,
            },
            InterfaceTraits {
                temporal_mode: TemporalMode::Timeline,
                protocols: vec![Protocol::Can],
                can_transmit: false,
            },
        ];
        let result = validate_session_traits(&traits);
        assert!(!result.valid);
        assert!(result.error.unwrap().contains("temporal mode"));
    }

    #[test]
    fn test_timeline_multiple_interfaces_invalid() {
        let traits = vec![
            InterfaceTraits {
                temporal_mode: TemporalMode::Timeline,
                protocols: vec![Protocol::Can],
                can_transmit: false,
            },
            InterfaceTraits {
                temporal_mode: TemporalMode::Timeline,
                protocols: vec![Protocol::Can],
                can_transmit: false,
            },
        ];
        let result = validate_session_traits(&traits);
        assert!(!result.valid);
        assert!(result.error.unwrap().contains("Timeline sessions are limited"));
    }

    #[test]
    fn test_mixed_protocols_valid() {
        // CAN + Serial is now valid (e.g., CAN bus + serial debug port)
        let traits = vec![
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Can],
                can_transmit: true,
            },
            InterfaceTraits {
                temporal_mode: TemporalMode::Realtime,
                protocols: vec![Protocol::Serial],
                can_transmit: true,
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
