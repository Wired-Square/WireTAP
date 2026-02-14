// ui/src-tauri/src/sessions.rs
//
// Tauri commands for IO session lifecycle.
// Handles session creation, control (start/stop/pause/resume), and destruction.

use crate::{
    buffer_store,
    credentials,
    io::{
        create_session, destroy_session, get_session_capabilities, get_session_joiner_count, get_session_state,
        get_session_listeners, join_session, leave_session, list_sessions, pause_session,
        reconfigure_session, register_listener, reinitialize_session_if_safe, resume_session,
        resume_session_fresh, seek_session, seek_session_by_frame, set_listener_active, start_session, stop_session,
        suspend_session, switch_to_buffer_replay, resume_to_live_session, transmit_frame, unregister_listener,
        update_session_direction, update_session_speed, update_session_time_range, ActiveSessionInfo, IOCapabilities, IODevice, IOState,
        JoinSessionResult, ListenerInfo, RegisterListenerResult, ReinitializeResult, BufferReader, step_frame, StepResult,
        BusMapping, InterfaceTraits, Protocol, TemporalMode,
        CsvReader, CsvReaderOptions,
        GvretDeviceInfo, probe_gvret_tcp,
        MqttConfig, MqttReader,
        MultiSourceReader, SourceConfig,
        PostgresConfig, PostgresReader, PostgresReaderOptions, PostgresSourceType,
        CanTransmitFrame, TransmitResult,
        emit_device_probe, DeviceProbePayload,
        set_wake_settings as io_set_wake_settings,
    },
    profile_tracker,
    settings::{self, AppSettings, IOProfile},
};
#[cfg(not(target_os = "ios"))]
use crate::io::probe_gvret_usb;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

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
#[allow(dead_code)]
pub fn clear_probe_cache(profile_id: &str) {
    if let Ok(mut cache) = PROBE_CACHE.lock() {
        cache.remove(profile_id);
    }
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
/// This should be called when a session is destroyed via unregister_listener
/// (auto-destroy when last listener leaves), since that code path doesn't
/// go through destroy_reader_session which normally handles this.
pub fn cleanup_session_profiles(session_id: &str) {
    let profile_ids = take_session_profiles(session_id);
    for profile_id in profile_ids {
        profile_tracker::unregister_usage_by_session(&profile_id, session_id);
    }
}

/// Get a secure credential for a profile, checking keyring if marked as stored there.
fn get_secure_credential(profile: &IOProfile, field: &str) -> Option<String> {
    // Check if the credential is stored in keyring
    let stored_key = format!("_{}_stored", field);
    let is_stored_in_keyring = profile
        .connection
        .get(&stored_key)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if is_stored_in_keyring {
        // Try to fetch from keyring
        match credentials::get_credential(&profile.id, field) {
            Ok(Some(value)) => Some(value),
            Ok(None) => {
                eprintln!(
                    "[get_secure_credential] No {} found in keyring for profile {}",
                    field, profile.id
                );
                None
            }
            Err(e) => {
                eprintln!(
                    "[get_secure_credential] Failed to get {} from keyring for profile {}: {}",
                    field, profile.id, e
                );
                None
            }
        }
    } else {
        // Fall back to connection field (for backward compatibility with old profiles)
        profile
            .connection
            .get(field)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
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

/// Check if a profile kind is a real-time device that can use MultiSourceReader.
/// These devices support the multi-source architecture for unified session handling.
fn is_realtime_device(kind: &str) -> bool {
    matches!(
        kind,
        "gvret_tcp" | "gvret-tcp" | "gvret_usb" | "gvret-usb" | "slcan" | "gs_usb" | "socketcan" | "serial"
    )
}

/// Create a SourceConfig from an IOProfile for use with MultiSourceReader.
/// This extracts the common device configuration logic used by both single-device
/// and multi-device session creation.
///
/// Returns None for non-realtime devices (postgres, csv_file, mqtt, serial, buffer)
/// which should use their direct readers instead.
fn create_source_config_from_profile(
    profile: &IOProfile,
    bus_override: Option<u8>,
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

    Some(SourceConfig {
        profile_id: profile.id.clone(),
        profile_kind: profile.kind.clone(),
        display_name: profile.name.clone(),
        bus_mappings,
        // Single-source sessions don't pass framing through session options
        // (they use profile.connection settings or session-level reinitialize options)
        framing_encoding: None,
        delimiter: None,
        max_frame_length: None,
        min_frame_length: None,
        emit_raw_bytes: None,
        // Frame ID extraction - not passed for single-source (uses profile settings)
        frame_id_start_byte: None,
        frame_id_bytes: None,
        frame_id_big_endian: None,
        source_address_start_byte: None,
        source_address_bytes: None,
        source_address_big_endian: None,
    })
}

/// Parse interfaces configuration from profile connection field.
/// Returns None if no interfaces are configured, otherwise returns bus mappings.
fn parse_interfaces_from_profile(
    profile: &IOProfile,
    bus_override: Option<u8>,
) -> Option<Vec<BusMapping>> {
    // Only GVRET profiles have multi-bus interface configuration
    if !matches!(
        profile.kind.as_str(),
        "gvret_tcp" | "gvret-tcp" | "gvret_usb" | "gvret-usb"
    ) {
        return None;
    }

    let interfaces = profile.connection.get("interfaces")?.as_array()?;
    if interfaces.is_empty() {
        return None;
    }

    let mappings: Vec<BusMapping> = interfaces
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let device_bus = obj.get("device_bus")?.as_u64()? as u8;
            let enabled = obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            let protocol = obj
                .get("protocol")
                .and_then(|v| v.as_str())
                .unwrap_or("can");

            // Use bus_override for output_bus if provided, otherwise use device_bus
            let output_bus = bus_override.unwrap_or(device_bus);

            // Determine protocols based on interface protocol setting
            let protocols = match protocol {
                "canfd" => vec![Protocol::Can, Protocol::CanFd],
                _ => vec![Protocol::Can],
            };

            Some(BusMapping {
                device_bus,
                enabled,
                output_bus,
                interface_id: format!("can{}", device_bus),
                traits: Some(InterfaceTraits {
                    temporal_mode: TemporalMode::Realtime,
                    protocols,
                    can_transmit: true,
                }),
            })
        })
        .collect();

    if mappings.is_empty() {
        None
    } else {
        Some(mappings)
    }
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

    // Determine interface traits based on profile kind
    let (interface_id, protocols, can_transmit) = match profile.kind.as_str() {
        "gvret_tcp" | "gvret-tcp" | "gvret_usb" | "gvret-usb" => {
            ("can0".to_string(), vec![Protocol::Can, Protocol::CanFd], true)
        }
        "slcan" => ("can0".to_string(), vec![Protocol::Can], true),
        "gs_usb" => ("can0".to_string(), vec![Protocol::Can, Protocol::CanFd], true),
        "socketcan" => ("can0".to_string(), vec![Protocol::Can, Protocol::CanFd], true),
        _ => ("can0".to_string(), vec![Protocol::Can], true),
    };

    vec![BusMapping {
        device_bus: 0,
        output_bus,
        enabled: true,
        interface_id,
        traits: Some(InterfaceTraits {
            temporal_mode: TemporalMode::Realtime,
            protocols,
            can_transmit,
        }),
    }]
}

/// Create a new reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn create_reader_session(
    app: tauri::AppHandle,
    session_id: String,
    profile_id: Option<String>,
    start_time: Option<String>,
    end_time: Option<String>,
    speed: Option<f64>,
    limit: Option<i64>,
    file_path: Option<String>,
    // Bus override for single-bus devices (overrides profile config)
    bus_override: Option<u8>,
    // Listener ID (for session logging)
    listener_id: Option<String>,
) -> Result<IOCapabilities, String> {
    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = choose_profile_by_id(&settings, profile_id.as_deref())
        .ok_or_else(|| "No IO profile configured".to_string())?;

    // Check if this profile is already in use (for single-handle devices)
    profile_tracker::can_use_profile(&profile.id, &profile.kind)?;

    // Track profile_id for later registration
    let profile_id_for_tracking = profile.id.clone();

    // Create the appropriate reader based on profile kind
    // Real-time devices (gvret, slcan, gs_usb, socketcan) use MultiSourceReader for unified handling
    let is_realtime = is_realtime_device(&profile.kind);
    let reader: Box<dyn IODevice> = if is_realtime {
        // Use MultiSourceReader for all real-time devices (unified path)
        let source_config = create_source_config_from_profile(&profile, bus_override)
            .ok_or_else(|| format!("Failed to create source config for profile '{}'", profile.id))?;

        Box::new(MultiSourceReader::single_source(
            app.clone(),
            session_id.clone(),
            source_config,
        )?)
    } else {
        // Non-realtime devices use their direct readers
        match profile.kind.as_str() {
        "postgres" => {
            let config = PostgresConfig {
                host: profile
                    .connection
                    .get("host")
                    .and_then(|v| v.as_str())
                    .unwrap_or("localhost")
                    .to_string(),
                port: profile
                    .connection
                    .get("port")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(5432) as u16,
                database: profile
                    .connection
                    .get("database")
                    .or_else(|| profile.connection.get("db"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "PostgreSQL database name is required".to_string())?
                    .to_string(),
                username: profile
                    .connection
                    .get("username")
                    .or_else(|| profile.connection.get("user"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "PostgreSQL username is required".to_string())?
                    .to_string(),
                password: get_secure_credential(&profile, "password"),
                sslmode: profile
                    .connection
                    .get("sslmode")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            };

            // Use provided time range or fall back to profile settings
            let start_from_profile = profile
                .connection
                .get("start")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let end_from_profile = profile
                .connection
                .get("end")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            eprintln!(
                "[create_reader_session] PostgreSQL time range - param start: {:?}, param end: {:?}, profile start: {:?}, profile end: {:?}",
                start_time, end_time, start_from_profile, end_from_profile
            );

            // Use provided limit or fall back to profile settings
            let limit_from_profile = profile.connection.get("limit").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));

            // Extract source type (defaults to can_frame for backward compatibility)
            let source_type = profile
                .connection
                .get("source_type")
                .and_then(|v| v.as_str())
                .map(PostgresSourceType::from_str)
                .unwrap_or_default();

            let options = PostgresReaderOptions {
                source_type,
                start: start_time.or(start_from_profile),
                end: end_time.or(end_from_profile),
                limit: limit.or(limit_from_profile),
                speed: speed.unwrap_or_else(|| {
                    profile
                        .connection
                        .get("speed")
                        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(0.0) // 0 = no limit (no pacing) by default
                }),
                batch_size: profile
                    .connection
                    .get("batch_size")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(1000) as i32,
            };

            Box::new(PostgresReader::new(
                app.clone(),
                session_id.clone(),
                config,
                options,
            ))
        }
        "csv_file" | "csv-file" => {
            // Use file_path parameter if provided, otherwise fall back to profile's configured path
            let profile_file_path = profile
                .connection
                .get("file_path")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());

            let path = file_path.or(profile_file_path).ok_or_else(|| {
                "CSV file path is required. Please select a file or configure a path in the profile.".to_string()
            })?;

            let options = CsvReaderOptions {
                file_path: path,
                speed: speed.unwrap_or_else(|| {
                    profile
                        .connection
                        .get("default_speed")
                        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(0.0) // 0 = no limit by default
                }),
            };

            Box::new(CsvReader::new(app.clone(), session_id.clone(), options))
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

            // Get password from keyring if stored, otherwise from profile
            let password_stored = profile
                .connection
                .get("_password_stored")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let password = if password_stored {
                credentials::get_credential(&profile.id, "password").ok().flatten()
            } else {
                profile
                    .connection
                    .get("password")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            };

            // Get subscription topic from savvycan format config
            let topic = profile
                .connection
                .get("formats")
                .and_then(|f| f.get("savvycan"))
                .and_then(|s| s.get("topic"))
                .and_then(|v| v.as_str())
                .unwrap_or("candor/#")
                .to_string();

            let config = MqttConfig {
                host,
                port,
                username,
                password,
                topic,
                client_id: None,
            };

            Box::new(MqttReader::new(app.clone(), session_id.clone(), config))
        }
        kind => {
            return Err(format!(
                "Unsupported reader type '{}'. Supported: mqtt, gvret_tcp, gvret_usb, postgres, csv_file, serial, slcan, socketcan, gs_usb",
                kind
            ));
        }
    }
    };

    // Register profile usage BEFORE create_session so lifecycle event has profile IDs
    profile_tracker::register_usage(&profile_id_for_tracking, &session_id);
    register_session_profile(&session_id, &profile_id_for_tracking);

    let result = create_session(app, session_id.clone(), reader, listener_id, None).await;

    // Auto-start the session after creation (only for real-time devices)
    // Playback sources (postgres, csv) should NOT auto-start because frames would be emitted
    // before the frontend has registered its listener and set up event handlers.
    // The frontend will call start_reader_session after registering the listener.
    let is_playback_source = matches!(profile.kind.as_str(), "postgres" | "csv_file" | "csv-file");

    if result.is_new && !is_playback_source {
        eprintln!("[create_reader_session] Auto-starting new session '{}' (real-time device)", session_id);
        if let Err(e) = start_session(&session_id).await {
            eprintln!("[create_reader_session] Failed to auto-start session '{}': {}", session_id, e);
            // Don't fail the whole creation - session is created but not started
        }
    } else if result.is_new && is_playback_source {
        eprintln!("[create_reader_session] Created playback session '{}' (not auto-starting - frontend will start after listener registration)", session_id);
    } else {
        eprintln!("[create_reader_session] Joined existing session '{}' (listener_count: {})", session_id, result.listener_count);
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

/// Join an existing reader session (for session sharing between apps).
/// Returns session info if session exists, error if not.
/// The caller can then set up event listeners to receive frames and state changes.
#[tauri::command(rename_all = "snake_case")]
pub async fn join_reader_session(session_id: String) -> Result<JoinSessionResult, String> {
    join_session(&session_id).await
}

/// Leave a reader session without stopping it.
/// Call this when you want to stop listening but not stop the session.
/// Returns the new joiner count.
#[tauri::command(rename_all = "snake_case")]
pub async fn leave_reader_session(session_id: String) -> Result<usize, String> {
    leave_session(&session_id).await
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

/// Suspend a reader session - stops streaming, finalizes buffer, session stays alive.
/// The buffer remains owned by the session and all joined apps can view it.
/// Use `resume_reader_session_fresh` to start streaming again with a new buffer.
#[tauri::command(rename_all = "snake_case")]
pub async fn suspend_reader_session(session_id: String) -> Result<IOState, String> {
    suspend_session(&session_id).await
}

/// Resume a suspended session with a fresh buffer.
/// The old buffer is orphaned (becomes available for standalone viewing).
/// A new buffer is created for the session and streaming starts.
#[tauri::command(rename_all = "snake_case")]
pub async fn resume_reader_session_fresh(session_id: String) -> Result<IOState, String> {
    resume_session_fresh(&session_id).await
}

/// Copy a buffer for an app that is detaching from a session.
/// Creates an orphaned copy of the buffer that can be used standalone.
/// Returns the new buffer ID.
#[tauri::command(rename_all = "snake_case")]
pub fn copy_buffer_for_detach(buffer_id: String, new_name: String) -> Result<String, String> {
    buffer_store::copy_buffer(&buffer_id, new_name)
}

/// Update playback speed for a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn update_reader_speed(session_id: String, speed: f64) -> Result<(), String> {
    update_session_speed(&session_id, speed).await
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
/// This stops the current stream, orphans the old buffer, creates a new buffer,
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

/// Seek to a specific frame index (preferred for buffer playback - avoids floating-point issues)
#[tauri::command(rename_all = "snake_case")]
pub async fn seek_reader_session_by_frame(session_id: String, frame_index: i64) -> Result<(), String> {
    seek_session_by_frame(&session_id, frame_index).await
}

/// Set playback direction for a reader session (reverse = true for backwards playback)
#[tauri::command(rename_all = "snake_case")]
pub async fn update_reader_direction(session_id: String, reverse: bool) -> Result<(), String> {
    update_session_direction(&session_id, reverse).await
}

/// Destroy a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn destroy_reader_session(session_id: String) -> Result<(), String> {
    // Unregister profile usage for all profiles this session was using
    let profile_ids = take_session_profiles(&session_id);
    for profile_id in profile_ids {
        profile_tracker::unregister_usage_by_session(&profile_id, &session_id);
    }

    // Orphan any buffers owned by this session
    buffer_store::orphan_buffers_for_session(&session_id);

    destroy_session(&session_id).await
}

/// Create a reader session for the shared buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn create_buffer_reader_session(
    app: tauri::AppHandle,
    session_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    if !buffer_store::has_data() {
        return Err("No data in buffer. Please import a CSV file first.".to_string());
    }

    let reader = BufferReader::new(
        app.clone(),
        session_id.clone(),
        speed.unwrap_or(0.0), // 0 = no limit by default
    );

    let result = create_session(app, session_id, Box::new(reader), None, None).await;
    Ok(result.capabilities)
}

