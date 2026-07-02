// src-tauri/src/telemetry.rs
//
// Backend-side anonymous usage-analytics telemetry. Emits Sentry *structured
// logs* over native HTTPS from Rust — bypassing the webview CSP and the flush/
// lifecycle quirks that made frontend emission unreliable. This is a
// logs-only client (error/panic events are dropped in `before_send`); crash
// reporting stays in the frontend `@sentry/react` SDK, gated on its own consent.
//
// Consent + the anonymous install id are cached (mirroring the `LOG_LEVEL`
// atomic in `logging.rs`) and refreshed whenever settings save, so the emit
// path never touches disk — the common (opted-out, default) path is a single
// relaxed atomic load. Logs carry only low-cardinality, non-identifying values:
// the event name, the feature (a source `kind` or panel id), the OS, and the
// anonymous install id as `user.id` (so "unique users" works in the explorer).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use tauri::AppHandle;

use crate::settings::{self, AppSettings};

/// Holds the Sentry client guard for the process lifetime (dropping it flushes
/// and shuts the client down, so it must stay alive).
static GUARD: OnceLock<sentry::ClientInitGuard> = OnceLock::new();
/// Cached usage-analytics consent — read on every emit, so the opted-out path
/// stays disk-free.
static USAGE_ENABLED: AtomicBool = AtomicBool::new(false);
/// Cached anonymous install id (set once by the frontend, stable thereafter).
static INSTALL_ID: RwLock<String> = RwLock::new(String::new());

/// Initialise the backend Sentry client for usage logging. Idempotent — the
/// first non-empty DSN wins. The DSN is handed over from the frontend (Vite
/// `VITE_SENTRY_DSN`) so it stays in `.env`, never in source; release/environment
/// are derived from the app config.
pub fn init(app: &AppHandle, dsn: String) {
    if dsn.is_empty() || GUARD.get().is_some() {
        return;
    }

    let release = app.config().version.clone().map(std::borrow::Cow::Owned);
    let environment = if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    };

    let options = sentry::ClientOptions {
        release,
        environment: Some(environment.into()),
        enable_logs: true,
        // Logs-only client: drop every error/transaction event so backend
        // panics are never reported without the separate crash-report consent.
        before_send: Some(Arc::new(|_event| None)),
        ..Default::default()
    };

    let _ = GUARD.set(sentry::init((dsn, options)));
    if let Ok(s) = settings::load_settings_sync(app) {
        refresh_consent(&s);
    }
    tlog!("[telemetry] backend Sentry logging initialised");
}

/// Refresh the cached consent flag + install id from settings. Called at init
/// and on every settings save, so the emit path never re-reads the file.
pub fn refresh_consent(settings: &AppSettings) {
    USAGE_ENABLED.store(settings.usage_analytics_enabled, Ordering::Relaxed);
    if let Ok(mut id) = INSTALL_ID.write() {
        if *id != settings.install_id {
            *id = settings.install_id.clone();
        }
    }
}

/// Record an anonymous feature-usage event as a Sentry log. No-op unless the
/// user has opted into usage analytics. `feature` must be low-cardinality and
/// non-identifying (a source `kind` or a panel id).
pub fn emit_feature_usage(event: &str, feature: &str) {
    if !USAGE_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let user_id = INSTALL_ID.read().map(|s| s.clone()).unwrap_or_default();

    // Local breadcrumb (Rust log) so usage events can be confirmed firing
    // without depending on Sentry.
    tlog!("[telemetry] feature_usage: {} ({})", event, feature);

    let os = std::env::consts::OS;
    // The "what" attribute is named per event so queries group on an intuitive
    // key — `source` for IO sources, `app` for panels. The macro needs a
    // compile-time key, hence the branch.
    match event {
        "app_open" => sentry::logger_info!(
            event = event,
            app = feature,
            os = os,
            user.id = user_id.as_str(),
            "feature_usage: {}",
            event
        ),
        _ => sentry::logger_info!(
            event = event,
            source = feature,
            os = os,
            user.id = user_id.as_str(),
            "feature_usage: {}",
            event
        ),
    }
}

/// Command: initialise backend telemetry with the DSN supplied by the frontend.
#[tauri::command]
pub fn telemetry_init(app: AppHandle, dsn: String) {
    init(&app, dsn);
}

/// Command: record a frontend-originated usage event (e.g. app-panel opens).
#[tauri::command]
pub fn track_feature_usage(event: String, feature: String) {
    emit_feature_usage(&event, &feature);
}
