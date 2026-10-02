use std::sync::RwLock;

#[cfg(not(target_os = "ios"))]
use keepawake::{Builder as KeepAwakeBuilder, KeepAwake};
use once_cell::sync::Lazy;

#[cfg(not(target_os = "ios"))]
use super::{roster::subscriber_count_for_session, session::each_idle_session, IOState};

// ============================================================================
// Wake Lock Management (prevents system sleep during active sessions)
// ============================================================================

/// Settings for wake lock behaviour
#[derive(Clone, Debug)]
pub struct WakeSettings {
    pub prevent_idle_sleep: bool,
    pub keep_display_awake: bool,
}

impl Default for WakeSettings {
    fn default() -> Self {
        Self {
            prevent_idle_sleep: true,
            keep_display_awake: false,
        }
    }
}

/// Cached wake settings (updated by frontend when settings change)
static WAKE_SETTINGS: Lazy<RwLock<WakeSettings>> = Lazy::new(|| RwLock::new(WakeSettings::default()));

/// Active wake lock guard (holds system awake while Some)
#[cfg(not(target_os = "ios"))]
static WAKE_LOCK: Lazy<std::sync::Mutex<Option<KeepAwake>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

/// Update the cached wake settings (called by Tauri command when settings change)
pub fn set_wake_settings(prevent_idle_sleep: bool, keep_display_awake: bool) {
    if let Ok(mut settings) = WAKE_SETTINGS.write() {
        settings.prevent_idle_sleep = prevent_idle_sleep;
        settings.keep_display_awake = keep_display_awake;
        tlog!(
            "[wake] Settings updated: prevent_idle_sleep={}, keep_display_awake={}",
            prevent_idle_sleep, keep_display_awake
        );
    }
}

/// Update the wake lock based on current session state and settings.
/// Called periodically by the heartbeat watchdog.
#[cfg(not(target_os = "ios"))]
pub(super) async fn update_wake_lock() {
    // Read current settings
    let settings = match WAKE_SETTINGS.read() {
        Ok(s) => s.clone(),
        Err(_) => return,
    };

    // If both settings are disabled, ensure no wake lock is held
    if !settings.prevent_idle_sleep && !settings.keep_display_awake {
        if let Ok(mut guard) = WAKE_LOCK.lock() {
            if guard.is_some() {
                *guard = None;
                tlog!("[wake] Released wake lock (settings disabled)");
            }
        }
        return;
    }

    // Check if any session is actively running with listeners
    let any_watched = each_idle_session(|session_id, session| {
        matches!(session.source.state(), IOState::Running) && subscriber_count_for_session(session_id) > 0
    })
    .contains(&true);

    // A capture that is actively recording keeps the machine awake even with no
    // UI subscribers. Otherwise closing or suspending the last panel drops the
    // wake lock mid-capture, the display sleeps, and on macOS the WebView content
    // process can be jettisoned — interrupting the recording and crashing the app
    // on the recovery path.
    let any_active = any_watched || crate::capture_store::has_streaming_captures();

    // Update wake lock based on session state
    if let Ok(mut guard) = WAKE_LOCK.lock() {
        match (any_active, guard.is_some()) {
            (true, false) => {
                // Need to acquire wake lock
                match KeepAwakeBuilder::default()
                    .idle(settings.prevent_idle_sleep)
                    .display(settings.keep_display_awake)
                    .reason("WireTAP session active")
                    .app_name("WireTAP")
                    .app_reverse_domain("com.wiredsquare.wiretap")
                    .create()
                {
                    Ok(lock) => {
                        *guard = Some(lock);
                        tlog!(
                            "[wake] Acquired wake lock (idle={}, display={})",
                            settings.prevent_idle_sleep, settings.keep_display_awake
                        );
                    }
                    Err(e) => {
                        tlog!("[wake] Failed to acquire wake lock: {:?}", e);
                    }
                }
            }
            (false, true) => {
                // Release wake lock
                *guard = None;
                tlog!("[wake] Released wake lock (no active sessions)");
            }
            _ => {
                // No change needed
            }
        }
    }
}

/// iOS stub - wake lock not supported
#[cfg(target_os = "ios")]
pub(super) async fn update_wake_lock() {
    // No-op on iOS - system handles power management differently
}
