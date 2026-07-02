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
pub async fn save_catalog(app: AppHandle, path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write catalog file: {}", e))?;
    refresh_catalog_cache(&app);
    Ok(())
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
        // Granular, save-time form validation (single source of truth in the
        // crate). Each deserialises `params` into the matching input struct.
        "catalog.validateMeta" => {
            let input = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let errors = wiretap_catalog::validate::validate_meta_fields(&input);
            Ok(serde_json::json!({ "valid": errors.is_empty(), "errors": errors }))
        }
        "catalog.validateFrame" => {
            let input = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let errors = wiretap_catalog::validate::validate_frame_fields(&input);
            Ok(serde_json::json!({ "valid": errors.is_empty(), "errors": errors }))
        }
        "catalog.validateSignal" => {
            let input = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let errors = wiretap_catalog::validate::validate_signal_fields(&input);
            Ok(serde_json::json!({ "valid": errors.is_empty(), "errors": errors }))
        }
        "catalog.validateChecksum" => {
            let input = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let errors = wiretap_catalog::validate::validate_checksum_fields(&input);
            Ok(serde_json::json!({ "valid": errors.is_empty(), "errors": errors }))
        }
        // DBC text → catalogue TOML.
        "catalog.import_dbc" => {
            let toml = wiretap_catalog::dbc::convert_dbc_to_toml(&content()?)?;
            Ok(serde_json::Value::String(toml))
        }
        // Attach a catalogue to a session so its frames are decoded in Rust and
        // streamed as DecodedSignals. Params: { session_id, content, path? }. The
        // optional `path` is recorded as the session's authoritative decoder path and
        // surfaced back to the frontend via `ActiveSessionInfo.catalog_path`.
        "catalog.attach" => {
            let session_id = req("session_id")?;
            let path = params.get("path").and_then(|v| v.as_str()).map(str::to_string);
            let cat = wiretap_catalog::Catalog::parse(&content()?).map_err(|e| e.to_string())?;
            let frame_count = cat.frames.len();
            // Return the resolved Catalog so the caller can feed its UI model from
            // this one parse instead of a separate catalog.parse round-trip.
            let catalog = serde_json::to_value(&cat).map_err(|e| e.to_string())?;
            crate::ws::dispatch::attach_catalog(&session_id, path, cat);
            // Decode frames already delivered before this attach (e.g. a capture replay
            // that started before the catalogue bound) so they don't show "No signals".
            crate::ws::dispatch::redecode_delivered(&session_id);
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
        // Comment-/formatting-preserving in-place edit. Params: { content, op, ...opArgs }.
        // `op` + args deserialise into wiretap_catalog::edit::EditOp (the stray
        // `content` key is ignored); returns the new TOML text.
        "catalog.edit" => {
            let text = content()?;
            let op: wiretap_catalog::edit::EditOp = serde_json::from_value(params.clone())
                .map_err(|e| format!("invalid edit op: {e}"))?;
            let next = wiretap_catalog::edit::apply_edit(&text, op)?;
            Ok(serde_json::Value::String(next))
        }
        // Upgrade a catalogue's text to the current schema (comment-preserving).
        // Returns { changed, toml, summary }. The editor loads the result as the
        // working buffer while keeping the on-disk text as the diff baseline, so a
        // silent in-memory migration surfaces as a real, saveable diff. Params:
        // { content }.
        "catalog.migrate" => {
            let m = wiretap_catalog::migrate::migrate(&content()?).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "changed": m.changed,
                "toml": m.toml,
                "summary": m.summary,
            }))
        }
        // Catalogue TOML → Modbus poll groups (the single source of truth for the
        // catalogue → polls mapping, shared with the MCP/headless open flow). The
        // editor passes these to the Modbus reader as `modbus_polls`. Empty for a
        // non-Modbus catalogue. Params: { content }.
        "catalog.polls" => {
            let polls = crate::io::build_polls_from_catalog(&content()?)?;
            serde_json::to_value(polls).map_err(|e| e.to_string())
        }
        // Line diff of the working buffer against the last-saved baseline. Drives
        // both the unsaved-changes indicator and the Text-mode diff view from one
        // Rust-computed source. Params: { current, baseline }.
        "catalog.diff" => {
            let current = req("current")?;
            let baseline = req("baseline")?;
            Ok(diff_lines_json(&baseline, &current))
        }
        _ => Err(format!("Unknown catalog op: {op_name}")),
    }
}

/// A unified line diff (baseline → current) plus a `dirty` flag, as JSON for the
/// editor. Full-context: every line is emitted as `context` | `add` | `remove`
/// with 1-based old/new line numbers for the gutter.
fn diff_lines_json(baseline: &str, current: &str) -> serde_json::Value {
    let a: Vec<&str> = baseline.split('\n').collect();
    let b: Vec<&str> = current.split('\n').collect();
    serde_json::json!({
        "dirty": baseline != current,
        "lines": lcs_diff(&a, &b),
    })
}

