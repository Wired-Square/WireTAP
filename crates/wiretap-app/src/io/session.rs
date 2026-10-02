use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::roster::{
    attach_app, current_session_of_app, detach_all_from_session, detach_app, other_instances_on_session,
    session_exists, set_app_active, subscriber_count_for_session,
};
use super::{
    emit_capture_orphaned_as_changed, emit_session_lifecycle, traits, types, BusMapping, CanTransmitFrame,
    CaptureSource, IOBroker, IOCapabilities, IOSource, IOState, PlaybackPosition, ReplaceSourceOptions,
    SessionLifecyclePayload, SourceConfig, SourceReplacedPayload, TransmitPayload, TransmitResult,
    VirtualBusState, CAPTURE_SOURCE_TYPE,
};
use crate::{capture_store, sessions};

// ============================================================================
// Session Management
// ============================================================================

/// Active IO session.
///
/// Subscribers are NOT stored here — they live in the global `APP_REGISTRY`
/// (keyed by instance_id, with `session_id` pointing back here). The per-session
/// subscriber list/count is derived via `subscribers_for_session` /
/// `subscriber_count_for_session`. Only session-level state lives on the struct.
pub struct IOSession {
    pub source: Box<dyn IOSource>,
    pub app: AppHandle,
    /// Display names of the sources in this session (for logging)
    pub source_names: Vec<String>,
    /// Original source configs for rebuilding the live reader on resume.
    /// Empty for non-multi-source sessions (recorded, buffer).
    pub source_configs: Vec<SourceConfig>,
    /// When all listeners went stale. During this grace period the reader is paused
    /// but the session stays alive, allowing recovery after display sleep / App Nap.
    pub suspended_at: Option<std::time::Instant>,
}

/// Convert IOState to a simple string for TypeScript
fn state_to_string(state: &IOState) -> String {
    match state {
        IOState::Error(msg) => format!("error:{msg}"),
        other => other.name().to_string(),
    }
}

/// Emit a state change event for a session
fn emit_state_change(session_id: &str, _previous: &IOState, current: &IOState) {
    crate::ws::dispatch::send_session_state(session_id, current);
}

/// Emit a joiner count change event for a session.
/// Sends speed = -1.0 as a sentinel meaning "no speed update".
pub(super) fn emit_joiner_count_change(
    session_id: &str,
    joiner_count: usize,
    _subscriber_id: Option<&str>,
    _app_name: Option<&str>,
    _change: Option<&str>,
) {
    crate::ws::dispatch::send_session_info(session_id, -1.0, joiner_count as u16);
}

/// Emit a speed change event for a session.
/// Sends subscriber_count = 0xFFFF as a sentinel meaning "no subscriber count update".
fn emit_speed_change(session_id: &str, speed: f64) {
    crate::ws::dispatch::send_session_info(session_id, speed, 0xFFFF);
}

/// Global session manager
pub(super) static IO_SESSIONS: Lazy<Mutex<HashMap<String, IOSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// If `session_id` has no attached subscribers left, extract and destroy it (same
/// cascade as the last subscriber leaving). Otherwise emit the updated joiner count.
/// `reset` marks a deliberate move away from this session (see `destroy_session`);
/// it rides the `destroyed` event so apps return to "No source" instead of adopting
/// the orphaned capture.
pub(super) async fn teardown_session_if_empty(session_id: &str, reset: bool) {
    let count = subscriber_count_for_session(session_id);
    if count == 0 {
        let extracted = { IO_SESSIONS.lock().await.remove(session_id) };
        if let Some(session) = extracted {
            tlog!("[reader] Session '{}' emptied (app/window gone), destroying", session_id);
            emit_joiner_count_change(session_id, 0, None, None, Some("left"));
            destroy_extracted_session(session_id, session, reset).await;
        }
    } else if session_exists(session_id).await {
        emit_joiner_count_change(session_id, count, None, None, Some("left"));
    }
    // Otherwise the count is phantom — subscribers still point at a session that is
    // gone. Don't broadcast a "left" for it, and don't detach either: this is also the
    // window `reinitialize_session` runs in, where the attachment is retained on
    // purpose because the session comes straight back under the same id.
}

/// Playback position cache — updated during capture/recorded streaming, polled by frontend
static PLAYBACK_POSITIONS: Lazy<RwLock<HashMap<String, PlaybackPosition>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub fn store_playback_position(session_id: &str, position: PlaybackPosition) {
    if let Ok(mut positions) = PLAYBACK_POSITIONS.write() {
        positions.insert(session_id.to_string(), position);
    }
}

pub fn get_playback_position(session_id: &str) -> Option<PlaybackPosition> {
    PLAYBACK_POSITIONS.read().ok().and_then(|p| p.get(session_id).cloned())
}

pub fn clear_playback_position(session_id: &str) {
    if let Ok(mut positions) = PLAYBACK_POSITIONS.write() {
        positions.remove(session_id);
    }
}

/// Sessions that are currently closing (window close in progress)
/// Uses RwLock (not async Mutex) so it can be checked synchronously
static CLOSING_SESSIONS: Lazy<RwLock<HashSet<String>>> = Lazy::new(|| RwLock::new(HashSet::new()));

// ============================================================================
// Startup Errors
// ============================================================================

/// Startup errors for sessions (errors that occurred before any subscriber registered).
/// Uses RwLock (not async Mutex) so it can be set synchronously.
/// The error is retrieved and cleared when the first subscriber registers.
static STARTUP_ERRORS: Lazy<RwLock<HashMap<String, String>>> = Lazy::new(|| RwLock::new(HashMap::new()));

/// Store a startup error for a session (called when error occurs with no listeners)
pub fn store_startup_error(session_id: &str, error: String) {
    if let Ok(mut errors) = STARTUP_ERRORS.write() {
        tlog!("[reader] Storing session error for session '{}': {}", session_id, error);
        errors.insert(session_id.to_string(), error);
    }
}

/// Take (retrieve and remove) the startup error for a session
pub fn take_startup_error(session_id: &str) -> Option<String> {
    if let Ok(mut errors) = STARTUP_ERRORS.write() {
        errors.remove(session_id)
    } else {
        None
    }
}

/// Read the startup error without removing it (for signal-then-fetch polling)
pub fn get_startup_error(session_id: &str) -> Option<String> {
    STARTUP_ERRORS.read().ok().and_then(|e| e.get(session_id).cloned())
}

/// Clear any startup error for a session (called on session destroy)
fn clear_startup_error(session_id: &str) {
    if let Ok(mut errors) = STARTUP_ERRORS.write() {
        errors.remove(session_id);
    }
}

/// Mark a session as closing (sync version for use in window event handler)
/// This prevents further events from being emitted to the closing window.
/// Returns true if this is the first time marking as closing, false if already closing.
/// Only used by window close handler which is desktop-only.
#[cfg(not(target_os = "ios"))]
pub fn mark_session_closing_sync(session_id: &str) -> bool {
    if let Ok(mut closing) = CLOSING_SESSIONS.write() {
        let is_new = closing.insert(session_id.to_string());
        if is_new {
            tlog!("[reader] Marked session '{}' as closing", session_id);
        }
        is_new
    } else {
        false
    }
}

