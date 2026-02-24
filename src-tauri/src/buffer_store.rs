// ui/src-tauri/src/buffer_store.rs
//
// Multi-buffer registry for storing captured data.
// Metadata lives in RAM; bulk frame/byte data lives in SQLite (buffer_db).
// Supports multiple named buffers, each typed as either Frames or Bytes.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

use crate::buffer_db;
use crate::io::FrameMessage;

// ============================================================================
// Types
// ============================================================================

/// Buffer type - determines what kind of data the buffer contains
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BufferType {
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
pub struct BufferMetadata {
    /// Unique buffer ID (e.g., "buffer_1", "buffer_2")
    pub id: String,
    /// Buffer type (frames or bytes)
    pub buffer_type: BufferType,
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
}

// ============================================================================
// Internal Types
// ============================================================================

/// A named buffer — metadata only, data lives in SQLite.
struct NamedBuffer {
    metadata: BufferMetadata,
}

/// Buffer registry holding multiple named buffers
struct BufferRegistry {
    /// All buffers indexed by ID
    buffers: HashMap<String, NamedBuffer>,
    /// ID of the currently active buffer (for viewing/operating on)
    active_id: Option<String>,
    /// ID of the buffer currently being streamed to (separate from active_id)
    /// This is set during streaming and cleared on finalize
    streaming_id: Option<String>,
    /// Counter for generating unique buffer IDs
    next_id: u32,
    /// Last logged streaming_id for list_buffers (reduces log spam)
    last_logged_streaming_id: Option<String>,
    /// Last logged buffer count for list_buffers
    last_logged_buffer_count: usize,
}

impl Default for BufferRegistry {
    fn default() -> Self {
        Self {
            buffers: HashMap::new(),
            active_id: None,
            streaming_id: None,
            next_id: 1,
            last_logged_streaming_id: None,
            last_logged_buffer_count: 0,
        }
    }
}

/// Global buffer registry
static BUFFER_REGISTRY: Lazy<RwLock<BufferRegistry>> =
    Lazy::new(|| RwLock::new(BufferRegistry::default()));

// ============================================================================
// Public API - Buffer Creation & Management
// ============================================================================

/// Create a new buffer and set it as active for streaming.
/// Returns the buffer ID.
pub fn create_buffer(buffer_type: BufferType, name: String) -> String {
    create_buffer_internal(buffer_type, name, true)
}

/// Create a new buffer WITHOUT setting it as active.
/// Use this when creating derived buffers (e.g., framing results) that shouldn't
/// disrupt the current streaming buffer.
/// Returns the buffer ID.
pub fn create_buffer_inactive(buffer_type: BufferType, name: String) -> String {
    create_buffer_internal(buffer_type, name, false)
}

/// Internal helper to create a buffer with optional streaming activation.
fn create_buffer_internal(buffer_type: BufferType, name: String, set_streaming: bool) -> String {
    let mut registry = BUFFER_REGISTRY.write().unwrap();

    let id = format!("buf_{}", registry.next_id);
    registry.next_id += 1;

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let metadata = BufferMetadata {
        id: id.clone(),
        buffer_type: buffer_type.clone(),
        name: name.clone(),
        count: 0,
        start_time_us: None,
        end_time_us: None,
        created_at,
        is_streaming: false,
        owning_session_id: None,
    };

    let buffer = NamedBuffer { metadata };
    registry.buffers.insert(id.clone(), buffer);

    if set_streaming {
        registry.streaming_id = Some(id.clone());
        registry.active_id = Some(id.clone());
    }

    tlog!(
        "[BufferStore] Created buffer '{}' ({:?}) - '{}' [streaming={}]",
        id, buffer_type, name, set_streaming
    );

    id
}

/// Finalize the streaming buffer (stop streaming to it).
/// Clears streaming_id but leaves active_id unchanged (for viewing/operating).
/// Returns the buffer metadata if there was a streaming buffer.
pub fn finalize_buffer() -> Option<BufferMetadata> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();

    if let Some(id) = registry.streaming_id.take() {
        if let Some(buffer) = registry.buffers.get(&id) {
            tlog!(
                "[BufferStore] Finalized buffer '{}' with {} items",
                id, buffer.metadata.count
            );
            return Some(buffer.metadata.clone());
        }
    }
    None
}

