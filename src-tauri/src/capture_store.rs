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

/// Buffer type - determines what kind of data the buffer contains
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

/// Metadata about a buffer
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
    /// When the buffer was created (Unix timestamp in seconds)
    pub created_at: u64,
    /// Whether this buffer is actively receiving data (is the streaming target)
    #[serde(default)]
    pub is_streaming: bool,
    /// Session ID that owns this buffer (None = orphaned, available for standalone use)
    /// Buffers with an owning session are only accessible through that session.
    /// When a session is destroyed, the buffer is orphaned (owning_session_id = None).
    #[serde(default)]
    pub owning_session_id: Option<String>,
    /// Whether this buffer survives app restart when 'clear buffers on start' is enabled.
    #[serde(default)]
    pub persistent: bool,
    /// Distinct bus numbers seen in this buffer's data (sorted).
    /// Enables bus mapping/wiring when a buffer is used as a source.
    #[serde(default)]
    pub buses: Vec<u8>,
}

// ============================================================================
// Internal Types
// ============================================================================

/// A named buffer — metadata only, data lives in SQLite.
struct NamedCapture {
    metadata: CaptureMetadata,
    /// In-memory set for efficient bus tracking during streaming
    seen_buses: HashSet<u8>,
}

/// Buffer registry holding multiple named buffers
struct CaptureRegistry {
    /// All buffers indexed by ID
    buffers: HashMap<String, NamedCapture>,
    /// Buffer IDs currently receiving streaming data
    streaming_ids: HashSet<String>,
    /// Buffer IDs currently being rendered by UI panels
    active_ids: HashSet<String>,
    /// Last logged streaming state for list_captures (reduces log spam)
    last_logged_streaming_ids: Option<HashSet<String>>,
    /// Last logged buffer count for list_captures
    last_logged_buffer_count: usize,
}

impl Default for CaptureRegistry {
    fn default() -> Self {
        Self {
            buffers: HashMap::new(),
            streaming_ids: HashSet::new(),
            active_ids: HashSet::new(),
            last_logged_streaming_ids: None,
            last_logged_buffer_count: 0,
        }
    }
}

/// Global buffer registry
static CAPTURE_REGISTRY: Lazy<RwLock<CaptureRegistry>> =
    Lazy::new(|| RwLock::new(CaptureRegistry::default()));

// ============================================================================
// Public API - Buffer ID Queries
// ============================================================================

/// Check if a given ID corresponds to a known buffer.
pub fn is_known_capture(id: &str) -> bool {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.buffers.contains_key(id)
}

/// Return all known buffer IDs.
pub fn list_capture_ids() -> Vec<String> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.buffers.keys().cloned().collect()
}

// ============================================================================
// Public API - Buffer Creation & Management
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
        if !registry.buffers.contains_key(&id) {
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
    registry.buffers.insert(id.clone(), capture);

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
/// Sets is_streaming=true for the buffer currently being streamed to.
pub fn list_captures() -> Vec<CaptureMetadata> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();

    let current_streaming = registry.streaming_ids.clone();
    let buffer_count = registry.buffers.len();
    let should_log = Some(&current_streaming) != registry.last_logged_streaming_ids.as_ref()
        || buffer_count != registry.last_logged_buffer_count;

    if should_log {
        tlog!(
            "[BufferStore] list_captures - streaming: {:?}, buffers: {}",
            current_streaming,
            buffer_count
        );
        for b in registry.buffers.values() {
            let is_streaming = current_streaming.contains(&b.metadata.id);
            tlog!(
                "[BufferStore]   buffer '{}' is_streaming: {}",
                b.metadata.id, is_streaming
            );
        }
        registry.last_logged_streaming_ids = Some(current_streaming.clone());
        registry.last_logged_buffer_count = buffer_count;
    }

    let result: Vec<CaptureMetadata> = registry
        .buffers
        .values()
        .map(|b| {
            let mut meta = b.metadata.clone();
            meta.is_streaming = current_streaming.contains(&meta.id);
            meta
        })
        .collect();
    result
}

