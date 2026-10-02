use std::collections::{HashMap, HashSet};

use once_cell::sync::Lazy;
use serde::Serialize;

use super::session::{
    each_session, lock_session, resume_reattached, session_capture, session_mode, session_states, source_kind,
    teardown_session_if_empty, IOSession, SessionMode, SessionSourceKind,
};
use super::{broker, IOCapabilities, IOState, SourceConfig};
use crate::{capture_store, sessions};

// ============================================================================
// Open-app registry (cross-window roster of session-aware app instances)
// ============================================================================
//
// Single source of truth for every open session-aware app instance across all
// windows. `session_id` is the instance's current session attachment (None =
// panel open but not watching). Because it is a single Option, the
// one-subscriber-one-session invariant holds by construction. The per-session
// subscriber view used by the UI is derived from this registry — see
// `subscribers_for_session` / `subscriber_count_for_session`.
//
// Lock discipline: APP_REGISTRY is a std Mutex held only for tiny critical
// sections. NEVER hold it across an await or while taking a session. Mutating functions
// take the registry lock, mutate, drop the guard, THEN emit the roster broadcast
// (which re-locks the registry) and run any async session teardown.

/// A single open session-aware app instance, tracked globally across windows.
#[derive(Clone, Debug)]
pub struct AppInstance {
    /// Unique instance id == the session subscriber_id (e.g. "main-1_decoder").
    pub instance_id: String,
    /// Cosmetic per-instance display id (e.g. "decoder_a3f9"). Generated once by the
    /// frontend on first registration; preserved across re-registers.
    pub display_id: String,
    /// Human-readable app name (e.g. "decoder").
    pub app_name: String,
    /// Label of the window that owns this instance (for window-close pruning).
    pub window_label: String,
    /// Current session attachment. None = panel open but not watching a session.
    pub session_id: Option<String>,
    /// When this instance first registered.
    pub registered_at: std::time::Instant,
    /// Last heartbeat. Window-close pruning is the primary cleanup; this is a backstop.
    pub last_heartbeat: std::time::Instant,
    /// Whether actively receiving frames (false when detached / paused).
    pub is_active: bool,
    /// The session the watchdog detached this instance from for a missed heartbeat;
    /// the next WS heartbeat for that session re-attaches it.
    pub parked_on: Option<String>,
}

/// Serializable snapshot of an app instance for the frontend roster.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AppInstanceInfo {
    pub instance_id: String,
    pub display_id: String,
    pub app_name: String,
    pub window_label: String,
    pub session_id: Option<String>,
    pub registered_seconds_ago: u64,
    pub is_active: bool,
}

/// Global registry of open app instances, keyed by instance_id.
pub(super) static APP_REGISTRY: Lazy<std::sync::Mutex<HashMap<String, AppInstance>>> =
    Lazy::new(|| std::sync::Mutex::new(HashMap::new()));

/// Snapshot the full open-app roster (drives the frontend reconcile query).
pub fn list_open_apps() -> Vec<AppInstanceInfo> {
    let now = std::time::Instant::now();
    let Ok(reg) = APP_REGISTRY.lock() else { return Vec::new() };
    reg.values()
        .map(|a| AppInstanceInfo {
            instance_id: a.instance_id.clone(),
            display_id: a.display_id.clone(),
            app_name: a.app_name.clone(),
            window_label: a.window_label.clone(),
            session_id: a.session_id.clone(),
            registered_seconds_ago: now.duration_since(a.registered_at).as_secs(),
            is_active: a.is_active,
        })
        .collect()
}

/// Subscribers (derived) attached to `session_id`, shaped for the UI.
pub fn subscribers_for_session(session_id: &str) -> Vec<SubscriberInfo> {
    let now = std::time::Instant::now();
    let Ok(reg) = APP_REGISTRY.lock() else { return Vec::new() };
    reg.values()
        .filter(|a| a.session_id.as_deref() == Some(session_id))
        .map(|a| SubscriberInfo {
            subscriber_id: a.instance_id.clone(),
            app_name: a.app_name.clone(),
            registered_seconds_ago: now.duration_since(a.registered_at).as_secs(),
            is_active: a.is_active,
        })
        .collect()
}

