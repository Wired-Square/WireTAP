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

/// A recorded source replays its whole archive from the head unless bounded.
/// Mirrors the frontend's playback controls; each falls back to the profile's
/// own `connection` value when omitted (see `create_reader_session`).
#[derive(Debug, Default)]
pub struct Window {
    /// RFC3339 lower bound (inclusive).
    pub start: Option<String>,
    /// RFC3339 upper bound (exclusive).
    pub end: Option<String>,
    /// Replay speed multiplier; `0` is "as fast as the source allows".
    pub speed: Option<f64>,
    /// Maximum frames to replay.
    pub limit: Option<i64>,
}

/// Open (create + start) a reader session for a profile, binding the profile's
/// preferred catalogue so the stream decodes. For Modbus profiles the same
/// catalogue also supplies the poll groups.
pub async fn open(
    app: tauri::AppHandle,
    profile_id: String,
    session_id: Option<String>,
    window: Window,
) -> Result<Value, String> {
    let settings = crate::settings::load_settings_sync(&app)?;
    let profile = settings
        .io_profiles
        .iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Profile '{profile_id}' not found"))?;

    // Read the preferred catalogue once: Modbus needs it for poll groups, and
    // every protocol needs it to decode.
    let catalog_toml = match &profile.preferred_catalog {
        Some(name) => {
            let name = crate::catalog::sanitise_catalog_filename(name)?;
            let path = std::path::PathBuf::from(&settings.decoder_dir).join(&name);
            let toml = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read catalog '{name}': {e}"))?;
            Some((path.to_string_lossy().into_owned(), toml))
        }
        None => None,
    };

    let modbus_polls = if profile.kind.starts_with("modbus") {
        let (_, toml) = catalog_toml.as_ref().ok_or_else(|| {
            "Modbus profile has no preferred_catalog — set one so poll groups can be built".to_string()
        })?;
        let polls = crate::io::build_polls_from_catalog(toml)?;
        if polls.is_empty() {
            return Err("Preferred catalog has no [frame.modbus.*] poll definitions".to_string());
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
        window.start,
        window.end,
        window.speed,
        window.limit,
        None,
        None,
        Some("mcp".to_string()),
        Some("mcp".to_string()),
        modbus_polls,
    )
    .await?;

    // Bind the catalogue before the source is started, so frames decode from the
    // first one rather than relying on a re-decode after the fact. This is also
    // what puts a path on `ActiveSessionInfo.catalog_path`, which every
    // session-aware panel mirrors — so a session surfaced by `attach_source`
    // arrives decoded instead of as a raw stream.
    let mut catalog_path = None;
    if let Some((path, toml)) = catalog_toml {
        match wiretap_catalog::Catalog::parse(&toml) {
            Ok(cat) => {
                crate::ws::dispatch::attach_catalog(&sid, Some(path.clone()), cat);
                catalog_path = Some(path);
            }
            // A broken catalogue must not cost you the session — the stream is
            // still useful undecoded, and the path is reported back as absent.
            Err(e) => tlog!("[mcp] open: catalog '{}' failed to parse: {}", path, e),
        }
    }

    // `create_reader_session` leaves playback sources stopped so the frontend
    // can register its frame listener first; headless there is nothing to race.
    // Only a stopped session is started — `start_session` is idempotent for
    // `Running` but would restart a `Paused` one, which an explicit session_id
    // can reach.
    let state = match crate::io::get_session_state(&sid).await {
        Some(crate::io::IOState::Stopped) | None => match crate::io::start_session(&sid).await {
            Ok(state) => state,
            Err(e) => {
                // Leave nothing behind holding the profile open: the session
                // would keep its "mcp" subscriber and never be reaped.
                let _ = crate::io::destroy_session(&sid, false).await;
                return Err(e);
            }
        },
        Some(state) => state,
    };

    spawn_keepalive(sid.clone());

    Ok(json!({
        "session_id": sid,
        "profile_id": profile_id,
        "state": state,
        "catalog_path": catalog_path,
        "capabilities": capabilities,
    }))
}