/// Clear the closing flag for a session (called after destroy)
fn clear_session_closing(session_id: &str) {
    if let Ok(mut closing) = CLOSING_SESSIONS.write() {
        closing.remove(session_id);
    }
}

/// Result of creating or joining a session
#[derive(Clone, Debug, Serialize)]
pub struct CreateSessionResult {
    /// Session capabilities
    pub capabilities: IOCapabilities,
    /// Whether this was a new session (true) or joined existing (false)
    pub is_new: bool,
    /// Total subscriber count
    pub subscriber_count: usize,
}

/// Create a new IO session with an initial subscriber.
/// If a session with this ID already exists, joins the existing session instead.
/// This prevents race conditions when multiple apps start simultaneously.
pub async fn create_session(
    app: AppHandle,
    session_id: String,
    device: Box<dyn IOSource>,
    subscriber_id: Option<String>,
    app_name: Option<String>,
    source_names: Option<Vec<String>>,
    source_configs: Vec<SourceConfig>,
) -> CreateSessionResult {
    // Clear the closing flag in case this is a new session for a previously closed window
    clear_session_closing(&session_id);

    let mut sessions = IO_SESSIONS.lock().await;

    // Check if session already exists - join it instead of overwriting
    if let Some(existing) = sessions.get_mut(&session_id) {
        let capabilities = existing.source.capabilities();

        // Clear suspension if the session was in the grace period
        if existing.suspended_at.take().is_some() {
            tlog!(
                "[reader] Session '{}' clearing suspension (new subscriber joining)",
                session_id
            );
            // Resume will happen via register_subscriber or auto-start
        }

        // Attach the joining subscriber to the registry (idempotent — refreshes
        // heartbeat if already attached). The per-session count is derived.
        if let Some(lid) = &subscriber_id {
            let resolved_name = app_name.clone().unwrap_or_else(|| lid.clone());
            attach_app(lid, &resolved_name, &session_id);
            emit_joiner_count_change(&session_id, subscriber_count_for_session(&session_id), Some(lid), Some(&resolved_name), Some("joined"));
            tlog!(
                "[reader] Session '{}' - subscriber '{}' joined existing session, total: {}",
                session_id, lid, subscriber_count_for_session(&session_id)
            );
        }

        return CreateSessionResult {
            capabilities,
            is_new: false,
            subscriber_count: subscriber_count_for_session(&session_id),
        };
    }

    // No existing session - create new one
    let capabilities = device.capabilities();

    // Attach the creating subscriber to the registry (the per-session view is derived).
    if let Some(lid) = subscriber_id.clone() {
        let resolved_name = app_name.unwrap_or_else(|| lid.clone());
        attach_app(&lid, &resolved_name, &session_id);
        tlog!(
            "[reader] Session '{}' created with subscriber '{}', total: 1",
            session_id, lid
        );
    } else {
        tlog!("[reader] Session '{}' created with no initial subscriber", session_id);
    }

    let subscriber_count = subscriber_count_for_session(&session_id).max(1);
    let source_type = device.source_type().to_string();
    let state = device.state();
    let app_for_event = app.clone();
    let session = IOSession {
        source: device,
        app,
        source_names: source_names.unwrap_or_default(),
        source_configs,
        suspended_at: None,
    };

    sessions.insert(session_id.clone(), session);

    // Emit global session lifecycle event (to all windows)
    // Use get_session_profile_ids() to get actual profile IDs (not display names)
    // Profile tracking is registered before create_session() is called
    let source_profile_ids = crate::sessions::get_session_profile_ids(&session_id);
    emit_session_lifecycle(&app_for_event, SessionLifecyclePayload {
        session_id: session_id.clone(),
        event_type: "created".to_string(),
        source_type: Some(source_type),
        state: Some(format!("{:?}", state)),
        subscriber_count,
        source_profile_ids,
        creator_subscriber_id: subscriber_id,
        reset: false,
    });

    CreateSessionResult {
        capabilities,
        is_new: true,
        subscriber_count,
    }
}

/// Start a reader session
/// Returns the confirmed state after the operation.
pub async fn start_session(session_id: &str) -> Result<IOState, String> {
    tlog!("[reader] start_session('{}') called", session_id);
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| {
            tlog!("[reader] start_session('{}') - session not found!", session_id);
            format!("Session '{}' not found", session_id)
        })?;

    let previous = session.source.state();
    tlog!("[reader] start_session('{}') - previous state: {:?}", session_id, previous);

    // Idempotency: if already running, return success
    if matches!(previous, IOState::Running) {
        tlog!("[reader] start_session('{}') - already running, returning", session_id);
        return Ok(previous);
    }

    tlog!("[reader] start_session('{}') - calling device.start()...", session_id);
    session.source.start().await?;

    let current = session.source.state();
    tlog!("[reader] start_session('{}') - current state: {:?}", session_id, current);
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    Ok(current)
}

/// Stop a reader session
/// Returns the confirmed state after the operation.
pub async fn stop_session(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Idempotency: if already stopped, return success
    if matches!(previous, IOState::Stopped) {
        return Ok(previous);
    }

    session.source.stop().await?;

    let current = session.source.state();
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    Ok(current)
}

/// Suspend a reader session - stops streaming, finalizes capture, session stays alive.
/// The capture remains owned by the session and all joined apps can view it.
/// Use `resume_session_fresh` to start streaming again with a new capture.
/// Returns the confirmed state after the operation.
pub async fn suspend_session(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Idempotency: if already stopped, return success
    if matches!(previous, IOState::Stopped) {
        return Ok(previous);
    }

    // Stop the device (triggers emit_stream_ended which finalises the capture)
    session.source.stop().await?;

    // Emit session-lifecycle signal with inline state + capabilities
    let current = session.source.state();
    let caps = session.source.capabilities();
    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &current, &caps);

    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    tlog!(
        "[reader] suspend_session('{}') - capture finalized, session stays alive",
        session_id
    );

    Ok(current)
}

