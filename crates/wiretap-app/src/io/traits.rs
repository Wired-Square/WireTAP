// crates/wiretap-app/src/io/traits.rs
//
// Interface trait validation and session trait inheritance.

use std::collections::HashMap;

use serde::Serialize;

use super::bus_mapping::BusMapping;
use super::device_kinds::{self, canonical_kind, conn_bool};
use super::{InterfaceTraits, Protocol, TemporalMode};
use crate::settings::IOProfile;

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

/// Validate and derive session traits from multiple interface traits.
///
/// Rules:
/// 1. Temporal mode must match across all interfaces
/// 2. Timeline sessions are limited to 1 interface
/// 3. Any protocols may share a session; `SessionDataStreams` tells frames from bytes
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
/// `normalise_bus_traits` re-derives with it on the way in — so a `traits` blob
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
/// dropdown — which is most kinds. GVRET's transmit command has no FD flag,
/// so its kinds offer CAN alone.
///
/// **Modbus is deliberately absent.** A serial port is read as Modbus by way of
/// its framing encoding (`framing_encoding: "modbus_rtu"`) and the attached
/// catalogue's protocol — see `io/serial/utils.rs` and `ws/dispatch.rs`. Adding
/// it here would be a third way to say the same thing, free to disagree with the
/// other two.
pub fn supported_protocols_for_kind(kind: &str) -> &'static [Protocol] {
    match super::device_kinds::canonical_kind(kind) {
        "framelink" | "slcan" | "gs_usb" | "socketcan" => &[Protocol::Can, Protocol::CanFd],
        "modbus_tcp" => &[Protocol::Modbus],
        "serial" => &[Protocol::Serial],
        "gvret_tcp" | "gvret_usb" | "mqtt" | "wiretap" | "capture" | "virtual" => &[Protocol::Can],
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
/// Clamping to that list rewrote exactly those buses to CAN. The one exception
/// is a GVRET bus saved as CAN FD, which runs as classic CAN: GVRET's transmit
/// command has no FD flag.
///
/// `supported_protocols` is only filled where the builder left it empty, so a
/// mapping that knows its own narrower list (an RS485 port that cannot be
/// talked into CAN) keeps it.
pub fn normalise_bus_traits(mappings: &mut [BusMapping], profile_kind: &str) {
    let supported = supported_protocols_for_kind(profile_kind);
    let gvret = matches!(super::device_kinds::canonical_kind(profile_kind), "gvret_tcp" | "gvret_usb");
    for m in mappings.iter_mut() {
        if gvret && m.protocol == Protocol::CanFd {
            m.protocol = Protocol::Can;
        }
        m.traits = Some(traits_for_protocol(m.protocol));
        if m.supported_protocols.is_empty() {
            m.supported_protocols = supported.to_vec();
        }
    }
}

/// Why a profile whose buses transmit cannot right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum TxBlock {
    SilentMode,
    ListenOnly,
}

/// What one profile brings to a session, read off its own connection map.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProfileTraits {
    #[serde(flatten)]
    pub session: InterfaceTraits,
    /// The protocol a single-bus profile's one bus carries.
    pub bus_protocol: Protocol,
    pub multi_bus: bool,
    pub tx_blocked: Option<TxBlock>,
}

/// A kind's traits as a profile with nothing configured has them.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct KindTraits {
    pub kind: String,
    pub available: bool,
    #[serde(flatten)]
    pub traits: ProfileTraits,
}

/// Every kind in the order the kind pickers list them, and every profile by id.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProfileTraitsTable {
    pub kinds: Vec<KindTraits>,
    pub profiles: HashMap<String, ProfileTraits>,
}

/// A profile's traits, derived from the buses its reader would open.
pub fn profile_traits(profile: &IOProfile) -> ProfileTraits {
    let spec = device_kinds::spec(&profile.kind);
    let mut buses = crate::sessions::profile_bus_mappings(profile);
    normalise_bus_traits(&mut buses, &profile.kind);
    let bus_traits: Vec<InterfaceTraits> = buses.iter().map(BusMapping::effective_traits).collect();
    let merged = validate_session_traits(&bus_traits)
        .session_traits
        .unwrap_or_else(|| traits_for_protocol(spec.map_or(Protocol::Can, |s| s.protocol)));

    let kind = canonical_kind(&profile.kind);
    let tx_blocked = match kind {
        "slcan" if conn_bool(profile, "silent_mode") == Some(true) => Some(TxBlock::SilentMode),
        "gs_usb" if conn_bool(profile, "listen_only") == Some(true) => Some(TxBlock::ListenOnly),
        _ => None,
    };
    ProfileTraits {
        session: InterfaceTraits {
            temporal_mode: if spec.is_some_and(|s| s.realtime) {
                TemporalMode::Realtime
            } else {
                TemporalMode::Recorded
            },
            tx_frames: merged.tx_frames && spec.is_some_and(|s| s.can_tx),
            multi_source: spec.is_some_and(|s| s.multi_source),
            ..merged
        },
        bus_protocol: buses.first().map_or(Protocol::Can, |b| b.protocol),
        // A GVRET is multi-bus however many buses it has saved: `probe_device`
        // reports it so, and the picker keys its config maps off this answer.
        multi_bus: matches!(kind, "gvret_tcp" | "gvret_usb") || buses.len() > 1,
        tx_blocked,
    }
}

