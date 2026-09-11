// ui/src-tauri/src/sessions.rs
//
// Tauri commands for IO session lifecycle.
// Handles session creation, control (start/stop/pause/resume), and destruction.

use crate::{
    capture_store,
    credentials,
    io::{
        self,
        create_session, destroy_session, get_session_capabilities, get_session_joiner_count, get_session_state,
        get_session_subscribers, get_session_source_configs, list_sessions, pause_session,
        reconfigure_session, register_subscriber, reinitialize_session_if_safe, resume_session,
        resume_session_fresh, seek_session, seek_session_by_frame, set_subscriber_active, start_session, stop_session,
        stop_and_switch_to_capture, suspend_session, switch_to_capture_replay, resume_to_live_session, transmit_frame, unregister_subscriber,
        evict_session_subscriber, leave_session_to_capture, add_source_to_session, remove_source_from_session, update_source_bus_mappings, set_source_polling, get_session_source_count,
        update_session_direction, update_session_speed, update_session_time_range, ActiveSessionInfo, IOCapabilities, IOSource, IOState,
        SubscriberInfo, RegisterSubscriberResult, ReinitializeResult, CaptureSource, step_frame, StepResult,
        BusMapping, Protocol, TemporalMode,
        GvretDeviceInfo, probe_gvret_tcp,
        ModbusTcpConfig, ModbusTcpSource,
        ModbusRangeSpec, PollGroup,
        MqttConfig, MqttSource,
        VirtualDeviceConfig, VirtualSource, VirtualInterfaceConfig, VirtualTrafficType,
        IOBroker, SerialOverrides, SourceConfig,
        BackendApiConfig, BackendApiSource, BackendApiSourceOptions,
        CanTransmitFrame, TransmitResult,
        emit_device_probe, DeviceProbePayload,
        set_wake_settings as io_set_wake_settings,
    },
    profile_tracker,
    settings::{self, AppSettings, IOProfile},
};
#[cfg(not(target_os = "ios"))]
use crate::io::device_kinds::{self, conn_f64, conn_i64, conn_str, req_str};
use crate::io::traits::supported_protocols_for_kind;
use crate::io::probe_gvret_usb;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{
    atomic::AtomicBool,
    Arc, Mutex,
};

/// Map of session_id -> profile_ids for tracking which profiles each reader session uses.
/// Multi-source sessions can use multiple profiles, so we store a Vec.
/// Used to unregister profile usage when a session is destroyed.
static SESSION_PROFILES: Lazy<Mutex<HashMap<String, Vec<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Map of profile_id -> session_ids for tracking which sessions use each profile.
/// This is the reverse of SESSION_PROFILES and is used to:
/// 1. Show "(in use: sessionId)" indicator in IO picker
/// 2. Lock reconfiguration when profile is in 2+ sessions
/// 3. Prevent parallel sessions from exclusive-access devices
static PROFILE_SESSIONS: Lazy<Mutex<HashMap<String, std::collections::HashSet<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Cache of successful probe results by profile_id.
/// When a device is probed successfully, the result is cached so subsequent probes
/// (e.g., when the device is already running) return instantly without reconnecting.
static PROBE_CACHE: Lazy<Mutex<HashMap<String, DeviceProbeResult>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Cache a successful probe result for a profile
fn cache_probe_result(profile_id: &str, result: &DeviceProbeResult) {
    if result.success {
        if let Ok(mut cache) = PROBE_CACHE.lock() {
            cache.insert(profile_id.to_string(), result.clone());
        }
    }
}

/// Get a cached probe result for a profile
fn get_cached_probe(profile_id: &str) -> Option<DeviceProbeResult> {
    PROBE_CACHE.lock().ok()?.get(profile_id).cloned()
}

/// Clear the cached probe result for a profile (called when device errors or disconnects)
pub fn clear_probe_cache(profile_id: &str) {
    if let Ok(mut cache) = PROBE_CACHE.lock() {
        cache.remove(profile_id);
    }
}

/// Drop a profile's cached probe after its connection parameters changed.
/// Editing a saved device keeps its id, so without this the next probe would
/// report the device it used to point at.
#[tauri::command(rename_all = "snake_case")]
pub fn clear_profile_probe_cache(profile_id: String) {
    clear_probe_cache(&profile_id);
}

/// Track that a session is using a specific profile.
/// For multi-source sessions, call this multiple times or use register_session_profiles.
fn register_session_profile(session_id: &str, profile_id: &str) {
    // Update SESSION_PROFILES (session -> profiles)
    if let Ok(mut map) = SESSION_PROFILES.lock() {
        let profiles = map.entry(session_id.to_string()).or_insert_with(Vec::new);
        if !profiles.contains(&profile_id.to_string()) {
            profiles.push(profile_id.to_string());
        }
    }

    // Update PROFILE_SESSIONS (profile -> sessions)
    if let Ok(mut map) = PROFILE_SESSIONS.lock() {
        let sessions = map
            .entry(profile_id.to_string())
            .or_insert_with(std::collections::HashSet::new);
        sessions.insert(session_id.to_string());
    }
}

/// Track that a session is using multiple profiles (for multi-source sessions).
fn register_session_profiles(session_id: &str, profile_ids: &[String]) {
    // Update SESSION_PROFILES (session -> profiles)
    if let Ok(mut map) = SESSION_PROFILES.lock() {
        map.insert(session_id.to_string(), profile_ids.to_vec());
    }

    // Update PROFILE_SESSIONS (profile -> sessions)
    if let Ok(mut map) = PROFILE_SESSIONS.lock() {
        for profile_id in profile_ids {
            let sessions = map
                .entry(profile_id.clone())
                .or_insert_with(std::collections::HashSet::new);
            sessions.insert(session_id.to_string());
        }
    }
}

/// Get and remove all profile_ids for a session (called during destroy).
/// Returns all profiles that were registered for this session.
/// Also cleans up the reverse mapping (PROFILE_SESSIONS).
fn take_session_profiles(session_id: &str) -> Vec<String> {
    let profile_ids = SESSION_PROFILES
        .lock()
        .ok()
        .and_then(|mut map| map.remove(session_id))
        .unwrap_or_default();

    // Clean up reverse mapping
    if let Ok(mut map) = PROFILE_SESSIONS.lock() {
        for profile_id in &profile_ids {
            if let Some(sessions) = map.get_mut(profile_id) {
                sessions.remove(session_id);
                // Remove the entry if no sessions remain
                if sessions.is_empty() {
                    map.remove(profile_id);
                }
            }
        }
    }

    profile_ids
}

/// Replace all profile IDs for a session (e.g., swap device profiles for capture ID).
/// Cleans up old reverse mappings and sets new ones.
pub fn replace_session_profiles(session_id: &str, new_profile_ids: &[String]) {
    // Remove old reverse mappings
    if let Ok(map) = SESSION_PROFILES.lock() {
        if let Some(old_ids) = map.get(session_id) {
            if let Ok(mut rev) = PROFILE_SESSIONS.lock() {
                for old_id in old_ids {
                    if let Some(sessions) = rev.get_mut(old_id) {
                        sessions.remove(session_id);
                        if sessions.is_empty() {
                            rev.remove(old_id);
                        }
                    }
                }
            }
        }
    }

    // Set new profile IDs
    if let Ok(mut map) = SESSION_PROFILES.lock() {
        map.insert(session_id.to_string(), new_profile_ids.to_vec());
    }

    // Add new reverse mappings
    if let Ok(mut rev) = PROFILE_SESSIONS.lock() {
        for id in new_profile_ids {
            rev.entry(id.clone())
                .or_insert_with(std::collections::HashSet::new)
                .insert(session_id.to_string());
        }
    }
}

/// Get all profile IDs for a session (without removing them).
/// Used for listing active sessions with their source profiles.
pub fn get_session_profile_ids(session_id: &str) -> Vec<String> {
    SESSION_PROFILES
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).cloned())
        .unwrap_or_default()
}

/// Get all session IDs that are using a specific profile.
/// Used to show "(in use: sessionId)" in the IO picker.
pub fn get_sessions_for_profile(profile_id: &str) -> Vec<String> {
    PROFILE_SESSIONS
        .lock()
        .ok()
        .and_then(|map| map.get(profile_id).map(|s| s.iter().cloned().collect()))
        .unwrap_or_default()
}

/// Get the count of sessions using a specific profile.
/// Used to determine if reconfiguration should be locked (locked if >= 2).
pub fn get_session_count_for_profile(profile_id: &str) -> usize {
    PROFILE_SESSIONS
        .lock()
        .ok()
        .and_then(|map| map.get(profile_id).map(|s| s.len()))
        .unwrap_or(0)
}

/// Clean up profile tracking for a destroyed session.
/// This should be called when a session is destroyed via unregister_subscriber
/// (auto-destroy when last subscriber leaves), since that code path doesn't
/// go through destroy_reader_session which normally handles this.
pub fn cleanup_session_profiles(session_id: &str) {
    let profile_ids = take_session_profiles(session_id);
    for profile_id in profile_ids {
        profile_tracker::unregister_usage_by_session(&profile_id, session_id);
    }
}

fn choose_profile_by_id(settings: &AppSettings, profile_id: Option<&str>) -> Option<IOProfile> {
    if let Some(id) = profile_id {
        settings.io_profiles.iter().find(|p| p.id == id).cloned()
    } else if let Some(id) = &settings.default_read_profile {
        settings.io_profiles.iter().find(|p| p.id == *id).cloned()
    } else {
        // Return the first profile as a fallback
        settings.io_profiles.first().cloned()
    }
}

/// Map a profile kind to its output protocol family ("can" | "serial" | "modbus"
/// | "unknown"). Used to pick a session-id prefix.
fn protocol_for_kind(kind: &str) -> &'static str {
    match kind {
        "gvret_tcp" | "gvret_usb" | "slcan" | "gs_usb" | "socketcan" | "mqtt" | "framelink" | "virtual" => "can",
        "serial" => "serial",
        "modbus_tcp" | "modbus_rtu" => "modbus",
        _ => "unknown",
    }
}

/// A random 6-hex-char id suffix (matches the previous frontend scheme).
fn random_hex6() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0),
    );
    format!("{:06x}", hasher.finish() & 0xFF_FFFF)
}

