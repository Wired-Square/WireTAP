use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, MutexGuard, PoisonError, RwLock};
use std::time::Instant;

use once_cell::sync::Lazy;
use serde::Serialize;
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::roster::{
    attach_app, current_session_of_app, detach_all_from_session, detach_app, other_instances_on_session,
    session_exists, set_app_active, subscriber_count_for_session,
};
use super::{
    emit_capture_orphaned_as_changed, emit_session_lifecycle, emit_to_windows, traits, types, BusMapping, CanTransmitFrame,
    CaptureSource, IOBroker, IOCapabilities, IOSource, IOState, LifecycleEvent, PlaybackPosition, ProfileLoader, ReplaceSourceOptions,
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
    /// Display names of the sources in this session (for logging)
    pub source_names: Vec<String>,
    /// Original source configs for rebuilding the live reader on resume.
    /// Empty for non-multi-source sessions (recorded, buffer).
    pub source_configs: Vec<SourceConfig>,
    /// Set by the teardown before it lets go of the session, so whoever was waiting
    /// on the session finds it gone.
    retired: bool,
}

/// Everything the process keeps for one session, so that forgetting a session is
/// removing its entry. The profiles are the exception: they are keyed both ways
/// in `sessions::tracking`.
pub(super) struct SessionState {
    io: Arc<Mutex<IOSession>>,
    /// When all listeners went stale. During this grace period the reader is paused
    /// but the session stays alive, allowing recovery after display sleep / App Nap.
    pub(super) suspended_at: Option<Instant>,
    /// Updated during capture/recorded streaming, polled by the frontend.
    playback_position: Option<PlaybackPosition>,
    /// An error from before any subscriber registered, handed to the first one.
    startup_error: Option<String>,
}

/// The session registry. Held only to find a session or touch its synchronous
/// state, never across an await: a driver call holds its own session's lock
/// instead, so a slow device open stalls only that session.
static IO_SESSIONS: Lazy<std::sync::Mutex<HashMap<String, SessionState>>> = Lazy::new(Default::default);

pub(super) fn session_states() -> MutexGuard<'static, HashMap<String, SessionState>> {
    IO_SESSIONS.lock().unwrap_or_else(PoisonError::into_inner)
}

fn not_found(session_id: &str) -> String {
    format!("Session '{}' not found", session_id)
}

/// The session, held for one operation. Operations on one session run one at a
/// time; different sessions' run in parallel.
pub(super) async fn lock_session(session_id: &str) -> Result<OwnedMutexGuard<IOSession>, String> {
    let cell = session_states()
        .get(session_id)
        .map(|s| s.io.clone())
        .ok_or_else(|| not_found(session_id))?;
    let session = cell.lock_owned().await;
    if session.retired {
        return Err(not_found(session_id));
    }
    Ok(session)
}

/// Wait out whatever operation is running on the session, a teardown included.
pub async fn settle_session(session_id: &str) {
    let _ = lock_session(session_id).await;
}

fn with_state<R>(session_id: &str, f: impl FnOnce(&mut SessionState) -> R) -> Option<R> {
    session_states().get_mut(session_id).map(f)
}

fn session_cells() -> Vec<(String, Arc<Mutex<IOSession>>)> {
    session_states().iter().map(|(id, s)| (id.clone(), s.io.clone())).collect()
}

/// `f` over every session, waiting for any that is mid-operation.
pub(super) async fn each_session<R>(mut f: impl FnMut(&str, &IOSession) -> R) -> Vec<R> {
    let mut out = Vec::new();
    for (id, cell) in session_cells() {
        let session = cell.lock().await;
        if !session.retired {
            out.push(f(&id, &session));
        }
    }
    out
}

/// `f` over every session not mid-operation: the watchdog's view, which must not
/// wait on a slow device.
pub(super) fn each_idle_session<R>(mut f: impl FnMut(&str, &IOSession) -> R) -> Vec<R> {
    session_cells()
        .into_iter()
        .filter_map(|(id, cell)| {
            let session = cell.try_lock().ok()?;
            (!session.retired).then(|| f(&id, &session))
        })
        .collect()
}

#[derive(Clone, Copy)]
enum Transition {
    Start,
    Stop,
    Pause,
    Resume,
}

