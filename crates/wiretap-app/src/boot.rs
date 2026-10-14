// Copyright 2026 Wired Square Pty Ltd

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::settings::{self, AppSettings};
use crate::{
    capture_db, capture_store, catalog, credentials, dashboard_history, io, logging, mcp,
    store_manager, transmit_history, ws,
};

/// Something about startup the user must be told, surfaced via the
/// `app.startup_notices` WS command.
///
/// Two levels, because they read differently and must not be shown the same
/// way: a subsystem that died is a standing failure the user has to act on; a
/// migration that ran is finished news. Dressing the second as the first is how
/// people learn to dismiss the banner unread.
#[derive(Clone, serde::Serialize)]
pub(crate) struct StartupNotice {
    /// `"error"` or `"info"`.
    pub level: &'static str,
    pub message: String,
}

static STARTUP_NOTICES: once_cell::sync::Lazy<Mutex<Vec<StartupNotice>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));

fn record_startup(level: &'static str, message: String) {
    if let Ok(mut notices) = STARTUP_NOTICES.lock() {
        notices.push(StartupNotice { level, message });
    }
}

/// A subsystem is dead for this run and the user must be told.
pub(crate) fn record_startup_error(msg: String) {
    record_startup("error", msg);
}

/// Something changed that the user should know about; nothing is broken.
pub(crate) fn record_startup_notice(msg: String) {
    record_startup("info", msg);
}

pub(crate) fn startup_notices() -> Vec<StartupNotice> {
    STARTUP_NOTICES.lock().map(|n| n.clone()).unwrap_or_default()
}

/// The directories a boot reads, resolved once.
pub(crate) struct Paths {
    pub data: PathBuf,
    pub config: PathBuf,
    pub documents: Option<PathBuf>,
}

impl Paths {
    pub(crate) fn resolve(app: &AppHandle) -> Result<Self, String> {
        let path = app.path();
        Ok(Self {
            data: path.app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?,
            config: path.app_config_dir().map_err(|e| format!("Failed to get app config dir: {}", e))?,
            documents: path.document_dir().ok(),
        })
    }
}

/// Pipe `tracing` events from framelink (and any other crate that uses the
/// `tracing` macros) to stderr, gated by RUST_LOG. With RUST_LOG unset, only
/// WARN and above are shown.
pub(crate) fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .try_init();
}

/// Settings, logging, the UI store and the SQLite databases: the boot that
/// needs no tauri. Returns the settings and whether loading rewrote the file.
pub(crate) fn boot_core(paths: &Paths) -> Result<(AppSettings, bool), String> {
    // One read serves setup: it migrates and writes the file if it needs
    // it, and on first run creates the directories the catalogue cache scans.
    let loaded = settings::load_settings_at(&paths.config, paths.documents.as_deref());
    if let Err(e) = &loaded {
        tlog!("[setup] Failed to load settings during startup: {}", e);
    }
    let startup_settings = loaded.as_ref().map(|(s, _)| s);

    // Start file logging as early as possible.
    if let Ok(s) = startup_settings {
        dashboard_history::set_capacity(s.graph_buffer_size);
        logging::set_log_level(&s.log_level);
        if s.log_level != "off" {
            if let Some(doc_dir) = &paths.documents {
                let reports_dir = doc_dir.join("WireTAP").join("Reports");
                if let Err(e) = logging::init_file_logging(&reports_dir) {
                    tlog!("[setup] Failed to init file logging: {}", e);
                }
            }
        }
    }

    if let Err(e) = store_manager::initialise(&paths.data) {
        tlog!("[setup] Failed to initialise store manager: {}", e);
    }

    let clear_on_start = startup_settings.map_or(true, |s| s.clear_captures_on_start);
    if let Err(e) = capture_db::initialise(&paths.data, clear_on_start) {
        tlog!("[setup] Failed to initialise capture database: {}", e);
        record_startup_error(format!(
            "Capture database failed to initialise: {e}. Captures, Discovery \
             and capture playback will not work until this is resolved."
        ));
    }

    if let Err(e) = transmit_history::initialise(&paths.data) {
        tlog!("[setup] Failed to initialise transmit history database: {}", e);
        record_startup_error(format!(
            "Transmit history database failed to initialise: {e}."
        ));
    }

    // Always called — persistent (pinned) captures may survive clear_on_start.
    capture_store::hydrate_from_db();

    loaded
}

pub(crate) fn boot_desktop(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let loaded = Paths::resolve(app.handle())
        .inspect_err(|e| tlog!("[setup] {}", e))
        .and_then(|paths| boot_core(&paths));
    if let Ok((s, true)) = &loaded {
        settings::announce_saved(app.handle(), s);
    }
    let startup_settings = loaded.map(|(s, _)| s);

    #[cfg(not(target_os = "ios"))]
    crate::windows::restore_dashboard_geometry(app);

    #[cfg(not(target_os = "ios"))]
    crate::menu::setup_desktop_menus(app)?;

    io::set_app_handle(app.handle().clone());
    io::session_log::spawn_stats_sampler(app.handle().clone());

    // Start the heartbeat watchdog to clean up stale session joiners
    // and probe WebView health (detects content process jettison on macOS)
    io::start_heartbeat_watchdog(app.handle());

    match ws::server::WsServer::start() {
        Ok((port, _token)) => {
            tlog!("[ws] Binary transport server listening on 127.0.0.1:{}", port);
        }
        Err(e) => {
            tlog!("[ws] Failed to start binary transport server: {}", e);
        }
    }

    // Opt-in; a port conflict must not crash the app, so failures are logged
    // and swallowed.
    match &startup_settings {
        Ok(s) if s.mcp_server_enabled => {
            if let Err(e) = mcp::commands::start_from(app.handle(), s) {
                tlog!("[mcp] Failed to start: {}", e);
            }
        }
        _ => {}
    }

    // Drain pre-rebrand keyring entries into the current namespace.
    // Deliberately off this blocking path: keyring access is OS IPC
    // (and can prompt), while nothing needs it before first paint —
    // get_credential migrates any secret on its way to being used.
    if let Ok(s) = startup_settings {
        let profiles = s.io_profiles;
        tauri::async_runtime::spawn_blocking(move || {
            credentials::migrate_legacy_io_profile_credentials(&profiles);
        });
    }

    // Warm the backend-owned catalogue cache (and start watching the
    // decoder dir) now that settings have resolved, so the frontend's
    // first list_catalogs() is served from memory instead of racing a scan.
    catalog::start_catalog_cache(app.handle());

    Ok(())
}

pub(crate) fn on_run_event(_app: &AppHandle, event: tauri::RunEvent) {
    // macOS's Quit ends the loop with no ExitRequested, so this is the one event every quit reaches.
    if let tauri::RunEvent::Exit = event {
        if let Err(e) = store_manager::flush() {
            tlog!("[exit] Failed to save UI state: {}", e);
        }
        tauri::async_runtime::block_on(io::stop_all_sessions(std::time::Duration::from_secs(3)));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn quitting_saves_ui_state_still_waiting_out_its_debounce() {
        let source = include_str!("boot.rs");
        let run_event = &source[source.find("fn on_run_event").unwrap()..];
        let run_event = &run_event[..run_event.find("\n}\n").unwrap()];
        assert!(run_event.contains("store_manager::flush()"), "the exit hook does not flush the UI store");
    }
}