/// Generate an opaque realtime session id. The prefix (modbus → m_, raw serial →
/// b_, CAN/framed serial → f_, otherwise s_) is inferred from the profiles' output
/// type. It is cosmetic — nothing parses the id — but owned here, not in the
/// frontend. Modbus anywhere wins; otherwise the first resolvable profile decides
/// (matches the old frontend behaviour of keying on the first enabled mapping).
///
/// Whether a serial source emits bytes is resolved here rather than taken from
/// the caller: the frontend does not know a profile's framing before the session
/// exists, so it always said `false` and every raw serial session came out `f_`.
/// An explicit `emit_raw_bytes` still wins — the picker's "Capture raw bytes"
/// puts bytes on a framed link.
#[tauri::command(rename_all = "snake_case")]
pub async fn generate_session_id(
    app: tauri::AppHandle,
    profile_ids: Vec<String>,
    emit_raw_bytes: Option<bool>,
) -> Result<String, String> {
    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;
    let mut protocol: Option<&str> = None;
    let mut emits_bytes = false;
    for id in &profile_ids {
        if let Some(p) = settings.io_profiles.iter().find(|p| &p.id == id) {
            let proto = protocol_for_kind(&p.kind);
            if proto == "serial" {
                emits_bytes |=
                    device_kinds::resolve_serial_framing(p, None, emit_raw_bytes).1;
            }
            if proto == "modbus" {
                protocol = Some("modbus");
                break;
            }
            if protocol.is_none() {
                protocol = Some(proto);
            }
        }
    }
    let prefix = match protocol {
        Some("modbus") => "m",
        Some("serial") if emits_bytes => "b",
        Some("can") | Some("serial") => "f",
        _ => "s",
    };
    Ok(format!("{}_{}", prefix, random_hex6()))
}

/// Check if a profile kind is a real-time device that can use IOBroker.
/// These devices support the multi-source architecture for unified session handling.
fn is_realtime_device(kind: &str) -> bool {
    matches!(
        kind,
        "gvret_tcp" | "gvret_usb" | "slcan" | "gs_usb" | "socketcan" | "serial" | "modbus_tcp" | "virtual" | "framelink"
    )
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
        config.serial.framing_encoding.as_deref(),
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
fn create_source_config_from_profile(
    profile: &IOProfile,
    bus_override: Option<u8>,
    serial: SerialOverrides,
) -> Option<SourceConfig> {
    if !is_realtime_device(&profile.kind) {
        return None;
    }

    // Try to read interfaces configuration from profile (for GVRET multi-bus)
    let bus_mappings = if let Some(mappings) = parse_interfaces_from_profile(profile, bus_override)
    {
        mappings
    } else {
        // Fall back to default single bus mapping
        create_default_bus_mapping(profile, bus_override)
    };

    let mut config = SourceConfig {
        profile_id: profile.id.clone(),
        profile_kind: profile.kind.clone(),
        display_name: profile.name.clone(),
        bus_mappings,
        // Modbus fields - populated later by create_multi_source_session
        modbus_polls: None,
        max_register_errors: None,
        ..SourceConfig::default()
    };
    apply_serial_overrides(&mut config, profile, serial);
    Some(config)
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
    let prefix = match protocol {
        Protocol::Modbus | Protocol::ModbusRtu => "modbus",
        Protocol::Serial => "serial",
        Protocol::Can | Protocol::CanFd => "can",
    };

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

/// Bus mappings every IO profile declares, keyed by profile id.
///
/// One round trip for the whole profile list: callers cache this and read it
/// synchronously, so the picker and the session graph stay non-async.
#[tauri::command(rename_all = "snake_case")]
pub fn get_profile_bus_mappings(
    app: tauri::AppHandle,
) -> Result<HashMap<String, Vec<BusMapping>>, String> {
    // Sync load deliberately: `load_settings` can *write* settings.json on its
    // migration paths, and a read-only getter has no business doing that.
    let settings = settings::load_settings_sync(&app)
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    // Only profiles that actually declare their buses. A profile that declares
    // nothing is omitted rather than sent as a synthetic single bus, so the
    // caller can prefer a live probe over our guess.
    Ok(settings
        .io_profiles
        .iter()
        .filter_map(|p| Some((p.id.clone(), declared_bus_mappings(p)?)))
        .collect())
}

/// What each profile kind's buses may be set to, keyed by kind.
///
/// The options the source picker's per-bus protocol dropdown renders. Fetched
/// once and cached beside the bus mappings, so the picker can answer
/// synchronously for a device it has only just probed — one whose profile
/// declares no buses yet, and so has no mapping to read the list off.
///
/// A kind with fewer than two entries has nothing to choose and gets no
/// dropdown. The *values* live in `io::traits`; this only carries them across.
#[tauri::command(rename_all = "snake_case")]
pub fn get_supported_protocols() -> HashMap<String, Vec<Protocol>> {
    io::traits::profile_kinds()
        .map(|kind| (kind.to_string(), supported_protocols_for_kind(kind).to_vec()))
        .collect()
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
        "modbus_tcp" => (0, "modbus0".to_string(), Protocol::Modbus),
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
        _ => (0, "can0".to_string(), Protocol::Can),
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
    let prefix = if protocol == Protocol::Serial { "serial" } else { "can" };
    BusMapping {
        device_bus: iface_index,
        output_bus,
        enabled: true,
        interface_id: format!("{}{}", prefix, iface_index),
        supported_protocols: vec![protocol],
        ..BusMapping::default().with_protocol(protocol)
    }
}

/// Create a new reader session
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn create_reader_session(
    app: tauri::AppHandle,
    session_id: String,
    profile_id: Option<String>,
    start_time: Option<String>,
    end_time: Option<String>,
    speed: Option<f64>,
    limit: Option<i64>,
    _file_path: Option<String>,
    // Bus override for single-bus devices (overrides profile config)
    bus_override: Option<u8>,
    // Listener ID (for session logging)
    subscriber_id: Option<String>,
    // Human-readable app name (e.g., "discovery", "decoder")
    app_name: Option<String>,
    // Modbus TCP poll groups (JSON-serialised from frontend catalog)
    modbus_polls: Option<String>,
    // Serial framing chosen in the picker, overriding the device profile.
    // These arrived as eleven flat parameters until Feb 2026, when they were
    // removed as unused — they were unread here, but the frontend was, and still
    // is, sending them, so the picker's framing dropdown and its "Capture raw
    // bytes" tick quietly went nowhere on the single-device path.
    // Optional so a caller with nothing to say — MCP — can omit it.
    serial: Option<SerialOverrides>,
) -> Result<IOCapabilities, String> {
    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = choose_profile_by_id(&settings, profile_id.as_deref())
        .ok_or_else(|| "No IO profile configured".to_string())?;

    // Check if this profile is already in use (for single-handle devices)
    profile_tracker::can_use_profile(&profile.id, &profile.kind)?;

    // Anonymous usage telemetry: which source kind gets started (wiretap,
    // wiretap, and any MCP-driven kind all land here).
    crate::telemetry::emit_feature_usage("io_source_start", &profile.kind);

    // Track profile_id for later registration
    let profile_id_for_tracking = profile.id.clone();

    // Create the appropriate reader based on profile kind
    // Real-time devices (gvret, slcan, gs_usb, socketcan) use IOBroker for unified handling
    let is_realtime = is_realtime_device(&profile.kind);
    let reader: Box<dyn IOSource> = if is_realtime {
        // Use IOBroker for all real-time devices (unified path)
        let source_config =
            create_source_config_from_profile(&profile, bus_override, serial.unwrap_or_default())
                .ok_or_else(|| {
                    format!("Failed to create source config for profile '{}'", profile.id)
                })?;

        Box::new(IOBroker::single_source(
            app.clone(),
            session_id.clone(),
            source_config,
        )?)
    } else {
        // Non-realtime devices use their direct readers
        match profile.kind.as_str() {
        "wiretap" => {
            let config = BackendApiConfig {
                base_url: profile
                    .connection
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "WireTAP backend URL is required".to_string())?
                    .trim_end_matches('/')
                    .to_string(),
                api_key: credentials::resolve_secret(&profile, "api_key").unwrap_or_default(),
                database: profile
                    .connection
                    .get("database")
                    .and_then(|v| v.as_str())
                    .unwrap_or("wiretap")
                    .to_string(),
                protocol: crate::apiclient::ArchiveProtocol::from_connection(&profile.connection)?,
            };

            let start_from_profile =
                profile.connection.get("start").and_then(|v| v.as_str()).map(|s| s.to_string());
            let end_from_profile =
                profile.connection.get("end").and_then(|v| v.as_str()).map(|s| s.to_string());
            let limit_from_profile = profile
                .connection
                .get("limit")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));

            let options = BackendApiSourceOptions {
                start: start_time.or(start_from_profile),
                end: end_time.or(end_from_profile),
                limit: limit.or(limit_from_profile),
                speed: speed.unwrap_or_else(|| {
                    profile
                        .connection
                        .get("speed")
                        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(0.0)
                }),
                batch_size: profile
                    .connection
                    .get("batch_size")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(1000) as i32,
            };

            Box::new(BackendApiSource::new(session_id.clone(), config, options))
        }
        "modbus_tcp" => {
            let (host, port, unit_id) = crate::io::modbus_endpoint(&profile);

            // Parse poll groups from frontend (catalog-derived JSON)
            tlog!("[create_reader_session] modbus_polls JSON: {:?}", modbus_polls.as_deref().unwrap_or("None"));
            let polls: Vec<crate::io::PollGroup> = match &modbus_polls {
                Some(json) => serde_json::from_str(json).map_err(|e| {
                    format!("Failed to parse Modbus poll groups: {}", e)
                })?,
                None => Vec::new(),
            };
            tlog!("[create_reader_session] Parsed {} Modbus poll groups for {}:{} unit {}", polls.len(), host, port, unit_id);

            let config = ModbusTcpConfig {
                host,
                port,
                unit_id,
                polls,
                max_register_errors: settings.modbus_max_register_errors,
            };

            Box::new(ModbusTcpSource::new(app.clone(), session_id.clone(), config))
        }
        "mqtt" => {
            let host = profile
                .connection
                .get("host")
                .and_then(|v| v.as_str())
                .unwrap_or("localhost")
                .to_string();

            let port = profile
                .connection
                .get("port")
                .and_then(|v| {
                    v.as_str()
                        .and_then(|s| s.parse().ok())
                        .or_else(|| v.as_i64().map(|n| n as u16))
                })
                .unwrap_or(1883);

            let username = profile
                .connection
                .get("username")
                .and_then(|v| v.as_str())
                .map(String::from);

            let password = credentials::resolve_secret(&profile, "password");

            // Get subscription topic from savvycan format config
            let topic = profile
                .connection
                .get("formats")
                .and_then(|f| f.get("savvycan"))
                .and_then(|s| s.get("topic"))
                .and_then(|v| v.as_str())
                .unwrap_or("wiretap/#")
                .to_string();

            let config = MqttConfig {
                host,
                port,
                username,
                password,
                topic,
                client_id: None,
            };

            Box::new(MqttSource::new(app.clone(), session_id.clone(), config))
        }
        "virtual" => {
            let traffic_type = match profile
                .connection
                .get("traffic_type")
                .and_then(|v| v.as_str())
            {
                Some("canfd") => VirtualTrafficType::CanFd,
                Some("modbus") => VirtualTrafficType::Modbus,
                Some("serial") => VirtualTrafficType::Serial,
                _ => VirtualTrafficType::Can,
            };

            let loopback = profile
                .connection
                .get("loopback")
                .and_then(|v| {
                    v.as_bool()
                        .or_else(|| v.as_str().map(|s| s != "false"))
                })
                .unwrap_or(true);

            // Parse per-bus interface configs from connection.interfaces array.
            // Falls back to a single bus with legacy frame_rate_hz / signal_generator fields.
            let interfaces: Vec<VirtualInterfaceConfig> = profile
                .connection
                .get("interfaces")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| {
                            let bus = item
                                .get("bus")
                                .and_then(|v| {
                                    v.as_i64()
                                        .map(|n| n as u8)
                                        .or_else(|| v.as_str().and_then(|s| s.parse::<u8>().ok()))
                                })
                                .unwrap_or(0);
                            let signal_generator = item
                                .get("signal_generator")
                                .and_then(|v| {
                                    v.as_bool()
                                        .or_else(|| v.as_str().map(|s| s != "false"))
                                })
                                .unwrap_or(true);
                            let frame_rate_hz = item
                                .get("frame_rate_hz")
                                .and_then(|v| {
                                    v.as_f64()
                                        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                                })
                                .unwrap_or(10.0)
                                .clamp(0.1, 1000.0);
                            Some(VirtualInterfaceConfig {
                                bus,
                                signal_generator,
                                frame_rate_hz,
                            })
                        })
                        .collect()
                })
                .unwrap_or_else(|| {
                    // Legacy fallback: single bus from top-level fields
                    let frame_rate_hz = profile
                        .connection
                        .get("frame_rate_hz")
                        .and_then(|v| {
                            v.as_str()
                                .and_then(|s| s.parse::<f64>().ok())
                                .or_else(|| v.as_f64())
                        })
                        .unwrap_or(10.0)
                        .clamp(0.1, 1000.0);
                    let signal_generator = profile
                        .connection
                        .get("signal_generator")
                        .and_then(|v| {
                            v.as_bool()
                                .or_else(|| v.as_str().map(|s| s != "false"))
                        })
                        .unwrap_or(true);
                    let bus_count = profile
                        .connection
                        .get("bus_count")
                        .and_then(|v| {
                            v.as_str()
                                .and_then(|s| s.parse::<u8>().ok())
                                .or_else(|| v.as_i64().map(|n| n as u8))
                        })
                        .unwrap_or(1)
                        .clamp(1, 8);
                    (0..bus_count)
                        .map(|bus| VirtualInterfaceConfig {
                            bus,
                            signal_generator,
                            frame_rate_hz,
                        })
                        .collect()
                });

            let config = VirtualDeviceConfig {
                traffic_type,
                loopback,
                interfaces,
            };

            tlog!(
                "[create_reader_session] Virtual device — {:?} loopback={} {} interface(s)",
                config.traffic_type, loopback, config.interfaces.len()
            );

            Box::new(VirtualSource::new(app.clone(), session_id.clone(), config))
        }
        kind => {
            return Err(format!(
                "Unsupported reader type '{}'. Supported: modbus_tcp, mqtt, virtual, gvret_tcp, gvret_usb, wiretap, csv, serial, slcan, socketcan, gs_usb",
                kind
            ));
        }
    }
    };

    // Register profile usage BEFORE create_session so lifecycle event has profile IDs
    profile_tracker::register_usage(&profile_id_for_tracking, &session_id);
    register_session_profile(&session_id, &profile_id_for_tracking);

    let result = create_session(app, session_id.clone(), reader, subscriber_id, app_name, None, vec![]).await;

    // Auto-start the session after creation (only for real-time devices)
    // Playback sources should NOT auto-start because frames would be emitted
    // before the frontend has registered its listener and set up event handlers.
    // The frontend will call start_reader_session after registering the listener.
    let is_playback_source = profile.kind == "wiretap";

    if result.is_new && !is_playback_source {
        tlog!("[create_reader_session] Auto-starting new session '{}' (device type: {})", session_id, profile.kind);
        match start_session(&session_id).await {
            Ok(_) => tlog!("[create_reader_session] Auto-start succeeded for '{}' (device type: {})", session_id, profile.kind),
            Err(e) => tlog!("[create_reader_session] Auto-start FAILED for '{}': {}", session_id, e),
        }
    } else if result.is_new && is_playback_source {
        tlog!("[create_reader_session] Created playback session '{}' (not auto-starting - frontend will start after listener registration)", session_id);
    } else {
        tlog!("[create_reader_session] Joined existing session '{}' (subscriber_count: {})", session_id, result.subscriber_count);
    }

    Ok(result.capabilities)
}

