// src-tauri/src/dashboard.rs
//
// Standalone dashboard artifacts (`*.dashboard.json`). Stored in a `dashboards`
// subdirectory of the decoder dir, alongside the catalogs they reference. The
// path/sanitisation helpers are shared with the MCP authoring tools.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize)]
pub struct DashboardFile {
    pub name: String,
    pub filename: String,
    pub path: String,
}

/// The dashboards directory: a `dashboards` subdir of the decoder dir.
pub fn dashboards_dir(decoder_dir: &str) -> PathBuf {
    PathBuf::from(decoder_dir).join("dashboards")
}

/// Sanitise a filename and resolve it within the dashboards dir.
/// Returns (path, exists). Rejects path separators and traversal.
pub fn resolve_dashboard_path(decoder_dir: &str, filename: &str) -> Result<(PathBuf, bool), String> {
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(format!("invalid dashboard filename: {filename:?}"));
    }
    let mut name = filename.to_string();
    if !name.ends_with(".dashboard.json") {
        name = name.trim_end_matches(".json").to_string();
        name.push_str(".dashboard.json");
    }
    let path = dashboards_dir(decoder_dir).join(&name);
    let exists = path.exists();
    Ok((path, exists))
}

/// Write a dashboard file, creating the dashboards dir if needed. Returns the path.
pub fn write_dashboard(decoder_dir: &str, filename: &str, content: &str) -> Result<String, String> {
    let (path, _exists) = resolve_dashboard_path(decoder_dir, filename)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dashboards dir: {e}"))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("Failed to write dashboard: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// List `*.dashboard.json` files in the dashboards dir (name taken from JSON).
#[tauri::command]
pub async fn list_dashboards(app: AppHandle) -> Result<Vec<DashboardFile>, String> {
    let settings = crate::settings::load_settings(app).await?;
    let dir = dashboards_dir(&settings.decoder_dir);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Failed to read dashboards dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let fname = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if !fname.ends_with(".dashboard.json") {
            continue;
        }
        let name = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .unwrap_or_else(|| fname.clone());
        out.push(DashboardFile { name, filename: fname, path: path.to_string_lossy().to_string() });
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

/// Read a dashboard file by absolute path.
#[tauri::command]
pub async fn open_dashboard(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read dashboard: {e}"))
}

/// Save a dashboard by filename into the dashboards dir. Returns the full path.
#[tauri::command]
pub async fn save_dashboard(app: AppHandle, filename: String, content: String) -> Result<String, String> {
    let settings = crate::settings::load_settings(app).await?;
    write_dashboard(&settings.decoder_dir, &filename, &content)
}
