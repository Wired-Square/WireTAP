//! Profile lifecycle — creating and changing a device, and making the change take effect.
//!
//! `ephemeral` is one of two places a profile can live; this module is about the
//! operations that span both, and the session reconnect that has to follow them.
//! Every device write goes through [`settle`], so defaults, validation and the
//! keyring split cannot differ between the surfaces that write one.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::credentials;
use crate::io::device_kinds::{apply_defaults, validate_profile, ProfileValidationError};
use crate::settings::{AppSettings, IOProfile};

/// A device as the user described it. The id is minted by [`create_device`].
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceDraft {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub connection: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub preferred_catalog: Option<String>,
}

/// Why a device write was refused: a rule the form can point at, or a failure
/// it can only report.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(untagged)]
pub enum DeviceWriteError {
    Invalid(ProfileValidationError),
    Failed(String),
}

impl From<ProfileValidationError> for DeviceWriteError {
    fn from(e: ProfileValidationError) -> Self {
        Self::Invalid(e)
    }
}

impl From<String> for DeviceWriteError {
    fn from(e: String) -> Self {
        Self::Failed(e)
    }
}

/// Each write reads the settings file and writes it back whole, so two at once
/// would lose one.
static DEVICE_WRITES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Defaults, validation against every other device, and secrets into `store`
/// for a profile bound for settings.json. An ad-hoc device keeps its secrets
/// inline: it never reaches disk, and `resolve_secret` reads them there.
fn settle(
    mut profile: IOProfile,
    existing: &[IOProfile],
    store: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<IOProfile, DeviceWriteError> {
    apply_defaults(&mut profile);
    validate_profile(&profile, existing)?;
    if !profile.ephemeral {
        credentials::split_secrets(&mut profile, store)?;
    }
    Ok(profile)
}

fn mint_id(prefix: &str, existing: &[IOProfile]) -> String {
    let mut stamp = chrono::Utc::now().timestamp_millis();
    loop {
        let id = format!("{prefix}_{stamp}");
        if !existing.iter().any(|p| p.id == id) {
            return id;
        }
        stamp += 1;
    }
}

fn new_device(
    draft: DeviceDraft,
    persist: bool,
    existing: &[IOProfile],
    store: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<IOProfile, DeviceWriteError> {
    let mut profile = IOProfile {
        id: mint_id(if persist { "io" } else { "adhoc" }, existing),
        name: draft.name,
        kind: draft.kind,
        connection: draft.connection,
        preferred_catalog: draft.preferred_catalog,
        ephemeral: !persist,
    };
    credentials::forget_stored_secrets(&mut profile);
    settle(profile, existing, store)
}

/// Write `profile` where it lives: the ad-hoc registry, or settings.json.
async fn put(app: AppHandle, mut settings: AppSettings, profile: IOProfile) -> Result<(), String> {
    if profile.ephemeral {
        // `register` clears the stale probe itself.
        super::ephemeral::register(profile);
        return Ok(());
    }
    let id = profile.id.clone();
    match settings.io_profiles.iter_mut().find(|p| p.id == id) {
        Some(slot) => *slot = profile,
        None => settings.io_profiles.push(profile),
    }
    crate::settings::save_settings(app, settings).await?;
    crate::sessions::clear_probe_cache(&id);
    Ok(())
}

/// Create a device, saved to settings.json when `persist`, otherwise ad-hoc for
/// this run, and return it as stored.
#[tauri::command(rename_all = "snake_case")]
pub async fn create_device(
    app: AppHandle,
    draft: DeviceDraft,
    persist: bool,
) -> Result<IOProfile, DeviceWriteError> {
    let _writing = DEVICE_WRITES.lock().await;
    let settings = crate::settings::load_settings(app.clone()).await?;
    let profile = new_device(draft, persist, &settings.io_profiles, credentials::store_io_secret)?;
    put(app, settings, profile.clone()).await?;
    Ok(profile)
}

/// Save an ad-hoc device to settings.json under a new id and `name`. The ad-hoc
/// copy stays until the caller discards it, so the name check skips it.
#[tauri::command(rename_all = "snake_case")]
pub async fn save_ad_hoc_device(
    app: AppHandle,
    profile_id: String,
    name: String,
) -> Result<IOProfile, DeviceWriteError> {
    let _writing = DEVICE_WRITES.lock().await;
    let settings = crate::settings::load_settings(app.clone()).await?;
    let ad_hoc = settings.profile(&profile_id)?.clone();
    let others: Vec<IOProfile> = settings
        .io_profiles
        .iter()
        .filter(|p| p.id != profile_id)
        .cloned()
        .collect();
    let draft = DeviceDraft {
        name,
        kind: ad_hoc.kind,
        connection: ad_hoc.connection,
        preferred_catalog: ad_hoc.preferred_catalog,
    };
    let profile = new_device(draft, true, &others, credentials::store_io_secret)?;
    put(app, settings, profile.clone()).await?;
    Ok(profile)
}

/// Rewrite an existing device through `edit`, keeping its id and where it lives.
async fn rewrite(
    app: &AppHandle,
    profile_id: &str,
    edit: impl FnOnce(IOProfile) -> IOProfile,
) -> Result<IOProfile, DeviceWriteError> {
    let _writing = DEVICE_WRITES.lock().await;
    let settings = crate::settings::load_settings(app.clone()).await?;
    let current = settings.profile(profile_id)?.clone();
    let ephemeral = current.ephemeral;
    let edited = IOProfile {
        id: profile_id.to_string(),
        ephemeral,
        ..edit(current)
    };
    let profile = settle(edited, &settings.io_profiles, credentials::store_io_secret)?;
    put(app.clone(), settings, profile.clone()).await?;
    Ok(profile)
}

/// Replace a device's name, kind and connection, and return it as stored.
#[tauri::command(rename_all = "snake_case")]
pub async fn update_device(app: AppHandle, profile: IOProfile) -> Result<IOProfile, DeviceWriteError> {
    let id = profile.id.clone();
    rewrite(&app, &id, |_| profile).await
}

/// Change a device's connection parameters, and reconnect anything using it.
///
/// One command rather than a frontend sequence, because the steps are
/// inseparable: the profile has to be written before the source respawns, or the
/// device comes back on the settings it just replaced. Nothing in a running
/// source can be re-tuned in place — a bitrate or a baud rate is fixed when the
/// port opens — so the source is dropped and re-established. The session id does
/// not change, so every app watching it stays attached and simply sees the
/// device reconnect.
#[tauri::command(rename_all = "snake_case")]
pub async fn reconfigure_device(
    app: AppHandle,
    profile_id: String,
    connection: HashMap<String, serde_json::Value>,
    session_id: Option<String>,
) -> Result<(), DeviceWriteError> {
    rewrite(&app, &profile_id, |p| IOProfile { connection, ..p }).await?;
    match session_id {
        Some(id) => Ok(crate::io::reload_session_source(&id, &profile_id).await?),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn no_keyring(_: &str, _: &str) -> Result<(), String> {
        Ok(())
    }

    fn draft(value: &Value) -> DeviceDraft {
        serde_json::from_value(value.clone()).unwrap()
    }

    fn create(d: DeviceDraft, persist: bool, existing: &[IOProfile]) -> (IOProfile, Vec<(String, String)>) {
        let mut stored = Vec::new();
        let profile = new_device(d, persist, existing, |account, value| {
            stored.push((account.to_string(), value.to_string()));
            Ok(())
        })
        .unwrap_or_else(|e| panic!("{e:?}"));
        (profile, stored)
    }

    /// The retired TypeScript create path's output, taken before it was deleted.
    /// The only deliberate difference is the id's number.
    #[test]
    fn the_retired_typescript_create_path_agrees() {
        let golden: Value =
            serde_json::from_str(include_str!("device_kinds/ts-create-golden.json")).unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let persist = case["persist"].as_bool().unwrap();
            let (profile, stored) = create(draft(&case["draft"]), persist, &[]);
            let name = &case["draft"]["name"];

            let prefix = if persist { "io_" } else { "adhoc_" };
            assert_eq!(case["id_pattern"], json!(format!("^{prefix}\\d+$")));
            let stamp = profile.id.strip_prefix(prefix).unwrap_or_default();
            assert!(!stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()), "{name}: id {}", profile.id);

            let mut written = serde_json::to_value(&profile).unwrap();
            written.as_object_mut().unwrap().remove("id");
            written.as_object_mut().unwrap().remove("preferred_catalog");
            assert_eq!(written, case["profile"], "{name} (persist {persist})");

            let want: Vec<(String, String)> = case["keychain"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (format!("{}:{}", profile.id, e[0].as_str().unwrap()), e[1].as_str().unwrap().to_string()))
                .collect();
            assert_eq!(stored, want, "{name} (persist {persist})");
        }
    }

    #[test]
    fn a_saved_device_never_carries_a_secret_into_the_settings_file() {
        let (profile, stored) = create(
            draft(&json!({ "name": "Broker", "kind": "mqtt",
                "connection": { "password": "hunter2", "token": "t0k", "api_key": "k", "secret": "s" } })),
            true,
            &[],
        );
        let settings_json = serde_json::to_string(&profile).unwrap();
        for secret in ["hunter2", "t0k", "\"k\"", "\"s\""] {
            assert!(!settings_json.contains(secret), "{secret} reached settings.json");
        }
        assert_eq!(stored.len(), 4);
    }

    /// A duplicated profile arrives with the original's markers, which point at
    /// the original's keyring entries, not the copy's.
    #[test]
    fn a_new_device_drops_markers_it_has_no_secret_for() {
        let (profile, stored) = create(
            draft(&json!({ "name": "Copy", "kind": "mqtt",
                "connection": { "_password_stored": true, "_api_key_stored": true, "api_key": "k" } })),
            true,
            &[],
        );
        assert!(!profile.connection.contains_key("_password_stored"));
        assert_eq!(profile.connection["_api_key_stored"], json!(true));
        assert_eq!(stored, vec![(format!("{}:api_key", profile.id), "k".to_string())]);
    }

    #[test]
    fn ids_minted_in_one_millisecond_stay_distinct() {
        let first = mint_id("io", &[]);
        let taken = IOProfile { id: first.clone(), ..Default::default() };
        assert_ne!(mint_id("io", &[taken]), first);
    }

    #[test]
    fn a_new_device_is_checked_against_saved_and_ad_hoc_devices() {
        let ad_hoc = IOProfile {
            id: "adhoc_1".into(),
            name: "Bench".into(),
            kind: "virtual".into(),
            ephemeral: true,
            ..Default::default()
        };
        let err = new_device(
            draft(&json!({ "name": "Bench", "kind": "virtual" })),
            true,
            &[ad_hoc],
            no_keyring,
        )
        .unwrap_err();
        assert!(matches!(err, DeviceWriteError::Invalid(ref e) if e.field.as_deref() == Some("name")));
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({ "code": "nameDuplicate", "field": "name" })
        );
    }

    #[test]
    fn an_edit_keeps_its_own_name_and_fills_blanks() {
        let saved = IOProfile {
            id: "io_1".into(),
            name: "CANable".into(),
            kind: "slcan".into(),
            connection: HashMap::from([("port".into(), json!("/dev/tty.usb"))]),
            ..Default::default()
        };
        let edited = IOProfile {
            connection: HashMap::from([("port".into(), json!("/dev/tty.usb")), ("bitrate".into(), json!(""))]),
            ..saved.clone()
        };
        let settled = settle(edited, &[saved], no_keyring).unwrap();
        assert_eq!(settled.connection["bitrate"], json!("500000"));
    }
}
