mod buffer_store;
mod buffers;
mod catalog;
mod checksums;
mod credentials;
mod dbc_export;
mod dbquery;
mod framing;
mod io;
mod profile_tracker;
mod sessions;
mod settings;
mod store_manager;
mod transmit;

use std::sync::Mutex;
use tauri::{menu::*, AppHandle, Emitter, Manager, State, WebviewWindowBuilder, WebviewUrl, WindowEvent, Wry};

// Track which window has the Settings panel open (singleton behavior)
struct SettingsWindowState(Mutex<Option<String>>);

// Store references to dynamic menu items that need to be updated at runtime
struct SessionMenuItems {
    source: MenuItem<Wry>,
    play: MenuItem<Wry>,
    pause: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    detach: MenuItem<Wry>,
    stop_all: MenuItem<Wry>,
}

struct SessionMenuState(Mutex<Option<SessionMenuItems>>);

// Store reference to the bookmarks submenu for dynamic updates
struct BookmarksMenuState(Mutex<Option<Submenu<Wry>>>);

// Bookmark info received from frontend for menu display
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct BookmarkInfo {
    id: String,
    name: String,
}

// Window configuration helper
struct WindowConfig {
    title: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

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
            title: "CANdor",
            width: 900.0,
            height: 600.0,
            min_width: 700.0,
            min_height: 500.0,
        },
    }
}

// Emit an event to the currently focused window only
fn emit_to_focused_window<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Some(window) = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
    {
        let _ = app.emit_to(window.label(), event, payload);
    }
}

// Open or focus a panel in the currently focused window
fn open_panel_in_focused_window(app: &AppHandle, panel_id: &str) {
    emit_to_focused_window(app, "menu-open-panel", panel_id);
}