/// Get metadata for a specific buffer.
/// Sets is_streaming=true if this buffer is being streamed to.
pub fn get_capture_metadata(id: &str) -> Option<CaptureMetadata> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.buffers.get(id).map(|b| {
        let mut meta = b.metadata.clone();
        meta.is_streaming = registry.streaming_ids.contains(&meta.id);
        meta
    })
}

/// Delete a specific buffer.
/// If deleting the active/streaming buffer, clears those IDs.
pub fn delete_capture(id: &str) -> Result<(), String> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();

    registry.active_ids.remove(id);
    registry.streaming_ids.remove(id);

    if registry.buffers.remove(id).is_some() {
        // Drop the registry lock before touching SQLite
        drop(registry);
        if let Err(e) = capture_db::delete_capture_data(id) {
            tlog!("[BufferStore] Failed to delete buffer data from SQLite: {}", e);
        }
        if let Err(e) = capture_db::delete_capture_metadata(id) {
            tlog!("[BufferStore] Failed to delete buffer metadata from SQLite: {}", e);
        }
        tlog!("[BufferStore] Deleted buffer '{}'", id);
        Ok(())
    } else {
        Err(format!("Buffer '{}' not found", id))
    }
}

/// Clear a buffer's data without deleting the buffer itself.
/// Resets metadata (count, times, buses) so the session can continue
/// writing new frames into the same buffer.
pub fn clear_capture(id: &str) -> Result<(), String> {
    {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();
        if let Some(buffer) = registry.buffers.get_mut(id) {
            buffer.metadata.count = 0;
            buffer.metadata.start_time_us = None;
            buffer.metadata.end_time_us = None;
            buffer.metadata.buses = Vec::new();
            buffer.seen_buses.clear();
        } else {
            return Err(format!("Buffer '{}' not found", id));
        }
    }

    if let Err(e) = capture_db::delete_capture_data(id) {
        tlog!("[BufferStore] Failed to clear buffer data from SQLite: {}", e);
    }
    tlog!("[BufferStore] Cleared buffer '{}'", id);
    Ok(())
}

/// Rename a buffer.
/// Updates both the in-memory registry and SQLite metadata.
pub fn rename_capture(id: &str, new_name: &str) -> Result<CaptureMetadata, String> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();
    let buffer = registry.buffers.get_mut(id)
        .ok_or_else(|| format!("Buffer '{}' not found", id))?;

    buffer.metadata.name = new_name.to_string();
    let meta = buffer.metadata.clone();

    // Drop registry lock before touching SQLite
    drop(registry);

    if let Err(e) = capture_db::update_capture_name(id, new_name) {
        tlog!("[BufferStore] Failed to persist buffer rename: {}", e);
    }

    tlog!("[BufferStore] Renamed buffer '{}' to '{}'", id, new_name);
    Ok(meta)
}

/// Set a buffer's persistent flag.
/// Persistent buffers survive app restart when 'clear buffers on start' is enabled.
pub fn set_capture_persistent(id: &str, persistent: bool) -> Result<CaptureMetadata, String> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();
    let buffer = registry.buffers.get_mut(id)
        .ok_or_else(|| format!("Buffer '{}' not found", id))?;

    buffer.metadata.persistent = persistent;
    let meta = buffer.metadata.clone();

    // Drop registry lock before touching SQLite
    drop(registry);

    if let Err(e) = capture_db::update_capture_persistent(id, persistent) {
        tlog!("[BufferStore] Failed to persist buffer persistent flag: {}", e);
    }

    tlog!("[BufferStore] Set buffer '{}' persistent={}", id, persistent);
    Ok(meta)
}

/// Hydrate the in-memory buffer registry from persisted SQLite metadata.
/// Called on startup when `clear_captures_on_start` is false.
/// Verifies that data actually exists in SQLite for each metadata entry.
pub fn hydrate_from_db() {
    let metadata_rows = match capture_db::load_all_capture_metadata() {
        Ok(rows) => rows,
        Err(e) => {
            tlog!("[BufferStore] Failed to load buffer metadata from DB: {}", e);
            return;
        }
    };

    if metadata_rows.is_empty() {
        tlog!("[BufferStore] No persisted buffer metadata to hydrate");
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
            tlog!("[BufferStore] Skipping metadata for '{}' — no data in SQLite", meta.id);
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

        registry.buffers.insert(capture.metadata.id.clone(), capture);
        hydrated += 1;
    }

    tlog!("[CaptureStore] Hydrated {} capture(s) from SQLite", hydrated);
}

