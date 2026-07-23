use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, path::BaseDirectory};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IOProfile {
    pub id: String,
    pub name: String,
    pub kind: String, // "mqtt", "postgres", "gvret_tcp"
    pub connection: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub preferred_catalog: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub config_path: String,
    pub decoder_dir: String,
    pub dump_dir: String,
    /// Directory analysis reports are written to. Optional in older settings
    /// files (added later), so it defaults to empty and is filled from the
    /// platform documents dir by `Default`/`with_defaults`.
    #[serde(default)]
    pub report_dir: String,
    #[serde(default)]
    pub io_profiles: Vec<IOProfile>,
    #[serde(default)]
    pub default_read_profile: Option<String>,
    #[serde(default)]
    pub default_write_profiles: Vec<String>,
    #[serde(default = "default_display_frame_id_format")]
    pub display_frame_id_format: String, // "hex" | "decimal"
    #[serde(default = "default_save_frame_id_format")]
    pub save_frame_id_format: String, // "hex" | "decimal"
    #[serde(default = "default_display_time_format")]
    pub display_time_format: String, // "delta-last" | "delta-start" | "timestamp" | "human"
    #[serde(default = "default_default_frame_type")]
    pub default_frame_type: String, // "can" | "modbus" | "serial"
    #[serde(default = "default_signal_colour_none")]
    pub signal_colour_none: String,
    #[serde(default = "default_signal_colour_low")]
    pub signal_colour_low: String,
    #[serde(default = "default_signal_colour_medium")]
    pub signal_colour_medium: String,
    #[serde(default = "default_signal_colour_high")]
    pub signal_colour_high: String,
    #[serde(default = "default_binary_one_colour")]
    pub binary_one_colour: String,
    #[serde(default = "default_binary_zero_colour")]
    pub binary_zero_colour: String,
    #[serde(default = "default_binary_unused_colour")]
    pub binary_unused_colour: String,

    // Frame editor signal colours (8 slots for the bit grid)
    #[serde(default = "default_frame_editor_colours")]
    pub frame_editor_colours: Vec<String>,

    #[serde(default = "default_display_timezone")]
    pub display_timezone: String, // "local" | "utc"
    #[serde(default = "default_session_manager_stats_interval")]
    pub session_manager_stats_interval: u32, // seconds (0 = disabled)
    #[serde(default = "default_graph_buffer_size")]
    pub graph_buffer_size: u32, // samples per signal in graph ring buffers
    #[serde(default = "default_discovery_history_buffer")]
    pub discovery_history_buffer: u32, // frames retained in Discovery history
    #[serde(default = "default_query_result_limit")]
    pub query_result_limit: u32, // max rows returned by a Query

    // Theme settings
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String, // "dark" | "light" | "auto"

    // Theme colours - light mode
    #[serde(default = "default_theme_bg_primary_light")]
    pub theme_bg_primary_light: String,
    #[serde(default = "default_theme_bg_surface_light")]
    pub theme_bg_surface_light: String,
    #[serde(default = "default_theme_text_primary_light")]
    pub theme_text_primary_light: String,
    #[serde(default = "default_theme_text_secondary_light")]
    pub theme_text_secondary_light: String,
    #[serde(default = "default_theme_border_default_light")]
    pub theme_border_default_light: String,
    #[serde(default = "default_theme_data_bg_light")]
    pub theme_data_bg_light: String,
    #[serde(default = "default_theme_data_text_primary_light")]
    pub theme_data_text_primary_light: String,

    // Theme colours - dark mode
    #[serde(default = "default_theme_bg_primary_dark")]
    pub theme_bg_primary_dark: String,
    #[serde(default = "default_theme_bg_surface_dark")]
    pub theme_bg_surface_dark: String,
    #[serde(default = "default_theme_text_primary_dark")]
    pub theme_text_primary_dark: String,
    #[serde(default = "default_theme_text_secondary_dark")]
    pub theme_text_secondary_dark: String,
    #[serde(default = "default_theme_border_default_dark")]
    pub theme_border_default_dark: String,
    #[serde(default = "default_theme_data_bg_dark")]
    pub theme_data_bg_dark: String,
    #[serde(default = "default_theme_data_text_primary_dark")]
    pub theme_data_text_primary_dark: String,

    // Theme colours - accent (mode-independent)
    #[serde(default = "default_theme_accent_primary")]
    pub theme_accent_primary: String,
    #[serde(default = "default_theme_accent_success")]
    pub theme_accent_success: String,
    #[serde(default = "default_theme_accent_danger")]
    pub theme_accent_danger: String,
    #[serde(default = "default_theme_accent_warning")]
    pub theme_accent_warning: String,

    // Power management
    #[serde(default = "default_prevent_idle_sleep")]
    pub prevent_idle_sleep: bool,
    #[serde(default = "default_keep_display_awake")]
    pub keep_display_awake: bool,

    // Diagnostics
    #[serde(default = "default_log_level")]
    pub log_level: String, // "off" | "info" | "debug" | "verbose"
    /// Backward compat: old settings files may have this instead of log_level
    #[serde(default)]
    pub enable_file_logging: bool,

    // Privacy / telemetry
    #[serde(default = "default_telemetry_enabled")]
    pub telemetry_enabled: bool,
    #[serde(default = "default_telemetry_consent_given")]
    pub telemetry_consent_given: bool,
    /// Anonymous feature-usage analytics (separate opt-in from crash reports)
    #[serde(default = "default_usage_analytics_enabled")]
    pub usage_analytics_enabled: bool,
    #[serde(default = "default_usage_analytics_consent_given")]
    pub usage_analytics_consent_given: bool,
    /// Random anonymous per-install identifier, generated once by the frontend
    /// so Sentry can count distinct installs. Empty until first generated.
    #[serde(default)]
    pub install_id: String,

    // Capture persistence
    #[serde(default = "default_clear_captures_on_start", alias = "clear_buffers_on_start")]
    pub clear_captures_on_start: bool,

    /// Capture storage backend ("sqlite" is the only option for now).
    /// Serialised as `buffer_storage` to match the frontend payload key; the
    /// `capture_storage` alias keeps older settings files loadable.
    #[serde(
        default = "default_capture_storage",
        rename = "buffer_storage",
        alias = "capture_storage"
    )]
    pub capture_storage: String,

    // Decoder buffer limits
    #[serde(default = "default_decoder_max_unmatched_frames")]
    pub decoder_max_unmatched_frames: u32,
    #[serde(default = "default_decoder_max_filtered_frames")]
    pub decoder_max_filtered_frames: u32,
    #[serde(default = "default_decoder_max_decoded_frames")]
    pub decoder_max_decoded_frames: u32,
    #[serde(default = "default_decoder_max_decoded_per_source")]
    pub decoder_max_decoded_per_source: u32,

    // Transmit limits
    #[serde(default = "default_transmit_max_history")]
    pub transmit_max_history: u32,

    // Modbus settings
    /// Stop polling a register group after this many consecutive errors (0 = never stop)
    #[serde(default = "default_modbus_max_register_errors")]
    pub modbus_max_register_errors: u32,

    /// SMP UDP port for firmware upgrades over the network
    #[serde(default = "default_smp_port")]
    pub smp_port: u16,

    /// UI language code (BCP 47, e.g. "en-AU"). Drives i18next translations.
    #[serde(default = "default_language")]
    pub language: String,

    // MCP server — lets an external MCP client query live runtime state over
    // a localhost HTTP transport. Both gates default off.
    /// Master gate: when true the MCP server binds and listens.
    #[serde(default = "default_mcp_server_enabled")]
    pub mcp_server_enabled: bool,
    /// Second gate: when true the control (mutation) tools are registered.
    #[serde(default = "default_mcp_allow_control")]
    pub mcp_allow_control: bool,
    /// Third gate: when true the session lifecycle tools (open/stop session) are registered.
    #[serde(default = "default_mcp_allow_control")]
    pub mcp_allow_session_control: bool,
    /// Catalog gate: when true the `create_catalog` tool (write a new catalog file)
    /// is registered. Independent of the control gate.
    #[serde(default = "default_mcp_allow_control")]
    pub mcp_allow_catalog_write: bool,
    /// Catalog gate: when true the `update_catalog` tool (overwrite an existing
    /// catalog file) is registered. Independent of the control gate.
    #[serde(default = "default_mcp_allow_control")]
    pub mcp_allow_catalog_modify: bool,
    /// Dashboard gate: when true the `create_dashboard`/`update_dashboard` tools
    /// (write dashboard artifacts) are registered. Independent of the control gate.
    #[serde(default = "default_mcp_allow_control")]
    pub mcp_allow_dashboard_write: bool,
    /// UI gate: when true the `open_app` tool (open/focus an app/panel, e.g. a
    /// dashboard, in the running window) is registered. Independent of the control gate.
    #[serde(default = "default_mcp_allow_control")]
    pub mcp_allow_ui_control: bool,
    /// Fixed localhost port the MCP server listens on.
    #[serde(default = "default_mcp_server_port")]
    pub mcp_server_port: u16,
    /// Bearer token required by clients (empty = no auth). Stored in settings so
    /// static client config survives restarts.
    #[serde(default)]
    pub mcp_server_token: String,
}

