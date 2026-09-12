// ui/src-tauri/src/capture_store.rs
//
// Multi-capture registry for storing captured data.
// Metadata lives in RAM; bulk frame/byte data lives in SQLite (capture_db).
// Supports multiple named captures, each typed as either Frames or Bytes.
//
// Schema changes to buffers.db MUST be recorded migrations — see
// docs/capture-db-migrations.md. Never issue ad-hoc DDL from this file.

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

impl CaptureKind {
    /// The wire spelling, as persisted and as reported to the frontend. Must match the
    /// `rename_all` derive above, which is what serialised `CaptureMetadata` carries.
    pub fn as_str(&self) -> &'static str {
        match self {
            CaptureKind::Frames => "frames",
            CaptureKind::Bytes => "bytes",
        }
    }

    /// Inverse of `as_str`. Anything unrecognised reads as `Frames`, which is what the
    /// persisted column has always defaulted to.
    pub fn from_str(s: &str) -> Self {
        match s {
            "bytes" => CaptureKind::Bytes,
            _ => CaptureKind::Frames,
        }
    }
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

/// Why a session holds a capture. A session's own capture and one it merely owns are
/// not interchangeable: ownership alone was the wrong test for "which capture is this
/// session's", because client-side framing derives its output into session-owned
/// captures. See docs/capture-flow.md § Registry state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CaptureRole {
    /// The session's own capture — the one it streams into, or replays from.
    Stream,
    /// Owned for cleanup only: a framing result the session derived but never wrote
    /// to. Never answers as "the session's capture".
    Derived,
}

/// A named capture — metadata only, data lives in SQLite.
struct NamedCapture {
    metadata: CaptureMetadata,
    /// Why the owning session holds it — written with `owning_session_id` and cleared
    /// with it, so the pair cannot drift. In memory only: `hydrate_from_db` orphans
    /// every capture, so no owner and no role survives a restart.
    owner_role: Option<CaptureRole>,
    /// In-memory set for efficient bus tracking during streaming
    seen_buses: HashSet<u8>,
    /// Distinct frame ids per protocol seen during streaming, for a cheap O(1)
    /// unique-frame count. Populated on append only — empty for DB-hydrated
    /// captures (their live "unique" display uses a different path).
    unique_frames: HashMap<String, HashSet<u32>>,
}

/// Record a frame's identity in the unique-frame index. Clones the protocol only the
/// first time each one is seen, so the streaming path stays allocation-free.
#[inline]
fn note_unique_frame(unique: &mut HashMap<String, HashSet<u32>>, frame: &FrameMessage) {
    if let Some(ids) = unique.get_mut(&frame.protocol) {
        ids.insert(frame.frame_id);
    } else {
        unique.insert(frame.protocol.clone(), HashSet::from([frame.frame_id]));
    }
}

/// A protocol and the frame ids selected under it.
///
/// Frame identity is (protocol, frame_id): CAN 0x100 and Modbus register 256 are
/// different frames that share a numeric id, so a bare id over-matches across
/// protocols. Grouping keeps the protocol string off every entry — a busy selection
/// is thousands of ids across at most three protocols.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolFrames {
    pub protocol: String,
    pub frame_ids: Vec<u32>,
    /// Every id of this protocol, `frame_ids` notwithstanding — a protocol tab
    /// wants its whole protocol, ids seen or not.
    #[serde(default)]
    pub all_ids: bool,
}

impl ProtocolFrames {
    pub fn ids(protocol: impl Into<String>, frame_ids: Vec<u32>) -> Self {
        Self { protocol: protocol.into(), frame_ids, all_ids: false }
    }

    pub fn whole(protocol: impl Into<String>) -> Self {
        Self { protocol: protocol.into(), frame_ids: Vec::new(), all_ids: true }
    }
}