/// List all buffers (returns metadata only, not data).
/// Sets is_streaming=true for the buffer currently being streamed to.
pub fn list_buffers() -> Vec<BufferMetadata> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();

    // Check if state changed since last log
    let streaming_id = registry.streaming_id.clone();
    let buffer_count = registry.buffers.len();
    let should_log = streaming_id != registry.last_logged_streaming_id
        || buffer_count != registry.last_logged_buffer_count;

    if should_log {
        tlog!(
            "[BufferStore] list_buffers - streaming_id: {:?}, buffers: {}",
            streaming_id.as_deref(),
            buffer_count
        );
        for b in registry.buffers.values() {
            let is_streaming = streaming_id.as_deref() == Some(b.metadata.id.as_str());
            tlog!(
                "[BufferStore]   buffer '{}' is_streaming: {}",
                b.metadata.id, is_streaming
            );
        }
        registry.last_logged_streaming_id = streaming_id.clone();
        registry.last_logged_buffer_count = buffer_count;
    }

    let result: Vec<BufferMetadata> = registry
        .buffers
        .values()
        .map(|b| {
            let mut meta = b.metadata.clone();
            meta.is_streaming = streaming_id.as_deref() == Some(meta.id.as_str());
            meta
        })
        .collect();
    result
}

/// Get metadata for a specific buffer.
/// Sets is_streaming=true if this buffer is being streamed to.
pub fn get_buffer_metadata(id: &str) -> Option<BufferMetadata> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    let streaming_id = registry.streaming_id.as_deref();
    registry.buffers.get(id).map(|b| {
        let mut meta = b.metadata.clone();
        meta.is_streaming = Some(meta.id.as_str()) == streaming_id;
        meta
    })
}

/// Delete a specific buffer.
/// If deleting the active/streaming buffer, clears those IDs.
pub fn delete_buffer(id: &str) -> Result<(), String> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();

    if registry.active_id.as_deref() == Some(id) {
        registry.active_id = None;
    }
    if registry.streaming_id.as_deref() == Some(id) {
        registry.streaming_id = None;
    }

    if registry.buffers.remove(id).is_some() {
        // Drop the registry lock before touching SQLite
        drop(registry);
        if let Err(e) = buffer_db::delete_buffer_data(id) {
            tlog!("[BufferStore] Failed to delete buffer data from SQLite: {}", e);
        }
        tlog!("[BufferStore] Deleted buffer '{}'", id);
        Ok(())
    } else {
        Err(format!("Buffer '{}' not found", id))
    }
}

/// Clear all buffers.
pub fn clear_all_buffers() {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    registry.buffers.clear();
    registry.active_id = None;
    registry.streaming_id = None;
    drop(registry);

    if let Err(e) = buffer_db::delete_all_data() {
        tlog!("[BufferStore] Failed to clear all buffer data from SQLite: {}", e);
    }
    tlog!("[BufferStore] Cleared all buffers");
}

/// Get the active buffer ID.
pub fn get_active_buffer_id() -> Option<String> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.active_id.clone()
}

/// Set a specific buffer as active.
/// Returns an error if the buffer doesn't exist.
pub fn set_active_buffer(buffer_id: &str) -> Result<(), String> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    if registry.buffers.contains_key(buffer_id) {
        registry.active_id = Some(buffer_id.to_string());
        tlog!("[BufferStore] Set active buffer: {}", buffer_id);
        Ok(())
    } else {
        Err(format!("Buffer '{}' not found", buffer_id))
    }
}

// ============================================================================
// Public API - Session Ownership
// ============================================================================