fn default_display_frame_id_format() -> String {
    "hex".to_string()
}
fn default_save_frame_id_format() -> String {
    "hex".to_string()
}
fn default_display_time_format() -> String {
    "human".to_string()
}
fn default_default_frame_type() -> String {
    "can".to_string()
}
fn default_signal_colour_none() -> String {
    "#94a3b8".to_string() // slate-400
}
fn default_signal_colour_low() -> String {
    "#f59e0b".to_string() // amber-500
}
fn default_signal_colour_medium() -> String {
    "#3b82f6".to_string() // blue-500
}
fn default_signal_colour_high() -> String {
    "#22c55e".to_string() // green-500
}
fn default_binary_one_colour() -> String {
    "#14b8a6".to_string() // teal-500
}
fn default_binary_zero_colour() -> String {
    "#94a3b8".to_string() // slate-400
}
fn default_binary_unused_colour() -> String {
    "#64748b".to_string() // slate-500
}
fn default_frame_editor_colours() -> Vec<String> {
    vec![
        "#22d3ee".to_string(), // cyan
        "#4ade80".to_string(), // green
        "#facc15".to_string(), // yellow
        "#c084fc".to_string(), // magenta
        "#60a5fa".to_string(), // blue
        "#f87171".to_string(), // red
        "#67e8f9".to_string(), // light cyan
        "#86efac".to_string(), // light green
    ]
}
fn default_display_timezone() -> String {
    "local".to_string()
}
fn default_session_manager_stats_interval() -> u32 {
    60 // default to 60 seconds
}
fn default_graph_buffer_size() -> u32 {
    10_000 // samples per signal in graph ring buffers
}
fn default_discovery_history_buffer() -> u32 {
    100_000 // frames retained in Discovery history
}
fn default_query_result_limit() -> u32 {
    10_000 // max rows returned by a Query
}

// Theme defaults
fn default_theme_mode() -> String {
    "auto".to_string()
}

// Light mode defaults
fn default_theme_bg_primary_light() -> String {
    "#ffffff".to_string() // white
}
fn default_theme_bg_surface_light() -> String {
    "#f8fafc".to_string() // slate-50
}
fn default_theme_text_primary_light() -> String {
    "#0f172a".to_string() // slate-900
}
fn default_theme_text_secondary_light() -> String {
    "#334155".to_string() // slate-700
}
fn default_theme_border_default_light() -> String {
    "#e2e8f0".to_string() // slate-200
}
fn default_theme_data_bg_light() -> String {
    "#f8fafc".to_string() // slate-50
}
fn default_theme_data_text_primary_light() -> String {
    "#0f172a".to_string() // slate-900
}

