// ui/src-tauri/src/capture_store.rs
//
// Multi-capture registry for storing captured data.
// Metadata lives in RAM; bulk frame/byte data lives in SQLite (capture_db).
// Supports multiple named captures, each typed as either Frames or Bytes.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::RwLock;

use crate::capture_db;
use crate::io::FrameMessage;

// ============================================================================
// Types
// ============================================================================

/// Capture kind - determines what kind of data the capture contains
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureKind {
    /// CAN frames, framed serial messages
    Frames,
    /// Raw serial bytes (unframed)
    Bytes,
}

/// Timestamped byte for raw serial data
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TimestampedByte {
    /// The byte value
    pub byte: u8,
    /// Timestamp in microseconds since epoch
    pub timestamp_us: u64,
    /// Bus/interface number (for multi-source sessions)
    #[serde(default)]
    pub bus: u8,
}

/// Metadata about a capture
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CaptureMetadata {
    /// Unique capture ID (e.g., "xk9m2p", "r7f3kw")
    pub id: String,
    /// Capture kind (frames or bytes)
    pub kind: CaptureKind,
    /// Display name (e.g., "GVRET 10:30am", "Serial dump")
    pub name: String,
    /// Number of items (frames or bytes depending on type)
    pub count: usize,
    /// Timestamp of first item (microseconds)
    pub start_time_us: Option<u64>,
    /// Timestamp of last item (microseconds)
    pub end_time_us: Option<u64>,
    /// When the capture was created (Unix timestamp in seconds)
    pub created_at: u64,
    /// Whether this capture is actively receiving data (is the streaming target)
    #[serde(default)]
    pub is_streaming: bool,
    /// Session ID that owns this capture (None = orphaned, available for standalone use)
    /// Captures with an owning session are only accessible through that session.
    /// When a session is destroyed, the capture is orphaned (owning_session_id = None).
    #[serde(default)]
    pub owning_session_id: Option<String>,
    /// Whether this capture survives app restart when 'clear captures on start' is enabled.
    #[serde(default)]
    pub persistent: bool,
    /// Distinct bus numbers seen in this capture's data (sorted).
    /// Enables bus mapping/wiring when a capture is used as a source.
    #[serde(default)]
    pub buses: Vec<u8>,
}

// ============================================================================
// Internal Types
// ============================================================================

/// A named capture — metadata only, data lives in SQLite.
struct NamedCapture {
    metadata: CaptureMetadata,
    /// In-memory set for efficient bus tracking during streaming
    seen_buses: HashSet<u8>,
}

/// Capture registry holding multiple named captures
struct CaptureRegistry {
    /// All captures indexed by ID
    captures: HashMap<String, NamedCapture>,
    /// Capture IDs currently receiving streaming data
    streaming_ids: HashSet<String>,
    /// Capture IDs currently being rendered by UI panels
    active_ids: HashSet<String>,
    /// Last logged streaming state for list_captures (reduces log spam)
    last_logged_streaming_ids: Option<HashSet<String>>,
    /// Last logged capture count for list_captures
    last_logged_capture_count: usize,
}

impl Default for CaptureRegistry {
    fn default() -> Self {
        Self {
            captures: HashMap::new(),
            streaming_ids: HashSet::new(),
            active_ids: HashSet::new(),
            last_logged_streaming_ids: None,
            last_logged_capture_count: 0,
        }
    }
}

/// Global capture registry
static CAPTURE_REGISTRY: Lazy<RwLock<CaptureRegistry>> =
    Lazy::new(|| RwLock::new(CaptureRegistry::default()));

// ============================================================================
// Public API - Capture ID Queries
// ============================================================================

/// Check if a given ID corresponds to a known capture.
pub fn is_known_capture(id: &str) -> bool {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.captures.contains_key(id)
}

/// Return all known capture IDs.
pub fn list_capture_ids() -> Vec<String> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.captures.keys().cloned().collect()
}

// ============================================================================
// Public API - Capture Creation & Management
// ============================================================================

/// Create a new capture and set it as active for streaming.
/// Returns the capture ID.
pub fn create_capture(kind: CaptureKind, name: String) -> String {
    create_capture_internal(kind, name, true)
}

/// Create a new capture WITHOUT setting it as active.
/// Use this when creating derived captures (e.g., framing results) that shouldn't
/// disrupt the current streaming capture.
/// Returns the capture ID.
pub fn create_capture_inactive(kind: CaptureKind, name: String) -> String {
    create_capture_internal(kind, name, false)
}