// ============================================================================
// Public API - Session Ownership
// ============================================================================

/// Assign a buffer to a session.
/// The buffer will only be accessible through this session until orphaned.
pub fn set_capture_owner(buffer_id: &str, session_id: &str) -> Result<(), String> {
    let meta = {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();
        if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
            buffer.metadata.owning_session_id = Some(session_id.to_string());
            tlog!(
                "[BufferStore] Assigned buffer '{}' to session '{}'",
                buffer_id, session_id
            );
            Some(buffer.metadata.clone())
        } else {
            None
        }
    };

    match meta {
        Some(m) => {
            if let Err(e) = capture_db::save_capture_metadata(&m) {
                tlog!("[BufferStore] Failed to persist buffer owner: {}", e);
            }
            Ok(())
        }
        None => Err(format!("Buffer '{}' not found", buffer_id)),
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
/// Returns list of orphaned buffer info for event emission.
pub fn orphan_captures_for_session(session_id: &str) -> Vec<OrphanedCaptureInfo> {
    let (orphaned, metas_to_persist) = {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();
        let mut orphaned = Vec::new();
        let mut metas = Vec::new();

        for buffer in registry.buffers.values_mut() {
            if buffer.metadata.owning_session_id.as_deref() == Some(session_id) {
                buffer.metadata.owning_session_id = None;
                orphaned.push(OrphanedCaptureInfo {
                    capture_id: buffer.metadata.id.clone(),
                    name: buffer.metadata.name.clone(),
                    kind: buffer.metadata.kind.clone(),
                    count: buffer.metadata.count,
                });
                metas.push(buffer.metadata.clone());
            }
        }

        (orphaned, metas)
    };

    // Persist ownership changes outside the registry lock
    for meta in &metas_to_persist {
        if let Err(e) = capture_db::save_capture_metadata(meta) {
            tlog!("[BufferStore] Failed to persist orphan for '{}': {}", meta.id, e);
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

/// Get all buffer IDs owned by a session (frames + bytes).
pub fn get_session_capture_ids(session_id: &str) -> Vec<String> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry
        .buffers
        .values()
        .filter(|b| b.metadata.owning_session_id.as_deref() == Some(session_id))
        .map(|b| b.metadata.id.clone())
        .collect()
}

/// Get the frame buffer ID for a session, if one exists.
pub fn get_session_frame_capture_id(session_id: &str) -> Option<String> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry
        .buffers
        .values()
        .find(|b| {
            b.metadata.owning_session_id.as_deref() == Some(session_id)
                && b.metadata.kind == CaptureKind::Frames
        })
        .map(|b| b.metadata.id.clone())
}

/// Append frames to this session's frame buffer.
/// Resolves the buffer by finding the buffer owned by session_id with
/// buffer_type == Frames. No-op if session has no frame buffer.
pub fn append_frames_to_session(session_id: &str, new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() { return; }
    // Tap test pattern frames for active io_test runners
    crate::io_test::tap_test_frames(session_id, &new_frames);
    let buffer_id = {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        registry.buffers.values()
            .find(|b| b.metadata.owning_session_id.as_deref() == Some(session_id)
                    && b.metadata.kind == CaptureKind::Frames)
            .map(|b| b.metadata.id.clone())
    };
    if let Some(id) = buffer_id {
        append_frames_to_capture(&id, new_frames);
    } else {
        tlog!("[BufferStore] WARN: append_frames_to_session('{}') — no frame buffer found for session (dropped {} frames)", session_id, new_frames.len());
    }
}

/// Append raw bytes to this session's byte buffer.
/// Resolves the buffer by finding the buffer owned by session_id with
/// buffer_type == Bytes. No-op if session has no byte buffer.
pub fn append_raw_bytes_to_session(session_id: &str, new_bytes: Vec<TimestampedByte>) {
    if new_bytes.is_empty() { return; }
    let buffer_id = {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        registry.buffers.values()
            .find(|b| b.metadata.owning_session_id.as_deref() == Some(session_id)
                    && b.metadata.kind == CaptureKind::Bytes)
            .map(|b| b.metadata.id.clone())
    };
    if let Some(id) = buffer_id {
        append_raw_bytes_to_capture(&id, new_bytes);
    }
}

/// Finalize all streaming buffers owned by this session.
/// Removes them from streaming_ids, persists final metadata.
pub fn finalize_session_captures(session_id: &str) -> Vec<CaptureMetadata> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();

    let owned: Vec<String> = {
        let streaming = &registry.streaming_ids;
        registry.buffers.values()
            .filter(|b| b.metadata.owning_session_id.as_deref() == Some(session_id)
                     && streaming.contains(&b.metadata.id))
            .map(|b| b.metadata.id.clone())
            .collect()
    };

    let mut finalized = Vec::new();
    for id in &owned {
        registry.streaming_ids.remove(id);
        if let Some(buffer) = registry.buffers.get(id) {
            let meta = buffer.metadata.clone();
            tlog!("[BufferStore] Finalized buffer '{}' with {} items", id, meta.count);
            finalized.push(meta);
        }
    }

    drop(registry);

    for meta in &finalized {
        if let Err(e) = capture_db::save_capture_metadata(meta) {
            tlog!("[BufferStore] Failed to persist finalized buffer metadata: {}", e);
        }
    }

    finalized
}

/// Mark a buffer as being rendered by a UI panel.
pub fn mark_capture_active(buffer_id: &str) -> Result<(), String> {
    let mut registry = CAPTURE_REGISTRY.write().unwrap();
    if registry.buffers.contains_key(buffer_id) {
        registry.active_ids.insert(buffer_id.to_string());
        tlog!("[BufferStore] Marked buffer active: {}", buffer_id);
        Ok(())
    } else {
        Err(format!("Buffer '{}' not found", buffer_id))
    }
}

/// List only orphaned buffers (no owning session).
/// These are available for standalone selection.
pub fn list_orphaned_captures() -> Vec<CaptureMetadata> {
    let registry = CAPTURE_REGISTRY.read().unwrap();

    registry
        .buffers
        .values()
        .filter(|b| b.metadata.owning_session_id.is_none())
        .map(|b| {
            let mut meta = b.metadata.clone();
            meta.is_streaming = registry.streaming_ids.contains(&meta.id);
            meta
        })
        .collect()
}

/// Create a copy of a buffer for an app that is detaching.
/// The copy is orphaned (no owning session) and available for standalone use.
/// Returns the new buffer ID.
pub fn copy_capture(source_buffer_id: &str, new_name: String) -> Result<String, String> {
    let source_metadata = {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        let source = registry
            .buffers
            .get(source_buffer_id)
            .ok_or_else(|| format!("Buffer '{}' not found", source_buffer_id))?;
        source.metadata.clone()
    };

    // Create new buffer entry in registry
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
        let buffer = NamedCapture { metadata: metadata.clone(), seen_buses };
        registry.buffers.insert(id.clone(), buffer);
        (id, metadata)
    };

    // Copy data in SQLite (INSERT INTO ... SELECT — no memory spike)
    let count = capture_db::copy_capture_data(source_buffer_id, &id)?;

    // Persist metadata for the new buffer
    if let Err(e) = capture_db::save_capture_metadata(&metadata) {
        tlog!("[BufferStore] Failed to persist copied buffer metadata: {}", e);
    }

    tlog!(
        "[BufferStore] Copied buffer '{}' -> '{}' ('{}', {} items)",
        source_buffer_id, id, new_name, count
    );

    Ok(id)
}

