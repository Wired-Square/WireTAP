use serde::{Deserialize, Serialize};

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
    write_file_atomically(Path::new(&path), content.as_bytes())?;
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
    conn_id: usize,
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
        // streamed as DecodedSignals. Params: { session_id, content, path?, subscriber? }.
        // The optional `path` is recorded as the session's authoritative decoder path and
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
            if let Some(subscriber) = params.get("subscriber").and_then(|v| v.as_str()) {
                crate::ws::dispatch::redecode_delivered(&session_id, conn_id, subscriber);
            }
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
        // Params: { content, ops }. All or nothing; returns the new TOML text.
        "catalog.edits" => {
            let next = wiretap_catalog::edit::apply_edits(&content()?, &edit_ops(&params)?)?;
            Ok(serde_json::Value::String(next))
        }
        // A new catalogue from `ops` alone, refused with its findings unless it validates.
        // Params: { ops }.
        "catalog.build" => {
            let text = wiretap_catalog::edit::apply_edits("", &edit_ops(&params)?)?;
            refuse_unless_valid(&text)?;
            Ok(serde_json::Value::String(text))
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

fn edit_ops(params: &serde_json::Value) -> Result<Vec<wiretap_catalog::edit::EditOp>, String> {
    let ops = params.get("ops").cloned().ok_or("missing 'ops' param")?;
    serde_json::from_value(ops).map_err(|e| format!("invalid edit op: {e}"))
}

fn refuse_unless_valid(text: &str) -> Result<(), String> {
    let findings = wiretap_catalog::validate::validate(text);
    if findings.is_empty() {
        return Ok(());
    }
    let lines: Vec<String> = findings
        .iter()
        .map(|f| format!("{}: {}", f.field, f.message))
        .collect();
    Err(format!(
        "The catalogue did not validate, so it was not saved:\n{}",
        lines.join("\n")
    ))
}

/// What a diff row says happened to its line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiffKind {
    Context,
    Add,
    Remove,
}

/// One row of a unified diff, with 1-based line numbers for the gutter.
///
/// A struct rather than `serde_json::Value` because two commands return these and one
/// of them counts them by kind: `row["kind"] == "add"` on untyped JSON compiles just
/// as happily when the string is wrong, and reports zero.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffRow {
    pub kind: DiffKind,
    pub text: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
}

/// A unified line diff (baseline → current). Full-context: every line is emitted as
/// context, add or remove.
///
/// Exposed for callers that already hold both texts — the push dialog's `publish_diff`
/// reads them out of the git clone, so routing them back through the `catalog.diff`
/// command would ship both files to the frontend and straight back again.
pub(crate) fn diff_lines(baseline: &str, current: &str) -> Vec<DiffRow> {
    let a: Vec<&str> = baseline.split('\n').collect();
    let b: Vec<&str> = current.split('\n').collect();
    lcs_diff(&a, &b)
}

/// [`diff_lines`] plus a `dirty` flag, as JSON for the editor.
fn diff_lines_json(baseline: &str, current: &str) -> serde_json::Value {
    serde_json::json!({
        "dirty": baseline != current,
        "lines": diff_lines(baseline, current),
    })
}

fn diff_row(kind: DiffKind, text: &str, old_line: Option<usize>, new_line: Option<usize>) -> DiffRow {
    DiffRow {
        kind,
        text: text.to_string(),
        old_line,
        new_line,
    }
}

/// Above this many `n * m` cells the LCS table costs more than the diff is worth
/// (4 bytes per cell, so 25M cells ≈ 100 MB). Catalogues are a few thousand lines
/// at most; anything past this is pathological or hostile — an imported file, an
/// MCP write, or a paste into text mode — so degrade instead of allocating.
const MAX_LCS_CELLS: usize = 25_000_000;

