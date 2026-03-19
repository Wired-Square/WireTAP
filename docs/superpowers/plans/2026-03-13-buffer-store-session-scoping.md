# Buffer Store Session Scoping Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate global singleton state (`streaming_id`, `active_id`) in the BufferStore, replacing it with session-scoped operations so concurrent sessions cannot contaminate each other's buffers.

**Architecture:** The BufferStore's `BufferRegistry` switches from single `Option<String>` fields to `HashSet<String>` sets for both streaming and active tracking. All public buffer operations become session-scoped — callers pass `session_id` and the BufferStore resolves to the correct buffer(s) internally. The `_to_buffer` functions become internal implementation details. Legacy fallback functions are removed entirely.

**Tech Stack:** Rust (Tauri backend), TypeScript (React frontend), SQLite (buffer persistence via buffer_db)

**Spec:** `docs/superpowers/specs/2026-03-13-buffer-store-session-scoping-design.md`

---

## Chunk 1: BufferRegistry Core — New API (Additive)

Add the new session-scoped API alongside the existing functions so the codebase compiles at every step. No callers are migrated yet — this chunk is purely additive.

### Task 1: Change BufferRegistry struct

**Files:**
- Modify: `src-tauri/src/buffer_store.rs:89-113`

- [ ] **Step 1: Replace `streaming_id` and `active_id` with HashSets**

Replace the `BufferRegistry` struct fields:

```rust
struct BufferRegistry {
    buffers: HashMap<String, NamedBuffer>,
    /// Buffer IDs currently receiving streaming data
    streaming_ids: HashSet<String>,
    /// Buffer IDs currently being rendered by UI panels
    active_ids: HashSet<String>,
    /// Last logged streaming state for list_buffers (reduces log spam)
    last_logged_streaming_ids: Option<HashSet<String>>,
    last_logged_buffer_count: usize,
}
```

Update `Default` impl:
```rust
impl Default for BufferRegistry {
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
```

- [ ] **Step 2: Update `create_buffer_internal` to use `streaming_ids`**

In `create_buffer_internal` (line ~178), replace:
```rust
// OLD
registry.streaming_id = Some(id.clone());
registry.active_id = Some(id.clone());
```
with:
```rust
// NEW — only add to streaming set, never touch active_ids
registry.streaming_ids.insert(id.clone());
```

Note: `create_buffer()` no longer sets `active_ids`. The UI is responsible for calling `mark_buffer_active` when it starts rendering a buffer.

- [ ] **Step 3: Update old `finalize_buffer()` to use `streaming_ids` temporarily**

Keep the no-arg `finalize_buffer()` working during migration by changing it to pop from `streaming_ids`:

```rust
pub fn finalize_buffer() -> Option<BufferMetadata> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    // Take first streaming buffer (temporary bridge — callers will migrate to finalize_session_buffers)
    let id = registry.streaming_ids.iter().next().cloned();
    if let Some(id) = id {
        registry.streaming_ids.remove(&id);
        if let Some(buffer) = registry.buffers.get(&id) {
            let meta = buffer.metadata.clone();
            tlog!("[BufferStore] Finalized buffer '{}' with {} items", id, meta.count);
            drop(registry);
            if let Err(e) = buffer_db::save_buffer_metadata(&meta) {
                tlog!("[BufferStore] Failed to persist finalized buffer metadata: {}", e);
            }
            return Some(meta);
        }
    }
    None
}
```

- [ ] **Step 4: Update `is_streaming` computation and logging throughout**

Update `list_buffers`, `get_buffer_metadata`, `list_orphaned_buffers`, `get_metadata` — everywhere `streaming_id` was compared, use `streaming_ids.contains(&id)`:

```rust
// OLD
meta.is_streaming = streaming_id.as_deref() == Some(meta.id.as_str());
// NEW
meta.is_streaming = registry.streaming_ids.contains(&meta.id);
```

Rewrite the `list_buffers` logging/spam-reduction section (lines ~260-280). The old code uses `Option<String>` comparisons and `.as_deref()` which won't compile against `Option<HashSet<String>>`:

