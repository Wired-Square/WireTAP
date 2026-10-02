use crate::{
    io::{
        self,
        BusMapping, Protocol,
        bus_mapping::{apply_bus_overrides, BusOverride},
        PollGroup,
        SerialOverrides, SourceConfig,
    },
    settings::{AppSettings, IOProfile},
};
#[cfg(not(target_os = "ios"))]
use crate::io::device_kinds::{self, conn_i64, conn_str};
use crate::io::traits::supported_protocols_for_kind;

use super::tracking::get_cached_probe;

pub(super) fn choose_profile_by_id(settings: &AppSettings, profile_id: Option<&str>) -> Option<IOProfile> {
    if let Some(id) = profile_id {
        settings.io_profiles.iter().find(|p| p.id == id).cloned()
    } else if let Some(id) = &settings.default_read_profile {
        settings.io_profiles.iter().find(|p| p.id == *id).cloned()
    } else {
        // Return the first profile as a fallback
        settings.io_profiles.first().cloned()
    }
}

/// Session-level serial settings, as the picker sends them for one source.
/// Adopt a session's serial overrides, then settle the two fields the broker
/// reads before any reader runs.
///
/// `IOBroker` decides which captures a session gets, and what `IOCapabilities`
/// reports, from `SourceConfig.serial.framing_encoding` alone — before any
/// reader has run. Leaving it `None` meant "raw" to the broker and something
/// else entirely to the port, and the two disagreeing is what made a framed
/// single-source session build a bytes capture nothing wrote to, no frames
/// capture at all, and drop every framed row.
fn apply_serial_overrides(
    config: &mut SourceConfig,
    profile: &IOProfile,
    serial: SerialOverrides,
) {
    config.serial = serial;
    if config.profile_kind != "serial" {
        return;
    }
    let (framing, emit_raw_bytes) = device_kinds::resolve_serial_framing(
        profile,
        config.serial.framing_encoding,
        config.serial.emit_raw_bytes,
    );
    config.serial.framing_encoding = Some(framing);
    config.serial.emit_raw_bytes = Some(emit_raw_bytes);
}

/// Create a SourceConfig from an IOProfile for use with IOBroker.
/// This extracts the common device configuration logic used by both single-device
/// and multi-device session creation.
///
/// Returns None for non-realtime devices (wiretap, mqtt, serial, capture)
/// which should use their direct readers instead.
pub(super) fn create_source_config_from_profile(
    profile: &IOProfile,
    bus_override: Option<u8>,
    serial: SerialOverrides,
) -> Option<SourceConfig> {
    if !device_kinds::is_multi_source(&profile.kind) {
        return None;
    }

    // Try to read interfaces configuration from profile (for GVRET multi-bus)
    let mut bus_mappings = if let Some(mappings) = parse_interfaces_from_profile(profile, bus_override)
    {
        mappings
    } else {
        // Fall back to default single bus mapping
        create_default_bus_mapping(profile, bus_override)
    };
    io::traits::normalise_bus_traits(&mut bus_mappings, &profile.kind);

    let mut config = SourceConfig {
        profile_id: profile.id.clone(),
        profile_kind: profile.kind.clone(),
        display_name: profile.name.clone(),
        bus_mappings,
        ..SourceConfig::default()
    };
    apply_serial_overrides(&mut config, profile, serial);
    Some(config)
}

pub(super) fn reader_source_config(
    profile: &IOProfile,
    bus_override: Option<u8>,
    serial: SerialOverrides,
    modbus_polls: Option<&str>,
    max_register_errors: u32,
) -> Result<SourceConfig, String> {
    let mut config = create_source_config_from_profile(profile, bus_override, serial)
        .ok_or_else(|| format!("Failed to create source config for profile '{}'", profile.id))?;
    attach_modbus_polls(&mut config, &parse_modbus_polls(modbus_polls)?, max_register_errors);
    Ok(config)
}

pub(super) fn parse_modbus_polls(json: Option<&str>) -> Result<Option<Vec<PollGroup>>, String> {
    json.map(|json| {
        serde_json::from_str(json).map_err(|e| format!("Failed to parse Modbus poll groups: {e}"))
    })
    .transpose()
}

pub(super) fn attach_modbus_polls(
    config: &mut SourceConfig,
    polls: &Option<Vec<PollGroup>>,
    max_register_errors: u32,
) {
    if config.profile_kind == "modbus_tcp" {
        config.modbus_polls = polls.clone();
        config.max_register_errors = Some(max_register_errors);
    }
}

/// The protocol a settings string names, defaulting to classic CAN.
///
/// The settings file spells these the same way the wire does, so this is the one
/// place the string form is turned back into the enum.
fn protocol_from_str(value: Option<&str>) -> Protocol {
    match value {
        Some("canfd") => Protocol::CanFd,
        Some("modbus") => Protocol::Modbus,
        Some("serial") => Protocol::Serial,
        _ => Protocol::Can,
    }
}