/// Generate a random 6-character lowercase alphanumeric capture ID.
/// Retries on collision (astronomically unlikely with 36^6 ≈ 2.2 billion possibilities).
fn generate_capture_id(registry: &CaptureRegistry) -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    loop {
        let random_state = RandomState::new();
        let mut hasher = random_state.build_hasher();
        hasher.write_u64(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0));
        let hash = hasher.finish();
        let id: String = (0..6)
            .map(|i| {
                let idx = ((hash >> (i * 8)) & 0xFF) as usize % CHARSET.len();
                CHARSET[idx] as char
            })
            .collect();
        if !registry.captures.contains_key(&id) {
            return id;
        }
    }
}

/// Internal helper to create a capture with optional streaming activation.
fn create_capture_internal(kind: CaptureKind, name: String, set_streaming: bool) -> String {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();

    let id = generate_capture_id(&registry);

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let metadata = CaptureMetadata {
        id: id.clone(),
        kind: kind.clone(),
        name: name.clone(),
        count: 0,
        start_time_us: None,
        end_time_us: None,
        created_at,
        is_streaming: false,
        owning_session_id: None,
        persistent: false,
        buses: Vec::new(),
    };

    let capture = NamedCapture { metadata: metadata.clone(), seen_buses: HashSet::new() };
    registry.captures.insert(id.clone(), capture);

    if set_streaming {
        registry.streaming_ids.insert(id.clone());
    }

    // Drop registry lock before touching SQLite
    drop(registry);

    // Persist initial metadata to SQLite
    if let Err(e) = capture_db::save_capture_metadata(&metadata) {
        tlog!("[CaptureStore] Failed to persist capture metadata: {}", e);
    }

    tlog!(
        "[CaptureStore] Created capture '{}' ({:?}) - '{}' [streaming={}]",
        id, kind, name, set_streaming
    );

    id
}

/// List all buffers (returns metadata only, not data).
/// Sets is_streaming=true for the capture currently being streamed to.
pub fn list_captures() -> Vec<CaptureMetadata> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();

    let current_streaming = registry.streaming_ids.clone();
    let capture_count = registry.captures.len();
    let should_log = Some(&current_streaming) != registry.last_logged_streaming_ids.as_ref()
        || capture_count != registry.last_logged_capture_count;

    if should_log {
        tlog!(
            "[CaptureStore] list_captures - streaming: {:?}, buffers: {}",
            current_streaming,
            capture_count
        );
        for b in registry.captures.values() {
            let is_streaming = current_streaming.contains(&b.metadata.id);
            tlog!(
                "[CaptureStore]   capture '{}' is_streaming: {}",
                b.metadata.id, is_streaming
            );
        }
        registry.last_logged_streaming_ids = Some(current_streaming.clone());
        registry.last_logged_capture_count = capture_count;
    }

    let result: Vec<CaptureMetadata> = registry
        .captures
        .values()
        .map(|b| {
            let mut meta = b.metadata.clone();
            meta.is_streaming = current_streaming.contains(&meta.id);
            meta
        })
        .collect();
    result
}

/// Get metadata for a specific capture.
/// Sets is_streaming=true if this capture is being streamed to.
pub fn get_capture_metadata(id: &str) -> Option<CaptureMetadata> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.captures.get(id).map(|b| {
        let mut meta = b.metadata.clone();
        meta.is_streaming = registry.streaming_ids.contains(&meta.id);
        meta
    })
}

/// Delete a specific capture.
/// If deleting the active/streaming capture, clears those IDs.
pub fn delete_capture(id: &str) -> Result<(), String> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();

    registry.active_ids.remove(id);
    registry.streaming_ids.remove(id);

    if registry.captures.remove(id).is_some() {
        // Drop the registry lock before touching SQLite
        drop(registry);
        if let Err(e) = capture_db::delete_capture_data(id) {
            tlog!("[CaptureStore] Failed to delete capture data from SQLite: {}", e);
        }
        if let Err(e) = capture_db::delete_capture_metadata(id) {
            tlog!("[CaptureStore] Failed to delete capture metadata from SQLite: {}", e);
        }
        tlog!("[CaptureStore] Deleted capture '{}'", id);
        Ok(())
    } else {
        Err(format!("Capture '{}' not found", id))
    }
}