/// Get the state of a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn get_reader_session_state(session_id: String) -> Result<Option<IOState>, String> {
    Ok(get_session_state(&session_id).await)
}

/// List all active sessions (for discovering shareable sessions like multi-source)
#[tauri::command(rename_all = "snake_case")]
pub async fn list_active_sessions() -> Vec<ActiveSessionInfo> {
    list_sessions().await
}

/// Get the capabilities of a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn get_reader_session_capabilities(
    session_id: String,
) -> Result<Option<IOCapabilities>, String> {
    Ok(get_session_capabilities(&session_id).await)
}

/// Get the joiner count for a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn get_reader_session_joiner_count(session_id: String) -> Result<usize, String> {
    Ok(get_session_joiner_count(&session_id).await)
}

/// Start a reader session
/// Returns the confirmed state after the operation.
#[tauri::command(rename_all = "snake_case")]
pub async fn start_reader_session(session_id: String) -> Result<IOState, String> {
    start_session(&session_id).await
}

/// Stop a reader session
/// Returns the confirmed state after the operation.
#[tauri::command(rename_all = "snake_case")]
pub async fn stop_reader_session(session_id: String) -> Result<IOState, String> {
    stop_session(&session_id).await
}

/// Pause a reader session
/// Returns the confirmed state after the operation.
#[tauri::command(rename_all = "snake_case")]
pub async fn pause_reader_session(session_id: String) -> Result<IOState, String> {
    pause_session(&session_id).await
}

/// Resume a reader session
/// Returns the confirmed state after the operation.
#[tauri::command(rename_all = "snake_case")]
pub async fn resume_reader_session(session_id: String) -> Result<IOState, String> {
    resume_session(&session_id).await
}

/// Suspend a reader session - stops streaming, finalizes capture, session stays alive.
/// The capture remains owned by the session and all joined apps can view it.
/// Use `resume_reader_session_fresh` to start streaming again with a new capture.
#[tauri::command(rename_all = "snake_case")]
pub async fn suspend_reader_session(session_id: String) -> Result<IOState, String> {
    suspend_session(&session_id).await
}

/// Stop a realtime session and switch all listeners to capture replay.
/// Emits `session-lifecycle` signal so all apps on the session refresh state.
#[tauri::command(rename_all = "snake_case")]
pub async fn io_stop_and_switch_to_capture(
    app: tauri::AppHandle,
    session_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    stop_and_switch_to_capture(&app, &session_id, speed.unwrap_or(1.0)).await
}

/// Stop a session and switch it to capture replay, choosing the backend path from
/// the source's temporal mode. Realtime → stop-and-switch all listeners (falling
/// back to a plain suspend if no capture exists); recorded → suspend (preserves
/// position) then switch to capture replay. Owns the decision that used to live in
/// the frontend `stopWatch`.
#[tauri::command(rename_all = "snake_case")]
pub async fn session_stop_to_capture(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    let is_realtime = get_session_capabilities(&session_id)
        .await
        .map(|c| c.traits.temporal_mode == TemporalMode::Realtime)
        .unwrap_or(false);

    if is_realtime {
        if let Err(e) = stop_and_switch_to_capture(&app, &session_id, 1.0).await {
            tlog!("[session_stop_to_capture] stop-and-switch failed ({}); suspending", e);
            suspend_session(&session_id).await?;
        }
    } else {
        suspend_session(&session_id).await?;
        if let Err(e) = switch_to_capture_replay(&app, &session_id, 1.0).await {
            tlog!("[session_stop_to_capture] switch-to-capture-replay failed: {}", e);
        }
    }
    Ok(())
}

/// Resume a suspended session with a fresh capture.
/// The old capture is orphaned (becomes available for standalone viewing).
/// A new capture is created for the session and streaming starts.
#[tauri::command(rename_all = "snake_case")]
pub async fn resume_reader_session_fresh(session_id: String) -> Result<IOState, String> {
    resume_session_fresh(&session_id).await
}

/// Copy a capture for an app that is detaching from a session.
/// Creates an orphaned copy of the capture that can be used standalone.
/// Returns the new capture ID.
#[tauri::command(rename_all = "snake_case")]
pub fn copy_capture_for_detach(capture_id: String, new_name: String) -> Result<String, String> {
    capture_store::copy_capture(&capture_id, new_name)
}

/// Update playback speed for a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn update_reader_speed(session_id: String, speed: f64) -> Result<(), String> {
    update_session_speed(&session_id, speed).await
}

/// Enable or disable traffic generation for a virtual device session
#[tauri::command(rename_all = "snake_case")]
pub async fn set_virtual_traffic_enabled(
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    use crate::io::set_session_traffic_enabled;
    set_session_traffic_enabled(&session_id, enabled).await
}

/// Enable or disable signal generator for a specific bus
#[tauri::command(rename_all = "snake_case")]
pub async fn set_virtual_bus_traffic_enabled(
    session_id: String,
    bus: u8,
    enabled: bool,
) -> Result<(), String> {
    use crate::io::set_session_bus_traffic_enabled;
    set_session_bus_traffic_enabled(&session_id, bus, enabled).await
}

/// Update signal generator cadence for a specific bus
#[tauri::command(rename_all = "snake_case")]
pub async fn set_virtual_bus_cadence(
    session_id: String,
    bus: u8,
    frame_rate_hz: f64,
) -> Result<(), String> {
    use crate::io::set_session_bus_cadence;
    set_session_bus_cadence(&session_id, bus, frame_rate_hz).await
}

/// Query per-bus signal generator states
#[tauri::command(rename_all = "snake_case")]
pub async fn get_virtual_bus_states(
    session_id: String,
) -> Result<Vec<crate::io::VirtualBusState>, String> {
    use crate::io::get_session_virtual_bus_states;
    get_session_virtual_bus_states(&session_id).await
}

/// Add a virtual bus generator to a running session
#[tauri::command(rename_all = "snake_case")]
pub async fn add_virtual_bus(
    session_id: String,
    bus: u8,
    traffic_type: String,
    frame_rate_hz: f64,
) -> Result<(), String> {
    use crate::io::add_session_virtual_bus;
    add_session_virtual_bus(&session_id, bus, traffic_type, frame_rate_hz).await
}

/// Remove a virtual bus generator from a running session
#[tauri::command(rename_all = "snake_case")]
pub async fn remove_virtual_bus(
    session_id: String,
    bus: u8,
) -> Result<(), String> {
    use crate::io::remove_session_virtual_bus;
    remove_session_virtual_bus(&session_id, bus).await
}

/// Update time range for a reader session (only works when stopped)
#[tauri::command(rename_all = "snake_case")]
pub async fn update_reader_time_range(
    session_id: String,
    start: Option<String>,
    end: Option<String>,
) -> Result<(), String> {
    update_session_time_range(&session_id, start, end).await
}

