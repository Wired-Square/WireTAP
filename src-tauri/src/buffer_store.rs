// ui/src-tauri/src/buffer_store.rs
//
// Multi-buffer registry for storing captured data.
// Supports multiple named buffers, each typed as either Frames or Bytes.
// Replaces the previous single global buffer design.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

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

/// Individual buffer storage - either frames or bytes
enum BufferData {
    Frames(Vec<FrameMessage>),
    Bytes(Vec<TimestampedByte>),
}

/// A named buffer with metadata and data
struct NamedBuffer {
    metadata: BufferMetadata,
    data: BufferData,
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

    let id = format!("buffer_{}", registry.next_id);
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
        is_streaming: false, // Will be set to true when streaming_id matches
        owning_session_id: None, // Will be set when assigned to a session
    };

    let data = match buffer_type {
        BufferType::Frames => BufferData::Frames(Vec::new()),
        BufferType::Bytes => BufferData::Bytes(Vec::new()),
    };

    let buffer = NamedBuffer { metadata, data };
    registry.buffers.insert(id.clone(), buffer);

    if set_streaming {
        // Set both streaming_id (for is_streaming flag) and active_id (for append operations)
        registry.streaming_id = Some(id.clone());
        registry.active_id = Some(id.clone());
    }

    eprintln!(
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
            eprintln!(
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

    // Only log when state changes
    if should_log {
        eprintln!(
            "[BufferStore] list_buffers - streaming_id: {:?}, buffers: {}",
            streaming_id.as_deref(),
            buffer_count
        );
        for b in registry.buffers.values() {
            let is_streaming = streaming_id.as_deref() == Some(b.metadata.id.as_str());
            eprintln!(
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

    // If deleting the active buffer, clear the active_id
    if registry.active_id.as_deref() == Some(id) {
        registry.active_id = None;
    }
    // If deleting the streaming buffer, clear the streaming_id
    if registry.streaming_id.as_deref() == Some(id) {
        registry.streaming_id = None;
    }

    if registry.buffers.remove(id).is_some() {
        eprintln!("[BufferStore] Deleted buffer '{}'", id);
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
    eprintln!("[BufferStore] Cleared all buffers");
}

/// Check if there's an active buffer.
pub fn has_active_buffer() -> bool {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.active_id.is_some()
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
        eprintln!("[BufferStore] Set active buffer: {}", buffer_id);
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
        eprintln!(
            "[BufferStore] Assigned buffer '{}' to session '{}'",
            buffer_id, session_id
        );
        Ok(())
    } else {
        Err(format!("Buffer '{}' not found", buffer_id))
    }
}

/// Orphan a buffer (remove session ownership).
/// The buffer becomes available for standalone use.
pub fn orphan_buffer(buffer_id: &str) -> Result<(), String> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
        let old_owner = buffer.metadata.owning_session_id.take();
        eprintln!(
            "[BufferStore] Orphaned buffer '{}' (was owned by {:?})",
            buffer_id, old_owner
        );
        Ok(())
    } else {
        Err(format!("Buffer '{}' not found", buffer_id))
    }
}

/// Orphan all buffers owned by a specific session.
/// Called when a session is destroyed.
pub fn orphan_buffers_for_session(session_id: &str) {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    let mut orphaned_count = 0;

    for buffer in registry.buffers.values_mut() {
        if buffer.metadata.owning_session_id.as_deref() == Some(session_id) {
            buffer.metadata.owning_session_id = None;
            orphaned_count += 1;
        }
    }

    if orphaned_count > 0 {
        eprintln!(
            "[BufferStore] Orphaned {} buffer(s) for destroyed session '{}'",
            orphaned_count, session_id
        );
    }
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
    // First, read the source buffer data
    let (source_type, cloned_data, source_metadata) = {
        let registry = BUFFER_REGISTRY.read().unwrap();
        let source = registry
            .buffers
            .get(source_buffer_id)
            .ok_or_else(|| format!("Buffer '{}' not found", source_buffer_id))?;

        let cloned = match &source.data {
            BufferData::Frames(frames) => BufferData::Frames(frames.clone()),
            BufferData::Bytes(bytes) => BufferData::Bytes(bytes.clone()),
        };

        (source.metadata.buffer_type.clone(), cloned, source.metadata.clone())
    };

    // Now create the new buffer with write lock
    let mut registry = BUFFER_REGISTRY.write().unwrap();

    let id = format!("buffer_{}", registry.next_id);
    registry.next_id += 1;

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let count = match &cloned_data {
        BufferData::Frames(f) => f.len(),
        BufferData::Bytes(b) => b.len(),
    };

    let metadata = BufferMetadata {
        id: id.clone(),
        buffer_type: source_type,
        name: new_name.clone(),
        count,
        start_time_us: source_metadata.start_time_us,
        end_time_us: source_metadata.end_time_us,
        created_at,
        is_streaming: false,
        owning_session_id: None, // Orphaned - available for standalone use
    };

    let buffer = NamedBuffer {
        metadata,
        data: cloned_data,
    };
    registry.buffers.insert(id.clone(), buffer);

    eprintln!(
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

    let mut registry = BUFFER_REGISTRY.write().unwrap();

    let active_id = match &registry.active_id {
        Some(id) => id.clone(),
        None => return,
    };

    if let Some(buffer) = registry.buffers.get_mut(&active_id) {
        if let BufferData::Frames(ref mut frames) = buffer.data {
            // Update time range
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            }
            buffer.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);

            frames.extend(new_frames);
            buffer.metadata.count = frames.len();
        }
    }
}

/// Append frames to a specific buffer by ID.
/// Silently returns if buffer doesn't exist or is not a frame buffer.
pub fn append_frames_to_buffer(buffer_id: &str, new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() {
        return;
    }

    let mut registry = BUFFER_REGISTRY.write().unwrap();

    if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
        if let BufferData::Frames(ref mut frames) = buffer.data {
            // Update time range
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            }
            buffer.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);

            frames.extend(new_frames);
            buffer.metadata.count = frames.len();
        }
    }
}