// Open Settings panel with singleton behavior (only one instance across all windows)
fn open_settings_singleton(app: &AppHandle, state: &State<SettingsWindowState>) {
    let mut settings_window = state.0.lock().unwrap();

    // Check if Settings is already open in a window
    if let Some(label) = settings_window.as_ref() {
        if let Some(window) = app.get_webview_window(label) {
            // Window exists - focus it and tell it to focus Settings panel
            let _ = window.set_focus();
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

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Clear the Settings panel tracking when the panel is closed.
/// This allows Settings to be opened in a different window.
#[tauri::command]
fn settings_panel_closed(state: State<SettingsWindowState>) {
    *state.0.lock().unwrap() = None;
}

/// Open the Settings panel with singleton behavior.
/// If Settings is already open in another window, focuses that window instead.
/// Called by frontend (e.g., LogoMenu) to ensure singleton behavior.
#[tauri::command]
fn open_settings_panel(app: AppHandle, state: State<SettingsWindowState>) {
    open_settings_singleton(&app, &state);
}

/// Update the Session menu state based on the focused app's session.
/// Called by the frontend when panel focus or session state changes.
#[tauri::command]
fn update_menu_session_state(
    state: State<SessionMenuState>,
    profile_name: Option<String>,
    is_streaming: bool,
    is_paused: bool,
    can_pause: bool,
    joiner_count: u32,
) {
    if let Some(items) = state.0.lock().unwrap().as_ref() {
        // Update source info item text
        let text = profile_name
            .as_ref()
            .map(|n| format!("Source: {}", n))
            .unwrap_or_else(|| "No source selected".to_string());
        let _ = items.source.set_text(&text);

        // Play: enabled when stopped or paused
        let _ = items.play.set_enabled(!is_streaming || is_paused);

        // Pause: enabled when streaming, not paused, AND source supports pause
        let _ = items.pause.set_enabled(is_streaming && !is_paused && can_pause);

        // Stop: enabled when streaming, not paused, and source supports pause
        // (Stop now acts as pause for timeline sources, like the timeline Pause button)
        let _ = items.stop.set_enabled(is_streaming && !is_paused && can_pause);

        // Detach Session: enabled when streaming and multiple apps connected
        let _ = items.detach.set_enabled(is_streaming && joiner_count > 1);

        // Stop Session: enabled when streaming (stops entire session for all apps)
        let _ = items.stop_all.set_enabled(is_streaming);
    }
}

/// Update the Bookmarks > Jump to Bookmark submenu with bookmarks for the current profile.
/// Called by the frontend when panel focus or IO profile changes.
#[tauri::command]
fn update_bookmarks_menu(
    app: AppHandle,
    state: State<BookmarksMenuState>,
    bookmarks: Vec<BookmarkInfo>,
) -> Result<(), String> {
    if let Some(submenu) = state.0.lock().unwrap().as_ref() {
        // Remove existing bookmark items (IDs start with "bookmark-jump-")
        // We need to collect the items first to avoid borrow issues
        let items_to_remove: Vec<_> = submenu
            .items()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                if let tauri::menu::MenuItemKind::MenuItem(menu_item) = item {
                    menu_item.id().0.starts_with("bookmark-jump-")
                } else {
                    false
                }
            })
            .collect();

        for item in items_to_remove {
            let _ = submenu.remove(&item);
        }

        // Add new bookmark items
        for bookmark in bookmarks {
            let item_id = format!("bookmark-jump-{}", bookmark.id);
            if let Ok(menu_item) = MenuItemBuilder::with_id(&item_id, &bookmark.name).build(&app) {
                let _ = submenu.append(&menu_item);
            }
        }
    }
    Ok(())
}

/// Create a new main window with the specified label.
///
/// This command spawns window creation in a background task and returns immediately.
/// On Windows, synchronous window creation can deadlock when called from a Tauri command
/// that's being awaited by the frontend, because window creation needs the UI thread.
#[tauri::command]
async fn create_main_window(app: AppHandle, label: String) -> Result<(), String> {
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
            let config = get_window_config("main");
            if let Err(e) = WebviewWindowBuilder::new(&app_for_window, &label_for_window, WebviewUrl::App("/".into()))
                .title(config.title)
                .inner_size(config.width, config.height)
                .min_inner_size(config.min_width, config.min_height)
                .center()
                .disable_drag_drop_handler()
                .build()
            {
                eprintln!("[create_main_window] Failed to create window '{}': {}", label_for_window, e);
            }
        });
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            // Initialise the centralised store manager
            if let Err(e) = store_manager::initialise(app.handle()) {
                eprintln!("[setup] Failed to initialise store manager: {}", e);
            }

            // Create About menu item (App submenu on macOS)
            let about_item = MenuItemBuilder::with_id("about", "About CANdor").build(app)?;

            let app_menu = SubmenuBuilder::new(app, "CANdor")
                .item(&about_item)
                .separator()
                .quit()
                .build()?;

            // Create Apps menu items
            let discovery_item = MenuItemBuilder::with_id("app-discovery", "Discovery")
                .accelerator("cmdOrCtrl+1")
                .build(app)?;
            let decoder_item = MenuItemBuilder::with_id("app-decoder", "Decoder")
                .accelerator("cmdOrCtrl+2")
                .build(app)?;
            let transmit_item = MenuItemBuilder::with_id("app-transmit", "Transmit")
                .accelerator("cmdOrCtrl+3")
                .build(app)?;
            let catalog_item = MenuItemBuilder::with_id("app-catalog-editor", "Catalog Editor")
                .accelerator("cmdOrCtrl+4")
                .build(app)?;
            let calculator_item = MenuItemBuilder::with_id("app-calculator", "Calculator")
                .accelerator("cmdOrCtrl+5")
                .build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("cmdOrCtrl+,")
                .build(app)?;

            let apps_menu = SubmenuBuilder::new(app, "Apps")
                .item(&discovery_item)
                .item(&decoder_item)
                .item(&transmit_item)
                .separator()
                .item(&catalog_item)
                .item(&calculator_item)
                .separator()
                .item(&settings_item)
                .build()?;

            // Create View menu items
            let new_window_item = MenuItemBuilder::with_id("new-window", "New Window")
                .accelerator("cmdOrCtrl+N")
                .build(app)?;

            // Edit menu - use predefined items for native clipboard/undo support
            let find_item = MenuItemBuilder::with_id("find", "Find…")
                .accelerator("cmdOrCtrl+F")
                .build(app)?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .separator()
                .select_all()
                .separator()
                .item(&find_item)
                .build()?;

            // Create Session menu for stream control
            let session_source_item = MenuItemBuilder::with_id("session-source", "No source selected")
                .enabled(false)
                .build(app)?;
            let session_picker_item = MenuItemBuilder::with_id("session-picker", "Select Source…")
                .accelerator("cmdOrCtrl+I")
                .build(app)?;

            // Playback controls (frame delivery)
            let session_play_item = MenuItemBuilder::with_id("session-play", "Play")
                .accelerator("cmdOrCtrl+Return")
                .build(app)?;
            let session_pause_item = MenuItemBuilder::with_id("session-pause", "Pause")
                .accelerator("cmdOrCtrl+.")
                .build(app)?;
            let session_stop_item = MenuItemBuilder::with_id("session-stop", "Stop")
                .accelerator("cmdOrCtrl+Shift+.")
                .build(app)?;

            // Session connection controls
            let session_detach_item = MenuItemBuilder::with_id("session-detach", "Detach Session")
                .enabled(false)
                .build(app)?;
            let session_stop_all_item = MenuItemBuilder::with_id("session-stop-all", "Stop Session")
                .build(app)?;

            let session_clear_item = MenuItemBuilder::with_id("session-clear", "Clear Frames")
                .accelerator("cmdOrCtrl+K")
                .build(app)?;

            let session_menu = SubmenuBuilder::new(app, "Session")
                .item(&session_source_item)
                .item(&session_picker_item)
                .separator()
                .item(&session_play_item)
                .item(&session_pause_item)
                .item(&session_stop_item)
                .separator()
                .item(&session_detach_item)
                .item(&session_stop_all_item)
                .separator()
                .item(&session_clear_item)
                .build()?;

            // Create Bookmarks menu
            let bookmark_save_item = MenuItemBuilder::with_id("bookmark-save", "Save Bookmark…")
                .accelerator("cmdOrCtrl+D")
                .build(app)?;
            let bookmark_manage_item =
                MenuItemBuilder::with_id("bookmark-manage", "Manage Bookmarks…").build(app)?;

            // Create "Jump to Bookmark" submenu (dynamically populated by frontend)
            let jump_to_bookmark_submenu = SubmenuBuilder::new(app, "Jump to Bookmark")
                .build()?;

            let bookmarks_menu = SubmenuBuilder::new(app, "Bookmarks")
                .item(&bookmark_save_item)
                .item(&jump_to_bookmark_submenu)
                .separator()
                .item(&bookmark_manage_item)
                .build()?;

            // Create View submenu
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&new_window_item)
                .separator()
                .fullscreen()
                .build()?;

            // Create main menu
            let menu = MenuBuilder::new(app)
                .items(&[
                    &app_menu,
                    &apps_menu,
                    &edit_menu,
                    &session_menu,
                    &bookmarks_menu,
                    &view_menu,
                ])
                .build()?;

            app.set_menu(menu)?;

            // Store session menu items for dynamic updates
            let session_menu_items = SessionMenuItems {
                source: session_source_item,
                play: session_play_item,
                pause: session_pause_item,
                stop: session_stop_item,
                detach: session_detach_item,
                stop_all: session_stop_all_item,
            };
            *app.state::<SessionMenuState>().0.lock().unwrap() = Some(session_menu_items);

            // Store bookmarks submenu reference for dynamic updates
            *app.state::<BookmarksMenuState>().0.lock().unwrap() = Some(jump_to_bookmark_submenu);

            // Handle menu events
            app.on_menu_event(|app, event| {
                let event_id = event.id().as_ref();

                match event_id {
                    "about" => {
                        emit_to_focused_window(app, "show-about", ());
                    }
                    // Note: undo, redo, cut, copy, paste, select-all are handled natively
                    // by predefined menu items - no custom handlers needed
                    "find" => {
                        emit_to_focused_window(app, "menu-find", ());
                    }
                    // App menu items - open as tabs in focused window
                    "app-discovery" | "app-decoder" | "app-transmit"
                    | "app-catalog-editor" | "app-calculator" => {
                        let panel_id = event_id.strip_prefix("app-").unwrap_or(event_id);
                        open_panel_in_focused_window(app, panel_id);
                    }
                    // Settings - singleton across all windows
                    "settings" => {
                        open_settings_singleton(app, &app.state::<SettingsWindowState>());
                    }
                    "new-window" => {
                        // Emit event to frontend - it will allocate a stable label and create the window
                        let _ = app.emit("menu-new-window", ());
                    }
                    // Session control menu items
                    "session-picker" => {
                        emit_to_focused_window(app, "menu-session-picker", ());
                    }
                    "session-play" => {
                        emit_to_focused_window(app, "menu-session-play", ());
                    }
                    "session-pause" => {
                        emit_to_focused_window(app, "menu-session-pause", ());
                    }
                    "session-stop" => {
                        emit_to_focused_window(app, "menu-session-stop", ());
                    }
                    "session-detach" => {
                        emit_to_focused_window(app, "menu-session-detach", ());
                    }
                    "session-stop-all" => {
                        emit_to_focused_window(app, "menu-session-stop-all", ());
                    }
                    "session-clear" => {
                        emit_to_focused_window(app, "menu-session-clear", ());
                    }
                    // Bookmark menu items
                    "bookmark-save" => {
                        emit_to_focused_window(app, "menu-bookmark-save", ());
                    }
                    "bookmark-manage" => {
                        // Open Settings panel and navigate to Bookmarks tab
                        open_settings_singleton(app, &app.state::<SettingsWindowState>());
                        emit_to_focused_window(app, "menu-bookmark-manage", ());
                    }
                    id if id.starts_with("bookmark-jump-") => {
                        // Jump to specific bookmark - extract ID and emit to focused window
                        let bookmark_id = id.strip_prefix("bookmark-jump-").unwrap_or("");
                        emit_to_focused_window(app, "menu-jump-to-bookmark", bookmark_id.to_string());
                    }
                    _ => {
                        // Unknown menu item - ignore
                    }
                }
            });

            // Start the heartbeat watchdog to clean up stale session joiners
            io::start_heartbeat_watchdog();

            // Install example decoders on app startup (only copies missing files)
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Load settings to get decoder directory
                match settings::load_settings(app_handle.clone()).await {
                    Ok(app_settings) => {
                        // Install example decoders (won't overwrite existing files)
                        if let Err(e) = settings::install_example_decoders(&app_handle, &app_settings.decoder_dir) {
                            eprintln!("[setup] Failed to install example decoders: {}", e);
                        }
                    }
                    Err(e) => {
                        eprintln!("[setup] Failed to load settings for example decoder installation: {}", e);
                    }
                }
            });

            Ok(())
        })
        .manage(SettingsWindowState(Mutex::new(None)))
        .manage(SessionMenuState(Mutex::new(None)))
        .manage(BookmarksMenuState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            greet,
            create_main_window,
            settings_panel_closed,
            open_settings_panel,
            update_menu_session_state,
            update_bookmarks_menu,
            catalog::open_catalog,
            catalog::save_catalog,
            catalog::validate_catalog,
            catalog::test_decode_frame,
            catalog::list_catalogs,
            catalog::duplicate_catalog,
            catalog::rename_catalog,
            catalog::delete_catalog,
            catalog::export_catalog,
            settings::load_settings,
            settings::save_settings,
            settings::validate_directory,
            settings::create_directory,
            settings::get_app_version,
            settings::check_for_updates,
            // Session-based reader API
            sessions::create_reader_session,
            sessions::get_reader_session_state,
            sessions::get_reader_session_capabilities,
            sessions::get_reader_session_joiner_count,
            sessions::join_reader_session,
            sessions::leave_reader_session,
            sessions::start_reader_session,
            sessions::stop_reader_session,
            sessions::pause_reader_session,
            sessions::resume_reader_session,
            sessions::update_reader_speed,
            sessions::update_reader_time_range,
            sessions::reconfigure_reader_session,
            sessions::seek_reader_session,
            sessions::update_reader_direction,
            sessions::destroy_reader_session,
            sessions::create_buffer_reader_session,
            sessions::transition_to_buffer_reader,
            sessions::step_buffer_frame,
            sessions::session_transmit_frame,
            // Listener registration API
            sessions::register_session_listener,
            sessions::unregister_session_listener,
            sessions::get_session_listener_list,
            sessions::reinitialize_session_if_safe_cmd,
            sessions::set_session_listener_active,
            sessions::probe_gvret_device,
            sessions::probe_device,
            sessions::create_multi_source_session,
            sessions::list_active_sessions,
            // Profile-to-session mapping API
            sessions::get_profile_sessions,
            sessions::get_profile_session_count,
            sessions::get_profiles_usage,
            io::get_active_listeners,
            // Buffer / CSV Import API
            buffers::import_csv_to_buffer,
            buffers::get_buffer_metadata,
            buffers::clear_buffer,
            buffers::get_buffer_frames,
            buffers::get_buffer_frames_paginated,
            buffers::get_buffer_frames_paginated_filtered,
            buffers::get_buffer_frames_paginated_by_id,
            buffers::get_buffer_frame_info,
            buffers::find_buffer_offset_for_timestamp,
            // Multi-buffer registry API
            buffers::list_buffers,
            buffers::delete_buffer,
            buffers::get_buffer_metadata_by_id,
            buffers::get_buffer_frames_by_id,
            buffers::get_buffer_bytes_by_id,
            buffers::set_active_buffer,
            buffers::create_frame_buffer_from_frames,
            // Byte buffer API (Serial Discovery)
            buffers::get_buffer_bytes_paginated,
            buffers::get_buffer_bytes_count,
            buffers::get_buffer_bytes_paginated_by_id,
            buffers::find_buffer_bytes_offset_for_timestamp,
            // Session-aware buffer API
            buffers::list_orphaned_buffers,
            // Backend framing
            framing::apply_framing_to_buffer,
            // Serial port API
            io::serial::reader::list_serial_ports,
            // slcan device probing
            io::slcan::reader::probe_slcan_device,
            // gs_usb device enumeration and setup commands
            io::gs_usb::list_gs_usb_devices,
            io::gs_usb::get_can_setup_command,
            io::gs_usb::probe_gs_usb_device,
            // Credential storage API
            credentials::store_credential,
            credentials::get_credential,
            credentials::delete_credential,
            credentials::delete_all_credentials,
            // Checksum calculation API
            checksums::calculate_checksum_cmd,
            checksums::validate_checksum_cmd,
            checksums::resolve_byte_index_cmd,
            // Transmit API
            transmit::get_transmit_capable_profiles,
            transmit::get_profile_usage,
            // IO session-based transmit
            transmit::io_transmit_can_frame,
            transmit::io_transmit_serial,
            transmit::get_io_session_capabilities,
            transmit::io_start_repeat_transmit,
            transmit::io_stop_repeat_transmit,
            transmit::io_stop_all_repeats,
            // IO session serial repeat
            transmit::io_start_serial_repeat_transmit,
            // IO session group repeat (multiple frames in one loop)
            transmit::io_start_repeat_group,
            transmit::io_stop_repeat_group,
            transmit::io_stop_all_group_repeats,
            // Centralised store API (replaces tauri-plugin-store for multi-window support)
            store_manager::store_get,
            store_manager::store_set,
            store_manager::store_delete,
            store_manager::store_has,
            store_manager::store_keys,
            // Database Query API (Query app)
            dbquery::db_query_byte_changes,
            dbquery::db_query_frame_changes,
            dbquery::db_query_mirror_validation,
            dbquery::db_cancel_query,
            dbquery::db_query_activity,
            dbquery::db_cancel_backend,
            dbquery::db_terminate_backend,
        ])
        // Handle window close events to prevent crashes on macOS 26.2+ (Tahoe)
        //
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
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label().to_string();
                // For decoder/discovery windows, do safe close with cleanup
                if label == "decoder" || label == "discovery" {
                    // Check if we're already in the close process (prevents infinite loop)
                    let is_first_close = io::mark_session_closing_sync(&label);
                    if !is_first_close {
                        // Second close request - let it through (this is our programmatic close)
                        eprintln!("[WindowEvent] Second close for '{}', allowing", label);
                        return;
                    }

                    // Prevent the default close - we'll destroy manually
                    api.prevent_close();

                    let window_clone = window.clone();

                    // Spawn async cleanup
                    tauri::async_runtime::spawn(async move {
                        eprintln!("[WindowEvent] CloseRequested for '{}', stopping session", label);

                        // Stop the streaming session - this waits for the task to finish
                        let _ = io::stop_session(&label).await;

                        // Destroy the session state
                        let _ = io::destroy_session(&label).await;

                        // Wait for WebKit to process any pending IPC operations.
                        // The session is stopped, so no new events will be emitted.
                        // This delay lets the main run loop drain pending operations.
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                        eprintln!("[WindowEvent] Cleanup complete for '{}', hiding window", label);

                        // Hide the window instead of destroying it.
                        // On macOS Tahoe (26.2+), calling destroy() can crash in
                        // WebKit::WebPageProxy::dispatchSetObscuredContentInsets()
                        // even after stopping the session and waiting.
                        // By hiding, the window stays in memory but is invisible.
                        // It will be cleaned up when the app exits.
                        if let Err(e) = window_clone.hide() {
                            eprintln!("[WindowEvent] Failed to hide '{}': {:?}", label, e);
                        }
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