/// Clear a capture's data without deleting the capture itself.
/// Resets metadata (count, times, buses) so the session can continue
/// writing new frames into the same capture.
/// Also resets the WS frame delivery offset so new frames are sent to subscribers.
pub fn clear_capture(id: &str) -> Result<(), String> {
    let owning_session: Option<String>;
    {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();
        if let Some(cap) = registry.captures.get_mut(id) {
            owning_session = cap.metadata.owning_session_id.clone();
            cap.metadata.count = 0;
            cap.metadata.start_time_us = None;
            cap.metadata.end_time_us = None;
            cap.metadata.buses = Vec::new();
            cap.seen_buses.clear();
        } else {
            return Err(format!("Capture '{}' not found", id));
        }
    }

    if let Err(e) = capture_db::delete_capture_data(id) {
        tlog!("[CaptureStore] Failed to clear capture data from SQLite: {}", e);
    }

    // Reset the WS frame delivery offset so new frames arriving into
    // this capture are delivered to subscribers from the beginning.
    if let Some(session_id) = &owning_session {
        crate::ws::dispatch::reset_frame_offset(session_id);
    }

    tlog!("[CaptureStore] Cleared capture '{}'", id);
    Ok(())
}

/// Rename a capture.
/// Updates both the in-memory registry and SQLite metadata.
pub fn rename_capture(id: &str, new_name: &str) -> Result<CaptureMetadata, String> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();
    let cap = registry.captures.get_mut(id)
        .ok_or_else(|| format!("Capture '{}' not found", id))?;

    cap.metadata.name = new_name.to_string();
    let meta = cap.metadata.clone();

    // Drop registry lock before touching SQLite
    drop(registry);

    if let Err(e) = capture_db::update_capture_name(id, new_name) {
        tlog!("[CaptureStore] Failed to persist capture rename: {}", e);
    }

    tlog!("[CaptureStore] Renamed capture '{}' to '{}'", id, new_name);
    Ok(meta)
}

/// Set a capture's persistent flag.
/// Persistent captures survive app restart when 'clear captures on start' is enabled.
pub fn set_capture_persistent(id: &str, persistent: bool) -> Result<CaptureMetadata, String> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();
    let cap = registry.captures.get_mut(id)
        .ok_or_else(|| format!("Capture '{}' not found", id))?;

    cap.metadata.persistent = persistent;
    let meta = cap.metadata.clone();

    // Drop registry lock before touching SQLite
    drop(registry);

    if let Err(e) = capture_db::update_capture_persistent(id, persistent) {
        tlog!("[CaptureStore] Failed to persist capture persistent flag: {}", e);
    }

    tlog!("[CaptureStore] Set capture '{}' persistent={}", id, persistent);
    Ok(meta)
}

