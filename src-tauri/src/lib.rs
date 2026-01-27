mod buffer_store;
mod buffers;
mod catalog;
mod checksums;
mod credentials;
mod dbc_export;
mod framing;
mod io;
mod profile_tracker;
mod sessions;
mod settings;
mod transmit;

use tauri::{menu::*, AppHandle, Emitter, Manager, WebviewWindowBuilder, WebviewUrl, WindowEvent};

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

// Open window or focus if already exists (single instance enforcement)
fn open_or_focus_window(app: &AppHandle, label: &str, url: &str) {
    if let Some(existing) = app.get_webview_window(label) {
        // Check if the window is visible. If it was hidden (due to our close workaround),
        // destroy the old hidden window and create a fresh one.
        if existing.is_visible().unwrap_or(true) {
            let _ = existing.set_focus();
        } else {
            // Window was hidden - destroy it and create a new one
            let _ = existing.destroy();
            let config = get_window_config(label);
            let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
                .title(config.title)
                .inner_size(config.width, config.height)
                .min_inner_size(config.min_width, config.min_height)
                .center()
                .build();
        }
    } else {
        let config = get_window_config(label);
        let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .title(config.title)
            .inner_size(config.width, config.height)
            .min_inner_size(config.min_width, config.min_height)
            .center()
            .build();
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Create a new main window with the specified label
#[tauri::command]
fn create_main_window(app: AppHandle, label: String) -> Result<(), String> {
    // Check if window already exists
    if app.get_webview_window(&label).is_some() {
        return Ok(()); // Window already exists
    }

    let config = get_window_config("main");
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("/".into()))
        .title(config.title)
        .inner_size(config.width, config.height)
        .min_inner_size(config.min_width, config.min_height)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

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
            // Create About/Settings menu items (App submenu on macOS)
            let about_item = MenuItemBuilder::with_id("about", "About CANdor").build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "Settings").build(app)?;

            let app_menu = SubmenuBuilder::new(app, "CANdor")
                .item(&about_item)
                .item(&settings_item)
                .separator()
                .quit()
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

            // Create View submenu
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&new_window_item)
                .separator()
                .fullscreen()
                .build()?;

            // Create main menu
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &view_menu])
                .build()?;

            app.set_menu(menu)?;

            // Handle menu events
            app.on_menu_event(|app, event| {
                let event_id = event.id().as_ref();

                match event_id {
                    "about" => {
                        // Broadcast to all windows - each window will show its own about dialog
                        let _ = app.emit("show-about", ());
                    }
                    // Note: undo, redo, cut, copy, paste, select-all are handled natively
                    // by predefined menu items - no custom handlers needed
                    "find" => {
                        // Emit event to frontend - the focused window will handle it
                        let _ = app.emit("menu-find", ());
                    }
                    "settings" => {
                        open_or_focus_window(app, "settings", "/settings");
                    }
                    "new-window" => {
                        // Emit event to frontend - it will allocate a stable label and create the window
                        let _ = app.emit("menu-new-window", ());
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
        .invoke_handler(tauri::generate_handler![
            greet,
            create_main_window,
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