/// Parse interfaces configuration from profile connection field.
/// Returns None if no interfaces are configured, otherwise returns bus mappings.
fn parse_interfaces_from_profile(
    profile: &IOProfile,
    bus_override: Option<u8>,
) -> Option<Vec<BusMapping>> {
    // Virtual adaptors carry their buses in the same field, shaped differently
    if matches!(profile.kind.as_str(), "virtual") {
        return parse_virtual_interfaces(profile, bus_override);
    }

    // Only GVRET profiles have multi-bus interface configuration
    if !matches!(profile.kind.as_str(), "gvret_tcp" | "gvret_usb") {
        return None;
    }

    let Some(interfaces) = profile
        .connection
        .get("interfaces")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
    else {
        // Never configured in Settings, but a probe counted the buses
        return parse_gvret_probed_bus_count(profile, bus_override);
    };

    let mappings: Vec<BusMapping> = interfaces
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let device_bus = obj.get("device_bus")?.as_u64()? as u8;
            let enabled = obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let protocol = protocol_from_str(obj.get("protocol").and_then(|v| v.as_str()));

            // Use bus_override for output_bus if provided, otherwise use device_bus
            let output_bus = bus_override.unwrap_or(device_bus);

            Some(BusMapping {
                device_bus,
                enabled,
                output_bus,
                interface_id: format!("can{}", device_bus),
                supported_protocols: supported_protocols_for_kind(&profile.kind).to_vec(),
                ..BusMapping::default().with_protocol(protocol)
            })
        })
        .collect();

    if mappings.is_empty() {
        None
    } else {
        Some(mappings)
    }
}

/// GVRET that was probed but never configured: synthesise one CAN bus per
/// bus the probe counted, so a 2-bus device is not treated as single-bus.
fn parse_gvret_probed_bus_count(
    profile: &IOProfile,
    bus_override: Option<u8>,
) -> Option<Vec<BusMapping>> {
    let count = profile
        .connection
        .get("_probed_bus_count")
        .and_then(|v| v.as_u64())
        .filter(|c| *c > 0)?
        .min(io::gvret::MAX_BUSES as u64) as u8;

    let mappings = io::bus_mapping::default_bus_mappings(count);
    Some(match bus_override {
        Some(offset) => offset_bus_mappings(mappings, offset),
        None => mappings,
    })
}

/// Virtual adaptor buses: `interfaces: [{ bus, .. }]`, else the legacy
/// `bus_count`. Protocol comes from `traffic_type`.
///
/// The `bus` / `bus_count` coercions match the two other readers of this same
/// config (`create_reader_session` and `broker::spawner::run_virtual_reader`) —
/// the settings form writes these as strings, so a number-only parse silently
/// yields no buses.
fn parse_virtual_interfaces(
    profile: &IOProfile,
    bus_override: Option<u8>,
) -> Option<Vec<BusMapping>> {
    let traffic_type = conn_str(profile, "traffic_type");
    let protocol = protocol_from_str(traffic_type.as_deref());
    let prefix = interface_prefix(protocol);

    let buses: Vec<u8> = match profile
        .connection
        .get("interfaces")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
    {
        Some(interfaces) => interfaces
            .iter()
            .filter_map(|item| coerce_u8(item.as_object()?.get("bus")?))
            .collect(),
        // Legacy profile: a bus count instead of an interface list
        None => {
            let (min, max) = device_kinds::VIRTUAL_BUS_COUNT_RANGE;
            let count = (conn_i64(profile, "bus_count").unwrap_or(1) as u8).clamp(min, max);
            (0..count).collect()
        }
    };

    let mappings: Vec<BusMapping> = buses
        .into_iter()
        .enumerate()
        .map(|(idx, device_bus)| BusMapping {
            device_bus,
            enabled: true,
            output_bus: bus_override.map(|b| b + idx as u8).unwrap_or(device_bus),
            interface_id: format!("{}{}", prefix, device_bus),
            // A virtual adaptor generates one kind of traffic for every bus, so
            // the protocol is the profile's `traffic_type` and there is nothing
            // per-bus to choose.
            supported_protocols: vec![protocol],
            ..BusMapping::default().with_protocol(protocol)
        })
        .collect();

    (!mappings.is_empty()).then_some(mappings)
}

/// How a bus carrying this protocol is named, ahead of its number.
fn interface_prefix(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Modbus | Protocol::ModbusRtu => "modbus",
        Protocol::Serial => "serial",
        Protocol::Can | Protocol::CanFd => "can",
    }
}

/// Settings values arrive as either JSON numbers or strings, depending on
/// which form wrote them. For whole-profile fields prefer `device_kinds::conn_*`,
/// which also consult the kind table's declared default; this is for values
/// inside an `interfaces[]` entry, which those helpers cannot address.
fn coerce_u8(value: &serde_json::Value) -> Option<u8> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .map(|n| n as u8)
}

/// Whether the profile itself says which buses it has.
///
/// A GVRET profile saved before anyone pressed Probe carries only host and
/// port; `profile_bus_mappings` still has to answer something, and answers
/// "one bus". That guess must not outrank a live probe that found two, so the
/// two questions are kept separate.
fn declares_buses(profile: &IOProfile) -> bool {
    let has_interfaces = profile
        .connection
        .get("interfaces")
        .and_then(|v| v.as_array())
        .is_some_and(|a| !a.is_empty());

    has_interfaces
        || profile.connection.contains_key("_probed_bus_count")
        || (profile.kind == "virtual" && profile.connection.contains_key("bus_count"))
        || (profile.kind == "framelink" && profile.connection.contains_key("interface_index"))
}

