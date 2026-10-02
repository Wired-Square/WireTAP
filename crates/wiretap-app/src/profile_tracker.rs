// ui/crates/wiretap-app/src/profile_tracker.rs
//
// Admission checks for IO sessions, read from the session profile registry
// (`sessions::tracking`), to prevent conflicts on single-handle devices
// (slcan, serial, gs_usb).
//
// Multi-handle devices (GVRET, the WireTAP backend, etc.) can be used by multiple
// sessions simultaneously - each session opens its own connection.

use crate::io::device_kinds::conn_str;
use crate::sessions::get_sessions_for_profile;
use crate::settings::IOProfile;

/// Check if a profile can be used (not already in use by another session)
///
/// For single-handle kinds, only one session is allowed.
/// For multi-handle devices (gvret_tcp, wiretap, etc.), multiple sessions are OK.
///
/// Returns Ok(()) if the profile can be used, or an error message if it's in use.
/// The session being `replacing`, about to be torn down for the same id, does not count.
pub fn can_use_profile(profile_id: &str, profile_kind: &str, replacing: Option<&str>) -> Result<(), String> {
    // Multi-handle profiles can always be used by multiple sessions
    if !crate::io::device_kinds::spec(profile_kind).is_some_and(|s| s.single_handle) {
        return Ok(());
    }

    let holders = holders_except(profile_id, replacing);
    if !holders.is_empty() {
        return Err(format!(
            "Profile is in use by session '{}'. Stop that session first.",
            holders.join(", ")
        ));
    }
    Ok(())
}

fn holders_except(profile_id: &str, replacing: Option<&str>) -> Vec<String> {
    let mut holders = get_sessions_for_profile(profile_id);
    holders.retain(|s| Some(s.as_str()) != replacing);
    holders
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
pub fn can_use_adapter(
    profile_id: &str,
    profiles: &[IOProfile],
    joining: &[&str],
    replacing: Option<&str>,
) -> Result<(), String> {
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
    let held = profiles.iter().filter(|p| on_adapter(&p.id)).find_map(|p| {
        let mut sessions = holders_except(&p.id, replacing);
        sessions.sort();
        (!sessions.is_empty()).then_some((p, sessions))
    });
    if let Some((profile, sessions)) = held {
        return Err(format!(
            "The gs_usb adapter is in use by '{}' in session '{}'. Stop that session first.",
            profile.name,
            sessions.join(", ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{register_session_profile, release_session_profiles};

    #[test]
    fn a_gs_usb_profile_cannot_be_opened_by_a_second_session() {
        register_session_profile("f_first", "gs-usb-held");
        let second = can_use_profile("gs-usb-held", "gs_usb", None);
        release_session_profiles("f_first");
        assert!(second.is_err(), "the adapter's interface has one owner");
    }

    #[test]
    fn a_session_recreated_under_its_own_id_is_not_refused_by_itself() {
        register_session_profile("f_recreated", "slcan-recreated");
        let own = can_use_profile("slcan-recreated", "slcan", Some("f_recreated"));
        let other = can_use_profile("slcan-recreated", "slcan", Some("f_elsewhere"));
        release_session_profiles("f_recreated");
        assert!(own.is_ok(), "{own:?}");
        assert!(other.is_err(), "another session's hold still refuses");
    }

    #[test]
    fn a_gs_usb_adapter_held_by_the_session_being_recreated_is_free() {
        let profiles = [
            gs_usb("gs-recreate-ch0", serde_json::json!({ "serial": "C3", "channel": 0 })),
            gs_usb("gs-recreate-ch1", serde_json::json!({ "serial": "C3", "channel": 1 })),
        ];
        register_session_profile("f_recreate_gs", "gs-recreate-ch0");
        let own = can_use_adapter("gs-recreate-ch1", &profiles, &[], Some("f_recreate_gs"));
        let other = can_use_adapter("gs-recreate-ch1", &profiles, &[], None);
        release_session_profiles("f_recreate_gs");
        assert!(own.is_ok(), "{own:?}");
        assert!(other.is_err());
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
        register_session_profile("f_holder", "gs-held-ch0");
        let same_adapter = can_use_adapter("gs-held-ch1", &profiles, &[], None);
        let other_adapter = can_use_adapter("gs-other", &profiles, &[], None);
        release_session_profiles("f_holder");

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
        let error = can_use_adapter("gs-join-ch1", &profiles, &["gs-join-ch0"], None)
            .expect_err("both channels claim the one interface");
        assert!(error.contains("gs-join-ch0 name"), "{error}");
        assert!(can_use_adapter("gs-join-elsewhere", &profiles, &["gs-join-ch0"], None).is_ok());

        let unidentified = [gs_usb("gs-bare-a", serde_json::json!({})), gs_usb("gs-bare-b", serde_json::json!({}))];
        assert!(can_use_adapter("gs-bare-b", &unidentified, &["gs-bare-a"], None).is_ok(), "no identity, nothing to compare");
    }
}