/// Assign a buffer to a session.
/// The buffer will only be accessible through this session until orphaned.
pub fn set_buffer_owner(buffer_id: &str, session_id: &str) -> Result<(), String> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
        buffer.metadata.owning_session_id = Some(session_id.to_string());
        tlog!(
            "[BufferStore] Assigned buffer '{}' to session '{}'",
            buffer_id, session_id
        );
        Ok(())
    } else {
        Err(format!("Buffer '{}' not found", buffer_id))
    }
}

/// Info about an orphaned buffer for event emission
#[derive(Clone, Debug, Serialize)]
pub struct OrphanedBufferInfo {
    pub buffer_id: String,
    pub buffer_name: String,
    pub buffer_type: BufferType,
    pub count: usize,
}

/// Orphan all buffers owned by a specific session.
/// Called when a session is destroyed or restarted.
/// Returns list of orphaned buffer info for event emission.
pub fn orphan_buffers_for_session(session_id: &str) -> Vec<OrphanedBufferInfo> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    let mut orphaned = Vec::new();

    for buffer in registry.buffers.values_mut() {
        if buffer.metadata.owning_session_id.as_deref() == Some(session_id) {
            buffer.metadata.owning_session_id = None;
            orphaned.push(OrphanedBufferInfo {
                buffer_id: buffer.metadata.id.clone(),
                buffer_name: buffer.metadata.name.clone(),
                buffer_type: buffer.metadata.buffer_type.clone(),
                count: buffer.metadata.count,
            });
        }
    }

    if !orphaned.is_empty() {
        tlog!(
            "[BufferStore] Orphaned {} buffer(s) for session '{}': {:?}",
            orphaned.len(),
            session_id,
            orphaned.iter().map(|o| &o.buffer_id).collect::<Vec<_>>()
        );
    }

    orphaned
}

/// Get the buffer ID owned by a session (if any).
pub fn get_buffer_for_session(session_id: &str) -> Option<String> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry
        .buffers
        .values()
        .find(|b| b.metadata.owning_session_id.as_deref() == Some(session_id))
        .map(|b| b.metadata.id.clone())
}

/// List only orphaned buffers (no owning session).
/// These are available for standalone selection.
pub fn list_orphaned_buffers() -> Vec<BufferMetadata> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    let streaming_id = registry.streaming_id.as_deref();

    registry
        .buffers
        .values()
        .filter(|b| b.metadata.owning_session_id.is_none())
        .map(|b| {
            let mut meta = b.metadata.clone();
            meta.is_streaming = Some(meta.id.as_str()) == streaming_id;
            meta
        })
        .collect()
}

/// Create a copy of a buffer for an app that is detaching.
/// The copy is orphaned (no owning session) and available for standalone use.
/// Returns the new buffer ID.
pub fn copy_buffer(source_buffer_id: &str, new_name: String) -> Result<String, String> {
    let source_metadata = {
        let registry = BUFFER_REGISTRY.read().unwrap();
        let source = registry
            .buffers
            .get(source_buffer_id)
            .ok_or_else(|| format!("Buffer '{}' not found", source_buffer_id))?;
        source.metadata.clone()
    };

    // Create new buffer entry in registry
    let id = {
        let mut registry = BUFFER_REGISTRY.write().unwrap();

        let id = format!("buf_{}", registry.next_id);
        registry.next_id += 1;

        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let metadata = BufferMetadata {
            id: id.clone(),
            buffer_type: source_metadata.buffer_type.clone(),
            name: new_name.clone(),
            count: source_metadata.count,
            start_time_us: source_metadata.start_time_us,
            end_time_us: source_metadata.end_time_us,
            created_at,
            is_streaming: false,
            owning_session_id: None,
        };

        let buffer = NamedBuffer { metadata };
        registry.buffers.insert(id.clone(), buffer);
        id
    };

    // Copy data in SQLite (INSERT INTO ... SELECT — no memory spike)
    let count = buffer_db::copy_buffer_data(source_buffer_id, &id)?;

    tlog!(
        "[BufferStore] Copied buffer '{}' -> '{}' ('{}', {} items)",
        source_buffer_id, id, new_name, count
    );

    Ok(id)
}