// ============================================================================
// Public API - Data Access (Frame Buffers)
// ============================================================================

/// Append frames to a specific buffer by ID.
/// Silently returns if buffer doesn't exist or is not a frame buffer.
/// Only used by framing.rs which is desktop-only.
#[cfg(not(target_os = "ios"))]
pub fn append_frames_to_capture(buffer_id: &str, new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() {
        return;
    }

    {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();

        if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
            if buffer.metadata.kind != CaptureKind::Frames {
                return;
            }
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            }
            buffer.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);
            buffer.metadata.count += new_frames.len();

            // Track distinct buses
            let prev_len = buffer.seen_buses.len();
            for f in &new_frames {
                buffer.seen_buses.insert(f.bus);
            }
            if buffer.seen_buses.len() != prev_len {
                let mut sorted: Vec<u8> = buffer.seen_buses.iter().copied().collect();
                sorted.sort();
                buffer.metadata.buses = sorted;
            }
        } else {
            return;
        }
        // Registry lock dropped here
    }

    if let Err(e) = capture_db::insert_frames(buffer_id, &new_frames) {
        tlog!("[BufferStore] Failed to insert frames to buffer '{}': {}", buffer_id, e);
    }
}

/// Clear a frame buffer and refill it with new frames.
/// Used during live framing to reuse the same buffer ID instead of creating new ones.
/// Silently returns if buffer doesn't exist or is not a frame buffer.
/// Only used by framing.rs which is desktop-only.
#[cfg(not(target_os = "ios"))]
pub fn clear_and_refill_capture(buffer_id: &str, new_frames: Vec<FrameMessage>) {
    {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();

        if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
            if buffer.metadata.kind != CaptureKind::Frames {
                return;
            }
            buffer.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            buffer.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);
            buffer.metadata.count = new_frames.len();

            // Reset and rebuild bus tracking
            buffer.seen_buses.clear();
            for f in &new_frames {
                buffer.seen_buses.insert(f.bus);
            }
            let mut sorted: Vec<u8> = buffer.seen_buses.iter().copied().collect();
            sorted.sort();
            buffer.metadata.buses = sorted;
        } else {
            return;
        }
    }

    if let Err(e) = capture_db::clear_and_refill(buffer_id, &new_frames) {
        tlog!("[BufferStore] Failed to clear and refill buffer '{}': {}", buffer_id, e);
    } else {
        tlog!(
            "[BufferStore] Refilled buffer '{}' with {} frames",
            buffer_id, new_frames.len()
        );
    }
}

