use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// `WINDOW_EVENTS.SETTINGS_CHANGED` in `src/events/registry.ts`.
const SETTINGS_CHANGED_EVENT: &str = "settings:changed";

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct IOProfile {
    pub id: String,
    pub name: String,
    pub kind: String, // "mqtt", "wiretap", "gvret_tcp"
    pub connection: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub preferred_catalog: Option<String>,
    /// A device created ad-hoc in the source picker. It lives in the in-memory
    /// registry (`io::ephemeral`) for this run only: `load_settings` overlays it
    /// onto `io_profiles` so every profile consumer sees it, and `save_settings`
    /// drops it again so it never reaches settings.json. Skipped on serialise
    /// when false, so saved profiles round-trip byte-identically.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ephemeral: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    #[serde(default = "default_config_path")]
    pub config_path: String,
    #[serde(default)]
    pub decoder_dir: String,
    #[serde(default)]
    pub dump_dir: String,
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
    /// Read from old settings files, which had this instead of log_level; never written.
    #[serde(default, skip_serializing)]
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
    /// Random anonymous per-install identifier, so Sentry can count distinct installs.
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

fn default_config_path() -> String {
    "config/wiretap.toml".to_string()
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
pub(crate) fn default_discovery_history_buffer() -> u32 {
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
            config_path: default_config_path(),
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

fn get_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get app config dir: {}", e))?;

    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app config dir: {}", e))?;

    Ok(app_dir.join("settings.json"))
}

/// Held across every read-migrate-write and every save, so a migration never
/// writes back over a save that landed after its read.
static SETTINGS_FILE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A scalar field that cannot be read takes its default instead of failing the
/// whole file. A list or object that cannot be read still fails it, so the
/// rewrite that follows a repair can never drop the profiles.
fn parse_settings(text: &str) -> Result<(AppSettings, bool), String> {
    let raw: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Failed to parse settings: {}", e))?;
    if let Ok(settings) = serde_json::from_value(raw.clone()) {
        return Ok((settings, false));
    }
    let serde_json::Value::Object(mut fields) = raw else {
        return Err("Failed to parse settings: not an object".to_string());
    };
    fields.retain(|key, value| {
        let alone = serde_json::Map::from_iter([(key.clone(), value.clone())]);
        let readable = serde_json::from_value::<AppSettings>(alone.into()).is_ok();
        if !readable && !(value.is_array() || value.is_object()) {
            tlog!("[settings] {} could not be read ({}); using its default", key, value);
            return false;
        }
        true
    });
    serde_json::from_value(serde_json::Value::Object(fields))
        .map(|settings| (settings, true))
        .map_err(|e| format!("Failed to parse settings: {}", e))
}

/// Brings settings written by any earlier version to the current shape: legacy
/// fields folded, empty fields defaulted, directories placed under `documents`,
/// FrameLink interfaces merged into devices, kinds canonical, numbers clamped.
/// True if anything changed.
fn migrate(settings: &mut AppSettings, documents: Option<&Path>) -> bool {
    let before = serde_json::to_value(&*settings).expect("settings serialise");

    if settings.enable_file_logging && settings.log_level == "off" {
        settings.log_level = "info".to_string();
    }
    settings.enable_file_logging = false;

    if let Some(documents) = documents {
        place_directories(settings, documents);
    }
    fill_empty_strings(settings);
    for format in [&mut settings.display_frame_id_format, &mut settings.save_frame_id_format] {
        if format != "decimal" {
            *format = "hex".to_string();
        }
    }
    if settings.frame_editor_colours.len() != 8 {
        settings.frame_editor_colours = default_frame_editor_colours();
    }
    merge_framelink_interfaces(settings);
    canonicalise_kinds(&mut settings.io_profiles);
    clamp_settings(settings);

    serde_json::to_value(&*settings).expect("settings serialise") != before
}

/// Empty directories, and all three when the decoder directory is not under
/// `documents` (an iOS container path goes stale on reinstall), are placed in
/// `documents/WireTAP`.
fn place_directories(settings: &mut AppSettings, documents: &Path) {
    let stale = !Path::new(&settings.decoder_dir).starts_with(documents);
    if stale {
        tlog!("[settings] decoder_dir {:?} is not under {:?}; regenerating the directories", settings.decoder_dir, documents);
    }
    let wiretap = documents.join("WireTAP");
    for (dir, name) in [
        (&mut settings.decoder_dir, "Decoders"),
        (&mut settings.dump_dir, "Dumps"),
        (&mut settings.report_dir, "Reports"),
    ] {
        if stale || dir.is_empty() {
            *dir = wiretap.join(name).to_string_lossy().into_owned();
        }
    }
}

fn fill_empty_strings(settings: &mut AppSettings) {
    let defaults = serde_json::to_value(AppSettings::default()).expect("settings serialise");
    let mut value = serde_json::to_value(&*settings).expect("settings serialise");
    let mut changed = false;
    for (key, field) in value.as_object_mut().expect("settings are an object") {
        if let Some(default) = defaults.get(key).filter(|d| *field == "" && **d != "") {
            *field = default.clone();
            changed = true;
        }
    }
    if changed {
        *settings = serde_json::from_value(value).expect("settings round-trip");
    }
}

/// Folds the per-interface FrameLink profiles of older versions (one profile per
/// interface, `interface_index` on the connection) into one profile per device,
/// in the place of its first interface and under its id. A default read or
/// write profile naming a merged-away interface follows it to the device.
fn merge_framelink_interfaces(settings: &mut AppSettings) {
    use serde_json::Value;
    type Connection = HashMap<String, Value>;

    fn present<'a>(c: &'a Connection, key: &str) -> Option<&'a Value> {
        c.get(key).filter(|v| !v.is_null())
    }
    fn spelt(v: Option<&Value>) -> String {
        match v {
            None => "undefined".to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
        }
    }
    let legacy = |p: &IOProfile| {
        p.kind == "framelink"
            && present(&p.connection, "interface_index").is_some()
            && !p.connection.get("interfaces").is_some_and(Value::is_array)
    };

    let profiles = &settings.io_profiles;
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, p) in profiles.iter().enumerate().filter(|(_, p)| legacy(p)) {
        let c = &p.connection;
        let device = present(c, "device_id").or_else(|| present(c, "port")).map_or("120".to_string(), |v| spelt(Some(v)));
        let key = format!("{}:{}", spelt(c.get("host")), device);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, members)) => members.push(i),
            None => groups.push((key, vec![i])),
        }
    }
    if groups.is_empty() {
        return;
    }

    let mut merged: HashMap<usize, IOProfile> = HashMap::new();
    let mut survivor: HashMap<String, String> = HashMap::new();
    for (_, members) in &groups {
        let first = &profiles[members[0]];
        let fc = &first.connection;
        let interface_name = present(fc, "interface_name").and_then(Value::as_str).unwrap_or("");
        let device_id = present(fc, "device_id").and_then(Value::as_str);
        let name = match first.name.strip_suffix(interface_name).filter(|_| !interface_name.is_empty()) {
            Some(stem) => [stem.trim(), device_id.unwrap_or("")]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or(&first.name),
            None => device_id.unwrap_or(&first.name),
        }
        .to_string();

        let mut connection: Connection = ["host", "device_id"]
            .into_iter()
            .filter_map(|key| fc.get(key).map(|v| (key.to_string(), v.clone())))
            .collect();
        connection.insert("port".into(), present(fc, "port").cloned().unwrap_or_else(|| "120".into()));
        if let Some(timeout) = members.iter().find_map(|&i| profiles[i].connection.get("timeout")) {
            connection.insert("timeout".into(), timeout.clone());
        }
        let mut interfaces: Vec<Value> = members
            .iter()
            .map(|&i| {
                let c = &profiles[i].connection;
                let index = &c["interface_index"];
                serde_json::json!({
                    "index": index,
                    "iface_type": present(c, "interface_type").cloned().unwrap_or_else(|| 1.into()),
                    "name": present(c, "interface_name").cloned().unwrap_or_else(|| format!("IF{}", spelt(Some(index))).into()),
                })
            })
            .collect();
        interfaces.sort_by(|a, b| a["index"].as_f64().partial_cmp(&b["index"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
        connection.insert("interfaces".into(), interfaces.into());

        for &i in &members[1..] {
            survivor.insert(profiles[i].id.clone(), first.id.clone());
        }
        merged.insert(
            members[0],
            IOProfile {
                id: first.id.clone(),
                name,
                kind: "framelink".to_string(),
                connection,
                preferred_catalog: members.iter().find_map(|&i| profiles[i].preferred_catalog.clone()),
                ephemeral: false,
            },
        );
    }

    let profiles = std::mem::take(&mut settings.io_profiles);
    settings.io_profiles = profiles
        .into_iter()
        .enumerate()
        .filter_map(|(i, p)| merged.remove(&i).or_else(|| (!survivor.contains_key(&p.id)).then_some(p)))
        .collect();

    let follow = |id: &String| survivor.get(id).cloned().unwrap_or_else(|| id.clone());
    settings.default_read_profile = settings.default_read_profile.as_ref().map(follow);
    let mut writes: Vec<String> = Vec::new();
    for id in settings.default_write_profiles.iter().map(follow) {
        if !writes.contains(&id) {
            writes.push(id);
        }
    }
    settings.default_write_profiles = writes;
}

/// Direct PostgreSQL profiles no longer open anything — a database-backed
/// source is a WireTAP backend now — so they are dropped rather than left for
/// every picker to hide and every reader to reject.
fn retire_postgres_profiles(settings: &mut AppSettings) -> Vec<IOProfile> {
    let (retired, kept): (Vec<_>, Vec<_>) =
        std::mem::take(&mut settings.io_profiles).into_iter().partition(|p| p.kind == "postgres");
    settings.io_profiles = kept;
    retired
}

/// Deletes the retired profiles' credentials and says so once, because a
/// profile disappearing silently is worse than one that fails.
fn announce_retired(retired: &[IOProfile]) {
    if retired.is_empty() {
        return;
    }
    for p in retired {
        let _ = crate::credentials::delete_all_credentials(&p.id);
    }
    let names: Vec<&str> = retired.iter().map(|p| p.name.as_str()).collect();
    let notice = format!(
        "Removed {} direct PostgreSQL source{} ({}). WireTAP now reaches a database \
         through a WireTAP backend profile; add one under Settings → Data I/O.",
        names.len(),
        if names.len() == 1 { "" } else { "s" },
        names.join(", ")
    );
    tlog!("[settings] {}", notice);
    crate::record_startup_notice(notice);
}

fn ensure_install_id(settings: &mut AppSettings) -> bool {
    if !settings.install_id.is_empty() {
        return false;
    }
    settings.install_id = uuid::Uuid::new_v4().to_string();
    true
}

struct Loaded {
    settings: AppSettings,
    retired: Vec<IOProfile>,
    written: bool,
}

/// The settings file migrated, rewritten once if migrating changed it. A
/// missing file is a first run: defaults, written out.
fn load_from(path: &Path, documents: Option<&Path>) -> Result<Loaded, String> {
    let _file = SETTINGS_FILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let (mut settings, mut written) = match std::fs::read_to_string(path) {
        Ok(text) => parse_settings(&text)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (parse_settings("{}")?.0, true),
        Err(e) => return Err(format!("Failed to read settings: {}", e)),
    };
    let retired = retire_postgres_profiles(&mut settings);
    written |= !retired.is_empty();
    written |= migrate(&mut settings, documents);
    written |= ensure_install_id(&mut settings);
    if written {
        write_settings_file(path, &settings)?;
    }
    Ok(Loaded { settings, retired, written })
}

fn write_settings_file(path: &Path, settings: &AppSettings) -> Result<(), String> {
    initialize_directories(settings)?;
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(path, content).map_err(|e| format!("Failed to write settings: {}", e))
}

/// Every reader's settings: migrated, defaulted and clamped, with this run's
/// ad-hoc devices overlaid.
pub fn load_settings_sync(app: &AppHandle) -> Result<AppSettings, String> {
    let path = get_settings_path(app)?;
    let documents = app.path().document_dir().ok();
    let Loaded { mut settings, retired, written } = load_from(&path, documents.as_deref())?;
    if written {
        announce_saved(app, &settings);
    }
    announce_retired(&retired);
    crate::io::ephemeral::overlay(&mut settings.io_profiles);
    Ok(settings)
}

/// Fold the legacy kind spellings the settings file has carried onto their
/// canonical form. Before this, `"gvret-tcp"` reached every consumer verbatim
/// and the sites that forgot the alias admitted a profile to a session, then
/// refused to transmit on it.
fn canonicalise_kinds(profiles: &mut [IOProfile]) {
    for p in profiles.iter_mut() {
        let canonical = crate::io::device_kinds::canonical_kind(&p.kind);
        if canonical != p.kind {
            p.kind = canonical.to_string();
        }
    }
}

impl AppSettings {
    pub fn profile(&self, profile_id: &str) -> Result<&IOProfile, String> {
        self.io_profiles
            .iter()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| format!("Profile '{profile_id}' not found"))
    }

    pub fn profile_mut(&mut self, profile_id: &str) -> Result<&mut IOProfile, String> {
        self.io_profiles
            .iter_mut()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| format!("Profile '{profile_id}' not found"))
    }
}