// Dark mode defaults
fn default_theme_bg_primary_dark() -> String {
    "#0f172a".to_string() // slate-900
}
fn default_theme_bg_surface_dark() -> String {
    "#1e293b".to_string() // slate-800
}
fn default_theme_text_primary_dark() -> String {
    "#ffffff".to_string() // white
}
fn default_theme_text_secondary_dark() -> String {
    "#cbd5e1".to_string() // slate-300
}
fn default_theme_border_default_dark() -> String {
    "#334155".to_string() // slate-700
}
fn default_theme_data_bg_dark() -> String {
    "#111827".to_string() // gray-900
}
fn default_theme_data_text_primary_dark() -> String {
    "#e5e7eb".to_string() // gray-200
}

// Accent colour defaults (mode-independent)
fn default_theme_accent_primary() -> String {
    "#2563eb".to_string() // blue-600
}
fn default_theme_accent_success() -> String {
    "#16a34a".to_string() // green-600
}
fn default_theme_accent_danger() -> String {
    "#dc2626".to_string() // red-600
}
fn default_theme_accent_warning() -> String {
    "#d97706".to_string() // amber-600
}

// Power management defaults
fn default_prevent_idle_sleep() -> bool {
    true
}
fn default_keep_display_awake() -> bool {
    false
}

// Diagnostics defaults
fn default_log_level() -> String {
    "off".to_string()
}
fn default_enable_file_logging() -> bool {
    false
}

// Privacy / telemetry defaults
fn default_telemetry_enabled() -> bool {
    false
}
fn default_telemetry_consent_given() -> bool {
    false
}
fn default_usage_analytics_enabled() -> bool {
    false
}
fn default_usage_analytics_consent_given() -> bool {
    false
}

// Capture persistence defaults
fn default_clear_captures_on_start() -> bool {
    true
}
fn default_capture_storage() -> String {
    "sqlite".to_string()
}
fn default_smp_port() -> u16 {
    1337
}
fn default_language() -> String {
    "en-AU".to_string()
}

// MCP server defaults
fn default_mcp_server_enabled() -> bool {
    false
}
fn default_mcp_allow_control() -> bool {
    false
}
fn default_mcp_server_port() -> u16 {
    8787
}

// Decoder buffer limit defaults
fn default_decoder_max_unmatched_frames() -> u32 {
    1000
}
fn default_decoder_max_filtered_frames() -> u32 {
    1000
}
fn default_decoder_max_decoded_frames() -> u32 {
    500
}
fn default_decoder_max_decoded_per_source() -> u32 {
    2000
}

// Transmit limit defaults
fn default_transmit_max_history() -> u32 {
    1000
}

// Modbus defaults
fn default_modbus_max_register_errors() -> u32 {
    3
}

impl Default for AppSettings {
    fn default() -> Self {
        // Get platform-specific documents directory
        let documents_dir = dirs::document_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("WireTAP");

        let decoder_path = documents_dir.join("Decoders");
        let dump_path = documents_dir.join("Dumps");
        let report_path = documents_dir.join("Reports");

        Self {
            config_path: "config/wiretap.toml".to_string(),
            decoder_dir: decoder_path.to_string_lossy().to_string(),
            dump_dir: dump_path.to_string_lossy().to_string(),
            report_dir: report_path.to_string_lossy().to_string(),
            io_profiles: Vec::new(),
            default_read_profile: None,
            default_write_profiles: Vec::new(),
            display_frame_id_format: default_display_frame_id_format(),
            save_frame_id_format: default_save_frame_id_format(),
            display_time_format: default_display_time_format(),
            default_frame_type: default_default_frame_type(),
            signal_colour_none: default_signal_colour_none(),
            signal_colour_low: default_signal_colour_low(),
            signal_colour_medium: default_signal_colour_medium(),
            signal_colour_high: default_signal_colour_high(),
            binary_one_colour: default_binary_one_colour(),
            binary_zero_colour: default_binary_zero_colour(),
            binary_unused_colour: default_binary_unused_colour(),
            frame_editor_colours: default_frame_editor_colours(),
            display_timezone: default_display_timezone(),
            session_manager_stats_interval: default_session_manager_stats_interval(),
            graph_buffer_size: default_graph_buffer_size(),
            discovery_history_buffer: default_discovery_history_buffer(),
            query_result_limit: default_query_result_limit(),
            // Theme settings
            theme_mode: default_theme_mode(),
            // Light mode
            theme_bg_primary_light: default_theme_bg_primary_light(),
            theme_bg_surface_light: default_theme_bg_surface_light(),
            theme_text_primary_light: default_theme_text_primary_light(),
            theme_text_secondary_light: default_theme_text_secondary_light(),
            theme_border_default_light: default_theme_border_default_light(),
            theme_data_bg_light: default_theme_data_bg_light(),
            theme_data_text_primary_light: default_theme_data_text_primary_light(),
            // Dark mode
            theme_bg_primary_dark: default_theme_bg_primary_dark(),
            theme_bg_surface_dark: default_theme_bg_surface_dark(),
            theme_text_primary_dark: default_theme_text_primary_dark(),
            theme_text_secondary_dark: default_theme_text_secondary_dark(),
            theme_border_default_dark: default_theme_border_default_dark(),
            theme_data_bg_dark: default_theme_data_bg_dark(),
            theme_data_text_primary_dark: default_theme_data_text_primary_dark(),
            // Accent colours
            theme_accent_primary: default_theme_accent_primary(),
            theme_accent_success: default_theme_accent_success(),
            theme_accent_danger: default_theme_accent_danger(),
            theme_accent_warning: default_theme_accent_warning(),
            // Power management
            prevent_idle_sleep: default_prevent_idle_sleep(),
            keep_display_awake: default_keep_display_awake(),
            // Diagnostics
            log_level: default_log_level(),
            enable_file_logging: default_enable_file_logging(),
            // Privacy / telemetry
            telemetry_enabled: default_telemetry_enabled(),
            telemetry_consent_given: default_telemetry_consent_given(),
            usage_analytics_enabled: default_usage_analytics_enabled(),
            usage_analytics_consent_given: default_usage_analytics_consent_given(),
            install_id: String::new(),
            // Capture persistence
            clear_captures_on_start: default_clear_captures_on_start(),
            capture_storage: default_capture_storage(),
            // Decoder buffer limits
            decoder_max_unmatched_frames: default_decoder_max_unmatched_frames(),
            decoder_max_filtered_frames: default_decoder_max_filtered_frames(),
            decoder_max_decoded_frames: default_decoder_max_decoded_frames(),
            decoder_max_decoded_per_source: default_decoder_max_decoded_per_source(),
            // Transmit limits
            transmit_max_history: default_transmit_max_history(),
            // Modbus
            modbus_max_register_errors: default_modbus_max_register_errors(),
            smp_port: default_smp_port(),
            language: default_language(),
            // MCP server (both gates off by default)
            mcp_server_enabled: default_mcp_server_enabled(),
            mcp_allow_control: default_mcp_allow_control(),
            mcp_allow_session_control: default_mcp_allow_control(),
            mcp_allow_catalog_write: default_mcp_allow_control(),
            mcp_allow_catalog_modify: default_mcp_allow_control(),
            mcp_allow_dashboard_write: default_mcp_allow_control(),
            mcp_allow_ui_control: default_mcp_allow_control(),
            mcp_server_port: default_mcp_server_port(),
            mcp_server_token: String::new(),
        }
    }
}