fn diff_row(kind: &str, text: &str, old_line: Option<usize>, new_line: Option<usize>) -> serde_json::Value {
    serde_json::json!({ "kind": kind, "text": text, "oldLine": old_line, "newLine": new_line })
}

/// Longest-common-subsequence line diff. O(n·m) — fine for catalogue-sized files.
fn lcs_diff(a: &[&str], b: &[&str]) -> Vec<serde_json::Value> {
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut rows = Vec::new();
    let (mut i, mut j, mut oln, mut nln) = (0, 0, 1usize, 1usize);
    while i < n && j < m {
        if a[i] == b[j] {
            rows.push(diff_row("context", a[i], Some(oln), Some(nln)));
            i += 1;
            j += 1;
            oln += 1;
            nln += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            rows.push(diff_row("remove", a[i], Some(oln), None));
            i += 1;
            oln += 1;
        } else {
            rows.push(diff_row("add", b[j], None, Some(nln)));
            j += 1;
            nln += 1;
        }
    }
    while i < n {
        rows.push(diff_row("remove", a[i], Some(oln), None));
        i += 1;
        oln += 1;
    }
    while j < m {
        rows.push(diff_row("add", b[j], None, Some(nln)));
        j += 1;
        nln += 1;
    }
    rows
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

use tauri::{AppHandle, Manager};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogFile {
    pub name: String,
    pub filename: String,
    pub path: String,
}

/// Backend-owned, always-warm cache of the decoder-directory catalogue list.
///
/// The list used to be re-scanned from disk on every `list_catalogs()` call,
/// and ~8 frontend consumers each fetched on their own mount across two
/// windows — so the picker showed an empty list until each async fetch
/// resolved, and the directory was re-walked (and the duplicate-name warning
/// re-logged) once per consumer. The cache is built once at startup, served
/// from memory, and kept fresh by mutation commands + a filesystem watcher.
#[derive(Default)]
pub struct CatalogCache {
    state: Mutex<CatalogCacheState>,
    /// Holds the live filesystem watcher; dropping it stops watching. Desktop
    /// only — iOS has no decoder directory to watch. Write-only (a keep-alive
    /// guard, never read back), hence the allow.
    #[cfg(not(target_os = "ios"))]
    #[allow(dead_code)]
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

#[derive(Default)]
struct CatalogCacheState {
    /// Directory the cache was last built from. `None` until first warm; used
    /// to detect a decoder-dir change and to serve without re-resolving settings.
    dir: Option<PathBuf>,
    catalogs: Vec<CatalogFile>,
}

/// Walk the decoder directory and build the catalogue list. Pure (no shared
/// state); the duplicate-name warning is logged here so it fires once per
/// rebuild rather than once per consumer fetch.
fn scan_catalogs(decoder_dir: &Path) -> Vec<CatalogFile> {
    let mut catalogs = Vec::new();

    let entries = match std::fs::read_dir(decoder_dir) {
        Ok(e) => e,
        Err(e) => {
            tlog!("[catalog] Failed to read decoder directory {:?}: {}", decoder_dir, e);
            return catalogs;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("toml") {
            continue;
        }
        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = match std::fs::read_to_string(&path) {
            Ok(content) => extract_catalog_name(&content).unwrap_or_else(|| filename.clone()),
            Err(_) => filename.clone(),
        };
        catalogs.push(CatalogFile {
            name,
            filename,
            path: path.to_string_lossy().to_string(),
        });
    }

    catalogs.sort_by(|a, b| a.filename.cmp(&b.filename));

    // Warn (non-fatal) when two or more catalogs share a display name. Selection is keyed
    // by filename/path, so this is harmless — but it makes the picker show identical labels
    // and is worth surfacing so a future "wrong catalog" report explains itself.
    let mut filenames_by_name: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for c in &catalogs {
        filenames_by_name.entry(c.name.as_str()).or_default().push(c.filename.as_str());
    }
    for (name, filenames) in &filenames_by_name {
        if filenames.len() > 1 {
            tlog!(
                "[catalog] {} decoders share the display name '{}': {:?} — they're disambiguated by filename",
                filenames.len(), name, filenames
            );
        }
    }

    catalogs
}

/// Resolve the decoder directory from settings (synchronously). Returns `None`
/// when settings can't be read or the directory doesn't exist.
fn resolve_decoder_dir(app: &AppHandle) -> Option<PathBuf> {
    let settings = crate::settings::load_settings_sync(app)
        .map_err(|e| tlog!("[catalog] Could not load settings for decoder dir: {}", e))
        .ok()?;
    let dir = PathBuf::from(&settings.decoder_dir);
    dir.exists().then_some(dir)
}

/// Rebuild the catalogue cache from the current decoder directory, store it, and
/// signal all WS clients (CatalogListChanged) to reconcile. Returns the fresh list.
pub fn refresh_catalog_cache(app: &AppHandle) -> Vec<CatalogFile> {
    let dir = match resolve_decoder_dir(app) {
        Some(d) => d,
        None => return Vec::new(),
    };
    let catalogs = scan_catalogs(&dir);
    {
        let cache = app.state::<CatalogCache>();
        let mut st = cache.state.lock().unwrap();
        st.dir = Some(dir);
        st.catalogs = catalogs.clone();
    }
    // Signal every connected WS client; each reconciles via list_catalogs.
    crate::ws::dispatch::send_catalog_list_changed(&catalogs);
    catalogs
}

/// Rebuild the cache for the current decoder directory and (re)point the
/// filesystem watcher at it. Returns the fresh list.
fn rebuild_and_watch(app: &AppHandle) -> Vec<CatalogFile> {
    let list = refresh_catalog_cache(app);
    if let Err(e) = restart_watcher(app) {
        tlog!("[catalog] decoder-dir watcher error: {}", e);
    }
    list
}

/// Warm the cache and start watching the decoder directory. Call once during
/// app setup, after example decoders are installed.
pub fn start_catalog_cache(app: &AppHandle) {
    let list = rebuild_and_watch(app);
    tlog!("[catalog] Cache warmed: {} decoder(s)", list.len());
}

/// React to a settings save: if the decoder directory changed, rebuild the cache
/// for the new directory and re-point the filesystem watcher.
pub fn handle_decoder_dir_change(app: &AppHandle, new_dir: &str) {
    // `try_state`, not `state`: save_settings can run during early setup (via
    // load_settings' first-run init) before the cache is managed.
    let Some(cache) = app.try_state::<CatalogCache>() else {
        return;
    };
    let changed = {
        let st = cache.state.lock().unwrap();
        st.dir.as_deref() != Some(Path::new(new_dir))
    };
    if changed {
        rebuild_and_watch(app);
    }
}

/// (Re)create the filesystem watcher on the current decoder directory. A burst
/// of filesystem events is debounced before a single cache rebuild + emit. The
/// previous watcher (and its debounce thread) is torn down when replaced.
#[cfg(not(target_os = "ios"))]
fn restart_watcher(app: &AppHandle) -> Result<(), String> {
    use notify::{EventKind, RecursiveMode, Watcher};
    use std::time::Duration;

    let dir = match resolve_decoder_dir(app) {
        Some(d) => d,
        None => return Ok(()),
    };

    // The watcher handler runs on notify's own thread; it only nudges the
    // debounce channel. A dedicated thread coalesces bursts and rebuilds, so a
    // multi-file edit triggers one scan, not one per event.
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let relevant = matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) && event
                .paths
                .iter()
                .any(|p| p.extension().and_then(|s| s.to_str()) == Some("toml"));
            if relevant {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("watcher init: {}", e))?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch {:?}: {}", dir, e))?;

    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        // Exits when the watcher (the sole sender) is dropped on the next restart.
        while rx.recv().is_ok() {
            std::thread::sleep(Duration::from_millis(250));
            while rx.try_recv().is_ok() {}
            refresh_catalog_cache(&app_for_thread);
        }
    });

    let cache = app.state::<CatalogCache>();
    let mut slot = cache.watcher.lock().unwrap();
    *slot = Some(watcher); // dropping the old watcher stops its debounce thread
    Ok(())
}

