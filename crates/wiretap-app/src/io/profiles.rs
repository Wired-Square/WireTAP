//! Profile lifecycle — changing a device and making the change take effect.
//!
//! `ephemeral` is one of two places a profile can live; this module is about the
//! operations that span both, and the session reconnect that has to follow them.

use std::collections::HashMap;

/// Change a device's connection parameters, and reconnect anything using it.
///
/// One command rather than a frontend sequence, because the steps are
/// inseparable: the profile has to be written before the source respawns, or the
/// device comes back on the settings it just replaced. Nothing in a running
/// source can be re-tuned in place — a bitrate or a baud rate is fixed when the
/// port opens — so the source is dropped and re-established. The session id does
/// not change, so every app watching it stays attached and simply sees the
/// device reconnect.
///
/// The change lands wherever the device already lives: settings.json for a saved
/// profile, the run-lifetime registry for an ad-hoc one. Secrets are split into
/// the keyring on the way, so nothing here can put a password on disk.
#[tauri::command(rename_all = "snake_case")]
pub async fn reconfigure_device(
    app: tauri::AppHandle,
    profile_id: String,
    connection: HashMap<String, serde_json::Value>,
    session_id: Option<String>,
) -> Result<(), String> {
    let mut settings = crate::settings::load_settings(app.clone()).await?;
    let idx = settings
        .io_profiles
        .iter()
        .position(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile '{profile_id}' not found"))?;

    settings.io_profiles[idx].connection = connection;
    crate::credentials::split_secrets(&mut settings.io_profiles[idx])?;

    if settings.io_profiles[idx].ephemeral {
        // `register` stamps `ephemeral` and clears the stale probe itself.
        super::ephemeral::register(settings.io_profiles.swap_remove(idx));
    } else {
        crate::settings::save_settings(app, settings).await?;
        crate::sessions::clear_probe_cache(&profile_id);
    }

    match session_id {
        Some(id) => crate::io::reload_session_source(&id, &profile_id).await,
        None => Ok(()),
    }
}