impl AppSettings {
    /// Create settings with defaults using Tauri's path APIs.
    /// This works correctly on all platforms including iOS.
    pub fn with_defaults(app: &AppHandle) -> Result<Self, String> {
        let documents_dir = app
            .path()
            .document_dir()
            .map_err(|e| format!("Failed to get document directory: {}", e))?
            .join("WireTAP");

        // Only the directory paths need Tauri's iOS-correct document dir; every
        // other field matches `Default`, so pull those in via `..Self::default()`.
        Ok(Self {
            decoder_dir: documents_dir.join("Decoders").to_string_lossy().to_string(),
            dump_dir: documents_dir.join("Dumps").to_string_lossy().to_string(),
            report_dir: documents_dir.join("Reports").to_string_lossy().to_string(),
            ..Self::default()
        })
    }
}

fn get_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get app config dir: {}", e))?;

    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app config dir: {}", e))?;

    Ok(app_dir.join("settings.json"))
}

/// Check if directory paths are stale (e.g., pointing to old iOS container UUIDs).
/// Returns true if paths need to be regenerated.
fn paths_are_stale(settings: &AppSettings, app: &AppHandle) -> bool {
    // Get the current document directory
    let current_doc_dir = match app.path().document_dir() {
        Ok(dir) => dir,
        Err(_) => return false, // Can't check, assume OK
    };

    let decoder_path = PathBuf::from(&settings.decoder_dir);

    // On iOS, paths contain container UUIDs that change on reinstall.
    // Check if the saved path starts with the current document directory.
    // If not, the path is stale and needs regeneration.
    if !decoder_path.starts_with(&current_doc_dir) {
        tlog!(
            "[settings] Detected stale paths: decoder_dir {:?} doesn't start with {:?}",
            decoder_path, current_doc_dir
        );
        return true;
    }

    false
}

/// Load settings synchronously (for use during app setup, before the async runtime
/// is fully available). Does not perform migrations or first-run initialisation —
/// those happen when the frontend calls `load_settings` via Tauri command.
pub fn load_settings_sync(app: &AppHandle) -> Result<AppSettings, String> {
    let settings_path = get_settings_path(app)?;
    if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))
    } else {
        Ok(AppSettings::default())
    }
}

#[tauri::command]
pub async fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let settings_path = get_settings_path(&app)?;

    if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;

        let mut settings: AppSettings = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))?;

        // Migrate enable_file_logging → log_level (backward compat)
        if settings.enable_file_logging && settings.log_level == "off" {
            settings.log_level = "info".to_string();
            settings.enable_file_logging = false;
        }

        // Migrate persisted paths from CANdor → WireTAP (rebrand)
        migrate_persisted_paths(&mut settings);

        // report_dir was added after decoder_dir/dump_dir; older settings files
        // won't contain it. Fill from platform defaults so it's always populated.
        if settings.report_dir.is_empty() {
            let fresh_defaults = AppSettings::with_defaults(&app)?;
            settings.report_dir = fresh_defaults.report_dir;
        }

        // Check for stale paths (e.g., old iOS container UUIDs after reinstall)
        if paths_are_stale(&settings, &app) {
            tlog!("[settings] Regenerating stale directory paths");
            let fresh_defaults = AppSettings::with_defaults(&app)?;
            settings.decoder_dir = fresh_defaults.decoder_dir;
            settings.dump_dir = fresh_defaults.dump_dir;
            settings.report_dir = fresh_defaults.report_dir;
            // Re-initialize directories and save updated settings
            initialize_directories(&settings)?;
            save_settings(app, settings.clone()).await?;
        }

        Ok(settings)
    } else {
        // First run: create default settings and directories
        // Use with_defaults() for iOS-compatible path resolution
        let settings = AppSettings::with_defaults(&app)?;
        initialize_directories(&settings)?;
        save_settings(app, settings.clone()).await?;
        Ok(settings)
    }
}

// ============================================================================
// CANdor → WireTAP migration (prompted by user on first run)
// ============================================================================

/// Derive the old CANdor app config directory path from the current WireTAP path.
fn get_candor_config_dir(app: &AppHandle) -> Option<PathBuf> {
    let current_dir = app.path().app_config_dir().ok()?;
    let current_str = current_dir.to_string_lossy();
    let old_str = current_str.replace("com.wiredsquare.wiretap", "com.wiredsquare.candor");
    if old_str == current_str.as_ref() {
        return None;
    }
    let old_dir = PathBuf::from(old_str);
    if old_dir.exists() { Some(old_dir) } else { None }
}