// iOS has no filesystem watcher: the cache is warmed once at startup and
// refreshed only via the explicit mutation/settings paths (which call
// refresh_catalog_cache directly), never from out-of-band file changes.
#[cfg(target_os = "ios")]
fn restart_watcher(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

/// List available catalog decoders. Served from the warm, backend-owned cache so
/// the first frontend call returns a populated list immediately. Falls back to a
/// one-off scan only if the cache was never built (shouldn't happen post-setup).
#[tauri::command]
pub async fn list_catalogs(app: AppHandle) -> Result<Vec<CatalogFile>, String> {
    {
        let cache = app.state::<CatalogCache>();
        let st = cache.state.lock().unwrap();
        if st.dir.is_some() {
            return Ok(st.catalogs.clone());
        }
    }
    Ok(refresh_catalog_cache(&app))
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
    app: AppHandle,
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

    refresh_catalog_cache(&app);
    Ok(())
}

/// Rename/edit a catalog file
#[tauri::command]
pub async fn rename_catalog(
    app: AppHandle,
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

    refresh_catalog_cache(&app);
    Ok(())
}

/// Delete a catalog file
#[tauri::command]
pub async fn delete_catalog(app: AppHandle, path: String) -> Result<(), String> {
    std::fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete catalog: {}", e))?;
    refresh_catalog_cache(&app);
    Ok(())
}
