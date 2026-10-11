use crate::io::{
    device_kinds, get_session_source_configs, resume_to_live_session, IOBroker, IOCapabilities, IOSource,
    ProfileLoader, SerialOverrides, SourceConfig,
};

use super::source_config::create_source_config_from_profile;
use super::tracking::{get_session_profile_ids, restore_session_profiles};

/// Swap a session's capture playback for a live reader over its sources.
/// Uses stored source configs to rebuild the reader (supports multi-source).
/// Falls back to the profile for single-source sessions without stored configs.
/// Re-registers device profiles with the tracker before reconnecting.
pub async fn rebuild_live_reader(session_id: &str, profiles: ProfileLoader) -> Result<IOCapabilities, String> {
    let load_profiles = || profiles().map_err(|e| format!("Failed to load settings: {}", e));

    // Prefer stored source configs (set during session creation)
    let stored_configs: Vec<SourceConfig> = get_session_source_configs(session_id).await;

    let configs = if !stored_configs.is_empty() {
        stored_configs
    } else {
        // Fallback: load from settings (legacy single-source path)
        let profile_ids = get_session_profile_ids(session_id);
        if profile_ids.is_empty() {
            return Err(format!(
                "No profile IDs or source configs found for session '{}'. Cannot resume to live.",
                session_id
            ));
        }

        let saved = load_profiles()?;

        let profile_id = &profile_ids[0];
        let profile = saved
            .iter()
            .find(|p| p.id == *profile_id)
            .ok_or_else(|| format!("Profile '{}' not found in settings", profile_id))?;

        if !device_kinds::is_multi_source(&profile.kind) {
            return Err(format!(
                "Cannot resume to live for '{}' device type.",
                profile.kind
            ));
        }

        // No session overrides on this path — the original ones went with the
        // stored configs this branch is the fallback for, so the profile decides.
        let source_config = create_source_config_from_profile(profile, None, SerialOverrides::default())
            .ok_or_else(|| format!("Failed to create source config for profile '{}'", profile_id))?;

        vec![source_config]
    };

    // Check profile availability before committing
    let saved = load_profiles()?;
    for config in &configs {
        crate::profile_tracker::can_use_profile(&config.profile_id, &config.profile_kind, None)?;
        crate::profile_tracker::can_use_adapter(&config.profile_id, &saved, &[], None)?;
    }

    let profile_ids: Vec<String> = configs.iter().map(|c| c.profile_id.clone()).collect();
    restore_session_profiles(session_id, &profile_ids);

    // Build the new live reader
    let new_reader: Box<dyn IOSource> = if configs.len() == 1 {
        Box::new(IOBroker::single_source(
            profiles,
            session_id.to_string(),
            configs.into_iter().next().unwrap(),
        )?)
    } else {
        Box::new(IOBroker::new(profiles, session_id.to_string(), configs)?)
    };

    resume_to_live_session(session_id, new_reader).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::test_source::TestSource;
    use crate::settings::IOProfile;
    use std::sync::Arc;

    fn loader(profiles: Vec<IOProfile>) -> ProfileLoader {
        Arc::new(move || Ok(profiles.clone()))
    }

    fn device(id: &str, kind: &str) -> IOProfile {
        IOProfile {
            id: id.into(),
            name: id.into(),
            kind: kind.into(),
            connection: [
                ("traffic_type".to_string(), "can".into()),
                ("signal_generator".to_string(), false.into()),
            ]
            .into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_session_with_no_sources_cannot_resume() {
        assert_eq!(
            rebuild_live_reader("f_live_nothing", loader(vec![])).await.unwrap_err(),
            "No profile IDs or source configs found for session 'f_live_nothing'. Cannot resume to live."
        );
    }

    #[tokio::test]
    async fn the_fallback_needs_a_saved_multi_source_profile() {
        let session_id = "f_live_fallback";
        super::super::register_session_profile(session_id, "live-mqtt");
        let unreadable: ProfileLoader = Arc::new(|| Err("unreadable".into()));

        let failed_load = rebuild_live_reader(session_id, unreadable).await;
        let missing = rebuild_live_reader(session_id, loader(vec![])).await;
        let single = rebuild_live_reader(session_id, loader(vec![device("live-mqtt", "mqtt")])).await;
        super::super::release_session_profiles(session_id);

        assert_eq!(failed_load.unwrap_err(), "Failed to load settings: unreadable");
        assert_eq!(missing.unwrap_err(), "Profile 'live-mqtt' not found in settings");
        assert_eq!(single.unwrap_err(), "Cannot resume to live for 'mqtt' device type.");
    }

    #[tokio::test]
    async fn a_session_returns_to_live_on_its_virtual_device() {
        crate::capture_db::use_in_memory_database();
        let session_id = "f_live_virtual";
        crate::io::create_session(session_id.into(), Box::new(TestSource::new(session_id)), None, None, None, vec![])
            .await;
        super::super::register_session_profile(session_id, "live-virtual");

        let resumed = rebuild_live_reader(session_id, loader(vec![device("live-virtual", "virtual")])).await;
        let state = crate::io::get_session_state(session_id).await;
        let held = super::super::get_session_profile_ids(session_id);
        crate::io::destroy_session(session_id, false).await.unwrap();

        assert!(resumed.is_ok(), "{resumed:?}");
        assert_eq!(state, Some(crate::io::IOState::Running));
        assert_eq!(held, ["live-virtual"]);
    }

    #[tokio::test]
    async fn stored_source_configs_win_over_the_profile_ids() {
        crate::capture_db::use_in_memory_database();
        let session_id = "f_live_stored";
        let virtual_device = device("live-stored", "virtual");
        let config = SourceConfig {
            profile_id: virtual_device.id.clone(),
            profile_kind: virtual_device.kind.clone(),
            display_name: virtual_device.name.clone(),
            bus_mappings: super::super::profile_bus_mappings(&virtual_device),
            ..Default::default()
        };
        let source = Box::new(TestSource::new(session_id));
        crate::io::create_session(session_id.into(), source, None, None, None, vec![config]).await;
        super::super::register_session_profile(session_id, "live-stale");

        let resumed = rebuild_live_reader(session_id, loader(vec![virtual_device])).await;
        let held = super::super::get_session_profile_ids(session_id);
        crate::io::destroy_session(session_id, false).await.unwrap();

        assert!(resumed.is_ok(), "{resumed:?}");
        assert_eq!(held, ["live-stored"]);
    }
}