/// Count of app instances attached to `session_id`.
pub fn subscriber_count_for_session(session_id: &str) -> usize {
    let Ok(reg) = APP_REGISTRY.lock() else { return 0 };
    reg.values()
        .filter(|a| a.session_id.as_deref() == Some(session_id))
        .count()
}

/// instance_ids attached to `session_id`, excluding `except`.
pub fn other_instances_on_session(session_id: &str, except: &str) -> Vec<String> {
    let Ok(reg) = APP_REGISTRY.lock() else { return Vec::new() };
    reg.values()
        .filter(|a| a.session_id.as_deref() == Some(session_id) && a.instance_id != except)
        .map(|a| a.instance_id.clone())
        .collect()
}

/// The session an app instance is currently attached to (None if unattached/unknown).
pub fn current_session_of_app(instance_id: &str) -> Option<String> {
    let reg = APP_REGISTRY.lock().ok()?;
    reg.get(instance_id).and_then(|a| a.session_id.clone())
}

/// Register an open app instance (panel mount). Idempotent: if it already exists,
/// refresh app_name/window_label/heartbeat but preserve its session attachment and
/// its display_id (the first one wins, so re-registers don't churn the label).
pub fn register_app(instance_id: &str, display_id: &str, app_name: &str, window_label: &str) {
    {
        let Ok(mut reg) = APP_REGISTRY.lock() else { return };
        let now = std::time::Instant::now();
        reg.entry(instance_id.to_string())
            .and_modify(|a| {
                a.app_name = app_name.to_string();
                a.window_label = window_label.to_string();
                a.last_heartbeat = now;
            })
            .or_insert_with(|| AppInstance {
                instance_id: instance_id.to_string(),
                display_id: display_id.to_string(),
                app_name: app_name.to_string(),
                window_label: window_label.to_string(),
                session_id: None,
                registered_at: now,
                last_heartbeat: now,
                is_active: false,
                parked_on: None,
            });
    }
    emit_open_apps_changed();
}

/// Mark an app instance as attached to `session_id` (a subscriber registered on a
/// session). Inserts a placeholder if the instance is unknown — e.g. the
/// mount-register hasn't run yet, or an MCP/agent registers a subscriber directly.
pub fn attach_app(instance_id: &str, app_name: &str, session_id: &str) {
    {
        let Ok(mut reg) = APP_REGISTRY.lock() else { return };
        let now = std::time::Instant::now();
        reg.entry(instance_id.to_string())
            .and_modify(|a| {
                a.session_id = Some(session_id.to_string());
                a.is_active = true;
                a.last_heartbeat = now;
                a.parked_on = None;
                if a.app_name.is_empty() {
                    a.app_name = app_name.to_string();
                }
            })
            .or_insert_with(|| AppInstance {
                instance_id: instance_id.to_string(),
                // Fallback when a subscriber attaches without a prior register_app
                // (e.g. an MCP/agent path or a non-session-aware app).
                display_id: instance_id.to_string(),
                app_name: app_name.to_string(),
                window_label: "unknown".to_string(),
                session_id: Some(session_id.to_string()),
                registered_at: now,
                last_heartbeat: now,
                is_active: true,
                parked_on: None,
            });
    }
    emit_open_apps_changed();
}

/// Apply `f` to the instance if present, then broadcast the roster. No-op if unknown.
fn update_app(instance_id: &str, f: impl FnOnce(&mut AppInstance)) {
    {
        let Ok(mut reg) = APP_REGISTRY.lock() else { return };
        match reg.get_mut(instance_id) {
            Some(a) => f(a),
            None => return,
        }
    }
    emit_open_apps_changed();
}

/// Clear an app instance's session attachment (a subscriber left a session). Keeps
/// the instance — the panel may still be open. No-op (no broadcast) if unknown.
pub fn detach_app(instance_id: &str) {
    update_app(instance_id, |a| {
        a.session_id = None;
        a.is_active = false;
        a.parked_on = None;
    });
}

/// Forget that the watchdog parked `instance_id` on `session_id`: it left on purpose.
pub(super) fn unpark_app(instance_id: &str, session_id: &str) {
    let Ok(mut reg) = APP_REGISTRY.lock() else { return };
    if let Some(a) = reg.get_mut(instance_id).filter(|a| a.parked_on.as_deref() == Some(session_id)) {
        a.parked_on = None;
    }
}