/// Hydrate the in-memory capture registry from persisted SQLite metadata.
/// Called on startup when `clear_captures_on_start` is false.
/// Verifies that data actually exists in SQLite for each metadata entry.
pub fn hydrate_from_db() {
    let metadata_rows = match capture_db::load_all_capture_metadata() {
        Ok(rows) => rows,
        Err(e) => {
            tlog!("[CaptureStore] Failed to load capture metadata from DB: {}", e);
            return;
        }
    };

    if metadata_rows.is_empty() {
        tlog!("[CaptureStore] No persisted capture metadata to hydrate");
        return;
    }

    let mut registry = CAPTURE_REGISTRY.write().unwrap();
    let mut hydrated = 0u32;

    for meta in metadata_rows {
        // Verify data actually exists in SQLite (skip orphaned metadata)
        let has_data = match meta.kind {
            CaptureKind::Frames => {
                capture_db::get_frame_count(&meta.id).unwrap_or(0) > 0
            }
            CaptureKind::Bytes => {
                // Check byte count via paginated query (limit 1 is enough to verify existence)
                capture_db::get_bytes_paginated(&meta.id, 0, 1)
                    .map(|(_, total)| total > 0)
                    .unwrap_or(false)
            }
        };

        if !has_data {
            tlog!("[CaptureStore] Skipping metadata for '{}' — no data in SQLite", meta.id);
            // Clean up the orphaned metadata row
            let _ = capture_db::delete_capture_metadata(&meta.id);
            continue;
        }

        // Auto-orphan captures whose owning session no longer exists.
        // On app restart, sessions are gone from memory but the DB still
        // records them as owners — without this, the capture is stranded
        // (not in any session's list, not in list_orphaned_captures).
        let had_stale_owner = meta.owning_session_id.is_some();

        // Backfill buses from DB if not already populated
        let mut buses = meta.buses.clone();
        if buses.is_empty() {
            let table = match meta.kind {
                CaptureKind::Frames => "frames",
                CaptureKind::Bytes => "bytes",
            };
            if let Ok(db_buses) = capture_db::get_distinct_buses(&meta.id, table) {
                buses = db_buses;
            }
        }

        if had_stale_owner {
            tlog!(
                "[CaptureStore] Auto-orphaning capture '{}' (stale owning_session_id={:?} from previous run)",
                meta.id, meta.owning_session_id
            );
        }

        tlog!(
            "[CaptureStore] Hydrating capture '{}' ({:?}, '{}', {} items, buses: {:?})",
            meta.id, meta.kind, meta.name, meta.count, buses
        );

        let seen_buses: HashSet<u8> = buses.iter().copied().collect();
        let capture = NamedCapture {
            metadata: CaptureMetadata {
                is_streaming: false,
                owning_session_id: None, // always orphan on startup
                buses: buses.clone(),
                ..meta
            },
            seen_buses,
        };

        // Persist if we changed anything (backfilled buses or orphaned)
        if !buses.is_empty() || had_stale_owner {
            let _ = capture_db::save_capture_metadata(&capture.metadata);
        }

        registry.captures.insert(capture.metadata.id.clone(), capture);
        hydrated += 1;
    }

    tlog!("[CaptureStore] Hydrated {} capture(s) from SQLite", hydrated);
}

// ============================================================================
// Public API - Session Ownership
// ============================================================================

/// Assign a capture to a session.
/// The capture will only be accessible through this session until orphaned.
pub fn set_capture_owner(capture_id: &str, session_id: &str) -> Result<(), String> {
    let meta = {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();
        if let Some(cap) = registry.captures.get_mut(capture_id) {
            cap.metadata.owning_session_id = Some(session_id.to_string());
            tlog!(
                "[CaptureStore] Assigned capture '{}' to session '{}'",
                capture_id, session_id
            );
            Some(cap.metadata.clone())
        } else {
            None
        }
    };

    match meta {
        Some(m) => {
            if let Err(e) = capture_db::save_capture_metadata(&m) {
                tlog!("[CaptureStore] Failed to persist capture owner: {}", e);
            }
            Ok(())
        }
        None => Err(format!("Capture '{}' not found", capture_id)),
    }
}

/// Info about an orphaned capture for event emission
#[derive(Clone, Debug, Serialize)]
pub struct OrphanedCaptureInfo {
    pub capture_id: String,
    pub name: String,
    pub kind: CaptureKind,
    pub count: usize,
}

/// Orphan all buffers owned by a specific session.
/// Called when a session is destroyed or restarted.
/// Returns list of orphaned capture info for event emission.
pub fn orphan_captures_for_session(session_id: &str) -> Vec<OrphanedCaptureInfo> {
    let (orphaned, metas_to_persist) = {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();
        let mut orphaned = Vec::new();
        let mut metas = Vec::new();

        for cap in registry.captures.values_mut() {
            if cap.metadata.owning_session_id.as_deref() == Some(session_id) {
                cap.metadata.owning_session_id = None;
                orphaned.push(OrphanedCaptureInfo {
                    capture_id: cap.metadata.id.clone(),
                    name: cap.metadata.name.clone(),
                    kind: cap.metadata.kind.clone(),
                    count: cap.metadata.count,
                });
                metas.push(cap.metadata.clone());
            }
        }

        (orphaned, metas)
    };

    // Persist ownership changes outside the registry lock
    for meta in &metas_to_persist {
        if let Err(e) = capture_db::save_capture_metadata(meta) {
            tlog!("[CaptureStore] Failed to persist orphan for '{}': {}", meta.id, e);
        }
    }

    if !orphaned.is_empty() {
        tlog!(
            "[CaptureStore] Orphaned {} capture(s) for session '{}': {:?}",
            orphaned.len(),
            session_id,
            orphaned.iter().map(|o| &o.capture_id).collect::<Vec<_>>()
        );
    }

    orphaned
}