```rust
// NEW logging section in list_buffers:
let current_streaming = registry.streaming_ids.clone();
let buffer_count = registry.buffers.len();
let should_log = Some(&current_streaming) != registry.last_logged_streaming_ids.as_ref()
    || buffer_count != registry.last_logged_buffer_count;

if should_log {
    tlog!(
        "[BufferStore] list_buffers - streaming: {:?}, buffers: {}",
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
```

- [ ] **Step 5: Update old `get_active_buffer_id()` to use `active_ids` temporarily**

Bridge during migration — return first active ID:
```rust
pub fn get_active_buffer_id() -> Option<String> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.active_ids.iter().next().cloned()
}
```

- [ ] **Step 6: Update old `set_active_buffer()` to use `active_ids` temporarily**

```rust
pub fn set_active_buffer(buffer_id: &str) -> Result<(), String> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    if registry.buffers.contains_key(buffer_id) {
        registry.active_ids.insert(buffer_id.to_string());
        tlog!("[BufferStore] Set active buffer: {}", buffer_id);
        Ok(())
    } else {
        Err(format!("Buffer '{}' not found", buffer_id))
    }
}
```

- [ ] **Step 7: Update `delete_buffer` to clean up both sets**

```rust
// In delete_buffer, replace:
// OLD
if registry.active_id.as_deref() == Some(id) { registry.active_id = None; }
if registry.streaming_id.as_deref() == Some(id) { registry.streaming_id = None; }
// NEW
registry.active_ids.remove(id);
registry.streaming_ids.remove(id);
```

- [ ] **Step 8: Update `append_frames()` to use `streaming_ids` temporarily**

Bridge: write to first streaming frame buffer (preserves current behaviour during migration — `create_buffer` now populates `streaming_ids` instead of `active_id`):
```rust
pub fn append_frames(new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() { return; }
    let buffer_id = {
        let registry = BUFFER_REGISTRY.read().unwrap();
        // Find first streaming frame buffer
        registry.streaming_ids.iter()
            .find(|id| registry.buffers.get(*id)
                .map(|b| b.metadata.buffer_type == BufferType::Frames)
                .unwrap_or(false))
            .cloned()
    };
    if let Some(id) = buffer_id {
        append_frames_to_buffer(&id, new_frames);
    }
}
```

Do the same for `append_raw_bytes()` (find first streaming `Bytes` buffer).

- [ ] **Step 9: Build and verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors. All existing callers still use the old API through the bridge functions.

- [ ] **Step 10: Commit**

```
feat(buffer_store): replace singleton streaming_id/active_id with HashSets

Bridge functions preserve existing caller behaviour during migration.
```

### Task 2: Add session-scoped API functions

**Files:**
- Modify: `src-tauri/src/buffer_store.rs`

- [ ] **Step 1: Add `get_session_buffer_ids`**

```rust
/// Get all buffer IDs owned by a session (frames + bytes).
pub fn get_session_buffer_ids(session_id: &str) -> Vec<String> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry
        .buffers
        .values()
        .filter(|b| b.metadata.owning_session_id.as_deref() == Some(session_id))
        .map(|b| b.metadata.id.clone())
        .collect()
}
```

- [ ] **Step 2: Add `append_frames_to_session`**

```rust
/// Append frames to this session's frame buffer.
/// Resolves the buffer by finding the buffer owned by session_id with
/// buffer_type == Frames. No-op if session has no frame buffer.
pub fn append_frames_to_session(session_id: &str, new_frames: Vec<FrameMessage>) {
    if new_frames.is_empty() { return; }
    let buffer_id = {
        let registry = BUFFER_REGISTRY.read().unwrap();
        registry.buffers.values()
            .find(|b| b.metadata.owning_session_id.as_deref() == Some(session_id)
                    && b.metadata.buffer_type == BufferType::Frames)
            .map(|b| b.metadata.id.clone())
    };
    if let Some(id) = buffer_id {
        append_frames_to_buffer(&id, new_frames);
    }
}
```

- [ ] **Step 3: Add `append_raw_bytes_to_session`**

Same pattern as above but for `BufferType::Bytes`, delegating to `append_raw_bytes_to_buffer`.

- [ ] **Step 4: Add `finalize_session_buffers`**