/// Clear a frame buffer and refill it with new frames.
/// Used during live framing to reuse the same buffer ID instead of creating new ones.
/// Silently returns if buffer doesn't exist or is not a frame buffer.
pub fn clear_and_refill_buffer(buffer_id: &str, new_frames: Vec<FrameMessage>) {
    let mut registry = BUFFER_REGISTRY.write().unwrap();

    if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
        if let BufferData::Frames(ref mut frames) = buffer.data {
            // Clear existing frames
            frames.clear();

            // Update metadata
            buffer.metadata.start_time_us = new_frames.first().map(|f| f.timestamp_us);
            buffer.metadata.end_time_us = new_frames.last().map(|f| f.timestamp_us);
            buffer.metadata.count = new_frames.len();

            // Add new frames
            frames.extend(new_frames);

            eprintln!(
                "[BufferStore] Refilled buffer '{}' with {} frames",
                buffer_id, buffer.metadata.count
            );
        }
    }
}

/// Get frames from a specific buffer.
/// Returns None if buffer doesn't exist or is not a frame buffer.
pub fn get_buffer_frames(id: &str) -> Option<Vec<FrameMessage>> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.buffers.get(id).and_then(|b| match &b.data {
        BufferData::Frames(frames) => Some(frames.clone()),
        BufferData::Bytes(_) => None,
    })
}

/// Get a page of frames from a specific buffer.
/// Returns (frames, total_count).
pub fn get_buffer_frames_paginated(id: &str, offset: usize, limit: usize) -> (Vec<FrameMessage>, usize) {
    let registry = BUFFER_REGISTRY.read().unwrap();

    if let Some(buffer) = registry.buffers.get(id) {
        if let BufferData::Frames(frames) = &buffer.data {
            let total = frames.len();
            if offset >= total {
                return (Vec::new(), total);
            }
            let end = std::cmp::min(offset + limit, total);
            return (frames[offset..end].to_vec(), total);
        }
    }

    (Vec::new(), 0)
}

/// Get a page of frames filtered by selected IDs.
pub fn get_buffer_frames_paginated_filtered(
    id: &str,
    offset: usize,
    limit: usize,
    selected_ids: &std::collections::HashSet<u32>,
) -> (Vec<FrameMessage>, usize) {
    let registry = BUFFER_REGISTRY.read().unwrap();

    if let Some(buffer) = registry.buffers.get(id) {
        if let BufferData::Frames(frames) = &buffer.data {
            // If no selection filter, return all frames
            if selected_ids.is_empty() {
                let total = frames.len();
                if offset >= total {
                    return (Vec::new(), total);
                }
                let end = std::cmp::min(offset + limit, total);
                return (frames[offset..end].to_vec(), total);
            }

            // Filter frames by selected IDs
            let filtered: Vec<&FrameMessage> = frames
                .iter()
                .filter(|f| selected_ids.contains(&f.frame_id))
                .collect();

            let total = filtered.len();
            if offset >= total {
                return (Vec::new(), total);
            }

            let end = std::cmp::min(offset + limit, total);
            let result = filtered[offset..end].iter().map(|f| (*f).clone()).collect();
            return (result, total);
        }
    }

    (Vec::new(), 0)
}

