use crate::{
    capture_store,
    io::{
        self,
        create_session, destroy_session, get_session_capabilities, get_session_joiner_count, get_session_state,
        get_session_subscribers, list_sessions, pause_session,
        reconfigure_session, reinitialize_session_if_safe, resume_session,
        resume_session_fresh, seek_session, seek_session_by_frame, set_subscriber_active, start_session, stop_session,
        stop_and_switch_to_capture, suspend_session, switch_to_capture_replay, transmit_frame, unregister_subscriber,
        evict_session_subscriber, leave_session_to_capture, add_source_to_session, remove_source_from_session, update_source_bus_mappings, set_source_polling, get_session_next_output_bus,
        update_session_direction, update_session_speed, update_session_time_range, ActiveSessionInfo, IOCapabilities, IOState,
        SubscriberInfo, ReinitializeResult, CaptureSource, step_frame, StepResult,
        BusMapping, Protocol, TemporalMode,
        GvretDeviceInfo,
        probe::DeviceProbeResult,
        ModbusRangeSpec, PollGroup,
        CanTransmitFrame, TransmitResult,
        session_log::{self, SessionLogEntry},
        set_wake_settings as io_set_wake_settings,
    },
    profile_tracker,
    settings,
};
#[cfg(not(target_os = "ios"))]
use crate::io::device_kinds;
use crate::io::traits::supported_protocols_for_kind;
use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc};

use super::open::{refused_on, SessionRefusal};
use super::ids::{mint_session_id, sources_prefix, SessionPurpose, MODBUS_SCAN_SESSION_PREFIX};
use super::source_config::{
    allocate_inputs, declared_bus_mappings, resolve_source_configs,
    MultiSourceInput,
};
use super::tracking::{
    claim_session_profile,
    hold_profile_while, profiles_in_use,
    unregister_session_profile,
};

/// Drop a profile's cached probe after its connection parameters changed.
/// Editing a saved device keeps its id, so without this the next probe would
/// report the device it used to point at.
#[tauri::command(rename_all = "snake_case")]
pub fn clear_profile_probe_cache(profile_id: String) {
    io::probe::clear_probe_cache(&profile_id);
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

/// Get the state of a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn get_reader_session_state(session_id: String) -> Result<Option<IOState>, String> {
    Ok(get_session_state(&session_id).await)
}

/// The session log after `after_id`, oldest first.
#[tauri::command(rename_all = "snake_case")]
pub fn get_session_log(after_id: Option<u64>) -> Vec<SessionLogEntry> {
    session_log::read(after_id, None)
}

/// Clear the session log for every window and the MCP.
#[tauri::command(rename_all = "snake_case")]
pub fn clear_session_log() {
    session_log::clear();
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
pub async fn stop_reader_session(session_id: String) -> Result<IOState, SessionRefusal> {
    refused_on(&session_id, stop_session(&session_id).await).await
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
pub async fn seek_reader_session(session_id: String, timestamp_us: i64) -> Result<(), SessionRefusal> {
    refused_on(&session_id, seek_session(&session_id, timestamp_us).await).await
}

/// Seek to a specific frame index (preferred for capture playback - avoids floating-point issues)
#[tauri::command(rename_all = "snake_case")]
pub async fn seek_reader_session_by_frame(session_id: String, frame_index: i64) -> Result<(), SessionRefusal> {
    refused_on(&session_id, seek_session_by_frame(&session_id, frame_index).await).await
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
#[tauri::command(rename_all = "snake_case")]
pub async fn resume_session_to_live(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<IOCapabilities, String> {
    super::live::rebuild_live_reader(&session_id, settings::saved_profiles(&app)).await
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
    io::probe::probe_gvret_device(&profile_id, load_settings(app)).await
}

/// Probe any real-time device to check if it's online and healthy.
///
/// This loads the profile from settings, connects to the device, queries it,
/// and returns device information. The connection is closed after probing.
///
/// If a successful probe result is cached for this profile, returns the cached
/// result immediately without reconnecting. This is useful when the device is
/// already running in an active session.
#[tauri::command(rename_all = "snake_case")]
pub async fn probe_device(
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<DeviceProbeResult, String> {
    io::probe::probe_device(&profile_id, load_settings(app)).await
}

async fn load_settings(app: tauri::AppHandle) -> Result<settings::AppSettings, String> {
    settings::load_settings(app)
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))
}

// ============================================================================
// Multi-Source Session Commands
// ============================================================================

/// The buses `open_session` would give these sources, for the
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

/// Usage of every profile a session holds.
#[tauri::command(rename_all = "snake_case")]
pub fn get_profiles_usage() -> Vec<ProfileUsageInfo> {
    profiles_in_use()
        .into_iter()
        .map(|(profile_id, session_ids)| {
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
    let pollers = (!allow_contention.unwrap_or(false)).then_some(&settings);
    super::scan::create_scan_session(session_id, job, profile_id, subscriber_id, app_name, pollers).await
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
