use crate::profile_tracker;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

use super::commands::DeviceProbeResult;

/// Map of session_id -> profile_ids for tracking which profiles each reader session uses.
/// Multi-source sessions can use multiple profiles, so we store a Vec.
/// Used to unregister profile usage when a session is destroyed.
pub(super) static SESSION_PROFILES: Lazy<Mutex<HashMap<String, Vec<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Profiles a session was opened from, kept while a stopped source is swapped
/// for its capture so the frontend can still name the source and return to live.
static SESSION_ORIGIN_PROFILES: Lazy<Mutex<HashMap<String, Vec<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Map of profile_id -> session_ids for tracking which sessions use each profile.
/// This is the reverse of SESSION_PROFILES and is used to:
/// 1. Show "(in use: sessionId)" indicator in IO picker
/// 2. Lock reconfiguration when profile is in 2+ sessions
/// 3. Prevent parallel sessions from exclusive-access devices
pub(super) static PROFILE_SESSIONS: Lazy<Mutex<HashMap<String, std::collections::HashSet<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Cache of successful probe results by profile_id.
/// When a device is probed successfully, the result is cached so subsequent probes
/// (e.g., when the device is already running) return instantly without reconnecting.
static PROBE_CACHE: Lazy<Mutex<HashMap<String, DeviceProbeResult>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Cache a successful probe result for a profile
pub(super) fn cache_probe_result(profile_id: &str, result: &DeviceProbeResult) {
    if result.success {
        if let Ok(mut cache) = PROBE_CACHE.lock() {
            cache.insert(profile_id.to_string(), result.clone());
        }
    }
}

/// Get a cached probe result for a profile
pub(super) fn get_cached_probe(profile_id: &str) -> Option<DeviceProbeResult> {
    PROBE_CACHE.lock().ok()?.get(profile_id).cloned()
}

/// Clear the cached probe result for a profile (called when device errors or disconnects)
pub fn clear_probe_cache(profile_id: &str) {
    if let Ok(mut cache) = PROBE_CACHE.lock() {
        cache.remove(profile_id);
    }
}

/// Track that a session is using a specific profile.
/// For multi-source sessions, call this multiple times or use register_session_profiles.
pub(super) fn register_session_profile(session_id: &str, profile_id: &str) {
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
pub(super) fn register_session_profiles(session_id: &str, profile_ids: &[String]) {
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
pub(super) fn take_session_profiles(session_id: &str) -> Vec<String> {
    let profile_ids = SESSION_PROFILES
        .lock()
        .ok()
        .and_then(|mut map| map.remove(session_id))
        .unwrap_or_default();
    forget_origin_profiles(session_id);

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

/// Swap a stopped source's profiles for its capture, remembering them as the origin.
pub fn swap_session_profiles_for_capture(session_id: &str, capture_id: &str) {
    let current = get_session_profile_ids(session_id);
    if let Ok(mut map) = SESSION_ORIGIN_PROFILES.lock() {
        map.entry(session_id.to_string()).or_insert(current);
    }
    replace_session_profiles(session_id, &[capture_id.to_string()]);
}

/// Put a resumed source's profiles back in place of its capture.
pub(super) fn restore_session_profiles(session_id: &str, profile_ids: &[String]) {
    replace_session_profiles(session_id, profile_ids);
    forget_origin_profiles(session_id);
}

fn forget_origin_profiles(session_id: &str) {
    if let Ok(mut map) = SESSION_ORIGIN_PROFILES.lock() {
        map.remove(session_id);
    }
}

/// The profiles a session was opened from — its current profiles unless a
/// stopped source has been swapped for its capture.
pub fn get_session_origin_profile_ids(session_id: &str) -> Vec<String> {
    SESSION_ORIGIN_PROFILES
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).cloned())
        .unwrap_or_else(|| get_session_profile_ids(session_id))
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

#[cfg(test)]
mod origin_profile_tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_origin_survives_the_capture_swap_until_the_source_resumes() {
        register_session_profiles("s_origin", &ids(&["io_dev"]));
        swap_session_profiles_for_capture("s_origin", "cap1");
        assert_eq!(get_session_profile_ids("s_origin"), ids(&["cap1"]));
        assert_eq!(get_session_origin_profile_ids("s_origin"), ids(&["io_dev"]));

        restore_session_profiles("s_origin", &ids(&["io_dev"]));
        swap_session_profiles_for_capture("s_origin", "cap2");
        assert_eq!(get_session_origin_profile_ids("s_origin"), ids(&["io_dev"]));
    }

    #[test]
    fn a_destroyed_session_forgets_its_origin() {
        register_session_profiles("s_gone", &ids(&["io_dev"]));
        swap_session_profiles_for_capture("s_gone", "cap1");
        take_session_profiles("s_gone");
        assert!(get_session_origin_profile_ids("s_gone").is_empty());
    }
}