/// The buses a profile explicitly declares, or None when it declares none.
pub fn declared_bus_mappings(profile: &IOProfile) -> Option<Vec<BusMapping>> {
    declares_buses(profile).then(|| profile_bus_mappings(profile))
}

/// Shift a profile's declared mappings onto a session's output bus range.
/// Enumerators number from 0; the offset is applied once, here.
pub fn offset_bus_mappings(mut mappings: Vec<BusMapping>, output_bus_offset: u8) -> Vec<BusMapping> {
    if output_bus_offset == 0 {
        return mappings;
    }
    for (i, m) in mappings.iter_mut().enumerate() {
        m.output_bus = output_bus_offset + i as u8;
    }
    mappings
}

/// Every bus mapping a profile declares, output buses numbered densely from 0.
///
/// The single source of truth for "what buses does this profile have". The
/// frontend applies its own output-bus offset on top rather than re-deriving
/// the bus list — a second implementation there drifted out of step once and
/// shipped a 2-bus GVRET as a single bus.
pub fn profile_bus_mappings(profile: &IOProfile) -> Vec<BusMapping> {
    let mut mappings = parse_interfaces_from_profile(profile, None)
        .unwrap_or_else(|| create_default_bus_mapping(profile, None));
    for (i, m) in mappings.iter_mut().enumerate() {
        m.output_bus = i as u8;
    }
    mappings
}

/// Create default single-bus mapping for devices without interface configuration.
fn create_default_bus_mapping(profile: &IOProfile, bus_override: Option<u8>) -> Vec<BusMapping> {
    let output_bus = bus_override.unwrap_or_else(|| {
        profile
            .connection
            .get("bus_override")
            .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .map(|v| v as u8)
            .unwrap_or(0)
    });

    // The protocol this kind's single bus carries; the traits follow from it.
    let (device_bus, interface_id, protocol) = match profile.kind.as_str() {
        // FD is a per-profile switch on these, and until now only the frontend
        // read it — Rust answered per kind, so an FD-enabled slcan was *shown*
        // as FD-capable and *ran* as classic CAN.
        "gvret_tcp" | "gvret_usb" | "slcan" | "gs_usb" | "socketcan" => (0, "can0".to_string(), can_protocol_for(profile)),
        "framelink" => {
            // Grouped profile with interfaces[] array
            if let Some(interfaces) = profile.connection.get("interfaces").and_then(|v| v.as_array()) {
                return interfaces.iter().enumerate().map(|(idx, iface)| {
                    let iface_index = iface.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
                    let iface_type = iface.get("iface_type").and_then(|v| v.as_u64()).unwrap_or(1) as u8;
                    let out_bus = bus_override.map(|b| b + idx as u8).unwrap_or(idx as u8);
                    framelink_bus_mapping(iface_index, iface_type, out_bus)
                }).collect();
            }
            // Legacy single-interface fallback
            let iface_index = profile.connection.get("interface_index")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u8;
            let iface_type = profile.connection.get("interface_type")
                .and_then(|v| v.as_u64())
                .unwrap_or(1) as u8;
            return vec![framelink_bus_mapping(iface_index, iface_type, output_bus)];
        }
        kind => {
            let protocol = device_kinds::spec(kind).map_or(Protocol::Can, |s| s.protocol);
            (0, format!("{}0", interface_prefix(protocol)), protocol)
        }
    };

    vec![BusMapping {
        device_bus,
        output_bus,
        enabled: true,
        interface_id,
        supported_protocols: supported_protocols_for_kind(&profile.kind).to_vec(),
        ..BusMapping::default().with_protocol(protocol)
    }]
}

/// Classic CAN or CAN FD, from the profile's `enable_fd` switch.
fn can_protocol_for(profile: &IOProfile) -> Protocol {
    match device_kinds::conn_bool(profile, "enable_fd") {
        Some(true) => Protocol::CanFd,
        _ => Protocol::Can,
    }
}

/// One FrameLink interface's mapping. Its `iface_type` fixes the protocol, so
/// there is nothing per-bus to choose — the same reading the reader applies when
/// the device reports its interfaces, borrowed rather than restated.
fn framelink_bus_mapping(iface_index: u8, iface_type: u8, output_bus: u8) -> BusMapping {
    let protocol = io::framelink::reader::protocol_for_iface_type(iface_type);
    BusMapping {
        device_bus: iface_index,
        output_bus,
        enabled: true,
        interface_id: format!("{}{}", interface_prefix(protocol), iface_index),
        supported_protocols: vec![protocol],
        ..BusMapping::default().with_protocol(protocol)
    }
}

/// Refuse a profile its device would refuse at open, before a session exists to
/// report Running and then fail.
pub(super) fn refuse_at_start(profile: &IOProfile) -> Result<(), String> {
    match profile.kind.as_str() {
        #[cfg(not(target_os = "ios"))]
        "slcan" => io::slcan::reader::slcan_rates(profile)
            .map(drop)
            .map_err(|e| format!("{}: {e}", profile.name)),
        _ => Ok(()),
    }
}