/// Reconfigure a running session with new time range.
/// This stops the current stream, orphans the old capture, creates a new capture,
/// and starts streaming with the new time range - all while keeping the session alive.
/// Other apps joined to this session remain connected.
#[tauri::command(rename_all = "snake_case")]
pub async fn reconfigure_reader_session(
    session_id: String,
    start: Option<String>,
    end: Option<String>,
) -> Result<(), String> {
    reconfigure_session(&session_id, start, end).await
}

/// Seek to a specific timestamp in microseconds
#[tauri::command(rename_all = "snake_case")]
pub async fn seek_reader_session(session_id: String, timestamp_us: i64) -> Result<(), String> {
    seek_session(&session_id, timestamp_us).await
}

/// Seek to a specific frame index (preferred for capture playback - avoids floating-point issues)
#[tauri::command(rename_all = "snake_case")]
pub async fn seek_reader_session_by_frame(session_id: String, frame_index: i64) -> Result<(), String> {
    seek_session_by_frame(&session_id, frame_index).await
}

/// Set playback direction for a reader session (reverse = true for backwards playback)
#[tauri::command(rename_all = "snake_case")]
pub async fn update_reader_direction(session_id: String, reverse: bool) -> Result<(), String> {
    update_session_direction(&session_id, reverse).await
}

/// Destroy a reader session. `reset` marks a deliberate user destroy (the app
/// resets to "No source" rather than the orphaned capture); it travels in the
/// emitted `destroyed` lifecycle event.
#[tauri::command(rename_all = "snake_case")]
pub async fn destroy_reader_session(session_id: String, reset: bool) -> Result<(), String> {
    // Unregister profile usage for all profiles this session was using
    let profile_ids = take_session_profiles(&session_id);
    for profile_id in profile_ids {
        profile_tracker::unregister_usage_by_session(&profile_id, &session_id);
    }

    // Capture orphaning is handled by destroy_session() which also emits
    // the capture-changed signal. Don't orphan here to avoid a double-call
    // that would cause destroy_session's emit to have an empty capture list.
    destroy_session(&session_id, reset).await
}

/// Create a reader session for a capture.
/// The capture is registered as a source profile so it appears in
/// `sourceProfileIds` and the session manager graph.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_capture_source_session(
    app: tauri::AppHandle,
    session_id: String,
    capture_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    if !capture_store::has_any_data() {
        return Err("No data in capture. Please import a CSV file first.".to_string());
    }

    register_session_profile(&session_id, &capture_id);

    let reader = CaptureSource::new(
        app.clone(),
        session_id.clone(),
        capture_id,
        speed.unwrap_or(0.0), // 0 = no limit by default
    );

    // Anonymous usage telemetry: user explicitly opened a capture for replay.
    crate::telemetry::emit_feature_usage("io_source_start", "capture");

    let result = create_session(app, session_id, Box::new(reader), None, None, None, vec![]).await;
    Ok(result.capabilities)
}

/// Transition an existing session to use a capture for replay.
/// This is used when a streaming source (GVRET, the WireTAP backend) ends and
/// the user wants to replay the captured frames.
#[tauri::command(rename_all = "snake_case")]
pub async fn transition_to_capture_source(
    app: tauri::AppHandle,
    session_id: String,
    capture_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    // Stop and destroy current session
    let _ = stop_session(&session_id).await;
    let _ = destroy_session(&session_id, false).await;

    if !capture_store::has_any_data() {
        return Err("No data in capture for replay".to_string());
    }

    register_session_profile(&session_id, &capture_id);

    let reader = CaptureSource::new(
        app.clone(),
        session_id.clone(),
        capture_id,
        speed.unwrap_or(1.0),
    );

    let result = create_session(app, session_id, Box::new(reader), None, None, None, vec![]).await;
    Ok(result.capabilities)
}

/// Switch a session to capture replay mode without destroying it.
/// This swaps the session's reader to a CaptureSource that reads from the session's
/// owned capture. All listeners stay connected and can replay the captured data.
/// Use this after ingest completes to enable playback controls.
#[tauri::command(rename_all = "snake_case")]
pub async fn switch_session_to_capture_replay(
    app: tauri::AppHandle,
    session_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    switch_to_capture_replay(&app, &session_id, speed.unwrap_or(1.0)).await
}

/// Resume a session from capture playback back to live streaming.
/// Uses stored source configs to rebuild the reader (supports multi-source).
/// Falls back to loading from settings for single-source sessions without stored configs.
/// Re-registers device profiles with the tracker before reconnecting.
#[tauri::command(rename_all = "snake_case")]
pub async fn resume_session_to_live(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<IOCapabilities, String> {
    // Prefer stored source configs (set during session creation)
    let stored_configs: Vec<SourceConfig> = get_session_source_configs(&session_id).await;

    let configs = if !stored_configs.is_empty() {
        stored_configs
    } else {
        // Fallback: load from settings (legacy single-source path)
        let profile_ids = get_session_profile_ids(&session_id);
        if profile_ids.is_empty() {
            return Err(format!(
                "No profile IDs or source configs found for session '{}'. Cannot resume to live.",
                session_id
            ));
        }

        let settings = settings::load_settings(app.clone())
            .await
            .map_err(|e| format!("Failed to load settings: {}", e))?;

        let profile_id = &profile_ids[0];
        let profile = settings
            .io_profiles
            .iter()
            .find(|p| p.id == *profile_id)
            .ok_or_else(|| format!("Profile '{}' not found in settings", profile_id))?;

        if !is_realtime_device(&profile.kind) {
            return Err(format!(
                "Cannot resume to live for '{}' device type.",
                profile.kind
            ));
        }

        // No session overrides on this path — the original ones went with the
        // stored configs this branch is the fallback for, so the profile decides.
        let source_config = create_source_config_from_profile(profile, None, SerialOverrides::default())
            .ok_or_else(|| format!("Failed to create source config for profile '{}'", profile_id))?;

        vec![source_config]
    };

    // Check profile availability before committing
    for config in &configs {
        crate::profile_tracker::can_use_profile(&config.profile_id, &config.profile_kind)?;
    }

    // Re-register profiles with the tracker
    for config in &configs {
        crate::profile_tracker::register_usage(&config.profile_id, &session_id);
    }

    // Restore original profile IDs to SESSION_PROFILES (replacing the capture ID)
    let profile_ids: Vec<String> = configs.iter().map(|c| c.profile_id.clone()).collect();
    replace_session_profiles(&session_id, &profile_ids);

    // Build the new live reader
    let new_reader: Box<dyn IOSource> = if configs.len() == 1 {
        Box::new(IOBroker::single_source(
            app.clone(),
            session_id.clone(),
            configs.into_iter().next().unwrap(),
        )?)
    } else {
        Box::new(IOBroker::new(
            app.clone(),
            session_id.clone(),
            configs,
        )?)
    };

    resume_to_live_session(&session_id, new_reader).await
}

/// Step one frame forward or backward in the capture.
/// Returns the new frame index and timestamp after stepping, or None if at the boundary.
/// Only works when the session is paused.
/// Requires either current_frame_index or current_timestamp_us to determine position.
/// If filter_selection is provided, skips frames it does not name.
#[tauri::command(rename_all = "snake_case")]
pub async fn step_capture_frame(
    app: tauri::AppHandle,
    session_id: String,
    capture_id: String,
    current_frame_index: Option<usize>,
    current_timestamp_us: Option<i64>,
    backward: bool,
    filter_selection: Option<Vec<crate::capture_store::ProtocolFrames>>,
) -> Result<Option<StepResult>, String> {
    let selection = crate::capture_store::FrameSelection::from_groups(filter_selection.unwrap_or_default());
    step_frame(&app, &session_id, &capture_id, current_frame_index, current_timestamp_us, backward, &selection)
}

// Legacy heartbeat commands removed - use register_session_subscriber/unregister_session_subscriber instead

/// Transmit a CAN frame through a session.
/// The session must be connected and support transmission.
#[tauri::command(rename_all = "snake_case")]
pub async fn session_transmit_frame(
    session_id: String,
    frame: CanTransmitFrame,
) -> Result<TransmitResult, String> {
    transmit_frame(&session_id, &frame).await
}

// ============================================================================
// Listener Registration Commands
// ============================================================================

/// Register a listener for a session.
/// This is the primary way for frontend components to join a session.
/// If the listener is already registered, this updates their heartbeat.
/// Returns session info including whether this listener is the owner.
#[tauri::command(rename_all = "snake_case")]
pub async fn register_session_subscriber(
    session_id: String,
    subscriber_id: String,
    app_name: Option<String>,
) -> Result<RegisterSubscriberResult, String> {
    register_subscriber(&session_id, &subscriber_id, app_name.as_deref()).await
}

/// Unregister a listener from a session.
/// If this was the last listener, the session will be stopped (but not destroyed).
/// Returns the remaining listener count.
#[tauri::command(rename_all = "snake_case")]
pub async fn unregister_session_subscriber(
    session_id: String,
    subscriber_id: String,
) -> Result<usize, String> {
    unregister_subscriber(&session_id, &subscriber_id).await
}

/// Get all listeners for a session.
/// Useful for debugging and for the frontend to understand session state.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_session_subscriber_list(session_id: String) -> Result<Vec<SubscriberInfo>, String> {
    get_session_subscribers(&session_id).await
}

// ============================================================================
// Open-app registry (cross-window roster of session-aware app instances)
// ============================================================================

/// Register an open session-aware app instance (called on panel mount). Tracks the
/// instance globally so the Session Manager graph can show apps from every window.
#[tauri::command(rename_all = "snake_case")]
pub fn register_open_app(instance_id: String, display_id: String, app_name: String, window_label: String) {
    crate::io::register_app(&instance_id, &display_id, &app_name, &window_label);
}

/// Unregister an open app instance (called on panel unmount).
#[tauri::command(rename_all = "snake_case")]
pub async fn unregister_open_app(instance_id: String) {
    crate::io::unregister_app(&instance_id).await;
}

/// List every open app instance across all windows (drives the roster reconcile).
#[tauri::command(rename_all = "snake_case")]
pub fn list_open_apps() -> Vec<crate::io::AppInstanceInfo> {
    crate::io::list_open_apps()
}

/// Remove all app instances owned by a window (called when a window is closing).
#[tauri::command(rename_all = "snake_case")]
pub async fn prune_window_apps(window_label: String) {
    crate::io::prune_window_sessions(&window_label).await;
}

/// Evict a listener from a session, giving it a copy of the current capture.
/// Used by the Session Manager to remove a listener without destroying the session.
#[tauri::command(rename_all = "snake_case")]
pub async fn evict_session_subscriber_cmd(
    app: tauri::AppHandle,
    session_id: String,
    subscriber_id: String,
) -> Result<Vec<String>, String> {
    evict_session_subscriber(&app, &session_id, &subscriber_id).await
}

/// Leave a session (user-initiated): the calling app detaches and reviews a frozen
/// snapshot of the capture; the session keeps streaming for any remaining apps.
/// Returns the copied snapshot capture IDs (empty when there was nothing captured).
#[tauri::command(rename_all = "snake_case")]
pub async fn session_leave_to_capture(
    app: tauri::AppHandle,
    session_id: String,
    subscriber_id: String,
) -> Result<Vec<String>, String> {
    leave_session_to_capture(&app, &session_id, &subscriber_id).await
}