/// Clear the session attachment of every instance on `session_id`, keeping the
/// instances themselves (their panels are still open). Every teardown path calls
/// this so the registry invariant holds: no entry may reference a session that is
/// no longer in `IO_SESSIONS`. A stale attachment is not cosmetic — it makes
/// `subscriber_count_for_session` report a phantom count, and it becomes the
/// `prev_session_id` that `register_subscriber_from` then evicts and tears down again.
pub(super) fn detach_all_from_session(session_id: &str) {
    let detached = {
        let Ok(mut reg) = APP_REGISTRY.lock() else { return };
        let mut n = 0usize;
        for a in reg.values_mut() {
            if a.parked_on.as_deref() == Some(session_id) {
                a.parked_on = None;
            }
            if a.session_id.as_deref() == Some(session_id) {
                a.session_id = None;
                a.is_active = false;
                n += 1;
            }
        }
        n
    };
    // Log and broadcast outside the lock — `tlog!` writes to stderr and an unbuffered
    // file, and `APP_REGISTRY` is taken inside `register_subscriber_from`'s session lock,
    // so blocking here would extend it.
    if detached == 0 {
        return;
    }
    tlog!("[reader] Session '{}' detached {} stale subscriber(s)", session_id, detached);
    emit_open_apps_changed();
}

/// Set an app instance's active flag (frames flowing or not). No-op if unknown.
pub fn set_app_active(instance_id: &str, is_active: bool) {
    update_app(instance_id, |a| a.is_active = is_active);
}

/// Remove an app instance entirely (panel unmount). If it was attached and its
/// session is now empty, tear that session down (same cascade as the last
/// subscriber leaving). This is robust to the unmount firing `unregister_app`
/// before `unregister_subscriber` (the two run unordered).
pub async fn unregister_app(instance_id: &str) {
    let removed = {
        let Ok(mut reg) = APP_REGISTRY.lock() else { return };
        reg.remove(instance_id)
    };
    let Some(inst) = removed else { return };
    emit_open_apps_changed();
    if let Some(sid) = inst.session_id {
        teardown_session_if_empty(&sid, false, None).await;
    }
}

/// Remove all app instances owned by `window_label` (window closed) and tear down
/// any session left with no subscribers. Reuses the last-subscriber-leaves cascade.
pub async fn prune_window_sessions(window_label: &str) {
    let removed: Vec<AppInstance> = {
        let Ok(mut reg) = APP_REGISTRY.lock() else { return };
        let ids: Vec<String> = reg
            .values()
            .filter(|a| a.window_label == window_label)
            .map(|a| a.instance_id.clone())
            .collect();
        ids.iter().filter_map(|id| reg.remove(id)).collect()
    };
    if removed.is_empty() {
        return;
    }
    emit_open_apps_changed();

    // Tear down each distinct session whose subscribers were removed, if now empty.
    let mut seen: Vec<String> = Vec::new();
    for sid in removed.into_iter().filter_map(|a| a.session_id) {
        if !seen.contains(&sid) {
            seen.push(sid.clone());
            teardown_session_if_empty(&sid, false, None).await;
        }
    }
}

/// Broadcast the full open-app roster to every window (Tauri emit + WS channel-0),
/// mirroring `emit_session_lifecycle`. MUST be called WITHOUT holding APP_REGISTRY.
pub fn emit_open_apps_changed() {
    let roster = list_open_apps();
    super::emit_to_windows("open-apps-changed", &roster);
    crate::ws::dispatch::send_open_apps_changed(&roster);
}

/// Get the state of a reader session (None if session doesn't exist)
pub async fn get_session_state(session_id: &str) -> Option<IOState> {
    lock_session(session_id).await.ok().map(|s| s.source.state())
}

/// Get the capabilities of a session (None if session doesn't exist)
pub async fn get_session_capabilities(session_id: &str) -> Option<IOCapabilities> {
    lock_session(session_id).await.ok().map(|s| s.source.capabilities())
}

/// Get the joiner count for a session (0 if session doesn't exist). Derived from
/// the open-app registry (the count of attached app instances).
pub async fn get_session_joiner_count(session_id: &str) -> usize {
    if session_exists(session_id).await {
        subscriber_count_for_session(session_id)
    } else {
        0
    }
}