/// Replace a session's device in-place, keeping the session ID and all listeners.
///
/// This is the low-level primitive for device swaps. Callers handle domain-specific
/// logic (capture orchestration, profile tracking) before/after calling this.
///
/// Steps: stop old device → swap device → optionally update metadata → optionally
/// auto-start → emit `session-lifecycle` signal → emit state change.
///
/// Takes `&mut HashMap` so callers can hold the IO_SESSIONS lock across the
/// full operation (preventing double-lock).
pub async fn replace_session_source(
    sessions: &mut HashMap<String, IOSession>,
    session_id: &str,
    new_device: Box<dyn IOSource>,
    opts: ReplaceSourceOptions,
) -> Result<SourceReplacedPayload, String> {
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // 1. Stop old device (idempotent)
    let previous_state = session.source.state();
    if !matches!(previous_state, IOState::Stopped) {
        let _ = session.source.stop().await;
    }

    // 2. Record old device info
    let previous_source_type = session.source.source_type().to_string();

    // 3. Get new device info before swap
    let capabilities = new_device.capabilities();
    let new_source_type = new_device.source_type().to_string();

    // 4. Swap the device
    session.source = new_device;

    // 5. Update metadata if provided
    if let Some(names) = opts.source_names {
        session.source_names = names;
    }
    if let Some(configs) = opts.source_configs {
        session.source_configs = configs;
    }

    // 6. Clear suspension state
    session.suspended_at = None;

    // 7. Optionally auto-start
    if opts.auto_start {
        session.source.start().await?;
    }

    let current_state = session.source.state();
    let state_str = state_to_string(&current_state);

    // 8. Build result payload (still returned to callers, just not emitted as event)
    let payload = SourceReplacedPayload {
        previous_source_type: previous_source_type.clone(),
        new_source_type: new_source_type.clone(),
        capabilities: capabilities.clone(),
        state: state_str.clone(),
        transition: opts.transition.clone(),
    };

    // 9. Emit session-lifecycle signal with inline state + capabilities
    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &current_state, &capabilities);

    // 10. Emit state change if different
    if previous_state != current_state {
        emit_state_change(session_id, &previous_state, &current_state);
    }

    tlog!(
        "[io] replace_session_source('{}') {} → {} (transition: {}, state: {})",
        session_id, previous_source_type, new_source_type, opts.transition, state_str
    );

    Ok(payload)
}

/// Stop a realtime session and switch to capture replay atomically.
///
/// This combines suspend + switch_to_capture_replay in a single lock acquisition
/// and emits a `session-lifecycle:{sessionId}` signal so ALL subscribers
/// on the session refresh their state.
///
/// If no capture exists (e.g. stopped before any frames), falls back to a normal
/// suspend.
pub async fn stop_and_switch_to_capture(app: &AppHandle, session_id: &str, speed: f64) -> Result<IOCapabilities, String> {
    let mut sessions = IO_SESSIONS.lock().await;

    // A session already replaying has no realtime source to stop, and re-switching it
    // would restart playback from the beginning. The streaming-set lookup this replaced
    // refused that case by accident, having no capture to offer once one was finalised.
    if sessions.get(session_id).is_some_and(|s| s.source.source_type() == CAPTURE_SOURCE_TYPE) {
        return Err(format!("Session '{}' is already replaying a capture", session_id));
    }

    // Must be read before orphan_captures_for_session below, which releases ownership.
    let streamed_capture_id = capture_store::get_session_frame_capture_id(session_id);

    // Stop the device first — stop() triggers emit_stream_ended which calls
    // finalize_capture(), so we must stop before looking up the capture.
    // Scoped to release the mutable borrow before calling replace_session_source.
    {
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;
        if !matches!(session.source.state(), IOState::Stopped) {
            session.source.stop().await?;
        }
    }

    // CaptureSource replays frames only, so a session that streamed bytes has nothing to
    // switch to and the caller falls back to suspending it.
    let capture_id = streamed_capture_id;

    // Try to switch to capture replay
    if let Some(ref bid) = capture_id {
        let _ = crate::capture_store::mark_capture_active(bid);

        // Domain-specific housekeeping before the swap
        capture_store::orphan_captures_for_session(session_id);
        let profile_ids = sessions::get_session_profile_ids(session_id);
        for profile_id in &profile_ids {
            crate::profile_tracker::unregister_usage_by_session(profile_id, session_id);
        }
        sessions::swap_session_profiles_for_capture(session_id, bid);

        let new_reader = CaptureSource::new(
            app.clone(),
            session_id.to_string(),
            bid.clone(),
            speed,
        );

        // Device is already stopped, so replace_session_source's stop is a no-op
        // replace_session_source emits session-lifecycle internally
        let result = replace_session_source(
            &mut sessions,
            session_id,
            Box::new(new_reader),
            ReplaceSourceOptions {
                transition: "capture".to_string(),
                auto_start: false,
                source_names: None,
                source_configs: None,
            },
        ).await?;

        tlog!(
            "[reader] stop_and_switch_to_capture('{}') - switched to capture '{}'",
            session_id, bid
        );

        Ok(result.capabilities)
    } else {
        // No capture available (e.g., 0 frames received) — return error so
        // the frontend can fall back to a full leave/disconnect.
        tlog!(
            "[reader] stop_and_switch_to_capture('{}') - no capture available",
            session_id
        );

        Err(format!("No capture available for session '{}'", session_id))
    }
}

/// Resume a suspended session with a fresh capture.
/// The old capture is orphaned (becomes available for standalone viewing).
/// A new capture is created by the device's start() method.
/// Returns the confirmed state after the operation.
pub async fn resume_session_fresh(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Must be stopped to resume with new capture
    if !matches!(previous, IOState::Stopped) {
        return Err(format!(
            "Session must be stopped to resume with new capture (current: {:?})",
            previous
        ));
    }

    // Emit session-lifecycle signal with current state + capabilities before restart
    let caps = session.source.capabilities();
    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &previous, &caps);

    // Start the device - this will orphan old capture and create new one
    // Recorded sources (the WireTAP backend, CSV, Capture) handle capture creation in start()
    session.source.start().await?;

    let current = session.source.state();
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    tlog!(
        "[reader] resume_session_fresh('{}') - device started with fresh capture",
        session_id
    );

    Ok(current)
}

/// Pause a reader session
/// Returns the confirmed state after the operation.
pub async fn pause_session(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Idempotency: if already paused, return success
    if matches!(previous, IOState::Paused) {
        return Ok(previous);
    }

    session.source.pause().await?;

    let current = session.source.state();
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    Ok(current)
}

/// Resume a reader session
/// Returns the confirmed state after the operation.
pub async fn resume_session(session_id: &str) -> Result<IOState, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let previous = session.source.state();

    // Idempotency: if already running, return success
    if matches!(previous, IOState::Running) {
        return Ok(previous);
    }

    session.source.resume().await?;

    let current = session.source.state();
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }

    Ok(current)
}

/// Enable or disable traffic generation for a virtual device session
pub async fn set_session_traffic_enabled(session_id: &str, enabled: bool) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_traffic_enabled(enabled)
}

/// Enable or disable signal generator for a specific bus
pub async fn set_session_bus_traffic_enabled(session_id: &str, bus: u8, enabled: bool) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_bus_traffic_enabled(bus, enabled)
}

/// Update signal generator cadence for a specific bus
pub async fn set_session_bus_cadence(session_id: &str, bus: u8, frame_rate_hz: f64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_bus_cadence(bus, frame_rate_hz)
}

/// Query per-bus signal generator states
pub async fn get_session_virtual_bus_states(session_id: &str) -> Result<Vec<VirtualBusState>, String> {
    let sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.virtual_bus_states()
}

/// Add a virtual bus generator to a running session
pub async fn add_session_virtual_bus(session_id: &str, bus: u8, traffic_type: String, frame_rate_hz: f64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.add_virtual_bus(bus, traffic_type, frame_rate_hz)
}