/// Transition an existing session to use the shared buffer for replay
/// This is used when a streaming source (GVRET, PostgreSQL) ends and
/// the user wants to replay the captured frames.
#[tauri::command(rename_all = "snake_case")]
pub async fn transition_to_buffer_reader(
    app: tauri::AppHandle,
    session_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    // Stop and destroy current session
    let _ = stop_session(&session_id).await;
    let _ = destroy_session(&session_id).await;

    if !buffer_store::has_data() {
        return Err("No data in buffer for replay".to_string());
    }

    // Create BufferReader with the captured frames
    let reader = BufferReader::new(
        app.clone(),
        session_id.clone(),
        speed.unwrap_or(1.0), // Default to 1x speed for replay
    );

    let result = create_session(app, session_id, Box::new(reader), None, None).await;
    Ok(result.capabilities)
}

/// Switch a session to buffer replay mode without destroying it.
/// This swaps the session's reader to a BufferReader that reads from the session's
/// owned buffer. All listeners stay connected and can replay the captured data.
/// Use this after ingest completes to enable playback controls.
#[tauri::command(rename_all = "snake_case")]
pub async fn switch_session_to_buffer_replay(
    app: tauri::AppHandle,
    session_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    switch_to_buffer_replay(&app, &session_id, speed.unwrap_or(1.0)).await
}

