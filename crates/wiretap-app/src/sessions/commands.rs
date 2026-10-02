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
        evict_session_subscriber, leave_session_to_capture, add_source_to_session, remove_source_from_session, update_source_bus_mappings, set_source_polling, get_session_next_output_bus,
        update_session_direction, update_session_speed, update_session_time_range, ActiveSessionInfo, IOCapabilities, IOSource, IOState,
        SubscriberInfo, RegisterSubscriberResult, ReinitializeResult, CaptureSource, step_frame, StepResult,
        BusMapping, Protocol, TemporalMode,
        GvretDeviceInfo, probe_gvret_tcp,
        ModbusRangeSpec, PollGroup,
        MqttConfig, MqttSource,
        IOBroker, SerialOverrides, SourceConfig,
        BackendApiConfig, BackendApiSource, BackendApiSourceOptions,
        CanTransmitFrame, TransmitResult,
        emit_device_probe, DeviceProbePayload,
        set_wake_settings as io_set_wake_settings,
    },
    profile_tracker,
    settings,
};
#[cfg(not(target_os = "ios"))]
use crate::io::device_kinds::{self, conn_f64, conn_i64, conn_str, req_str};
use crate::io::traits::supported_protocols_for_kind;
use crate::io::probe_gvret_usb;
#[cfg(not(target_os = "ios"))]
use crate::io::serial::utils::line_settings;
use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc};

use super::ids::{mint_session_id, sources_prefix, SessionPurpose, MODBUS_SCAN_SESSION_PREFIX};
use super::source_config::{
    allocate_inputs, attach_modbus_polls, choose_profile_by_id, create_source_config_from_profile,
    declared_bus_mappings, parse_modbus_polls, reader_source_config, refuse_at_start, resolve_source_configs,
    MultiSourceInput,
};
use super::tracking::{
    cache_probe_result, claim_session_profile, clear_probe_cache, get_cached_probe, get_session_profile_ids,
    get_sessions_for_profile, hold_profile_while, register_session_profiles, restore_session_profiles,
    unregister_session_profile,
};

/// Drop a profile's cached probe after its connection parameters changed.
/// Editing a saved device keeps its id, so without this the next probe would
/// report the device it used to point at.
#[tauri::command(rename_all = "snake_case")]
pub fn clear_profile_probe_cache(profile_id: String) {
    clear_probe_cache(&profile_id);
}

