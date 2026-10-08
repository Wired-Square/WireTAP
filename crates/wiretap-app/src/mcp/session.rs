// Copyright 2026 Wired Square Pty Ltd

//! Rust-native session open for the MCP server. Mirrors the frontend's open
//! flow (build Modbus poll groups from the profile's catalog, then create the
//! reader session) without needing an app window. A keep-alive task touches the
//! MCP subscriber so the session isn't reaped by the heartbeat watchdog.

use std::time::Duration;

use serde_json::{json, Value};

/// The MCP's subscriber on `session_id`. A subscriber is on one session at a time,
/// and an agent may hold several.
pub fn subscriber_for(session_id: &str) -> String {
    format!("mcp_{session_id}")
}

/// Touch the MCP subscriber every 10s so the heartbeat watchdog doesn't reap a
/// headless session. Once the session is gone, drops the subscriber from the roster.
pub(super) fn spawn_keepalive(session_id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if crate::io::get_session_state(&session_id).await.is_none() {
                crate::io::forget_detached_app(&subscriber_for(&session_id));
                break;
            }
            crate::io::touch_subscriber_heartbeats(std::slice::from_ref(&session_id)).await;
        }
    });
}

/// A recorded source replays its whole archive from the head unless bounded.
/// Mirrors the frontend's playback controls; each falls back to the profile's
/// own `connection` value when omitted (see `open_session`).
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

/// Everything the caller can vary about an open beyond the profile itself.
#[derive(Debug, Default)]
pub struct OpenOptions {
    pub window: Window,
    /// Modbus only: poll these ranges rather than a catalogue's registers.
    pub modbus_ranges: Option<crate::io::ModbusRangeSpec>,
}

/// Open (create + start) a reader session for a profile, binding the profile's
/// preferred catalogue so the stream decodes. For Modbus profiles the poll groups
/// come from that catalogue, or from an explicit range spec when the device has
/// no decoder yet.
pub async fn open(
    app: tauri::AppHandle,
    profile_id: String,
    session_id: Option<String>,
    opts: OpenOptions,
) -> Result<Value, String> {
    let OpenOptions {
        window,
        modbus_ranges,
    } = opts;
    let settings = crate::settings::load_settings_sync(&app)?;
    let profile = settings.profile(&profile_id)?;

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
        let polls = match (&modbus_ranges, catalog_toml.as_ref()) {
            // An explicit range spec wins over a catalogue: that is how you
            // re-sweep a device whose catalogue you already know is incomplete.
            (Some(spec), _) => crate::io::build_polls_from_ranges(spec)?,
            (None, Some((_, toml))) => {
                let polls = crate::io::build_polls_from_catalog(toml)?;
                if polls.is_empty() {
                    return Err(
                        "Preferred catalog has no [frame.modbus.*] poll definitions".to_string()
                    );
                }
                polls
            }
            // Deliberately not a default sweep. Silently probing an unknown
            // industrial bus on an agent's behalf is not a safe default; make
            // the caller say what to poll.
            (None, None) => {
                return Err(format!(
                    "Modbus profile '{profile_id}' has no preferred_catalog and no register_ranges \
                     — pass register_ranges to poll an address range, or bind a catalogue with \
                     set_profile_catalog"
                ))
            }
        };
        Some(serde_json::to_string(&polls).map_err(|e| e.to_string())?)
    } else {
        if modbus_ranges.is_some() {
            return Err("register_ranges only applies to Modbus profiles".to_string());
        }
        None
    };

    let sid = match session_id {
        Some(sid) => sid,
        None => crate::sessions::mint_session_id(crate::sessions::session_id_prefix([profile], None)).await,
    };
    // Connect-only, so the catalogue is bound before the first frame.
    let opts = crate::sessions::OpenSessionOptions {
        source_id: Some(profile_id.clone()),
        start_time: window.start,
        end_time: window.end,
        speed: window.speed,
        limit: window.limit,
        modbus_polls,
        connect_only: Some(true),
        ..Default::default()
    };
    let opened = crate::sessions::open_from(&app, Some(&sid), &subscriber_for(&sid), Some("mcp"), opts)
        .await
        .map_err(|e| e.to_string())?;
    let capabilities = opened.registration.capabilities;
    spawn_keepalive(sid.clone());

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

    // Only a stopped session is started — `start_session` is idempotent for
    // `Running` but would restart a `Paused` one, which an explicit session_id
    // can reach.
    let state = match crate::io::get_session_state(&sid).await {
        Some(crate::io::IOState::Stopped) | None => match crate::io::start_session(&sid).await {
            Ok(state) => state,
            Err(e) => {
                // Leave nothing behind holding the profile open: the session
                // would keep its MCP subscriber and never be reaped.
                let _ = crate::io::destroy_session(&sid, false).await;
                return Err(e);
            }
        },
        Some(state) => state,
    };

    Ok(json!({
        "session_id": sid,
        "profile_id": profile_id,
        "state": state,
        "catalog_path": catalog_path,
        "capabilities": capabilities,
    }))
}