/// Add a new IO source to an existing multi-source session.
/// Stops the current device, creates a new IOBroker with all sources (old + new),
/// and restarts. Keeps the same session ID and listeners.
#[tauri::command(rename_all = "snake_case")]
pub async fn add_source_to_session_cmd(
    app: tauri::AppHandle,
    session_id: String,
    source: MultiSourceInput,
) -> Result<IOCapabilities, String> {
    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    // Determine next source index from existing configs (for auto-assigning output bus)
    let existing_count = get_session_source_count(&session_id).await;

    let source_config = resolve_source_config(source, existing_count, &settings)?;

    // Validate it's a real-time device
    if !is_realtime_device(&source_config.profile_kind) {
        return Err(format!(
            "Profile '{}' has unsupported type '{}' for multi-source mode",
            source_config.profile_id, source_config.profile_kind
        ));
    }

    // Check if profile is already in use by another session
    profile_tracker::can_use_profile(&source_config.profile_id, &source_config.profile_kind)?;

    // Register profile usage
    let profile_id = source_config.profile_id.clone();
    profile_tracker::register_usage(&profile_id, &session_id);
    register_session_profile(&session_id, &profile_id);

    let capabilities = add_source_to_session(&app, &session_id, source_config).await?;

    Ok(capabilities)
}

/// Remove an IO source from an existing multi-source session.
/// Stops the current device, rebuilds with remaining sources (bus mappings preserved),
/// and restarts. Cannot remove the last source — destroy the session instead.
#[tauri::command(rename_all = "snake_case")]
pub async fn remove_source_from_session_cmd(
    app: tauri::AppHandle,
    session_id: String,
    profile_id: String,
) -> Result<IOCapabilities, String> {
    let capabilities = remove_source_from_session(&app, &session_id, &profile_id).await?;

    // Unregister profile tracking for the removed source
    profile_tracker::unregister_usage_by_session(&profile_id, &session_id);

    // Remove from session→profile mapping
    if let Ok(mut map) = SESSION_PROFILES.lock() {
        if let Some(profiles) = map.get_mut(&session_id) {
            profiles.retain(|id| id != &profile_id);
        }
    }
    if let Ok(mut map) = PROFILE_SESSIONS.lock() {
        if let Some(sessions) = map.get_mut(&profile_id) {
            sessions.remove(&session_id);
            if sessions.is_empty() {
                map.remove(&profile_id);
            }
        }
    }

    Ok(capabilities)
}

/// Pause polling for a specific source within a running session.
/// The session stays active and other sources continue normally.
#[tauri::command(rename_all = "snake_case")]
pub async fn pause_source_polling(
    session_id: String,
    profile_id: String,
) -> Result<(), String> {
    set_source_polling(&session_id, &profile_id, false).await
}

/// Resume polling for a paused source within a running session.
///
/// Refuses while a sweep holds the same endpoint. `create_modbus_scan_session`
/// has always refused the mirror image — a sweep while a poller holds the device
/// — and the poll switch makes "resume the poller during a sweep" a one-click
/// action from the same top bar, so guarding one direction only was an asymmetry
/// with a UI behind it.
#[tauri::command(rename_all = "snake_case")]
pub async fn resume_source_polling(
    app: tauri::AppHandle,
    session_id: String,
    profile_id: String,
) -> Result<(), String> {
    let settings = crate::settings::load_settings_sync(&app)?;
    // `modbus_tcp` rather than any Modbus protocol: a sweep is a TCP endpoint,
    // which is also how `session_modbus_profile` narrows.
    if let Some(profile) = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id && p.kind == "modbus_tcp")
    {
        let endpoint = crate::io::modbus_tcp::modbus_endpoint_str(profile);
        if let Some(holder) = crate::io::modbus_tcp::scan_source::scan_holding(&endpoint) {
            return Err(format!(
                "A Modbus scan of {endpoint} is running as session '{holder}' — that device may \
                 only serve one Modbus connection at a time. Wait for the scan, or stop it."
            ));
        }
    }
    set_source_polling(&session_id, &profile_id, true).await
}

/// Update bus mappings for a source in a multi-source session.
/// Hot-swaps the source by removing and re-adding it with updated mappings.
/// If no mappings remain enabled, the source is removed entirely.
#[tauri::command(rename_all = "snake_case")]
pub async fn update_source_bus_mappings_cmd(
    session_id: String,
    profile_id: String,
    bus_mappings: Vec<BusMapping>,
) -> Result<IOCapabilities, String> {
    update_source_bus_mappings(&session_id, &profile_id, bus_mappings).await
}

/// Check if it's safe to reinitialize a session and do so if safe.
/// Reinitialize is only safe if the requesting listener is the only listener.
/// This is an atomic check-and-act operation to prevent race conditions.
///
/// If safe, the session will be destroyed so a new one can be created.
/// Returns success status and reason if failed.
#[tauri::command(rename_all = "snake_case")]
pub async fn reinitialize_session_if_safe_cmd(
    session_id: String,
    subscriber_id: String,
) -> Result<ReinitializeResult, String> {
    reinitialize_session_if_safe(&session_id, &subscriber_id).await
}

/// Set whether a listener is active (receiving frames).
/// When a listener detaches, set is_active to false to stop receiving frames.
/// When they rejoin, set is_active to true to resume receiving frames.
/// This is handled in Rust to avoid frontend race conditions.
#[tauri::command(rename_all = "snake_case")]
pub async fn set_session_subscriber_active(
    session_id: String,
    subscriber_id: String,
    is_active: bool,
) -> Result<(), String> {
    set_subscriber_active(&session_id, &subscriber_id, is_active).await
}