/// Longest-common-subsequence line diff. O(n·m) in time and memory, so bounded
/// by [`MAX_LCS_CELLS`]; beyond that it falls back to remove-all/add-all, which
/// is a truthful (if coarse) diff rather than an out-of-memory abort.
fn lcs_diff(a: &[&str], b: &[&str]) -> Vec<DiffRow> {
    let (n, m) = (a.len(), b.len());
    if n.saturating_mul(m) > MAX_LCS_CELLS {
        let mut rows = Vec::with_capacity(n + m);
        rows.extend(
            a.iter()
                .enumerate()
                .map(|(i, line)| diff_row(DiffKind::Remove, line, Some(i + 1), None)),
        );
        rows.extend(
            b.iter()
                .enumerate()
                .map(|(j, line)| diff_row(DiffKind::Add, line, None, Some(j + 1))),
        );
        return rows;
    }
    // One flat allocation rather than `vec![vec![]; n + 1]`: the nested form is n+1
    // separate heap blocks for the same bytes, and a contiguous row keeps the inner
    // loop's reads adjacent.
    let stride = m + 1;
    let mut dp = vec![0u32; (n + 1) * stride];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * stride + j] = if a[i] == b[j] {
                dp[(i + 1) * stride + j + 1] + 1
            } else {
                dp[(i + 1) * stride + j].max(dp[i * stride + j + 1])
            };
        }
    }
    let mut rows = Vec::new();
    let (mut i, mut j, mut oln, mut nln) = (0, 0, 1usize, 1usize);
    while i < n && j < m {
        if a[i] == b[j] {
            rows.push(diff_row(DiffKind::Context, a[i], Some(oln), Some(nln)));
            i += 1;
            j += 1;
            oln += 1;
            nln += 1;
        } else if dp[(i + 1) * stride + j] >= dp[i * stride + j + 1] {
            rows.push(diff_row(DiffKind::Remove, a[i], Some(oln), None));
            i += 1;
            oln += 1;
        } else {
            rows.push(diff_row(DiffKind::Add, b[j], None, Some(nln)));
            j += 1;
            nln += 1;
        }
    }
    while i < n {
        rows.push(diff_row(DiffKind::Remove, a[i], Some(oln), None));
        i += 1;
        oln += 1;
    }
    while j < m {
        rows.push(diff_row(DiffKind::Add, b[j], None, Some(nln)));
        j += 1;
        nln += 1;
    }
    rows
}