/// Resume a session from buffer playback back to live streaming.
/// This is the reverse of switch_session_to_buffer_replay.
/// It recreates the original reader from the stored profile configuration,
/// orphans the current buffer (preserving data for later viewing), and starts
/// streaming into a fresh buffer.
///
/// Only supported for realtime devices (gvret, slcan, gs_usb, socketcan).
/// Returns an error for timeline sources (postgres, csv, mqtt) which don't
/// have the live/buffer toggle concept.
#[tauri::command(rename_all = "snake_case")]
pub async fn resume_session_to_live(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<IOCapabilities, String> {
    // Get the profile IDs for this session
    let profile_ids = get_session_profile_ids(&session_id);
    if profile_ids.is_empty() {
        return Err(format!(
            "No profile IDs found for session '{}'. Cannot resume to live.",
            session_id
        ));
    }

    // Load settings to get profile configs
    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    // For now, only support single-source sessions (first profile)
    // Multi-source resume could be added later
    let profile_id = &profile_ids[0];
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == *profile_id)
        .ok_or_else(|| format!("Profile '{}' not found in settings", profile_id))?;

    // Only realtime devices support live/buffer toggle
    if !is_realtime_device(&profile.kind) {
        return Err(format!(
            "Cannot resume to live for '{}' device type. Only realtime devices (gvret, slcan, gs_usb, socketcan) support live/buffer toggle.",
            profile.kind
        ));
    }

    // Create the reader from profile config (same logic as create_reader_session)
    let source_config = create_source_config_from_profile(profile, None)
        .ok_or_else(|| format!("Failed to create source config for profile '{}'", profile_id))?;

    let new_reader: Box<dyn IODevice> = Box::new(MultiSourceReader::single_source(
        app.clone(),
        session_id.clone(),
        source_config,
    )?);

    // Call the io module to do the actual session manipulation
    resume_to_live_session(&session_id, new_reader).await
}