```rust
/// Finalize all streaming buffers owned by this session.
/// Removes them from streaming_ids, persists final metadata.
pub fn finalize_session_buffers(session_id: &str) -> Vec<BufferMetadata> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();

    // Collect owned streaming buffer IDs — extract streaming_ids ref first
    // to avoid double-borrow through the write guard
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
        if let Err(e) = buffer_db::save_buffer_metadata(meta) {
            tlog!("[BufferStore] Failed to persist finalized buffer metadata: {}", e);
        }
    }

    finalized
}
```

- [ ] **Step 5: Add `finalize_buffer` (explicit buffer_id variant)**

```rust
/// Finalize a specific buffer by ID. Removes from streaming_ids.
fn finalize_buffer_by_id(buffer_id: &str) -> Option<BufferMetadata> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    registry.streaming_ids.remove(buffer_id);
    if let Some(buffer) = registry.buffers.get(buffer_id) {
        let meta = buffer.metadata.clone();
        tlog!("[BufferStore] Finalized buffer '{}' with {} items", buffer_id, meta.count);
        drop(registry);
        if let Err(e) = buffer_db::save_buffer_metadata(&meta) {
            tlog!("[BufferStore] Failed to persist finalized buffer metadata: {}", e);
        }
        return Some(meta);
    }
    None
}
```

- [ ] **Step 6: Add active buffer tracking functions**

```rust
/// Mark a buffer as being rendered by a UI panel.
pub fn mark_buffer_active(buffer_id: &str) -> Result<(), String> {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    if registry.buffers.contains_key(buffer_id) {
        registry.active_ids.insert(buffer_id.to_string());
        tlog!("[BufferStore] Marked buffer active: {}", buffer_id);
        Ok(())
    } else {
        Err(format!("Buffer '{}' not found", buffer_id))
    }
}

/// Mark a buffer as no longer being rendered.
pub fn mark_buffer_inactive(buffer_id: &str) {
    let mut registry = BUFFER_REGISTRY.write().unwrap();
    registry.active_ids.remove(buffer_id);
    tlog!("[BufferStore] Marked buffer inactive: {}", buffer_id);
}

/// Check if a buffer is currently being rendered.
pub fn is_buffer_active(buffer_id: &str) -> bool {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.active_ids.contains(buffer_id)
}

/// Get all buffer IDs currently being rendered.
pub fn get_active_buffer_ids() -> Vec<String> {
    let registry = BUFFER_REGISTRY.read().unwrap();
    registry.active_ids.iter().cloned().collect()
}
```

- [ ] **Step 7: Build and verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles. New functions exist alongside old ones.

- [ ] **Step 8: Commit**

```
feat(buffer_store): add session-scoped API functions

append_frames_to_session, append_raw_bytes_to_session,
finalize_session_buffers, get_session_buffer_ids,
mark_buffer_active/inactive, is_buffer_active, get_active_buffer_ids.
```

---

## Chunk 2: Migrate Session Readers

Migrate all IO device readers from the global `append_frames()` / `append_raw_bytes()` to the session-scoped variants. Each reader already has `session_id` in scope.

### Task 3: Migrate multi_source/merge.rs

**Files:**
- Modify: `src-tauri/src/io/multi_source/merge.rs:235,245,262,272`

- [ ] **Step 1: Replace `append_frames` calls with `append_frames_to_session`**

Line 235 and 262: `buffer_store::append_frames(...)` → `buffer_store::append_frames_to_session(&session_id, ...)`

- [ ] **Step 2: Replace `append_raw_bytes` fallback with `append_raw_bytes_to_session`**

Line 245 and 272: The fallback path `buffer_store::append_raw_bytes(...)` → `buffer_store::append_raw_bytes_to_session(&session_id, ...)`

Note: The `append_raw_bytes_to_buffer` calls (lines 243, 270) that use `bytes_buffer_id` should also switch to `append_raw_bytes_to_session` since the buffer is session-owned.

- [ ] **Step 3: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 4: Commit**

```
refactor(multi_source): use session-scoped buffer append
```

### Task 4: Migrate gs_usb/nusb_driver.rs

**Files:**
- Modify: `src-tauri/src/io/gs_usb/nusb_driver.rs:781,808`

- [ ] **Step 1: Replace `append_frames` calls**

Both sites: `buffer_store::append_frames(...)` → `buffer_store::append_frames_to_session(&session_id, ...)`

- [ ] **Step 2: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 3: Commit**