/// Response from tail fetch operation
#[derive(Clone, Debug, serde::Serialize)]
pub struct TailResponse {
    pub frames: Vec<FrameMessage>,
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
    let registry = BUFFER_REGISTRY.read().unwrap();

    if let Some(buffer) = registry.buffers.get(id) {
        if let BufferData::Frames(frames) = &buffer.data {
            let buffer_end_time_us = buffer.metadata.end_time_us;

            // If no selection filter, return last N frames directly
            if selected_ids.is_empty() {
                let total = frames.len();
                let start = total.saturating_sub(limit);
                let result = frames[start..].to_vec();
                return TailResponse {
                    frames: result,
                    total_filtered_count: total,
                    buffer_end_time_us,
                };
            }

            // Filter frames by selected IDs, then take last N
            // For efficiency, iterate backwards and collect up to limit matches
            let mut result: Vec<FrameMessage> = Vec::with_capacity(limit);
            let mut total_filtered = 0usize;

            for frame in frames.iter().rev() {
                if selected_ids.contains(&frame.frame_id) {
                    total_filtered += 1;
                    if result.len() < limit {
                        result.push(frame.clone());
                    }
                }
            }

            // We collected in reverse order, so reverse to get chronological order
            result.reverse();

            // Count remaining filtered frames we didn't collect
            // (We already counted all matching frames in total_filtered)

            return TailResponse {
                frames: result,
                total_filtered_count: total_filtered,
                buffer_end_time_us,
            };
        }
    }

    TailResponse {
        frames: Vec::new(),
        total_filtered_count: 0,
        buffer_end_time_us: None,
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
    let registry = BUFFER_REGISTRY.read().unwrap();

    if let Some(buffer) = registry.buffers.get(id) {
        if let BufferData::Frames(frames) = &buffer.data {
            let mut info_map: HashMap<u32, (u8, u8, bool, bool)> = HashMap::new();

            for frame in frames {
                let entry = info_map.entry(frame.frame_id).or_insert((
                    frame.dlc,
                    frame.bus,
                    frame.is_extended,
                    false,
                ));

                if frame.dlc != entry.0 {
                    entry.3 = true; // has_dlc_mismatch
                    if frame.dlc > entry.0 {
                        entry.0 = frame.dlc;
                    }
                }
            }

            return info_map
                .into_iter()
                .map(|(frame_id, (max_dlc, bus, is_extended, has_dlc_mismatch))| BufferFrameInfo {
                    frame_id,
                    max_dlc,
                    bus,
                    is_extended,
                    has_dlc_mismatch,
                })
                .collect();
        }
    }

    Vec::new()
}

/// Find the offset for a given timestamp in a buffer.
pub fn find_buffer_offset_for_timestamp(
    id: &str,
    target_time_us: u64,
    selected_ids: &std::collections::HashSet<u32>,
) -> usize {
    let registry = BUFFER_REGISTRY.read().unwrap();

    if let Some(buffer) = registry.buffers.get(id) {
        if let BufferData::Frames(frames) = &buffer.data {
            if selected_ids.is_empty() {
                return frames.partition_point(|f| f.timestamp_us < target_time_us);
            }

            let approx_idx = frames.partition_point(|f| f.timestamp_us < target_time_us);
            return frames[..approx_idx]
                .iter()
                .filter(|f| selected_ids.contains(&f.frame_id))
                .count();
        }
    }

    0
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

    let mut registry = BUFFER_REGISTRY.write().unwrap();

    let active_id = match &registry.active_id {
        Some(id) => id.clone(),
        None => return,
    };

    if let Some(buffer) = registry.buffers.get_mut(&active_id) {
        if let BufferData::Bytes(ref mut bytes) = buffer.data {
            // Update time range
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_bytes.first().map(|b| b.timestamp_us);
            }
            buffer.metadata.end_time_us = new_bytes.last().map(|b| b.timestamp_us);

            bytes.extend(new_bytes);
            buffer.metadata.count = bytes.len();
        }
    }
}

