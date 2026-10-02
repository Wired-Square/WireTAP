use std::collections::HashMap;

use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager};

use super::roster::{emit_open_apps_changed, subscriber_count_for_session, subscribers_for_session, APP_REGISTRY};
use super::session::{
    destroy_session, each_idle_session, emit_joiner_count_change, pause_suspended_session, session_states,
};
use super::wake::update_wake_lock;

/// Heartbeat timeout - listeners that haven't sent a heartbeat in this time are considered stale.
/// Set to 30s (up from 10s) to tolerate WKWebView timer throttling during display sleep.
/// The WS connection timeout in ws/server.rs is derived from this (2x) so the socket
/// outlives IO suspension and a display-sleep wake resumes without a resubscribe.
pub const HEARTBEAT_TIMEOUT_SECS: u64 = 30;
/// How often to check for stale subscribers
const HEARTBEAT_CHECK_INTERVAL_SECS: u64 = 5;
/// Grace period before destroying a session after all listeners go stale.
/// During this window the reader is paused (no frame emission) but the session
/// stays alive so it can resume if heartbeats return (e.g., after display wake).
const SUSPENSION_GRACE_PERIOD_SECS: u64 = 300; // 5 minutes

// ============================================================================
// WebView Health Monitoring (detects WKWebView content process jettison)
// ============================================================================

/// How long after suspension before we start probing the WebView (seconds).
/// Gives time for normal display-sleep recovery via visibilitychange heartbeats.
const PROBE_START_DELAY_SECS: u64 = 15;

/// Number of consecutive pings with no pong before triggering recovery.
/// At one ping per watchdog tick (5s), this is 30s of probing.
const PROBE_MAX_MISSES: u64 = 6;

/// App handle for the watchdog to access WebView windows.
pub(super) static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// Root URL of the dashboard webview, captured once at startup while the content
/// process is known-alive. Recovery navigates here instead of reading the live
/// `webview.url()` getter: once macOS jettisons the content process, wry's getter
/// unwraps `URL()` == None and panics — and that panic lands on the Cocoa main
/// thread, where the recovery task's `catch_unwind` cannot reach it, so it takes
/// the whole app down. `navigate()` to a known URL string never touches the dead
/// getter and is exactly what relaunches the content process.
static DASHBOARD_ROOT_URL: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// WebView health probing state.
struct WebViewHealthState {
    probing: bool,
    probe_started_at: Option<std::time::Instant>,
    probe_counter: u64,
    last_pong_counter: u64,
    reload_in_progress: bool,
    /// Set on recovery, cleared when frontend reads it.
    recovery_occurred: bool,
}

static WEBVIEW_HEALTH: Lazy<std::sync::Mutex<WebViewHealthState>> = Lazy::new(|| {
    std::sync::Mutex::new(WebViewHealthState {
        probing: false,
        probe_started_at: None,
        probe_counter: 0,
        last_pong_counter: 0,
        reload_in_progress: false,
        recovery_occurred: false,
    })
});

/// Called by the frontend in response to a health ping from the watchdog.
#[tauri::command]
pub fn webview_health_pong(counter: u64) {
    if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
        state.last_pong_counter = counter;
    }
}

/// Check whether a recovery occurred (one-shot: cleared after reading).
#[tauri::command]
pub fn check_recovery_occurred() -> bool {
    WEBVIEW_HEALTH
        .lock()
        .map(|mut s| {
            let occurred = s.recovery_occurred;
            s.recovery_occurred = false;
            occurred
        })
        .unwrap_or(false)
}