use tauri::{AppHandle, Manager};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::catalog_share::registry::{CatalogSourceRegistry, SyncIndex, SyncStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFile {
    pub name: String,
    pub filename: String,
    pub path: String,
    /// How this catalogue stands across **every** repository tracking it, folded by
    /// `registry::aggregate_status`.
    ///
    /// Resolved here rather than joined in the frontend: the picker is mounted by
    /// five panels that otherwise never touch the sharing store, and making each of
    /// them import it to answer one question would put the whole share subtree in
    /// their bundles. The scan already reads every file, so this is a hash over bytes
    /// already in hand.
    pub sync_status: SyncStatus,
    /// How many repositories track this file — `0` exactly when `sync_status` is
    /// `LocalOnly`.
    ///
    /// The count and not the list: the per-repository rows already have a home on
    /// `TrackedCatalog`, and reproducing them here would make the directory scan
    /// resolve repository *labels*, coupling it to a table it deliberately does not
    /// know about. A summary glyph with no hint that it summarises more than one
    /// answer is the dishonest part, and a `Vec::len()` already in hand fixes that.
    pub tracked_repo_count: usize,
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
///
/// `index` supplies the git provenance, snapshotted by the caller so the registry
/// lock is not held across a directory walk and N file reads.
fn scan_catalogs(decoder_dir: &Path, index: &SyncIndex) -> Vec<CatalogFile> {
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
        // One read serves both the display name and the sync status: hashing bytes
        // already in memory is what keeps the status free. Raw bytes rather than
        // `read_to_string`, so a catalogue that is not valid UTF-8 still hashes
        // correctly instead of reading as a missing file.
        let bytes = std::fs::read(&path).ok();
        let name = bytes
            .as_deref()
            .and_then(|b| extract_catalog_name(&String::from_utf8_lossy(b)))
            .unwrap_or_else(|| filename.clone());
        let sync = index.status_for(&filename, bytes.as_deref());
        catalogs.push(CatalogFile {
            name,
            filename,
            path: path.to_string_lossy().to_string(),
            sync_status: sync.status,
            tracked_repo_count: sync.tracked_repos,
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
    decoder_dir(app).filter(|dir| dir.exists())
}

/// Rebuild the catalogue cache from the current decoder directory, store it, and
/// signal all WS clients (CatalogListChanged) to reconcile. Returns the fresh list.
pub fn refresh_catalog_cache(app: &AppHandle) -> Vec<CatalogFile> {
    let dir = match resolve_decoder_dir(app) {
        Some(d) => d,
        None => return Vec::new(),
    };
    let catalogs = scan_catalogs(&dir, &sync_index(app));
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

/// The provenance registry, snapshotted for the scan's join.
///
/// `try_state` rather than `state`: this runs from `start_catalog_cache` inside the
/// setup hook, and `lib.rs` registers some state on the builder and some inside that
/// hook. Builder state does land first today, but degrading to "nothing is tracked"
/// costs nothing and does not make catalogue listing depend on that ordering.
fn sync_index(app: &AppHandle) -> SyncIndex {
    app.try_state::<CatalogSourceRegistry>()
        .map(|registry| registry.read(app, |r| r.sync_index()))
        .unwrap_or_default()
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
/// app setup, after settings have resolved.
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

/// The catalogue a caller named, by filename, display name or bare filename
/// without its `.toml`.
pub async fn find_catalog(app: &AppHandle, name: &str) -> Result<CatalogFile, String> {
    let catalogs = list_catalogs(app.clone()).await?;
    catalog_named(&catalogs, name)
        .cloned()
        .ok_or_else(|| format!("Catalog '{name}' not found — use list_catalogs"))
}

fn catalog_named<'a>(catalogs: &'a [CatalogFile], name: &str) -> Option<&'a CatalogFile> {
    let want = name.trim();
    let with_suffix = format!("{want}.toml");
    catalogs
        .iter()
        .find(|c| c.filename == want || c.name == want || c.filename == with_suffix)
}

/// `[meta].name` alone, so a catalogue that fails validation still shows its name.
fn extract_catalog_name(content: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Head {
        meta: Option<Meta>,
    }
    #[derive(Deserialize)]
    struct Meta {
        name: Option<String>,
    }
    toml::from_str::<Head>(content)
        .ok()?
        .meta?
        .name
        .filter(|n| !n.trim().is_empty())
}

/// Reject a filename that is not a bare, visible name.
///
/// Shared by every path that turns outside input into a file under a
/// user-data directory — catalogues here, dashboards in `dashboard.rs` — so the
/// traversal guard has one implementation rather than one per suffix.
pub fn reject_unsafe_filename(filename: &str) -> Result<&str, String> {
    let name = filename.trim();
    if name.is_empty() {
        return Err("Filename is empty".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!(
            "Invalid filename '{name}' — must be a bare name with no path separators"
        ));
    }
    // A leading dot would hide the file from the directory scanners.
    if name.starts_with('.') {
        return Err(format!("Invalid filename '{name}' — must not start with a dot"));
    }
    Ok(name)
}

/// Reduce an untrusted name to a bare `*.toml` filename.
///
/// The single implementation for every path that names a file in the decoder
/// directory: the MCP write tools, the git import, and the duplicate/rename
/// commands below.
pub fn sanitise_catalog_filename(filename: &str) -> Result<String, String> {
    let name = reject_unsafe_filename(filename)?;
    if name.to_lowercase().ends_with(".toml") {
        Ok(name.to_string())
    } else {
        Ok(format!("{name}.toml"))
    }
}

/// Write a file via a temp name plus rename, so no reader can observe a partial
/// file.
///
/// Matters for anything in the decoder directory: the `notify` watcher fires on
/// create/modify, and `scan_catalogs` swallows read failures and falls back to
/// the filename — so a torn read shows up as a catalogue with the wrong name
/// rather than as an error.
pub fn write_file_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp-write");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to replace {}: {e}", path.display())
    })
}

