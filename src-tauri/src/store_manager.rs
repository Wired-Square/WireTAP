// src-tauri/src/store_manager.rs
//
// Centralised store manager for UI state persistence.
// Provides a single point of access for all windows, eliminating
// file locking issues on Windows when multiple windows access the same store.
//
// Data is cached in memory and persisted to disk with debounced writes.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

// ============================================================================
// Types
// ============================================================================

/// Event payload for store changes
#[derive(Clone, Debug, Serialize)]
pub struct StoreChangedEvent {
    pub key: String,
}

/// The store data structure - a simple key-value store
#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreData {
    #[serde(flatten)]
    entries: HashMap<String, serde_json::Value>,
}

/// Store manager state
struct StoreManager {
    /// The in-memory store data
    data: StoreData,
    /// Path to the store file
    store_path: Option<PathBuf>,
    /// Whether there are unsaved changes
    dirty: bool,
    /// Last save time (for debouncing)
    last_save: Instant,
}

impl Default for StoreManager {
    fn default() -> Self {
        Self {
            data: StoreData::default(),
            store_path: None,
            dirty: false,
            last_save: Instant::now(),
        }
    }
}

/// Global store manager singleton
static STORE_MANAGER: Lazy<RwLock<StoreManager>> =
    Lazy::new(|| RwLock::new(StoreManager::default()));

/// Channel for triggering debounced saves
static SAVE_CHANNEL: Lazy<mpsc::UnboundedSender<()>> = Lazy::new(|| {
    let (tx, mut rx) = mpsc::unbounded_channel::<()>();

    // Spawn the debounced save task
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        rt.block_on(async {
            let debounce_duration = Duration::from_millis(500);
            let mut pending = false;

            loop {
                tokio::select! {
                    result = rx.recv() => {
                        if result.is_none() {
                            // Channel closed
                            break;
                        }
                        pending = true;
                    }
                    _ = tokio::time::sleep(debounce_duration), if pending => {
                        pending = false;
                        if let Err(e) = save_to_disk_internal() {
                            tlog!("[StoreManager] Failed to save: {}", e);
                        }
                    }
                }
            }
        });
    });

    tx
});

// ============================================================================
// Internal Functions
// ============================================================================

/// Get the store file path for the app
fn get_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Ensure directory exists
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("ui-state.json"))
}

/// Load store data from disk
fn load_from_disk(path: &PathBuf) -> Result<StoreData, String> {
    if !path.exists() {
        return Ok(StoreData::default());
    }

    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read store file: {}", e))?;

    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse store file: {}", e))
}

/// Save store data to disk (atomic write)
fn save_to_disk_internal() -> Result<(), String> {
    let manager = STORE_MANAGER
        .read()
        .map_err(|e| format!("Failed to acquire read lock: {}", e))?;

    let path = match &manager.store_path {
        Some(p) => p.clone(),
        None => return Ok(()), // Not initialised yet
    };

    if !manager.dirty {
        return Ok(()); // Nothing to save
    }

    let json = serde_json::to_string_pretty(&manager.data)
        .map_err(|e| format!("Failed to serialise store: {}", e))?;

    drop(manager); // Release read lock before file operations

    // Atomic write: write to temp file, then rename
    let temp_path = path.with_extension("json.tmp");

    fs::write(&temp_path, &json)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    fs::rename(&temp_path, &path)
        .map_err(|e| format!("Failed to rename temp file: {}", e))?;

    // Clear dirty flag
    if let Ok(mut manager) = STORE_MANAGER.write() {
        manager.dirty = false;
        manager.last_save = Instant::now();
    }

    Ok(())
}

/// Schedule a debounced save
fn schedule_save() {
    // Ignore errors (channel might not be ready yet during init)
    let _ = SAVE_CHANNEL.send(());
}

// ============================================================================
// Public API
// ============================================================================

