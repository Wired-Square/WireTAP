use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, path::BaseDirectory};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IOProfile {
    pub id: String,
    pub name: String,
    pub kind: String, // "mqtt", "postgres", "gvret_tcp"
    pub connection: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub config_path: String,
    pub decoder_dir: String,
    pub dump_dir: String,
    #[serde(default)]
    pub io_profiles: Vec<IOProfile>,
    #[serde(default)]
    pub default_read_profile: Option<String>,
    #[serde(default)]
    pub default_write_profiles: Vec<String>,
    #[serde(default)]
    pub default_catalog: Option<String>,
    #[serde(default = "default_display_frame_id_format")]
    pub display_frame_id_format: String, // "hex" | "decimal"
    #[serde(default = "default_save_frame_id_format")]
    pub save_frame_id_format: String, // "hex" | "decimal"
    #[serde(default = "default_display_time_format")]
    pub display_time_format: String, // "delta-last" | "delta-start" | "timestamp" | "human"
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
    #[serde(default = "default_display_timezone")]
    pub display_timezone: String, // "local" | "utc"
    #[serde(default = "default_session_manager_stats_interval")]
    pub session_manager_stats_interval: u32, // seconds (0 = disabled)

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
fn default_display_timezone() -> String {
    "local".to_string()
}
fn default_session_manager_stats_interval() -> u32 {
    60 // default to 60 seconds
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

impl Default for AppSettings {
    fn default() -> Self {
        // Get platform-specific documents directory
        let documents_dir = dirs::document_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("CANdor");

        let decoder_path = documents_dir.join("Decoders");
        let dump_path = documents_dir.join("Dumps");

        Self {
            config_path: "config/candor.toml".to_string(),
            decoder_dir: decoder_path.to_string_lossy().to_string(),
            dump_dir: dump_path.to_string_lossy().to_string(),
            io_profiles: Vec::new(),
            default_read_profile: None,
            default_write_profiles: Vec::new(),
            default_catalog: None,
            display_frame_id_format: default_display_frame_id_format(),
            save_frame_id_format: default_save_frame_id_format(),
            display_time_format: default_display_time_format(),
            signal_colour_none: default_signal_colour_none(),
            signal_colour_low: default_signal_colour_low(),
            signal_colour_medium: default_signal_colour_medium(),
            signal_colour_high: default_signal_colour_high(),
            binary_one_colour: default_binary_one_colour(),
            display_timezone: default_display_timezone(),
            session_manager_stats_interval: default_session_manager_stats_interval(),
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

#[tauri::command]
pub async fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let settings_path = get_settings_path(&app)?;

    if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;

        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))
    } else {
        // First run: create default settings and directories
        let settings = AppSettings::default();
        initialize_directories(&settings)?;
        save_settings(app, settings.clone()).await?;
        Ok(settings)
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

    Ok(())
}

/// Install bundled example decoders to the user's decoder directory.
/// Only copies files that don't already exist (never overwrites).
pub fn install_example_decoders(app: &AppHandle, decoder_dir: &str) -> Result<u32, String> {
    let decoder_path = PathBuf::from(decoder_dir);

    // Resolve the bundled examples directory
    let examples_dir = app
        .path()
        .resolve("examples", BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve examples directory: {}", e))?;

    // If examples directory doesn't exist (dev mode without resources), skip silently
    if !examples_dir.exists() {
        eprintln!("[settings] Examples directory not found at {:?}, skipping installation", examples_dir);
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
            eprintln!("[settings] Skipping '{}' - already exists in decoder directory", filename);
            continue;
        }

        // Copy the file
        match std::fs::copy(&path, &dest_path) {
            Ok(_) => {
                eprintln!("[settings] Installed example decoder: {}", filename);
                installed_count += 1;
            }
            Err(e) => {
                eprintln!("[settings] Failed to install '{}': {}", filename, e);
            }
        }
    }

    if installed_count > 0 {
        eprintln!("[settings] Installed {} example decoder(s)", installed_count);
    }

    Ok(installed_count)
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let settings_path = get_settings_path(&app)?;

    // Ensure directories exist when saving
    initialize_directories(&settings)?;

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    std::fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write settings: {}", e))
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
        let test_file = dir_path.join(".candor_write_test");
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
        .user_agent("CANdor-App")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get("https://api.github.com/repos/Wired-Square/CANdor/releases/latest")
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