impl Transition {
    fn reached(self, state: &IOState) -> bool {
        matches!(
            (self, state),
            (Self::Start | Self::Resume, IOState::Running)
                | (Self::Stop, IOState::Stopped)
                | (Self::Pause, IOState::Paused)
        )
    }
}

/// Drive the source to `to` and emit the state change; a no-op when it is already there.
async fn transition(session_id: &str, session: &mut IOSession, to: Transition) -> Result<IOState, String> {
    let previous = session.source.state();
    if to.reached(&previous) {
        return Ok(previous);
    }
    let source = &mut session.source;
    match to {
        Transition::Start => source.start().await?,
        Transition::Stop => source.stop().await?,
        Transition::Pause => source.pause().await?,
        Transition::Resume => source.resume().await?,
    }
    let current = session.source.state();
    if previous != current {
        emit_state_change(session_id, &previous, &current);
    }
    Ok(current)
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

/// If `session_id` has no attached subscribers left, destroy it (same cascade as
/// the last subscriber leaving). Otherwise emit the updated joiner count.
/// `reset` marks a deliberate move away from this session (see `destroy_session`);
/// it rides the `destroyed` event so apps return to "No source" instead of adopting
/// the orphaned capture.
pub(super) async fn teardown_session_if_empty(session_id: &str, reset: bool) {
    let count = subscriber_count_for_session(session_id);
    if count == 0 {
        if let Ok(session) = lock_session(session_id).await {
            tlog!("[reader] Session '{}' emptied (app/window gone), destroying", session_id);
            emit_joiner_count_change(session_id, 0, None, None, Some("left"));
            tear_down(session_id, session, Teardown::Destroy { reset }).await;
        }
    } else if session_exists(session_id).await {
        emit_joiner_count_change(session_id, count, None, None, Some("left"));
    }
    // Otherwise the count is phantom — subscribers still point at a session that is
    // gone. Don't broadcast a "left" for it, and don't detach either: this is also the
    // window `reinitialize_session` runs in, where the attachment is retained on
    // purpose because the session comes straight back under the same id.
}

pub fn store_playback_position(session_id: &str, position: PlaybackPosition) {
    with_state(session_id, |s| s.playback_position = Some(position));
}

pub fn get_playback_position(session_id: &str) -> Option<PlaybackPosition> {
    session_states().get(session_id).and_then(|s| s.playback_position.clone())
}

/// Sessions that are currently closing (window close in progress)
/// Uses RwLock (not async Mutex) so it can be checked synchronously
static CLOSING_SESSIONS: Lazy<RwLock<HashSet<String>>> = Lazy::new(|| RwLock::new(HashSet::new()));

// ============================================================================
// Startup Errors
// ============================================================================

/// Store a startup error for a session (called when error occurs with no listeners)
pub fn store_startup_error(session_id: &str, error: String) {
    tlog!("[reader] Storing session error for session '{}': {}", session_id, error);
    with_state(session_id, |s| s.startup_error = Some(error));
}

/// Take (retrieve and remove) the startup error for a session
pub fn take_startup_error(session_id: &str) -> Option<String> {
    with_state(session_id, |s| s.startup_error.take()).flatten()
}

/// Read the startup error without removing it (for signal-then-fetch polling)
pub fn get_startup_error(session_id: &str) -> Option<String> {
    session_states().get(session_id).and_then(|s| s.startup_error.clone())
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
    session_id: String,
    device: Box<dyn IOSource>,
    subscriber_id: Option<String>,
    app_name: Option<String>,
    source_names: Option<Vec<String>>,
    source_configs: Vec<SourceConfig>,
) -> CreateSessionResult {
    // Clear the closing flag in case this is a new session for a previously closed window
    clear_session_closing(&session_id);

    let capabilities = device.capabilities();
    let source_type = device.source_type().to_string();
    let state = device.state();

    // Join an existing session rather than overwrite it, once whatever it is doing
    // has finished. One that a teardown retired meanwhile is gone: look again.
    let existing = loop {
        let cell = match session_states().entry(session_id.clone()) {
            Entry::Occupied(entry) => entry.get().io.clone(),
            Entry::Vacant(entry) => {
                let io = Arc::new(Mutex::new(IOSession {
                    source: device,
                    source_names: source_names.unwrap_or_default(),
                    source_configs,
                    retired: false,
                }));
                entry.insert(SessionState {
                    io,
                    suspended_at: None,
                    playback_position: None,
                    startup_error: None,
                });
                break None;
            }
        };
        let session = cell.lock_owned().await;
        if !session.retired {
            break Some(session);
        }
    };

    if let Some(existing) = existing {
        let capabilities = existing.source.capabilities();

        // Clear suspension if the session was in the grace period
        if with_state(&session_id, |s| s.suspended_at.take()).flatten().is_some() {
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

    // Emit global session lifecycle event (to all windows)
    // Use get_session_profile_ids() to get actual profile IDs (not display names)
    // Profile tracking is registered before create_session() is called
    let source_profile_ids = crate::sessions::get_session_profile_ids(&session_id);
    emit_session_lifecycle(SessionLifecyclePayload {
        session_id: session_id.clone(),
        event_type: LifecycleEvent::Created,
        source_type: Some(source_type),
        state: Some(state),
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
    let mut session = lock_session(session_id)
        .await
        .inspect_err(|e| tlog!("[reader] start_session: {}", e))?;
    let current = transition(session_id, &mut session, Transition::Start).await?;
    tlog!("[reader] start_session('{}') - state: {:?}", session_id, current);
    Ok(current)
}

/// Stop a reader session
/// Returns the confirmed state after the operation.
pub async fn stop_session(session_id: &str) -> Result<IOState, String> {
    transition(session_id, &mut *lock_session(session_id).await?, Transition::Stop).await
}

/// Suspend a reader session - stops streaming, finalizes capture, session stays alive.
/// The capture remains owned by the session and all joined apps can view it.
/// Use `resume_session_fresh` to start streaming again with a new capture.
/// Returns the confirmed state after the operation.
pub async fn suspend_session(session_id: &str) -> Result<IOState, String> {
    let mut session = lock_session(session_id).await?;

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
/// Takes the session already locked, so a caller's checks and the swap are one
/// operation on it.
async fn replace_session_source(
    session: &mut IOSession,
    session_id: &str,
    new_device: Box<dyn IOSource>,
    opts: ReplaceSourceOptions,
) -> Result<SourceReplacedPayload, String> {
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
    with_state(session_id, |s| s.suspended_at = None);

    // 7. Optionally auto-start
    if opts.auto_start {
        session.source.start().await?;
    }

    let current_state = session.source.state();

    // 8. Build result payload (still returned to callers, just not emitted as event)
    let payload = SourceReplacedPayload {
        previous_source_type: previous_source_type.clone(),
        new_source_type: new_source_type.clone(),
        capabilities: capabilities.clone(),
        state: current_state.clone(),
        transition: opts.transition.clone(),
    };

    // 9. Emit session-lifecycle signal with inline state + capabilities
    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &current_state, &capabilities);

    // 10. Emit state change if different
    if previous_state != current_state {
        emit_state_change(session_id, &previous_state, &current_state);
    }

    tlog!(
        "[io] replace_session_source('{}') {} → {} (transition: {}, state: {:?})",
        session_id, previous_source_type, new_source_type, opts.transition, current_state
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
pub async fn stop_and_switch_to_capture(session_id: &str, speed: f64) -> Result<IOCapabilities, String> {
    let mut session = lock_session(session_id).await?;

    // A session already replaying has no realtime source to stop, and re-switching it
    // would restart playback from the beginning. The streaming-set lookup this replaced
    // refused that case by accident, having no capture to offer once one was finalised.
    if session.source.source_type() == CAPTURE_SOURCE_TYPE {
        return Err(format!("Session '{}' is already replaying a capture", session_id));
    }

    // Must be read before orphan_captures_for_session below, which releases ownership.
    let streamed_capture_id = capture_store::get_session_frame_capture_id(session_id);

    // Stop the device first — stop() triggers emit_stream_ended which calls
    // finalize_capture(), so we must stop before looking up the capture.
    if !matches!(session.source.state(), IOState::Stopped) {
        session.source.stop().await?;
    }

    // CaptureSource replays frames only, so a session that streamed bytes has nothing to
    // switch to and the caller falls back to suspending it.
    let capture_id = streamed_capture_id;

    // Try to switch to capture replay
    if let Some(ref bid) = capture_id {
        let _ = crate::capture_store::mark_capture_active(bid);

        // Domain-specific housekeeping before the swap
        capture_store::orphan_captures_for_session(session_id);
        sessions::swap_session_profiles_for_capture(session_id, bid);

        let new_reader = CaptureSource::new(session_id.to_string(), bid.clone(), speed);

        // Device is already stopped, so replace_session_source's stop is a no-op
        // replace_session_source emits session-lifecycle internally
        let result = replace_session_source(
            &mut session,
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
    let mut session = lock_session(session_id).await?;

    let previous = session.source.state();
    if !matches!(previous, IOState::Stopped) {
        return Err(format!(
            "Session must be stopped to resume with new capture (current: {:?})",
            previous
        ));
    }

    // Emit session-lifecycle signal with current state + capabilities before restart
    let caps = session.source.capabilities();
    crate::ws::dispatch::send_session_lifecycle_scoped(session_id, &previous, &caps);

    // Starting orphans the old capture and creates a new one. Recorded sources
    // (the WireTAP backend, CSV, Capture) handle capture creation in start().
    let current = transition(session_id, &mut session, Transition::Start).await?;

    tlog!(
        "[reader] resume_session_fresh('{}') - device started with fresh capture",
        session_id
    );

    Ok(current)
}

/// Pause a reader session
/// Returns the confirmed state after the operation.
pub async fn pause_session(session_id: &str) -> Result<IOState, String> {
    transition(session_id, &mut *lock_session(session_id).await?, Transition::Pause).await
}

/// Pause a session the watchdog suspended, unless a subscriber came back first.
pub(super) async fn pause_suspended_session(session_id: &str) -> Result<IOState, String> {
    let mut session = lock_session(session_id).await?;
    let state = session.source.state();
    let suspended = with_state(session_id, |s| s.suspended_at.is_some()).unwrap_or(false);
    if !suspended || !matches!(state, IOState::Running) {
        return Ok(state);
    }
    transition(session_id, &mut session, Transition::Pause).await
}

/// Resume a reader session
/// Returns the confirmed state after the operation.
pub async fn resume_session(session_id: &str) -> Result<IOState, String> {
    transition(session_id, &mut *lock_session(session_id).await?, Transition::Resume).await
}

/// Enable or disable traffic generation for a virtual device session
pub async fn set_session_traffic_enabled(session_id: &str, enabled: bool) -> Result<(), String> {
    lock_session(session_id).await?.source.set_traffic_enabled(enabled)
}

/// Enable or disable signal generator for a specific bus
pub async fn set_session_bus_traffic_enabled(session_id: &str, bus: u8, enabled: bool) -> Result<(), String> {
    lock_session(session_id).await?.source.set_bus_traffic_enabled(bus, enabled)
}

/// Update signal generator cadence for a specific bus
pub async fn set_session_bus_cadence(session_id: &str, bus: u8, frame_rate_hz: f64) -> Result<(), String> {
    lock_session(session_id).await?.source.set_bus_cadence(bus, frame_rate_hz)
}

/// Query per-bus signal generator states
pub async fn get_session_virtual_bus_states(session_id: &str) -> Result<Vec<VirtualBusState>, String> {
    lock_session(session_id).await?.source.virtual_bus_states()
}

/// Add a virtual bus generator to a running session
pub async fn add_session_virtual_bus(session_id: &str, bus: u8, traffic_type: String, frame_rate_hz: f64) -> Result<(), String> {
    lock_session(session_id).await?.source.add_virtual_bus(bus, traffic_type, frame_rate_hz)
}

/// Remove a virtual bus generator from a running session
pub async fn remove_session_virtual_bus(session_id: &str, bus: u8) -> Result<(), String> {
    lock_session(session_id).await?.source.remove_virtual_bus(bus)
}

/// Update speed for a reader session
pub async fn update_session_speed(session_id: &str, speed: f64) -> Result<(), String> {
    let mut session = lock_session(session_id).await?;

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

    let mut session = lock_session(session_id)
        .await
        .inspect_err(|e| tlog!("[io] update_session_time_range: {}", e))?;

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

    let mut session = lock_session(session_id)
        .await
        .inspect_err(|e| tlog!("[io] reconfigure_session: {}", e))?;

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
    lock_session(session_id).await?.source.seek(timestamp_us)
}

/// Seek to a specific frame index (preferred for capture playback)
pub async fn seek_session_by_frame(session_id: &str, frame_index: i64) -> Result<(), String> {
    lock_session(session_id).await?.source.seek_by_frame(frame_index)
}

/// Set playback direction (reverse = true for backwards playback)
pub async fn update_session_direction(session_id: &str, reverse: bool) -> Result<(), String> {
    lock_session(session_id).await?.source.set_direction(reverse)
}

/// Switch a session to capture replay mode.
/// This replaces the session's reader with a CaptureSource that reads from the session's
/// owned capture. The session stays alive and all listeners remain connected.
/// Use this after ingest completes to enable playback without destroying the session.
pub async fn switch_to_capture_replay(session_id: &str, speed: f64) -> Result<IOCapabilities, String> {
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
    let new_reader = CaptureSource::new(session_id.to_string(), capture_id, speed);

    let result = replace_session_source(
        &mut *lock_session(session_id).await?,
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

    // replace_session_source emits session-lifecycle internally
    let result = replace_session_source(
        &mut *lock_session(session_id).await?,
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
    match lock_session(session_id).await {
        Ok(session) => tear_down(session_id, session, Teardown::Destroy { reset }).await,
        // Stale attachments and per-session state must go even if the session had
        // already been removed (see `detach_all_from_session`).
        Err(_) => {
            detach_all_from_session(session_id);
            forget_session(session_id);
        }
    }
    Ok(())
}

enum Teardown {
    Destroy { reset: bool },
    /// The session comes straight back under the same id, so its subscribers stay
    /// attached and its captures stay owned.
    Reinitialise,
}

/// Stop the session, forget it, then emit `destroyed`. It stays registered and
/// locked until stopped, so a same-id create waits for the teardown instead of
/// having its profiles released by it.
async fn tear_down(session_id: &str, mut session: OwnedMutexGuard<IOSession>, how: Teardown) {
    let destroying = matches!(how, Teardown::Destroy { .. });
    if destroying {
        detach_all_from_session(session_id);
    }
    let _ = session.source.stop().await;
    session_states().remove(session_id);
    session.retired = true;
    if destroying {
        // The frontend fetches the orphaned ids from the post-session cache when it
        // handles `destroyed`, so they are stored before it and outlive the session.
        let orphaned = crate::capture_store::orphan_captures_for_session(session_id);
        emit_capture_orphaned_as_changed(session_id, orphaned);
    }
    let reset = matches!(how, Teardown::Destroy { reset: true });
    let source_profile_ids = forget_session(session_id);
    emit_session_lifecycle(SessionLifecyclePayload {
        session_id: session_id.to_string(),
        event_type: LifecycleEvent::Destroyed,
        source_type: None,
        state: None,
        subscriber_count: 0,
        source_profile_ids,
        creator_subscriber_id: None,
        reset,
    });
    tlog!("[reader] Session '{}' destroyed", session_id);
}

/// Clear what a session holds outside its entry, returning the profiles it held.
fn forget_session(session_id: &str) -> Vec<String> {
    clear_session_closing(session_id);
    sessions::release_session_profiles(session_id)
}

async fn transmitting_session(
    session_id: &str,
    payload: &TransmitPayload,
) -> Result<OwnedMutexGuard<IOSession>, String> {
    if matches!(payload, TransmitPayload::CanFrame(f) if f.is_brs && !f.is_fd) {
        return Err("A classic CAN frame does not support bit rate switch (BRS)".to_string());
    }
    if matches!(payload, TransmitPayload::CanFrame(f) if f.is_rtr && f.is_fd) {
        return Err("A CAN FD frame does not support remote request (RTR)".to_string());
    }
    let session = lock_session(session_id).await?;

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
    // Call device transmit — fire-and-forget for most devices.
    // Queues the frame into the device's transmit channel and returns
    // immediately. The lock is held only briefly for the channel send.
    transmitting_session(session_id, payload).await?.source.transmit(payload)
}

/// Transmit a CAN frame through a session (convenience wrapper)
pub async fn transmit_frame(session_id: &str, frame: &CanTransmitFrame) -> Result<TransmitResult, String> {
    session_transmit(session_id, &TransmitPayload::CanFrame(frame.clone())).await
}

/// [`transmit_frame`], waiting for room in the source's send queue instead of
/// being refused by a full one. The wait holds no session lock.
pub async fn transmit_frame_when_ready(session_id: &str, frame: &CanTransmitFrame) -> Result<TransmitResult, String> {
    let payload = TransmitPayload::CanFrame(frame.clone());
    let pending = transmitting_session(session_id, &payload).await?.source.pending_can_transmit(frame)?;
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
    let Ok(session) = lock_session(session_id).await else {
        return;
    };
    let capabilities = session.source.capabilities();
    let state = session.source.state();
    drop(session);

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
    let session = lock_session(session_id).await?;
    session.source.set_framing(req)?;
    let capabilities = session.source.capabilities();
    let state = session.source.state();
    drop(session);

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
        let mut session = lock_session(session_id).await?;

        // Resume the session if a heartbeat arrived while it was suspended (e.g.
        // display woke up, App Nap ended).
        let needs_resume = match with_state(session_id, |s| s.suspended_at.take()).flatten() {
            Some(suspended_at) => {
                tlog!(
                    "[reader] Session '{}' resuming from suspension (was suspended for {:?}, subscriber '{}' heartbeat)",
                    session_id, suspended_at.elapsed(), subscriber_id
                );
                // Only resume if the device is paused (we paused it during suspension)
                matches!(session.source.state(), IOState::Paused)
            }
            None => false,
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

        if needs_resume {
            match transition(session_id, &mut session, Transition::Resume).await {
                Ok(_) => tlog!("[reader] Session '{}' reader resumed successfully", session_id),
                Err(e) => tlog!("[reader] Session '{}' failed to resume reader: {}", session_id, e),
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
    emit_to_windows("subscriber-evicted", SubscriberEvictedPayload {
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
pub async fn evict_session_subscriber(session_id: &str, subscriber_id: &str) -> Result<Vec<String>, String> {
    detach_subscriber_to_capture_copy(session_id, subscriber_id, |base| format!("{} (evicted)", base)).await
}

/// Leave a session (user-initiated): the calling subscriber detaches and reviews a frozen
/// snapshot of the capture, while the session keeps streaming for any remaining apps. The
/// snapshot gets a unique "{name}_{n}" name so repeated leaves stay distinct.
pub async fn leave_session_to_capture(session_id: &str, subscriber_id: &str) -> Result<Vec<String>, String> {
    detach_subscriber_to_capture_copy(session_id, subscriber_id, crate::capture_store::next_indexed_name).await
}

/// Add a new source to an existing multi-source session.
/// Stops the current device, creates a new IOBroker with all sources (old + new),
/// swaps it into the session, and restarts. Keeps the same session ID and listeners.
pub async fn add_source_to_session(
    profiles: ProfileLoader,
    session_id: &str,
    new_source: SourceConfig,
) -> Result<IOCapabilities, String> {
    let mut session = lock_session(session_id).await?;

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

    let reader = IOBroker::new(profiles, session_id.to_string(), all_configs)?;
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
    profiles: ProfileLoader,
    session_id: &str,
    profile_id: &str,
) -> Result<IOCapabilities, String> {
    let mut session = lock_session(session_id).await?;

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

    let reader = IOBroker::new(profiles, session_id.to_string(), remaining_configs)?;
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
    let session = lock_session(session_id).await?;

    if polling {
        session.source.resume_source_polling(profile_id)?;
    } else {
        session.source.pause_source_polling(profile_id)?;
    }

    emit_session_lifecycle(SessionLifecyclePayload {
        session_id: session_id.to_string(),
        event_type: LifecycleEvent::Updated,
        source_type: Some(session.source.source_type().to_string()),
        state: None,
        subscriber_count: subscriber_count_for_session(session_id),
        source_profile_ids: sessions::get_session_profile_ids(session_id),
        creator_subscriber_id: None,
        reset: false,
    });
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
    let mut session = lock_session(session_id).await?;

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
    let mut session = lock_session(session_id).await?;

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
    // Session doesn't exist - that's fine, caller can create a new one
    let Ok(session) = lock_session(session_id).await else {
        return Ok(ReinitializeResult {
            success: true,
            reason: None,
            other_subscribers: vec![],
        });
    };

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

    tear_down(session_id, session, Teardown::Reinitialise).await;

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
    if !session_exists(session_id).await {
        return Err(not_found(session_id));
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
    fn every_session_state_keeps_its_name_and_code() {
        let cases = [
            (IOState::Stopped, "stopped", 0),
            (IOState::Starting, "starting", 1),
            (IOState::Running, "running", 2),
            (IOState::Paused, "paused", 3),
            (IOState::Error("boom".into()), "error", 4),
        ];
        for (state, name, code) in cases {
            assert_eq!(state.name(), name);
            assert_eq!(state.code(), code);
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
        assert!(crate::transmit::is_permanent_error(&refused));
    }

    #[test]
    fn a_destroyed_session_releases_its_profiles() {
        sessions::register_session_profile("f_destroyed", "slcan-destroyed");
        tauri::async_runtime::block_on(destroy_session("f_destroyed", false)).unwrap();
        assert!(crate::profile_tracker::can_use_profile("slcan-destroyed", "slcan", None).is_ok());
    }

    #[test]
    fn every_operation_on_a_missing_session_is_refused_as_not_found() {
        let id = "f_never_created";
        let not_found = "Session 'f_never_created' not found";
        tauri::async_runtime::block_on(async {
            assert_eq!(start_session(id).await.unwrap_err(), not_found);
            assert_eq!(stop_session(id).await.unwrap_err(), not_found);
            assert_eq!(suspend_session(id).await.unwrap_err(), not_found);
            assert_eq!(pause_session(id).await.unwrap_err(), not_found);
            assert_eq!(resume_session(id).await.unwrap_err(), not_found);
            assert_eq!(resume_session_fresh(id).await.unwrap_err(), not_found);
            assert_eq!(seek_session(id, 0).await.unwrap_err(), not_found);
            assert_eq!(update_session_speed(id, 1.0).await.unwrap_err(), not_found);
            assert_eq!(reconfigure_session(id, None, None).await.unwrap_err(), not_found);
            assert_eq!(transmit_serial(id, &[0]).await.unwrap_err(), not_found);
            assert!(super::super::get_session_state(id).await.is_none());
            assert!(reinitialize_session_if_safe(id, "w_app").await.unwrap().success);
        });
    }

    use super::super::test_source::{Gate, TestSource};
    use std::time::Duration;

    async fn open(session_id: &str, source: TestSource) -> CreateSessionResult {
        let subscriber = Some(format!("{session_id}-app"));
        create_session(session_id.into(), Box::new(source), subscriber, None, None, vec![]).await
    }

    async fn stalls<F: std::future::Future>(operation: F) -> bool {
        tokio::time::timeout(Duration::from_millis(100), operation).await.is_err()
    }

    #[tokio::test]
    async fn a_destroyed_session_leaves_nothing_behind() {
        let id = "f_destroy_clears";
        open(id, TestSource::new(id)).await;
        sessions::register_session_profile(id, "p-destroy-clears");
        store_startup_error(id, "boom".into());
        let position = PlaybackPosition { timestamp_us: 1, frame_index: 1, frame_count: None };
        store_playback_position(id, position);
        with_state(id, |s| s.suspended_at = Some(Instant::now()));
        CLOSING_SESSIONS.write().unwrap().insert(id.into());

        destroy_session(id, false).await.unwrap();

        assert!(!session_states().contains_key(id));
        assert_eq!(current_session_of_app(&format!("{id}-app")), None);
        assert!(sessions::get_session_profile_ids(id).is_empty());
        assert!(!CLOSING_SESSIONS.read().unwrap().contains(id));

        open(id, TestSource::new(id)).await;
        assert_eq!(get_startup_error(id), None);
        assert!(get_playback_position(id).is_none());
        assert_eq!(with_state(id, |s| s.suspended_at.is_some()), Some(false));
        destroy_session(id, false).await.unwrap();
    }

    #[tokio::test]
    async fn a_slow_session_does_not_hold_up_another() {
        let gate = Arc::new(Gate::default());
        open("f_slow", TestSource::new("f_slow").slow_start(&gate)).await;
        open("f_quick", TestSource::new("f_quick")).await;

        let slow_start = tokio::spawn(start_session("f_slow"));
        gate.entered().await;

        let quick = tokio::time::timeout(Duration::from_secs(1), start_session("f_quick")).await;
        assert_eq!(quick.expect("the quick session waited on the slow one"), Ok(IOState::Running));
        assert!(stalls(stop_session("f_slow")).await, "one session's operations run one at a time");

        gate.release();
        assert_eq!(slow_start.await.unwrap(), Ok(IOState::Running));
        destroy_session("f_slow", false).await.unwrap();
        destroy_session("f_quick", false).await.unwrap();
    }

    #[tokio::test]
    async fn a_same_id_create_waits_out_the_teardown() {
        let id = "f_recreated";
        let gate = Arc::new(Gate::default());
        open(id, TestSource::new(id).slow_stop(&gate)).await;
        let teardown = tokio::spawn(destroy_session(id, false));
        gate.entered().await;

        let mut recreate = tokio::spawn(async move { open(id, TestSource::new(id)).await });
        assert!(stalls(&mut recreate).await, "the create joined a session being torn down");

        gate.release();
        teardown.await.unwrap().unwrap();
        assert!(recreate.await.unwrap().is_new);
        assert!(session_states().contains_key(id));
        destroy_session(id, false).await.unwrap();
    }

    fn device(id: &str, kind: &str, connection: serde_json::Value) -> crate::settings::IOProfile {
        crate::settings::IOProfile {
            id: id.into(),
            name: id.into(),
            kind: kind.into(),
            connection: serde_json::from_value(connection).unwrap(),
            preferred_catalog: None,
            ephemeral: true,
        }
    }

    fn missing_port(id: &str) -> crate::settings::IOProfile {
        device(id, "serial", serde_json::json!({ "port": "/dev/wiretap-no-such-port" }))
    }

    async fn open_broker(session_id: &str, devices: Vec<crate::settings::IOProfile>, profiles: ProfileLoader) {
        crate::capture_db::use_in_memory_database();
        let configs = devices
            .iter()
            .map(|p| SourceConfig {
                profile_id: p.id.clone(),
                profile_kind: p.kind.clone(),
                display_name: p.name.clone(),
                bus_mappings: sessions::profile_bus_mappings(p),
                ..Default::default()
            })
            .collect();
        let broker = IOBroker::new(profiles, session_id.into(), configs).unwrap();
        create_session(session_id.into(), Box::new(broker), None, None, None, vec![]).await;
    }

    async fn open_saved(session_id: &str, devices: Vec<crate::settings::IOProfile>) {
        let saved = devices.clone();
        open_broker(session_id, devices, Arc::new(move || Ok(saved.clone()))).await;
    }

    #[tokio::test]
    async fn a_source_refused_at_open_fails_the_start() {
        let id = "f_refused_at_open";
        open_saved(id, vec![missing_port("p-missing-port")]).await;

        let refused = start_session(id).await.unwrap_err();
        assert!(refused.contains("/dev/wiretap-no-such-port"), "{refused}");
        assert_eq!(super::super::get_session_state(id).await, Some(IOState::Error(refused)));
        destroy_session(id, false).await.unwrap();
    }

    #[tokio::test]
    async fn unreadable_profiles_fail_the_start() {
        let id = "f_unreadable_profiles";
        let unreadable: ProfileLoader = Arc::new(|| Err("settings.json is corrupt".into()));
        open_broker(id, vec![missing_port("p-unreadable")], unreadable).await;

        assert_eq!(start_session(id).await.unwrap_err(), "settings.json is corrupt");
        destroy_session(id, false).await.unwrap();
    }

    #[tokio::test]
    async fn one_source_refused_does_not_fail_a_start_another_source_made() {
        let id = "f_one_of_two_refused";
        let generator = device("p-serial-generator", "virtual", serde_json::json!({ "traffic_type": "serial" }));
        open_saved(id, vec![missing_port("p-one-missing-port"), generator]).await;

        assert_eq!(start_session(id).await, Ok(IOState::Running));
        destroy_session(id, false).await.unwrap();
    }

    #[test]
    fn a_missing_session_keeps_no_per_session_state() {
        let id = "f_never_created_state";
        store_startup_error(id, "boom".into());
        store_playback_position(id, PlaybackPosition { timestamp_us: 1, frame_index: 1, frame_count: None });
        assert_eq!(get_startup_error(id), None);
        assert_eq!(get_playback_position(id).map(|p| p.frame_index), None);
    }
}