/// Get all capture IDs owned by a session (frames + bytes).
pub fn get_session_capture_ids(session_id: &str) -> Vec<String> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry
        .captures
        .values()
        .filter(|b| b.metadata.owning_session_id.as_deref() == Some(session_id))
        .map(|b| b.metadata.id.clone())
        .collect()
}

/// Get the frame capture ID for a session, if one exists.
pub fn get_session_frame_capture_id(session_id: &str) -> Option<String> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry
        .captures
        .values()
        .find(|b| {
            b.metadata.owning_session_id.as_deref() == Some(session_id)
                && b.metadata.kind == CaptureKind::Frames
        })
        .map(|b| b.metadata.id.clone())
}

/// Append frames to this session's frame capture.
/// Resolves the capture by finding the capture owned by session_id with
/// capture kind == Frames. No-op if session has no frame capture.
pub fn append_frames_to_session(session_id: &str, new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() { return; }
    // Tap test pattern frames for active io_test runners
    crate::io_test::tap_test_frames(session_id, &new_frames);
    let capture_id = {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        registry.captures.values()
            .find(|b| b.metadata.owning_session_id.as_deref() == Some(session_id)
                    && b.metadata.kind == CaptureKind::Frames)
            .map(|b| b.metadata.id.clone())
    };
    if let Some(id) = capture_id {
        append_frames_to_capture(&id, new_frames);
    } else {
        tlog!("[CaptureStore] WARN: append_frames_to_session('{}') — no frame capture found for session (dropped {} frames)", session_id, new_frames.len());
    }
}

/// Append raw bytes to this session's byte capture.
/// Resolves the capture by finding the capture owned by session_id with
/// capture kind == Bytes. No-op if session has no byte capture.
pub fn append_raw_bytes_to_session(session_id: &str, new_bytes: Vec<TimestampedByte>) {
    if new_bytes.is_empty() { return; }
    let capture_id = {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        registry.captures.values()
            .find(|b| b.metadata.owning_session_id.as_deref() == Some(session_id)
                    && b.metadata.kind == CaptureKind::Bytes)
            .map(|b| b.metadata.id.clone())
    };
    if let Some(id) = capture_id {
        append_raw_bytes_to_capture(&id, new_bytes);
    }
}

/// Finalize all streaming captures owned by this session.
/// Removes them from streaming_ids, persists final metadata.
pub fn finalize_session_captures(session_id: &str) -> Vec<CaptureMetadata> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();

    let owned: Vec<String> = {
        let streaming = &registry.streaming_ids;
        registry.captures.values()
            .filter(|b| b.metadata.owning_session_id.as_deref() == Some(session_id)
                     && streaming.contains(&b.metadata.id))
            .map(|b| b.metadata.id.clone())
            .collect()
    };

    let mut finalized = Vec::new();
    for id in &owned {
        registry.streaming_ids.remove(id);
        if let Some(cap) = registry.captures.get(id) {
            let meta = cap.metadata.clone();
            tlog!("[CaptureStore] Finalized capture '{}' with {} items", id, meta.count);
            finalized.push(meta);
        }
    }

    drop(registry);

    for meta in &finalized {
        if let Err(e) = capture_db::save_capture_metadata(meta) {
            tlog!("[CaptureStore] Failed to persist finalized capture metadata: {}", e);
        }
    }

    finalized
}

/// Mark a capture as being rendered by a UI panel.
pub fn mark_capture_active(capture_id: &str) -> Result<(), String> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();
    if registry.captures.contains_key(capture_id) {
        registry.active_ids.insert(capture_id.to_string());
        tlog!("[CaptureStore] Marked capture active: {}", capture_id);
        Ok(())
    } else {
        Err(format!("Capture '{}' not found", capture_id))
    }
}

/// List only orphaned buffers (no owning session).
/// These are available for standalone selection.
pub fn list_orphaned_captures() -> Vec<CaptureMetadata> {
    let registry = CAPTURE_REGISTRY.read().unwrap();

    registry
        .captures
        .values()
        .filter(|b| b.metadata.owning_session_id.is_none())
        .map(|b| {
            let mut meta = b.metadata.clone();
            meta.is_streaming = registry.streaming_ids.contains(&meta.id);
            meta
        })
        .collect()
}

