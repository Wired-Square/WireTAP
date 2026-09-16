// ui/crates/wiretap-app/src/dbquery.rs
//
// The Query app's analytical queries against a WireTAP backend.
//
// Every query here is a thin Tauri command over `apiclient` — the backend owns
// the database, and the app talks to it over HTTP. WireTAP used to also connect
// to PostgreSQL directly, which meant two implementations of each query (one in
// SQL here, one over the wire there) that had to agree, and a `tokio_postgres`
// dependency for a path the backend already served. The shapes these answer in
// live in `queryresults`, shared with the SQLite capture queries.

use tauri::AppHandle;

use crate::capture_db::InventoryRow;
use crate::queryresults::*;
use crate::settings::{load_settings, IOProfile};

/// Cancel a running query.
#[tauri::command]
pub async fn db_cancel_query(query_id: String) -> Result<(), String> {
    if crate::apiclient::cancel_query(&query_id).await {
        tlog!("[dbquery] Cancelled query: {}", query_id);
        return Ok(());
    }
    Err(format!("Query not found: {}", query_id))
}

// ── Profile resolution ───────────────────────────────────────────────────────

fn find_profile(settings: &crate::settings::AppSettings, profile_id: &str) -> Option<IOProfile> {
    settings.io_profiles.iter().find(|p| p.id == profile_id).cloned()
}

/// Resolve a profile id to a WireTAP backend profile.
///
/// A database-backed source is a `wiretap` profile and nothing else. Anything
/// else reaching here is a caller passing the wrong profile, not a source this
/// module should try to open.
async fn backend_profile(app: &AppHandle, profile_id: &str) -> Result<IOProfile, String> {
    let settings = load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;
    let profile = find_profile(&settings, profile_id)
        .ok_or_else(|| format!("Profile not found: {}", profile_id))?;
    if profile.kind != "wiretap" {
        return Err(format!(
            "Profile '{}' is a {} source, not a WireTAP backend",
            profile.name, profile.kind
        ));
    }
    Ok(profile)
}

/// A query id for a call that did not bring one — which is every call from the
/// Query app, so this is the usual path rather than a fallback. Only a caller
/// that named its query can cancel it; this one is a label for the backend's
/// logs and the session status line.
fn query_id_or(kind: &str, supplied: Option<String>) -> String {
    supplied.unwrap_or_else(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        format!("{kind}_{nanos:x}")
    })
}

// ── Queries ──────────────────────────────────────────────────────────────────

/// Per-frame-id rollup for a WireTAP backend. Time bounds are optional
/// RFC3339 strings.
pub async fn db_frame_inventory(
    app: &AppHandle,
    profile_id: &str,
    start_time: Option<String>,
    end_time: Option<String>,
) -> Result<Vec<InventoryRow>, String> {
    let profile = backend_profile(app, profile_id).await?;
    crate::apiclient::frame_inventory(&profile, start_time, end_time).await
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
#[allow(clippy::too_many_arguments)]
pub async fn db_query_byte_changes(
    app: AppHandle,
    profile_id: String,
    frame_id: u32,
    byte_index: u8,
    is_extended: Option<bool>,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
) -> Result<ByteChangeQueryResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::byte_changes(
        &profile,
        frame_id,
        byte_index,
        is_extended,
        start_time,
        end_time,
        limit,
        query_id_or("byte_changes", query_id),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_query_frame_changes(
    app: AppHandle,
    profile_id: String,
    frame_id: u32,
    is_extended: Option<bool>,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
) -> Result<FrameChangeQueryResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::frame_changes(
        &profile,
        frame_id,
        is_extended,
        start_time,
        end_time,
        limit,
        query_id_or("frame_changes", query_id),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_query_mirror_validation(
    app: AppHandle,
    profile_id: String,
    mirror_frame_id: u32,
    source_frame_id: u32,
    is_extended: Option<bool>,
    tolerance_ms: u32,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
    compare_byte_indices: Option<Vec<u8>>,
) -> Result<MirrorValidationQueryResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::mirror_validation(
        &profile,
        mirror_frame_id,
        source_frame_id,
        is_extended,
        tolerance_ms,
        start_time,
        end_time,
        limit,
        query_id_or("mirror_validation", query_id),
        compare_index_set(compare_byte_indices),
    )
    .await
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_query_mux_statistics(
    app: AppHandle,
    profile_id: String,
    frame_id: u32,
    mux_selector_byte: u8,
    is_extended: Option<bool>,
    include_16bit: bool,
    payload_length: u8,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
) -> Result<MuxStatisticsQueryResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::mux_statistics(
        &profile,
        frame_id,
        mux_selector_byte,
        is_extended,
        include_16bit,
        payload_length,
        start_time,
        end_time,
        limit,
        query_id_or("mux_statistics", query_id),
    )
    .await
}

#[tauri::command]
pub async fn db_query_first_last(
    app: AppHandle,
    profile_id: String,
    frame_id: u32,
    is_extended: Option<bool>,
    start_time: Option<String>,
    end_time: Option<String>,
    query_id: Option<String>,
) -> Result<FirstLastQueryResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::first_last(
        &profile,
        frame_id,
        is_extended,
        start_time,
        end_time,
        query_id_or("first_last", query_id),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_query_frequency(
    app: AppHandle,
    profile_id: String,
    frame_id: u32,
    is_extended: Option<bool>,
    bucket_size_ms: u32,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
) -> Result<FrequencyQueryResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::frequency(
        &profile,
        frame_id,
        is_extended,
        bucket_size_ms,
        start_time,
        end_time,
        limit,
        query_id_or("frequency", query_id),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_query_distribution(
    app: AppHandle,
    profile_id: String,
    frame_id: u32,
    byte_index: u8,
    is_extended: Option<bool>,
    start_time: Option<String>,
    end_time: Option<String>,
    query_id: Option<String>,
) -> Result<DistributionQueryResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::distribution(
        &profile,
        frame_id,
        byte_index,
        is_extended,
        start_time,
        end_time,
        query_id_or("distribution", query_id),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_query_gap_analysis(
    app: AppHandle,
    profile_id: String,
    frame_id: u32,
    is_extended: Option<bool>,
    gap_threshold_ms: f64,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
) -> Result<GapAnalysisQueryResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::gap_analysis(
        &profile,
        frame_id,
        is_extended,
        gap_threshold_ms,
        start_time,
        end_time,
        limit,
        query_id_or("gap_analysis", query_id),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_query_pattern_search(
    app: AppHandle,
    profile_id: String,
    pattern: Vec<u8>,
    pattern_mask: Vec<u8>,
    start_time: Option<String>,
    end_time: Option<String>,
    limit: Option<u32>,
    query_id: Option<String>,
) -> Result<PatternSearchQueryResult, String> {
    let profile = backend_profile(&app, &profile_id).await?;
    crate::apiclient::pattern_search(
        &profile,
        pattern,
        pattern_mask,
        start_time,
        end_time,
        limit,
        query_id_or("pattern_search", query_id),
    )
    .await
}