/// A normalised frame selection: empty groups dropped, ids deduplicated, and the
/// protocols selected whole — which absorb any ids listed under them.
///
/// Every consumer reads empty as "select everything", so a group carrying no ids must
/// not leave the selection looking non-empty — that would turn "select nothing" into
/// "select everything".
#[derive(Debug, Clone, Default)]
pub struct FrameSelection {
    ids: HashMap<String, HashSet<u32>>,
    whole: HashSet<String>,
}

impl FrameSelection {
    pub fn from_groups(groups: Vec<ProtocolFrames>) -> Self {
        let mut selection = Self::default();
        for group in groups {
            if group.all_ids {
                selection.whole.insert(group.protocol);
            } else if !group.frame_ids.is_empty() {
                selection
                    .ids
                    .entry(group.protocol)
                    .or_default()
                    .extend(group.frame_ids);
            }
        }
        let whole = &selection.whole;
        selection.ids.retain(|protocol, _| !whole.contains(protocol));
        selection
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty() && self.whole.is_empty()
    }

    /// True when every frame the capture has seen is selected, so the filter can be
    /// skipped entirely. Discovery auto-selects each id it discovers, making this the
    /// common case.
    pub fn covers(&self, unique: &HashMap<String, HashSet<u32>>) -> bool {
        unique.iter().all(|(protocol, ids)| {
            self.whole.contains(protocol)
                || self.ids.get(protocol).is_some_and(|selected| ids.is_subset(selected))
        })
    }

    /// Whether one frame is selected, matched on the identity pair.
    pub fn contains(&self, protocol: &str, frame_id: u32) -> bool {
        self.whole.contains(protocol)
            || self.ids.get(protocol).is_some_and(|ids| ids.contains(&frame_id))
    }

    /// (frame_id, protocol) pairs, sorted so the JSON payload is stable across calls.
    /// A protocol selected whole contributes none: it is matched by `protocols`.
    pub fn pairs(&self) -> Vec<(u32, &str)> {
        let mut pairs: Vec<(u32, &str)> = self
            .ids
            .iter()
            .flat_map(|(protocol, ids)| ids.iter().map(move |id| (*id, protocol.as_str())))
            .collect();
        pairs.sort_unstable();
        pairs
    }