/// Summary of what was found in the old CANdor directory.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CandorMigrationInfo {
    pub io_profile_count: usize,
    pub io_profile_names: Vec<String>,
    pub has_ui_state: bool,
    pub has_window_state: bool,
}

/// Check whether old CANdor data exists and return a summary.
#[tauri::command]
pub fn check_candor_migration(app: AppHandle) -> Option<CandorMigrationInfo> {
    let old_dir = get_candor_config_dir(&app)?;
    let settings_path = old_dir.join("settings.json");
    let ui_state_path = old_dir.join("ui-state.json");
    let window_state_path = old_dir.join(".window-state.json");

    // Need at least settings or ui-state to be worth prompting
    if !settings_path.exists() && !ui_state_path.exists() {
        return None;
    }

    let (io_profile_count, io_profile_names) = if settings_path.exists() {
        std::fs::read_to_string(&settings_path)
            .ok()
            .and_then(|c| serde_json::from_str::<AppSettings>(&c).ok())
            .map(|s| {
                let names: Vec<String> = s.io_profiles.iter().map(|p| p.name.clone()).collect();
                (names.len(), names)
            })
            .unwrap_or((0, Vec::new()))
    } else {
        (0, Vec::new())
    };

    Some(CandorMigrationInfo {
        io_profile_count,
        io_profile_names,
        has_ui_state: ui_state_path.exists(),
        has_window_state: window_state_path.exists(),
    })
}

/// Surgically migrate user data from old CANdor directory, then delete it.
/// Only copies IO profiles and user preferences into current settings;
/// paths and defaults come from the current WireTAP installation.
#[tauri::command]
pub async fn run_candor_migration(app: AppHandle) -> Result<String, String> {
    let old_dir = get_candor_config_dir(&app)
        .ok_or_else(|| "Old CANdor directory not found".to_string())?;

    let mut migrated = Vec::new();

    // ── Settings: surgically copy user data fields ──
    let settings_path = old_dir.join("settings.json");
    if settings_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&settings_path) {
            if let Ok(old) = serde_json::from_str::<AppSettings>(&content) {
                // Load current settings (fresh defaults from first run)
                let current_path = get_settings_path(&app)?;
                let mut current: AppSettings = if current_path.exists() {
                    let c = std::fs::read_to_string(&current_path)
                        .map_err(|e| format!("Failed to read current settings: {}", e))?;
                    serde_json::from_str(&c)
                        .map_err(|e| format!("Failed to parse current settings: {}", e))?
                } else {
                    AppSettings::with_defaults(&app)?
                };

                // IO profiles and defaults
                let profile_count = old.io_profiles.len();
                current.io_profiles = old.io_profiles;
                current.default_read_profile = old.default_read_profile;
                current.default_write_profiles = old.default_write_profiles;

                // User preferences (non-path settings)
                current.display_frame_id_format = old.display_frame_id_format;
                current.save_frame_id_format = old.save_frame_id_format;
                current.display_time_format = old.display_time_format;
                current.display_timezone = old.display_timezone;
                current.signal_colour_none = old.signal_colour_none;
                current.signal_colour_low = old.signal_colour_low;
                current.signal_colour_medium = old.signal_colour_medium;
                current.signal_colour_high = old.signal_colour_high;
                current.binary_one_colour = old.binary_one_colour;
                if !old.frame_editor_colours.is_empty() {
                    current.frame_editor_colours = old.frame_editor_colours;
                }
                current.session_manager_stats_interval = old.session_manager_stats_interval;
                current.graph_buffer_size = old.graph_buffer_size;
                current.theme_mode = old.theme_mode;
                // Light theme
                current.theme_bg_primary_light = old.theme_bg_primary_light;
                current.theme_bg_surface_light = old.theme_bg_surface_light;
                current.theme_text_primary_light = old.theme_text_primary_light;
                current.theme_text_secondary_light = old.theme_text_secondary_light;
                current.theme_border_default_light = old.theme_border_default_light;
                current.theme_data_bg_light = old.theme_data_bg_light;
                current.theme_data_text_primary_light = old.theme_data_text_primary_light;
                // Dark theme
                current.theme_bg_primary_dark = old.theme_bg_primary_dark;
                current.theme_bg_surface_dark = old.theme_bg_surface_dark;
                current.theme_text_primary_dark = old.theme_text_primary_dark;
                current.theme_text_secondary_dark = old.theme_text_secondary_dark;
                current.theme_border_default_dark = old.theme_border_default_dark;
                current.theme_data_bg_dark = old.theme_data_bg_dark;
                current.theme_data_text_primary_dark = old.theme_data_text_primary_dark;
                // Accent colours
                current.theme_accent_primary = old.theme_accent_primary;
                current.theme_accent_success = old.theme_accent_success;
                current.theme_accent_danger = old.theme_accent_danger;
                current.theme_accent_warning = old.theme_accent_warning;
                // Power management
                current.prevent_idle_sleep = old.prevent_idle_sleep;
                current.keep_display_awake = old.keep_display_awake;
                // Diagnostics
                current.log_level = old.log_level;
                // Buffer limits
                current.decoder_max_unmatched_frames = old.decoder_max_unmatched_frames;
                current.decoder_max_filtered_frames = old.decoder_max_filtered_frames;
                current.decoder_max_decoded_frames = old.decoder_max_decoded_frames;
                current.decoder_max_decoded_per_source = old.decoder_max_decoded_per_source;
                current.transmit_max_history = old.transmit_max_history;
                current.modbus_max_register_errors = old.modbus_max_register_errors;

                // Apply path migration (CANdor → WireTAP) but keep fresh defaults for paths
                // Don't copy old paths — they point to CANdor directories

                save_settings(app.clone(), current).await?;
                migrated.push(format!("{} IO profiles", profile_count));
                tlog!("[migration] Migrated {} IO profiles and user preferences", profile_count);
            }
        }
    }

    // ── UI state: copy entire file (layouts, favourites, selection sets) ──
    let ui_state_path = old_dir.join("ui-state.json");
    if ui_state_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&ui_state_path) {
            if let Ok(old_data) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&content) {
                let entry_count = old_data.len();
                for (key, value) in &old_data {
                    if let Err(e) = crate::store_manager::set(key, value.clone()) {
                        tlog!("[migration] Failed to set UI state key '{}': {}", key, e);
                    }
                }
                migrated.push(format!("{} UI state entries", entry_count));
                tlog!("[migration] Migrated {} UI state entries", entry_count);
            }
        }
    }

    // ── Delete the entire old directory ──
    if let Err(e) = std::fs::remove_dir_all(&old_dir) {
        tlog!("[migration] Failed to remove old CANdor directory: {}", e);
        return Err(format!("Migration complete but failed to remove old directory: {}", e));
    }
    tlog!("[migration] Removed old CANdor directory: {:?}", old_dir);

    Ok(format!("Migrated: {}", migrated.join(", ")))
}