/// Step one frame forward or backward in the buffer.
/// Returns the new frame index and timestamp after stepping, or None if at the boundary.
/// Only works when the session is paused.
/// Requires either current_frame_index or current_timestamp_us to determine position.
/// If filter_frame_ids is provided, skips frames that don't match the filter.
#[tauri::command(rename_all = "snake_case")]
pub async fn step_buffer_frame(
    app: tauri::AppHandle,
    session_id: String,
    current_frame_index: Option<usize>,
    current_timestamp_us: Option<i64>,
    backward: bool,
    filter_frame_ids: Option<Vec<u32>>,
) -> Result<Option<StepResult>, String> {
    step_frame(&app, &session_id, current_frame_index, current_timestamp_us, backward, filter_frame_ids.as_deref())
}

// Legacy heartbeat commands removed - use register_session_listener/unregister_session_listener instead

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
pub async fn register_session_listener(
    session_id: String,
    listener_id: String,
) -> Result<RegisterListenerResult, String> {
    register_listener(&session_id, &listener_id).await
}

/// Unregister a listener from a session.
/// If this was the last listener, the session will be stopped (but not destroyed).
/// Returns the remaining listener count.
#[tauri::command(rename_all = "snake_case")]
pub async fn unregister_session_listener(
    session_id: String,
    listener_id: String,
) -> Result<usize, String> {
    unregister_listener(&session_id, &listener_id).await
}