/// One source of a multi-source session, as the picker names it. Rust allocates
/// its output buses; `overrides` carries what the user changed about them.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct MultiSourceInput {
    pub profile_id: String,
    /// Display name for this source (optional, defaults to profile name)
    #[cfg_attr(test, ts(optional))]
    pub display_name: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub overrides: Option<Vec<BusOverride>>,
    /// Serial framing for this source, overriding the device profile. Flattened,
    /// so the wire shape stays the flat keys the frontend has always sent.
    #[serde(flatten)]
    pub serial: SerialOverrides,
}

/// A multi-bus probe's bus count, for a profile that declares none of its own.
fn cached_probed_bus_count(profile_id: &str) -> Option<u8> {
    get_cached_probe(profile_id).filter(|p| p.is_multi_bus).map(|p| p.bus_count)
}

/// The buses a source opens with: what its profile declares, else as many as a
/// probe counted, else its kind's default.
fn source_bus_mappings(profile: &IOProfile, probed_bus_count: Option<u8>) -> Vec<BusMapping> {
    match probed_bus_count.filter(|&n| n > 1 && !declares_buses(profile)) {
        Some(count) => {
            let mut mappings = io::bus_mapping::default_bus_mappings(count.min(io::gvret::MAX_BUSES));
            for m in &mut mappings {
                m.supported_protocols = supported_protocols_for_kind(&profile.kind).to_vec();
            }
            mappings
        }
        None => profile_bus_mappings(profile),
    }
}

/// Lay each source's buses end to end from `first_output_bus`, then apply what
/// the user overrode. Every bus is counted, ticked or not, so unticking one does
/// not move the sources after it.
pub fn allocate_output_buses<'a>(
    sources: impl IntoIterator<Item = (&'a IOProfile, &'a [BusOverride])>,
    first_output_bus: u8,
    probed_bus_count: impl Fn(&str) -> Option<u8>,
) -> Vec<Vec<BusMapping>> {
    let mut next = first_output_bus;
    sources
        .into_iter()
        .map(|(profile, overrides)| {
            let mut mappings = offset_bus_mappings(source_bus_mappings(profile, probed_bus_count(&profile.id)), next);
            next = next.saturating_add(mappings.len() as u8);
            apply_bus_overrides(&mut mappings, overrides);
            io::traits::normalise_bus_traits(&mut mappings, &profile.kind);
            mappings
        })
        .collect()
}

pub(super) fn allocate_inputs<'a>(
    inputs: &[MultiSourceInput],
    settings: &'a AppSettings,
    first_output_bus: u8,
) -> Result<Vec<(&'a IOProfile, Vec<BusMapping>)>, String> {
    let profiles = inputs
        .iter()
        .map(|i| settings.profile(&i.profile_id))
        .collect::<Result<Vec<_>, _>>()?;
    let overrides = inputs.iter().map(|i| i.overrides.as_deref().unwrap_or_default());
    let buses = allocate_output_buses(profiles.iter().copied().zip(overrides), first_output_bus, cached_probed_bus_count);
    Ok(profiles.into_iter().zip(buses).collect())
}

/// Resolve the picker's sources against settings, allocating their output buses
/// from `first_output_bus`.
pub(super) fn resolve_source_configs(
    inputs: Vec<MultiSourceInput>,
    settings: &AppSettings,
    first_output_bus: u8,
) -> Result<Vec<SourceConfig>, String> {
    let allocated = allocate_inputs(&inputs, settings, first_output_bus)?;
    for (profile, _) in &allocated {
        refuse_at_start(profile)?;
    }
    Ok(inputs
        .into_iter()
        .zip(allocated)
        .map(|(input, (profile, bus_mappings))| {
            let mut config = SourceConfig {
                profile_id: input.profile_id,
                profile_kind: profile.kind.clone(),
                display_name: input.display_name.unwrap_or_else(|| profile.name.clone()),
                bus_mappings,
                ..SourceConfig::default()
            };
            // A multi-source serial interface the picker left alone arrives with no
            // framing either, and the broker reads this config the same way.
            apply_serial_overrides(&mut config, profile, input.serial);
            config
        })
        .collect())
}

#[cfg(test)]
mod bus_mapping_tests {
    use super::*;
    use serde_json::json;
    use crate::sessions::profile;

    fn gvret(connection: serde_json::Value) -> IOProfile {
        profile("gvret_tcp", connection)
    }