// ============================================================================
// Public API - Data Access (Frame Buffers)
// ============================================================================

/// Append frames to the active buffer.
/// Silently returns if there's no active buffer or it's not a frame buffer.
pub fn append_frames(new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() {
        return;
    }

    let active_id = {
        let mut registry = BUFFER_REGISTRY.write().unwrap();

        let active_id = match &registry.active_id {
            Some(id) => id.clone(),
            None => return,
        };

        if let Some(buffer) = registry.buffers.get_mut(&active_id) {
            if buffer.metadata.buffer_type != BufferType::Frames {
                return;
            }
            // Update metadata in RAM
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            }
            buffer.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);
            buffer.metadata.count += new_frames.len();
        } else {
            return;
        }

        active_id
        // Registry lock dropped here
    };

    // Insert into SQLite (separate lock)
    if let Err(e) = buffer_db::insert_frames(&active_id, &new_frames) {
        tlog!("[BufferStore] Failed to insert frames: {}", e);
    }
}

/// Append frames to a specific buffer by ID.
/// Silently returns if buffer doesn't exist or is not a frame buffer.
/// Only used by framing.rs which is desktop-only.
#[cfg(not(target_os = "ios"))]
pub fn append_frames_to_buffer(buffer_id: &str, new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() {
        return;
    }

    {
        let mut registry = BUFFER_REGISTRY.write().unwrap();

        if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
            if buffer.metadata.buffer_type != BufferType::Frames {
                return;
            }
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            }
            buffer.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);
            buffer.metadata.count += new_frames.len();
        } else {
            return;
        }
        // Registry lock dropped here
    }

    if let Err(e) = buffer_db::insert_frames(buffer_id, &new_frames) {
        tlog!("[BufferStore] Failed to insert frames to buffer '{}': {}", buffer_id, e);
    }
}

/// Clear a frame buffer and refill it with new frames.
/// Used during live framing to reuse the same buffer ID instead of creating new ones.
/// Silently returns if buffer doesn't exist or is not a frame buffer.
/// Only used by framing.rs which is desktop-only.
#[cfg(not(target_os = "ios"))]
pub fn clear_and_refill_buffer(buffer_id: &str, new_frames: Vec<FrameMessage>) {
    {
        let mut registry = BUFFER_REGISTRY.write().unwrap();

        if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
            if buffer.metadata.buffer_type != BufferType::Frames {
                return;
            }
            buffer.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            buffer.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);
            buffer.metadata.count = new_frames.len();
        } else {
            return;
        }
    }

    if let Err(e) = buffer_db::clear_and_refill(buffer_id, &new_frames) {
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
pub fn get_buffer_frames(id: &str) -> Option<Vec<FrameMessage>> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    let buffer = registry.buffers.get(id)?;
    if buffer.metadata.buffer_type != BufferType::Frames {
        return None;
    }
    drop(registry);

    buffer_db::get_all_frames(id).ok()
}

