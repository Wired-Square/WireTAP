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
                all_protocols.push(p.clone());
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

/// Get interface traits for a profile kind.
/// Used when explicit traits are not available in IOCapabilities.
pub fn get_traits_for_profile_kind(kind: &str) -> InterfaceTraits {
    match kind {
        "gvret_tcp" | "gvret-tcp" | "gvret_usb" | "gvret-usb" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            tx_frames: true,
            tx_bytes: false,
            multi_source: true,
        },
        "slcan" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            tx_frames: true, // Note: silent_mode overrides this at runtime
            tx_bytes: false,
            multi_source: true,
        },
        "gs_usb" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            tx_frames: true, // Note: listen_only overrides this at runtime
            tx_bytes: false,
            multi_source: true,
        },
        "socketcan" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            tx_frames: true,
            tx_bytes: false,
            multi_source: true,
        },
        "mqtt" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            tx_frames: false,
            tx_bytes: false,
            multi_source: true,
        },
        "modbus_tcp" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Modbus],
            tx_frames: false,
            tx_bytes: false,
            multi_source: true,
        },
        "postgres" => InterfaceTraits {
            temporal_mode: TemporalMode::Recorded,
            protocols: vec![Protocol::Can],
            tx_frames: false,
            tx_bytes: false,
            multi_source: false,
        },
        "capture" => InterfaceTraits {
            temporal_mode: TemporalMode::Capture,
            protocols: vec![Protocol::Can],
            tx_frames: false,
            tx_bytes: false,
            multi_source: false,
        },
        "serial" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Serial],
            tx_frames: false,
            tx_bytes: false,
            multi_source: true,
        },
        "framelink" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            tx_frames: true,
            tx_bytes: false,
            multi_source: true,
        },
        "virtual" => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![Protocol::Can],
            tx_frames: true,
            tx_bytes: false,
            multi_source: true,
        },
        _ => InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols: vec![],
            tx_frames: false,
            tx_bytes: false,
            multi_source: false,
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