/// Get all listeners for a session.
/// Useful for debugging and for the frontend to understand session state.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_session_listener_list(session_id: String) -> Result<Vec<ListenerInfo>, String> {
    get_session_listeners(&session_id).await
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
    listener_id: String,
) -> Result<ReinitializeResult, String> {
    reinitialize_session_if_safe(&session_id, &listener_id).await
}

/// Set whether a listener is active (receiving frames).
/// When a listener detaches, set is_active to false to stop receiving frames.
/// When they rejoin, set is_active to true to resume receiving frames.
/// This is handled in Rust to avoid frontend race conditions.
#[tauri::command(rename_all = "snake_case")]
pub async fn set_session_listener_active(
    session_id: String,
    listener_id: String,
    is_active: bool,
) -> Result<(), String> {
    set_listener_active(&session_id, &listener_id, is_active).await
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
        "gvret_tcp" | "gvret-tcp" => {
            let host = profile
                .connection
                .get("host")
                .and_then(|v| v.as_str())
                .unwrap_or("127.0.0.1");
            let port = profile
                .connection
                .get("port")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(23) as u16;
            let timeout_sec = profile
                .connection
                .get("timeout")
                .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(5.0);

            probe_gvret_tcp(host, port, timeout_sec)
                .await
                .map_err(String::from)
        }
        #[cfg(not(target_os = "ios"))]
        "gvret_usb" | "gvret-usb" => {
            let port = profile
                .connection
                .get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required for GVRET USB".to_string())?;
            let baud_rate = profile
                .connection
                .get("baud_rate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(115200) as u32;

            // Run blocking serial probe in a dedicated thread
            let port_owned = port.to_string();
            tokio::task::spawn_blocking(move || {
                probe_gvret_usb(&port_owned, baud_rate).map_err(String::from)
            })
                .await
                .map_err(|e| format!("Probe task failed: {}", e))?
        }
        #[cfg(target_os = "ios")]
        "gvret_usb" | "gvret-usb" => {
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
    pub device_type: String,
    /// Whether this is a multi-bus device (GVRET can have multiple CAN buses)
    pub is_multi_bus: bool,
    /// Number of buses available (1 for single-bus devices, 1-5 for GVRET)
    pub bus_count: u8,
    /// Primary info line (firmware version, device name, etc.)
    pub primary_info: Option<String>,
    /// Secondary info line (hardware version, channel count, etc.)
    pub secondary_info: Option<String>,
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

    // Check cache first - if we have a successful probe result, return it immediately
    if let Some(cached) = get_cached_probe(&profile_id) {
        eprintln!("[probe_device] Returning cached probe result for profile '{}'", profile_id);
        emit_device_probe(&app, DeviceProbePayload {
            profile_id: profile_id.clone(),
            device_type: cached.device_type.clone(),
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
        "gvret_tcp" | "gvret-tcp" => {
            let host = profile.connection.get("host")
                .and_then(|v| v.as_str())
                .unwrap_or("127.0.0.1");
            let port = profile.connection.get("port")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(23) as u16;
            let timeout_sec = profile.connection.get("timeout")
                .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(5.0);

            match probe_gvret_tcp(host, port, timeout_sec).await {
                Ok(info) => Ok(DeviceProbeResult {
                    success: true,
                    device_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: info.bus_count,
                    primary_info: Some(format!("{} buses available", info.bus_count)),
                    secondary_info: Some(format!("{}:{}", host, port)),
                    error: None,
                }),
                Err(e) => Ok(DeviceProbeResult {
                    success: false,
                    device_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    error: Some(e.to_string()),
                }),
            }
        }

        #[cfg(not(target_os = "ios"))]
        "gvret_usb" | "gvret-usb" => {
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
                    device_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: info.bus_count,
                    primary_info: Some(format!("{} buses available", info.bus_count)),
                    secondary_info: Some(port.to_string()),
                    error: None,
                }),
                Ok(Err(e)) => Ok(DeviceProbeResult {
                    success: false,
                    device_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    error: Some(e.to_string()),
                }),
                Err(e) => Ok(DeviceProbeResult {
                    success: false,
                    device_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    error: Some(format!("Probe task failed: {}", e)),
                }),
            }
        }
        #[cfg(target_os = "ios")]
        "gvret_usb" | "gvret-usb" => {
            Ok(DeviceProbeResult {
                success: false,
                device_type: "gvret".to_string(),
                is_multi_bus: true,
                bus_count: 0,
                primary_info: None,
                secondary_info: None,
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
            let baud_rate = profile.connection.get("baud_rate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(115200) as u32;
            let data_bits = profile.connection.get("data_bits")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .map(|v| v as u8);
            let stop_bits = profile.connection.get("stop_bits")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .map(|v| v as u8);
            let parity = profile.connection.get("parity")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let result = tokio::task::spawn_blocking(move || {
                probe_slcan_device(port, baud_rate, data_bits, stop_bits, parity)
            }).await.map_err(|e| format!("Probe task failed: {}", e))?;

            Ok(DeviceProbeResult {
                success: result.success,
                device_type: "slcan".to_string(),
                is_multi_bus: false,
                bus_count: if result.success { 1 } else { 0 },
                primary_info: result.version,
                secondary_info: result.hardware_version,
                error: result.error,
            })
        }
        #[cfg(target_os = "ios")]
        "slcan" => {
            Ok(DeviceProbeResult {
                success: false,
                device_type: "slcan".to_string(),
                is_multi_bus: false,
                bus_count: 0,
                primary_info: None,
                secondary_info: None,
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

            match probe_gs_usb_device(bus, address) {
                Ok(info) => Ok(DeviceProbeResult {
                    success: true,
                    device_type: "gs_usb".to_string(),
                    is_multi_bus: false,
                    bus_count: info.channel_count.unwrap_or(1) as u8,
                    primary_info: info.channel_count.map(|c| format!("{} channel(s)", c)),
                    secondary_info: if info.supports_fd.unwrap_or(false) {
                        Some("CAN FD supported".to_string())
                    } else {
                        None
                    },
                    error: None,
                }),
                Err(e) => Ok(DeviceProbeResult {
                    success: false,
                    device_type: "gs_usb".to_string(),
                    is_multi_bus: false,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    error: Some(e),
                }),
            }
        }

        // SocketCAN - Linux only, check if interface exists
        #[cfg(target_os = "linux")]
        "socketcan" => {
            let interface = profile.connection.get("interface")
                .and_then(|v| v.as_str())
                .unwrap_or("can0");

            // Check if the interface exists by reading from /sys/class/net
            let path = format!("/sys/class/net/{}", interface);
            if std::path::Path::new(&path).exists() {
                Ok(DeviceProbeResult {
                    success: true,
                    device_type: "socketcan".to_string(),
                    is_multi_bus: false,
                    bus_count: 1,
                    primary_info: Some(format!("Interface: {}", interface)),
                    secondary_info: None,
                    error: None,
                })
            } else {
                Ok(DeviceProbeResult {
                    success: false,
                    device_type: "socketcan".to_string(),
                    is_multi_bus: false,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
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
                    device_type: "serial".to_string(),
                    is_multi_bus: false,
                    bus_count: 1,
                    primary_info: Some(port.to_string()),
                    secondary_info: None,
                    error: None,
                })
            } else {
                Ok(DeviceProbeResult {
                    success: false,
                    device_type: "serial".to_string(),
                    is_multi_bus: false,
                    bus_count: 0,
                    primary_info: None,
                    secondary_info: None,
                    error: Some(format!("Port '{}' not found", port)),
                })
            }
        }
        #[cfg(target_os = "ios")]
        "serial" => {
            Ok(DeviceProbeResult {
                success: false,
                device_type: "serial".to_string(),
                is_multi_bus: false,
                bus_count: 0,
                primary_info: None,
                secondary_info: None,
                error: Some("Serial ports are not available on iOS".to_string()),
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
            device_type: probe_result.device_type.clone(),
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
    /// Framing encoding for serial sources (overrides profile settings if provided)
    #[serde(default)]
    pub framing_encoding: Option<String>,
    /// Delimiter bytes for delimiter-based framing
    #[serde(default)]
    pub delimiter: Option<Vec<u8>>,
    /// Maximum frame length for delimiter-based framing
    #[serde(default)]
    pub max_frame_length: Option<usize>,
    /// Minimum frame length - frames shorter than this are discarded
    #[serde(default)]
    pub min_frame_length: Option<usize>,
    /// Whether to emit raw bytes in addition to framed data
    #[serde(default)]
    pub emit_raw_bytes: Option<bool>,
    /// Frame ID extraction: start byte position (0-indexed)
    #[serde(default)]
    pub frame_id_start_byte: Option<i32>,
    /// Frame ID extraction: number of bytes (1 or 2)
    #[serde(default)]
    pub frame_id_bytes: Option<u8>,
    /// Frame ID extraction: byte order (true = big endian)
    #[serde(default)]
    pub frame_id_big_endian: Option<bool>,
    /// Source address extraction: start byte position (0-indexed)
    #[serde(default)]
    pub source_address_start_byte: Option<i32>,
    /// Source address extraction: number of bytes (1 or 2)
    #[serde(default)]
    pub source_address_bytes: Option<u8>,
    /// Source address extraction: byte order (true = big endian)
    #[serde(default)]
    pub source_address_big_endian: Option<bool>,
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
    listener_id: Option<String>,
) -> Result<IOCapabilities, String> {
    if sources.is_empty() {
        return Err("At least one source is required".to_string());
    }

    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    // Convert MultiSourceInput to SourceConfig, resolving profile names and kinds
    // Auto-assign unique output bus numbers based on source index to distinguish frames from different devices
    let mut source_configs: Vec<SourceConfig> = Vec::with_capacity(sources.len());
    for (source_idx, input) in sources.into_iter().enumerate() {
        // Look up the profile to get its kind
        let profile = settings
            .io_profiles
            .iter()
            .find(|p| p.id == input.profile_id)
            .ok_or_else(|| format!("Profile '{}' not found", input.profile_id))?;

        let display_name = input.display_name.unwrap_or_else(|| profile.name.clone());
        let profile_kind = profile.kind.clone();

        // Determine interface traits based on profile kind
        let (default_interface_id, default_protocols, default_can_transmit) = match profile_kind.as_str() {
            "gvret_tcp" | "gvret-tcp" | "gvret_usb" | "gvret-usb" => {
                ("can0".to_string(), vec![Protocol::Can, Protocol::CanFd], true)
            }
            "slcan" => ("can0".to_string(), vec![Protocol::Can], true),
            "gs_usb" => ("can0".to_string(), vec![Protocol::Can, Protocol::CanFd], true),
            "socketcan" => ("can0".to_string(), vec![Protocol::Can, Protocol::CanFd], true),
            _ => ("can0".to_string(), vec![Protocol::Can], true),
        };

        // Use provided bus mappings, or auto-assign if none provided
        // The frontend now handles sequential assignment, so we trust mappings as-is
        let bus_mappings = if input.bus_mappings.is_empty() {
            // No mappings provided - create default for device bus 0 with source index as output
            let output_bus = source_idx as u8;
            eprintln!(
                "[create_multi_source_session] Source {} '{}' has no bus mappings, auto-assigning output bus {}",
                source_idx, display_name, output_bus
            );
            vec![BusMapping {
                device_bus: 0,
                enabled: true,
                output_bus,
                interface_id: default_interface_id,
                traits: Some(InterfaceTraits {
                    temporal_mode: TemporalMode::Realtime,
                    protocols: default_protocols,
                    can_transmit: default_can_transmit,
                }),
            }]
        } else {
            // Mappings provided by frontend - use as-is (frontend handles sequential assignment)
            input.bus_mappings
        };

        source_configs.push(SourceConfig {
            profile_id: input.profile_id,
            profile_kind,
            display_name,
            bus_mappings,
            framing_encoding: input.framing_encoding,
            delimiter: input.delimiter,
            max_frame_length: input.max_frame_length,
            min_frame_length: input.min_frame_length,
            emit_raw_bytes: input.emit_raw_bytes,
            frame_id_start_byte: input.frame_id_start_byte,
            frame_id_bytes: input.frame_id_bytes,
            frame_id_big_endian: input.frame_id_big_endian,
            source_address_start_byte: input.source_address_start_byte,
            source_address_bytes: input.source_address_bytes,
            source_address_big_endian: input.source_address_big_endian,
        });
    }

    // Validate all profiles are real-time devices supported by MultiSourceReader
    for config in &source_configs {
        if !is_realtime_device(&config.profile_kind) {
            return Err(format!(
                "Profile '{}' has unsupported type '{}' for multi-source mode. \
                Currently supported: gvret_tcp, gvret_usb, slcan, gs_usb, socketcan, serial",
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
    if get_session_state(&session_id).await.is_some() {
        let _ = destroy_session(&session_id).await;
    }

    // Create the multi-source reader (validates interface trait compatibility)
    // Extract display names for logging before moving source_configs
    let source_display_names: Vec<String> = source_configs.iter()
        .map(|c| c.display_name.clone())
        .collect();
    let reader = MultiSourceReader::new(app.clone(), session_id.clone(), source_configs)?;

    // Register profile usage BEFORE create_session so lifecycle event has profile IDs
    for profile_id in &profile_ids {
        profile_tracker::register_usage(profile_id, &session_id);
    }
    // Store all profiles for this session (needed for cleanup on destroy)
    register_session_profiles(&session_id, &profile_ids);

    let result = create_session(app, session_id.clone(), Box::new(reader), listener_id, Some(source_display_names)).await;

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
            eprintln!(
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