/// The saved profiles as a broker reads them: from the settings file as it is
/// at each read.
pub fn saved_profiles(app: &AppHandle) -> crate::io::ProfileLoader {
    let app = app.clone();
    std::sync::Arc::new(move || load_settings_sync(&app).map(|s| s.io_profiles))
}

/// The saved profile with this id, from the settings file as it is now.
pub fn profile_by_id(app: &AppHandle, profile_id: &str) -> Result<IOProfile, String> {
    load_settings_sync(app)?.profile(profile_id).cloned()
}

#[tauri::command]
pub async fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    load_settings_sync(&app)
}

fn initialize_directories(settings: &AppSettings) -> Result<(), String> {
    for dir in [&settings.decoder_dir, &settings.dump_dir, &settings.report_dir] {
        if !dir.is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create directory {}: {}", dir, e))?;
        }
    }
    Ok(())
}

/// One table drives `clamp_settings` (every load and save) and the ranges the
/// settings UI reads from `src/generated/settingRanges.ts`.
macro_rules! setting_ranges {
    ($($field:ident: $min:literal..=$max:literal),* $(,)?) => {
        #[cfg(test)]
        pub(crate) const SETTING_RANGES: &[(&str, u32, u32)] = &[$((stringify!($field), $min, $max)),*];

        fn clamp_settings(settings: &mut AppSettings) {
            $(settings.$field = settings.$field.clamp($min, $max);)*
        }
    };
}