/// Get a page of frames from a specific buffer.
/// Returns (frames, buffer_indices, total_count).
pub fn get_buffer_frames_paginated(id: &str, offset: usize, limit: usize) -> (Vec<FrameMessage>, Vec<usize>, usize) {
    let total = {
        let registry = BUFFER_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
            Some(b) if b.metadata.buffer_type == BufferType::Frames => b.metadata.count,
            _ => return (Vec::new(), Vec::new(), 0),
        }
    };

    if offset >= total {
        return (Vec::new(), Vec::new(), total);
    }

    match buffer_db::get_frames_paginated(id, offset, limit) {
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
pub fn get_buffer_frames_paginated_filtered(
    id: &str,
    offset: usize,
    limit: usize,
    selected_ids: &std::collections::HashSet<u32>,
) -> (Vec<FrameMessage>, Vec<usize>, usize) {
    {
        let registry = BUFFER_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
            Some(b) if b.metadata.buffer_type == BufferType::Frames => {},
            _ => return (Vec::new(), Vec::new(), 0),
        }
    }

    if selected_ids.is_empty() {
        return get_buffer_frames_paginated(id, offset, limit);
    }

    let frame_ids: Vec<u32> = selected_ids.iter().copied().collect();
    match buffer_db::get_frames_paginated_filtered(id, offset, limit, &frame_ids) {
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
    /// 1-based original buffer position (rowid) for each frame, parallel to `frames`.
    pub buffer_indices: Vec<usize>,
    pub total_filtered_count: usize,
    pub buffer_end_time_us: Option<u64>,
}

/// Get the most recent N frames from a buffer, optionally filtered by frame IDs.
/// Returns the frames in chronological order (oldest first) for display.
pub fn get_buffer_frames_tail(
    id: &str,
    limit: usize,
    selected_ids: &std::collections::HashSet<u32>,
) -> TailResponse {
    {
        let registry = BUFFER_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
            Some(b) if b.metadata.buffer_type == BufferType::Frames => {},
            _ => return TailResponse {
                frames: Vec::new(),
                buffer_indices: Vec::new(),
                total_filtered_count: 0,
                buffer_end_time_us: None,
            },
        }
    }

    let frame_ids: Vec<u32> = selected_ids.iter().copied().collect();
    match buffer_db::get_frames_tail(id, limit, &frame_ids) {
        Ok((frames, rowids, total, end_time_us)) => {
            let indices = rowids.into_iter().map(|r| r as usize).collect();
            TailResponse {
                frames,
                buffer_indices: indices,
                total_filtered_count: total,
                buffer_end_time_us: end_time_us,
            }
        }
        Err(e) => {
            tlog!("[BufferStore] Failed to get tail frames: {}", e);
            TailResponse {
                frames: Vec::new(),
                buffer_indices: Vec::new(),
                total_filtered_count: 0,
                buffer_end_time_us: None,
            }
        }
    }
}

/// Frame info extracted from a buffer
#[derive(Clone, Debug, serde::Serialize)]
pub struct BufferFrameInfo {
    pub frame_id: u32,
    pub max_dlc: u8,
    pub bus: u8,
    pub is_extended: bool,
    pub has_dlc_mismatch: bool,
}

/// Get unique frame IDs and their metadata from a buffer.
pub fn get_buffer_frame_info(id: &str) -> Vec<BufferFrameInfo> {
    {
        let registry = BUFFER_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
            Some(b) if b.metadata.buffer_type == BufferType::Frames => {},
            _ => return Vec::new(),
        }
    }

    match buffer_db::get_frame_info(id) {
        Ok(info) => info,
        Err(e) => {
            tlog!("[BufferStore] Failed to get frame info: {}", e);
            Vec::new()
        }
    }
}

/// Find the offset for a given timestamp in a buffer.
pub fn find_buffer_offset_for_timestamp(
    id: &str,
    target_time_us: u64,
    selected_ids: &std::collections::HashSet<u32>,
) -> usize {
    {
        let registry = BUFFER_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
            Some(b) if b.metadata.buffer_type == BufferType::Frames => {},
            _ => return 0,
        }
    }

    let frame_ids: Vec<u32> = selected_ids.iter().copied().collect();
    match buffer_db::find_offset_for_timestamp(id, target_time_us, &frame_ids) {
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

/// Append raw bytes to the active buffer.
/// Silently returns if there's no active buffer or it's not a byte buffer.
pub fn append_raw_bytes(new_bytes: Vec<TimestampedByte>) {
    if new_bytes.is_empty() {
        return;
    }

    let active_id = {
        let mut registry = BUFFER_REGISTRY.write().unwrap();

        let active_id = match &registry.active_id {
            Some(id) => id.clone(),
            None => return,
        };

        if let Some(buffer) = registry.buffers.get_mut(&active_id) {
            if buffer.metadata.buffer_type != BufferType::Bytes {
                return;
            }
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_bytes.first().map(|b| b.timestamp_us);
            }
            buffer.metadata.end_time_us = new_bytes.last().map(|b| b.timestamp_us);
            buffer.metadata.count += new_bytes.len();
        } else {
            return;
        }

        active_id
    };

    if let Err(e) = buffer_db::insert_bytes(&active_id, &new_bytes) {
        tlog!("[BufferStore] Failed to insert bytes: {}", e);
    }
}