/// Probe the WebView to determine if the content process is still alive.
/// Called every watchdog tick while any session is suspended.
async fn check_webview_health() {
    let app = match APP_HANDLE.get() {
        Some(a) => a,
        None => return,
    };

    // Check if any session is in the suspension grace period
    let any_suspended_long_enough = {
        let now = std::time::Instant::now();
        let delay = std::time::Duration::from_secs(PROBE_START_DELAY_SECS);
        session_states().values().any(|s| {
            s.suspended_at
                .map(|at| now.duration_since(at) > delay)
                .unwrap_or(false)
        })
    };

    if !any_suspended_long_enough {
        // No sessions have been suspended long enough — reset probing
        if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
            if state.probing {
                tlog!("[webview health] No suspended sessions — stopping probes");
                state.probing = false;
                state.probe_started_at = None;
                state.probe_counter = 0;
                state.last_pong_counter = 0;
            }
        }
        return;
    }

    let mut should_recover = false;

    if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
        if state.reload_in_progress {
            return; // Recovery already in progress
        }

        if !state.probing {
            // Start probing
            tlog!("[webview health] Starting content process probes");
            state.probing = true;
            state.probe_started_at = Some(std::time::Instant::now());
            state.probe_counter = 0;
            state.last_pong_counter = 0;
        }

        // Send a ping via eval()
        state.probe_counter += 1;
        let counter = state.probe_counter;
        let misses = counter.saturating_sub(state.last_pong_counter);

        if misses > PROBE_MAX_MISSES {
            let rss = get_rss_mb().map(|m| format!("{:.1} MB", m)).unwrap_or_else(|| "unknown".to_string());
            tlog!(
                "[webview health] {} pings with no pong — content process appears dead (RSS: {})",
                misses, rss
            );
            should_recover = true;
        } else {
            // Send ping to the dashboard WebView
            let js = format!(
                "if(window.__TAURI_INTERNALS__){{window.__TAURI_INTERNALS__.invoke('webview_health_pong',{{counter:{}}})}}",
                counter
            );
            if let Some(window) = app.get_webview_window("dashboard") {
                let _ = window.eval(&js);
                tlog!(
                    "[webview health] Sent ping #{}, last pong={}, misses={}",
                    counter, state.last_pong_counter, misses
                );
            }
        }
    }

    if should_recover {
        trigger_webview_recovery(app).await;
    }
}

/// Reload the WebView page to recover from a content process jettison.
async fn trigger_webview_recovery(app: &AppHandle) {
    // Set flags
    if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
        if state.reload_in_progress {
            return;
        }
        state.reload_in_progress = true;
        state.recovery_occurred = true;
    }

    tlog!("[webview recovery] Content process appears dead — triggering reload");

    // Small delay to let any in-flight IPC settle
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Navigate to the root URL captured at startup (fresh navigation, safer than
    // reload()). We deliberately do NOT read window.url() here: on a jettisoned
    // content process wry's url() getter unwraps URL() == None and panics on the
    // Cocoa main thread — uncatchable from this task and fatal to the app.
    // navigate() with a known URL string never touches the dead getter and is
    // what relaunches the content process.
    if let Some(window) = app.get_webview_window("dashboard") {
        let target = DASHBOARD_ROOT_URL
            .get()
            .cloned()
            .unwrap_or_else(|| "tauri://localhost/".to_string());
        match target.parse() {
            Ok(url) => match window.navigate(url) {
                Ok(()) => tlog!("[webview recovery] navigate() to {} succeeded", target),
                Err(e) => tlog!("[webview recovery] navigate() to {} failed: {}", target, e),
            },
            Err(e) => tlog!("[webview recovery] could not parse recovery URL '{}': {}", target, e),
        }
    } else {
        tlog!("[webview recovery] No dashboard window found");
    }

    // Wait for the page to load, then reset probing state
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    if let Ok(mut state) = WEBVIEW_HEALTH.lock() {
        state.reload_in_progress = false;
        state.probing = false;
        state.probe_started_at = None;
        state.probe_counter = 0;
        state.last_pong_counter = 0;
    }
    tlog!("[webview recovery] Recovery complete — probing state reset");
}

