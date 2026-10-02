use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};

use super::commands::DeviceProbeResult;

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

/// Which profiles each session holds, and the reverse. A single-handle device
/// (slcan, serial, gs_usb) admits a second session only once its holder is released.
#[derive(Default)]
struct ProfileRegistry {
    by_session: HashMap<String, Vec<String>>,
    by_profile: HashMap<String, HashSet<String>>,
    /// The profiles a session was opened from, kept while a stopped source is
    /// swapped for its capture so the frontend can still name it and return to live.
    origins: HashMap<String, Vec<String>>,
}

impl ProfileRegistry {
    fn add(&mut self, session_id: &str, profile_id: &str) -> bool {
        let profiles = self.by_session.entry(session_id.to_string()).or_default();
        let added = !profiles.iter().any(|p| p == profile_id);
        if added {
            profiles.push(profile_id.to_string());
        }
        self.by_profile.entry(profile_id.to_string()).or_default().insert(session_id.to_string());
        added
    }

    fn remove(&mut self, session_id: &str, profile_id: &str) {
        if let Some(profiles) = self.by_session.get_mut(session_id) {
            profiles.retain(|p| p != profile_id);
        }
        if let Some(sessions) = self.by_profile.get_mut(profile_id) {
            sessions.remove(session_id);
            if sessions.is_empty() {
                self.by_profile.remove(profile_id);
            }
        }
    }

    fn take(&mut self, session_id: &str) -> Vec<String> {
        let profile_ids = self.by_session.remove(session_id).unwrap_or_default();
        for profile_id in &profile_ids {
            self.remove(session_id, profile_id);
        }
        profile_ids
    }

    fn set(&mut self, session_id: &str, profile_ids: &[String]) {
        self.take(session_id);
        for profile_id in profile_ids {
            self.add(session_id, profile_id);
        }
    }
}

static PROFILE_REGISTRY: Lazy<Mutex<ProfileRegistry>> = Lazy::new(Mutex::default);

fn registry() -> MutexGuard<'static, ProfileRegistry> {
    PROFILE_REGISTRY.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn register_session_profile(session_id: &str, profile_id: &str) {
    registry().add(session_id, profile_id);
}

/// Register `profile_id` for a session about to be created, once a teardown in
/// flight on the same id has released what the old session held.
pub(super) async fn claim_session_profile(session_id: &str, profile_id: &str) {
    crate::io::settle_session(session_id).await;
    register_session_profile(session_id, profile_id);
}

/// Hold `profile_id` for `session_id` while `open` runs, so a second opener is
/// refused meanwhile, and let it go again if `open` fails and the session did
/// not already hold it.
pub(super) async fn hold_profile_while<T>(
    session_id: &str,
    profile_id: &str,
    open: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let added = registry().add(session_id, profile_id);
    let opened = open.await;
    if opened.is_err() && added {
        unregister_session_profile(session_id, profile_id);
    }
    opened
}

pub(super) fn register_session_profiles(session_id: &str, profile_ids: &[String]) {
    registry().set(session_id, profile_ids);
}

pub(super) fn unregister_session_profile(session_id: &str, profile_id: &str) {
    registry().remove(session_id, profile_id);
}

/// Release every profile a session holds, its origin included, returning the
/// ones it held. The only unregister a teardown needs.
pub fn release_session_profiles(session_id: &str) -> Vec<String> {
    let mut registry = registry();
    registry.origins.remove(session_id);
    registry.take(session_id)
}

/// Swap a stopped source's profiles for its capture, remembering them as the origin.
pub fn swap_session_profiles_for_capture(session_id: &str, capture_id: &str) {
    let mut registry = registry();
    let current = registry.by_session.get(session_id).cloned().unwrap_or_default();
    registry.origins.entry(session_id.to_string()).or_insert(current);
    registry.set(session_id, &[capture_id.to_string()]);
}

/// Put a resumed source's profiles back in place of its capture.
pub(super) fn restore_session_profiles(session_id: &str, profile_ids: &[String]) {
    let mut registry = registry();
    registry.set(session_id, profile_ids);
    registry.origins.remove(session_id);
}

/// The profiles a session was opened from — its current profiles unless a
/// stopped source has been swapped for its capture.
pub fn get_session_origin_profile_ids(session_id: &str) -> Vec<String> {
    let registry = registry();
    registry
        .origins
        .get(session_id)
        .or_else(|| registry.by_session.get(session_id))
        .cloned()
        .unwrap_or_default()
}

pub fn get_session_profile_ids(session_id: &str) -> Vec<String> {
    registry().by_session.get(session_id).cloned().unwrap_or_default()
}

/// Every held profile with the sessions holding it, sorted.
pub fn profiles_in_use() -> Vec<(String, Vec<String>)> {
    registry()
        .by_profile
        .iter()
        .map(|(profile_id, sessions)| {
            let mut sessions: Vec<String> = sessions.iter().cloned().collect();
            sessions.sort();
            (profile_id.clone(), sessions)
        })
        .collect()
}

/// The sessions holding a profile, which the single-handle admission check reads.
pub fn get_sessions_for_profile(profile_id: &str) -> Vec<String> {
    registry()
        .by_profile
        .get(profile_id)
        .map(|sessions| sessions.iter().cloned().collect())
        .unwrap_or_default()
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
    fn a_failed_open_lets_go_only_of_a_profile_it_took() {
        let refused = || async { Err::<(), _>("refused".to_string()) };
        let _ = tauri::async_runtime::block_on(hold_profile_while("f_failed_add", "slcan-new", refused()));
        assert!(get_sessions_for_profile("slcan-new").is_empty());

        register_session_profile("f_failed_add", "gvret-held");
        let _ = tauri::async_runtime::block_on(hold_profile_while("f_failed_add", "gvret-held", refused()));
        assert_eq!(get_sessions_for_profile("gvret-held"), ids(&["f_failed_add"]));

        let opened = tauri::async_runtime::block_on(hold_profile_while("f_failed_add", "slcan-opened", async { Ok(()) }));
        assert!(opened.is_ok());
        assert_eq!(get_sessions_for_profile("slcan-opened"), ids(&["f_failed_add"]));
        release_session_profiles("f_failed_add");
    }

    #[test]
    fn a_destroyed_session_forgets_its_origin() {
        register_session_profiles("s_gone", &ids(&["io_dev"]));
        swap_session_profiles_for_capture("s_gone", "cap1");
        release_session_profiles("s_gone");
        assert!(get_session_origin_profile_ids("s_gone").is_empty());
    }
}