```
refactor(gs_usb): use session-scoped buffer append
```

### Task 5: Migrate virtual_device/mod.rs

**Files:**
- Modify: `src-tauri/src/io/virtual_device/mod.rs:528,557,580,593,642,656`

- [ ] **Step 1: Replace all `append_frames` calls (lines 528, 557, 580, 642)**

All: `buffer_store::append_frames(...)` → `buffer_store::append_frames_to_session(&session_id, ...)`

- [ ] **Step 2: Replace `append_raw_bytes` calls (lines 593, 656)**

Both: `buffer_store::append_raw_bytes(...)` → `buffer_store::append_raw_bytes_to_session(&session_id, ...)`

- [ ] **Step 3: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 4: Commit**

```
refactor(virtual_device): use session-scoped buffer append
```

### Task 6: Migrate remaining readers (mqtt, modbus_tcp, postgres)

**Files:**
- Modify: `src-tauri/src/io/mqtt/reader.rs:313`
- Modify: `src-tauri/src/io/modbus_tcp/reader.rs:346`
- Modify: `src-tauri/src/io/timeline/postgres.rs:512,572,597,618,635`

- [ ] **Step 1: mqtt — replace `append_frames` (line 313)**

`buffer_store::append_frames(...)` → `buffer_store::append_frames_to_session(&session_id, ...)`

- [ ] **Step 2: modbus_tcp — replace `append_frames` (line 346)**

Same replacement.

- [ ] **Step 3: postgres — replace all 5 `append_frames` calls**

Lines 512, 572, 597, 618, 635: all → `buffer_store::append_frames_to_session(&session_id, ...)`

- [ ] **Step 4: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 5: Commit**

```
refactor(mqtt,modbus,postgres): use session-scoped buffer append
```

### Task 7: Migrate `emit_stream_ended`

**Files:**
- Modify: `src-tauri/src/io/mod.rs:1253-1301`

- [ ] **Step 1: Replace `finalize_buffer()` with `finalize_session_buffers(session_id)`**

```rust
pub fn emit_stream_ended(
    app_handle: &AppHandle,
    session_id: &str,
    reason: &str,
    log_prefix: &str,
) {
    use crate::buffer_store::{self, BufferType};

    let finalized = buffer_store::finalize_session_buffers(session_id);
    // Use the frame buffer metadata for the payload (primary), fall back to first finalized
    let metadata = finalized.iter()
        .find(|m| m.buffer_type == BufferType::Frames)
        .or(finalized.first());

    let (buffer_id, buffer_type, count, time_range, buffer_available) = match metadata {
        Some(m) => {
            let type_str = match m.buffer_type {
                BufferType::Frames => "frames",
                BufferType::Bytes => "bytes",
            };
            (
                Some(m.id.clone()),
                Some(type_str.to_string()),
                m.count,
                match (m.start_time_us, m.end_time_us) {
                    (Some(start), Some(end)) => Some((start, end)),
                    _ => None,
                },
                m.count > 0,
            )
        }
        None => (None, None, 0, None, false),
    };

    // ... rest unchanged (emit_to_session call)
}
```

- [ ] **Step 2: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 3: Commit**

```
refactor(io): emit_stream_ended uses finalize_session_buffers
```

---

## Chunk 3: Migrate Session Lifecycle (io/mod.rs)

### Task 8: Migrate `stop_and_switch_to_buffer` and `suspend_session`

**Files:**
- Modify: `src-tauri/src/io/mod.rs:1993-2053` (`suspend_session`)
- Modify: `src-tauri/src/io/mod.rs:2146-2260` (`stop_and_switch_to_buffer`)

- [ ] **Step 1: Update `suspend_session` to use `get_session_buffer_ids`**

Replace `buffer_store::get_buffer_for_session(session_id)` with:
```rust
let buffer_ids = buffer_store::get_session_buffer_ids(session_id);
let metadata = buffer_ids.iter()
    .filter_map(|id| buffer_store::get_buffer_metadata(id))
    .find(|m| m.buffer_type == buffer_store::BufferType::Frames);
```

- [ ] **Step 2: Update `stop_and_switch_to_buffer` and `switch_to_buffer_replay` to use session-scoped API**