/// Clean up stale subscribers from all sessions.
/// Called periodically by the watchdog task.
///
/// When all listeners go stale, the session is NOT destroyed immediately.
/// Instead the reader is paused and a grace period starts. This tolerates
/// WKWebView timer throttling during display sleep / App Nap. If heartbeats
/// resume within the grace period, the session is resumed (see `register_subscriber`).
/// Only after `SUSPENSION_GRACE_PERIOD_SECS` does the watchdog destroy the session.
///
/// Returns a list of (session_id, removed_count, remaining_count) for sessions that had stale subscribers.
pub async fn cleanup_stale_subscribers() -> Vec<(String, usize, usize)> {
    let mut results = Vec::new();
    let mut sessions_to_destroy: Vec<String> = Vec::new();
    let mut sessions_to_pause: Vec<String> = Vec::new();

    let now = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(HEARTBEAT_TIMEOUT_SECS);
    let grace = std::time::Duration::from_secs(SUSPENSION_GRACE_PERIOD_SECS);

    // Phase 1: Evict stale ATTACHED app instances from the registry. Unattached
    // instances have no WS heartbeat path (no channel subscription), so they are
    // NOT evicted on staleness — window-close pruning reaps those. An attached
    // instance implies its session is not suspended (attach clears suspended_at),
    // so this only affects live sessions. Returns affected session → removed count.
    let mut affected: HashMap<String, usize> = HashMap::new();
    {
        let Ok(mut reg) = APP_REGISTRY.lock() else { return results };
        let stale: Vec<String> = reg
            .values()
            .filter(|a| a.session_id.is_some() && now.duration_since(a.last_heartbeat) > timeout)
            .map(|a| a.instance_id.clone())
            .collect();
        for id in stale {
            if let Some(inst) = reg.remove(&id) {
                let sid = inst.session_id.unwrap_or_default();
                tlog!(
                    "[reader] Removing stale subscriber '{}' from session '{}' (no heartbeat)",
                    id, sid
                );
                *affected.entry(sid).or_insert(0) += 1;
            }
        }
    } // APP_REGISTRY lock released
    if !affected.is_empty() {
        emit_open_apps_changed();
    }

    // Phase 2: grace-destroy already-suspended sessions and suspend any session that
    // just lost its last subscriber.
    let after_counts: Vec<_> = affected
        .iter()
        .map(|(sid, removed)| (sid, *removed, subscriber_count_for_session(sid)))
        .collect();
    {
        let mut sessions = session_states();

        // Grace-period expiry for already-suspended sessions.
        for (session_id, session) in sessions.iter() {
            if let Some(suspended_at) = session.suspended_at {
                if now.duration_since(suspended_at) > grace {
                    // Don't destroy if a WebView health probe or recovery is in progress
                    let skip_destroy = WEBVIEW_HEALTH
                        .lock()
                        .map(|s| s.probing || s.reload_in_progress)
                        .unwrap_or(false);
                    if skip_destroy {
                        tlog!(
                            "[reader] Session '{}' exceeded grace period but WebView recovery in progress — skipping destroy",
                            session_id
                        );
                    } else {
                        tlog!(
                            "[reader] Session '{}' exceeded suspension grace period ({:?}), will destroy",
                            session_id,
                            now.duration_since(suspended_at)
                        );
                        sessions_to_destroy.push(session_id.clone());
                    }
                }
            }
        }

        // Suspend sessions whose last subscriber just went stale.
        for (sid, removed_count, after_count) in after_counts {
            let Some(session) = sessions.get_mut(sid) else { continue };
            results.push((sid.clone(), removed_count, after_count));

            // Emit joiner count change (sync - no specific subscriber)
            emit_joiner_count_change(sid, after_count, None, None, None);

            // If no subscribers left, enter suspension grace period instead of destroying
            if after_count == 0 && session.suspended_at.is_none() {
                tlog!(
                    "[reader] Session '{}' has no listeners left — entering suspension grace period ({}s)",
                    sid, SUSPENSION_GRACE_PERIOD_SECS
                );
                session.suspended_at = Some(now);

                // Pause the reader to stop frame emission (reduces IPC pressure
                // while the WebView is throttled).
                sessions_to_pause.push(sid.clone());
            }
        }
    } // Lock released here

    // Phase 2a: Pause suspended sessions, off the watchdog: one may be mid-open.
    for session_id in sessions_to_pause {
        tauri::async_runtime::spawn(async move {
            tlog!("[reader watchdog] Pausing suspended session '{}'", session_id);
            if let Err(e) = pause_suspended_session(&session_id).await {
                tlog!("[reader watchdog] Failed to pause session '{}': {}", session_id, e);
            }
        });
    }

    // Phase 2b: Destroy sessions that exceeded the grace period
    for session_id in sessions_to_destroy {
        tlog!("[reader watchdog] Destroying session '{}' (grace period expired)", session_id);
        if let Err(e) = destroy_session(&session_id, false).await {
            tlog!("[reader watchdog] Failed to destroy session '{}': {}", session_id, e);
        }
    }

    results
}

/// How often to log session status (seconds)
const STATUS_LOG_INTERVAL_SECS: u64 = 60;