/// First unused `name-N.toml` beside `name.toml`, for a non-destructive save.
pub fn next_free_catalog_filename(dir: &Path, desired: &str) -> String {
    let stem = desired.strip_suffix(".toml").unwrap_or(desired);
    (2..1000)
        .map(|n| format!("{stem}-{n}.toml"))
        .find(|candidate| !dir.join(candidate).exists())
        .unwrap_or_else(|| format!("{stem}-{}.toml", chrono::Utc::now().timestamp()))
}

/// The configured decoder directory, whether or not it exists yet.
pub fn decoder_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::settings::load_settings_sync(app)
        .ok()
        .map(|s| PathBuf::from(s.decoder_dir))
}

/// Land an outside catalogue in the decoder directory, returning its new path.
///
/// The frontend picks the file (and converts DBC to TOML on the way), but naming
/// stays here with the other writers: one sanitiser and one non-destructive
/// collision rule cover every path into that directory, resolved against the
/// directory itself rather than a list the frontend happens to be holding.
///
/// Deliberately unvalidated, unlike the git import — a file the user picked
/// themselves is often a broken catalogue on its way to the editor to be fixed.
#[tauri::command]
pub async fn import_catalog(
    app: AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    let dir = decoder_dir(&app).ok_or_else(|| "No decoder directory is set".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

    let desired = sanitise_catalog_filename(&filename)?;
    let free = if dir.join(&desired).exists() {
        next_free_catalog_filename(&dir, &desired)
    } else {
        desired
    };

    let path = dir.join(free);
    write_file_atomically(&path, content.as_bytes())?;
    refresh_catalog_cache(&app);
    Ok(path.to_string_lossy().into_owned())
}

fn with_catalogue_name(content: &str, new_name: &str) -> Result<String, String> {
    wiretap_catalog::edit::apply_edit(
        content,
        wiretap_catalog::edit::EditOp::SetTable {
            path: vec!["meta".into()],
            value: serde_json::Map::from_iter([("name".into(), new_name.into())]),
            managed_keys: Vec::new(),
            replace_contents: false,
            sort_parent_numeric: false,
            skip_if_exists: false,
            error_if_exists: false,
        },
    )
}

#[cfg(unix)]
fn is_same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => (a.dev(), a.ino()) == (b.dev(), b.ino()),
        _ => false,
    }
}

#[cfg(not(unix))]
fn is_same_file(a: &Path, b: &Path) -> bool {
    a.parent() == b.parent()
        && a.file_name().map(|n| n.to_string_lossy().to_lowercase())
            == b.file_name().map(|n| n.to_string_lossy().to_lowercase())
}

/// The destination is the user's choice, so a taken name is an error rather
/// than a quiet `next_free_catalog_filename`.
fn refuse_existing(dest: &Path, filename: &str) -> Result<(), String> {
    if dest.exists() {
        return Err(format!("A catalogue file named '{filename}' already exists"));
    }
    Ok(())
}

fn duplicate_catalogue_file(source: &Path, new_filename: &str, new_name: &str) -> Result<(), String> {
    let parent_dir = source.parent()
        .ok_or_else(|| "Invalid source path".to_string())?;
    let new_filename = sanitise_catalog_filename(new_filename)?;
    let dest = parent_dir.join(&new_filename);
    refuse_existing(&dest, &new_filename)?;

    let content = std::fs::read_to_string(source)
        .map_err(|e| format!("Failed to read source catalog: {}", e))?;
    write_file_atomically(&dest, with_catalogue_name(&content, new_name)?.as_bytes())
}

/// Duplicate a catalog file
#[tauri::command]
pub async fn duplicate_catalog(
    app: AppHandle,
    source_path: String,
    new_filename: String,
    new_name: String,
) -> Result<(), String> {
    duplicate_catalogue_file(Path::new(&source_path), &new_filename, &new_name)?;
    refresh_catalog_cache(&app);
    Ok(())
}