Replace `get_buffer_for_session` with `get_session_buffer_ids`. Replace `set_active_buffer` with `mark_buffer_active` at **both** sites:
- `stop_and_switch_to_buffer` (line 2183)
- `switch_to_buffer_replay` (line 2583)

```rust
let buffer_ids = buffer_store::get_session_buffer_ids(session_id);
let metadata = buffer_ids.iter()
    .filter_map(|id| buffer_store::get_buffer_metadata(id))
    .find(|m| m.buffer_type == buffer_store::BufferType::Frames);

// ... extract buffer info ...

if let Some(ref bid) = buffer_id {
    let _ = buffer_store::mark_buffer_active(bid);
    // ... rest of switch logic unchanged ...
}
```

- [ ] **Step 3: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 4: Commit**

```
refactor(io): stop_and_switch/suspend use session-scoped buffer API
```

### Task 9: Migrate `emit_state_change`, `join_session`, `register_listener`

**Files:**
- Modify: `src-tauri/src/io/mod.rs:737-747` (`emit_state_change`)
- Modify: `src-tauri/src/io/mod.rs:1595-1623` (`join_session`)
- Modify: `src-tauri/src/io/mod.rs:2900-2918` (`register_listener`)

- [ ] **Step 1: Update `emit_state_change` to resolve buffer via session**

```rust
fn emit_state_change(app: &AppHandle, session_id: &str, previous: &IOState, current: &IOState) {
    use crate::buffer_store;

    let buffer_id = buffer_store::get_session_buffer_ids(session_id)
        .into_iter()
        .find(|id| buffer_store::get_buffer_metadata(id)
            .map(|m| m.buffer_type == buffer_store::BufferType::Frames)
            .unwrap_or(false));

    let payload = StateChangePayload {
        previous: state_to_string(previous),
        current: state_to_string(current),
        buffer_id,
    };
    emit_to_session(app, "session-state", session_id, payload);
}
```

- [ ] **Step 2: Update `join_session` to use `get_session_buffer_ids`**

Replace `crate::buffer_store::get_active_buffer_id()` at line 1605 with:
```rust
let buffer_ids = crate::buffer_store::get_session_buffer_ids(session_id);
// Return the frame buffer specifically (primary buffer for the session)
let (buffer_id, buffer_type) = buffer_ids.iter()
    .filter_map(|id| crate::buffer_store::get_buffer_metadata(id))
    .find(|m| m.buffer_type == crate::buffer_store::BufferType::Frames)
    .map(|m| (Some(m.id), Some("frames".to_string())))
    .unwrap_or((None, None));
```

- [ ] **Step 3: Update `register_listener` — same pattern as `join_session`**

Replace `get_active_buffer_id()` at line 2909 with the same session-scoped lookup.

- [ ] **Step 4: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 5: Commit**

```
refactor(io): state_change/join/register use session-scoped buffer lookup
```

---

## Chunk 4: Migrate BufferReader and Timeline

### Task 10: Remove `BufferReader::new()`, update `resolve_buffer_id`, `step_frame`

**Files:**
- Modify: `src-tauri/src/io/timeline/buffer.rs:43-86,214-222,309-315,522`
- Modify: `src-tauri/src/sessions.rs:1124-1136,1166-1178`

- [ ] **Step 1: Make `BufferReader::new_with_buffer` the only constructor**

Remove `BufferReader::new()` (lines 43-66). Rename `new_with_buffer` to `new`:
```rust
pub fn new(app: AppHandle, session_id: String, buffer_id: String, speed: f64) -> Self {
    let buses = buffer_store::get_buffer_metadata(&buffer_id)
        .map(|m| m.buses)
        .unwrap_or_default();
    Self {
        app,
        reader_state: TimelineReaderState::new(session_id, speed),
        seek_target_us: Arc::new(AtomicI64::new(NO_SEEK)),
        seek_target_frame: Arc::new(AtomicI64::new(NO_SEEK_FRAME)),
        completed_flag: Arc::new(AtomicBool::new(false)),
        buffer_id: Some(buffer_id),
        buses,
    }
}
```

- [ ] **Step 2: Update `sessions.rs` callers to require `buffer_id`**

In `create_buffer_reader_session` (line ~1124) and `transition_to_buffer_reader` (line ~1166), remove the `None` fallback path. Make `buffer_id` a required `String` parameter (not `Option<String>`):