/// Append raw bytes to a specific buffer by ID.
/// Silently returns if buffer doesn't exist or is not a byte buffer.
pub fn append_raw_bytes_to_buffer(buffer_id: &str, new_bytes: Vec<TimestampedByte>) {
    if new_bytes.is_empty() {
        return;
    }

    let mut registry = BUFFER_REGISTRY.write().unwrap();

    if let Some(buffer) = registry.buffers.get_mut(buffer_id) {
        if let BufferData::Bytes(ref mut bytes) = buffer.data {
            // Update time range
            if buffer.metadata.start_time_us.is_none() {
                buffer.metadata.start_time_us = new_bytes.first().map(|b| b.timestamp_us);
            }
            buffer.metadata.end_time_us = new_bytes.last().map(|b| b.timestamp_us);

            bytes.extend(new_bytes);
            buffer.metadata.count = bytes.len();
        }
    }
}

/// Get raw bytes from a specific buffer.
/// Returns None if buffer doesn't exist or is not a byte buffer.
pub fn get_buffer_bytes(id: &str) -> Option<Vec<TimestampedByte>> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.buffers.get(id).and_then(|b| match &b.data {
        BufferData::Bytes(bytes) => Some(bytes.clone()),
        BufferData::Frames(_) => None,
    })
}

/// Get a page of bytes from a specific buffer.
/// Returns (bytes, total_count).
pub fn get_buffer_bytes_paginated(id: &str, offset: usize, limit: usize) -> (Vec<TimestampedByte>, usize) {
    let registry = BUFFER_REGISTRY.read().unwrap();

    if let Some(buffer) = registry.buffers.get(id) {
        if let BufferData::Bytes(bytes) = &buffer.data {
            let total = bytes.len();
            if offset >= total {
                return (Vec::new(), total);
            }
            let end = std::cmp::min(offset + limit, total);
            return (bytes[offset..end].to_vec(), total);
        }
    }

    (Vec::new(), 0)
}