setting_ranges! {
    discovery_history_buffer: 1_000..=10_000_000,
    query_result_limit: 100..=100_000,
    graph_buffer_size: 1_000..=100_000,
    decoder_max_unmatched_frames: 100..=10_000,
    decoder_max_filtered_frames: 100..=10_000,
    decoder_max_decoded_frames: 100..=5_000,
    decoder_max_decoded_per_source: 500..=20_000,
    transmit_max_history: 100..=10_000,
    modbus_max_register_errors: 0..=1_000,
    smp_port: 1..=65_535,
    mcp_server_port: 1_024..=65_535,
}

/// Ad-hoc devices are a run-lifetime thing. `load_settings` overlays them onto
/// `io_profiles`, so anything that round-trips a loaded settings object would
/// otherwise persist them — drop them on the way out rather than trusting every
/// caller to have kept them apart.
fn drop_ephemeral_profiles(settings: &mut AppSettings) {
    settings.io_profiles.retain(|p| !p.ephemeral);
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, mut settings: AppSettings) -> Result<(), String> {
    let settings_path = get_settings_path(&app)?;
    clamp_settings(&mut settings);
    drop_ephemeral_profiles(&mut settings);
    {
        let _file = SETTINGS_FILE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        write_settings_file(&settings_path, &settings)?;
    }
    announce_saved(&app, &settings);
    Ok(())
}