/// Remove a virtual bus generator from a running session
pub async fn remove_session_virtual_bus(session_id: &str, bus: u8) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.remove_virtual_bus(bus)
}

/// Update speed for a reader session
pub async fn update_session_speed(session_id: &str, speed: f64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_speed(speed)?;

    // Emit speed change event to all subscribers
    emit_speed_change(session_id, speed);

    Ok(())
}

/// Update time range for a reader session
pub async fn update_session_time_range(
    session_id: &str,
    start: Option<String>,
    end: Option<String>,
) -> Result<(), String> {
    tlog!(
        "[io] update_session_time_range called - session: {}, start: {:?}, end: {:?}",
        session_id,
        start,
        end
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions.get_mut(session_id).ok_or_else(|| {
        let err = format!("Session '{}' not found", session_id);
        tlog!("[io] update_session_time_range: {}", err);
        err
    })?;

    let result = session.source.set_time_range(start, end);
    if let Err(ref e) = result {
        tlog!("[io] update_session_time_range failed: {}", e);
    }
    result
}

/// Reconfigure a running session with new time range.
/// This stops the current stream, orphans the old capture, creates a new capture,
/// and starts streaming with the new time range - all while keeping the session alive.
/// Other apps joined to this session remain connected.
pub async fn reconfigure_session(
    session_id: &str,
    start: Option<String>,
    end: Option<String>,
) -> Result<(), String> {
    tlog!(
        "[io] reconfigure_session called - session: {}, start: {:?}, end: {:?}",
        session_id, start, end
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions.get_mut(session_id).ok_or_else(|| {
        let err = format!("Session '{}' not found", session_id);
        tlog!("[io] reconfigure_session: {}", err);
        err
    })?;

    // Phase 1: Stop the old stream and update options (no new frames after this)
    session.source.prepare_reconfigure(start.clone(), end.clone()).await?;

    // Emit session-reconfigured BETWEEN stop and start.
    // This ensures the event ordering in the frontend is:
    //   [stale frames from old stream] → [session-reconfigured] → [new frames]
    // The frontend clears stale frames when it receives this event.
    crate::ws::dispatch::send_reconfigured(session_id);

    // Phase 2: Start the new stream (orphans old capture, creates new one)
    let result = session.source.complete_reconfigure().await;
    if let Err(ref e) = result {
        tlog!("[io] reconfigure_session failed on restart: {}", e);
    } else {
        let state_after = session.source.state();
        tlog!(
            "[io] reconfigure_session completed successfully - final state: {:?}",
            state_after
        );
        // Force emit Stopped -> current to ensure UI updates to streaming state
        emit_state_change(session_id, &IOState::Stopped, &state_after);
    }
    result
}

/// Seek to a specific timestamp in microseconds
pub async fn seek_session(session_id: &str, timestamp_us: i64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.seek(timestamp_us)
}

/// Seek to a specific frame index (preferred for capture playback)
pub async fn seek_session_by_frame(session_id: &str, frame_index: i64) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.seek_by_frame(frame_index)
}

/// Set playback direction (reverse = true for backwards playback)
pub async fn update_session_direction(session_id: &str, reverse: bool) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    session.source.set_direction(reverse)
}

/// Switch a session to capture replay mode.
/// This replaces the session's reader with a CaptureSource that reads from the session's
/// owned capture. The session stays alive and all listeners remain connected.
/// Use this after ingest completes to enable playback without destroying the session.
pub async fn switch_to_capture_replay(app: &AppHandle, session_id: &str, speed: f64) -> Result<IOCapabilities, String> {
    // Get the frame capture this session streamed into
    let capture_id = crate::capture_store::get_session_frame_capture_id(session_id)
        .ok_or_else(|| {
            let captures = crate::capture_store::list_captures();
            tlog!(
                "[io] switch_to_capture_replay: No capture found for session '{}'. Available captures:",
                session_id
            );
            for cap in &captures {
                tlog!(
                    "  - {} (owner: {:?}, count: {})",
                    cap.id,
                    cap.owning_session_id,
                    cap.count
                );
            }
            format!("No capture found for session '{}'", session_id)
        })?;

    // Log capture details
    let capture_count = crate::capture_store::get_capture_count(&capture_id);
    tlog!(
        "[io] switch_to_capture_replay: session='{}', capture='{}', frames={}, speed={}",
        session_id, capture_id, capture_count, speed
    );

    let _ = crate::capture_store::mark_capture_active(&capture_id);

    // Create a new CaptureSource that reads from the session's capture
    let new_reader = CaptureSource::new(
        app.clone(),
        session_id.to_string(),
        capture_id,
        speed,
    );

    let mut sessions = IO_SESSIONS.lock().await;
    let result = replace_session_source(
        &mut sessions,
        session_id,
        Box::new(new_reader),
        ReplaceSourceOptions {
            transition: "capture".to_string(),
            auto_start: false,
            source_names: None,
            source_configs: None,
        },
    ).await?;

    Ok(result.capabilities)
}

/// Resume a session from capture playback back to live streaming.
/// This replaces the CaptureSource with a new live reader (passed in from the caller
/// who creates it from profile config). The session stays alive and all listeners
/// remain connected.
///
/// Steps:
/// 1. Replace device via `replace_session_source` (stops old, swaps, auto-starts)
/// 2. `replace_session_source` emits `session-lifecycle` signal so apps refresh state
pub async fn resume_to_live_session(
    session_id: &str,
    new_reader: Box<dyn IOSource>,
) -> Result<IOCapabilities, String> {
    tlog!(
        "[io] resume_to_live_session: session='{}' switching from capture to live",
        session_id
    );

    let mut sessions = IO_SESSIONS.lock().await;
    // replace_session_source emits session-lifecycle internally
    let result = replace_session_source(
        &mut sessions,
        session_id,
        new_reader,
        ReplaceSourceOptions {
            transition: "live".to_string(),
            auto_start: true,
            source_names: None,
            source_configs: None,
        },
    ).await?;

    Ok(result.capabilities)
}

/// Destroy a reader session. `reset` marks a deliberate user destroy so the
/// frontend resets to "No source" rather than the orphaned capture.
pub async fn destroy_session(session_id: &str, reset: bool) -> Result<(), String> {
    let removed = {
        let mut sessions = IO_SESSIONS.lock().await;
        sessions.remove(session_id)
    };
    // Lock released — perform slow operations outside the critical section
    // Detach unconditionally: stale attachments must go even if the session had
    // already been removed (see `detach_all_from_session`).
    detach_all_from_session(session_id);
    if let Some(mut session) = removed {
        // Stop the reader first
        let _ = session.source.stop().await;
        // Orphan captures and store IDs in post-session cache before lifecycle event.
        // The frontend fetches orphaned capture IDs via command when it handles "destroyed".
        let orphaned = crate::capture_store::orphan_captures_for_session(session_id);
        emit_capture_orphaned_as_changed(session_id, orphaned);
        // Now emit lifecycle event
        let source_profile_ids = crate::sessions::get_session_profile_ids(session_id);
        emit_session_lifecycle(&session.app, SessionLifecyclePayload {
            session_id: session_id.to_string(),
            event_type: "destroyed".to_string(),
            source_type: None,
            state: None,
            subscriber_count: 0,
            source_profile_ids,
            creator_subscriber_id: None,
            reset,
        });
    }
    // Clear the closing flag now that the session is fully destroyed
    clear_session_closing(session_id);
    // Clear any stored startup error
    clear_startup_error(session_id);
    clear_playback_position(session_id);
    // Don't sweep_expired here — the orphaned capture IDs were just stored
    // and need to survive long enough for the frontend to fetch them.
    Ok(())
}