/// Find the byte offset for a given timestamp in the active byte buffer.
/// Uses binary search for O(log n) performance.
/// Returns the index of the first byte at or after the target timestamp.
pub fn find_buffer_bytes_offset_for_timestamp(target_time_us: u64) -> usize {
    let registry = BUFFER_REGISTRY.read().unwrap();

    // Get active buffer
    let active_id = match &registry.active_id {
        Some(id) => id,
        None => return 0,
    };

    if let Some(buffer) = registry.buffers.get(active_id) {
        if let BufferData::Bytes(bytes) = &buffer.data {
            // Binary search for target timestamp
            return bytes.partition_point(|b| b.timestamp_us < target_time_us);
        }
    }

    0
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

/// Get the first buffer's metadata (backward compat).
/// Sets is_streaming=true if this buffer is the active streaming buffer.
pub fn get_metadata() -> Option<BufferMetadata> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    let active_id = registry.active_id.as_deref();

    // First try active buffer
    if let Some(id) = &registry.active_id {
        if let Some(buffer) = registry.buffers.get(id) {
            let mut meta = buffer.metadata.clone();
            meta.is_streaming = true; // This IS the active buffer
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
    let registry = BUFFER_REGISTRY.read().unwrap();

    // First try active buffer if it's a frame buffer
    if let Some(active_id) = &registry.active_id {
        if let Some(buffer) = registry.buffers.get(active_id) {
            if let BufferData::Frames(frames) = &buffer.data {
                return frames.clone();
            }
        }
    }

    // Fall back to first frame buffer
    for buffer in registry.buffers.values() {
        if let BufferData::Frames(frames) = &buffer.data {
            return frames.clone();
        }
    }

    Vec::new()
}

/// Get all frames from a specific buffer by ID.
/// Falls back to get_frames() if buffer not found or not a frame buffer.
pub fn get_frames_by_id(buffer_id: &str) -> Vec<FrameMessage> {
    let registry = BUFFER_REGISTRY.read().unwrap();

    if let Some(buffer) = registry.buffers.get(buffer_id) {
        if let BufferData::Frames(frames) = &buffer.data {
            eprintln!("[BufferStore] get_frames_by_id('{}') returning {} frames", buffer_id, frames.len());
            return frames.clone();
        }
    }

    eprintln!("[BufferStore] get_frames_by_id('{}') buffer not found, falling back to get_frames()", buffer_id);
    drop(registry);
    get_frames()
}

/// Check if any buffer has frame data (backward compat).
pub fn has_data() -> bool {
    has_any_data()
}

/// Legacy clear_buffer (clears all buffers).
/// Now always succeeds - the previous check for active_id prevented clearing
/// after loading a buffer for framing, which was too restrictive.
pub fn clear_buffer() -> Result<(), String> {
    clear_all_buffers();
    Ok(())
}

/// Legacy is_streaming check.
pub fn is_streaming() -> bool {
    has_active_buffer()
}

/// Get paginated frames from the active buffer (or first frame buffer as fallback).
pub fn get_frames_paginated(offset: usize, limit: usize) -> (Vec<FrameMessage>, usize) {
    let buffer_id = {
        let registry = BUFFER_REGISTRY.read().unwrap();

        // First try active buffer if it's a frame buffer
        if let Some(active_id) = &registry.active_id {
            if let Some(buffer) = registry.buffers.get(active_id) {
                if matches!(&buffer.data, BufferData::Frames(_)) {
                    return get_buffer_frames_paginated(active_id, offset, limit);
                }
            }
        }

        // Fall back to first frame buffer
        registry.buffers.iter()
            .find(|(_, buffer)| matches!(&buffer.data, BufferData::Frames(_)))
            .map(|(id, _)| id.clone())
    };

    if let Some(id) = buffer_id {
        get_buffer_frames_paginated(&id, offset, limit)
    } else {
        (Vec::new(), 0)
    }
}

/// Get paginated filtered frames from the active buffer (or first frame buffer as fallback).
pub fn get_frames_paginated_filtered(
    offset: usize,
    limit: usize,
    selected_ids: &std::collections::HashSet<u32>,
) -> (Vec<FrameMessage>, usize) {
    let buffer_id = {
        let registry = BUFFER_REGISTRY.read().unwrap();

        // First try active buffer if it's a frame buffer
        if let Some(active_id) = &registry.active_id {
            if let Some(buffer) = registry.buffers.get(active_id) {
                if matches!(&buffer.data, BufferData::Frames(_)) {
                    return get_buffer_frames_paginated_filtered(active_id, offset, limit, selected_ids);
                }
            }
        }

        // Fall back to first frame buffer
        registry.buffers.iter()
            .find(|(_, buffer)| matches!(&buffer.data, BufferData::Frames(_)))
            .map(|(id, _)| id.clone())
    };

    if let Some(id) = buffer_id {
        get_buffer_frames_paginated_filtered(&id, offset, limit, selected_ids)
    } else {
        (Vec::new(), 0)
    }
}

/// Get frame info from the active buffer (or first frame buffer as fallback).
pub fn get_frame_info_map() -> Vec<BufferFrameInfo> {
    let buffer_id = {
        let registry = BUFFER_REGISTRY.read().unwrap();

        // First try active buffer if it's a frame buffer
        if let Some(active_id) = &registry.active_id {
            if let Some(buffer) = registry.buffers.get(active_id) {
                if matches!(&buffer.data, BufferData::Frames(_)) {
                    eprintln!("[BufferStore] get_frame_info_map using active buffer '{}'", active_id);
                    return get_buffer_frame_info(active_id);
                }
            }
        }

        // Fall back to first frame buffer
        registry.buffers.iter()
            .find(|(_, buffer)| matches!(&buffer.data, BufferData::Frames(_)))
            .map(|(id, _)| id.clone())
    };

    if let Some(id) = buffer_id {
        eprintln!("[BufferStore] get_frame_info_map using fallback buffer '{}'", id);
        get_buffer_frame_info(&id)
    } else {
        Vec::new()
    }
}

/// Find offset for timestamp from the active buffer (or first frame buffer as fallback).
pub fn find_offset_for_timestamp(
    target_time_us: u64,
    selected_ids: &std::collections::HashSet<u32>,
) -> usize {
    let buffer_id = {
        let registry = BUFFER_REGISTRY.read().unwrap();

        // First try active buffer if it's a frame buffer
        if let Some(active_id) = &registry.active_id {
            if let Some(buffer) = registry.buffers.get(active_id) {
                if matches!(&buffer.data, BufferData::Frames(_)) {
                    return find_buffer_offset_for_timestamp(active_id, target_time_us, selected_ids);
                }
            }
        }

        // Fall back to first frame buffer
        registry.buffers.iter()
            .find(|(_, buffer)| matches!(&buffer.data, BufferData::Frames(_)))
            .map(|(id, _)| id.clone())
    };

    if let Some(id) = buffer_id {
        find_buffer_offset_for_timestamp(&id, target_time_us, selected_ids)
    } else {
        0
    }
}

/// Legacy set_buffer (imports frames, creates new buffer).
pub fn set_buffer(frames: Vec<FrameMessage>, filename: String) {
    let id = create_buffer(BufferType::Frames, filename);
    append_frames(frames);
    finalize_buffer();
    eprintln!("[BufferStore] Imported frames into buffer '{}'", id);
}