```rust
// Both callers become:
let reader = BufferReader::new(
    app.clone(),
    session_id.clone(),
    buffer_id,
    speed.unwrap_or(1.0),
);
```

Update the Tauri command signatures: `buffer_id: Option<String>` → `buffer_id: String`.

- [ ] **Step 3: Remove `resolve_buffer_id` fallback**

In `resolve_buffer_id` (line 309), remove the `find_frame_buffer_id()` fallback. The `buffer_id` field on `BufferReader` is always `Some` now, so this function can be simplified or inlined.

- [ ] **Step 4: Update `step_frame` to accept explicit `buffer_id`**

Add `buffer_id: &str` parameter to `step_frame` in `io/timeline/buffer.rs:214`. Replace `find_frame_buffer_id()` with the passed parameter.

Update the Tauri command wrapper `step_buffer_frame` in `sessions.rs:1283-1292` to accept `buffer_id: String` and pass it through:
```rust
pub async fn step_buffer_frame(
    app: tauri::AppHandle,
    session_id: String,
    buffer_id: String,
    current_frame_index: Option<usize>,
    current_timestamp_us: Option<i64>,
    backward: bool,
    filter_frame_ids: Option<Vec<u32>>,
) -> Result<Option<StepResult>, String> {
    step_frame(&app, &session_id, &buffer_id, current_frame_index, current_timestamp_us, backward, filter_frame_ids.as_deref())
}
```

- [ ] **Step 5: Update `run_buffer_stream` logging (line 522)**

Replace `buffer_store::get_metadata()` with `buffer_store::get_buffer_metadata(&buf_id)`.

- [ ] **Step 6: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 7: Commit**

```
refactor(buffer_reader): require explicit buffer_id, remove fallback constructors
```

---

## Chunk 5: Migrate Import Commands

### Task 11: Add `ensure_session` helper and migrate import Tauri commands

**Files:**
- Modify: `src-tauri/src/buffers.rs:67,111,135-230,430-447`
- Modify: `src-tauri/src/buffer_store.rs:1272-1277` (delete `set_buffer`)
- Modify: `src-tauri/src/framing.rs:164-175`
- Modify: `src-tauri/src/io/mod.rs` (add `ensure_session` or equivalent)

- [ ] **Step 1: Add `ensure_session` helper**

In `io/mod.rs` or `sessions.rs`, add a function that creates a session if one doesn't exist:
```rust
/// Ensure a session exists. If the session_id doesn't correspond to an
/// existing session, create a minimal BufferReader session for it.
pub async fn ensure_session(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let sessions = IO_SESSIONS.lock().await;
    if sessions.contains_key(session_id) {
        return Ok(());
    }
    drop(sessions);
    // Create a stopped session — it will be populated by the import
    // The caller creates the buffer and assigns ownership
    // ... create session with a placeholder device
    Ok(())
}
```

The exact implementation depends on the session creation API. Read `create_session` in `io/mod.rs` to determine the minimal device needed. A stopped `BufferReader` with no buffer is likely simplest.

- [ ] **Step 2: Migrate `import_csv_to_buffer` and `import_csv_with_mapping`**

Add `session_id: String` parameter to both Tauri commands. Replace `buffer_store::set_buffer(frames, filename)` with:
```rust
let buffer_id = buffer_store::create_buffer(buffer_store::BufferType::Frames, filename);
buffer_store::set_buffer_owner(&buffer_id, &session_id);
buffer_store::append_frames_to_session(&session_id, frames);
buffer_store::finalize_session_buffers(&session_id);
```

- [ ] **Step 3: Delete `set_buffer` from `buffer_store.rs`**

Remove the `set_buffer` function at line 1272.

- [ ] **Step 4: Migrate `import_csv_batch_with_mapping`**

Add `session_id: String` parameter. Replace `append_frames(result.frames)` (line 214) with `append_frames_to_session(&session_id, result.frames)`. Replace `finalize_buffer()` (line 230) with `finalize_session_buffers(&session_id)`. Add `set_buffer_owner` after `create_buffer`.

- [ ] **Step 5: Migrate `create_frame_buffer_from_frames`**

Add `session_id: String` parameter. Same pattern: create buffer, set owner, append via session, finalize via session.

