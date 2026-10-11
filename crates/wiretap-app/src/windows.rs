// Copyright 2026 Wired Square Pty Ltd

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(not(target_os = "ios"))]
use tauri::{WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(not(target_os = "ios"))]
use crate::{io, store_manager};

// Track which window has the Settings panel open (singleton behavior)
#[derive(Default)]
pub(crate) struct SettingsWindowState(Mutex<Option<String>>);

// Window configuration helper (desktop only - multi-window support)
#[cfg(not(target_os = "ios"))]
struct WindowConfig {
    title: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

#[cfg(not(target_os = "ios"))]
fn get_window_config(label: &str) -> WindowConfig {
    match label {
        "catalog-editor" => WindowConfig {
            title: "📘 Catalog Editor",
            width: 1200.0,
            height: 800.0,
            min_width: 1000.0,
            min_height: 600.0,
        },
        "decoder" => WindowConfig {
            title: "📡 CAN Decoder",
            width: 1000.0,
            height: 700.0,
            min_width: 800.0,
            min_height: 500.0,
        },
        "discovery" => WindowConfig {
            title: "🔍 CAN Discovery",
            width: 1100.0,
            height: 750.0,
            min_width: 900.0,
            min_height: 600.0,
        },
        "frame-calculator" => WindowConfig {
            title: "🧮 Frame Calculator",
            width: 800.0,
            height: 600.0,
            min_width: 700.0,
            min_height: 500.0,
        },
        "settings" => WindowConfig {
            title: "⚙️ Settings",
            width: 1000.0,
            height: 720.0,
            min_width: 800.0,
            min_height: 600.0,
        },
        _ => WindowConfig {
            title: "WireTAP",
            width: 900.0,
            height: 600.0,
            min_width: 700.0,
            min_height: 500.0,
        },
    }
}

// Emit an event to the currently focused window only (desktop only - multi-window support)
#[cfg(not(target_os = "ios"))]
pub(crate) fn emit_to_focused_window<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Some(window) = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
    {
        let _ = app.emit_to(window.label(), event, payload);
    }
}

// Open or focus a panel in the currently focused window (desktop only - multi-window support)
#[cfg(not(target_os = "ios"))]
pub(crate) fn open_panel_in_focused_window(app: &AppHandle, panel_id: &str) {
    emit_to_focused_window(app, "menu-open-panel", panel_id);
}

// Open Settings panel with singleton behavior (only one instance across all windows)
pub(crate) fn open_settings_singleton(app: &AppHandle, state: &State<SettingsWindowState>) {
    let mut settings_window = state.0.lock().unwrap();

    // Check if Settings is already open in a window
    if let Some(label) = settings_window.as_ref() {
        if let Some(_window) = app.get_webview_window(label) {
            // Window exists - focus it and tell it to focus Settings panel
            #[cfg(not(target_os = "ios"))]
            let _ = _window.set_focus();
            let _ = app.emit_to(label, "menu-focus-panel", "settings");
            return;
        }
        // Window no longer exists - clear tracking
        *settings_window = None;
    }

    // Open Settings in focused window and track it
    let target_window = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .map(|w| w.label().to_string())
        // Fallback to dashboard window if no window reports as focused (Windows startup race)
        .or_else(|| {
            app.get_webview_window("dashboard")
                .map(|w| w.label().to_string())
        });

    if let Some(label) = target_window {
        *settings_window = Some(label.clone());
        let _ = app.emit_to(&label, "menu-open-panel", "settings");
    }
}

/// Clear the Settings panel tracking when the panel is closed.
/// This allows Settings to be opened in a different window.
#[tauri::command]
pub fn settings_panel_closed(state: State<SettingsWindowState>) {
    *state.0.lock().unwrap() = None;
}

/// Open the Settings panel with singleton behavior.
/// If Settings is already open in another window, focuses that window instead.
/// Called by frontend (e.g., LogoMenu) to ensure singleton behavior.
#[tauri::command]
pub fn open_settings_panel(app: AppHandle, state: State<SettingsWindowState>) {
    open_settings_singleton(&app, &state);
}

/// Create a new main window with the specified label.
///
/// This command spawns window creation in a background task and returns immediately.
/// On Windows, synchronous window creation can deadlock when called from a Tauri command
/// that's being awaited by the frontend, because window creation needs the UI thread.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub async fn create_main_window(app: AppHandle, label: String) -> Result<(), String> {
    // Check if window already exists
    if app.get_webview_window(&label).is_some() {
        return Ok(()); // Window already exists
    }

    // Spawn window creation on a background task to avoid blocking.
    // The run_on_main_thread() runs the closure on the main thread (required for window creation)
    // but doesn't block the command response.
    let app_for_spawn = app.clone();
    tauri::async_runtime::spawn(async move {
        // Clone again for the closure
        let app_for_window = app_for_spawn.clone();
        let label_for_window = label.clone();
        // Run window creation on the main thread
        let _ = app_for_spawn.run_on_main_thread(move || {
            // Check again inside the spawned closure - another task may have created
            // the window between the initial check and now (race condition)
            if app_for_window.get_webview_window(&label_for_window).is_some() {
                return; // Window already created by another call
            }
            let config = get_window_config("main");
            if let Err(e) = WebviewWindowBuilder::new(&app_for_window, &label_for_window, WebviewUrl::App("/".into()))
                .title(config.title)
                .inner_size(config.width, config.height)
                .min_inner_size(config.min_width, config.min_height)
                .center()
                .disable_drag_drop_handler()
                .accept_first_mouse(true)
                .build()
            {
                tlog!("[create_main_window] Failed to create window '{}': {}", label_for_window, e);
            }
        });
    });

    Ok(())
}

