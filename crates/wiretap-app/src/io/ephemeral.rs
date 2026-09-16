//! Ad-hoc IO devices — profiles that exist for this run only.
//!
//! A device created in the source picker without being saved lives here rather
//! than in settings.json. `settings::load_settings` overlays this registry onto
//! `AppSettings::io_profiles`, so every existing profile consumer — session
//! creation, the broker spawner, probing, transmit, Modbus, MCP — resolves an
//! ad-hoc device by id exactly as it resolves a saved one, with no change at
//! those call sites. `settings::save_settings` drops them again on the way out,
//! so nothing here ever reaches disk.
//!
//! Ids are minted frontend-side as `adhoc_<epoch_ms>`, keeping them disjoint
//! from the `io_<epoch_ms>` ids saved profiles use.

use once_cell::sync::Lazy;
use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::settings::IOProfile;

/// Keyed by id, and a BTreeMap so the picker's list does not reshuffle between
/// reads the way a HashMap's randomised iteration order would.
static EPHEMERAL: Lazy<Mutex<BTreeMap<String, IOProfile>>> =
    Lazy::new(|| Mutex::new(BTreeMap::new()));

/// Every ad-hoc device, ordered by id.
pub fn list() -> Vec<IOProfile> {
    let Ok(map) = EPHEMERAL.lock() else {
        return Vec::new();
    };
    map.values().cloned().collect()
}

/// Append the ad-hoc devices to a settings profile list. Anything already
/// present under the same id wins, so a saved profile is never shadowed.
pub fn overlay(profiles: &mut Vec<IOProfile>) {
    for extra in list() {
        if !profiles.iter().any(|p| p.id == extra.id) {
            profiles.push(extra);
        }
    }
}

/// Add or replace an ad-hoc device. Returns the full list so the caller updates
/// its mirror from one round trip.
pub fn register(mut profile: IOProfile) -> Vec<IOProfile> {
    profile.ephemeral = true;
    // A replaced device may have different connection parameters under the same
    // id, which would otherwise be probed from cache and reported as the old one.
    crate::sessions::clear_probe_cache(&profile.id);
    if let Ok(mut map) = EPHEMERAL.lock() {
        tlog!(
            "[ephemeral] Registered ad-hoc {} device '{}' ({})",
            profile.kind, profile.name, profile.id
        );
        map.insert(profile.id.clone(), profile);
    }
    list()
}

/// Discard an ad-hoc device. Returns the remaining list.
pub fn unregister(profile_id: &str) -> Vec<IOProfile> {
    crate::sessions::clear_probe_cache(profile_id);
    if let Ok(mut map) = EPHEMERAL.lock() {
        if map.remove(profile_id).is_some() {
            tlog!("[ephemeral] Discarded ad-hoc device {}", profile_id);
        }
    }
    list()
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Add or replace an ad-hoc device. Rejects an id already used by a saved
/// profile, since the overlay would silently drop it.
#[tauri::command(rename_all = "snake_case")]
pub async fn register_ephemeral_profile(
    app: tauri::AppHandle,
    profile: IOProfile,
) -> Result<Vec<IOProfile>, String> {
    let settings = crate::settings::load_settings(app).await?;
    if settings
        .io_profiles
        .iter()
        .any(|p| p.id == profile.id && !p.ephemeral)
    {
        return Err(format!(
            "'{}' is already the id of a saved profile",
            profile.id
        ));
    }
    Ok(register(profile))
}

/// Discard an ad-hoc device. Succeeds when there was nothing to discard, and
/// refuses while a session still holds it — dropping it then would leave that
/// session pointing at a profile nothing can resolve.
#[tauri::command(rename_all = "snake_case")]
pub fn unregister_ephemeral_profile(profile_id: String) -> Result<Vec<IOProfile>, String> {
    let sessions = crate::sessions::get_sessions_for_profile(&profile_id);
    if !sessions.is_empty() {
        return Err(format!(
            "'{}' is still in use by {}",
            profile_id,
            sessions.join(", ")
        ));
    }
    Ok(unregister(&profile_id))
}

/// Every ad-hoc device registered this run.
#[tauri::command(rename_all = "snake_case")]
pub fn list_ephemeral_profiles() -> Vec<IOProfile> {
    list()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str) -> IOProfile {
        IOProfile {
            id: id.to_string(),
            name: format!("Device {id}"),
            kind: "slcan".to_string(),
            connection: std::collections::HashMap::new(),
            preferred_catalog: None,
            ephemeral: false,
        }
    }

    // The registry is process-global, so each test uses its own ids and cleans up.

    #[test]
    fn overlay_adds_ad_hoc_devices() {
        let id = "adhoc_test_overlay";
        register(profile(id));

        let mut profiles = vec![profile("io_saved_overlay")];
        overlay(&mut profiles);

        assert!(profiles.iter().any(|p| p.id == id && p.ephemeral));
        assert!(profiles.iter().any(|p| p.id == "io_saved_overlay"));
        unregister(id);
    }

    #[test]
    fn overlay_never_shadows_a_saved_profile() {
        let id = "adhoc_test_shadow";
        register(profile(id));

        let mut saved = profile(id);
        saved.name = "Saved wins".to_string();
        let mut profiles = vec![saved];
        overlay(&mut profiles);

        // Other tests share the process-global registry, so assert on this id
        // rather than the list length.
        let matching: Vec<&IOProfile> = profiles.iter().filter(|p| p.id == id).collect();
        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].name, "Saved wins");
        assert!(!matching[0].ephemeral);
        unregister(id);
    }

    #[test]
    fn unregister_removes_the_device() {
        let id = "adhoc_test_register";
        register(profile(id));
        assert!(!unregister(id).iter().any(|p| p.id == id));
    }
}