/// Delete the old CANdor directory without migrating anything.
#[tauri::command]
pub fn delete_candor_data(app: AppHandle) -> Result<(), String> {
    let old_dir = get_candor_config_dir(&app)
        .ok_or_else(|| "Old CANdor directory not found".to_string())?;

    std::fs::remove_dir_all(&old_dir)
        .map_err(|e| format!("Failed to remove old CANdor directory: {}", e))?;

    tlog!("[migration] Deleted old CANdor directory: {:?}", old_dir);
    Ok(())
}

/// Migrate persisted directory paths from CANdor to WireTAP after rebrand.
/// Only replaces path components, not arbitrary substrings.
fn migrate_persisted_paths(settings: &mut AppSettings) {
    let sep = std::path::MAIN_SEPARATOR;
    let old_component = format!("{}CANdor{}", sep, sep);
    let new_component = format!("{}WireTAP{}", sep, sep);

    if settings.decoder_dir.contains(&old_component) {
        settings.decoder_dir = settings.decoder_dir.replace(&old_component, &new_component);
    }
    if settings.dump_dir.contains(&old_component) {
        settings.dump_dir = settings.dump_dir.replace(&old_component, &new_component);
    }
    if settings.report_dir.contains(&old_component) {
        settings.report_dir = settings.report_dir.replace(&old_component, &new_component);
    }
    if settings.config_path.contains("candor.toml") {
        settings.config_path = settings.config_path.replace("candor.toml", "wiretap.toml");
    }
}

fn initialize_directories(settings: &AppSettings) -> Result<(), String> {
    // Create decoder directory
    let decoder_path = PathBuf::from(&settings.decoder_dir);
    std::fs::create_dir_all(&decoder_path)
        .map_err(|e| format!("Failed to create decoder directory: {}", e))?;

    // Create dump directory
    let dump_path = PathBuf::from(&settings.dump_dir);
    std::fs::create_dir_all(&dump_path)
        .map_err(|e| format!("Failed to create dump directory: {}", e))?;

    // Create report directory (skip if unset — filled by load_settings/frontend)
    if !settings.report_dir.is_empty() {
        let report_path = PathBuf::from(&settings.report_dir);
        std::fs::create_dir_all(&report_path)
            .map_err(|e| format!("Failed to create report directory: {}", e))?;
    }

    Ok(())
}

