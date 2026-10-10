// ui/crates/wiretap-app/src/dbquery.rs
//
// A WireTAP backend profile resolved from settings, and the Query app's Stats
// tab over it. Queries themselves run through `query`.

use tauri::AppHandle;

use crate::capture_db::InventoryRow;
use crate::settings::{load_settings, IOProfile};
use wiretap_gateway::DatabaseActivityResult;

/// Resolve a profile id to a WireTAP backend profile.
///
/// A database-backed source is a `wiretap` profile and nothing else. Anything
/// else reaching here is a caller passing the wrong profile, not a source this
/// module should try to open.
pub async fn backend_profile(app: &AppHandle, profile_id: &str) -> Result<IOProfile, String> {
    let settings = load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;
    if profile.kind != "wiretap" {
        return Err(format!(
            "Profile '{}' is a {} source, not a WireTAP backend",
            profile.name, profile.kind
        ));
    }
    Ok(profile)
}

pub async fn db_frame_inventory(
    app: &AppHandle,
    profile_id: &str,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<Vec<InventoryRow>, String> {
    let profile = backend_profile(app, profile_id).await?;
    crate::apiclient::frame_inventory(&profile, start_us, end_us).await
}

pub async fn db_fetch_frame_payloads(
    app: &AppHandle,
    profile_id: &str,
    frame_id: u32,
    is_extended: Option<bool>,
    limit: u32,
) -> Result<Vec<Vec<u8>>, String> {
    let profile = backend_profile(app, profile_id).await?;
    crate::apiclient::fetch_frame_payloads(&profile, frame_id, is_extended, limit).await
}

#[tauri::command]
pub async fn db_query_activity(
    app: AppHandle,
    profile_id: String,
) -> Result<DatabaseActivityResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::activity(&profile).await
}

#[tauri::command]
pub async fn db_cancel_backend(
    app: AppHandle,
    profile_id: String,
    pid: i32,
) -> Result<bool, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::signal_backend(&profile, pid, false).await
}

#[tauri::command]
pub async fn db_terminate_backend(
    app: AppHandle,
    profile_id: String,
    pid: i32,
) -> Result<bool, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::signal_backend(&profile, pid, true).await
}
