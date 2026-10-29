#[macro_use]
pub(crate) mod logging;
mod adhoc;
mod blocking;
mod boot;
mod payload_source;
mod byte_roles;
mod app_registry;
mod ble_provision;
mod capture_db;
mod capture_events;
mod capture_inventory;
mod capture_store;
mod captures;
mod catalog;
mod catalog_share;
mod apiclient;
mod gateway_admin;
mod dashboard;
mod dashboard_history;
mod drafting;
mod checksum_discovery;
mod checksums;
mod credentials;
mod dbquery;
mod decode_views;
mod query;
mod device_scan;
#[cfg(not(target_os = "ios"))]
mod flashers;
mod frame_export;
mod framing;
mod framing_detect;
#[cfg(test)]
mod generated_types;
#[cfg(test)]
mod small_twin_tables;
pub mod io;
mod profile_tracker;
mod sessions;
mod settings;
mod telemetry;
#[cfg(not(target_os = "ios"))]
mod serial_terminal;
mod store_manager;
mod transmit;
mod transmit_history;
mod transmit_queue;
mod replay;
mod report;
mod io_test;
mod mcp;
mod menu;
pub mod ws;
mod windows;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    boot::init_tracing();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    // Keep screen on plugin for iOS (prevents screen dimming during sessions)
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_keep_screen_on::init());

    // Expose safe area insets as CSS variables on iOS (works around WebKit env() timing bug)
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_safe_area_insets_css::init());

    let builder = builder
        .setup(boot::boot_desktop)
        .manage(windows::SettingsWindowState::default())
        // Git-sharing provenance: which remote each local catalogue came from.
        // Loaded lazily on first access; managed here so the rename/delete hooks
        // in catalog.rs can always reach it.
        .manage(catalog_share::registry::CatalogSourceRegistry::default())
        .manage(catalog::CatalogCache::default());

    let builder = menu::manage_state(builder).invoke_handler(tauri::generate_handler![
            windows::show_current_window,
            logging::commands::log_from_frontend,
            telemetry::telemetry_init,
            telemetry::track_feature_usage,
            logging::commands::set_log_level,
            windows::create_main_window,
            windows::settings_panel_closed,
            windows::open_settings_panel,
            menu::update_menu_state,
            menu::update_events_menu,
            catalog::open_catalog,
            catalog::save_catalog,
            catalog::save_binary_file,
            catalog::list_catalogs,
            catalog::import_catalog,
            catalog::new_catalog_filename,
            catalog::duplicate_catalog,
            catalog::rename_catalog,
            catalog::delete_catalog,
            // Catalogue sharing: a real libgit2 clone per repository for the transport,
            // GitHub REST only for what git has no concept of (forks, pull requests).
            catalog_share::parse_catalog_source_url,
            catalog_share::browse_catalog_repo,
            catalog_share::resolve_remote_catalogs,
            catalog_share::import_remote_catalogs,
            catalog_share::list_catalog_sources,
            catalog_share::link_catalog_source,
            catalog_share::forget_catalog_source,
            catalog_share::save_catalog_repo,
            catalog_share::forget_catalog_repo,
            catalog_share::set_favourite_catalog_repo,
            catalog_share::community::save_community_repo,
            catalog_share::community::forget_community_repo,
            catalog_share::refresh_pr_status,
            catalog_share::check_catalog_updates,
            catalog_share::fetch_remote_catalog,
            catalog_share::apply_catalog_update,
            catalog_share::pull_catalog,
            catalog_share::repo_status,
            // Sharing: GitHub account (token lives in the keychain, never crosses IPC)
            catalog_share::auth::set_git_token,
            catalog_share::auth::get_git_identity,
            catalog_share::auth::verify_git_token,
            catalog_share::auth::clear_git_token,
            catalog_share::auth::git_token_setup_url,
            // Sharing: publish as a branch plus pull request
            catalog_share::publish::preflight_publish,
            catalog_share::publish::publish_diff,
            catalog_share::publish::publish_catalog,
            catalog_share::publish::create_catalog_repo,
            dashboard::list_dashboards,
            dashboard::open_dashboard,
            dashboard::save_dashboard,
            settings::load_settings,
            settings::save_settings,
            settings::validate_directory,
            settings::get_app_version,
            settings::check_for_updates,
            // Session-based reader API
            sessions::open_session,
            sessions::get_reader_session_state,
            sessions::get_reader_session_capabilities,
            sessions::get_reader_session_joiner_count,
            sessions::start_reader_session,
            sessions::stop_reader_session,
            sessions::pause_reader_session,
            sessions::resume_reader_session,
            sessions::session_stop_to_capture,
            sessions::resume_reader_session_fresh,
            sessions::update_reader_speed,
            sessions::set_virtual_traffic_enabled,
            sessions::set_virtual_bus_traffic_enabled,
            sessions::set_virtual_bus_cadence,
            sessions::get_virtual_bus_states,
            sessions::add_virtual_bus,
            sessions::remove_virtual_bus,
            sessions::update_reader_time_range,
            sessions::reconfigure_reader_session,
            sessions::seek_reader_session,
            sessions::seek_reader_session_by_frame,
            sessions::update_reader_direction,
            sessions::destroy_reader_session,
            sessions::transition_to_capture_source,
            sessions::switch_session_to_capture_replay,
            sessions::resume_session_to_live,
            sessions::step_capture_frame,
            sessions::session_transmit_frame,
            // Subscriber registration API
            sessions::unregister_session_subscriber,
            sessions::evict_session_subscriber_cmd,
            sessions::session_leave_to_capture,
            sessions::add_source_to_session_cmd,
            sessions::remove_source_from_session_cmd,
            sessions::pause_source_polling,
            sessions::resume_source_polling,
            sessions::update_source_bus_mappings_cmd,
            sessions::get_session_subscriber_list,
            sessions::register_open_app,
            sessions::unregister_open_app,
            sessions::list_open_apps,
            sessions::prune_window_apps,
            sessions::reinitialize_session_if_safe_cmd,
            sessions::set_session_subscriber_active,
            sessions::probe_gvret_device,
            sessions::probe_device,
            sessions::preview_source_buses,
            sessions::list_active_sessions,
            sessions::get_session_log,
            sessions::clear_session_log,
            sessions::get_profile_bus_mappings,
            sessions::get_supported_protocols,
            io::traits::list_profile_traits,
            io::traits::validate_source_selection,
            sessions::generate_session_id,
            // Profile-to-session mapping API
            sessions::get_profiles_usage,
            // Signal-then-fetch query commands
            sessions::get_stream_ended_info,
            sessions::get_session_error,
            sessions::get_session_sources,
            sessions::get_orphaned_capture_ids,
            // Power management API
            sessions::set_wake_settings,
            // Modbus scanning API
            sessions::modbus_polls_from_ranges,
            sessions::modbus_probe_function_codes,
            sessions::create_modbus_scan_session,
            io::webview_health_pong,
            io::check_recovery_occurred,
            // Capture / CSV Import API
            captures::detect_candump,
            captures::import_candump,
            captures::preview_csv,
            captures::preview_csv_timestamps,
            captures::import_csv_with_mapping,
            captures::import_csv_batch_with_mapping,
            captures::get_capture_metadata,
            captures::get_capture_frames,
            captures::get_capture_frames_paginated,
            captures::get_capture_frames_paginated_filtered,
            captures::get_capture_frames_paginated_by_id,
            captures::get_capture_frames_tail,
            captures::get_capture_frame_info,
            captures::get_capture_latest_frames,
            captures::find_capture_offset_for_timestamp,
            captures::search_capture_frames,
            // Multi-capture registry API
            captures::list_captures,
            captures::delete_capture,
            captures::clear_capture,
            captures::get_capture_metadata_by_id,
            captures::get_capture_frames_by_id,
            captures::get_capture_bytes_by_id,
            captures::set_active_capture,
            captures::create_frame_capture_from_frames,
            // Byte capture API (Serial Discovery)
            captures::get_capture_bytes_tail,
            captures::get_capture_bytes_paginated,
            captures::get_capture_bytes_count,
            captures::get_capture_bytes_paginated_by_id,
            captures::find_capture_bytes_offset_for_timestamp,
            captures::rename_capture,
            captures::set_capture_persistent,
            // Session-aware capture API
            captures::list_orphaned_captures,
            // Backend framing
            framing::apply_framing_to_capture,
            framing::extract_serial_ids,
            framing_detect::detect_serial_framing,
            // Serial port API (platform-aware: real on desktop, stub on iOS)
            io::platform::platform_list_serial_ports,
            // slcan device probing (platform-aware: real on desktop, stub on iOS)
            io::platform::platform_probe_slcan_device,
            // gs_usb device enumeration and setup commands
            io::gs_usb::list_gs_usb_devices,
            io::gs_usb::get_can_setup_command,
            io::gs_usb::probe_gs_usb_device,
            // Ad-hoc devices (registered for this run, never written to settings)
            io::ephemeral::unregister_ephemeral_profile,
            io::ephemeral::list_ephemeral_profiles,
            // Profile lifecycle
            io::profiles::create_device,
            io::profiles::update_device,
            io::profiles::save_ad_hoc_device,
            io::profiles::reconfigure_device,
            sessions::clear_profile_probe_cache,
            // Per-kind connection defaults — one declaration, which the form
            // seeds from and the readers consume.
            io::device_kinds::default_connection_for_kind,
            // Credential storage API
            credentials::store_credential,
            credentials::get_credential,
            credentials::delete_credential,
            credentials::delete_all_credentials,
            // Checksum calculation API
            checksums::calculate_checksum_cmd,
            checksums::validate_checksum_cmd,
            checksums::resolve_byte_indices,
            checksums::sweep_checksum_specs_cmd,
            checksums::detect_checksum_cmd,
            checksum_discovery::discover_checksums_cmd,
            checksum_discovery::discover_checksums_in_capture_cmd,
            byte_roles::payload_changes_cmd,
            byte_roles::frame_order_cmd,
            byte_roles::payload_changes_report_cmd,
            byte_roles::frame_order_report_cmd,
            drafting::draft_preview_cmd,
            drafting::draft_catalog_cmd,
            drafting::export_frames_catalog_cmd,
            drafting::export_modbus_catalog_cmd,
            decode_views::decode_groups_cmd,
            decode_views::interpret_registers_cmd,
            decode_views::can_mask_match_cmd,
            drafting::candidate_signals_cmd,
            byte_roles::serial_structure_cmd,
            adhoc::rank_hypotheses,
            frame_export::export_frame_dump,
            frame_export::export_byte_dump,
            // Transmit API
            transmit::get_transmit_capable_profiles,
            // IO session-based transmit
            transmit::io_transmit_can_frame,
            transmit::io_transmit_serial,
            transmit::io_set_framing,
            transmit::get_io_session_capabilities,
            transmit_queue::transmit_queue_get,
            transmit_queue::transmit_queue_add,
            transmit_queue::transmit_queue_edit,
            transmit_queue::transmit_queue_remove,
            transmit_queue::transmit_queue_clear,
            transmit_queue::transmit_queue_start,
            transmit_queue::transmit_queue_stop,
            transmit_queue::transmit_group_start,
            transmit_queue::transmit_group_stop,
            transmit_queue::transmit_queue_stop_all,
            // Time-accurate frame replay
            replay::io_start_replay,
            replay::io_restart_replay,
            replay::replay_estimate,
            replay::io_stop_replay,
            replay::io_stop_all_replays,
            // Direct serial-terminal (Serial app) — desktop only
            #[cfg(not(target_os = "ios"))]
            serial_terminal::serial_terminal_open,
            #[cfg(not(target_os = "ios"))]
            serial_terminal::serial_terminal_close,
            #[cfg(not(target_os = "ios"))]
            serial_terminal::serial_terminal_write,
            #[cfg(not(target_os = "ios"))]
            serial_terminal::serial_terminal_reset,
            // Firmware flashers (Serial app) — desktop only
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_esp_detect_chip,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_esp_flash,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_esp_read_flash,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_esp_erase,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_esp_cancel,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_dfu_list_devices,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_dfu_flash,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_dfu_cancel,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_stm32_detect_chip,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_stm32_flash,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_stm32_read_flash,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_stm32_erase,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_stm32_cancel,
            #[cfg(not(target_os = "ios"))]
            flashers::flasher_serial_detect,
            // Test Pattern protocol
            io_test::io_test_start,
            io_test::io_test_stop,
            io_test::get_io_test_state,
            // Transmit history (SQLite-backed)
            transmit_history::transmit_history_query,
            transmit_history::transmit_history_count,
            transmit_history::transmit_history_clear,
            transmit_history::transmit_history_time_range,
            transmit_history::transmit_history_find_offset,
            // Centralised store API (replaces tauri-plugin-store for multi-window support)
            store_manager::store_get,
            store_manager::store_set,
            store_manager::store_delete,
            store_manager::store_has,
            store_manager::store_keys,
            // Query app: one query path, its queue, and the backend's Stats tab
            query::queue::query_enqueue,
            query::queue::query_queue_get,
            query::queue::query_remove,
            query::queue::query_result,
            query::queue::query_preview,
            query::queue::query_export_csv,
            dbquery::db_query_activity,
            dbquery::db_cancel_backend,
            dbquery::db_terminate_backend,
            // WireTAP backend API (wiretap profiles)
            apiclient::api_list_databases,
            apiclient::api_test_connection,
            apiclient::api_probe_backend,
            apiclient::api_database_protocols,
            apiclient::api_import_capture,
            apiclient::api_valid_database_name,
            gateway_admin::gateway_list_daemons,
            gateway_admin::gateway_assign_catalogue,
            gateway_admin::gateway_clear_assignment,
            gateway_admin::gateway_copy_catalogue,
            capture_events::capture_events_list,
            capture_events::capture_events_add,
            capture_events::capture_events_update,
            capture_events::capture_events_delete,
                        // Unified Device Scan API
                        device_scan::device_scan_start,
                        device_scan::device_scan_stop,
                        device_scan::release_device,
                        // BLE WiFi Provisioning API
                        ble_provision::ble_scan_start,
                        ble_provision::ble_scan_stop,
                        ble_provision::ble_connect,
                        ble_provision::ble_delete_all_credentials,
                        ble_provision::ble_wifi_disconnect,
                        ble_provision::ble_read_device_state,
                        ble_provision::ble_provision_wifi,
                        ble_provision::ble_subscribe_status,
                        ble_provision::ble_get_host_wifi_ssid,
                        // FrameLink Device API
                        io::framelink::framelink_probe_device,
                        io::framelink::framelink_get_interface_signals,
                        io::framelink::framelink_write_signal,
                        io::framelink::framelink_read_signal,
                        // WebSocket binary transport
                        ws::server::get_ws_config,
                        // MCP server control
                        mcp::commands::get_mcp_status,
                        mcp::commands::toggle_mcp_server,
                        mcp::commands::generate_mcp_token,
        ]);

    #[cfg(not(target_os = "ios"))]
    let builder = builder.on_window_event(windows::on_window_event);

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(boot::on_run_event);
}
