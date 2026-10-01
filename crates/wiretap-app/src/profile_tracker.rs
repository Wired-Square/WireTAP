// ui/crates/wiretap-app/src/profile_tracker.rs
//
// Profile usage tracker for IO sessions.
// Tracks which sessions are using which profiles to prevent conflicts
// on single-handle devices (slcan, serial, gs_usb).
//
// Multi-handle devices (GVRET, the WireTAP backend, etc.) can be used by multiple
// sessions simultaneously - each session opens its own connection.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use crate::io::device_kinds::conn_str;
use crate::settings::IOProfile;

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
const SINGLE_HANDLE_KINDS: &[&str] = &["slcan", "serial", "gs_usb"];

/// Check if a profile can be used (not already in use by another session)
///
/// For single-handle devices (slcan, serial, gs_usb), only one session is allowed.
/// For multi-handle devices (gvret_tcp, wiretap, etc.), multiple sessions are OK.
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

/// A gs_usb adapter, by its serial number or else its USB bus and address.
fn gs_usb_adapter(profile: &IOProfile) -> Option<String> {
    if profile.kind != "gs_usb" {
        return None;
    }
    let at = || {
        let field = |key| profile.connection.get(key).and_then(|v| v.as_i64().or_else(|| v.as_str()?.trim().parse().ok()));
        Some(format!("{}:{}", field("bus")?, field("address")?))
    };
    conn_str(profile, "serial").or_else(at)
}

/// Refuse a gs_usb profile whose adapter another live session holds, or another
/// of the profiles opening with it (`joining`) is on. Every channel claims the
/// adapter's one USB interface, and macOS gives that interface one owner.
pub fn can_use_adapter(profile_id: &str, profiles: &[IOProfile], joining: &[&str]) -> Result<(), String> {
    let find = |id: &str| profiles.iter().find(|p| p.id == id);
    let Some(adapter) = find(profile_id).and_then(gs_usb_adapter) else {
        return Ok(());
    };
    let on_adapter = |id: &str| id != profile_id && find(id).and_then(gs_usb_adapter).as_ref() == Some(&adapter);
    let name = |id: &str| find(id).map_or(id.to_string(), |p| p.name.clone());

    if let Some(other) = joining.iter().find(|id| on_adapter(id)) {
        return Err(format!(
            "'{}' and '{}' are on the same gs_usb adapter, which only one source can open at a time.",
            name(other),
            name(profile_id)
        ));
    }
    let usage = PROFILE_USAGE.lock().map_err(|e| e.to_string())?;
    if let Some((held, sessions)) = usage.iter().find(|(id, _)| on_adapter(id)) {
        let mut sessions: Vec<_> = sessions.iter().cloned().collect();
        sessions.sort();
        return Err(format!(
            "The gs_usb adapter is in use by '{}' in session '{}'. Stop that session first.",
            name(held),
            sessions.join(", ")
        ));
    }
    Ok(())
}

/// Check if a profile kind requires single-handle access
#[allow(dead_code)]
pub fn is_single_handle_kind(profile_kind: &str) -> bool {
    SINGLE_HANDLE_KINDS.contains(&profile_kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gs_usb_profile_cannot_be_opened_by_a_second_session() {
        register_usage("gs-usb-held", "f_first");
        let second = can_use_profile("gs-usb-held", "gs_usb");
        unregister_usage_by_session("gs-usb-held", "f_first");
        assert!(second.is_err(), "the adapter's interface has one owner");
    }

    fn gs_usb(id: &str, connection: serde_json::Value) -> IOProfile {
        IOProfile {
            id: id.into(),
            name: format!("{id} name"),
            kind: "gs_usb".into(),
            connection: serde_json::from_value(connection).unwrap(),
            preferred_catalog: None,
            ephemeral: false,
        }
    }

    #[test]
    fn a_second_gs_usb_profile_on_a_held_adapter_is_refused() {
        let profiles = [
            gs_usb("gs-held-ch0", serde_json::json!({ "serial": "A1", "channel": 0 })),
            gs_usb("gs-held-ch1", serde_json::json!({ "serial": "A1", "channel": 1 })),
            gs_usb("gs-other", serde_json::json!({ "serial": "B2" })),
        ];
        register_usage("gs-held-ch0", "f_holder");
        let same_adapter = can_use_adapter("gs-held-ch1", &profiles, &[]);
        let other_adapter = can_use_adapter("gs-other", &profiles, &[]);
        unregister_usage_by_session("gs-held-ch0", "f_holder");

        let error = same_adapter.expect_err("the adapter's interface has one owner");
        assert!(error.contains("gs-held-ch0 name") && error.contains("f_holder"), "{error}");
        assert!(other_adapter.is_ok(), "{other_adapter:?}");
    }

    #[test]
    fn two_gs_usb_sources_on_one_adapter_cannot_share_a_session() {
        let profiles = [
            gs_usb("gs-join-ch0", serde_json::json!({ "bus": 2, "address": 7, "channel": 0 })),
            gs_usb("gs-join-ch1", serde_json::json!({ "bus": 2, "address": 7, "channel": 1 })),
            gs_usb("gs-join-elsewhere", serde_json::json!({ "bus": 2, "address": 8 })),
        ];
        let error = can_use_adapter("gs-join-ch1", &profiles, &["gs-join-ch0"])
            .expect_err("both channels claim the one interface");
        assert!(error.contains("gs-join-ch0 name"), "{error}");
        assert!(can_use_adapter("gs-join-elsewhere", &profiles, &["gs-join-ch0"]).is_ok());

        let unidentified = [gs_usb("gs-bare-a", serde_json::json!({})), gs_usb("gs-bare-b", serde_json::json!({}))];
        assert!(can_use_adapter("gs-bare-b", &unidentified, &["gs-bare-a"]).is_ok(), "no identity, nothing to compare");
    }
}