/// Install bundled example decoders to the user's decoder directory.
/// Only copies files that don't already exist (never overwrites).
pub fn install_example_decoders(app: &AppHandle, decoder_dir: &str) -> Result<u32, String> {
    let decoder_path = PathBuf::from(decoder_dir);
    tlog!("[settings] Decoder directory: {:?}", decoder_path);

    // Try to resolve the bundled examples directory
    // First try BaseDirectory::Resource (works on desktop)
    let examples_dir = match app.path().resolve("examples", BaseDirectory::Resource) {
        Ok(path) => {
            tlog!("[settings] Resolved examples via Resource: {:?}", path);
            path
        }
        Err(e) => {
            tlog!("[settings] Failed to resolve via Resource: {}", e);
            // Fallback: try resource_dir directly (for iOS)
            match app.path().resource_dir() {
                Ok(resource_dir) => {
                    let path = resource_dir.join("examples");
                    tlog!("[settings] Trying resource_dir fallback: {:?}", path);
                    path
                }
                Err(e2) => {
                    return Err(format!("Failed to resolve examples directory: {} / {}", e, e2));
                }
            }
        }
    };

    // If examples directory doesn't exist (dev mode without resources), skip silently
    if !examples_dir.exists() {
        tlog!("[settings] Examples directory not found at {:?}, skipping installation", examples_dir);
        return Ok(0);
    }

    let mut installed_count = 0u32;

    // Read all .toml files from the examples directory
    let entries = std::fs::read_dir(&examples_dir)
        .map_err(|e| format!("Failed to read examples directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        // Only process .toml files
        if path.extension().and_then(|s| s.to_str()) != Some("toml") {
            continue;
        }

        // Get the filename
        let filename = match path.file_name().and_then(|s| s.to_str()) {
            Some(name) => name,
            None => continue,
        };

        // Check if file already exists in destination
        let dest_path = decoder_path.join(filename);
        if dest_path.exists() {
            tlog!("[settings] Skipping '{}' - already exists in decoder directory", filename);
            continue;
        }

        // Copy the file
        match std::fs::copy(&path, &dest_path) {
            Ok(_) => {
                tlog!("[settings] Installed example decoder: {}", filename);
                installed_count += 1;
            }
            Err(e) => {
                tlog!("[settings] Failed to install '{}': {}", filename, e);
            }
        }
    }

    if installed_count > 0 {
        tlog!("[settings] Installed {} example decoder(s)", installed_count);
    }

    Ok(installed_count)
}

/// Clamp numeric settings into the ranges the UI enforces (kept in step with
/// `SETTINGS_BOUNDS` in src/settings/bounds.ts). Authoritative — applied on every
/// save so an out-of-range value (from an older file or a hand edit) is corrected.
fn clamp_settings(settings: &mut AppSettings) {
    settings.discovery_history_buffer = settings.discovery_history_buffer.clamp(1_000, 10_000_000);
    settings.query_result_limit = settings.query_result_limit.clamp(100, 100_000);
    settings.graph_buffer_size = settings.graph_buffer_size.clamp(1_000, 100_000);
    settings.decoder_max_unmatched_frames = settings.decoder_max_unmatched_frames.clamp(100, 10_000);
    settings.decoder_max_filtered_frames = settings.decoder_max_filtered_frames.clamp(100, 10_000);
    settings.decoder_max_decoded_frames = settings.decoder_max_decoded_frames.clamp(100, 5_000);
    settings.decoder_max_decoded_per_source =
        settings.decoder_max_decoded_per_source.clamp(500, 20_000);
    settings.transmit_max_history = settings.transmit_max_history.clamp(100, 10_000);
    settings.modbus_max_register_errors = settings.modbus_max_register_errors.clamp(0, 1_000);
    settings.smp_port = settings.smp_port.clamp(1, 65_535);
    settings.mcp_server_port = settings.mcp_server_port.clamp(1_024, 65_535);
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, mut settings: AppSettings) -> Result<(), String> {
    let settings_path = get_settings_path(&app)?;

    // Clamp numeric settings to their allowed ranges before persisting.
    clamp_settings(&mut settings);

    // Ensure directories exist when saving
    initialize_directories(&settings)?;

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    std::fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    // Rebuild the catalogue cache + re-point the watcher if the decoder dir moved.
    crate::catalog::handle_decoder_dir_change(&app, &settings.decoder_dir);

    // Keep the cached telemetry consent + install id in sync (read on every emit).
    crate::telemetry::refresh_consent(&settings);

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DirectoryValidation {
    pub exists: bool,
    pub writable: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn validate_directory(path: String) -> Result<DirectoryValidation, String> {
    let dir_path = PathBuf::from(&path);

    // Check if directory exists
    let exists = dir_path.exists();

    // Check if writable
    let writable = if exists {
        // Try to create a temporary file to test writability
        let test_file = dir_path.join(".wiretap_write_test");
        match std::fs::write(&test_file, b"test") {
            Ok(_) => {
                std::fs::remove_file(&test_file).ok();
                true
            }
            Err(_) => false,
        }
    } else {
        false
    };

    let error = if !exists {
        Some("Directory does not exist".to_string())
    } else if !writable {
        Some("Directory is not writable".to_string())
    } else {
        None
    };

    Ok(DirectoryValidation {
        exists,
        writable,
        error,
    })
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    let dir_path = PathBuf::from(&path);
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
pub async fn get_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "unknown".to_string()))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
}

fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let v = version.trim_start_matches('v');
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() >= 3 {
        let major = parts[0].parse().ok()?;
        let minor = parts[1].parse().ok()?;
        let patch = parts[2].parse().ok()?;
        Some((major, minor, patch))
    } else {
        None
    }
}