/// Create a copy of a capture for an app that is detaching.
/// The copy is orphaned (no owning session) and available for standalone use.
/// Returns the new capture ID.
pub fn copy_capture(source_capture_id: &str, new_name: String) -> Result<String, String> {
    let source_metadata = {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        let source = registry
            .captures
            .get(source_capture_id)
            .ok_or_else(|| format!("Capture '{}' not found", source_capture_id))?;
        source.metadata.clone()
    };

    // Create new capture entry in registry
    let (id, metadata) = {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();

        let id = generate_capture_id(&registry);

        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let metadata = CaptureMetadata {
            id: id.clone(),
            kind: source_metadata.kind.clone(),
            name: new_name.clone(),
            count: source_metadata.count,
            start_time_us: source_metadata.start_time_us,
            end_time_us: source_metadata.end_time_us,
            created_at,
            is_streaming: false,
            owning_session_id: None,
            persistent: false,
            buses: source_metadata.buses.clone(),
        };

        let seen_buses: HashSet<u8> = source_metadata.buses.iter().copied().collect();
        let entry = NamedCapture { metadata: metadata.clone(), seen_buses };
        registry.captures.insert(id.clone(), entry);
        (id, metadata)
    };

    // Copy data in SQLite (INSERT INTO ... SELECT — no memory spike)
    let count = capture_db::copy_capture_data(source_capture_id, &id)?;

    // Persist metadata for the new capture
    if let Err(e) = capture_db::save_capture_metadata(&metadata) {
        tlog!("[CaptureStore] Failed to persist copied capture metadata: {}", e);
    }

    tlog!(
        "[CaptureStore] Copied capture '{}' -> '{}' ('{}', {} items)",
        source_capture_id, id, new_name, count
    );

    Ok(id)
}

// ============================================================================
// Public API - Data Access (Frame Captures)
// ============================================================================

/// Append frames to a specific capture by ID.
/// Silently returns if capture doesn't exist or is not a frame capture.
/// Only used by framing.rs which is desktop-only.
#[cfg(not(target_os = "ios"))]
pub fn append_frames_to_capture(capture_id: &str, new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() {
        return;
    }

    {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();

        if let Some(cap) = registry.captures.get_mut(capture_id) {
            if cap.metadata.kind != CaptureKind::Frames {
                return;
            }
            if cap.metadata.start_time_us.is_none() {
                cap.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            }
            cap.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);
            cap.metadata.count += new_frames.len();

            // Track distinct buses
            let prev_len = cap.seen_buses.len();
            for f in &new_frames {
                cap.seen_buses.insert(f.bus);
            }
            if cap.seen_buses.len() != prev_len {
                let mut sorted: Vec<u8> = cap.seen_buses.iter().copied().collect();
                sorted.sort();
                cap.metadata.buses = sorted;
            }
        } else {
            return;
        }
        // Registry lock dropped here
    }

    if let Err(e) = capture_db::insert_frames(capture_id, &new_frames) {
        tlog!("[CaptureStore] Failed to insert frames to capture '{}': {}", capture_id, e);
    }
}

/// Clear a frame capture and refill it with new frames.
/// Used during live framing to reuse the same capture ID instead of creating new ones.
/// Silently returns if capture doesn't exist or is not a frame capture.
/// Only used by framing.rs which is desktop-only.
#[cfg(not(target_os = "ios"))]
pub fn clear_and_refill_capture(capture_id: &str, new_frames: Vec<FrameMessage>) {
    {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();

        if let Some(cap) = registry.captures.get_mut(capture_id) {
            if cap.metadata.kind != CaptureKind::Frames {
                return;
            }
            cap.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            cap.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);
            cap.metadata.count = new_frames.len();

            // Reset and rebuild bus tracking
            cap.seen_buses.clear();
            for f in &new_frames {
                cap.seen_buses.insert(f.bus);
            }
            let mut sorted: Vec<u8> = cap.seen_buses.iter().copied().collect();
            sorted.sort();
            cap.metadata.buses = sorted;
        } else {
            return;
        }
    }

    if let Err(e) = capture_db::clear_and_refill(capture_id, &new_frames) {
        tlog!("[CaptureStore] Failed to clear and refill capture '{}': {}", capture_id, e);
    } else {
        tlog!(
            "[CaptureStore] Refilled capture '{}' with {} frames",
            capture_id, new_frames.len()
        );
    }
}