/// The first output bus no source of this session has claimed, disabled buses included.
pub async fn get_session_next_output_bus(session_id: &str) -> u8 {
    lock_session(session_id)
        .await
        .ok()
        .and_then(|s| s.source.broker_configs())
        .into_iter()
        .flatten()
        .flat_map(|c| c.bus_mappings)
        .map(|m| m.output_bus.saturating_add(1))
        .max()
        .unwrap_or(0)
}

/// Get the stored source configs for a session (used for resume-to-live).
/// Returns empty vec if session doesn't exist or has no stored configs.
pub async fn get_session_source_configs(session_id: &str) -> Vec<SourceConfig> {
    lock_session(session_id)
        .await
        .map(|s| s.source_configs.clone())
        .unwrap_or_default()
}

/// Touch `last_heartbeat` for all app instances attached to the given sessions,
/// re-attaching any the watchdog parked there and resuming their sessions.
/// Called by the WS server when a client heartbeat arrives, bridging the WS
/// keepalive to the IO session watchdog, so a webview waking from display sleep
/// needs no call of its own to get its sessions back.
pub async fn touch_subscriber_heartbeats(session_ids: &[String]) {
    let reattached: HashSet<String> = {
        let Ok(mut reg) = APP_REGISTRY.lock() else { return };
        let now = std::time::Instant::now();
        let named = |sid: &Option<String>| sid.as_ref().is_some_and(|sid| session_ids.contains(sid));
        let mut reattached = HashSet::new();
        for inst in reg.values_mut() {
            if inst.session_id.is_none() && named(&inst.parked_on) {
                inst.session_id = inst.parked_on.take();
                inst.is_active = true;
                reattached.extend(inst.session_id.clone());
            }
            if named(&inst.session_id) {
                inst.last_heartbeat = now;
            }
        }
        reattached
    };
    if reattached.is_empty() {
        return;
    }
    emit_open_apps_changed();
    for session_id in reattached {
        resume_reattached(&session_id).await;
    }
}

pub async fn session_ids() -> HashSet<String> {
    session_states().keys().cloned().collect()
}

/// Check if a session exists
pub async fn session_exists(session_id: &str) -> bool {
    session_states().contains_key(session_id)
}

/// Info about an active session (for listing)
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ActiveSessionInfo {
    /// Session ID
    pub session_id: String,
    /// Device type (e.g., "gvret_tcp", "realtime")
    pub source_type: String,
    /// Current state
    pub state: IOState,
    /// Session capabilities
    pub capabilities: IOCapabilities,
    /// Number of subscribers
    pub subscriber_count: usize,
    /// Individual subscriber details
    pub subscribers: Vec<SubscriberInfo>,
    /// For multi-source sessions: the source configurations
    pub broker_configs: Option<Vec<broker::SourceConfig>>,
    /// Profile IDs feeding this session (from the session profile registry)
    #[serde(default)]
    pub source_profile_ids: Vec<String>,
    /// Profiles the session was opened from; differs from `source_profile_ids`
    /// only while a stopped source is replaying its capture
    #[serde(default)]
    pub origin_profile_ids: Vec<String>,
    pub source_kind: SessionSourceKind,
    pub mode: SessionMode,
    /// The session's own capture, or else the one it was opened on
    #[serde(default)]
    pub capture_id: Option<String>,
    /// Kind of the capture named by `capture_id`
    #[serde(default)]
    pub capture_kind: Option<capture_store::CaptureKind>,
    /// Frame count in the owned capture
    #[serde(default)]
    pub capture_frame_count: Option<usize>,
    /// Distinct (bus, frame_id) count in the owned capture (live streaming only)
    #[serde(default)]
    pub capture_unique_frame_count: Option<usize>,
    /// Whether the session is actively streaming data
    #[serde(default)]
    pub is_streaming: bool,
    /// Source file path of the catalogue attached for live decode (None when no
    /// decoder is bound). Authoritative — the frontend mirrors this one-way.
    #[serde(default)]
    pub catalog_path: Option<String>,
    /// Profile IDs within this session whose polling is paused. Authoritative,
    /// like `catalog_path`: the poll switch reads it rather than remembering
    /// what it last asked for.
    #[serde(default)]
    pub paused_source_profile_ids: Vec<String>,
}

/// List all active sessions
pub async fn list_sessions() -> Vec<ActiveSessionInfo> {
    each_session(describe_session).await
}