/// Get process RSS (Resident Set Size) in MB using platform-specific APIs.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn get_rss_mb() -> Option<f64> {
    use std::mem;

    #[repr(C)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: [u32; 2],   // time_value_t
        system_time: [u32; 2], // time_value_t
        policy: i32,
        suspend_count: i32,
    }

    extern "C" {
        fn mach_task_self() -> u32;
        fn task_info(
            target_task: u32,
            flavor: u32,
            task_info_out: *mut MachTaskBasicInfo,
            task_info_out_count: *mut u32,
        ) -> i32;
    }

    const MACH_TASK_BASIC_INFO: u32 = 20;
    let mut info: MachTaskBasicInfo = unsafe { mem::zeroed() };
    let mut count = (mem::size_of::<MachTaskBasicInfo>() / mem::size_of::<u32>()) as u32;

    let kr = unsafe { task_info(mach_task_self(), MACH_TASK_BASIC_INFO, &mut info, &mut count) };
    if kr == 0 {
        Some(info.resident_size as f64 / (1024.0 * 1024.0))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn get_rss_mb() -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if line.starts_with("VmRSS:") {
            let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
            return Some(kb / 1024.0);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn get_rss_mb() -> Option<f64> {
    None // TODO: use GetProcessMemoryInfo if needed
}

/// Log current session status (for debugging)
async fn log_session_status() {
    let lines = each_idle_session(|session_id, session| {
        let state = session.source.state().name();
        let subscribers = subscribers_for_session(session_id);
        let subscriber_ids: Vec<&str> = subscribers.iter().map(|s| s.subscriber_id.as_str()).collect();
        let sources = if session.source_names.is_empty() {
            String::new()
        } else {
            format!(", sources={:?}", session.source_names)
        };
        let suspended = match session_states().get(session_id).and_then(|s| s.suspended_at) {
            Some(at) => format!(", SUSPENDED for {:?}", at.elapsed()),
            None => String::new(),
        };
        format!(
            "'{}': state={}, listeners={} {:?}{}{}",
            session_id,
            state,
            subscriber_ids.len(),
            subscriber_ids,
            sources,
            suspended
        )
    });
    let running_queries = crate::apiclient::running_queries().await;

    if lines.is_empty() && running_queries.is_empty() {
        return; // Don't log if nothing active
    }

    tlog!("[session status] ========== Active Sessions ==========");
    for line in lines {
        tlog!("[session status]   {}", line);
    }
    if !running_queries.is_empty() {
        tlog!("[session status] ---------- Running Queries -----------");
        for (id, query) in running_queries {
            let elapsed = query.started_at.elapsed().as_secs();
            tlog!(
                "[session status]   '{}': type={}, profile={}, running for {}s",
                id, query.query_type, query.profile_id, elapsed
            );
        }
    }
    if let Some(rss_mb) = get_rss_mb() {
        tlog!("[session status]   Process RSS: {:.1} MB", rss_mb);
    }
    tlog!("[session status] =====================================");
}

/// Start the heartbeat watchdog task.
/// This runs in the background and periodically cleans up stale subscribers,
/// probes WebView health, and logs session status.
pub fn start_heartbeat_watchdog(app: AppHandle) {
    // Capture the dashboard root URL once, now, while the content process is
    // alive — recovery reuses it instead of calling the live url() getter (which
    // panics on a jettisoned content process). This runs on the main thread
    // during setup, so the catch_unwind here genuinely guards wry's url() unwrap.
    if let Some(window) = app.get_webview_window("dashboard") {
        let captured = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            window.url().ok().map(|mut u| {
                u.set_path("/");
                u.set_query(None);
                u.set_fragment(None);
                u.to_string()
            })
        }))
        .ok()
        .flatten();
        if let Some(root) = captured {
            tlog!("[webview recovery] Captured dashboard root URL: {}", root);
            let _ = DASHBOARD_ROOT_URL.set(root);
        }
    }

    APP_HANDLE.set(app).ok();
    tauri::async_runtime::spawn(async {
        let cleanup_interval = std::time::Duration::from_secs(HEARTBEAT_CHECK_INTERVAL_SECS);
        let status_interval = STATUS_LOG_INTERVAL_SECS / HEARTBEAT_CHECK_INTERVAL_SECS;
        let mut tick_count: u64 = 0;

        loop {
            tokio::time::sleep(cleanup_interval).await;
            tick_count += 1;

            // Cleanup stale subscribers every tick
            let results = cleanup_stale_subscribers().await;
            for (session_id, removed, remaining) in results {
                tlog!(
                    "[reader watchdog] Session '{}': removed {} stale subscribers, {} remaining",
                    session_id, removed, remaining
                );
            }

            // Probe WebView health (detects content process jettison)
            check_webview_health().await;

            // Update wake lock based on session state and settings
            update_wake_lock().await;

            // Log session status every STATUS_LOG_INTERVAL_SECS
            if tick_count % status_interval == 0 {
                log_session_status().await;
            }
        }
    });
}