- [ ] **Step 6: Migrate `apply_framing_to_buffer`**

Add `session_id: String` parameter. Replace `get_active_buffer_id()` with session buffer lookup:
```rust
let byte_buffer_id = buffer_store::get_session_buffer_ids(&session_id)
    .into_iter()
    .find(|id| buffer_store::get_buffer_metadata(id)
        .map(|m| m.buffer_type == buffer_store::BufferType::Bytes)
        .unwrap_or(false))
    .ok_or_else(|| "No byte buffer found for session".to_string())?;
```

Assign derived frame buffer ownership to the same session:
```rust
buffer_store::set_buffer_owner(&frame_buffer_id, &session_id);
```

- [ ] **Step 7: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 8: Commit**

```
refactor(imports): all import commands accept session_id, buffers always session-owned
```

---

## Chunk 6: Migrate Remaining `buffers.rs` Tauri Commands and Remove Legacy Functions

### Task 12: Migrate `buffers.rs` read commands

**Files:**
- Modify: `src-tauri/src/buffers.rs:297,303,347,424,476,491,520`

- [ ] **Step 1: Update commands that use `get_active_buffer_id()`**

Lines 347, 476, 491: These Tauri commands need a `buffer_id: String` parameter instead of calling `get_active_buffer_id()`. Check if the frontend already passes `buffer_id` — if not, add it.

- [ ] **Step 2: Update `set_active_buffer` call (line 424)**

Replace `buffer_store::set_active_buffer(id)` with `buffer_store::mark_buffer_active(id)`.

- [ ] **Step 3: Update `get_metadata()` callers (lines 297)**

Replace with `buffer_store::get_buffer_metadata(&buffer_id)` — add `buffer_id` parameter to the Tauri command.

- [ ] **Step 4: Update `get_frames()` caller (line 303)**

Replace with `buffer_store::get_buffer_frames(&buffer_id)` with explicit ID.

- [ ] **Step 5: Update `find_buffer_bytes_offset_for_timestamp()` caller (line 520)**

Add `buffer_id` parameter, pass to explicit variant.

- [ ] **Step 6: Build and verify**

Run: `cd src-tauri && cargo check`

- [ ] **Step 7: Commit**

```
refactor(buffers): all Tauri commands use explicit buffer_id
```

### Task 13: Remove all legacy functions from `buffer_store.rs`

**Files:**
- Modify: `src-tauri/src/buffer_store.rs`

- [ ] **Step 1: Remove global-implicit functions**

Delete these functions (they should have no remaining callers):
- `append_frames()` (the no-arg global version)
- `append_raw_bytes()` (the no-arg global version)
- `finalize_buffer()` (the no-arg version)
- `get_active_buffer_id()`
- `set_active_buffer()`
- `get_buffer_for_session()`
- `find_frame_buffer_id()`
- `get_metadata()`
- `get_frames()`
- `find_buffer_bytes_offset_for_timestamp()` (the no-arg version)
- `set_buffer()` (if not already deleted)
- `find_offset_for_timestamp()` (uses `find_frame_buffer_id` internally)

- [ ] **Step 2: Make `append_frames_to_buffer` and `append_raw_bytes_to_buffer` non-public**

Change `pub fn` → `fn` (or `pub(crate) fn` if needed by `framing.rs`).

- [ ] **Step 3: Build and verify**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors. If any caller was missed, the compiler will tell us.

- [ ] **Step 4: Commit**

```
refactor(buffer_store): remove all legacy global-implicit functions

append_frames, append_raw_bytes, finalize_buffer (no-arg),
get_active_buffer_id, set_active_buffer, get_buffer_for_session,
find_frame_buffer_id, get_metadata, get_frames, set_buffer.

All callers now use session-scoped or explicit buffer ID API.
```

---

## Chunk 7: Frontend Changes

### Task 14: Update TypeScript API wrappers

**Files:**
- Modify: `src/api/buffer.ts`
- Modify: `src/api/io.ts`

- [ ] **Step 1: Add `sessionId` to import API functions**