fn kind_traits() -> Vec<KindTraits> {
    device_kinds::kinds()
        .map(|kind| KindTraits {
            kind: kind.to_string(),
            available: device_kinds::spec(kind).is_some_and(|s| s.available),
            traits: profile_traits(&IOProfile { kind: kind.to_string(), ..Default::default() }),
        })
        .collect()
}

/// The traits of every kind and every profile, saved or ad hoc.
#[tauri::command(rename_all = "snake_case")]
pub fn list_profile_traits(app: tauri::AppHandle) -> Result<ProfileTraitsTable, String> {
    let settings = crate::settings::load_settings_sync(&app)?;
    Ok(ProfileTraitsTable {
        kinds: kind_traits(),
        profiles: settings
            .io_profiles
            .iter()
            .map(|p| (p.id.clone(), profile_traits(p)))
            .collect(),
    })
}

/// Why these profiles cannot open as one session, or `None` when they can.
pub fn selection_error(profiles: &[IOProfile]) -> Option<String> {
    let traits: Vec<InterfaceTraits> = profiles.iter().map(|p| profile_traits(p).session).collect();
    let validation = validate_session_traits(&traits);
    if !validation.valid {
        return validation.error;
    }
    let ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
    profiles
        .iter()
        .enumerate()
        .find_map(|(i, p)| crate::profile_tracker::can_use_adapter(&p.id, profiles, &ids[..i]).err())
}