    #[test]
    fn gvret_yields_one_mapping_per_declared_interface() {
        let mappings = profile_bus_mappings(&gvret(json!({
            "interfaces": [
                { "device_bus": 0, "enabled": true, "protocol": "can" },
                { "device_bus": 1, "enabled": true, "protocol": "canfd" },
            ]
        })));

        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[0].device_bus, 0);
        assert_eq!(mappings[1].device_bus, 1);
        assert_eq!(mappings[0].output_bus, 0);
        assert_eq!(mappings[1].output_bus, 1);
        assert_eq!(mappings[1].interface_id, "can1");
        let traits = mappings[1].traits.as_ref().unwrap();
        assert!(traits.protocols.contains(&Protocol::CanFd));
    }

    #[test]
    fn gvret_keeps_a_profile_disabled_bus_marked_disabled() {
        let mappings = profile_bus_mappings(&gvret(json!({
            "interfaces": [
                { "device_bus": 0, "enabled": true, "protocol": "can" },
                { "device_bus": 1, "enabled": false, "protocol": "can" },
            ]
        })));

        assert_eq!(mappings.len(), 2, "a disabled bus stays in the list");
        assert!(mappings[0].enabled);
        assert!(!mappings[1].enabled);
    }

    #[test]
    fn gvret_falls_back_to_the_probed_bus_count() {
        let mappings = profile_bus_mappings(&gvret(json!({ "_probed_bus_count": 3 })));
        assert_eq!(mappings.len(), 3);
        assert!(mappings.iter().all(|m| m.enabled));
        assert_eq!(mappings[2].device_bus, 2);
    }

    #[test]
    fn gvret_prefers_saved_interfaces_over_the_probe_count() {
        let mappings = profile_bus_mappings(&gvret(json!({
            "_probed_bus_count": 4,
            "interfaces": [{ "device_bus": 0, "enabled": true, "protocol": "can" }]
        })));
        assert_eq!(mappings.len(), 1, "the user's saved config wins");
    }

    #[test]
    fn never_probed_gvret_yields_a_single_bus() {
        assert_eq!(profile_bus_mappings(&gvret(json!({}))).len(), 1);
    }

    #[test]
    fn output_buses_stay_dense_for_sparse_device_buses() {
        let mappings = profile_bus_mappings(&gvret(json!({
            "interfaces": [
                { "device_bus": 0, "enabled": true, "protocol": "can" },
                { "device_bus": 3, "enabled": true, "protocol": "can" },
            ]
        })));
        assert_eq!(mappings[1].device_bus, 3);
        assert_eq!(mappings[1].output_bus, 1);
    }

    #[test]
    fn framelink_types_each_interface_by_iface_type() {
        let mappings = profile_bus_mappings(&profile("framelink", json!({
            "interfaces": [
                { "index": 0, "iface_type": 1 },
                { "index": 1, "iface_type": 2 },
                { "index": 2, "iface_type": 3 },
            ]
        })));

        assert_eq!(mappings.len(), 3);
        assert_eq!(mappings[2].interface_id, "serial2");
        let serial = mappings[2].traits.as_ref().unwrap();
        assert!(serial.tx_bytes);
        assert!(!serial.tx_frames);
        let fd = mappings[1].traits.as_ref().unwrap();
        assert!(fd.protocols.contains(&Protocol::CanFd));
    }

    #[test]
    fn virtual_yields_one_mapping_per_interface() {
        let mappings = profile_bus_mappings(&profile("virtual", json!({
            "traffic_type": "canfd",
            "interfaces": [{ "bus": 0 }, { "bus": 1 }, { "bus": 2 }]
        })));

        assert_eq!(mappings.len(), 3, "virtual multi-bus must not collapse to one");
        assert_eq!(mappings[2].device_bus, 2);
        assert!(mappings[0].traits.as_ref().unwrap().protocols.contains(&Protocol::CanFd));
    }

    #[test]
    fn a_probed_gvret_bus_carries_what_a_configured_one_does() {
        // Regression: the two enumerators disagreed. A bus configured in
        // Settings without an explicit protocol came out classic CAN, while one
        // synthesised from a bare probe count came out CAN FD — so the same
        // device advertised different capabilities depending on which path had
        // described it. What they agree *on* matters less than that they agree;
        // the picker's protocol dropdown is how a bus is told it carries FD.
        let probed = profile_bus_mappings(&gvret(json!({ "_probed_bus_count": 2 })));
        let configured = profile_bus_mappings(&gvret(json!({
            "interfaces": [{ "device_bus": 0, "enabled": true }]
        })));

        assert_eq!(probed[0].protocol, configured[0].protocol);
        assert_eq!(
            probed[0].traits.as_ref().unwrap().protocols,
            configured[0].traits.as_ref().unwrap().protocols,
        );
    }

    #[test]
    fn a_bus_protocol_decides_its_traits() {
        // `traits` is derived output: setting the protocol is the only way to
        // move it, so the two cannot drift apart.
        let mappings = profile_bus_mappings(&gvret(json!({
            "interfaces": [
                { "device_bus": 0, "enabled": true, "protocol": "can" },
                { "device_bus": 1, "enabled": true, "protocol": "canfd" },
            ]
        })));

        assert_eq!(mappings[0].protocol, Protocol::Can);
        assert!(!mappings[0].traits.as_ref().unwrap().protocols.contains(&Protocol::CanFd));
        assert_eq!(mappings[1].protocol, Protocol::CanFd);
        assert!(mappings[1].traits.as_ref().unwrap().protocols.contains(&Protocol::CanFd));
    }

    #[test]
    fn traits_sent_from_the_frontend_are_rebuilt_from_the_protocol() {
        // The frontend no longer sends traits at all, but a stale or
        // hand-written blob must not be believed if one arrives.
        let mut mappings = vec![BusMapping {
            traits: Some(io::traits::traits_for_protocol(Protocol::Serial)),
            ..BusMapping::default().with_protocol(Protocol::CanFd)
        }];
        // Undo `with_protocol`'s derivation so traits and protocol disagree.
        mappings[0].traits = Some(io::traits::traits_for_protocol(Protocol::Serial));

        io::traits::normalise_bus_traits(&mut mappings, "slcan");

        let traits = mappings[0].traits.as_ref().unwrap();
        assert!(traits.protocols.contains(&Protocol::CanFd));
        assert!(!traits.protocols.contains(&Protocol::Serial));
        assert!(traits.tx_frames, "a CAN FD bus transmits frames, not bytes");
    }

    #[test]
    fn a_gvret_bus_saved_as_can_fd_opens_as_classic_can() {
        let saved = gvret(json!({
            "interfaces": [{ "device_bus": 0, "enabled": true, "protocol": "canfd" }]
        }));
        let single = create_source_config_from_profile(&saved, None, SerialOverrides::default())
            .unwrap()
            .bus_mappings;
        let mut multi = profile_bus_mappings(&saved);
        io::traits::normalise_bus_traits(&mut multi, "gvret_tcp");

        for (path, mappings) in [("single", single), ("multi", multi)] {
            assert_eq!(mappings[0].protocol, Protocol::Can, "{path}");
            let traits = mappings[0].traits.as_ref().unwrap();
            assert!(!traits.protocols.contains(&Protocol::CanFd), "{path}: {traits:?}");
        }
    }

    #[test]
    fn a_serial_framelink_bus_is_not_clamped_to_can() {
        // Regression: normalising against the *kind's* protocol list rewrote a
        // FrameLink RS485 port to CAN, because "framelink" as a kind offers
        // [Can, CanFd] while that individual interface carries Serial. The
        // per-bus answer is the finer one and has to win.
        let mut mappings = profile_bus_mappings(&profile("framelink", json!({
            "interfaces": [{ "index": 2, "iface_type": 3 }]
        })));

        io::traits::normalise_bus_traits(&mut mappings, "framelink");

        assert_eq!(mappings[0].protocol, Protocol::Serial);
        let traits = mappings[0].traits.as_ref().unwrap();
        assert!(traits.protocols.contains(&Protocol::Serial));
        assert!(traits.tx_bytes, "a serial port transmits raw bytes");
    }

    #[test]
    fn virtual_accepts_a_bus_written_as_a_string() {
        // The settings form writes these as strings; a number-only parse
        // yielded zero buses and silently fell back to a single bus.
        let mappings = profile_bus_mappings(&profile("virtual", json!({
            "interfaces": [{ "bus": "0" }, { "bus": "1" }]
        })));
        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[1].device_bus, 1);
    }

    #[test]
    fn virtual_falls_back_to_the_legacy_bus_count() {
        let mappings = profile_bus_mappings(&profile("virtual", json!({ "bus_count": "3" })));
        assert_eq!(mappings.len(), 3);
    }

    #[test]
    fn framelink_with_no_mappings_keeps_all_its_interfaces() {
        // resolve_source_config used to hand FrameLink a lone bus-0 default
        // because parse_interfaces_from_profile returns None for it.
        let mappings = profile_bus_mappings(&profile("framelink", json!({
            "interfaces": [{ "index": 0, "iface_type": 1 }, { "index": 1, "iface_type": 3 }]
        })));
        assert_eq!(mappings.len(), 2);
    }

    #[test]
    fn an_slcan_rate_the_protocol_cannot_name_refuses_the_start() {
        let slcan = |connection| profile("slcan", connection);
        let error = refuse_at_start(&slcan(json!({ "port": "/dev/x", "bitrate": 33_333 })))
            .expect_err("SLCAN has no command for 33 333 bit/s");
        assert!(error.contains("33333") && error.contains("10000"), "{error}");
        assert!(refuse_at_start(&slcan(json!({ "port": "/dev/x", "bitrate": 500_000 }))).is_ok());
        let fd = json!({ "port": "/dev/x", "bitrate": 500_000, "enable_fd": true, "data_bitrate": 3_000_000 });
        assert!(refuse_at_start(&slcan(fd)).is_err(), "nor a data rate it cannot name");
    }

    #[test]
    fn offset_shifts_output_buses_and_leaves_device_buses_alone() {
        let mappings = offset_bus_mappings(
            profile_bus_mappings(&gvret(json!({
                "interfaces": [
                    { "device_bus": 0, "enabled": true, "protocol": "can" },
                    { "device_bus": 1, "enabled": true, "protocol": "can" },
                ]
            }))),
            2,
        );
        assert_eq!(mappings.iter().map(|m| m.output_bus).collect::<Vec<_>>(), vec![2, 3]);
        assert_eq!(mappings.iter().map(|m| m.device_bus).collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn a_profile_that_declares_nothing_declares_nothing() {
        // A GVRET saved before anyone pressed Probe carries only host and port.
        // profile_bus_mappings still has to answer, and answers "one bus" — but
        // that guess must not reach the picker as a declaration, or it outranks
        // a live probe that found two.
        let bare = gvret(json!({ "host": "127.0.0.1", "port": "2323" }));
        assert_eq!(profile_bus_mappings(&bare).len(), 1);
        assert!(declared_bus_mappings(&bare).is_none());
    }

    #[test]
    fn a_probed_or_configured_profile_does_declare() {
        assert!(declared_bus_mappings(&gvret(json!({ "_probed_bus_count": 2 }))).is_some());
        assert!(declared_bus_mappings(&gvret(json!({
            "interfaces": [{ "device_bus": 0, "enabled": true, "protocol": "can" }]
        }))).is_some());
        assert!(declared_bus_mappings(&profile("virtual", json!({ "bus_count": "2" }))).is_some());
        assert!(declared_bus_mappings(&profile("slcan", json!({}))).is_none());
    }

    #[test]
    fn single_bus_kinds_yield_one_mapping() {
        assert_eq!(profile_bus_mappings(&profile("slcan", json!({}))).len(), 1);
    }

    // ── session creation ────────────────────────────────────────────────────
    // resolve_source_configs is the funnel every multi-source session goes
    // through, and allocate_output_buses the one count of its output buses.

    fn settings_with(profiles: Vec<IOProfile>) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.io_profiles = profiles;
        settings
    }

    fn input_for(profile_id: &str, overrides: serde_json::Value) -> MultiSourceInput {
        serde_json::from_value(json!({ "profile_id": profile_id, "overrides": overrides }))
            .expect("MultiSourceInput should deserialise")
    }

    fn two_bus_gvret() -> IOProfile {
        gvret(json!({
            "interfaces": [
                { "device_bus": 0, "enabled": true, "protocol": "can" },
                { "device_bus": 1, "enabled": true, "protocol": "can" },
            ]
        }))
    }

    fn resolve(profile: IOProfile, overrides: serde_json::Value, first_output_bus: u8) -> SourceConfig {
        let id = profile.id.clone();
        resolve_source_configs(vec![input_for(&id, overrides)], &settings_with(vec![profile]), first_output_bus)
            .expect("profile is present, so this resolves")
            .remove(0)
    }

    fn output_buses(mappings: &[BusMapping]) -> Vec<u8> {
        mappings.iter().map(|m| m.output_bus).collect()
    }

    #[test]
    fn a_source_opens_every_bus_the_profile_declares() {
        let config = resolve(two_bus_gvret(), json!([]), 0);
        assert_eq!(config.bus_mappings.len(), 2, "a 2-bus device must not resolve to one bus");
        assert_eq!(config.bus_mappings.iter().map(|m| m.device_bus).collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn framelink_interfaces_are_kept_too() {
        // Regression: this path consulted a GVRET-only parser, so FrameLink fell
        // through to a hand-rolled single bus 0 even though its interfaces were
        // right there in the profile.
        let config = resolve(
            profile("framelink", json!({
                "interfaces": [
                    { "index": 0, "iface_type": 1 },
                    { "index": 1, "iface_type": 2 },
                    { "index": 2, "iface_type": 3 },
                ]
            })),
            json!([]),
            0,
        );
        assert_eq!(config.bus_mappings.len(), 3);
        assert_eq!(config.bus_mappings[2].interface_id, "serial2");
    }

    #[test]
    fn sources_are_laid_end_to_end_by_bus_count_not_source_index() {
        let mut slcan = profile("slcan", json!({}));
        slcan.id = "p-slcan".into();
        let settings = settings_with(vec![two_bus_gvret(), slcan]);
        let configs = resolve_source_configs(
            vec![input_for("p-gvret_tcp", json!([])), input_for("p-slcan", json!([]))],
            &settings,
            0,
        )
        .unwrap();
        assert_eq!(output_buses(&configs[0].bus_mappings), vec![0, 1]);
        assert_eq!(output_buses(&configs[1].bus_mappings), vec![2], "source 1 starts after source 0's two buses");
    }

    #[test]
    fn a_source_added_to_a_session_starts_after_its_buses() {
        assert_eq!(output_buses(&resolve(two_bus_gvret(), json!([]), 3).bus_mappings), vec![3, 4]);
    }

    #[test]
    fn the_users_overrides_are_applied_over_the_allocation() {
        let config = resolve(
            two_bus_gvret(),
            json!([
                { "device_bus": 0, "output_bus": 4 },
                { "device_bus": 1, "enabled": false },
                { "device_bus": 7, "enabled": false },
            ]),
            0,
        );
        assert_eq!(output_buses(&config.bus_mappings), vec![4, 1]);
        assert!(!config.bus_mappings[1].enabled);
    }

    #[test]
    fn a_gvret_bus_offers_no_protocol_but_classic_can() {
        let probed = allocate_output_buses([(&gvret(json!({})), &[][..])], 0, |_| Some(2));
        for bus in profile_bus_mappings(&two_bus_gvret()).iter().chain(&probed[0]) {
            assert_eq!(bus.supported_protocols, vec![Protocol::Can], "the dropdown must not offer what runs as CAN");
        }
    }

    #[test]
    fn an_unticked_bus_still_holds_its_place() {
        let gvret = two_bus_gvret();
        let slcan = profile("slcan", json!({}));
        let unticked = [BusOverride { device_bus: 1, enabled: Some(false), ..Default::default() }];
        let buses = allocate_output_buses([(&gvret, &unticked[..]), (&slcan, &[][..])], 0, |_| None);
        assert_eq!(output_buses(&buses[1]), vec![2]);
    }

    #[test]
    fn a_probe_counts_the_buses_of_a_profile_that_declares_none() {
        let bare = gvret(json!({ "host": "127.0.0.1", "port": "2323" }));
        let buses = allocate_output_buses([(&bare, &[][..])], 0, |_| Some(3));
        assert_eq!(output_buses(&buses[0]), vec![0, 1, 2]);
        assert_eq!(buses[0][2].interface_id, "can2");

        let declared = two_bus_gvret();
        let buses = allocate_output_buses([(&declared, &[][..])], 0, |_| Some(3));
        assert_eq!(buses[0].len(), 2, "what the profile declares outranks a probe");
    }

    #[test]
    fn a_profile_that_declares_nothing_and_was_never_probed_opens_one_bus() {
        let config = resolve(gvret(json!({ "host": "127.0.0.1", "port": "2323" })), json!([]), 0);
        assert_eq!(config.bus_mappings.len(), 1);
        assert_eq!(config.bus_mappings[0].device_bus, 0);
    }

    #[test]
    fn an_unknown_profile_is_an_error_not_a_default_session() {
        assert!(resolve_source_configs(vec![input_for("io_missing", json!([]))], &settings_with(vec![]), 0).is_err());
    }

    /// The TypeScript assembly's answers, taken before it was deleted. Rust
    /// matches each case except where the case names why it differs.
    #[test]
    fn rust_allocates_what_the_typescript_assembly_did_bar_its_named_bugs() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../io/bus_mapping/ts-allocation-golden.json")).unwrap();
        let profiles: Vec<IOProfile> = golden["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let mut profile = profile(p["kind"].as_str().unwrap(), p["connection"].clone());
                profile.id = p["id"].as_str().unwrap().into();
                profile
            })
            .collect();
        let probed = |id: &str| {
            let probe = &golden["probes"][id];
            probe["is_multi_bus"].as_bool().unwrap().then(|| probe["bus_count"].as_u64().unwrap() as u8)
        };

        for case in golden["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let ids: Vec<&str> = case["selection"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            let overrides: Vec<Vec<BusOverride>> = ids
                .iter()
                .map(|id| serde_json::from_value(case["overrides"].get(*id).cloned().unwrap_or(json!([]))).unwrap())
                .collect();
            let sources = ids.iter().zip(&overrides).map(|(id, o)| (profiles.iter().find(|p| p.id == *id).unwrap(), o.as_slice()));
            let ours = allocate_output_buses(sources, 0, probed);

            for (id, buses) in ids.iter().zip(&ours) {
                if let Some(rust) = case["differs"]["rust"].get(*id) {
                    assert_eq!(json!(output_buses(buses)), *rust, "{name}: {id} output buses");
                    continue;
                }
                let ts = case["ts"][*id].as_array().unwrap();
                assert_eq!(buses.len(), ts.len(), "{name}: {id} bus count");
                for (m, t) in buses.iter().zip(ts) {
                    assert_eq!(m.output_bus as u64, t["output_bus"].as_u64().unwrap(), "{name}: {id}");
                    assert_eq!(m.device_bus as u64, t["device_bus"].as_u64().unwrap(), "{name}: {id}");
                    assert_eq!(m.enabled, t["enabled"].as_bool().unwrap(), "{name}: {id}");
                    assert_eq!(m.interface_id, t["interface_id"].as_str().unwrap(), "{name}: {id}");
                }
                let protocols: Vec<serde_json::Value> = buses.iter().map(|m| json!(m.protocol)).collect();
                let expected = case["differs"]["rust_protocol"]
                    .get(*id)
                    .cloned()
                    .unwrap_or_else(|| json!(ts.iter().map(|m| m["protocol"].clone()).collect::<Vec<_>>()));
                assert_eq!(json!(protocols), expected, "{name}: {id} protocols");
            }
        }
    }
}

#[cfg(test)]
mod reader_source_config_tests {
    use super::*;

    fn modbus_profile() -> IOProfile {
        IOProfile {
            id: "p-modbus".into(),
            name: "modbus".into(),
            kind: "modbus_tcp".into(),
            connection: Default::default(),
            preferred_catalog: None,
            ephemeral: false,
        }
    }

    #[test]
    fn a_single_modbus_source_polls_what_its_caller_asked_for() {
        let polls = r#"[{"register_type":"holding","start_register":10,"count":4,
            "interval_ms":1000,"frame_id":10}]"#;
        let config = reader_source_config(
            &modbus_profile(),
            None,
            SerialOverrides::default(),
            Some(polls),
            7,
        )
        .unwrap();

        let polls = config
            .modbus_polls
            .expect("the caller's polls were dropped");
        assert_eq!(polls.len(), 1);
        assert_eq!(polls[0].start_register, 10);
        assert_eq!(config.max_register_errors, Some(7));
    }
}