/// Get frames from a specific capture.
/// Returns None if capture doesn't exist or is not a frame capture.
pub fn get_capture_frames(id: &str) -> Option<Vec<FrameMessage>> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    let cap = registry.captures.get(id)?;
    if cap.metadata.kind != CaptureKind::Frames {
        return None;
    }
    drop(registry);

    capture_db::get_all_frames(id).ok()
}

/// Get a page of frames from a specific capture.
/// Returns (frames, buffer_indices, total_count).
pub fn get_capture_frames_paginated(id: &str, offset: usize, limit: usize) -> (Vec<FrameMessage>, Vec<usize>, usize) {
    let total = {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => b.metadata.count,
            _ => return (Vec::new(), Vec::new(), 0),
        }
    };

    if offset >= total {
        return (Vec::new(), Vec::new(), total);
    }

    match capture_db::get_frames_paginated(id, offset, limit) {
        Ok((frames, rowids)) => {
            let indices = rowids.into_iter().map(|r| r as usize).collect();
            (frames, indices, total)
        }
        Err(e) => {
            tlog!("[CaptureStore] Failed to get paginated frames: {}", e);
            (Vec::new(), Vec::new(), total)
        }
    }
}

/// Get a page of frames filtered by selected IDs.
/// Returns (frames, buffer_indices, total_filtered_count).
pub fn get_capture_frames_paginated_filtered(
    id: &str,
    offset: usize,
    limit: usize,
    selected_ids: &std::collections::HashSet<u32>,
) -> (Vec<FrameMessage>, Vec<usize>, usize) {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => {},
            _ => return (Vec::new(), Vec::new(), 0),
        }
    }

    if selected_ids.is_empty() {
        return get_capture_frames_paginated(id, offset, limit);
    }

    let frame_ids: Vec<u32> = selected_ids.iter().copied().collect();
    match capture_db::get_frames_paginated_filtered(id, offset, limit, &frame_ids) {
        Ok((frames, rowids, total)) => {
            let indices = rowids.into_iter().map(|r| r as usize).collect();
            (frames, indices, total)
        }
        Err(e) => {
            tlog!("[CaptureStore] Failed to get filtered paginated frames: {}", e);
            (Vec::new(), Vec::new(), 0)
        }
    }
}

/// Response from tail fetch operation
#[derive(Clone, Debug, serde::Serialize)]
pub struct TailResponse {
    pub frames: Vec<FrameMessage>,
    /// 1-based original capture position (rowid) for each frame, parallel to `frames`.
    pub capture_indices: Vec<usize>,
    pub total_filtered_count: usize,
    pub capture_end_time_us: Option<u64>,
}

/// Get the most recent N frames from a capture, optionally filtered by frame IDs.
/// Returns the frames in chronological order (oldest first) for display.
pub fn get_capture_frames_tail(
    id: &str,
    limit: usize,
    selected_ids: &std::collections::HashSet<u32>,
) -> TailResponse {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => {},
            _ => return TailResponse {
                frames: Vec::new(),
                capture_indices: Vec::new(),
                total_filtered_count: 0,
                capture_end_time_us: None,
            },
        }
    }

    let frame_ids: Vec<u32> = selected_ids.iter().copied().collect();
    match capture_db::get_frames_tail(id, limit, &frame_ids) {
        Ok((frames, rowids, total, end_time_us)) => {
            let indices = rowids.into_iter().map(|r| r as usize).collect();
            TailResponse {
                frames,
                capture_indices: indices,
                total_filtered_count: total,
                capture_end_time_us: end_time_us,
            }
        }
        Err(e) => {
            tlog!("[CaptureStore] Failed to get tail frames: {}", e);
            TailResponse {
                frames: Vec::new(),
                capture_indices: Vec::new(),
                total_filtered_count: 0,
                capture_end_time_us: None,
            }
        }
    }
}

/// Frame info extracted from a capture
#[derive(Clone, Debug, serde::Serialize)]
pub struct CaptureFrameInfo {
    pub frame_id: u32,
    pub max_dlc: u8,
    pub bus: u8,
    pub is_extended: bool,
    pub has_dlc_mismatch: bool,
}

/// Get unique frame IDs and their metadata from a capture.
pub fn get_capture_frame_info(id: &str) -> Vec<CaptureFrameInfo> {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => {},
            _ => return Vec::new(),
        }
    }

    match capture_db::get_frame_info(id) {
        Ok(info) => info,
        Err(e) => {
            tlog!("[CaptureStore] Failed to get frame info: {}", e);
            Vec::new()
        }
    }
}

