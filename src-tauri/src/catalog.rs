use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct DecodedSignal {
    pub name: String,
    pub value: serde_json::Value,
    pub unit: Option<String>,
}

/// Open and parse a catalog TOML file using the Python CLI
#[tauri::command]
pub async fn open_catalog(path: String) -> Result<String, String> {
    // Read the file directly - we'll parse it in the frontend
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read catalog file: {}", e))
}

/// Save catalog to TOML file
#[tauri::command]
pub async fn save_catalog(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write catalog file: {}", e))
}

/// Write raw bytes to a file path (used for PNG image export)
#[tauri::command]
pub async fn save_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data)
        .map_err(|e| format!("Failed to write file: {}", e))
}

/// Dispatch a `catalog.*` WS command to the shared `wiretap-catalog` crate.
/// This is the request/response half of the canonical-catalogue work: the
/// editor and tooling parse/validate/convert over the binary WebSocket instead
/// of duplicating the logic in TypeScript. (Live decode is a separate push
/// stream — see `ws::dispatch`.)
pub async fn dispatch_catalog_command(
    op_name: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let req = |key: &str| -> Result<String, String> {
        params
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("missing '{key}' param"))
    };
    let content = || req("content");

    match op_name {
        // TOML → resolved Catalog model (CAN/Serial/Modbus; shorthands +
        // mirror/copy resolved).
        "catalog.parse" => {
            let cat = wiretap_catalog::Catalog::parse(&content()?).map_err(|e| e.to_string())?;
            serde_json::to_value(cat).map_err(|e| e.to_string())
        }
        // TOML → field-path + message validation findings.
        "catalog.validate" => {
            let errors = wiretap_catalog::validate::validate(&content()?);
            Ok(serde_json::json!({ "valid": errors.is_empty(), "errors": errors }))
        }
        // DBC text → catalogue TOML.
        "catalog.import_dbc" => {
            let toml = wiretap_catalog::dbc::convert_dbc_to_toml(&content()?)?;
            Ok(serde_json::Value::String(toml))
        }
        // Attach a catalogue to a session so its frames are decoded in Rust and
        // streamed as DecodedSignals. Params: { session_id, content }.
        "catalog.attach" => {
            let session_id = req("session_id")?;
            let cat = wiretap_catalog::Catalog::parse(&content()?).map_err(|e| e.to_string())?;
            let frame_count = cat.frames.len();
            // Return the resolved Catalog so the caller can feed its UI model from
            // this one parse instead of a separate catalog.parse round-trip.
            let catalog = serde_json::to_value(&cat).map_err(|e| e.to_string())?;
            crate::ws::dispatch::attach_catalog(&session_id, cat);
            Ok(serde_json::json!({ "attached": true, "frames": frame_count, "catalog": catalog }))
        }
        // Detach a session's catalogue (decoded stream stops). Params: { session_id }.
        "catalog.detach" => {
            crate::ws::dispatch::detach_catalog(&req("session_id")?);
            Ok(serde_json::json!({ "attached": false }))
        }
        // Catalogue TOML → DBC text (extended | flattened mux).
        "catalog.export_dbc" => {
            let receiver = params
                .get("receiver")
                .and_then(|v| v.as_str())
                .unwrap_or("WireTAP");
            let mode = match params.get("muxMode").and_then(|v| v.as_str()) {
                Some("flattened") => wiretap_catalog::dbc::MuxExportMode::Flattened,
                _ => wiretap_catalog::dbc::MuxExportMode::Extended,
            };
            let dbc =
                wiretap_catalog::dbc::render_catalog_as_dbc_with_mode(&content()?, receiver, mode)?;
            Ok(serde_json::Value::String(dbc))
        }
        _ => Err(format!("Unknown catalog op: {op_name}")),
    }
}

/// Test decode a CAN frame using the catalog
#[tauri::command]
pub async fn test_decode_frame(
    catalog_path: String,
    frame_id: String,
    data: Vec<u8>,
) -> Result<Vec<DecodedSignal>, String> {
    // Create a temporary file with the frame data
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join("test_frame.log");

    // Format: timestamp arbitration_id data_bytes
    let frame_line = format!("0.0 {} {}", frame_id,
        data.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" "));

    std::fs::write(&temp_file, frame_line)
        .map_err(|e| format!("Failed to write temp frame file: {}", e))?;

    let output = Command::new("wiretap")
        .args(&[
            "decode",
            "--catalog", &catalog_path,
            "--input", temp_file.to_str().unwrap(),
            "--format", "jsonl",
            "--count", "1"
        ])
        .output()
        .map_err(|e| format!("Failed to run wiretap CLI: {}", e))?;

    // Clean up temp file
    let _ = std::fs::remove_file(&temp_file);

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Parse JSONL output to extract decoded signals
        if let Some(line) = stdout.lines().next() {
            let decoded: serde_json::Value = serde_json::from_str(line)
                .map_err(|e| format!("Failed to parse decode output: {}", e))?;

            // Extract signals from decoded JSON
            let mut signals = vec![];
            if let Some(obj) = decoded.as_object() {
                for (key, value) in obj.iter() {
                    if key != "timestamp" && key != "id" && key != "data" {
                        signals.push(DecodedSignal {
                            name: key.clone(),
                            value: value.clone(),
                            unit: None, // Would need to extract from catalog
                        });
                    }
                }
            }
            Ok(signals)
        } else {
            Ok(vec![])
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Decode failed: {}", stderr))
    }
}