fn transmitting_session<'a>(
    sessions: &'a HashMap<String, IOSession>,
    session_id: &str,
    payload: &TransmitPayload,
) -> Result<&'a IOSession, String> {
    if matches!(payload, TransmitPayload::CanFrame(f) if f.is_brs && !f.is_fd) {
        return Err("A classic CAN frame does not support bit rate switch (BRS)".to_string());
    }
    if matches!(payload, TransmitPayload::CanFrame(f) if f.is_rtr && f.is_fd) {
        return Err("A CAN FD frame does not support remote request (RTR)".to_string());
    }
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let caps = session.source.capabilities();

    // Check if the reader supports the requested transmit type
    match payload {
        TransmitPayload::CanFrame(_) if !caps.traits.tx_frames => {
            return Err("This session does not support CAN transmission".to_string());
        }
        TransmitPayload::RawBytes(_) if !caps.traits.tx_bytes => {
            return Err("This session does not support serial transmission".to_string());
        }
        _ => {}
    }
    Ok(session)
}

/// Transmit a payload through a session (unified)
pub async fn session_transmit(session_id: &str, payload: &TransmitPayload) -> Result<TransmitResult, String> {
    let sessions = IO_SESSIONS.lock().await;
    // Call device transmit — fire-and-forget for most devices.
    // Queues the frame into the device's transmit channel and returns
    // immediately. The lock is held only briefly for the channel send.
    transmitting_session(&sessions, session_id, payload)?.source.transmit(payload)
}

/// Transmit a CAN frame through a session (convenience wrapper)
pub async fn transmit_frame(session_id: &str, frame: &CanTransmitFrame) -> Result<TransmitResult, String> {
    session_transmit(session_id, &TransmitPayload::CanFrame(frame.clone())).await
}

/// [`transmit_frame`], waiting for room in the source's send queue instead of
/// being refused by a full one. The wait holds no session lock.
pub async fn transmit_frame_when_ready(session_id: &str, frame: &CanTransmitFrame) -> Result<TransmitResult, String> {
    let pending = {
        let sessions = IO_SESSIONS.lock().await;
        let payload = TransmitPayload::CanFrame(frame.clone());
        transmitting_session(&sessions, session_id, &payload)?.source.pending_can_transmit(frame)?
    };
    pending.send_when_ready().await
}

/// Transmit raw serial bytes through a session (convenience wrapper)
pub async fn transmit_serial(session_id: &str, bytes: &[u8]) -> Result<TransmitResult, String> {
    session_transmit(session_id, &TransmitPayload::RawBytes(bytes.to_vec())).await
}

/// Re-read a session's capabilities and push them to the frontend.
///
/// For changes that originate in the backend — a source revising its bus
/// mappings once it has seen the device — where no command is on the stack to
/// return the new set to. Silently does nothing if the session has since gone.
pub async fn refresh_session_capabilities(session_id: &str) {
    let sessions = IO_SESSIONS.lock().await;
    let Some(session) = sessions.get(session_id) else {
        return;
    };
    let capabilities = session.source.capabilities();
    let state = session.source.state();
    drop(sessions);

    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &state, &capabilities);
}

/// Change serial framing on a running session in place (no device reconnect),
/// then broadcast the updated capabilities (rx_frames flips when framing turns
/// a Raw byte stream into framed messages). Returns the new capabilities.
pub async fn set_framing(
    session_id: &str,
    req: types::SetFramingRequest,
) -> Result<IOCapabilities, String> {
    // Keep the WS decode path in step with the port; see `SERIAL_RTU_OPTIONS`.
    if let Some(options) = req.modbus.clone() {
        crate::ws::dispatch::set_serial_rtu_options(session_id, options);
    }
    let sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;
    session.source.set_framing(req)?;
    let capabilities = session.source.capabilities();
    let state = session.source.state();
    drop(sessions);

    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &state, &capabilities);
    Ok(capabilities)
}

/// Result of registering a subscriber
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RegisterSubscriberResult {
    /// Session capabilities
    pub capabilities: IOCapabilities,
    /// Current session state
    pub state: IOState,
    /// Active capture ID (if any)
    pub capture_id: Option<String>,
    /// Capture kind
    pub capture_kind: Option<crate::capture_store::CaptureKind>,
    /// Total number of subscribers
    pub subscriber_count: usize,
    /// Error that occurred before this subscriber registered (one-shot, cleared after return)
    pub startup_error: Option<String>,
    /// Profiles the session was opened from (see `get_session_origin_profile_ids`)
    pub origin_profile_ids: Vec<String>,
    /// What kind of source is behind the session, as the roster reports it
    pub source_type: String,
}