/// Get frames from a specific buffer.
/// Returns None if buffer doesn't exist or is not a frame buffer.
pub fn get_capture_frames(id: &str) -> Option<Vec<FrameMessage>> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    let buffer = registry.buffers.get(id)?;
    if buffer.metadata.kind != CaptureKind::Frames {
        return None;
    }
    drop(registry);

    capture_db::get_all_frames(id).ok()
}

/// Get a page of frames from a specific buffer.
/// Returns (frames, buffer_indices, total_count).
pub fn get_capture_frames_paginated(id: &str, offset: usize, limit: usize) -> (Vec<FrameMessage>, Vec<usize>, usize) {
    let total = {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
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
            tlog!("[BufferStore] Failed to get paginated frames: {}", e);
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
        match registry.buffers.get(id) {
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
            tlog!("[BufferStore] Failed to get filtered paginated frames: {}", e);
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

/// Get the most recent N frames from a buffer, optionally filtered by frame IDs.
/// Returns the frames in chronological order (oldest first) for display.
pub fn get_capture_frames_tail(
    id: &str,
    limit: usize,
    selected_ids: &std::collections::HashSet<u32>,
) -> TailResponse {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
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
            tlog!("[BufferStore] Failed to get tail frames: {}", e);
            TailResponse {
                frames: Vec::new(),
                capture_indices: Vec::new(),
                total_filtered_count: 0,
                capture_end_time_us: None,
            }
        }
    }
}

/// Frame info extracted from a buffer
#[derive(Clone, Debug, serde::Serialize)]
pub struct CaptureFrameInfo {
    pub frame_id: u32,
    pub max_dlc: u8,
    pub bus: u8,
    pub is_extended: bool,
    pub has_dlc_mismatch: bool,
}

/// Get unique frame IDs and their metadata from a buffer.
pub fn get_capture_frame_info(id: &str) -> Vec<CaptureFrameInfo> {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => {},
            _ => return Vec::new(),
        }
    }

    match capture_db::get_frame_info(id) {
        Ok(info) => info,
        Err(e) => {
            tlog!("[BufferStore] Failed to get frame info: {}", e);
            Vec::new()
        }
    }
}

