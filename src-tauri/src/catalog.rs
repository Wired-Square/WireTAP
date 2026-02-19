use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;

// These structs are defined for potential future use with serde deserialization
// of catalog documents. Currently, validation uses toml::Value directly.
#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct CatalogDocument {
    pub meta: Option<MetaDoc>,
    pub sets: Option<std::collections::HashMap<String, SetDoc>>,
    pub peer: Option<std::collections::HashMap<String, PeerDoc>>,
    pub id: Option<std::collections::HashMap<String, IdBodyDoc>>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct MetaDoc {
    pub version: Option<i32>,
    pub default_endianness: Option<String>,
    pub base_id: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct SetDoc {
    pub name: Option<String>,
    pub description: Option<String>,
    pub ids: Option<Vec<String>>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct PeerDoc {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct IdBodyDoc {
    pub id: String,
    pub name: Option<String>,
    pub length: Option<i32>,
    pub description: Option<String>,
    pub signal: Option<Vec<SignalDoc>>,
    pub mux: Option<Vec<MuxDoc>>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct SignalDoc {
    pub name: String,
    pub start_bit: i32,
    pub bit_length: i32,
    pub factor: Option<f64>,
    pub offset: Option<f64>,
    pub unit: Option<String>,
    pub signed: Option<bool>,
    pub endianness: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    #[serde(rename = "enum")]
    pub enum_map: Option<std::collections::HashMap<i64, String>>,
    pub confidence: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct MuxDoc {
    pub name: String,
    pub signal: String,
    pub default: Option<String>,
    pub case: Option<Vec<MuxCaseDoc>>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct MuxCaseDoc {
    pub value: serde_json::Value,
    pub signal: Option<Vec<SignalDoc>>,
    pub mux: Option<Vec<MuxDoc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DecodedSignal {
    pub name: String,
    pub value: serde_json::Value,
    pub unit: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ValidationError {
    pub field: String,
    pub message: String,
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

/// Validation result returned to frontend
#[derive(Debug, Serialize, Deserialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<ValidationError>,
}

/// Validate catalog TOML content natively
#[tauri::command]
pub async fn validate_catalog(content: String) -> Result<ValidationResult, String> {
    let mut errors = Vec::new();

    // Try to parse the TOML
    let parsed: toml::Value = match toml::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            return Ok(ValidationResult {
                valid: false,
                errors: vec![ValidationError {
                    field: "toml".to_string(),
                    message: format!("TOML syntax error: {}", e),
                }],
            });
        }
    };

    let table = match parsed.as_table() {
        Some(t) => t,
        None => {
            return Ok(ValidationResult {
                valid: false,
                errors: vec![ValidationError {
                    field: "toml".to_string(),
                    message: "Catalog must be a TOML table".to_string(),
                }],
            });
        }
    };

    // Validate [meta] section
    if let Some(meta) = table.get("meta") {
        if let Some(meta_table) = meta.as_table() {
            // Check name
            if !meta_table.contains_key("name") {
                errors.push(ValidationError {
                    field: "meta.name".to_string(),
                    message: "Catalog name is required in [meta] section".to_string(),
                });
            }

            // Check version
            if let Some(version) = meta_table.get("version") {
                if let Some(v) = version.as_integer() {
                    if v < 1 {
                        errors.push(ValidationError {
                            field: "meta.version".to_string(),
                            message: "Version must be at least 1".to_string(),
                        });
                    }
                }
            }

            // Check default_endianness
            if let Some(endianness) = meta_table.get("default_endianness") {
                if let Some(e) = endianness.as_str() {
                    if e != "little" && e != "big" {
                        errors.push(ValidationError {
                            field: "meta.default_endianness".to_string(),
                            message: format!("Invalid endianness '{}'. Must be 'little' or 'big'", e),
                        });
                    }
                }
            }
        }
    } else {
        errors.push(ValidationError {
            field: "meta".to_string(),
            message: "Missing [meta] section".to_string(),
        });
    }

    // Validate [frame.can.*] sections
    if let Some(frame) = table.get("frame") {
        if let Some(frame_table) = frame.as_table() {
            if let Some(can) = frame_table.get("can") {
                if let Some(can_table) = can.as_table() {
                    for (frame_id, frame_def) in can_table {
                        validate_can_frame(frame_id, frame_def, &mut errors);
                    }
                }
            }
        }
    }

    Ok(ValidationResult {
        valid: errors.is_empty(),
        errors,
    })
}

/// Validate a single CAN frame definition
fn validate_can_frame(frame_id: &str, frame_def: &toml::Value, errors: &mut Vec<ValidationError>) {
    let prefix = format!("frame.can.{}", frame_id);

    let frame_table = match frame_def.as_table() {
        Some(t) => t,
        None => {
            errors.push(ValidationError {
                field: prefix.clone(),
                message: "Frame definition must be a table".to_string(),
            });
            return;
        }
    };

    // Validate length (DLC)
    if let Some(length) = frame_table.get("length") {
        if let Some(len) = length.as_integer() {
            if len < 0 || len > 64 {
                errors.push(ValidationError {
                    field: format!("{}.length", prefix),
                    message: format!("Length {} must be between 0 and 64", len),
                });
            }
        }
    }

    // Validate signals (check both "signal" and "signals" keys)
    let signals_value = frame_table.get("signal").or_else(|| frame_table.get("signals"));
    if let Some(signals) = signals_value {
        if let Some(signal_array) = signals.as_array() {
            let mut signal_names: HashMap<String, usize> = HashMap::new();

            for (idx, signal) in signal_array.iter().enumerate() {
                validate_signal(&prefix, idx, signal, &mut signal_names, errors);
            }
        }
    }

    // Validate mux (mux is an object, not an array)
    if let Some(mux) = frame_table.get("mux") {
        validate_mux_object(&prefix, mux, errors);
    }
}

/// Validate a signal definition
fn validate_signal(
    prefix: &str,
    idx: usize,
    signal: &toml::Value,
    signal_names: &mut HashMap<String, usize>,
    errors: &mut Vec<ValidationError>,
) {
    let signal_table = match signal.as_table() {
        Some(t) => t,
        None => {
            errors.push(ValidationError {
                field: format!("{}.signal[{}]", prefix, idx),
                message: "Signal must be a table".to_string(),
            });
            return;
        }
    };

    // Check required name
    let name = match signal_table.get("name") {
        Some(n) => match n.as_str() {
            Some(s) => s.to_string(),
            None => {
                errors.push(ValidationError {
                    field: format!("{}.signal[{}].name", prefix, idx),
                    message: "Signal name must be a string".to_string(),
                });
                return;
            }
        },
        None => {
            errors.push(ValidationError {
                field: format!("{}.signal[{}]", prefix, idx),
                message: "Signal must have a name".to_string(),
            });
            return;
        }
    };

    // Check for duplicate signal names
    if let Some(prev_idx) = signal_names.get(&name) {
        errors.push(ValidationError {
            field: format!("{}.signal[{}].name", prefix, idx),
            message: format!("Duplicate signal name '{}' (first defined at index {})", name, prev_idx),
        });
    } else {
        signal_names.insert(name.clone(), idx);
    }

    // DBC compatibility warnings: max 32 chars, alphanumeric + underscore only
    if name.len() > 32 {
        errors.push(ValidationError {
            field: format!("{}.signal[{}].name", prefix, idx),
            message: format!(
                "Signal name '{}' exceeds DBC limit of 32 characters ({} chars)",
                name,
                name.len()
            ),
        });
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        errors.push(ValidationError {
            field: format!("{}.signal[{}].name", prefix, idx),
            message: format!(
                "Signal name '{}' contains invalid characters for DBC export (only A-Z, a-z, 0-9, _ allowed)",
                name
            ),
        });
    }

    // Check required start_bit
    match signal_table.get("start_bit") {
        Some(sb) => {
            if let Some(bit) = sb.as_integer() {
                if bit < 0 {
                    errors.push(ValidationError {
                        field: format!("{}.signal[{}].start_bit", prefix, idx),
                        message: "start_bit must be non-negative".to_string(),
                    });
                }
            }
        }
        None => {
            errors.push(ValidationError {
                field: format!("{}.signal[{}]", prefix, idx),
                message: format!("Signal '{}' must have start_bit", name),
            });
        }
    }

    // Check required bit_length
    match signal_table.get("bit_length") {
        Some(bl) => {
            if let Some(len) = bl.as_integer() {
                if len < 1 || len > 64 {
                    errors.push(ValidationError {
                        field: format!("{}.signal[{}].bit_length", prefix, idx),
                        message: format!("bit_length {} must be between 1 and 64", len),
                    });
                }
            }
        }
        None => {
            errors.push(ValidationError {
                field: format!("{}.signal[{}]", prefix, idx),
                message: format!("Signal '{}' must have bit_length", name),
            });
        }
    }

    // Validate endianness if present
    if let Some(endianness) = signal_table.get("endianness") {
        if let Some(e) = endianness.as_str() {
            if e != "little" && e != "big" {
                errors.push(ValidationError {
                    field: format!("{}.signal[{}].endianness", prefix, idx),
                    message: format!("Invalid endianness '{}'. Must be 'little' or 'big'", e),
                });
            }
        }
    }

    // Validate min/max relationship
    if let (Some(min_val), Some(max_val)) = (signal_table.get("min"), signal_table.get("max")) {
        if let (Some(min), Some(max)) = (min_val.as_float().or_else(|| min_val.as_integer().map(|i| i as f64)),
                                          max_val.as_float().or_else(|| max_val.as_integer().map(|i| i as f64))) {
            if min > max {
                errors.push(ValidationError {
                    field: format!("{}.signal[{}]", prefix, idx),
                    message: format!("Signal '{}' has min ({}) greater than max ({})", name, min, max),
                });
            }
        }
    }
}

/// Validate a mux object (mux is an object with name, start_bit, bit_length, and numeric case keys)
fn validate_mux_object(prefix: &str, mux: &toml::Value, errors: &mut Vec<ValidationError>) {
    let mux_table = match mux.as_table() {
        Some(t) => t,
        None => {
            errors.push(ValidationError {
                field: format!("{}.mux", prefix),
                message: "Mux must be a table".to_string(),
            });
            return;
        }
    };

    let mux_prefix = format!("{}.mux", prefix);

    // Check required name
    let mux_name = match mux_table.get("name") {
        Some(n) => match n.as_str() {
            Some(s) => s.to_string(),
            None => {
                errors.push(ValidationError {
                    field: format!("{}.name", mux_prefix),
                    message: "Mux name must be a string".to_string(),
                });
                "unknown".to_string()
            }
        },
        None => {
            errors.push(ValidationError {
                field: mux_prefix.clone(),
                message: "Mux must have a name".to_string(),
            });
            "unknown".to_string()
        }
    };

    // Check required start_bit
    if mux_table.get("start_bit").is_none() {
        errors.push(ValidationError {
            field: mux_prefix.clone(),
            message: format!("Mux '{}' must have start_bit", mux_name),
        });
    }

    // Check required bit_length
    if mux_table.get("bit_length").is_none() {
        errors.push(ValidationError {
            field: mux_prefix.clone(),
            message: format!("Mux '{}' must have bit_length", mux_name),
        });
    }

    // Reserved keys that are not case values
    let reserved: std::collections::HashSet<&str> = ["name", "start_bit", "bit_length", "default"]
        .iter()
        .copied()
        .collect();

    // Validate each case (numeric keys like "0", "1", etc.)
    for (key, case_value) in mux_table {
        if reserved.contains(key.as_str()) {
            continue;
        }
        // Case keys should be numeric
        if key.parse::<i64>().is_err() {
            continue;
        }

        let case_prefix = format!("{}.{}", mux_prefix, key);

        if let Some(case_table) = case_value.as_table() {
            // Validate signals within the case
            if let Some(signals) = case_table.get("signals") {
                if let Some(signal_array) = signals.as_array() {
                    let mut signal_names: HashMap<String, usize> = HashMap::new();

                    for (sig_idx, signal) in signal_array.iter().enumerate() {
                        validate_signal(&case_prefix, sig_idx, signal, &mut signal_names, errors);
                    }
                }
            }

            // Validate nested mux (recursively)
            if let Some(nested_mux) = case_table.get("mux") {
                validate_mux_object(&case_prefix, nested_mux, errors);
            }
        }
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

    let output = Command::new("candor")
        .args(&[
            "decode",
            "--catalog", &catalog_path,
            "--input", temp_file.to_str().unwrap(),
            "--format", "jsonl",
            "--count", "1"
        ])
        .output()
        .map_err(|e| format!("Failed to run candor CLI: {}", e))?;

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

/// Import a DBC file and convert to TOML catalog format
#[tauri::command]
pub async fn import_dbc(content: String) -> Result<String, String> {
    crate::dbc_import::convert_dbc_to_toml(&content)
}

/// Export catalog to file in specified format (toml or dbc)
///
/// For DBC export, mux_mode controls how multiplexed signals are exported:
/// - "extended" (default): Uses SG_MUL_VAL_ with proper mNM notation for nested mux
/// - "flattened": Legacy mode that flattens nested mux into composite values
#[tauri::command]
pub async fn export_catalog(
    path: String,
    content: String,
    format: String,
    mux_mode: Option<String>,
) -> Result<(), String> {
    let output = match format.as_str() {
        "toml" => content,
        "dbc" => {
            let mode = match mux_mode.as_deref() {
                Some("flattened") => crate::dbc_export::MuxExportMode::Flattened,
                _ => crate::dbc_export::MuxExportMode::Extended,
            };
            crate::dbc_export::render_catalog_as_dbc_with_mode(&content, "CANdor", mode)?
        }
        _ => return Err(format!("Unknown export format: {}", format)),
    };

    std::fs::write(&path, output)
        .map_err(|e| format!("Failed to export catalog: {}", e))
}
