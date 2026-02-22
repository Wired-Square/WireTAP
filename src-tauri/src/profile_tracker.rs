// ui/src-tauri/src/profile_tracker.rs
//
// Profile usage tracker for IO sessions.
// Tracks which sessions are using which profiles to prevent conflicts
// on single-handle devices (slcan, serial).
//
// Multi-handle devices (GVRET, PostgreSQL, etc.) can be used by multiple
// sessions simultaneously - each session opens its own connection.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// Information about active profile usage
#[derive(Clone, Debug, Serialize)]
pub struct ProfileUsage {
    /// IDs of sessions using this profile (can be multiple for multi-handle devices)
    pub session_ids: Vec<String>,
}

/// Map of profile_id -> set of session IDs using it
static PROFILE_USAGE: Lazy<Mutex<HashMap<String, HashSet<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Register a profile as being used by a session.
/// For multi-handle devices, multiple sessions can use the same profile.
pub fn register_usage(profile_id: &str, session_id: &str) {
    if let Ok(mut map) = PROFILE_USAGE.lock() {
        let sessions = map.entry(profile_id.to_string()).or_insert_with(HashSet::new);
        let is_new = sessions.insert(session_id.to_string());
        if is_new {
            tlog!(
                "[profile_tracker] Registered usage for profile '{}' by session '{}' (total: {})",
                profile_id, session_id, sessions.len()
            );
        }
    }
}

/// Unregister a specific session's usage of a profile.
/// Only removes the profile entry entirely when no sessions are using it.
pub fn unregister_usage_by_session(profile_id: &str, session_id: &str) {
    if let Ok(mut map) = PROFILE_USAGE.lock() {
        if let Some(sessions) = map.get_mut(profile_id) {
            if sessions.remove(session_id) {
                tlog!(
                    "[profile_tracker] Unregistered session '{}' from profile '{}' (remaining: {})",
                    session_id, profile_id, sessions.len()
                );
                // Remove the profile entry entirely if no sessions remain
                if sessions.is_empty() {
                    map.remove(profile_id);
                    tlog!(
                        "[profile_tracker] Profile '{}' has no more sessions, removed from tracker",
                        profile_id
                    );
                }
            }
        }
    }
}

/// Unregister profile usage when a session ends (legacy API).
/// This removes the first session found using this profile.
/// Prefer unregister_usage_by_session for explicit session removal.
#[allow(dead_code)]
pub fn unregister_usage(profile_id: &str) {
    if let Ok(mut map) = PROFILE_USAGE.lock() {
        if let Some(sessions) = map.get_mut(profile_id) {
            // Remove one session (for backwards compatibility)
            if let Some(session_id) = sessions.iter().next().cloned() {
                sessions.remove(&session_id);
                tlog!(
                    "[profile_tracker] Unregistered session '{}' from profile '{}' (remaining: {})",
                    session_id, profile_id, sessions.len()
                );
                if sessions.is_empty() {
                    map.remove(profile_id);
                    tlog!(
                        "[profile_tracker] Profile '{}' has no more sessions, removed from tracker",
                        profile_id
                    );
                }
            }
        }
    }
}

/// Check if a profile is in use, and by what sessions
pub fn get_usage(profile_id: &str) -> Option<ProfileUsage> {
    let map = PROFILE_USAGE.lock().ok()?;
    map.get(profile_id).map(|sessions| ProfileUsage {
        session_ids: sessions.iter().cloned().collect(),
    })
}

/// Profile kinds that require exclusive (single-handle) access
const SINGLE_HANDLE_KINDS: &[&str] = &["slcan", "serial"];

/// Check if a profile can be used (not already in use by another session)
///
/// For single-handle devices (slcan, serial), only one session is allowed.
/// For multi-handle devices (gvret_tcp, postgres, etc.), multiple sessions are OK.
///
/// Returns Ok(()) if the profile can be used, or an error message if it's in use.
pub fn can_use_profile(profile_id: &str, profile_kind: &str) -> Result<(), String> {
    // Multi-handle profiles can always be used by multiple sessions
    if !SINGLE_HANDLE_KINDS.contains(&profile_kind) {
        return Ok(());
    }

    // Check if this single-handle profile is already in use
    if let Some(usage) = get_usage(profile_id) {
        if !usage.session_ids.is_empty() {
            return Err(format!(
                "Profile is in use by session '{}'. Stop that session first.",
                usage.session_ids.join(", ")
            ));
        }
    }
    Ok(())
}

/// Check if a profile kind requires single-handle access
#[allow(dead_code)]
pub fn is_single_handle_kind(profile_kind: &str) -> bool {
    SINGLE_HANDLE_KINDS.contains(&profile_kind)
}