/// Find the offset for a given timestamp in a buffer.
pub fn find_capture_offset_for_timestamp(
    id: &str,
    target_time_us: u64,
    selected_ids: &std::collections::HashSet<u32>,
) -> usize {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => {},
            _ => return 0,
        }
    }

    let frame_ids: Vec<u32> = selected_ids.iter().copied().collect();
    match capture_db::find_offset_for_timestamp(id, target_time_us, &frame_ids) {
        Ok(offset) => offset,
        Err(e) => {
            tlog!("[BufferStore] Failed to find offset for timestamp: {}", e);
            0
        }
    }
}

// ============================================================================
// Public API - Data Access (Byte Buffers)
// ============================================================================

/// Append raw bytes to a specific buffer by ID.
/// Silently returns if buffer doesn't exist or is not a byte buffer.
pub fn append_raw_bytes_to_capture(buffer_id: &str, new_bytes: Vec<TimestampedByte>) {
    if new_bytes.is_empty() {
        return;
    }

    {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();

        if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
            if buffer.metadata.kind != CaptureKind::Bytes {
                return;
            }
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_bytes.first().map(|b| b.timestamp_us);
            }
            buffer.metadata.end_time_us = new_bytes.last().map(|b| b.timestamp_us);
            buffer.metadata.count += new_bytes.len();

            // Track distinct buses
            let prev_len = buffer.seen_buses.len();
            for b in &new_bytes {
                buffer.seen_buses.insert(b.bus);
            }
            if buffer.seen_buses.len() != prev_len {
                let mut sorted: Vec<u8> = buffer.seen_buses.iter().copied().collect();
                sorted.sort();
                buffer.metadata.buses = sorted;
            }
        } else {
            return;
        }
    }

    if let Err(e) = capture_db::insert_bytes(buffer_id, &new_bytes) {
        tlog!("[BufferStore] Failed to insert bytes to buffer '{}': {}", buffer_id, e);
    }
}

/// Get raw bytes from a specific buffer.
/// Returns None if buffer doesn't exist or is not a byte buffer.
pub fn get_capture_bytes(id: &str) -> Option<Vec<TimestampedByte>> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    let buffer = registry.buffers.get(id)?;
    if buffer.metadata.kind != CaptureKind::Bytes {
        return None;
    }
    drop(registry);

    capture_db::get_all_bytes(id).ok()
}

/// Get a page of bytes from a specific buffer.
/// Returns (bytes, total_count).
pub fn get_capture_bytes_paginated(id: &str, offset: usize, limit: usize) -> (Vec<TimestampedByte>, usize) {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Bytes => {},
            _ => return (Vec::new(), 0),
        }
    }

    match capture_db::get_bytes_paginated(id, offset, limit) {
        Ok((bytes, total)) => (bytes, total),
        Err(e) => {
            tlog!("[BufferStore] Failed to get paginated bytes: {}", e);
            (Vec::new(), 0)
        }
    }
}

/// Find the byte offset for a given timestamp in a specific byte buffer.
pub fn find_capture_bytes_offset_for_timestamp_by_id(buffer_id: &str, target_time_us: u64) -> usize {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.buffers.get(buffer_id) {
            Some(b) if b.metadata.kind == CaptureKind::Bytes => {},
            _ => return 0,
        }
    }

    match capture_db::find_bytes_offset_for_timestamp(buffer_id, target_time_us) {
        Ok(offset) => offset,
        Err(e) => {
            tlog!("[BufferStore] Failed to find bytes offset for timestamp: {}", e);
            0
        }
    }
}

// ============================================================================
// Public API - Utility Functions
// ============================================================================

/// Check if any buffer has data.
pub fn has_any_data() -> bool {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.buffers.values().any(|b| b.metadata.count > 0)
}

/// Get the count for a specific buffer.
pub fn get_capture_count(id: &str) -> usize {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.buffers.get(id).map(|b| b.metadata.count).unwrap_or(0)
}

/// Get the type of a specific buffer.
pub fn get_capture_kind(id: &str) -> Option<CaptureKind> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.buffers.get(id).map(|b| b.metadata.kind.clone())
}