/// Append raw bytes to a specific buffer by ID.
/// Silently returns if buffer doesn't exist or is not a byte buffer.
pub fn append_raw_bytes_to_buffer(buffer_id: &str, new_bytes: Vec<TimestampedByte>) {
    if new_bytes.is_empty() {
        return;
    }

    {
        let mut registry = BUFFER_REGISTRY.write().unwrap();

        if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
            if buffer.metadata.buffer_type != BufferType::Bytes {
                return;
            }
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_bytes.first().map(|b| b.timestamp_us);
            }
            buffer.metadata.end_time_us = new_bytes.last().map(|b| b.timestamp_us);
            buffer.metadata.count += new_bytes.len();
        } else {
            return;
        }
    }

    if let Err(e) = buffer_db::insert_bytes(buffer_id, &new_bytes) {
        tlog!("[BufferStore] Failed to insert bytes to buffer '{}': {}", buffer_id, e);
    }
}

/// Get raw bytes from a specific buffer.
/// Returns None if buffer doesn't exist or is not a byte buffer.
pub fn get_buffer_bytes(id: &str) -> Option<Vec<TimestampedByte>> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    let buffer = registry.buffers.get(id)?;
    if buffer.metadata.buffer_type != BufferType::Bytes {
        return None;
    }
    drop(registry);

    buffer_db::get_all_bytes(id).ok()
}

/// Get a page of bytes from a specific buffer.
/// Returns (bytes, total_count).
pub fn get_buffer_bytes_paginated(id: &str, offset: usize, limit: usize) -> (Vec<TimestampedByte>, usize) {
    {
        let registry = BUFFER_REGISTRY.read().unwrap();
        match registry.buffers.get(id) {
            Some(b) if b.metadata.buffer_type == BufferType::Bytes => {},
            _ => return (Vec::new(), 0),
        }
    }

    match buffer_db::get_bytes_paginated(id, offset, limit) {
        Ok((bytes, total)) => (bytes, total),
        Err(e) => {
            tlog!("[BufferStore] Failed to get paginated bytes: {}", e);
            (Vec::new(), 0)
        }
    }
}

/// Find the byte offset for a given timestamp in the active byte buffer.
/// Returns the index of the first byte at or after the target timestamp.
pub fn find_buffer_bytes_offset_for_timestamp(target_time_us: u64) -> usize {
    let active_id = {
        let registry = BUFFER_REGISTRY.read().unwrap();
        match &registry.active_id {
            Some(id) => {
                match registry.buffers.get(id) {
                    Some(b) if b.metadata.buffer_type == BufferType::Bytes => id.clone(),
                    _ => return 0,
                }
            }
            None => return 0,
        }
    };

    match buffer_db::find_bytes_offset_for_timestamp(&active_id, target_time_us) {
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
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.buffers.values().any(|b| b.metadata.count > 0)
}

/// Get the count for a specific buffer.
pub fn get_buffer_count(id: &str) -> usize {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.buffers.get(id).map(|b| b.metadata.count).unwrap_or(0)
}

/// Get the type of a specific buffer.
pub fn get_buffer_type(id: &str) -> Option<BufferType> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.buffers.get(id).map(|b| b.metadata.buffer_type.clone())
}

// ============================================================================
// Backward Compatibility Layer
// ============================================================================

// These functions maintain backward compatibility with the old single-buffer API.
// They operate on the most recently created buffer or the first buffer found.