/// Register a subscriber for a session.
/// This is the primary way for frontend components to join a session.
/// If the subscriber is already registered, this updates their heartbeat.
/// Returns session info for the registered subscriber.
pub async fn register_subscriber(session_id: &str, subscriber_id: &str, app_name: Option<&str>) -> Result<RegisterSubscriberResult, String> {
    let resolved_app_name = app_name.unwrap_or(subscriber_id).to_string();

    // The subscriber's prior session attachment, captured before we re-attach it here.
    // Enforcing the one-subscriber-one-session invariant is automatic: `session_id` is a
    // single Option, so attaching to this session detaches from any other. If that other
    // session is left empty we tear it down after releasing the lock.
    let prev_session_id = current_session_of_app(subscriber_id);

    let result = {
        let mut sessions = IO_SESSIONS.lock().await;
        let now = std::time::Instant::now();

        // Verify the session exists before attaching, and resume it if a heartbeat
        // arrived while it was suspended (e.g. display woke up, App Nap ended).
        let needs_resume = {
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(|| format!("Session '{}' not found", session_id))?;
            if let Some(suspended_at) = session.suspended_at.take() {
                let suspended_for = now.duration_since(suspended_at);
                tlog!(
                    "[reader] Session '{}' resuming from suspension (was suspended for {:?}, subscriber '{}' heartbeat)",
                    session_id, suspended_for, subscriber_id
                );
                // Only resume if the device is paused (we paused it during suspension)
                matches!(session.source.state(), IOState::Paused)
            } else {
                false
            }
        };

        // Attach (idempotent — refreshes heartbeat / app_name / is_active). The
        // per-session subscriber view is derived from the registry.
        attach_app(subscriber_id, &resolved_app_name, session_id);
        let count = subscriber_count_for_session(session_id);
        tlog!(
            "[reader] Session '{}' registered subscriber '{}', total: {}",
            session_id, subscriber_id, count
        );
        emit_joiner_count_change(session_id, count, Some(subscriber_id), Some(&resolved_app_name), Some("joined"));

        // Get the session's own capture. Reporting its real kind is what lets a joining
        // app tell a raw serial link from a CAN one — Discovery keys its serial view off
        // exactly this, and used to be told "frames" or nothing at all.
        let (capture_id, capture_kind) = crate::capture_store::get_session_capture(session_id).unzip();

        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;

        // Resume from suspension if needed (the reader was paused when listeners went stale)
        if needs_resume {
            let previous = session.source.state();
            match session.source.resume().await {
                Ok(()) => {
                    let current = session.source.state();
                    if previous != current {
                        emit_state_change(session_id, &previous, &current);
                    }
                    tlog!("[reader] Session '{}' reader resumed successfully", session_id);
                }
                Err(e) => {
                    tlog!("[reader] Session '{}' failed to resume reader: {}", session_id, e);
                }
            }
        }

        // Retrieve any startup error (one-shot: cleared after retrieval)
        let startup_error = take_startup_error(session_id);
        if let Some(ref err) = startup_error {
            tlog!("[reader] Returning startup error for session '{}': {}", session_id, err);
        }

        RegisterSubscriberResult {
            capabilities: session.source.capabilities(),
            state: session.source.state(),
            capture_id,
            capture_kind,
            subscriber_count: subscriber_count_for_session(session_id),
            startup_error,
            origin_profile_ids: sessions::get_session_origin_profile_ids(session_id),
            source_type: session.source.source_type().to_string(),
        }
    };
    // Lock released here

    // If the subscriber moved off a different session, tear that session down if it's
    // now empty (same cascade as the last subscriber leaving). `reset: true` — the
    // subscriber chose this new session; see `teardown_session_if_empty`.
    if let Some(prev) = prev_session_id {
        if prev != session_id {
            teardown_session_if_empty(&prev, true).await;
        }
    }

    Ok(result)
}

/// Run the slow Phase-2 teardown for a session that has already been removed from
/// IO_SESSIONS. The caller MUST have dropped the IO_SESSIONS lock first, since stopping
/// the source and emitting lifecycle events can be slow. Shared by the two "last
/// subscriber left" paths: an explicit unregister, and the one-subscriber-one-session
/// eviction that fires when a subscriber registers on a different session.
async fn destroy_extracted_session(session_id: &str, mut session: IOSession, reset: bool) {
    let _ = session.source.stop().await;
    // Nothing may still claim this session — see `detach_all_from_session`.
    detach_all_from_session(session_id);
    // Orphan captures and store IDs in post-session cache before lifecycle event.
    let orphaned = crate::capture_store::orphan_captures_for_session(session_id);
    emit_capture_orphaned_as_changed(session_id, orphaned);
    // Now emit lifecycle event
    let source_profile_ids = crate::sessions::get_session_profile_ids(session_id);
    emit_session_lifecycle(&session.app, SessionLifecyclePayload {
        session_id: session_id.to_string(),
        event_type: "destroyed".to_string(),
        source_type: None,
        state: None,
        subscriber_count: 0,
        source_profile_ids,
        creator_subscriber_id: None,
        reset,
    });
    // Clear any closing flag
    clear_session_closing(session_id);
    clear_playback_position(session_id);
    // Clean up profile tracking (release single-handle device locks)
    crate::sessions::cleanup_session_profiles(session_id);
    tlog!("[reader] Session '{}' destroyed", session_id);
}

/// Unregister a subscriber from a session.
/// If this was the last subscriber, the session will be stopped and destroyed.
/// Returns the remaining subscriber count.
pub async fn unregister_subscriber(session_id: &str, subscriber_id: &str) -> Result<usize, String> {
    // Only act if the subscriber is actually attached to THIS session.
    if current_session_of_app(subscriber_id).as_deref() != Some(session_id) {
        return Ok(subscriber_count_for_session(session_id));
    }

    // Detach in the registry (keeps the instance — the panel may still be open; it
    // becomes an unconnected app node). The per-session count is derived.
    detach_app(subscriber_id);
    let remaining = subscriber_count_for_session(session_id);
    tlog!(
        "[reader] Session '{}' unregistered subscriber '{}', remaining: {}",
        session_id, subscriber_id, remaining
    );

    // Emit the updated count and destroy the session if that was the last subscriber.
    // `reset: false` — a plain leave is an ordinary end-of-session, so any app still
    // on it keeps the existing orphaned-capture fallback.
    teardown_session_if_empty(session_id, false).await;

    Ok(remaining)
}

/// Detach a single subscriber from a session, handing it a frozen snapshot copy of the
/// session's frame capture so it can keep reviewing the data standalone. The session
/// stays alive for the remaining subscribers (or is destroyed if this was the last one).
/// `label` names the snapshot in the capture list (e.g. "evicted", "review"). Returns the
/// copied capture IDs and emits `subscriber-evicted` so the detached app switches to it.
async fn detach_subscriber_to_capture_copy(
    app: &AppHandle,
    session_id: &str,
    subscriber_id: &str,
    name_for_copy: impl Fn(&str) -> String,
) -> Result<Vec<String>, String> {
    // Copy the capture before unregistering (so the detached subscriber gets a snapshot).
    let mut copied_capture_ids = Vec::new();
    if let Some((capture_id, _kind)) = crate::capture_store::get_session_capture(session_id) {
        // Derive the snapshot name from the original capture's name.
        let base = crate::capture_store::get_capture_metadata(&capture_id)
            .map(|m| m.name)
            .unwrap_or_else(|| capture_id.clone());
        let copy_name = name_for_copy(&base);
        match crate::capture_store::copy_capture(&capture_id, copy_name) {
            Ok(copied_id) => {
                tlog!(
                    "[reader] Copied capture '{}' -> '{}' for detached subscriber '{}'",
                    capture_id, copied_id, subscriber_id
                );
                copied_capture_ids.push(copied_id);
            }
            Err(e) => {
                tlog!(
                    "[reader] Failed to copy capture for detached subscriber '{}': {}",
                    subscriber_id, e
                );
            }
        }
    }

    // Unregister the subscriber (this may destroy the session if it was the last one).
    let remaining = unregister_subscriber(session_id, subscriber_id).await?;

    // Emit subscriber-evicted so the frontend switches the detached app to the snapshot.
    #[derive(Clone, Debug, Serialize)]
    struct SubscriberEvictedPayload {
        session_id: String,
        subscriber_id: String,
        capture_ids: Vec<String>,
    }
    let _ = app.emit("subscriber-evicted", SubscriberEvictedPayload {
        session_id: session_id.to_string(),
        subscriber_id: subscriber_id.to_string(),
        capture_ids: copied_capture_ids.clone(),
    });

    tlog!(
        "[reader] Detached subscriber '{}' from session '{}' (remaining: {}, capture copies: {:?})",
        subscriber_id, session_id, remaining, copied_capture_ids
    );
    Ok(copied_capture_ids)
}