fn announce_saved(app: &AppHandle, settings: &AppSettings) {
    // Rebuild the catalogue cache + re-point the watcher if the decoder dir moved.
    crate::catalog::handle_decoder_dir_change(app, &settings.decoder_dir);

    // Keep the cached telemetry consent + install id in sync (read on every emit).
    crate::telemetry::refresh_consent(settings);

    // Every window's settings store rebases on this, so a write from any path
    // (another window, a device reconfigure, MCP) is not undone by its next save.
    let _ = app.emit(SETTINGS_CHANGED_EVENT, serde_json::json!({ "settings": settings }));
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn profile(kind: &str) -> IOProfile {
        IOProfile {
            id: "io_1".into(),
            name: "Dev".into(),
            kind: kind.into(),
            connection: Default::default(),
            preferred_catalog: None,
            ephemeral: false,
        }
    }

    /// The legacy spellings are folded once, on load, so no consumer has to know
    /// they exist. They used to be spelled out at eleven sites, and the sites
    /// that forgot admitted a profile to a session and then refused to transmit
    /// on it.
    #[test]
    fn legacy_kind_spellings_are_folded_on_load() {
        let mut profiles = vec![profile("gvret-tcp"), profile("gvret-usb")];
        canonicalise_kinds(&mut profiles);
        assert_eq!(profiles[0].kind, "gvret_tcp");
        assert_eq!(profiles[1].kind, "gvret_usb");
    }

    #[test]
    fn a_canonical_kind_is_left_alone() {
        let mut profiles = vec![profile("gvret_tcp"), profile("slcan"), profile("nonesuch")];
        canonicalise_kinds(&mut profiles);
        assert_eq!(
            profiles.iter().map(|p| p.kind.as_str()).collect::<Vec<_>>(),
            ["gvret_tcp", "slcan", "nonesuch"],
            "an unknown kind passes through — this normalises, it does not validate"
        );
    }

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
            ephemeral: false,
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

    /// `load_settings` overlays ad-hoc devices onto `io_profiles`, so a caller
    /// that round-trips a loaded settings object would persist them. `save_settings`
    /// drops them; this guards the `retain` that does it, and the `skip_serializing_if`
    /// that keeps saved profiles free of an `ephemeral` key.
    #[test]
    fn ephemeral_profiles_are_not_persisted() {
        let mut profile = IOProfile {
            id: "adhoc_1".to_string(),
            name: "Ad-hoc".to_string(),
            kind: "slcan".to_string(),
            connection: HashMap::new(),
            preferred_catalog: None,
            ephemeral: true,
        };
        let mut settings = AppSettings::default();
        settings.io_profiles.push(profile.clone());
        profile.id = "io_1".to_string();
        profile.ephemeral = false;
        settings.io_profiles.push(profile);

        drop_ephemeral_profiles(&mut settings);
        assert_eq!(settings.io_profiles.len(), 1);
        assert_eq!(settings.io_profiles[0].id, "io_1");

        // A saved profile must not gain an `ephemeral` key in settings.json.
        let value = serde_json::to_value(&settings.io_profiles[0]).unwrap();
        assert!(value.get("ephemeral").is_none(), "ephemeral key leaked");
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

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../frontend/wiretap-ui/src/tests/fixtures");

    fn clamped(field: &str, value: u64) -> Option<u64> {
        let mut raw = serde_json::to_value(AppSettings::default()).unwrap();
        raw[field] = value.into();
        let mut settings: AppSettings = serde_json::from_value(raw).ok()?;
        clamp_settings(&mut settings);
        serde_json::to_value(settings).unwrap()[field].as_u64()
    }

    fn widest(field: &str) -> u64 {
        [u64::from(u32::MAX), u64::from(u16::MAX)]
            .into_iter()
            .find(|&v| clamped(field, v).is_some())
            .expect("an integer field")
    }

    /// Asserts `value` against the fixture at `file`; `WRITE_DATA_FIXTURES=1` rewrites it.
    fn golden(file: &str, value: &serde_json::Value) {
        let path = format!("{FIXTURES}/data/{file}");
        if std::env::var_os("WRITE_DATA_FIXTURES").is_some() {
            std::fs::write(&path, serde_json::to_string_pretty(value).unwrap() + "\n").unwrap();
        }
        let fixture: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("fixture")).expect("json");
        assert_eq!(*value, fixture, "{file}");
    }

    /// `settingsGoldens.test.ts` checks the frontend changes nothing of this.
    /// The directories depend on the host, so they are blanked.
    #[test]
    fn defaults_match_the_fixture() {
        let mut defaults = serde_json::to_value(AppSettings::default()).unwrap();
        for dir in ["decoder_dir", "dump_dir", "report_dir"] {
            defaults[dir] = "".into();
        }
        golden("settingsDefaults.rust.json", &defaults);
    }

    fn served(raw: &serde_json::Value) -> serde_json::Value {
        let (mut settings, _) = parse_settings(&raw.to_string()).expect("readable");
        migrate(&mut settings, Some(Path::new("/Documents")));
        serde_json::to_value(settings).unwrap()
    }

    /// Objects with their keys sorted, so a rewritten fixture does not churn with
    /// a profile connection's hash order.
    fn sorted(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(map) => {
                let map: BTreeMap<String, serde_json::Value> = map.into_iter().map(|(k, v)| (k, sorted(v))).collect();
                serde_json::to_value(map).unwrap()
            }
            serde_json::Value::Array(items) => items.into_iter().map(sorted).collect(),
            v => v,
        }
    }

    fn cases(file: &str) -> Vec<serde_json::Value> {
        let text = std::fs::read_to_string(format!("{FIXTURES}/data/{file}")).expect("fixture");
        let fixture: serde_json::Value = serde_json::from_str(&text).expect("json");
        fixture["cases"].as_array().expect("cases").clone()
    }

    /// What a settings file reads as once Rust has parsed and migrated it: the
    /// first case in full, the rest as the keys that differ from it.
    #[test]
    fn served_settings_match_the_normalise_golden() {
        let mut cases = cases("settingsNormalise.json");
        let defaults = served(&serde_json::json!({}));
        for case in &mut cases {
            let raw = case["input"].get("raw").unwrap_or(&case["input"]).clone();
            let settings = served(&raw);
            case["expected"] = if raw == serde_json::json!({}) {
                settings
            } else {
                let changed: serde_json::Map<_, _> = settings
                    .as_object()
                    .unwrap()
                    .iter()
                    .filter(|(k, v)| defaults[k.as_str()] != **v)
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                changed.into()
            };
        }
        golden("settingsNormalise.json", &serde_json::json!({ "cases": cases }));
    }

    #[test]
    fn framelink_merge_matches_the_golden() {
        let mut cases = cases("settingsMigrateFrameLink.json");
        for case in &mut cases {
            let input: Vec<IOProfile> = serde_json::from_value(case["input"].clone()).expect("profiles");
            let mut settings = AppSettings { io_profiles: input.clone(), ..AppSettings::default() };
            merge_framelink_interfaces(&mut settings);
            let mut profiles = serde_json::to_value(&settings.io_profiles).unwrap();
            for p in profiles.as_array_mut().unwrap() {
                if p["preferred_catalog"].is_null() {
                    p.as_object_mut().unwrap().remove("preferred_catalog");
                }
            }
            let removed: Vec<&str> = input
                .iter()
                .map(|p| p.id.as_str())
                .filter(|id| settings.io_profiles.iter().all(|p| p.id != *id))
                .collect();
            case["expected"] = sorted(serde_json::json!({ "profiles": profiles, "removedIds": removed }));
        }
        golden("settingsMigrateFrameLink.json", &serde_json::json!({ "cases": cases }));
    }

    fn legacy_framelink(id: &str, index: u64) -> IOProfile {
        IOProfile {
            id: id.into(),
            name: format!("Bench CAN{index}"),
            kind: "framelink".into(),
            connection: serde_json::from_value(serde_json::json!({
                "host": "10.0.0.5", "device_id": "FL1", "interface_index": index, "interface_name": format!("CAN{index}"),
            }))
            .unwrap(),
            preferred_catalog: None,
            ephemeral: false,
        }
    }

    #[test]
    fn default_profiles_follow_a_merged_interface_to_its_device() {
        let mut settings = AppSettings {
            io_profiles: vec![legacy_framelink("p1", 1), legacy_framelink("p2", 2)],
            default_read_profile: Some("p2".into()),
            default_write_profiles: vec!["p2".into(), "p1".into(), "other".into()],
            ..AppSettings::default()
        };
        merge_framelink_interfaces(&mut settings);
        assert_eq!(settings.io_profiles.len(), 1);
        assert_eq!(settings.default_read_profile.as_deref(), Some("p1"));
        assert_eq!(settings.default_write_profiles, ["p1", "other"]);
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("wiretap-settings-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn file(&self) -> PathBuf {
            self.0.join("settings.json")
        }
        fn load(&self) -> Result<Loaded, String> {
            load_from(&self.file(), Some(&self.0.join("Documents")))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_first_run_writes_defaults_with_directories_and_an_install_id() {
        let scratch = Scratch::new("first-run");
        let loaded = scratch.load().unwrap();
        assert!(loaded.written);
        let decoders = scratch.0.join("Documents/WireTAP/Decoders");
        assert_eq!(loaded.settings.decoder_dir, decoders.to_string_lossy());
        assert!(decoders.is_dir());
        assert_eq!(loaded.settings.install_id.len(), 36);

        let again = scratch.load().unwrap();
        assert!(!again.written, "a migrated file is not rewritten");
        assert_eq!(again.settings.install_id, loaded.settings.install_id);
    }

    #[test]
    fn an_old_file_is_migrated_once_for_every_reader() {
        let scratch = Scratch::new("old-file");
        let mut postgres = profile("postgres");
        postgres.id = "pg".into();
        let raw = serde_json::json!({
            "config_path": "",
            "io_profiles": [postgres, legacy_framelink("p1", 1), legacy_framelink("p2", 2), profile("gvret-tcp")],
            "default_read_profile": "p2",
            "query_result_limit": 5,
            "smp_port": 70_000,
            "enable_file_logging": true,
            "log_level": "off",
            "display_frame_id_format": "Decimal",
        });
        std::fs::write(scratch.file(), raw.to_string()).unwrap();

        let loaded = scratch.load().unwrap();
        assert!(loaded.written);
        assert_eq!(loaded.retired.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["pg"]);
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(scratch.file()).unwrap()).unwrap();
        assert_eq!(on_disk, serde_json::to_value(&loaded.settings).unwrap());
        let s = &loaded.settings;
        assert_eq!(s.io_profiles.iter().map(|p| p.kind.as_str()).collect::<Vec<_>>(), ["framelink", "gvret_tcp"]);
        assert_eq!(s.default_read_profile.as_deref(), Some("p1"));
        assert_eq!((s.query_result_limit, s.smp_port), (100, default_smp_port()));
        assert_eq!((s.log_level.as_str(), s.config_path.as_str()), ("info", "config/wiretap.toml"));
        assert_eq!(s.display_frame_id_format, "hex");
        assert!(on_disk.get("enable_file_logging").is_none());

        assert!(!scratch.load().unwrap().written);
    }

    #[test]
    fn an_unreadable_profile_list_fails_the_load_and_writes_nothing() {
        let scratch = Scratch::new("bad-profiles");
        let text = r#"{"io_profiles": [{"id": 1}], "query_result_limit": "500"}"#;
        std::fs::write(scratch.file(), text).unwrap();
        assert!(scratch.load().is_err());
        assert_eq!(std::fs::read_to_string(scratch.file()).unwrap(), text);
    }

    /// The `rust` column of the table `bounds.ts` is checked against; a numeric
    /// field missing from the table must not be clamped at all.
    #[test]
    fn clamp_settings_matches_the_bounds_table() {
        let text = std::fs::read_to_string(format!("{FIXTURES}/data/settingsBounds.json")).expect("table");
        let table: serde_json::Value = serde_json::from_str(&text).expect("json");
        let rows = table["bounds"].as_array().expect("bounds");
        for row in rows {
            let field = row["field"].as_str().expect("field");
            let top = widest(field);
            let (min, max) = match &row["rust"] {
                serde_json::Value::Null => (0, top),
                bound => (bound["min"].as_u64().unwrap(), bound["max"].as_u64().unwrap()),
            };
            assert_eq!(clamped(field, 0), Some(min), "{field} below");
            assert_eq!(clamped(field, top), Some(max), "{field} above");
        }

        let listed: Vec<&str> = rows.iter().map(|row| row["field"].as_str().unwrap()).collect();
        let defaults = serde_json::to_value(AppSettings::default()).unwrap();
        for (field, value) in defaults.as_object().unwrap() {
            if value.is_u64() && !listed.contains(&field.as_str()) {
                let top = widest(field);
                assert_eq!((clamped(field, 0), clamped(field, top)), (Some(0), Some(top)), "{field} is clamped but not in the table");
            }
        }
    }
}