// iOS stub commands - menus/windows not available on iOS
#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn create_main_window(_app: AppHandle, _label: String) -> Result<(), String> {
    Ok(()) // No-op on iOS
}

/// Show the calling window and give it focus.
/// Called from the frontend inline script once the splash HTML is painted.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn show_current_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn show_current_window() {}

/// Restore dashboard window geometry from persisted state.
/// The window starts hidden (visible: false in tauri.conf.json) and is
/// shown by a frontend inline script once the splash HTML has rendered,
/// so it appears at the saved position with content already painted.
#[cfg(not(target_os = "ios"))]
pub(crate) fn restore_dashboard_geometry(app: &tauri::App) {
    let Some(window) = app.get_webview_window("dashboard") else {
        return;
    };
    let mut restored = false;

    if let Some(value) = store_manager::get("windows.state.dashboard") {
        if let Some(geom) = value.get("geometry") {
            let x = geom.get("x").and_then(|v| v.as_f64());
            let y = geom.get("y").and_then(|v| v.as_f64());
            let w = geom.get("width").and_then(|v| v.as_f64());
            let h = geom.get("height").and_then(|v| v.as_f64());

            if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, w, h) {
                let _ = window.set_size(tauri::LogicalSize::new(w, h));
                let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                restored = true;
            }
        }
    }

    if !restored {
        let _ = window.center();
    }
}

/// Handle window close events to prevent crashes on macOS 26.2+ (Tahoe).
/// Desktop only - iOS doesn't have multiple windows or hide().
#[cfg(not(target_os = "ios"))]
pub(crate) fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    // The crash occurs in WebKit::WebPageProxy::dispatchSetObscuredContentInsets()
    // when events are emitted to a WebView that is being destroyed.
    //
    // Strategy for decoder/discovery windows:
    // 1. Mark session as closing IMMEDIATELY to stop all event emissions
    // 2. Prevent the default close
    // 3. Stop the streaming session in background
    // 4. Wait for WebKit to process pending operations
    // 5. Destroy the window programmatically
    //
    // NOTE: This bypasses the JavaScript StopStreamDialog. For UX, if you want
    // to confirm with the user, you'd need to use a different approach.
    // When any window is destroyed, prune its open-app instances from the global
    // registry so the Session Manager graph (in other windows) drops its app nodes
    // and tears down any session it was the last subscriber on. (A hard crash that
    // fires no Destroyed event leaves the window's unattached nodes until restart —
    // the in-memory registry clears on relaunch.)
    if let WindowEvent::Destroyed = event {
        let label = window.label().to_string();
        tauri::async_runtime::spawn(async move {
            io::prune_window_sessions(&label).await;
        });
        return;
    }

    if let WindowEvent::CloseRequested { api, .. } = event {
        let label = window.label().to_string();
        // For decoder/discovery windows, do safe close with cleanup
        if label == "decoder" || label == "discovery" {
            // Check if we're already in the close process (prevents infinite loop)
            let is_first_close = io::mark_session_closing_sync(&label);
            if !is_first_close {
                // Second close request - let it through (this is our programmatic close)
                tlog!("[WindowEvent] Second close for '{}', allowing", label);
                return;
            }

            // Prevent the default close - we'll destroy manually
            api.prevent_close();

            let window_clone = window.clone();

            // Spawn async cleanup
            tauri::async_runtime::spawn(async move {
                tlog!("[WindowEvent] CloseRequested for '{}', stopping session", label);

                // Stop the streaming session - this waits for the task to finish
                let _ = io::stop_session(&label).await;

                // Destroy the session state
                let _ = io::destroy_session(&label, false).await;

                // Drop this window's open-app instances from the global registry
                // (it gets hidden, not destroyed, so no Destroyed event fires).
                io::prune_window_sessions(&label).await;

                // Wait for WebKit to process any pending IPC operations.
                // The session is stopped, so no new events will be emitted.
                // This delay lets the main run loop drain pending operations.
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                tlog!("[WindowEvent] Cleanup complete for '{}', hiding window", label);

                // Hide the window instead of destroying it.
                // On macOS Tahoe (26.2+), calling destroy() can crash in
                // WebKit::WebPageProxy::dispatchSetObscuredContentInsets()
                // even after stopping the session and waiting.
                // By hiding, the window stays in memory but is invisible.
                // It will be cleaned up when the app exits.
                if let Err(e) = window_clone.hide() {
                    tlog!("[WindowEvent] Failed to hide '{}': {:?}", label, e);
                }
            });
        }
    }
}