/// Find the offset for a given timestamp in a capture.
pub fn find_capture_offset_for_timestamp(
    id: &str,
    target_time_us: u64,
    selected_ids: &std::collections::HashSet<u32>,
) -> usize {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => {},
            _ => return 0,
        }
    }

    let frame_ids: Vec<u32> = selected_ids.iter().copied().collect();
    match capture_db::find_offset_for_timestamp(id, target_time_us, &frame_ids) {
        Ok(offset) => offset,
        Err(e) => {
            tlog!("[CaptureStore] Failed to find offset for timestamp: {}", e);
            0
        }
    }
}

// ============================================================================
// Public API - Data Access (Byte Captures)
// ============================================================================

/// Append raw bytes to a specific capture by ID.
/// Silently returns if capture doesn't exist or is not a byte capture.
pub fn append_raw_bytes_to_capture(capture_id: &str, new_bytes: Vec<TimestampedByte>) {
    if new_bytes.is_empty() {
        return;
    }

    {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();

        if let Some(cap) = registry.captures.get_mut(capture_id) {
            if cap.metadata.kind != CaptureKind::Bytes {
                return;
            }
            if cap.metadata.start_time_us.is_none() {
                cap.metadata.start_time_us = new_bytes.first().map(|b| b.timestamp_us);
            }
            cap.metadata.end_time_us = new_bytes.last().map(|b| b.timestamp_us);
            cap.metadata.count += new_bytes.len();

            // Track distinct buses
            let prev_len = cap.seen_buses.len();
            for b in &new_bytes {
                cap.seen_buses.insert(b.bus);
            }
            if cap.seen_buses.len() != prev_len {
                let mut sorted: Vec<u8> = cap.seen_buses.iter().copied().collect();
                sorted.sort();
                cap.metadata.buses = sorted;
            }
        } else {
            return;
        }
    }

    if let Err(e) = capture_db::insert_bytes(capture_id, &new_bytes) {
        tlog!("[CaptureStore] Failed to insert bytes to capture '{}': {}", capture_id, e);
    }
}

/// Get raw bytes from a specific capture.
/// Returns None if capture doesn't exist or is not a byte capture.
pub fn get_capture_bytes(id: &str) -> Option<Vec<TimestampedByte>> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    let cap = registry.captures.get(id)?;
    if cap.metadata.kind != CaptureKind::Bytes {
        return None;
    }
    drop(registry);

    capture_db::get_all_bytes(id).ok()
}

/// Get a page of bytes from a specific capture.
/// Returns (bytes, total_count).
pub fn get_capture_bytes_paginated(id: &str, offset: usize, limit: usize) -> (Vec<TimestampedByte>, usize) {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Bytes => {},
            _ => return (Vec::new(), 0),
        }
    }

    match capture_db::get_bytes_paginated(id, offset, limit) {
        Ok((bytes, total)) => (bytes, total),
        Err(e) => {
            tlog!("[CaptureStore] Failed to get paginated bytes: {}", e);
            (Vec::new(), 0)
        }
    }
}

/// Find the byte offset for a given timestamp in a specific byte capture.
pub fn find_capture_bytes_offset_for_timestamp_by_id(capture_id: &str, target_time_us: u64) -> usize {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(capture_id) {
            Some(b) if b.metadata.kind == CaptureKind::Bytes => {},
            _ => return 0,
        }
    }

    match capture_db::find_bytes_offset_for_timestamp(capture_id, target_time_us) {
        Ok(offset) => offset,
        Err(e) => {
            tlog!("[CaptureStore] Failed to find bytes offset for timestamp: {}", e);
            0
        }
    }
}

// ============================================================================
// Public API - Utility Functions
// ============================================================================

/// Check if any capture has data.
pub fn has_any_data() -> bool {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.captures.values().any(|b| b.metadata.count > 0)
}

/// Get the count for a specific capture.
pub fn get_capture_count(id: &str) -> usize {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.captures.get(id).map(|b| b.metadata.count).unwrap_or(0)
}

/// Get the kind of a specific capture.
pub fn get_capture_kind(id: &str) -> Option<CaptureKind> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.captures.get(id).map(|b| b.metadata.kind.clone())
}


