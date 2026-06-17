// Copyright 2026 Wired Square Pty Ltd

//! Rust-native session open for the MCP server. Mirrors the frontend's open
//! flow (build Modbus poll groups from the profile's catalog, then create the
//! reader session) without needing an app window. A keep-alive task touches the
//! MCP subscriber so the session isn't reaped by the heartbeat watchdog.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

static SID_COUNTER: AtomicU64 = AtomicU64::new(1);

fn generate_session_id(kind: &str) -> String {
    let prefix = if kind.starts_with("modbus") {
        "m"
    } else if kind == "serial" {
        "b"
    } else {
        "f"
    };
    format!("{prefix}_mcp{}", SID_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Touch the MCP subscriber every 10s so the heartbeat watchdog doesn't reap a
/// headless session. Self-terminates once the session is gone.
fn spawn_keepalive(session_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if crate::io::get_session_state(&session_id).await.is_none() {
                break;
            }
            crate::io::touch_subscriber_heartbeats(std::slice::from_ref(&session_id)).await;
        }
    });
}

/// Open (create + auto-start) a reader session for a profile. For Modbus
/// profiles, poll groups are built from the profile's preferred catalog.
pub async fn open(
    app: tauri::AppHandle,
    profile_id: String,
    session_id: Option<String>,
) -> Result<Value, String> {
    let settings = crate::settings::load_settings_sync(&app)?;
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile '{profile_id}' not found"))?;

    let modbus_polls = if profile.kind.starts_with("modbus") {
        let catalog = profile.preferred_catalog.clone().ok_or_else(|| {
            "Modbus profile has no preferred_catalog — set one so poll groups can be built".to_string()
        })?;
        let path = std::path::PathBuf::from(&settings.decoder_dir).join(&catalog);
        let toml = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read catalog '{catalog}': {e}"))?;
        let polls = crate::io::build_polls_from_catalog(&toml)?;
        if polls.is_empty() {
            return Err(format!("Catalog '{catalog}' has no [frame.modbus.*] poll definitions"));
        }
        Some(serde_json::to_string(&polls).map_err(|e| e.to_string())?)
    } else {
        None
    };

    let sid = session_id.unwrap_or_else(|| generate_session_id(&profile.kind));
    let capabilities = crate::sessions::create_reader_session(
        app.clone(),
        sid.clone(),
        Some(profile_id.clone()),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("mcp".to_string()),
        Some("mcp".to_string()),
        modbus_polls,
    )
    .await?;

    spawn_keepalive(sid.clone());

    Ok(json!({ "session_id": sid, "profile_id": profile_id, "capabilities": capabilities }))
}