```typescript
// buffer.ts
export async function importCsvToBuffer(sessionId: string, filePath: string): Promise<BufferMetadata> {
  return invoke("import_csv_to_buffer", { session_id: sessionId, file_path: filePath });
}

export async function importCsvWithMapping(
  sessionId: string,
  filePath: string,
  mappings: CsvColumnMapping[],
  // ... rest unchanged
): Promise<CsvImportResult> {
  return invoke("import_csv_with_mapping", { session_id: sessionId, file_path: filePath, /* ... */ });
}

export async function importCsvBatchWithMapping(
  sessionId: string,
  // ... rest unchanged
): Promise<CsvImportResult> {
  return invoke("import_csv_batch_with_mapping", { session_id: sessionId, /* ... */ });
}

export async function createFrameBufferFromFrames(
  sessionId: string,
  name: string,
  frames: BufferFrame[]
): Promise<BufferMetadata> {
  return invoke("create_frame_buffer_from_frames", { session_id: sessionId, name, frames });
}
```

- [ ] **Step 2: Add `sessionId` to `applyFramingToBuffer`**

```typescript
export async function applyFramingToBuffer(
  sessionId: string,
  config: BackendFramingConfig,
  reuseBufferId?: string
): Promise<FramingResult> {
  return invoke("apply_framing_to_buffer", { session_id: sessionId, config, reuse_buffer_id: reuseBufferId });
}
```

- [ ] **Step 3: Make `bufferId` required in `createBufferReaderSession` / `transitionToBufferReader`**

Update `createBufferReaderSession` in `api/buffer.ts` to require `bufferId: string` (not optional). Same for `transitionToBufferReader`.

- [ ] **Step 4: Build and check for type errors**

Run: `cd /path/to/WireTAP && npx tsc --noEmit`
Expected: Type errors at call sites that don't pass `sessionId` yet.

- [ ] **Step 5: Commit**

```
refactor(api): add sessionId to all buffer import API functions
```

### Task 15: Update frontend callers

**Files:**
- Modify: `src/dialogs/csv-column-mapper/CsvColumnMapperDialog.tsx`
- Modify: `src/stores/discoveryStore.ts`
- Modify: `src/stores/discoverySerialStore.ts`

- [ ] **Step 1: Thread `sessionId` through `CsvColumnMapperDialog`**

The dialog needs a `sessionId` prop. Trace the call chain:
- `IoSourcePickerDialog` opens `CsvColumnMapperDialog`
- `IoSourcePickerDialog` is opened from app handler hooks that have `sessionId` in scope
- Add `sessionId: string` to `CsvColumnMapperDialogProps`
- Pass it through from `IoSourcePickerDialog` (which needs it from its parent)
- Use it in the `importCsvWithMapping` / `importCsvBatchWithMapping` calls

- [ ] **Step 2: Thread `sessionId` through `discoveryStore.acceptFraming`**

The `acceptFraming` method calls `createFrameBufferFromFrames`. The Discovery app has a session ID available via `useIOSessionManager`. Pass `sessionId` as a parameter to `acceptFraming`.

- [ ] **Step 3: Thread `sessionId` through `discoverySerialStore.applyFraming`**

The `applyFraming` method calls `applyFramingToBuffer`. Thread `sessionId` from the Discovery app's session context.

- [ ] **Step 4: Build and verify frontend compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 5: Commit**

```
refactor(frontend): thread sessionId through import dialogs and stores
```

### Task 16: Full build and manual smoke test

- [ ] **Step 1: Full Tauri build**

Run: `npm run tauri build`
Expected: Builds successfully.

- [ ] **Step 2: Manual smoke test — single session**

1. Start a single CAN session (e.g., Innomaker)
2. Verify frames appear in discovery
3. Stop session — verify buffer is finalized correctly in logs
4. Verify buffer replay works

- [ ] **Step 3: Manual smoke test — concurrent sessions**

1. Start session A (e.g., Innomaker CAN)
2. Start session B (e.g., FrameLink)
3. Verify each session's frames go to separate buffers (check log: `[BufferStore] Created buffer 'xxx' ... 'session_id'`)
4. Stop session A — verify only A's buffer is finalized, B continues streaming
5. Stop session B — verify B's buffer is finalized
6. Verify both buffers contain the correct frame counts

- [ ] **Step 4: Manual smoke test — CSV import**

1. Import a CSV file
2. Verify a session is created for it
3. Verify the buffer is owned by that session

- [ ] **Step 5: Commit any fixes found during testing**