/// Initialise the store manager with the app handle.
/// Call this once during app setup.
pub fn initialise(app: &AppHandle) -> Result<(), String> {
    let path = get_store_path(app)?;

    let mut manager = STORE_MANAGER
        .write()
        .map_err(|e| format!("Failed to acquire write lock: {}", e))?;

    // Load existing data if available
    manager.data = load_from_disk(&path)?;
    manager.store_path = Some(path.clone());
    manager.dirty = false;

    tlog!(
        "[StoreManager] Initialised with {} entries",
        manager.data.entries.len()
    );

    // Migrate data from old tauri-plugin-store format if needed
    let app_data_dir = path.parent().ok_or("Invalid store path")?;
    let mut migrated = false;

    // Migrate favorites.dat -> favorites.timeRanges
    if !manager.data.entries.contains_key("favorites.timeRanges") {
        if let Some(data) = migrate_old_store(app_data_dir, "favorites.dat", "timeRangeFavorites") {
            tlog!("[StoreManager] Migrating favorites from old store");
            manager.data.entries.insert("favorites.timeRanges".to_string(), data);
            migrated = true;
        }
    }

    // Migrate selection-sets.dat -> selectionSets.all
    if !manager.data.entries.contains_key("selectionSets.all") {
        if let Some(data) = migrate_old_store(app_data_dir, "selection-sets.dat", "selectionSets") {
            tlog!("[StoreManager] Migrating selection sets from old store");
            manager.data.entries.insert("selectionSets.all".to_string(), data);
            migrated = true;
        }
    }

    if migrated {
        manager.dirty = true;
        drop(manager); // Release lock before saving
        schedule_save();
        tlog!("[StoreManager] Migration complete, scheduled save");
    }

    Ok(())
}

/// Try to migrate data from an old tauri-plugin-store file.
/// Returns the value if found, None otherwise.
fn migrate_old_store(app_data_dir: &std::path::Path, filename: &str, key: &str) -> Option<serde_json::Value> {
    let old_path = app_data_dir.join(filename);
    if !old_path.exists() {
        return None;
    }

    let content = fs::read_to_string(&old_path).ok()?;

    // tauri-plugin-store uses a simple JSON object format
    let data: serde_json::Value = serde_json::from_str(&content).ok()?;

    // Get the value from the old key
    data.get(key).cloned()
}

/// Get a value from the store
pub fn get(key: &str) -> Option<serde_json::Value> {
    let manager = STORE_MANAGER.read().ok()?;
    manager.data.entries.get(key).cloned()
}

/// Set a value in the store
pub fn set(key: &str, value: serde_json::Value) -> Result<(), String> {
    let mut manager = STORE_MANAGER
        .write()
        .map_err(|e| format!("Failed to acquire write lock: {}", e))?;

    manager.data.entries.insert(key.to_string(), value);
    manager.dirty = true;

    drop(manager); // Release lock before scheduling save

    schedule_save();
    Ok(())
}

/// Delete a value from the store
pub fn delete(key: &str) -> Result<bool, String> {
    let mut manager = STORE_MANAGER
        .write()
        .map_err(|e| format!("Failed to acquire write lock: {}", e))?;

    let existed = manager.data.entries.remove(key).is_some();

    if existed {
        manager.dirty = true;
        drop(manager);
        schedule_save();
    }

    Ok(existed)
}

/// Check if a key exists
pub fn has(key: &str) -> bool {
    STORE_MANAGER
        .read()
        .map(|m| m.data.entries.contains_key(key))
        .unwrap_or(false)
}

/// Get all keys in the store
pub fn keys() -> Vec<String> {
    STORE_MANAGER
        .read()
        .map(|m| m.data.entries.keys().cloned().collect())
        .unwrap_or_default()
}

/// Force an immediate save (useful before app shutdown)
#[allow(unused)]
pub fn flush() -> Result<(), String> {
    save_to_disk_internal()
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Get a value from the centralised store
#[tauri::command]
pub fn store_get(key: String) -> Result<Option<serde_json::Value>, String> {
    Ok(get(&key))
}

/// Set a value in the centralised store and broadcast change to all windows
#[tauri::command]
pub fn store_set(app: AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    set(&key, value)?;

    // Broadcast change to all windows
    let _ = app.emit("store:changed", StoreChangedEvent { key });

    Ok(())
}

/// Delete a value from the centralised store
#[tauri::command]
pub fn store_delete(app: AppHandle, key: String) -> Result<bool, String> {
    let existed = delete(&key)?;

    if existed {
        // Broadcast change to all windows
        let _ = app.emit("store:changed", StoreChangedEvent { key });
    }

    Ok(existed)
}

/// Check if a key exists in the store
#[tauri::command]
pub fn store_has(key: String) -> bool {
    has(&key)
}

/// Get all keys in the store
#[tauri::command]
pub fn store_keys() -> Vec<String> {
    keys()
}