/// Evict a subscriber from a session (Session Manager: forced removal), handing it a
/// snapshot copy of the capture. See [`detach_subscriber_to_capture_copy`].
pub async fn evict_session_subscriber(app: &AppHandle, session_id: &str, subscriber_id: &str) -> Result<Vec<String>, String> {
    detach_subscriber_to_capture_copy(app, session_id, subscriber_id, |base| format!("{} (evicted)", base)).await
}

/// Leave a session (user-initiated): the calling subscriber detaches and reviews a frozen
/// snapshot of the capture, while the session keeps streaming for any remaining apps. The
/// snapshot gets a unique "{name}_{n}" name so repeated leaves stay distinct.
pub async fn leave_session_to_capture(app: &AppHandle, session_id: &str, subscriber_id: &str) -> Result<Vec<String>, String> {
    detach_subscriber_to_capture_copy(app, session_id, subscriber_id, crate::capture_store::next_indexed_name).await
}

/// Add a new source to an existing multi-source session.
/// Stops the current device, creates a new IOBroker with all sources (old + new),
/// swaps it into the session, and restarts. Keeps the same session ID and listeners.
pub async fn add_source_to_session(
    app: &AppHandle,
    session_id: &str,
    new_source: SourceConfig,
) -> Result<IOCapabilities, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // Get current source configs — only multi-source sessions support this
    let existing_configs = session.source.broker_configs()
        .ok_or_else(|| "Session does not support multi-source — cannot add a source".to_string())?;

    // Check for duplicate profile
    if existing_configs.iter().any(|c| c.profile_id == new_source.profile_id) {
        return Err(format!(
            "Profile '{}' is already a source in session '{}'",
            new_source.profile_id, session_id
        ));
    }

    let new_display_name = new_source.display_name.clone();

    // If the session is running, hot-add the source without stopping
    if matches!(session.source.state(), IOState::Running) {
        session.source.add_source_hot(new_source)?;
        session.source_names.push(new_display_name.clone());
        let capabilities = session.source.capabilities();
        tlog!(
            "[reader] Hot-added source '{}' to session '{}' (sources: {:?})",
            new_display_name, session_id, session.source_names
        );
        return Ok(capabilities);
    }

    // Cold path: session not running — rebuild the IOBroker
    let mut all_configs = existing_configs;
    all_configs.push(new_source);

    let source_display_names: Vec<String> = all_configs.iter()
        .map(|c| c.display_name.clone())
        .collect();

    let reader = IOBroker::new(app.clone(), session_id.to_string(), all_configs)?;
    let capabilities = reader.capabilities();

    session.source = Box::new(reader);
    session.source_names = source_display_names;

    tlog!(
        "[reader] Added source '{}' to session '{}' (sources: {:?})",
        new_display_name, session_id, session.source_names
    );

    Ok(capabilities)
}

/// Remove a source from an existing multi-source session.
/// Stops the current device, creates a new IOBroker with the remaining sources
/// (preserving their bus mappings), swaps it into the session, and restarts.
pub async fn remove_source_from_session(
    app: &AppHandle,
    session_id: &str,
    profile_id: &str,
) -> Result<IOCapabilities, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // Get current source configs — only multi-source sessions support this
    let existing_configs = session.source.broker_configs()
        .ok_or_else(|| "Session does not support multi-source — cannot remove a source".to_string())?;

    // Check the profile is actually a source
    if !existing_configs.iter().any(|c| c.profile_id == profile_id) {
        return Err(format!(
            "Profile '{}' is not a source in session '{}'",
            profile_id, session_id
        ));
    }

    // Must keep at least one source
    let remaining_count = existing_configs.iter().filter(|c| c.profile_id != profile_id).count();
    if remaining_count == 0 {
        return Err("Cannot remove the last source — destroy the session instead".to_string());
    }

    // If the session is running, hot-remove the source without stopping
    if matches!(session.source.state(), IOState::Running) {
        session.source.remove_source_hot(profile_id)?;
        // Rebuild source_names from current configs
        if let Some(configs) = session.source.broker_configs() {
            session.source_names = configs.iter().map(|c| c.display_name.clone()).collect();
        }
        let capabilities = session.source.capabilities();
        tlog!(
            "[reader] Hot-removed source '{}' from session '{}' (remaining: {:?})",
            profile_id, session_id, session.source_names
        );
        return Ok(capabilities);
    }

    // Cold path: session not running — rebuild the IOBroker
    let remaining_configs: Vec<_> = existing_configs
        .into_iter()
        .filter(|c| c.profile_id != profile_id)
        .collect();

    let source_display_names: Vec<String> = remaining_configs.iter()
        .map(|c| c.display_name.clone())
        .collect();

    let reader = IOBroker::new(app.clone(), session_id.to_string(), remaining_configs)?;
    let capabilities = reader.capabilities();

    session.source = Box::new(reader);
    session.source_names = source_display_names;

    tlog!(
        "[reader] Removed source '{}' from session '{}' (remaining sources: {:?})",
        profile_id, session_id, session.source_names
    );

    Ok(capabilities)
}

/// Pause or resume one source, then tell every window the roster moved.
///
/// The session stays active and other sources continue normally.
///
/// The broadcast is the half that makes `paused_source_profile_ids` worth
/// reporting: `useSessionRosterSync` re-fetches on a lifecycle push, on mount and
/// on reconnect, and nothing else. Without it a second panel on the same session
/// would keep showing the state it last set for itself.
pub async fn set_source_polling(
    session_id: &str,
    profile_id: &str,
    polling: bool,
) -> Result<(), String> {
    let sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    if polling {
        session.source.resume_source_polling(profile_id)?;
    } else {
        session.source.pause_source_polling(profile_id)?;
    }

    emit_session_lifecycle(
        &session.app,
        SessionLifecyclePayload {
            session_id: session_id.to_string(),
            event_type: "updated".to_string(),
            source_type: Some(session.source.source_type().to_string()),
            state: None,
            subscriber_count: subscriber_count_for_session(session_id),
            source_profile_ids: sessions::get_session_profile_ids(session_id),
            creator_subscriber_id: None,
            reset: false,
        },
    );
    Ok(())
}