/// Returns the sanitised new filename.
fn rename_catalogue_file(old_path: &Path, new_filename: &str, new_name: &str) -> Result<String, String> {
    let parent_dir = old_path.parent()
        .ok_or_else(|| "Invalid path".to_string())?;
    let new_filename = sanitise_catalog_filename(new_filename)?;
    let new_path = parent_dir.join(&new_filename);
    if !is_same_file(old_path, &new_path) {
        refuse_existing(&new_path, &new_filename)?;
    }

    let content = std::fs::read_to_string(old_path)
        .map_err(|e| format!("Failed to read catalog: {}", e))?;
    write_file_atomically(old_path, with_catalogue_name(&content, new_name)?.as_bytes())?;
    // A rename, not write-new-then-delete-old: on a case-insensitive filesystem
    // a case-only change makes both paths the same file.
    if old_path != new_path {
        std::fs::rename(old_path, &new_path)
            .map_err(|e| format!("Failed to rename catalog: {}", e))?;
    }
    Ok(new_filename)
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
    let new_filename = rename_catalogue_file(&old_path_buf, &new_filename, &new_name)?;

    // Carry any git provenance across to the new filename, so a rename doesn't
    // silently detach the catalogue from the repository it came from.
    if let Some(old_name) = old_path_buf.file_name().and_then(|n| n.to_str()) {
        crate::catalog_share::registry::on_catalog_renamed(&app, old_name, &new_filename);
    }

    refresh_catalog_cache(&app);
    Ok(())
}