use tauri::AppHandle;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct CatalogFile {
    pub name: String,
    pub filename: String,
    pub path: String,
}

/// List available catalog decoders from the decoder directory
#[tauri::command]
pub async fn list_catalogs(app: AppHandle) -> Result<Vec<CatalogFile>, String> {
    // Load settings to get decoder directory
    let settings = crate::settings::load_settings(app).await?;
    let decoder_dir = PathBuf::from(&settings.decoder_dir);

    if !decoder_dir.exists() {
        return Ok(vec![]);
    }

    let mut catalogs = Vec::new();

    // Read all .toml files from the decoder directory
    let entries = std::fs::read_dir(&decoder_dir)
        .map_err(|e| format!("Failed to read decoder directory: {}", e))?;

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("toml") {
                let filename = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();

                // Try to parse the catalog to get the name
                let name = if let Ok(content) = std::fs::read_to_string(&path) {
                    extract_catalog_name(&content).unwrap_or_else(|| filename.clone())
                } else {
                    filename.clone()
                };

                catalogs.push(CatalogFile {
                    name,
                    filename,
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }

    // Sort by filename
    catalogs.sort_by(|a, b| a.filename.cmp(&b.filename));

    Ok(catalogs)
}

/// Extract catalog name from TOML content
fn extract_catalog_name(content: &str) -> Option<String> {
    // Simple parser to extract name from [meta] section
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("name") && line.contains('=') {
            if let Some(name_part) = line.split('=').nth(1) {
                let name = name_part
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
    }
    None
}

/// Duplicate a catalog file
#[tauri::command]
pub async fn duplicate_catalog(
    source_path: String,
    new_filename: String,
    new_name: String,
) -> Result<(), String> {
    let source = PathBuf::from(&source_path);
    let parent_dir = source.parent()
        .ok_or_else(|| "Invalid source path".to_string())?;
    let dest = parent_dir.join(&new_filename);

    // Read source content
    let mut content = std::fs::read_to_string(&source)
        .map_err(|e| format!("Failed to read source catalog: {}", e))?;

    // Update the name in the content if present
    if let Some(start_idx) = content.find("name = ") {
        if let Some(line_end) = content[start_idx..].find('\n') {
            let end_idx = start_idx + line_end;
            let updated_line = format!("name = \"{}\"", new_name);
            content.replace_range(start_idx..end_idx, &updated_line);
        }
    }

    // Write to destination
    std::fs::write(&dest, content)
        .map_err(|e| format!("Failed to write duplicated catalog: {}", e))?;

    Ok(())
}

/// Rename/edit a catalog file
#[tauri::command]
pub async fn rename_catalog(
    old_path: String,
    new_filename: String,
    new_name: String,
) -> Result<(), String> {
    let old_path_buf = PathBuf::from(&old_path);
    let parent_dir = old_path_buf.parent()
        .ok_or_else(|| "Invalid path".to_string())?;
    let new_path = parent_dir.join(&new_filename);

    // Read content
    let mut content = std::fs::read_to_string(&old_path_buf)
        .map_err(|e| format!("Failed to read catalog: {}", e))?;

    // Update the name in the content if present
    if let Some(start_idx) = content.find("name = ") {
        if let Some(line_end) = content[start_idx..].find('\n') {
            let end_idx = start_idx + line_end;
            let updated_line = format!("name = \"{}\"", new_name);
            content.replace_range(start_idx..end_idx, &updated_line);
        }
    }

    // If filename changed, move the file
    if old_path != new_path.to_string_lossy().to_string() {
        // Write to new location
        std::fs::write(&new_path, &content)
            .map_err(|e| format!("Failed to write renamed catalog: {}", e))?;

        // Remove old file
        std::fs::remove_file(&old_path_buf)
            .map_err(|e| format!("Failed to remove old catalog: {}", e))?;
    } else {
        // Just update content
        std::fs::write(&new_path, &content)
            .map_err(|e| format!("Failed to update catalog: {}", e))?;
    }

    Ok(())
}

/// Delete a catalog file
#[tauri::command]
pub async fn delete_catalog(path: String) -> Result<(), String> {
    std::fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete catalog: {}", e))
}