    /// The protocols selected whole, sorted.
    pub fn protocols(&self) -> Vec<&str> {
        let mut out: Vec<&str> = self.whole.iter().map(String::as_str).collect();
        out.sort_unstable();
        out
    }
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

/// Whether any capture is currently receiving live appends — i.e. a recording is
/// in progress. True independent of whether a UI panel is watching the session,
/// so the wake lock can stay held while an unwatched capture keeps recording.
pub fn has_streaming_captures() -> bool {
    CAPTURE_REGISTRY
        .read()
        .map(|r| !r.streaming_ids.is_empty())
        .unwrap_or(false)
}

// ============================================================================
// Public API - Capture Creation & Management
// ============================================================================

/// Create a capture as `session_id`'s own — the one it streams into — and hand back
/// its ID. It becomes the live append target; use `create_session_capture_inactive`
/// for the byte capture beside a framed serial session's frames capture, which fills
/// only if the source also emits raw bytes.
pub fn create_session_capture(session_id: &str, kind: CaptureKind, name: String) -> String {
    create_capture_internal(kind, name, true, Some((session_id, CaptureRole::Stream)))
}

/// As `create_session_capture`, but not the live append target.
pub fn create_session_capture_inactive(session_id: &str, kind: CaptureKind, name: String) -> String {
    create_capture_internal(kind, name, false, Some((session_id, CaptureRole::Stream)))
}

/// Create a capture derived from a session's data — a framing result. Owned by the
/// session so it is cleaned up with it, but never "the session's capture", and never
/// the live append target.
pub fn create_derived_capture(session_id: &str, kind: CaptureKind, name: String) -> String {
    create_capture_internal(kind, name, false, Some((session_id, CaptureRole::Derived)))
}

/// Create a capture owned by no session — data that arrived from outside any
/// source, such as bytes handed in over MCP. Nothing streams into it and no
/// session's lifecycle takes it away; it is deleted explicitly or not at all.
pub fn create_standalone_capture(kind: CaptureKind, name: String) -> String {
    create_capture_internal(kind, name, false, None)
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

/// Internal helper to create a capture, with optional streaming activation and an
/// owning session. Owner and role are set as the capture is built, so it is never
/// briefly visible as unowned and the row is written to SQLite once.
fn create_capture_internal(
    kind: CaptureKind,
    name: String,
    set_streaming: bool,
    owner: Option<(&str, CaptureRole)>,
) -> String {
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
        owning_session_id: owner.map(|(session_id, _)| session_id.to_string()),
        persistent: false,
        buses: Vec::new(),
    };

    let capture = NamedCapture {
        metadata: metadata.clone(),
        owner_role: owner.map(|(_, role)| role),
        seen_buses: HashSet::new(),
        unique_frames: HashMap::new(),
    };
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
        "[CaptureStore] Created capture '{}' ({:?}) - '{}' [streaming={}, owner={:?}]",
        id, kind, name, set_streaming, owner
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
            cap.unique_frames.clear();
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
            owner_role: None, // no owner, so no role
            seen_buses,
            unique_frames: HashMap::new(),
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

/// Assign an existing capture to a session — it is only reachable through this session
/// until orphaned. `role` says whether it is the session's own (a replay source binding
/// the capture it plays back) or merely derived from it; the role is required precisely
/// so the choice cannot be made by omission.
pub fn set_capture_owner(
    capture_id: &str,
    session_id: &str,
    role: CaptureRole,
) -> Result<(), String> {
    let meta = {
        let mut registry = CAPTURE_REGISTRY.write().unwrap();
        if let Some(cap) = registry.captures.get_mut(capture_id) {
            cap.metadata.owning_session_id = Some(session_id.to_string());
            cap.owner_role = Some(role);
            tlog!(
                "[CaptureStore] Assigned capture '{}' to session '{}' as {:?}",
                capture_id, session_id, role
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
                cap.owner_role = None;
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

/// Next unique "{base}_{n}" capture name — n is the highest existing such suffix + 1.
/// Gives each per-app "Leave session" snapshot a distinct, sortable name.
pub fn next_indexed_name(base: &str) -> String {
    let prefix = format!("{}_", base);
    let max_n = CAPTURE_REGISTRY
        .read()
        .map(|registry| {
            registry
                .captures
                .values()
                .filter_map(|b| b.metadata.name.strip_prefix(prefix.as_str()))
                .filter_map(|suffix| suffix.parse::<u32>().ok())
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    format!("{}_{}", base, max_n + 1)
}

/// Whether this capture is `session_id`'s own — owned by it *and* held as a stream
/// target rather than as a derived result. Ownership alone is the wrong test: a raw
/// serial session owns the Frames capture client-side framing derived from its bytes,
/// but never streamed a frame into it. See docs/capture-flow.md § Registry state.
fn is_session_stream(capture: &NamedCapture, session_id: &str) -> bool {
    capture.metadata.owning_session_id.as_deref() == Some(session_id)
        && capture.owner_role == Some(CaptureRole::Stream)
}

/// Whether `capture_id` is a capture derived from `session_id`'s data rather than the
/// session's own. Framing may clear and refill one of these; doing that to the
/// session's own capture would destroy what it is still recording.
pub fn is_derived_capture(capture_id: &str, session_id: &str) -> bool {
    CAPTURE_REGISTRY.read().unwrap().captures.get(capture_id).is_some_and(|c| {
        c.metadata.owning_session_id.as_deref() == Some(session_id)
            && c.owner_role == Some(CaptureRole::Derived)
    })
}

/// The capture of `kind` that `session_id` streams into, if one exists. A session has
/// at most one of each kind, so this identifies it uniquely.
fn session_capture_id(session_id: &str, kind: CaptureKind) -> Option<String> {
    CAPTURE_REGISTRY
        .read()
        .unwrap()
        .captures
        .values()
        .find(|b| is_session_stream(b, session_id) && b.metadata.kind == kind)
        .map(|b| b.metadata.id.clone())
}

/// Get the frame capture ID for a session, if one exists.
pub fn get_session_frame_capture_id(session_id: &str) -> Option<String> {
    session_capture_id(session_id, CaptureKind::Frames)
}

/// Get the byte capture ID for a session, if one exists.
pub fn get_session_bytes_capture_id(session_id: &str) -> Option<String> {
    session_capture_id(session_id, CaptureKind::Bytes)
}

/// The session's own capture and its kind, frames first. A session that streams both
/// (framed serial with raw bytes alongside) is a frames session; one that streams only
/// bytes reports bytes, which is what tells a joining app it is looking at a serial
/// link rather than a CAN one.
pub fn get_session_capture(session_id: &str) -> Option<(String, CaptureKind)> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    let mut bytes = None;
    for capture in registry.captures.values() {
        if !is_session_stream(capture, session_id) {
            continue;
        }
        match capture.metadata.kind {
            CaptureKind::Frames => return Some((capture.metadata.id.clone(), CaptureKind::Frames)),
            CaptureKind::Bytes => bytes = Some(capture.metadata.id.clone()),
        }
    }
    bytes.map(|id| (id, CaptureKind::Bytes))
}

/// Append frames to this session's frame capture.
/// Resolves the capture by finding the capture owned by session_id with
/// capture kind == Frames. No-op if session has no frame capture.
pub fn append_frames_to_session(session_id: &str, new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() { return; }
    // Tap test pattern frames for active io_test runners
    crate::io_test::tap_test_frames(session_id, &new_frames);
    let capture_id = get_session_frame_capture_id(session_id);
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
    if let Some(id) = get_session_bytes_capture_id(session_id) {
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
        // A snapshot belongs to nobody — it is handed to a detaching app to review.
        let entry = NamedCapture {
            metadata: metadata.clone(),
            owner_role: None,
            seen_buses,
            unique_frames: HashMap::new(),
        };
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

            // Track distinct buses and distinct (bus, frame_id) keys
            let prev_len = cap.seen_buses.len();
            for f in &new_frames {
                cap.seen_buses.insert(f.bus);
                note_unique_frame(&mut cap.unique_frames, f);
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

            // Reset and rebuild bus + unique-frame tracking
            cap.seen_buses.clear();
            cap.unique_frames.clear();
            for f in &new_frames {
                cap.seen_buses.insert(f.bus);
                note_unique_frame(&mut cap.unique_frames, f);
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

/// The newest frame per identity in a frame capture. See `capture_db::get_latest_frames`.
pub fn get_capture_latest_frames(id: &str) -> Option<Vec<FrameMessage>> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    let cap = registry.captures.get(id)?;
    if cap.metadata.kind != CaptureKind::Frames {
        return None;
    }
    drop(registry);

    capture_db::get_latest_frames(id).ok()
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
    selection: &FrameSelection,
) -> (Vec<FrameMessage>, Vec<usize>, usize) {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => {},
            _ => return (Vec::new(), Vec::new(), 0),
        }
    }

    if selection.is_empty() {
        return get_capture_frames_paginated(id, offset, limit);
    }

    match capture_db::get_frames_paginated_filtered(id, offset, limit, selection) {
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

impl TailResponse {
    fn empty() -> Self {
        TailResponse {
            frames: Vec::new(),
            capture_indices: Vec::new(),
            total_filtered_count: 0,
            capture_end_time_us: None,
        }
    }
}

/// Get the most recent N frames from a capture, optionally filtered by frame IDs.
/// Returns the frames in chronological order (oldest first) for display.
pub fn get_capture_frames_tail(id: &str, limit: usize, selection: &FrameSelection) -> TailResponse {
    // The registry tracks the count, the end time and the distinct frame ids for every
    // capture. The live view refetches this on each frame-count signal, so answering from
    // RAM keeps a COUNT(*) and a MAX() scan of the whole capture off that path.
    let (total, end_time_us, covers_everything) = {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => {
                // Discovery auto-selects every id it discovers, so the common case is a
                // selection that excludes nothing. Recognising that takes the cheap path
                // instead of filtering by every id in the capture.
                let covers = selection.covers(&b.unique_frames);
                (b.metadata.count, b.metadata.end_time_us, covers)
            }
            _ => return TailResponse::empty(),
        }
    };

    let result = if selection.is_empty() || covers_everything {
        capture_db::get_frames_tail_rows(id, limit).map(|(frames, rowids)| (frames, rowids, total))
    } else {
        capture_db::get_frames_tail_filtered(id, limit, selection)
    };

    match result {
        Ok((frames, rowids, total_filtered_count)) => TailResponse {
            frames,
            capture_indices: rowids.into_iter().map(|r| r as usize).collect(),
            total_filtered_count,
            capture_end_time_us: end_time_us,
        },
        Err(e) => {
            tlog!("[CaptureStore] Failed to get tail frames: {}", e);
            TailResponse::empty()
        }
    }
}

/// Frame info extracted from a capture
#[derive(Clone, Debug, serde::Serialize)]
pub struct CaptureFrameInfo {
    /// Frame identity is (protocol, frame_id) — CAN 0x100 and Modbus register 256
    /// are different frames that share a numeric id.
    pub protocol: String,
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
    selection: &FrameSelection,
) -> usize {
    {
        let registry = CAPTURE_REGISTRY.read().unwrap();
        match registry.captures.get(id) {
            Some(b) if b.metadata.kind == CaptureKind::Frames => {},
            _ => return 0,
        }
    }

    match capture_db::find_offset_for_timestamp(id, target_time_us, selection) {
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
    if !is_byte_capture(id) {
        return None;
    }

    capture_db::get_all_bytes(id).ok()
}

/// Whether `id` names a capture that holds bytes. Byte queries return empty rather
/// than erroring for a frames capture, so every one of them checks first.
fn is_byte_capture(id: &str) -> bool {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    matches!(registry.captures.get(id), Some(b) if b.metadata.kind == CaptureKind::Bytes)
}

/// Get a page of bytes from a specific capture.
/// Returns (bytes, total_count).
pub fn get_capture_bytes_paginated(id: &str, offset: usize, limit: usize) -> (Vec<TimestampedByte>, usize) {
    if !is_byte_capture(id) {
        return (Vec::new(), 0);
    }

    match capture_db::get_bytes_paginated(id, offset, limit) {
        Ok((bytes, total)) => (bytes, total),
        Err(e) => {
            tlog!("[CaptureStore] Failed to get paginated bytes: {}", e);
            (Vec::new(), 0)
        }
    }
}

/// Get the last `limit` bytes from a specific capture, oldest first.
/// The caller takes the total from `get_capture_count`, which is O(1).
pub fn get_capture_bytes_tail(id: &str, limit: usize) -> Vec<TimestampedByte> {
    if !is_byte_capture(id) {
        return Vec::new();
    }

    capture_db::get_bytes_tail_rows(id, limit).unwrap_or_else(|e| {
        tlog!("[CaptureStore] Failed to get bytes tail: {}", e);
        Vec::new()
    })
}

/// Find the byte offset for a given timestamp in a specific byte capture.
pub fn find_capture_bytes_offset_for_timestamp_by_id(capture_id: &str, target_time_us: u64) -> usize {
    if !is_byte_capture(capture_id) {
        return 0;
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

/// Distinct (bus, frame_id) count seen while streaming into this capture.
/// O(1). Returns 0 for DB-hydrated captures that have had no live appends.
pub fn get_capture_unique_count(id: &str) -> usize {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry
        .captures
        .get(id)
        .map(|b| b.unique_frames.values().map(HashSet::len).sum())
        .unwrap_or(0)
}

/// Get the kind of a specific capture.
pub fn get_capture_kind(id: &str) -> Option<CaptureKind> {
    let registry = CAPTURE_REGISTRY.read().unwrap();
    registry.captures.get(id).map(|b| b.metadata.kind.clone())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn groups(entries: &[(&str, &[u32])]) -> Vec<ProtocolFrames> {
        entries.iter().map(|(protocol, ids)| ProtocolFrames::ids(*protocol, ids.to_vec())).collect()
    }

    fn unique(entries: &[(&str, &[u32])]) -> HashMap<String, HashSet<u32>> {
        entries
            .iter()
            .map(|(protocol, ids)| (protocol.to_string(), ids.iter().copied().collect()))
            .collect()
    }

    /// A capture with no owning session — what MCP ingest creates — is owned by
    /// nothing, so no session's lifecycle can take it away. (The byte round-trip
    /// itself is `capture_db`'s; the store holds only metadata.)
    #[test]
    fn a_standalone_capture_is_owned_by_no_session() {
        let id = create_standalone_capture(CaptureKind::Bytes, "ingest test".to_string());
        assert_eq!(get_capture_kind(&id), Some(CaptureKind::Bytes));
        let listed = list_captures();
        let entry = listed.iter().find(|c| c.id == id).expect("capture is listed");
        assert!(entry.owning_session_id.is_none());
        assert!(!entry.is_streaming, "nothing streams into an ingested capture");
    }

    /// Empty means "select everything" at every call site, so a group carrying no ids must
    /// not leave the selection looking non-empty — that would invert "select nothing".
    #[test]
    fn groups_with_no_ids_normalise_to_an_empty_selection() {
        assert!(FrameSelection::from_groups(groups(&[("can", &[])])).is_empty());
        assert!(FrameSelection::from_groups(Vec::new()).is_empty());
        assert!(!FrameSelection::from_groups(groups(&[("can", &[256])])).is_empty());
    }

    #[test]
    fn repeated_groups_merge_and_deduplicate() {
        let selection = FrameSelection::from_groups(groups(&[("can", &[256, 256]), ("can", &[257])]));
        assert_eq!(selection.pairs(), vec![(256, "can"), (257, "can")]);
    }

    /// The tail skips filtering when the selection covers every frame seen. Keyed on the
    /// bare id, a CAN-only selection wrongly "covered" a capture holding Modbus too, and
    /// the tail silently returned unfiltered rows.
    #[test]
    fn covers_is_protocol_aware() {
        let capture = unique(&[("can", &[256]), ("modbus", &[256])]);

        assert!(!FrameSelection::from_groups(groups(&[("can", &[256, 257])])).covers(&capture));
        assert!(
            FrameSelection::from_groups(groups(&[("can", &[256]), ("modbus", &[256])]))
                .covers(&capture)
        );
    }

    /// A protocol tab selects its protocol whole: not empty (which would select
    /// everything), covering every id of that protocol including ones not yet seen,
    /// and contributing no pairs — the predicate matches it by name.
    #[test]
    fn a_protocol_selected_whole_covers_ids_it_has_not_seen() {
        let selection = FrameSelection::from_groups(vec![ProtocolFrames::whole("modbus_rtu")]);
        assert!(!selection.is_empty());
        assert!(selection.contains("modbus_rtu", 0x0265));
        assert!(!selection.contains("can", 0x0265));
        assert!(selection.covers(&unique(&[("modbus_rtu", &[288, 613])])));
        assert!(!selection.covers(&unique(&[("modbus_rtu", &[288]), ("can", &[256])])));
        assert!(selection.pairs().is_empty());
        assert_eq!(selection.protocols(), vec!["modbus_rtu"]);

        // Whole and by-id combine, and a whole protocol absorbs its own ids.
        let mut mixed = groups(&[("can", &[256]), ("modbus_rtu", &[288])]);
        mixed.push(ProtocolFrames::whole("modbus_rtu"));
        let mixed = FrameSelection::from_groups(mixed);
        assert_eq!(mixed.pairs(), vec![(256, "can")]);
        assert_eq!(mixed.protocols(), vec!["modbus_rtu"]);
    }

    #[test]
    fn pairs_are_sorted_regardless_of_insertion_order() {
        let a = FrameSelection::from_groups(groups(&[("modbus", &[257, 256]), ("can", &[256])]));
        let b = FrameSelection::from_groups(groups(&[("can", &[256]), ("modbus", &[256, 257])]));
        assert_eq!(a.pairs(), b.pairs());
        assert_eq!(a.pairs(), vec![(256, "can"), (256, "modbus"), (257, "modbus")]);
    }

    /// A raw serial session streams bytes, and client-side framing derives a Frames
    /// capture that it assigns to the same session. Picking by ownership finds that
    /// derived capture and the session gets replayed as frames instead of suspended,
    /// which is what dropped Discovery out of its serial view on stop.
    #[test]
    fn a_derived_frame_capture_is_not_the_session_stream_target() {
        let session = "test_session_streaming_only";
        let streamed = create_session_capture(session, CaptureKind::Bytes, "raw serial".into());
        let derived = create_derived_capture(session, CaptureKind::Frames, "Framed from raw".into());

        assert_eq!(get_session_frame_capture_id(session), None);
        assert_eq!(get_session_capture(session), Some((streamed, CaptureKind::Bytes)));
        // ...and framing may refill that one, having not been told it is the session's.
        assert!(is_derived_capture(&derived, session));
    }

    /// The role outlives the streaming set, so the answer does not change under the
    /// caller when a session stops — which is what forced `stop_and_switch_to_capture`
    /// to read the capture before `stop()` and made the ordering load-bearing.
    #[test]
    fn stopping_does_not_change_the_session_capture() {
        let session = "test_session_finalise";
        let streamed = create_session_capture(session, CaptureKind::Frames, "can".into());
        assert_eq!(get_session_frame_capture_id(session), Some(streamed.clone()));

        finalize_session_captures(session);

        assert_eq!(get_session_frame_capture_id(session), Some(streamed));
    }

    /// A replay session adopts an orphaned capture it did not create. Owning it is not
    /// enough — without the Stream role it would still answer None and WS dispatch
    /// would send nothing.
    #[test]
    fn an_adopted_capture_becomes_the_session_capture() {
        let recorder = "test_session_recorder";
        let replay = "test_session_adopt";
        let existing = create_session_capture(recorder, CaptureKind::Frames, "recording".into());
        orphan_captures_for_session(recorder);
        assert_eq!(get_session_frame_capture_id(replay), None);

        set_capture_owner(&existing, replay, CaptureRole::Stream).unwrap();

        assert_eq!(get_session_frame_capture_id(replay), Some(existing));
    }

    /// Orphaning clears the role with the owner, so a capture re-owned as a derived
    /// result cannot inherit a stale claim from the session that streamed it.
    #[test]
    fn orphaning_releases_the_role_with_the_owner() {
        let first = "test_session_first";
        let second = "test_session_second";
        let capture = create_session_capture(first, CaptureKind::Frames, "can".into());
        orphan_captures_for_session(first);

        set_capture_owner(&capture, second, CaptureRole::Derived).unwrap();

        assert_eq!(get_session_frame_capture_id(second), None);
        assert!(is_derived_capture(&capture, second));
    }

    /// Framed serial streams both kinds; frames is the session's identity, and the
    /// byte capture beside it must not be reported as the thing a joiner renders.
    #[test]
    fn frames_win_over_bytes_for_a_session_that_streams_both() {
        let session = "test_session_both";
        let frames = create_session_capture(session, CaptureKind::Frames, "framed".into());
        let bytes = create_session_capture_inactive(session, CaptureKind::Bytes, "raw".into());

        assert_eq!(get_session_capture(session), Some((frames, CaptureKind::Frames)));
        assert_eq!(get_session_bytes_capture_id(session), Some(bytes));
    }
}