/// Delete a catalog file
#[tauri::command]
pub async fn delete_catalog(app: AppHandle, path: String) -> Result<(), String> {
    std::fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete catalog: {}", e))?;

    if let Some(name) = PathBuf::from(&path).file_name().and_then(|n| n.to_str()) {
        crate::catalog_share::registry::on_catalog_deleted(&app, name);
    }

    refresh_catalog_cache(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog_share::registry::{git_blob_sha, Registry};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wiretap-catalog-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).expect("write catalogue");
    }

    #[test]
    fn renaming_a_catalogue_leaves_its_signal_names_alone() {
        let catalogue = "[[frame.can.0x100.signals]]\nname = \"Voltage\"\nstart_bit = 0\nbit_length = 16\n\n[meta]\nname = \"Pack\"\nversion = 1\n";

        let renamed = with_catalogue_name(catalogue, "Pack copy").expect("rename");

        assert_eq!(extract_catalog_name(&renamed).as_deref(), Some("Pack copy"));
        assert!(renamed.contains("name = \"Voltage\""), "signal renamed:\n{renamed}");
    }

    #[test]
    fn duplicating_onto_an_existing_file_name_is_refused() {
        let dir = temp_dir("dup-collision");
        write(&dir, "pack.toml", "[meta]\nname = \"Pack\"\n");
        write(&dir, "other.toml", "[meta]\nname = \"Other\"\n");

        let err = duplicate_catalogue_file(&dir.join("pack.toml"), "other", "Pack copy")
            .expect_err("an existing file must not be overwritten");

        assert!(err.contains("other.toml"), "error should name the file: {err}");
        let other = std::fs::read_to_string(dir.join("other.toml")).unwrap();
        assert_eq!(extract_catalog_name(&other).as_deref(), Some("Other"));
    }

    #[test]
    fn renaming_onto_another_existing_file_name_is_refused() {
        let dir = temp_dir("rename-collision");
        write(&dir, "pack.toml", "[meta]\nname = \"Pack\"\n");
        write(&dir, "other.toml", "[meta]\nname = \"Other\"\n");

        let err = rename_catalogue_file(&dir.join("pack.toml"), "other.toml", "Pack")
            .expect_err("an existing file must not be overwritten");

        assert!(err.contains("other.toml"), "error should name the file: {err}");
        assert!(dir.join("pack.toml").exists());
        let other = std::fs::read_to_string(dir.join("other.toml")).unwrap();
        assert_eq!(extract_catalog_name(&other).as_deref(), Some("Other"));
    }

    #[test]
    fn renaming_only_the_display_name_keeps_the_file() {
        let dir = temp_dir("rename-in-place");
        write(&dir, "pack.toml", "[meta]\nname = \"Pack\"\n");

        rename_catalogue_file(&dir.join("pack.toml"), "pack.toml", "Battery").expect("rename");

        let body = std::fs::read_to_string(dir.join("pack.toml")).unwrap();
        assert_eq!(extract_catalog_name(&body).as_deref(), Some("Battery"));
    }

    #[test]
    fn renaming_only_the_case_of_the_file_name_keeps_the_file() {
        let dir = temp_dir("rename-case");
        write(&dir, "pack.toml", "[meta]\nname = \"Pack\"\n");

        rename_catalogue_file(&dir.join("pack.toml"), "Pack.toml", "Pack").expect("rename");

        let names: Vec<_> = std::fs::read_dir(&dir).unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["Pack.toml"]);
    }

    #[test]
    fn a_catalogue_is_found_by_filename_display_name_or_bare_name() {
        let catalogs = [CatalogFile {
            name: "Sungrow SHx".into(),
            filename: "sungrow_shx.toml".into(),
            path: "/decoders/sungrow_shx.toml".into(),
            sync_status: SyncStatus::LocalOnly,
            tracked_repo_count: 0,
        }];
        for spelling in [
            "sungrow_shx.toml",
            "Sungrow SHx",
            "sungrow_shx",
            " sungrow_shx ",
        ] {
            assert!(catalog_named(&catalogs, spelling).is_some(), "{spelling:?}");
        }
        assert!(catalog_named(&catalogs, "sungrow").is_none());
    }

    #[test]
    fn catalogue_name_is_read_from_meta_only() {
        let below_a_signal = "[[frame.can.0x100.signals]]\nname = \"Voltage\"\n\n[meta]\nname = \"Pack\"\n";
        assert_eq!(extract_catalog_name(below_a_signal).as_deref(), Some("Pack"));

        let commented = "[meta]\nname = \"Pack = BMS\" # the display name\n";
        assert_eq!(extract_catalog_name(commented).as_deref(), Some("Pack = BMS"));

        let prefix_first = "name_prefix = \"hyp_\"\n[meta]\nname = \"Pack\"\n";
        assert_eq!(extract_catalog_name(prefix_first).as_deref(), Some("Pack"));

        assert_eq!(extract_catalog_name("[meta]\nversion = 1\n"), None);
    }

    /// The scan labels each row from the registry as it walks, using the bytes it read
    /// for the display name. Testable at all only because `scan_catalogs` takes a
    /// snapshot rather than an `AppHandle`.
    #[test]
    fn scan_labels_tracked_and_untracked_catalogues() {
        let dir = temp_dir("scan-labels");
        let tracked_body = "[meta]\nname = \"Tracked\"\n";
        write(&dir, "tracked.toml", tracked_body);
        write(&dir, "local.toml", "[meta]\nname = \"Local\"\n");
        write(&dir, "edited.toml", "[meta]\nname = \"Edited\"\n");

        let mut registry = Registry::default();
        // Byte-identical to what was last exchanged, but no check has run.
        registry
            .catalogs
            .push(tracked_entry("tracked.toml", &git_blob_sha(tracked_body.as_bytes())));
        // Tracked against bytes that are not what is on disk.
        registry
            .catalogs
            .push(tracked_entry("edited.toml", "some-other-sha"));

        let found = scan_catalogs(&dir, &registry.sync_index());
        let status = |name: &str| {
            found
                .iter()
                .find(|c| c.filename == name)
                .unwrap_or_else(|| panic!("{name} missing from the scan"))
                .sync_status
        };

        assert_eq!(status("tracked.toml"), SyncStatus::Unchecked);
        assert_eq!(status("local.toml"), SyncStatus::LocalOnly);
        assert_eq!(status("edited.toml"), SyncStatus::LocalAhead);

        // The display name still comes from [meta], and the sort is still by filename.
        assert_eq!(
            found.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["Edited", "Local", "Tracked"]
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A tracked catalogue whose file has gone reads as missing — but it only appears
    /// at all if something else in the directory is there, since the scan walks files.
    #[test]
    fn a_tracked_file_that_is_gone_never_reaches_the_scan() {
        let dir = temp_dir("scan-missing");
        write(&dir, "present.toml", "[meta]\nname = \"Present\"\n");

        let mut registry = Registry::default();
        registry.catalogs.push(tracked_entry("gone.toml", "aaa"));

        let found = scan_catalogs(&dir, &registry.sync_index());
        assert_eq!(found.len(), 1, "the scan lists files, not registry entries");
        assert_eq!(found[0].filename, "present.toml");
        // `missing` is therefore the settings list's answer, not the picker's — the
        // picker cannot show a row for a file it never walked.
        assert_eq!(
            registry.sync_index().status_for("gone.toml", None).status,
            SyncStatus::Missing
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    fn tracked_entry(filename: &str, sha: &str) -> crate::catalog_share::registry::CatalogEntry {
        let remote_path = format!("catalogs/{filename}");
        crate::catalog_share::registry::CatalogEntry {
            id: crate::catalog_share::registry::catalog_entry_id(
                "gh:owner/repo",
                &remote_path,
                "main",
            ),
            repo_id: "gh:owner/repo".to_string(),
            remote_path,
            git_ref: "main".to_string(),
            synced_sha: sha.to_string(),
            local_filename: filename.to_string(),
            imported_at: "2026-08-02T00:00:00Z".to_string(),
            remote_sha: None,
            publish: None,
        }
    }
    const DISPLAY_HINTS_FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../frontend/wiretap-ui/src/tests/fixtures/display-hints"
    );

    fn display_hints_fixture(extension: &str) -> String {
        std::fs::read_to_string(format!("{DISPLAY_HINTS_FIXTURE}.{extension}")).expect("fixture")
    }

    fn command(op: &str, params: serde_json::Value) -> serde_json::Value {
        tauri::async_runtime::block_on(dispatch_catalog_command(op, params, 0)).expect(op)
    }

    #[test]
    fn catalog_parse_serves_the_dashboard_display_hints_fixture() {
        let toml = display_hints_fixture("toml");
        let served = command("catalog.parse", serde_json::json!({ "content": toml }));
        let golden: serde_json::Value =
            serde_json::from_str(&display_hints_fixture("catalog.json")).expect("golden json");
        assert_eq!(served, golden);
    }

    #[test]
    fn editing_a_signal_keeps_its_display_hint() {
        let edited = command(
            "catalog.edits",
            serde_json::json!({
                "content": display_hints_fixture("toml"),
                "ops": [{
                    "op": "UpsertSignal",
                    "owner_path": ["frame", "can", "0x100", "mux", "1"],
                    "index": 0,
                    "signal": {
                        "name": "Boost",
                        "start_bit": 56,
                        "bit_length": 8,
                        "unit": "kPa",
                        "display": { "widget": "rotary", "start_angle": -90, "end_angle": 90 },
                    },
                }],
            }),
        );
        let parsed = command("catalog.parse", serde_json::json!({ "content": edited }));
        let boost = &parsed["frames"][0]["mux"]["cases"]["1"]["signals"][0];
        assert_eq!(boost["unit"], "kPa");
        assert_eq!(
            boost["display"],
            serde_json::json!({ "widget": "rotary", "start_angle": -90, "end_angle": 90 })
        );
    }

    fn try_command(op: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        tauri::async_runtime::block_on(dispatch_catalog_command(op, params, 0))
    }

    #[test]
    fn catalog_edits_applies_its_ops_in_order() {
        let edited = command(
            "catalog.edits",
            serde_json::json!({
                "content": "[meta]\nname = \"d\"\nversion = 1\n",
                "ops": [
                    { "op": "SetFrame", "protocol": "can", "key": "0x100", "frame": { "length": 8 } },
                    {
                        "op": "UpsertSignal",
                        "owner_path": ["frame", "can", "0x100"],
                        "signal": { "name": "rpm", "start_bit": 0, "bit_length": 16 },
                    },
                ],
            }),
        );
        let parsed = command("catalog.parse", serde_json::json!({ "content": edited }));
        assert_eq!(parsed["frames"][0]["signals"][0]["name"], "rpm");
    }

    #[test]
    fn catalog_build_refuses_a_catalogue_that_does_not_validate() {
        let refused = try_command(
            "catalog.build",
            serde_json::json!({
                "ops": [
                    { "op": "SetMeta", "meta": { "name": "d", "version": 1 } },
                    { "op": "SetFrame", "protocol": "can", "key": "0x100", "frame": { "length": 8 } },
                    { "op": "SetTable", "path": ["frame", "can", "0x100", "mux"], "value": { "start_bit": 0, "bit_length": 8 } },
                ],
            }),
        )
        .expect_err("an unnamed mux is refused");
        assert!(refused.contains("frame.can.0x100.mux"), "{refused}");
    }

    const DISCOVERY_EXPORTS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../frontend/wiretap-ui/src/tests/fixtures/discovery-export"
    );

    fn discovery_export(file: &str) -> String {
        std::fs::read_to_string(format!("{DISCOVERY_EXPORTS}/{file}")).expect("fixture")
    }

    fn parsed(toml: serde_json::Value) -> serde_json::Value {
        command("catalog.parse", serde_json::json!({ "content": toml }))
    }

    fn built_export(name: &str) -> serde_json::Value {
        let ops: serde_json::Value =
            serde_json::from_str(&discovery_export(&format!("{name}.ops.json"))).expect("ops");
        parsed(command("catalog.build", serde_json::json!({ "ops": ops })))
    }

    /// What the TypeScript writers never wrote: mux names, which `validate` requires, and
    /// signal confidence, which they wrote as a comment. Signals are compared by position.
    fn without_new_keys(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                map.remove("confidence");
                if let Some(mux) = map.get_mut("mux").and_then(|m| m.as_object_mut()) {
                    mux.remove("name");
                }
                if let Some(signals) = map.get_mut("signals").and_then(|s| s.as_array_mut()) {
                    signals.sort_by_key(|s| s["startBit"].as_u64());
                }
                map.values_mut().for_each(without_new_keys);
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(without_new_keys),
            _ => {}
        }
    }

    #[test]
    fn each_discovery_export_builds_the_catalogue_its_typescript_writer_did() {
        for name in ["knowledge-can", "knowledge-serial", "plain-can", "modbus"] {
            let mut ours = built_export(name);
            let golden = discovery_export(&format!("{name}.golden.toml"));
            let mut theirs = parsed(golden.into());
            without_new_keys(&mut ours);
            without_new_keys(&mut theirs);
            assert_eq!(ours, theirs, "{name}");
        }
    }

    #[test]
    fn a_discovery_export_names_its_mux_selectors_and_keeps_signal_confidence() {
        let catalogue = built_export("knowledge-can");
        let frames = catalogue["frames"].as_array().unwrap();
        let frame = |id: u64| frames.iter().find(|f| f["frameId"] == id).unwrap();

        assert_eq!(frame(0x200)["mux"]["name"], "selector_0");
        assert_eq!(frame(0x300)["mux"]["name"], "selector_0");
        let inner = &frame(0x300)["mux"]["cases"]["1"]["mux"];
        assert_eq!(inner["name"], "selector_1");
        let signals = frame(0x100)["signals"].as_array().unwrap();
        let rpm = signals.iter().find(|s| s["name"] == "rpm").unwrap();
        assert_eq!(rpm["confidence"], "high");
    }

    fn set_meta_version(original: &str) -> serde_json::Value {
        command(
            "catalog.edits",
            serde_json::json!({
                "content": original,
                "ops": [{ "op": "SetMeta", "meta": { "name": "pack", "version": 2 } }],
            }),
        )
    }

    const META_WITH_COMMENTS: &str = "# Pack catalogue\n[meta]\n# Bumped on every release\nversion = 1 # keep in step\nname = \"pack\"\n\n[frame.can.\"0x100\"]\nlength = 8\n";

    #[test]
    fn saving_metadata_keeps_the_comments_around_the_value_it_sets() {
        assert_eq!(
            set_meta_version(META_WITH_COMMENTS),
            META_WITH_COMMENTS.replace("version = 1 #", "version = 2 #")
        );
    }

    #[test]
    #[ignore = "wiretap_catalog::edit::apply_edits re-encodes every line with LF"]
    fn saving_metadata_keeps_a_crlf_file_crlf() {
        let original = META_WITH_COMMENTS.replace('\n', "\r\n");
        assert_eq!(set_meta_version(&original), original.replace("version = 1 #", "version = 2 #"));
    }
}