/// Mint a session id. The prefix is cosmetic: nothing classifies a session by
/// its id, which is what the roster's `source_type` is for.
#[tauri::command(rename_all = "snake_case")]
pub async fn generate_session_id(
    app: tauri::AppHandle,
    purpose: SessionPurpose,
) -> Result<String, String> {
    let prefix = match purpose {
        SessionPurpose::Sources { profile_ids, emit_raw_bytes } => {
            let settings = settings::load_settings(app.clone())
                .await
                .map_err(|e| format!("Failed to load settings: {}", e))?;
            sources_prefix(&profile_ids, &settings, emit_raw_bytes)
        }
        SessionPurpose::Ingest => "load",
        SessionPurpose::ModbusScan => MODBUS_SCAN_SESSION_PREFIX,
    };
    Ok(mint_session_id(prefix).await)
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
    refuse_at_start(&profile)?;

    // Check if this profile is already in use (for single-handle devices)
    profile_tracker::can_use_profile(&profile.id, &profile.kind, None)?;
    profile_tracker::can_use_adapter(&profile.id, &settings.io_profiles, &[], None)?;

    // Anonymous usage telemetry: which source kind gets started (wiretap,
    // wiretap, and any MCP-driven kind all land here).
    crate::telemetry::emit_feature_usage("io_source_start", &profile.kind);

    // Track profile_id for later registration
    let profile_id_for_tracking = profile.id.clone();

    // Create the appropriate reader based on profile kind
    // Real-time devices (gvret, slcan, gs_usb, socketcan) use IOBroker for unified handling
    let is_realtime = device_kinds::is_multi_source(&profile.kind);
    let reader: Box<dyn IOSource> = if is_realtime {
        // Use IOBroker for all real-time devices (unified path)
        let source_config = reader_source_config(
            &profile,
            bus_override,
            serial.unwrap_or_default(),
            modbus_polls.as_deref(),
            settings.modbus_max_register_errors,
        )?;

        Box::new(IOBroker::single_source(
            settings::saved_profiles(&app),
            session_id.clone(),
            source_config,
        )?)
    } else {
        // Non-realtime devices use their direct readers
        match profile.kind.as_str() {
        "wiretap" => {
            let config = BackendApiConfig {
                base_url: req_str(&profile, "url")?.trim_end_matches('/').to_string(),
                api_key: credentials::resolve_secret(&profile, "api_key").unwrap_or_default(),
                database: req_str(&profile, "database")?,
                protocol: crate::apiclient::archive_protocol(&profile.connection)?,
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
        "mqtt" => {
            let host = req_str(&profile, "host")?;
            let port = device_kinds::req_i64(&profile, "port")? as u16;

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

            Box::new(MqttSource::new(session_id.clone(), config))
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
    claim_session_profile(&session_id, &profile_id_for_tracking).await;

    let result = create_session(session_id.clone(), reader, subscriber_id, app_name, None, vec![]).await;

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
    session_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    stop_and_switch_to_capture(&session_id, speed.unwrap_or(1.0)).await
}

/// Stop a session and switch it to capture replay, choosing the backend path from
/// the source's temporal mode. Realtime → stop-and-switch all listeners (falling
/// back to a plain suspend if no capture exists); recorded → suspend (preserves
/// position) then switch to capture replay. Owns the decision that used to live in
/// the frontend `stopWatch`.
#[tauri::command(rename_all = "snake_case")]
pub async fn session_stop_to_capture(session_id: String) -> Result<(), String> {
    let is_realtime = get_session_capabilities(&session_id)
        .await
        .map(|c| c.traits.temporal_mode == TemporalMode::Realtime)
        .unwrap_or(false);

    if is_realtime {
        if let Err(e) = stop_and_switch_to_capture(&session_id, 1.0).await {
            tlog!("[session_stop_to_capture] stop-and-switch failed ({}); suspending", e);
            suspend_session(&session_id).await?;
        }
    } else {
        suspend_session(&session_id).await?;
        if let Err(e) = switch_to_capture_replay(&session_id, 1.0).await {
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
    destroy_session(&session_id, reset).await
}

/// Create a reader session for a capture.
/// The capture is registered as a source profile so it appears in
/// `sourceProfileIds` and the session manager graph.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_capture_source_session(
    session_id: String,
    capture_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    if !capture_store::has_any_data() {
        return Err("No data in capture. Please import a CSV file first.".to_string());
    }

    claim_session_profile(&session_id, &capture_id).await;

    let reader = CaptureSource::new(
        session_id.clone(),
        capture_id,
        speed.unwrap_or(0.0), // 0 = no limit by default
    );

    // Anonymous usage telemetry: user explicitly opened a capture for replay.
    crate::telemetry::emit_feature_usage("io_source_start", "capture");

    let result = create_session(session_id, Box::new(reader), None, None, None, vec![]).await;
    Ok(result.capabilities)
}

/// Transition an existing session to use a capture for replay.
/// This is used when a streaming source (GVRET, the WireTAP backend) ends and
/// the user wants to replay the captured frames.
#[tauri::command(rename_all = "snake_case")]
pub async fn transition_to_capture_source(
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

    claim_session_profile(&session_id, &capture_id).await;

    let reader = CaptureSource::new(session_id.clone(), capture_id, speed.unwrap_or(1.0));

    let result = create_session(session_id, Box::new(reader), None, None, None, vec![]).await;
    Ok(result.capabilities)
}

/// Switch a session to capture replay mode without destroying it.
/// This swaps the session's reader to a CaptureSource that reads from the session's
/// owned capture. All listeners stay connected and can replay the captured data.
/// Use this after ingest completes to enable playback controls.
#[tauri::command(rename_all = "snake_case")]
pub async fn switch_session_to_capture_replay(
    session_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    switch_to_capture_replay(&session_id, speed.unwrap_or(1.0)).await
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

        if !device_kinds::is_multi_source(&profile.kind) {
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
    let profiles = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?
        .io_profiles;
    for config in &configs {
        crate::profile_tracker::can_use_profile(&config.profile_id, &config.profile_kind, None)?;
        crate::profile_tracker::can_use_adapter(&config.profile_id, &profiles, &[], None)?;
    }

    let profile_ids: Vec<String> = configs.iter().map(|c| c.profile_id.clone()).collect();
    restore_session_profiles(&session_id, &profile_ids);

    // Build the new live reader
    let new_reader: Box<dyn IOSource> = if configs.len() == 1 {
        Box::new(IOBroker::single_source(
            settings::saved_profiles(&app),
            session_id.clone(),
            configs.into_iter().next().unwrap(),
        )?)
    } else {
        Box::new(IOBroker::new(
            settings::saved_profiles(&app),
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
    session_id: String,
    capture_id: String,
    current_frame_index: Option<usize>,
    current_timestamp_us: Option<i64>,
    backward: bool,
    filter_selection: Option<Vec<crate::capture_store::ProtocolFrames>>,
) -> Result<Option<StepResult>, String> {
    let selection = crate::capture_store::FrameSelection::from_groups(filter_selection.unwrap_or_default());
    step_frame(&session_id, &capture_id, current_frame_index, current_timestamp_us, backward, &selection)
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
    session_id: String,
    subscriber_id: String,
) -> Result<Vec<String>, String> {
    evict_session_subscriber(&session_id, &subscriber_id).await
}

/// Leave a session (user-initiated): the calling app detaches and reviews a frozen
/// snapshot of the capture; the session keeps streaming for any remaining apps.
/// Returns the copied snapshot capture IDs (empty when there was nothing captured).
#[tauri::command(rename_all = "snake_case")]
pub async fn session_leave_to_capture(
    session_id: String,
    subscriber_id: String,
) -> Result<Vec<String>, String> {
    leave_session_to_capture(&session_id, &subscriber_id).await
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

    let first_output_bus = get_session_next_output_bus(&session_id).await;
    let source_config = resolve_source_configs(vec![source], &settings, first_output_bus)?.remove(0);

    // Validate it's a real-time device
    if !device_kinds::is_multi_source(&source_config.profile_kind) {
        return Err(format!(
            "Profile '{}' has unsupported type '{}' for multi-source mode",
            source_config.profile_id, source_config.profile_kind
        ));
    }

    profile_tracker::can_use_profile(&source_config.profile_id, &source_config.profile_kind, None)?;
    profile_tracker::can_use_adapter(&source_config.profile_id, &settings.io_profiles, &[], None)?;

    let profile_id = source_config.profile_id.clone();
    let adding = add_source_to_session(settings::saved_profiles(&app), &session_id, source_config);
    hold_profile_while(&session_id, &profile_id, adding).await
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
    let capabilities =
        remove_source_from_session(settings::saved_profiles(&app), &session_id, &profile_id).await?;
    unregister_session_profile(&session_id, &profile_id);
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

            probe_gvret_tcp(host, port, timeout_sec).await
        }
        #[cfg(not(target_os = "ios"))]
        "gvret_usb" => {
            let port = profile
                .connection
                .get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required for GVRET USB".to_string())?;
            probe_gvret_usb(port, line_settings(profile)?).await
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
#[cfg_attr(test, derive(ts_rs::TS))]
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
    use crate::io::slcan::reader::probe_slcan;

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
                    error: Some(e),
                }),
            }
        }

        #[cfg(not(target_os = "ios"))]
        "gvret_usb" => {
            let port = profile.connection.get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required for GVRET USB".to_string())?;
            match probe_gvret_usb(port, line_settings(profile)?).await {
                Ok(info) => Ok(DeviceProbeResult {
                    success: true,
                    source_type: "gvret".to_string(),
                    is_multi_bus: true,
                    bus_count: info.bus_count,
                    primary_info: Some(format!("{} buses available", info.bus_count)),
                    secondary_info: Some(port.to_string()),
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
                    error: Some(e),
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
                .ok_or_else(|| "Serial port is required for slcan".to_string())?;
            let result = probe_slcan(port, line_settings(profile)?).await;

            Ok(DeviceProbeResult {
                success: result.success,
                source_type: "slcan".to_string(),
                is_multi_bus: false,
                bus_count: if result.success { 1 } else { 0 },
                primary_info: result.version,
                secondary_info: result.hardware_version,
                supports_fd: result.supports_fd,
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

            match probe_gs_usb_device(bus, address, serial).await {
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

            let port_exists = wiretap_io::serial::ports()
                .unwrap_or_default()
                .iter()
                .any(|p| p.path == port);

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

/// What a multi-source session opened, and the buses Rust gave each source.
#[derive(Debug, Clone, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct MultiSourceSession {
    pub capabilities: IOCapabilities,
    pub bus_mappings: HashMap<String, Vec<BusMapping>>,
}

/// The buses `create_multi_source_session` would give these sources, for the
/// picker to show before anything opens.
#[tauri::command(rename_all = "snake_case")]
pub fn preview_source_buses(
    app: tauri::AppHandle,
    sources: Vec<MultiSourceInput>,
) -> Result<HashMap<String, Vec<BusMapping>>, String> {
    let settings = settings::load_settings_sync(&app)?;
    Ok(allocate_inputs(&sources, &settings, 0)?
        .into_iter()
        .map(|(profile, buses)| (profile.id.clone(), buses))
        .collect())
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
) -> Result<MultiSourceSession, String> {
    if sources.is_empty() {
        return Err("At least one source is required".to_string());
    }

    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    let parsed_polls = parse_modbus_polls(modbus_polls.as_deref())?;
    let mut source_configs = resolve_source_configs(sources, &settings, 0)?;

    for config in &mut source_configs {
        attach_modbus_polls(config, &parsed_polls, settings.modbus_max_register_errors);
    }

    // Validate all profiles are real-time devices supported by IOBroker
    for (idx, config) in source_configs.iter().enumerate() {
        if !device_kinds::is_multi_source(&config.profile_kind) {
            return Err(format!(
                "Profile '{}' has unsupported type '{}' for multi-source mode.",
                config.profile_id, config.profile_kind
            ));
        }

        if !device_kinds::spec(&config.profile_kind).is_some_and(|s| s.available) {
            return Err(format!(
                "Profile '{}' uses {}, which this platform cannot open.",
                config.profile_id, config.profile_kind
            ));
        }

        // Check if profile is already in use
        profile_tracker::can_use_profile(&config.profile_id, &config.profile_kind, Some(&session_id))?;
        let joining: Vec<&str> = source_configs[..idx].iter().map(|c| c.profile_id.as_str()).collect();
        profile_tracker::can_use_adapter(&config.profile_id, &settings.io_profiles, &joining, Some(&session_id))?;
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
    let bus_mappings = source_configs.iter().map(|c| (c.profile_id.clone(), c.bus_mappings.clone())).collect();
    let reader = IOBroker::new(settings::saved_profiles(&app), session_id.clone(), source_configs)?;

    // Register profile usage BEFORE create_session so lifecycle event has profile IDs
    register_session_profiles(&session_id, &profile_ids);

    // Anonymous usage telemetry: which source kinds get started (deduped so a
    // multi-bus start doesn't over-count a single user action).
    let mut seen = std::collections::HashSet::new();
    for config in &stored_configs {
        if seen.insert(config.profile_kind.as_str()) {
            crate::telemetry::emit_feature_usage("io_source_start", &config.profile_kind);
        }
    }

    let result = create_session(session_id.clone(), Box::new(reader), subscriber_id, app_name, Some(source_display_names), stored_configs).await;

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

    Ok(MultiSourceSession { capabilities: result.capabilities, bus_mappings })
}

// ============================================================================
// Profile-to-Session Mapping Commands
// ============================================================================

/// Response type for profile usage query
#[derive(Clone, Debug, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
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
    exclude: &str,
) -> Option<(String, String)> {
    for info in crate::io::list_sessions().await {
        // A paused poller still holds its socket — pause stops requests, not the
        // connection — so it contends exactly as a running one does.
        let holds_socket = matches!(
            info.state,
            crate::io::IOState::Running | crate::io::IOState::Paused
        );
        if info.session_id == exclude || !holds_socket {
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
#[tauri::command(rename_all = "snake_case")]
pub async fn modbus_probe_function_codes(
    config: crate::io::FcProbeConfig,
) -> Result<Vec<crate::io::FcProbeEntry>, String> {
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
    job: crate::io::ScanJob,
    profile_id: Option<String>,
    subscriber_id: Option<String>,
    app_name: Option<String>,
    allow_contention: Option<bool>,
) -> Result<IOCapabilities, String> {
    let settings = crate::settings::load_settings_sync(&app)?;

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
        if let Some((holder, name)) =
            endpoint_in_use_by_poller(&settings, &endpoint, &session_id).await
        {
            return Err(format!(
                "{name} is being polled by session '{holder}' — that device may only serve one \
                 Modbus connection at a time. Stop that session, or re-run allowing contention."
            ));
        }
    }

    if let Some(pid) = &profile_id {
        claim_session_profile(&session_id, pid).await;
    }

    let source = crate::io::ModbusScanSource::new(session_id.clone(), job);
    let result = create_session(
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