/// The source picker's check on a multi-source selection, with the profiles as
/// it holds them: a device saved a moment ago may not be on disk yet.
#[tauri::command(rename_all = "snake_case")]
pub fn validate_source_selection(profiles: Vec<IOProfile>) -> Option<String> {
    selection_error(&profiles)
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

    fn profile(id: &str, kind: &str, connection: serde_json::Value) -> IOProfile {
        IOProfile {
            id: id.to_string(),
            name: id.to_string(),
            kind: kind.to_string(),
            connection: serde_json::from_value(connection).unwrap(),
            ..Default::default()
        }
    }

    fn blank(kind: &str) -> IOProfile {
        profile(&format!("io_{kind}"), kind, serde_json::json!({}))
    }

    fn protocol_names(protocols: &[Protocol]) -> Vec<String> {
        let mut names: Vec<String> = protocols
            .iter()
            .map(|p| serde_json::to_value(p).unwrap().as_str().unwrap().to_string())
            .collect();
        names.sort();
        names
    }

    fn family(kind: &str) -> Protocol {
        device_kinds::spec(kind).unwrap().protocol
    }

    /// The TypeScript registry, taken before it was deleted: every kind and
    /// config variant it answered for, and every pair the picker allowed. Where
    /// the two disagree this table stands, and the differences are listed here.
    #[test]
    fn the_retired_typescript_registry_agrees_with_this_one() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("device_kinds/ts-traits-golden.json")).unwrap();

        let platform = if cfg!(target_os = "ios") {
            "ios"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        };
        let offered: Vec<String> = kind_traits().into_iter().filter(|k| k.available).map(|k| k.kind).collect();
        assert_eq!(serde_json::json!(offered), golden["availableKinds"][platform]);

        for (kind, theirs) in golden["kinds"].as_object().unwrap() {
            let ours = profile_traits(&blank(kind)).session;
            let realtime = theirs["temporalMode"] == "realtime";
            assert_eq!(ours.temporal_mode == TemporalMode::Realtime, realtime, "{kind}");
            // MQTT has its own reader, and the broker's spawner no arm for it.
            let multi_source = theirs["multiSource"].as_bool().unwrap() && kind != "mqtt";
            assert_eq!(ours.multi_source, multi_source, "{kind}");
        }

        // GVRET's transmit command has no FD flag, so a bus saved as CAN FD runs
        // as classic CAN; an RS-232 FrameLink port is serial, as RS-485 is.
        let protocols_differ = [
            ("gvret_tcp_canfd_bus", vec!["can"]),
            ("gvret_usb_canfd_bus", vec!["can"]),
            ("framelink_rs232", vec!["serial"]),
            ("framelink_legacy_rs232", vec!["serial"]),
        ];
        // The one-bus protocol, so a multi-bus FrameLink reads its first bus.
        let bus_protocol_differs = [
            ("gvret_tcp_canfd_bus", "can"),
            ("gvret_usb_canfd_bus", "can"),
            ("framelink_mixed", "can"),
            ("framelink_rs232", "serial"),
            ("framelink_legacy_rs232", "serial"),
        ];
        for v in golden["variants"].as_array().unwrap() {
            let name = v["name"].as_str().unwrap();
            let ours = profile_traits(&profile(name, v["kind"].as_str().unwrap(), v["connection"].clone()));
            let theirs = &v["traits"];

            let mut want: Vec<String> = theirs["protocols"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect();
            want.sort();
            if let Some((_, differs)) = protocols_differ.iter().find(|(n, _)| *n == name) {
                want = differs.iter().map(|p| p.to_string()).collect();
            }
            assert_eq!(protocol_names(&ours.session.protocols), want, "{name} protocols");

            let bus_protocol = bus_protocol_differs
                .iter()
                .find(|(n, _)| *n == name)
                .map_or_else(|| v["busProtocol"].clone(), |(_, p)| serde_json::json!(p));
            assert_eq!(serde_json::to_value(ours.bus_protocol).unwrap(), bus_protocol, "{name} bus protocol");

            assert_eq!(serde_json::json!(ours.multi_bus), v["multiBus"], "{name} multi-bus");

            // A serial port writes bytes, which TypeScript did not count.
            let transmits = theirs["canTransmit"].as_bool().unwrap() || name == "serial";
            assert_eq!(ours.session.tx_frames || ours.session.tx_bytes, transmits, "{name} transmits");
        }

        // TypeScript refused protocols of different families in one session;
        // Rust has carried CAN, Modbus and serial side by side since data
        // streams were split. MQTT cannot join any session.
        for pair in golden["selections"].as_array().unwrap() {
            let (a, b) = (pair["a"].as_str().unwrap(), pair["b"].as_str().unwrap());
            let ours = selection_error(&[blank(a), profile("io_b", b, serde_json::json!({}))]).is_none();
            let both_live = [a, b].iter().all(|k| device_kinds::spec(k).unwrap().realtime);
            let theirs = pair["valid"].as_bool().unwrap();
            let want = if !both_live {
                theirs
            } else if a == "mqtt" || b == "mqtt" {
                false
            } else {
                theirs || family(a) != family(b)
            };
            assert_eq!(ours, want, "{a} + {b}");
        }
    }

    #[test]
    fn a_serial_port_transmits_bytes() {
        let t = profile_traits(&blank("serial")).session;
        assert!(t.tx_bytes && !t.tx_frames);
        assert_eq!(t.protocols, vec![Protocol::Serial]);
    }

    #[test]
    fn modbus_and_serial_share_a_session() {
        assert_eq!(selection_error(&[blank("modbus_tcp"), blank("serial")]), None);
    }

    #[test]
    fn an_rs232_framelink_port_is_serial() {
        for iface_type in [3, 4] {
            let p = profile("io_fl", "framelink", serde_json::json!({ "interface_type": iface_type }));
            assert_eq!(profile_traits(&p).bus_protocol, Protocol::Serial, "{iface_type}");
        }
    }

    #[test]
    fn mqtt_is_live_but_cannot_join_a_session() {
        let t = profile_traits(&blank("mqtt")).session;
        assert_eq!(t.temporal_mode, TemporalMode::Realtime);
        assert!(!t.multi_source);
        assert!(selection_error(&[blank("gvret_tcp"), blank("mqtt")]).is_some());
    }

    #[test]
    fn a_gvret_bus_saved_as_canfd_runs_as_classic_can() {
        let p = profile(
            "io_gvret",
            "gvret_tcp",
            serde_json::json!({ "interfaces": [{ "device_bus": 0, "protocol": "canfd" }] }),
        );
        let t = profile_traits(&p);
        assert_eq!(t.session.protocols, vec![Protocol::Can]);
        assert_eq!(t.bus_protocol, Protocol::Can);
    }

    #[test]
    fn two_channels_of_one_gs_usb_adapter_cannot_share_a_selection() {
        let on = |id: &str, channel: i64| {
            profile(id, "gs_usb", serde_json::json!({ "serial": "ABC123", "channel": channel }))
        };
        let err = selection_error(&[on("io_ch0", 0), on("io_ch1", 1)]).unwrap();
        assert!(err.contains("same gs_usb adapter"), "{err}");
    }

    #[test]
    fn listen_only_and_silent_profiles_say_why_they_cannot_transmit() {
        assert_eq!(profile_traits(&blank("slcan")).tx_blocked, Some(TxBlock::SilentMode));
        assert_eq!(profile_traits(&blank("gs_usb")).tx_blocked, Some(TxBlock::ListenOnly));
        let active = profile("io_s", "slcan", serde_json::json!({ "silent_mode": false }));
        assert_eq!(profile_traits(&active).tx_blocked, None);
    }

    /// A serial profile's own bus used to come out as `can0` carrying CAN when
    /// Rust built the mapping, while the picker's came out serial.
    #[test]
    fn a_default_bus_carries_the_kinds_protocol() {
        let bus = &crate::sessions::profile_bus_mappings(&blank("serial"))[0];
        assert_eq!((bus.interface_id.as_str(), bus.protocol), ("serial0", Protocol::Serial));
    }
}