/// One session's listing, or `None` when there is no such session.
pub async fn session_info(session_id: &str) -> Option<ActiveSessionInfo> {
    lock_session(session_id)
        .await
        .ok()
        .map(|session| describe_session(session_id, &session))
}

fn describe_session(session_id: &str, session: &IOSession) -> ActiveSessionInfo {
    // Get source profile IDs from the session tracking
    let source_profile_ids = sessions::get_session_profile_ids(session_id);

    // Kind travels with the id — picking an arbitrary owned capture and leaving the
    // roster to assume "frames" is how the two came apart. The counts are the session's
    // own capture's, which is the one it streams.
    let owned = capture_store::get_session_capture(session_id).map(|(id, _)| id);
    let capture_frame_count = owned.as_deref().map(capture_store::get_capture_count);
    let capture_unique_frame_count = owned.as_deref().map(capture_store::get_capture_unique_count);
    let (capture_id, capture_kind) = session_capture(session_id).unzip();

    // Check if session is actively streaming (running state)
    let is_streaming = matches!(session.source.state(), IOState::Running);

    // Build individual subscriber details (derived from the open-app registry)
    let subscribers = subscribers_for_session(session_id);

    ActiveSessionInfo {
        session_id: session_id.to_string(),
        source_type: session.source.source_type().to_string(),
        state: session.source.state(),
        capabilities: session.source.capabilities(),
        subscriber_count: subscribers.len(),
        subscribers,
        broker_configs: session.source.broker_configs(),
        source_profile_ids,
        origin_profile_ids: sessions::get_session_origin_profile_ids(session_id),
        source_kind: source_kind(session_id),
        mode: session_mode(session_id, session),
        capture_id,
        capture_kind,
        capture_frame_count,
        capture_unique_frame_count,
        is_streaming,
        catalog_path: crate::ws::dispatch::attached_catalog_path(session_id),
        paused_source_profile_ids: session.source.paused_source_profile_ids(),
    }
}

/// Info about a registered subscriber (for TypeScript)
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SubscriberInfo {
    pub subscriber_id: String,
    /// Human-readable app name (e.g., "discovery", "decoder")
    pub app_name: String,
    /// Seconds since registration
    pub registered_seconds_ago: u64,
    /// Whether this subscriber is actively receiving frames
    pub is_active: bool,
}

/// Get all listeners for a session.
/// Useful for debugging and for the frontend to understand session state.
pub async fn get_session_subscribers(session_id: &str) -> Result<Vec<SubscriberInfo>, String> {
    if !session_exists(session_id).await {
        return Err(format!("Session '{}' not found", session_id));
    }
    Ok(subscribers_for_session(session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registry invariant: after a session is torn down nothing may still claim
    /// it, but the instances themselves survive — their panels are still open, they
    /// just become unconnected app nodes.
    #[test]
    fn detach_all_from_session_clears_attachments_but_keeps_instances() {
        let session = "test_detach_all";
        register_app("w_decoder_detach", "decoder_ab12", "decoder", "main");
        attach_app("w_decoder_detach", "decoder", session);
        attach_app("w_discovery_detach", "discovery", session);
        assert_eq!(subscriber_count_for_session(session), 2);

        detach_all_from_session(session);

        assert_eq!(subscriber_count_for_session(session), 0);
        assert_eq!(current_session_of_app("w_discovery_detach"), None);

        let reg = APP_REGISTRY.lock().unwrap();
        let entry = reg.get("w_decoder_detach").expect("instance should survive");
        assert_eq!(entry.session_id, None);
        assert!(!entry.is_active);
        assert_eq!(entry.display_id, "decoder_ab12");
    }

    /// Detaching one session must not disturb another — the sweep is filtered by
    /// `session_id`, not a blanket clear.
    #[test]
    fn detach_all_from_session_leaves_other_sessions_alone() {
        attach_app("w_decoder_scoped", "decoder", "test_scoped_a");
        attach_app("w_discovery_scoped", "discovery", "test_scoped_b");

        detach_all_from_session("test_scoped_a");

        assert_eq!(current_session_of_app("w_decoder_scoped"), None);
        assert_eq!(
            current_session_of_app("w_discovery_scoped").as_deref(),
            Some("test_scoped_b")
        );
    }
}