/// Find the ID of the active frame buffer, or fall back to the first frame buffer.
pub fn find_frame_buffer_id() -> Option<String> {
    let registry = BUFFER_REGISTRY.read().unwrap();

    // First try active buffer if it's a frame buffer
    if let Some(active_id) = &registry.active_id {
        if let Some(buffer) = registry.buffers.get(active_id) {
            if buffer.metadata.buffer_type == BufferType::Frames {
                return Some(active_id.clone());
            }
        }
    }

    // Fall back to first frame buffer
    registry.buffers.iter()
        .find(|(_, buffer)| buffer.metadata.buffer_type == BufferType::Frames)
        .map(|(id, _)| id.clone())
}

/// Get the first buffer's metadata (backward compat).
/// Sets is_streaming=true if this buffer is the active streaming buffer.
pub fn get_metadata() -> Option<BufferMetadata> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    let active_id = registry.active_id.as_deref();

    // First try active buffer
    if let Some(id) = &registry.active_id {
        if let Some(buffer) = registry.buffers.get(id) {
            let mut meta = buffer.metadata.clone();
            meta.is_streaming = true;
            return Some(meta);
        }
    }

    // Fall back to first buffer
    registry.buffers.values().next().map(|b| {
        let mut meta = b.metadata.clone();
        meta.is_streaming = Some(meta.id.as_str()) == active_id;
        meta
    })
}

/// Get all frames from the active buffer (or first frame buffer as fallback).
pub fn get_frames() -> Vec<FrameMessage> {
    let id = match find_frame_buffer_id() {
        Some(id) => id,
        None => return Vec::new(),
    };

    match buffer_db::get_all_frames(&id) {
        Ok(frames) => frames,
        Err(e) => {
            tlog!("[BufferStore] get_frames failed: {}", e);
            Vec::new()
        }
    }
}

/// Check if any buffer has frame data (backward compat).
pub fn has_data() -> bool {
    has_any_data()
}

/// Legacy clear_buffer (clears all buffers).
pub fn clear_buffer() -> Result<(), String> {
    clear_all_buffers();
    Ok(())
}

/// Get paginated frames from the active buffer (or first frame buffer as fallback).
pub fn get_frames_paginated(offset: usize, limit: usize) -> (Vec<FrameMessage>, Vec<usize>, usize) {
    match find_frame_buffer_id() {
        Some(id) => get_buffer_frames_paginated(&id, offset, limit),
        None => (Vec::new(), Vec::new(), 0),
    }
}

/// Get paginated filtered frames from the active buffer (or first frame buffer as fallback).
pub fn get_frames_paginated_filtered(
    offset: usize,
    limit: usize,
    selected_ids: &std::collections::HashSet<u32>,
) -> (Vec<FrameMessage>, Vec<usize>, usize) {
    match find_frame_buffer_id() {
        Some(id) => get_buffer_frames_paginated_filtered(&id, offset, limit, selected_ids),
        None => (Vec::new(), Vec::new(), 0),
    }
}

/// Get frame info from the active buffer (or first frame buffer as fallback).
pub fn get_frame_info_map() -> Vec<BufferFrameInfo> {
    match find_frame_buffer_id() {
        Some(id) => {
            tlog!("[BufferStore] get_frame_info_map using buffer '{}'", id);
            get_buffer_frame_info(&id)
        }
        None => Vec::new(),
    }
}

/// Find offset for timestamp from the active buffer (or first frame buffer as fallback).
pub fn find_offset_for_timestamp(
    target_time_us: u64,
    selected_ids: &std::collections::HashSet<u32>,
) -> usize {
    match find_frame_buffer_id() {
        Some(id) => find_buffer_offset_for_timestamp(&id, target_time_us, selected_ids),
        None => 0,
    }
}

/// Legacy set_buffer (imports frames, creates new buffer).
pub fn set_buffer(frames: Vec<FrameMessage>, filename: String) {
    let id = create_buffer(BufferType::Frames, filename);
    append_frames(frames);
    finalize_buffer();
    tlog!("[BufferStore] Imported frames into buffer '{}'", id);
}