fn is_newer_version(current: &str, latest: &str) -> bool {
    match (parse_version(current), parse_version(latest)) {
        (Some((c_maj, c_min, c_pat)), Some((l_maj, l_min, l_pat))) => {
            (l_maj, l_min, l_pat) > (c_maj, c_min, c_pat)
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let current_version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());

    let client = reqwest::Client::builder()
        .user_agent("WireTAP-App")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get("https://api.github.com/repos/Wired-Square/WireTAP/releases/latest")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned status: {}", response.status()));
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {}", e))?;

    if is_newer_version(&current_version, &release.tag_name) {
        Ok(Some(UpdateInfo {
            version: release.tag_name,
            url: release.html_url,
        }))
    } else {
        Ok(None)
    }
}

/// Migrate user data directory from legacy CANdor name to WireTAP.
/// Renames ~/Documents/CANdor → ~/Documents/WireTAP if the old directory
/// exists and the new one does not. Called once on startup.
pub fn migrate_data_directory(doc_dir: &Path) {
    let old = doc_dir.join("CANdor");
    let new = doc_dir.join("WireTAP");
    if old.exists() && !new.exists() {
        if let Err(e) = std::fs::rename(&old, &new) {
            tlog!("[settings] Failed to migrate data directory: {}", e);
        } else {
            tlog!("[settings] Migrated data directory from CANdor to WireTAP");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every key the frontend sends in `buildAppSettings`
    /// (src/apps/settings/stores/settingsStore.ts) MUST have a counterpart in
    /// the `AppSettings` struct, otherwise serde silently drops it on
    /// `save_settings` and the setting never persists. Keep this list in sync
    /// with `buildAppSettings`; the `ts_payload_keys_subset_of_struct_fields`
    /// test fails if a key here has no matching (serialised) struct field.
    const TS_PAYLOAD_KEYS: &[&str] = &[
        "config_path",
        "decoder_dir",
        "dump_dir",
        "report_dir",
        "io_profiles",
        "default_read_profile",
        "default_write_profiles",
        "display_frame_id_format",
        "save_frame_id_format",
        "display_time_format",
        "display_timezone",
        "default_frame_type",
        "signal_colour_none",
        "signal_colour_low",
        "signal_colour_medium",
        "signal_colour_high",
        "binary_one_colour",
        "binary_zero_colour",
        "binary_unused_colour",
        "frame_editor_colours",
        "clear_captures_on_start",
        "buffer_storage",
        "discovery_history_buffer",
        "query_result_limit",
        "graph_buffer_size",
        "decoder_max_unmatched_frames",
        "decoder_max_filtered_frames",
        "decoder_max_decoded_frames",
        "decoder_max_decoded_per_source",
        "transmit_max_history",
        "session_manager_stats_interval",
        "prevent_idle_sleep",
        "keep_display_awake",
        "log_level",
        "telemetry_enabled",
        "telemetry_consent_given",
        "usage_analytics_enabled",
        "usage_analytics_consent_given",
        "install_id",
        "modbus_max_register_errors",
        "theme_mode",
        "theme_bg_primary_light",
        "theme_bg_surface_light",
        "theme_text_primary_light",
        "theme_text_secondary_light",
        "theme_border_default_light",
        "theme_data_bg_light",
        "theme_data_text_primary_light",
        "theme_bg_primary_dark",
        "theme_bg_surface_dark",
        "theme_text_primary_dark",
        "theme_text_secondary_dark",
        "theme_border_default_dark",
        "theme_data_bg_dark",
        "theme_data_text_primary_dark",
        "theme_accent_primary",
        "theme_accent_success",
        "theme_accent_danger",
        "theme_accent_warning",
        "smp_port",
        "language",
        "mcp_server_enabled",
        "mcp_allow_control",
        "mcp_allow_session_control",
        "mcp_allow_catalog_write",
        "mcp_allow_catalog_modify",
        "mcp_allow_dashboard_write",
        "mcp_allow_ui_control",
        "mcp_server_port",
        "mcp_server_token",
    ];

    /// Guard against the "field sent by the frontend but missing from the Rust
    /// struct" class of bug (which silently dropped six settings on save).
    #[test]
    fn ts_payload_keys_subset_of_struct_fields() {
        let value = serde_json::to_value(AppSettings::default()).unwrap();
        let obj = value.as_object().expect("AppSettings serialises to an object");
        let missing: Vec<&str> = TS_PAYLOAD_KEYS
            .iter()
            .copied()
            .filter(|k| !obj.contains_key(*k))
            .collect();
        assert!(
            missing.is_empty(),
            "AppSettings is missing struct fields for keys emitted by buildAppSettings: {:?}",
            missing
        );
    }

    /// A save (serialise) → load (deserialise) → save round-trip must not drop
    /// or alter any field.
    #[test]
    fn round_trip_preserves_all_fields() {
        let mut settings = AppSettings::default();
        // Exercise the formerly-dropped fields + the renamed one.
        settings.report_dir = "/tmp/reports".to_string();
        settings.default_frame_type = "modbus".to_string();
        settings.discovery_history_buffer = 12_345;
        settings.query_result_limit = 6_789;
        settings.binary_zero_colour = "#111111".to_string();
        settings.binary_unused_colour = "#222222".to_string();
        settings.io_profiles.push(IOProfile {
            id: "p1".to_string(),
            name: "Test".to_string(),
            kind: "mqtt".to_string(),
            connection: HashMap::new(),
            preferred_catalog: None,
        });

        let saved = serde_json::to_string(&settings).unwrap();
        let loaded: AppSettings = serde_json::from_str(&saved).unwrap();
        let re_saved = serde_json::to_string(&loaded).unwrap();
        assert_eq!(saved, re_saved, "settings changed across a save/load round-trip");

        // The capture-storage field must serialise under the frontend key.
        let value = serde_json::to_value(&settings).unwrap();
        assert!(value.get("buffer_storage").is_some(), "buffer_storage key missing");
        assert!(value.get("capture_storage").is_none(), "capture_storage key leaked");
        assert_eq!(value.get("report_dir").unwrap(), "/tmp/reports");
        assert_eq!(value.get("discovery_history_buffer").unwrap(), 12_345);
    }

    /// Older settings files stored the field as `capture_storage`; that spelling
    /// must still load via the serde alias.
    #[test]
    fn capture_storage_alias_still_loads() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let obj = value.as_object_mut().unwrap();
        obj.remove("buffer_storage");
        obj.insert("capture_storage".to_string(), serde_json::json!("sqlite"));
        let json = serde_json::to_string(&value).unwrap();
        let parsed: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.capture_storage, "sqlite");
    }

    /// Settings files written before these fields existed must deserialise,
    /// falling back to the documented defaults.
    #[test]
    fn missing_new_fields_use_defaults() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let obj = value.as_object_mut().unwrap();
        for k in [
            "report_dir",
            "default_frame_type",
            "discovery_history_buffer",
            "query_result_limit",
            "binary_zero_colour",
            "binary_unused_colour",
        ] {
            obj.remove(k);
        }
        let json = serde_json::to_string(&value).unwrap();
        let parsed: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.default_frame_type, "can");
        assert_eq!(parsed.discovery_history_buffer, 100_000);
        assert_eq!(parsed.query_result_limit, 10_000);
        assert_eq!(parsed.binary_zero_colour, "#94a3b8");
        assert_eq!(parsed.binary_unused_colour, "#64748b");
        // report_dir defaults to empty (filled by load_settings/frontend, not serde).
        assert_eq!(parsed.report_dir, "");
    }

    /// Out-of-range numeric settings are clamped to their bounds on save.
    #[test]
    fn clamp_settings_bounds() {
        let mut settings = AppSettings::default();
        // Below the minimum.
        settings.discovery_history_buffer = 1;
        settings.query_result_limit = 1;
        settings.decoder_max_decoded_per_source = 1;
        settings.smp_port = 0;
        settings.mcp_server_port = 1;
        // Above the maximum.
        settings.graph_buffer_size = 5_000_000;
        settings.decoder_max_decoded_frames = 999_999;
        settings.transmit_max_history = 999_999;
        settings.modbus_max_register_errors = 999_999;

        clamp_settings(&mut settings);

        assert_eq!(settings.discovery_history_buffer, 1_000);
        assert_eq!(settings.query_result_limit, 100);
        assert_eq!(settings.decoder_max_decoded_per_source, 500);
        assert_eq!(settings.smp_port, 1);
        assert_eq!(settings.mcp_server_port, 1_024);
        assert_eq!(settings.graph_buffer_size, 100_000);
        assert_eq!(settings.decoder_max_decoded_frames, 5_000);
        assert_eq!(settings.transmit_max_history, 10_000);
        assert_eq!(settings.modbus_max_register_errors, 1_000);

        // An in-range value is left untouched.
        let mut ok = AppSettings::default();
        ok.query_result_limit = 5_000;
        clamp_settings(&mut ok);
        assert_eq!(ok.query_result_limit, 5_000);
    }
}