/// Update bus mappings for a source in a multi-source session.
/// Hot-swaps the source by removing and re-adding it with updated mappings.
/// If no mappings are enabled, the source is removed entirely (unless it's the last source).
pub async fn update_source_bus_mappings(
    session_id: &str,
    profile_id: &str,
    mut bus_mappings: Vec<BusMapping>,
) -> Result<IOCapabilities, String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    // Only multi-source sessions support this
    let configs = session.source.broker_configs()
        .ok_or_else(|| "Session does not support multi-source — cannot update bus mappings".to_string())?;

    // Traits are derived, never accepted — the same normalisation the create
    // path applies, so a hot-swap cannot leave a session in a state
    // `create_multi_source_session` would never have produced. The live source
    // already knows its kind, so the caller needn't say.
    let kind = configs
        .iter()
        .find(|c| c.profile_id == profile_id)
        .map(|c| c.profile_kind.clone())
        .ok_or_else(|| format!("Source '{}' is not part of session '{}'", profile_id, session_id))?;
    traits::normalise_bus_traits(&mut bus_mappings, &kind);

    // Delegate to the device implementation (handles hot-swap internally)
    session.source.update_source_bus_mappings(profile_id, bus_mappings)?;

    // Rebuild source_names from current configs
    if let Some(configs) = session.source.broker_configs() {
        session.source_names = configs.iter().map(|c| c.display_name.clone()).collect();
    }

    let capabilities = session.source.capabilities();
    tlog!(
        "[reader] Updated bus mappings for source '{}' in session '{}' (sources: {:?})",
        profile_id, session_id, session.source_names
    );

    Ok(capabilities)
}

/// Reconnect one source of a running session so it picks up its profile's
/// current connection parameters.
///
/// Re-applying the bus mappings the source already has is a remove-then-add,
/// which is the whole job: the source config is unchanged, and the merge task
/// re-reads the profile — which did change — when it respawns it.
///
/// Reconnecting is a session-lifecycle operation, not a device capability:
/// no device can re-tune a bitrate or a baud rate in place, so there is nothing
/// per-type to dispatch on.
pub async fn reload_session_source(
    session_id: &str,
    profile_id: &str,
) -> Result<(), String> {
    let mut sessions = IO_SESSIONS.lock().await;
    let session = sessions
        .get_mut(session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let mappings = session
        .source
        .broker_configs()
        .ok_or_else(|| {
            "This source cannot be reconfigured while it is open — stop the session first"
                .to_string()
        })?
        .into_iter()
        .find(|c| c.profile_id == profile_id)
        .ok_or_else(|| format!("Profile '{}' is not a source in this session", profile_id))?
        .bus_mappings;

    session.source.update_source_bus_mappings(profile_id, mappings)?;

    tlog!(
        "[reader] Reloaded source '{}' in session '{}'",
        profile_id, session_id
    );
    Ok(())
}

/// Result of attempting a safe reinitialize
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ReinitializeResult {
    /// Whether the reinitialize was successful
    pub success: bool,
    /// Reason for failure (if success is false)
    pub reason: Option<String>,
    /// List of other listeners preventing reinitialize (if any)
    pub other_subscribers: Vec<String>,
}

/// Check if it's safe to reinitialize a session.
/// Reinitialize is only safe if the requesting subscriber is the only subscriber.
/// This is an atomic check-and-act operation to prevent race conditions.
///
/// If safe, the session will be destroyed so a new one can be created.
/// The caller should create a new session after this returns success.
pub async fn reinitialize_session_if_safe(
    session_id: &str,
    subscriber_id: &str,
) -> Result<ReinitializeResult, String> {
    let mut sessions = IO_SESSIONS.lock().await;

    // Session doesn't exist - that's fine, caller can create a new one
    if !sessions.contains_key(session_id) {
        return Ok(ReinitializeResult {
            success: true,
            reason: None,
            other_subscribers: vec![],
        });
    }

    // Check if this subscriber is the only one (derived from the open-app registry)
    let other_subscribers = other_instances_on_session(session_id, subscriber_id);

    if !other_subscribers.is_empty() {
        return Ok(ReinitializeResult {
            success: false,
            reason: Some(format!(
                "Cannot reinitialize: {} other subscriber(s) connected",
                other_subscribers.len()
            )),
            other_subscribers,
        });
    }

    // Safe to reinitialize - destroy the session
    if let Some(mut session) = sessions.remove(session_id) {
        // Emit lifecycle event before stopping
        let source_profile_ids = crate::sessions::get_session_profile_ids(session_id);
        emit_session_lifecycle(&session.app, SessionLifecyclePayload {
            session_id: session_id.to_string(),
            event_type: "destroyed".to_string(),
            source_type: None,
            state: None,
            subscriber_count: 0,
            source_profile_ids,
            creator_subscriber_id: None,
            reset: false,
        });
        let _ = session.source.stop().await;
    }
    clear_session_closing(session_id);

    tlog!(
        "[reader] Session '{}' reinitialized by subscriber '{}'",
        session_id, subscriber_id
    );

    Ok(ReinitializeResult {
        success: true,
        reason: None,
        other_subscribers: vec![],
    })
}

/// Set the active state of a subscriber.
/// When a subscriber detaches (stops receiving frames), set is_active to false.
/// When they rejoin, set is_active to true.
pub async fn set_subscriber_active(session_id: &str, subscriber_id: &str, is_active: bool) -> Result<(), String> {
    {
        let sessions = IO_SESSIONS.lock().await;
        if !sessions.contains_key(session_id) {
            return Err(format!("Session '{}' not found", session_id));
        }
    }
    // The subscriber lives in the open-app registry; verify it's attached to this session.
    if current_session_of_app(subscriber_id).as_deref() != Some(session_id) {
        return Err(format!("Subscriber '{}' not found in session '{}'", subscriber_id, session_id));
    }
    tlog!(
        "[reader] Session '{}' subscriber '{}' active -> {}",
        session_id, subscriber_id, is_active
    );
    set_app_active(subscriber_id, is_active);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_session_state_keeps_its_name_code_and_string() {
        let cases = [
            (IOState::Stopped, "stopped", 0, "stopped"),
            (IOState::Starting, "starting", 1, "starting"),
            (IOState::Running, "running", 2, "running"),
            (IOState::Paused, "paused", 3, "paused"),
            (IOState::Error("boom".into()), "error", 4, "error:boom"),
        ];
        for (state, name, code, string) in cases {
            assert_eq!(state.name(), name);
            assert_eq!(state.code(), code);
            assert_eq!(crate::ws::protocol::code_of(&crate::ws::protocol::SESSION_STATES, name), code);
            assert_eq!(state_to_string(&state), string);
        }
    }

    #[test]
    fn a_bit_rate_switch_on_a_classic_frame_is_refused() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![0; 8],
            bus: 0,
            is_extended: false,
            is_fd: false,
            is_brs: true,
            is_rtr: false,
        };
        let refused = tauri::async_runtime::block_on(transmit_frame("no-such-session", &frame));
        assert_eq!(
            refused.unwrap_err(),
            "A classic CAN frame does not support bit rate switch (BRS)"
        );
    }

    #[test]
    fn a_remote_frame_on_can_fd_is_refused() {
        let frame = CanTransmitFrame {
            frame_id: 0x123,
            data: vec![],
            bus: 0,
            is_extended: false,
            is_fd: true,
            is_brs: false,
            is_rtr: true,
        };
        let refused = tauri::async_runtime::block_on(transmit_frame("no-such-session", &frame)).unwrap_err();
        assert_eq!(refused, "A CAN FD frame does not support remote request (RTR)");
        assert!(crate::transmit::is_permanent_error_pub(&refused));
    }
}