/// Probe a GVRET device to discover its capabilities (number of buses, etc.)
///
/// This loads the profile from settings, connects to the device, queries it,
/// and returns device information. The connection is closed after probing.
#[tauri::command(rename_all = "snake_case")]
pub async fn probe_gvret_device(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<GvretDeviceInfo, String> {
    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile '{}' not found", profile_id))?;

    match profile.kind.as_str() {
        "gvret_tcp" => {
            let host = &conn_str(profile, "host").unwrap_or_default();
            let port = conn_i64(profile, "port").unwrap_or_default() as u16;
            let timeout_sec = conn_f64(profile, "timeout").unwrap_or_default();

            // user_message(), not String::from — the latter renders Display, which for
            // a DNS failure drops the "check your network or VPN" half of the message.
            probe_gvret_tcp(host, port, timeout_sec)
                .await
                .map_err(|e| e.user_message())
        }
        #[cfg(not(target_os = "ios"))]
        "gvret_usb" => {
            let port = profile
                .connection
                .get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required for GVRET USB".to_string())?;
            let baud_rate = conn_i64(profile, "baud_rate").unwrap_or_default() as u32;

            // Run blocking serial probe in a dedicated thread
            let port_owned = port.to_string();
            tokio::task::spawn_blocking(move || {
                probe_gvret_usb(&port_owned, baud_rate).map_err(String::from)
            })
                .await
                .map_err(|e| format!("Probe task failed: {}", e))?
        }
        #[cfg(target_os = "ios")]
        "gvret_usb" => {
            Err("GVRET USB is not available on iOS".to_string())
        }
        _ => Err(format!(
            "Profile '{}' is not a GVRET device (kind: {})",
            profile_id, profile.kind
        )),
    }
}

// ============================================================================
// Unified Device Probe API
// ============================================================================

/// Result of probing any real-time device.
/// Provides a unified structure for all device types.
#[derive(Clone, Debug, serde::Serialize)]
pub struct DeviceProbeResult {
    /// Whether the probe was successful (device is online and responding)
    pub success: bool,
    /// Device type (e.g., "gvret", "slcan", "gs_usb", "socketcan")
    pub source_type: String,
    /// Whether this is a multi-bus device (GVRET can have multiple CAN buses)
    pub is_multi_bus: bool,
    /// Number of buses available (1 for single-bus devices, 1-5 for GVRET)
    pub bus_count: u8,
    /// Primary info line (firmware version, device name, etc.)
    pub primary_info: Option<String>,
    /// Secondary info line (hardware version, channel count, etc.)
    pub secondary_info: Option<String>,
    /// Whether device supports CAN FD (gs_usb devices only, None for others)
    pub supports_fd: Option<bool>,
    /// Error message if probe failed
    pub error: Option<String>,
}

/// Probe any real-time device to check if it's online and healthy.
///
/// This loads the profile from settings, connects to the device, queries it,
/// and returns device information. The connection is closed after probing.
///
/// If a successful probe result is cached for this profile, returns the cached
/// result immediately without reconnecting. This is useful when the device is
/// already running in an active session.
///
/// Supported device types:
/// - gvret_tcp, gvret_usb: Multi-bus GVRET devices
/// - slcan: Single-bus slcan/CANable devices
/// - gs_usb: Single-bus gs_usb/candleLight devices (Windows/macOS)
/// - socketcan: Single-bus SocketCAN interfaces (Linux)
/// - serial: Raw serial ports (always "online" if port exists)
#[tauri::command(rename_all = "snake_case")]
pub async fn probe_device(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<DeviceProbeResult, String> {
    #[cfg(not(target_os = "ios"))]
    use crate::io::slcan::reader::probe_slcan_device;

    // Capture IDs — metadata already in memory, no profile lookup needed
    if capture_store::is_known_capture(&profile_id) {
        if let Some(meta) = capture_store::get_capture_metadata(&profile_id) {
            let bus_count = if meta.buses.is_empty() { 1 } else { meta.buses.len() as u8 };
            let is_multi_bus = meta.buses.len() > 1;
            let result = DeviceProbeResult {
                success: true,
                source_type: "capture".to_string(),
                is_multi_bus,
                bus_count,
                primary_info: Some(format!("{} buses", bus_count)),
                secondary_info: Some(meta.id.clone()),
                supports_fd: None,
                error: None,
            };
            emit_device_probe(&app, DeviceProbePayload {
                profile_id: profile_id.clone(),
                source_type: "capture".to_string(),
                address: meta.id.clone(),
                success: true,
                cached: false,
                bus_count,
                error: None,
            });
            // Don't cache capture probes — metadata may change as data streams in
            return Ok(result);
        } else {
            return Err(format!("Capture '{}' not found", profile_id));
        }
    }

    // Check cache first - if we have a successful probe result, return it immediately
    if let Some(cached) = get_cached_probe(&profile_id) {
        tlog!("[probe_device] Returning cached probe result for profile '{}'", profile_id);
        emit_device_probe(&app, DeviceProbePayload {
            profile_id: profile_id.clone(),
            source_type: cached.source_type.clone(),
            address: cached.secondary_info.clone().unwrap_or_default(),
            success: cached.success,
            cached: true,
            bus_count: cached.bus_count,
            error: cached.error.clone(),
        });
        return Ok(cached);
    }

    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile '{}' not found", profile_id))?;

    let result = match profile.kind.as_str() {
        // GVRET devices - multi-bus
        "gvret_tcp" => {
            let host = conn_str(profile, "host").unwrap_or_default();
            let port = conn_i64(profile, "port").unwrap_or_default() as u16;
            let timeout_sec = conn_f64(profile, "timeout").unwrap_or_default();

            match probe_gvret_tcp(&host, port, timeout_sec).await {
                Ok(info) => Ok(DeviceProbeResult {
                    success: true,
                    source_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: info.bus_count,
                    primary_info: Some(format!("{} buses available", info.bus_count)),
                    secondary_info: Some(format!("{}:{}", host, port)),
                    supports_fd: None,
                    error: None,
                }),
                Err(e) => Ok(DeviceProbeResult {
                    success: false,
                    source_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    supports_fd: None,
                    error: Some(e.user_message()),
                }),
            }
        }

        #[cfg(not(target_os = "ios"))]
        "gvret_usb" => {
            let port = profile.connection.get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required for GVRET USB".to_string())?;
            let baud_rate = profile.connection.get("baud_rate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(115200) as u32;

            let port_owned = port.to_string();
            match tokio::task::spawn_blocking(move || probe_gvret_usb(&port_owned, baud_rate)).await {
                Ok(Ok(info)) => Ok(DeviceProbeResult {
                    success: true,
                    source_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: info.bus_count,
                    primary_info: Some(format!("{} buses available", info.bus_count)),
                    secondary_info: Some(port.to_string()),
                    supports_fd: None,
                    error: None,
                }),
                Ok(Err(e)) => Ok(DeviceProbeResult {
                    success: false,
                    source_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    supports_fd: None,
                    error: Some(e.to_string()),
                }),
                Err(e) => Ok(DeviceProbeResult {
                    success: false,
                    source_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    supports_fd: None,
                    error: Some(format!("Probe task failed: {}", e)),
                }),
            }
        }
        #[cfg(target_os = "ios")]
        "gvret_usb" => {
            Ok(DeviceProbeResult {
                success: false,
                source_type: "gvret".to_string(),
                is_multi_bus: true,
                bus_count: 0,
                primary_info: None,
                secondary_info: None,
                supports_fd: None,
                error: Some("GVRET USB is not available on iOS".to_string()),
            })
        }

        // slcan devices - single-bus (desktop only)
        #[cfg(not(target_os = "ios"))]
        "slcan" => {
            let port = profile.connection.get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required for slcan".to_string())?
                .to_string();
            let baud_rate = conn_i64(profile, "baud_rate").unwrap_or_default() as u32;
            let data_bits = conn_i64(profile, "data_bits").map(|v| v as u8);
            let stop_bits = conn_i64(profile, "stop_bits").map(|v| v as u8);
            let parity = conn_str(profile, "parity");

            let result = tokio::task::spawn_blocking(move || {
                probe_slcan_device(port, baud_rate, data_bits, stop_bits, parity)
            }).await.map_err(|e| format!("Probe task failed: {}", e))?;

            Ok(DeviceProbeResult {
                success: result.success,
                source_type: "slcan".to_string(),
                is_multi_bus: false,
                bus_count: if result.success { 1 } else { 0 },
                primary_info: result.version,
                secondary_info: result.hardware_version,
                supports_fd: None,
                error: result.error,
            })
        }
        #[cfg(target_os = "ios")]
        "slcan" => {
            Ok(DeviceProbeResult {
                success: false,
                source_type: "slcan".to_string(),
                is_multi_bus: false,
                bus_count: 0,
                primary_info: None,
                secondary_info: None,
                supports_fd: None,
                error: Some("slcan is not available on iOS".to_string()),
            })
        }

        // gs_usb devices - single-bus (Windows/macOS via nusb)
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        "gs_usb" => {
            use crate::io::gs_usb::probe_gs_usb_device;

            let bus = profile.connection.get("bus")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0) as u8;
            let address = profile.connection.get("address")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0) as u8;
            // Serial number for stable device matching across USB re-enumeration
            let serial = profile.connection.get("serial")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            match probe_gs_usb_device(bus, address, serial) {
                Ok(info) => Ok(DeviceProbeResult {
                    success: true,
                    source_type: "gs_usb".to_string(),
                    is_multi_bus: false,
                    bus_count: info.channel_count.unwrap_or(1) as u8,
                    primary_info: info.channel_count.map(|c| format!("{} channel(s)", c)),
                    secondary_info: if info.supports_fd.unwrap_or(false) {
                        Some("CAN FD supported".to_string())
                    } else {
                        None
                    },
                    supports_fd: info.supports_fd,
                    error: None,
                }),
                Err(e) => Ok(DeviceProbeResult {
                    success: false,
                    source_type: "gs_usb".to_string(),
                    is_multi_bus: false,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    supports_fd: None,
                    error: Some(e),
                }),
            }
        }

        // SocketCAN - Linux only, check if interface exists
        #[cfg(target_os = "linux")]
        "socketcan" => {
            let interface = conn_str(profile, "interface").unwrap_or_default();

            // Check if the interface exists by reading from /sys/class/net
            let path = format!("/sys/class/net/{}", interface);
            if std::path::Path::new(&path).exists() {
                Ok(DeviceProbeResult {
                    success: true,
                    source_type: "socketcan".to_string(),
                    is_multi_bus: false,
                    bus_count: 1,
                    primary_info: Some(format!("Interface: {}", interface)),
                    secondary_info: None,
                    supports_fd: None,
                    error: None,
                })
            } else {
                Ok(DeviceProbeResult {
                    success: false,
                    source_type: "socketcan".to_string(),
                    is_multi_bus: false,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    supports_fd: None,
                    error: Some(format!("Interface '{}' not found", interface)),
                })
            }
        }

        // Serial port - check if port exists (desktop only)
        #[cfg(not(target_os = "ios"))]
        "serial" => {
            let port = profile.connection.get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required".to_string())?;

            // Try to check if port exists
            let available_ports = serialport::available_ports().unwrap_or_default();
            let port_exists = available_ports.iter().any(|p| p.port_name == port);

            if port_exists {
                Ok(DeviceProbeResult {
                    success: true,
                    source_type: "serial".to_string(),
                    is_multi_bus: false,
                    bus_count: 1,
                    primary_info: Some(port.to_string()),
                    secondary_info: None,
                    supports_fd: None,
                    error: None,
                })
            } else {
                Ok(DeviceProbeResult {
                    success: false,
                    source_type: "serial".to_string(),
                    is_multi_bus: false,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    supports_fd: None,
                    error: Some(format!("Port '{}' not found", port)),
                })
            }
        }
        #[cfg(target_os = "ios")]
        "serial" => {
            Ok(DeviceProbeResult {
                success: false,
                source_type: "serial".to_string(),
                is_multi_bus: false,
                bus_count: 0,
                primary_info: None,
                secondary_info: None,
                supports_fd: None,
                error: Some("Serial ports are not available on iOS".to_string()),
            })
        }

        // Modbus TCP - probe by attempting a TCP connection
        "modbus_tcp" => {
            let host = conn_str(profile, "host").unwrap_or_default();
            let port = conn_i64(profile, "port").unwrap_or_default() as u16;
            let timeout_sec = conn_f64(profile, "timeout").unwrap_or_default();

            let addr = format!("{}:{}", host, port);

            // Resolve before connecting, like every other Modbus TCP path — passing
            // the "host:port" string to connect() resolves inside the timeout, which
            // reports a DNS failure as a connection one.
            let sock_addr = match crate::io::net::resolve_host_port(&host, port).await {
                Ok(a) => a,
                Err(e) => {
                    return Ok(DeviceProbeResult {
                        success: false,
                        source_type: "modbus_tcp".to_string(),
                        is_multi_bus: false,
                        bus_count: 0,
                        primary_info: None,
                        secondary_info: Some(addr),
                        supports_fd: None,
                        error: Some(e.user_message()),
                    });
                }
            };

            match tokio::time::timeout(
                std::time::Duration::from_secs_f64(timeout_sec),
                tokio::net::TcpStream::connect(sock_addr),
            ).await {
                Ok(Ok(_stream)) => Ok(DeviceProbeResult {
                    success: true,
                    source_type: "modbus_tcp".to_string(),
                    is_multi_bus: false,
                    bus_count: 1,
                    primary_info: Some("Modbus TCP".to_string()),
                    secondary_info: Some(addr),
                    supports_fd: None,
                    error: None,
                }),
                Ok(Err(e)) => Ok(DeviceProbeResult {
                    success: false,
                    source_type: "modbus_tcp".to_string(),
                    is_multi_bus: false,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: Some(addr),
                    supports_fd: None,
                    error: Some(format!("Connection failed: {}", e)),
                }),
                Err(_) => Ok(DeviceProbeResult {
                    success: false,
                    source_type: "modbus_tcp".to_string(),
                    is_multi_bus: false,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: Some(addr),
                    supports_fd: None,
                    error: Some(format!("Connection timed out after {}s", timeout_sec)),
                }),
            }
        }

        // FrameLink device — grouped profile with interfaces[], TCP probe to verify reachability
        "framelink" => {
            let host = req_str(profile, "host")?;
            let port = conn_i64(profile, "port").unwrap_or_default() as u16;
            // `as_f64()` only, before — and the form writes strings, so a
            // configured timeout was silently ignored.
            let timeout_sec = conn_f64(profile, "timeout").unwrap_or_default();
            let device_id = conn_str(profile, "device_id");
            let iface_count = profile.connection.get("interfaces")
                .and_then(|v| v.as_array())
                .map(|a| a.len() as u8)
                .unwrap_or(1);

            match crate::io::framelink::probe_framelink(&host, port, timeout_sec).await {
                Ok(probe) => {
                    let bus_count = probe.interfaces.len().max(iface_count as usize) as u8;
                    Ok(DeviceProbeResult {
                        success: true,
                        source_type: "framelink".to_string(),
                        is_multi_bus: bus_count > 1,
                        bus_count,
                        primary_info: device_id.map(|s| s.to_string()),
                        secondary_info: Some(format!("{}:{}", host, port)),
                        supports_fd: None,
                        error: None,
                    })
                }
                Err(e) => Ok(DeviceProbeResult {
                    success: false,
                    source_type: "framelink".to_string(),
                    is_multi_bus: iface_count > 1,
                    bus_count: iface_count,
                    primary_info: device_id.map(|s| s.to_string()),
                    secondary_info: None,
                    supports_fd: None,
                    error: Some(e.to_string()),
                }),
            }
        }

        // Virtual adapter — always succeeds, reports configured interface count and traffic type
        "virtual" => {
            let bus_count = profile
                .connection
                .get("interfaces")
                .and_then(|v| v.as_array())
                .map(|a| a.len() as u8)
                .unwrap_or_else(|| {
                    profile
                        .connection
                        .get("bus_count")
                        .and_then(|v| {
                            v.as_str()
                                .and_then(|s| s.parse::<u8>().ok())
                                .or_else(|| v.as_i64().map(|n| n as u8))
                        })
                        .unwrap_or(1)
                        .clamp(1, 8)
                });
            let traffic_type = profile
                .connection
                .get("traffic_type")
                .and_then(|v| v.as_str())
                .unwrap_or("can");
            let traffic_label = match traffic_type {
                "canfd" => "CAN-FD",
                "modbus" => "Modbus",
                "serial" => "Serial",
                _ => "CAN",
            };
            let supports_fd = traffic_type == "canfd";
            Ok(DeviceProbeResult {
                success: true,
                source_type: "virtual".to_string(),
                is_multi_bus: bus_count > 1,
                bus_count,
                primary_info: Some(format!("{}", traffic_label)),
                secondary_info: Some(format!("{} interface(s)", bus_count)),
                supports_fd: Some(supports_fd),
                error: None,
            })
        }

        // Recorded sources or unsupported types
        _ => Err(format!(
            "Profile '{}' is not a real-time device (kind: {})",
            profile_id, profile.kind
        )),
    };

    // Emit probe result event (fresh probe, not cached)
    if let Ok(ref probe_result) = result {
        emit_device_probe(&app, DeviceProbePayload {
            profile_id: profile_id.clone(),
            source_type: probe_result.source_type.clone(),
            address: probe_result.secondary_info.clone().unwrap_or_default(),
            success: probe_result.success,
            cached: false,
            bus_count: probe_result.bus_count,
            error: probe_result.error.clone(),
        });
        // Cache successful probe results for future use
        cache_probe_result(&profile_id, probe_result);
    }

    result
}

// ============================================================================
// Multi-Source Session Commands
// ============================================================================

/// Source configuration for multi-source session creation (TypeScript-friendly version)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MultiSourceInput {
    /// Profile ID for this source
    pub profile_id: String,
    /// Display name for this source (optional, defaults to profile name)
    pub display_name: Option<String>,
    /// Bus mappings for this source
    pub bus_mappings: Vec<BusMapping>,
    /// Serial framing for this source, overriding the device profile. Flattened,
    /// so the wire shape stays the flat keys the frontend has always sent.
    #[serde(flatten)]
    pub serial: SerialOverrides,
}

/// Convert a MultiSourceInput to a SourceConfig, resolving profile name and kind from settings.
/// `source_idx` is used for auto-assigning output bus numbers when no mappings are provided.
fn resolve_source_config(
    input: MultiSourceInput,
    source_idx: usize,
    settings: &AppSettings,
) -> Result<SourceConfig, String> {
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == input.profile_id)
        .ok_or_else(|| format!("Profile '{}' not found", input.profile_id))?;

    let display_name = input.display_name.unwrap_or_else(|| profile.name.clone());
    let profile_kind = profile.kind.clone();

    // Use provided bus mappings, or fall back to the profile's declared buses.
    // A lone bus-0 guess here is what dropped a multi-bus device's other buses.
    let mut bus_mappings = if input.bus_mappings.is_empty() {
        let mappings = offset_bus_mappings(profile_bus_mappings(profile), source_idx as u8);
        tlog!(
            "[resolve_source_config] Source {} '{}' has no bus mappings, using {} declared bus(es)",
            source_idx, display_name, mappings.len()
        );
        mappings
    } else {
        input.bus_mappings
    };
    io::traits::normalise_bus_traits(&mut bus_mappings, &profile_kind);

    let mut config = SourceConfig {
        profile_id: input.profile_id,
        profile_kind,
        display_name,
        bus_mappings,
        modbus_polls: None,    // Injected by create_multi_source_session
        max_register_errors: None, // Injected by create_multi_source_session
        ..SourceConfig::default()
    };
    // A multi-source serial interface the picker left alone arrives with no
    // framing either, and the broker reads this config the same way.
    apply_serial_overrides(&mut config, profile, input.serial);
    Ok(config)
}

/// Create a multi-source reader session that combines frames from multiple devices.
///
/// This is used for multi-bus capture where frames from diverse sources are merged
/// into a single stream. Each source can have its own bus mappings to:
/// - Filter out disabled buses
/// - Remap device bus numbers to different output bus numbers
///
/// The merged frames are sorted by timestamp and emitted as a single stream.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_multi_source_session(
    app: tauri::AppHandle,
    session_id: String,
    sources: Vec<MultiSourceInput>,
    subscriber_id: Option<String>,
    app_name: Option<String>,
    modbus_polls: Option<String>,
) -> Result<IOCapabilities, String> {
    if sources.is_empty() {
        return Err("At least one source is required".to_string());
    }

    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    // Parse shared Modbus poll groups (if any)
    let parsed_polls: Option<Vec<crate::io::PollGroup>> = match &modbus_polls {
        Some(json) => {
            let polls: Vec<crate::io::PollGroup> = serde_json::from_str(json)
                .map_err(|e| format!("Failed to parse Modbus poll groups: {}", e))?;
            tlog!("[create_multi_source_session] Parsed {} shared Modbus poll groups", polls.len());
            Some(polls)
        }
        None => None,
    };

    // Convert MultiSourceInput to SourceConfig
    let mut source_configs: Vec<SourceConfig> = Vec::with_capacity(sources.len());
    for (source_idx, input) in sources.into_iter().enumerate() {
        source_configs.push(resolve_source_config(input, source_idx, &settings)?);
    }

    // Inject shared Modbus polls and settings into Modbus TCP source configs
    for config in &mut source_configs {
        if config.profile_kind == "modbus_tcp" {
            config.modbus_polls = parsed_polls.clone();
            config.max_register_errors = Some(settings.modbus_max_register_errors);
        }
    }

    // Validate all profiles are real-time devices supported by IOBroker
    for config in &source_configs {
        if !is_realtime_device(&config.profile_kind) {
            return Err(format!(
                "Profile '{}' has unsupported type '{}' for multi-source mode. \
                Currently supported: gvret_tcp, gvret_usb, slcan, gs_usb, socketcan, serial, modbus_tcp, virtual",
                config.profile_id, config.profile_kind
            ));
        }

        // Platform-specific validation
        #[cfg(target_os = "linux")]
        if config.profile_kind == "gs_usb" {
            return Err(format!(
                "Profile '{}' uses gs_usb which on Linux should use SocketCAN interface. \
                Configure a socketcan profile instead.",
                config.profile_id
            ));
        }

        #[cfg(not(target_os = "linux"))]
        if config.profile_kind == "socketcan" {
            return Err(format!(
                "Profile '{}' uses socketcan which is only available on Linux.",
                config.profile_id
            ));
        }

        // Check if profile is already in use
        profile_tracker::can_use_profile(&config.profile_id, &config.profile_kind)?;
    }

    // Track all profiles for this session
    let profile_ids: Vec<String> = source_configs.iter().map(|c| c.profile_id.clone()).collect();

    // Always destroy any existing session with this ID first.
    // This ensures we use the fresh bus mappings provided by the frontend.
    // Without this, a stopped session would be reused with stale mappings.
    // `reset: true` — the session is about to be recreated under this same id, so
    // apps must not treat the teardown as an external death and adopt the orphaned
    // capture. Doing so made the capture the app's next session id, which re-entered
    // this path and churned the session in a loop.
    if get_session_state(&session_id).await.is_some() {
        let _ = destroy_session(&session_id, true).await;
    }

    // Create the multi-source reader (validates interface trait compatibility)
    // Extract display names for logging before moving source_configs
    let source_display_names: Vec<String> = source_configs.iter()
        .map(|c| c.display_name.clone())
        .collect();
    let stored_configs = source_configs.clone();
    let reader = IOBroker::new(app.clone(), session_id.clone(), source_configs)?;

    // Register profile usage BEFORE create_session so lifecycle event has profile IDs
    for profile_id in &profile_ids {
        profile_tracker::register_usage(profile_id, &session_id);
    }
    // Store all profiles for this session (needed for cleanup on destroy)
    register_session_profiles(&session_id, &profile_ids);

    // Anonymous usage telemetry: which source kinds get started (deduped so a
    // multi-bus start doesn't over-count a single user action).
    let mut seen = std::collections::HashSet::new();
    for config in &stored_configs {
        if seen.insert(config.profile_kind.as_str()) {
            crate::telemetry::emit_feature_usage("io_source_start", &config.profile_kind);
        }
    }

    let result = create_session(app, session_id.clone(), Box::new(reader), subscriber_id, app_name, Some(source_display_names), stored_configs).await;

    // Auto-start the session if it's new OR if it exists but is stopped
    let should_start = if result.is_new {
        true
    } else {
        // Check if existing session is stopped
        matches!(
            get_session_state(&session_id).await,
            Some(state) if matches!(state, IOState::Stopped)
        )
    };

    if should_start {
        if let Err(e) = start_session(&session_id).await {
            tlog!(
                "[create_multi_source_session] Failed to auto-start session '{}': {}",
                session_id, e
            );
        }
    }

    Ok(result.capabilities)
}

// ============================================================================
// Profile-to-Session Mapping Commands
// ============================================================================

/// Get all session IDs that are using a specific profile.
/// Used by the IO picker to show "(in use: sessionId)" indicator.
#[tauri::command(rename_all = "snake_case")]
pub fn get_profile_sessions(profile_id: String) -> Vec<String> {
    get_sessions_for_profile(&profile_id)
}

/// Get the count of sessions using a specific profile.
/// Used by the IO picker to determine if reconfiguration should be locked.
/// Returns >= 2 if reconfiguration should be locked.
#[tauri::command(rename_all = "snake_case")]
pub fn get_profile_session_count(profile_id: String) -> usize {
    get_session_count_for_profile(&profile_id)
}

/// Response type for profile usage query
#[derive(Clone, Debug, serde::Serialize)]
pub struct ProfileUsageInfo {
    /// Profile ID
    pub profile_id: String,
    /// Session IDs using this profile
    pub session_ids: Vec<String>,
    /// Number of sessions using this profile
    pub session_count: usize,
    /// Whether reconfiguration is locked (2+ sessions)
    pub config_locked: bool,
}

/// Get usage info for multiple profiles at once.
/// More efficient than calling get_profile_sessions for each profile.
#[tauri::command(rename_all = "snake_case")]
pub fn get_profiles_usage(profile_ids: Vec<String>) -> Vec<ProfileUsageInfo> {
    profile_ids
        .into_iter()
        .map(|profile_id| {
            let session_ids = get_sessions_for_profile(&profile_id);
            let session_count = session_ids.len();
            ProfileUsageInfo {
                profile_id,
                session_ids,
                session_count,
                config_locked: session_count >= 2,
            }
        })
        .collect()
}

/// Update the wake lock settings.
/// Called by frontend when user changes power management settings.
#[tauri::command(rename_all = "snake_case")]
pub fn set_wake_settings(prevent_idle_sleep: bool, keep_display_awake: bool) {
    io_set_wake_settings(prevent_idle_sleep, keep_display_awake);
}

// ============================================================================
// Modbus Scanning
// ============================================================================

/// Find a live session already polling this `host:port`, so a sweep can name the
/// conflict instead of quietly contending for the socket.
///
/// `scan_holding` only sees other *sweeps*; this sees pollers, which is the case
/// that matters now that the Discovery tools only appear during a live session.
async fn endpoint_in_use_by_poller(
    settings: &crate::settings::AppSettings,
    endpoint: &str,
    exclude: &[&str],
) -> Option<(String, String)> {
    for info in crate::io::list_sessions().await {
        // A paused poller still holds its socket — pause stops requests, not the
        // connection — so it contends exactly as a running one does.
        let holds_socket = matches!(
            info.state,
            crate::io::IOState::Running | crate::io::IOState::Paused
        );
        if exclude.contains(&info.session_id.as_str()) || !holds_socket {
            continue;
        }
        let Some(profile) = crate::io::modbus_tcp::session_modbus_profile(settings, &info.session_id)
        else {
            continue;
        };
        if crate::io::modbus_tcp::modbus_endpoint_str(profile) == endpoint {
            return Some((info.session_id.clone(), profile.name.clone()));
        }
    }
    None
}

/// Probe which read function codes a device answers, before sweeping anything.
///
/// `target_session_id` names a live Modbus session to take the address from, so
/// the Discovery tool probes whatever the session is talking to. Only four
/// requests per unit, so this never stops the session for them — a stop/resume
/// cycle would cost far more than the probe does.
#[tauri::command(rename_all = "snake_case")]
pub async fn modbus_probe_function_codes(
    app: tauri::AppHandle,
    mut config: crate::io::FcProbeConfig,
    target_session_id: Option<String>,
) -> Result<Vec<crate::io::FcProbeEntry>, String> {
    if let Some(sid) = &target_session_id {
        let (host, port, _) = crate::io::session_modbus_endpoint(&app, sid)?;
        config.host = host;
        config.port = port;
    }
    // At most four requests per unit, so there is nothing worth cancelling.
    let cancel = Arc::new(AtomicBool::new(false));
    crate::io::modbus_tcp::scanner::probe_function_codes(config, cancel).await
}

/// Create a session that runs a Modbus discovery sweep.
///
/// Needs neither an existing session nor a catalogue — that is the whole point.
/// Results land in the session's frame capture, so the Discovery analysis tools,
/// TOML export and `get_capture_frames` paging all work on them.
///
/// **The session is created stopped.** `ws::dispatch::reset_frame_offset`
/// snapshots the capture's *current* frame count when a subscriber attaches, so
/// anything appended before the frontend subscribes is never pushed over the
/// WebSocket. Callers must subscribe, then call `start_reader_session`. Starting
/// here would look like an intermittent "some registers missing" bug.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_modbus_scan_session(
    app: tauri::AppHandle,
    session_id: String,
    mut job: crate::io::ScanJob,
    profile_id: Option<String>,
    subscriber_id: Option<String>,
    app_name: Option<String>,
    target_session_id: Option<String>,
    stop_target: Option<bool>,
    allow_contention: Option<bool>,
) -> Result<IOCapabilities, String> {
    // Resolve, then refuse, then stop — in that order, and all inside one command.
    //
    // Resolution must precede the stop because stopping swaps a session's profile
    // ids for its capture id (`replace_session_profiles` inside
    // `stop_and_switch_to_capture`), leaving it unable to name its own device.
    // The refusals must also precede it, or a rejected sweep would leave the
    // caller's session stopped for a scan that never ran.
    let settings = crate::settings::load_settings_sync(&app)?;
    if let Some(sid) = &target_session_id {
        let (host, port, _) = crate::io::modbus_tcp::session_modbus_profile(&settings, sid)
            .map(crate::io::modbus_endpoint)
            .ok_or_else(|| format!("Session '{sid}' has no Modbus source profile"))?;
        job.retarget(host, port);
    }

    // A sweep opens its own connection. Devices that serve one Modbus
    // conversation at a time — the cheap stacks this feature exists for — break
    // when a second one arrives, and pausing a poller doesn't help because it
    // keeps its socket. Name the conflict rather than producing junk data.
    let endpoint = job.endpoint();
    if let Some(holder) = crate::io::modbus_tcp::scan_source::scan_holding(&endpoint) {
        if holder != session_id {
            return Err(format!(
                "A Modbus scan of {} is already running as session '{}' — stop it first.",
                endpoint, holder
            ));
        }
    }

    if !allow_contention.unwrap_or(false) {
        // The target is excluded only when the caller has asked for it to be
        // stopped, a few lines below. It used to be excluded unconditionally on
        // the caller's word that it had "already dealt with it" — an exemption
        // nobody paid for, and one pausing cannot earn either: a paused poller
        // keeps its socket, which is exactly why `holds_socket` above counts it.
        let stopping_target = stop_target.unwrap_or(false);
        let exclude: Vec<&str> = std::iter::once(session_id.as_str())
            .chain(target_session_id.as_deref().filter(|_| stopping_target))
            .collect();
        if let Some((holder, name)) =
            endpoint_in_use_by_poller(&settings, &endpoint, &exclude).await
        {
            return Err(format!(
                "{name} is being polled by session '{holder}' — that device may only serve one \
                 Modbus connection at a time. Stop that session, or re-run allowing contention."
            ));
        }
    }

    if stop_target.unwrap_or(false) {
        if let Some(sid) = &target_session_id {
            // Stop, not pause: pause halts requests but keeps the socket, which is
            // exactly what a single-connection device needs released.
            session_stop_to_capture(app.clone(), sid.clone()).await?;
        }
    }

    if let Some(pid) = &profile_id {
        register_session_profile(&session_id, pid);
    }

    let source = crate::io::ModbusScanSource::new(app.clone(), session_id.clone(), job);
    let result = create_session(
        app,
        session_id,
        Box::new(source),
        subscriber_id,
        app_name,
        None,
        vec![],
    )
    .await;
    Ok(result.capabilities)
}

/// Build Modbus poll groups from an address range instead of a catalogue, so a
/// session can poll a device you have no decoder for. The result goes straight
/// into `watchSource`'s `modbusPollsJson`, exactly as catalogue-derived polls do.
#[tauri::command(rename_all = "snake_case")]
pub fn modbus_polls_from_ranges(spec: ModbusRangeSpec) -> Result<Vec<PollGroup>, String> {
    crate::io::build_polls_from_ranges(&spec)
}

// ============================================================================
// Signal-then-fetch query commands
// ============================================================================

#[tauri::command(rename_all = "snake_case")]
pub fn get_playback_position_cmd(session_id: String) -> Option<io::PlaybackPosition> {
    io::get_playback_position(&session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_stream_ended_info(session_id: String) -> Option<io::post_session::StreamEndedInfo> {
    io::post_session::get_stream_ended(&session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_session_error(session_id: String) -> Option<String> {
    io::post_session::get_error(&session_id)
        .or_else(|| io::get_startup_error(&session_id))
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_session_sources(session_id: String) -> Vec<io::post_session::SourceInfo> {
    io::post_session::get_sources(&session_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_orphaned_capture_ids(session_id: String) -> Vec<String> {
    io::post_session::get_orphaned_capture_ids(&session_id)
}

#[cfg(test)]
mod bus_mapping_tests {
    use super::*;
    use serde_json::json;

    /// Minimal profile — only the fields the bus enumeration reads.
    fn profile(kind: &str, connection: serde_json::Value) -> IOProfile {
        IOProfile {
            id: format!("p-{}", kind),
            name: kind.to_string(),
            kind: kind.to_string(),
            connection: connection
                .as_object()
                .expect("connection must be an object")
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            preferred_catalog: None,
            ephemeral: false,
        }
    }

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

        io::traits::normalise_bus_traits(&mut mappings, "gvret_tcp");

        let traits = mappings[0].traits.as_ref().unwrap();
        assert!(traits.protocols.contains(&Protocol::CanFd));
        assert!(!traits.protocols.contains(&Protocol::Serial));
        assert!(traits.tx_frames, "a CAN FD bus transmits frames, not bytes");
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
    // resolve_source_config is the funnel every multi-source session goes
    // through. What it does with an *empty* bus_mappings is what silently
    // dropped a multi-bus device's extra buses.

    fn settings_with(profiles: Vec<IOProfile>) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.io_profiles = profiles;
        settings
    }

    fn input_for(profile_id: &str, bus_mappings: serde_json::Value) -> MultiSourceInput {
        serde_json::from_value(json!({
            "profile_id": profile_id,
            "display_name": null,
            "bus_mappings": bus_mappings,
        }))
        .expect("MultiSourceInput should deserialise")
    }

    fn resolve(profile: IOProfile, bus_mappings: serde_json::Value, source_idx: usize) -> SourceConfig {
        let id = profile.id.clone();
        let settings = settings_with(vec![profile]);
        resolve_source_config(input_for(&id, bus_mappings), source_idx, &settings)
            .expect("profile is present, so this resolves")
    }

    #[test]
    fn no_mappings_falls_back_to_every_bus_the_profile_declares() {
        let config = resolve(
            gvret(json!({
                "interfaces": [
                    { "device_bus": 0, "enabled": true, "protocol": "can" },
                    { "device_bus": 1, "enabled": true, "protocol": "can" },
                ]
            })),
            json!([]),
            0,
        );

        assert_eq!(config.bus_mappings.len(), 2, "a 2-bus device must not resolve to one bus");
        assert_eq!(
            config.bus_mappings.iter().map(|m| m.device_bus).collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn no_mappings_keeps_framelink_interfaces_too() {
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
    fn a_second_source_does_not_land_on_the_first_ones_buses() {
        let config = resolve(
            gvret(json!({
                "interfaces": [
                    { "device_bus": 0, "enabled": true, "protocol": "can" },
                    { "device_bus": 1, "enabled": true, "protocol": "can" },
                ]
            })),
            json!([]),
            1,
        );

        assert_eq!(
            config.bus_mappings.iter().map(|m| m.output_bus).collect::<Vec<_>>(),
            vec![1, 2],
            "source 1 starts at output bus 1, and its second bus follows on"
        );
    }

    #[test]
    fn explicit_mappings_from_the_picker_win_untouched() {
        // The picker resolves buses itself (probe included), so whatever it
        // sends is authoritative — including a deliberate remap and a bus the
        // user unticked for this session only.
        let config = resolve(
            gvret(json!({
                "interfaces": [
                    { "device_bus": 0, "enabled": true, "protocol": "can" },
                    { "device_bus": 1, "enabled": true, "protocol": "can" },
                ]
            })),
            json!([
                { "device_bus": 0, "enabled": true, "output_bus": 4 },
                { "device_bus": 1, "enabled": false, "output_bus": 5 },
            ]),
            0,
        );

        assert_eq!(config.bus_mappings.len(), 2);
        assert_eq!(config.bus_mappings[0].output_bus, 4);
        assert!(!config.bus_mappings[1].enabled);
    }

    #[test]
    fn a_profile_that_declares_nothing_still_resolves_to_one_bus() {
        let config = resolve(gvret(json!({ "host": "127.0.0.1", "port": "2323" })), json!([]), 0);
        assert_eq!(config.bus_mappings.len(), 1);
        assert_eq!(config.bus_mappings[0].device_bus, 0);
    }

    #[test]
    fn an_unknown_profile_is_an_error_not_a_default_session() {
        let settings = settings_with(vec![]);
        assert!(resolve_source_config(input_for("io_missing", json!([])), 0, &settings).is_err());
    }
}
