# Buffer Store Session Scoping

## Problem

`BufferRegistry` uses global singletons (`streaming_id: Option<String>`, `active_id: Option<String>`) to track which buffer receives data and which buffer the UI displays. When multiple sessions run concurrently, the second session's `create_buffer()` overwrites both globals, causing:

1. **Cross-session data contamination** — `append_frames()` writes to `active_id` (global), so all concurrent sessions' frames go to whichever buffer was created last.
2. **Wrong buffer finalized on stop** — `finalize_buffer()` consumes `streaming_id` (global), so stopping session A finalizes session B's buffer.
3. **UI hijacking** — creating a streaming buffer sets `active_id`, stealing the viewed buffer from the user.

### Observed behaviour (from logs)

- `am0ijn` created for session `f_c60f07`, `budv94` created for session `f_edfb4c`
- All frames routed to `budv94` (the last-created buffer)
- Stopping `f_c60f07` finalized `budv94` (wrong session's buffer)
- Pattern repeats for every subsequent session transition

## Design

### Principle

**All buffers belong to sessions.** The session is the primary interface — all code interacts with the BufferStore through session IDs, never by manipulating buffer IDs directly. The BufferStore resolves session to buffer(s) internally. There are no "non-session" buffer operations — even imports create or reuse a session.

### Changes to `BufferRegistry`

```rust
struct BufferRegistry {
    buffers: HashMap<String, NamedBuffer>,
    // REMOVED: streaming_id: Option<String>
    // REMOVED: active_id: Option<String>
    streaming_ids: HashSet<String>,   // buffer IDs currently receiving data
    active_ids: HashSet<String>,      // buffer IDs currently being rendered by UI panels
    // logging fields unchanged
}
```

### New session-scoped API

These are the primary API for session readers. Readers only need their `session_id`.

#### Data writes

```rust
/// Append frames to this session's frame buffer.
/// Resolves the buffer by finding the buffer owned by session_id with
/// buffer_type == Frames. A session has at most one frame buffer and
/// at most one byte buffer — never two of the same type.
/// No-op if session has no frame buffer.
pub fn append_frames_to_session(session_id: &str, frames: Vec<FrameMessage>)

/// Append raw bytes to this session's byte buffer.
/// Resolves the buffer by finding the buffer owned by session_id with
/// buffer_type == Bytes. Same one-per-type invariant.
/// No-op if session has no byte buffer.
pub fn append_raw_bytes_to_session(session_id: &str, bytes: Vec<TimestampedByte>)
```

**Lookup algorithm:** Both functions iterate `buffers` in the registry, find the entry where `owning_session_id == Some(session_id)` AND `buffer_type` matches (Frames or Bytes respectively). A session has at most one buffer of each type — this is enforced by the creation pattern in multi_source (one `create_buffer` for frames, one for bytes).

#### Lifecycle

```rust
/// Finalize all streaming buffers owned by this session.
/// Removes them from streaming_ids, persists final metadata.
/// Returns metadata for all finalized buffers.
pub fn finalize_session_buffers(session_id: &str) -> Vec<BufferMetadata>
```

#### Queries

```rust
/// Get all buffer IDs owned by a session (frames + bytes).
/// Returns empty vec if session has no buffers.
pub fn get_session_buffer_ids(session_id: &str) -> Vec<String>
```

### Internal buffer-level functions

The existing `append_frames_to_buffer`, `append_raw_bytes_to_buffer`, and `finalize_buffer(buffer_id)` remain as **internal implementation details** — used by the session-scoped API to do the actual work after resolving session to buffer. They are not part of the public API.

```rust
/// Internal — called by append_frames_to_session after resolving session → buffer
fn append_frames_to_buffer(buffer_id: &str, frames: Vec<FrameMessage>)
fn append_raw_bytes_to_buffer(buffer_id: &str, bytes: Vec<TimestampedByte>)
fn finalize_buffer(buffer_id: &str) -> Option<BufferMetadata>
```

### Active buffer tracking (UI rendering)

```rust
/// Mark a buffer as being rendered by a UI panel.
pub fn mark_buffer_active(buffer_id: &str) -> Result<(), String>

/// Mark a buffer as no longer being rendered.
pub fn mark_buffer_inactive(buffer_id: &str)

/// Check if a buffer is currently being rendered.
pub fn is_buffer_active(buffer_id: &str) -> bool

/// Get all buffer IDs currently being rendered.
pub fn get_active_buffer_ids() -> Vec<String>
```

### Removed functions

All global-implicit functions are removed. No deprecation shims — clean break.

| Removed | Replacement | Reason |
|---------|-------------|--------|
| `append_frames()` | `append_frames_to_session()` | Session-scoped write |
| `append_raw_bytes()` | `append_raw_bytes_to_session()` | Session-scoped write |
| `finalize_buffer()` (no args) | `finalize_session_buffers(session_id)` | Session-scoped finalize |
| `get_active_buffer_id()` | `get_active_buffer_ids()` or caller passes explicit ID | No singleton |
| `set_active_buffer(id)` | `mark_buffer_active(id)` / `mark_buffer_inactive(id)` | Set-based tracking |
| `get_buffer_for_session(session_id)` | `get_session_buffer_ids(session_id)` | Returns all buffers, not just first found |
| `find_frame_buffer_id()` | Callers pass explicit buffer ID | No fallback guessing |
| `get_metadata()` | `get_buffer_metadata(id)` (already exists) | Explicit target |
| `get_frames()` | `get_buffer_frames(id)` (already exists) | Explicit target |
| `find_buffer_bytes_offset_for_timestamp()` | Takes explicit `buffer_id` parameter | Explicit target |
| `set_buffer()` (legacy) | Callers migrated to session-scoped import commands | Remove indirection |
| `append_frames_to_buffer()` (public) | Internal only — called by `append_frames_to_session` | No direct external use |
| `append_raw_bytes_to_buffer()` (public) | Internal only — called by `append_raw_bytes_to_session` | No direct external use |

### `create_buffer()` changes

`create_buffer()` no longer sets `active_id` or `streaming_id` as side effects. Instead:

```rust
/// Create a new buffer and add it to streaming_ids.
/// Does NOT modify active_ids — that is the UI's responsibility.
/// Caller must still call set_buffer_owner() to assign session ownership.
pub fn create_buffer(buffer_type: BufferType, name: String) -> String
```

- Inserts into `streaming_ids` (the buffer will receive data)
- Does NOT touch `active_ids` (creating a streaming buffer should not hijack the user's view)
- `create_buffer_inactive()` unchanged — doesn't add to `streaming_ids`

### `is_streaming` field on `BufferMetadata`

Computed dynamically from `streaming_ids.contains(&id)` — same as today but using the HashSet instead of comparing against a single `streaming_id`.

### Caller migration

#### Session readers (multi_source, gs_usb, mqtt, modbus_tcp, postgres, virtual_device)

Before:
```rust
let buffer_id = buffer_store::create_buffer(BufferType::Frames, session_id.clone());
buffer_store::set_buffer_owner(&buffer_id, &session_id);
// ... in streaming loop:
buffer_store::append_frames(frames.clone());
```

After:
```rust
let buffer_id = buffer_store::create_buffer(BufferType::Frames, session_id.clone());
buffer_store::set_buffer_owner(&buffer_id, &session_id);
// ... in streaming loop:
buffer_store::append_frames_to_session(&session_id, frames.clone());
```

The reader no longer needs to hold `buffer_id` for the append path — it flows through the session.

#### `emit_stream_ended()` in `io/mod.rs:1253`

Before:
```rust
let metadata = buffer_store::finalize_buffer();
```

After:
```rust
let finalized = buffer_store::finalize_session_buffers(session_id);
// stream-ended payload reports all finalized buffers (frames and/or bytes)
```

**Timing note:** `emit_stream_ended` is called by device readers during `device.stop()`. In the `stop_and_switch_to_buffer` path, `device.stop()` at line 2157 triggers `emit_stream_ended` which calls `finalize_session_buffers`. By the time `get_session_buffer_ids` is called afterwards, all the session's buffers are already finalized and removed from `streaming_ids`. Callers must not call `finalize_session_buffers` again in the switch path — the finalization has already happened.

#### Import commands (CSV, frame buffer creation)

All import operations become session-scoped. The Tauri command accepts a `session_id` parameter — if no session exists yet, one is created transparently. This keeps the user-facing flow unchanged while ensuring all buffers are session-owned from creation.

**`import_csv_to_buffer` (`buffers.rs:67`) and `import_csv_with_mapping` (`buffers.rs:111`):**
Currently call legacy `set_buffer()`. Add `session_id: String` parameter to both Tauri commands. The backend creates a session (if needed), creates a buffer owned by that session, imports frames, and finalizes:
```rust
// Ensure session exists (create if needed)
let session_id = ensure_session(app, session_id).await;
let buffer_id = buffer_store::create_buffer(BufferType::Frames, filename);
buffer_store::set_buffer_owner(&buffer_id, &session_id);
buffer_store::append_frames_to_session(&session_id, frames);
buffer_store::finalize_session_buffers(&session_id);
```
The `set_buffer` function is deleted.

**`import_csv_batch_with_mapping` (`buffers.rs:135`):**
Currently uses global `append_frames()` at line 214 and no-arg `finalize_buffer()` at line 230. Add `session_id: String` parameter. Same pattern:
```rust
let session_id = ensure_session(app, session_id).await;
let buffer_id = buffer_store::create_buffer(BufferType::Frames, name);
buffer_store::set_buffer_owner(&buffer_id, &session_id);
// ... loop:
buffer_store::append_frames_to_session(&session_id, result.frames);
// ... after loop:
buffer_store::finalize_session_buffers(&session_id);
```

**`create_frame_buffer_from_frames` (`buffers.rs:430`):**
Currently uses global `append_frames()` at line 442 and no-arg `finalize_buffer()` at line 445. Add `session_id: String` parameter:
```rust
let session_id = ensure_session(app, session_id).await;
let buffer_id = buffer_store::create_buffer(BufferType::Frames, name);
buffer_store::set_buffer_owner(&buffer_id, &session_id);
buffer_store::append_frames_to_session(&session_id, frames);
buffer_store::finalize_session_buffers(&session_id);
```

**`apply_framing_to_buffer` (`framing.rs:164`):**
Currently uses `get_active_buffer_id()` to find the source byte buffer. Add `session_id: String` parameter. The derived frame buffer belongs to the same session that owns the source byte buffer:
```rust
// Look up session's byte buffer
let byte_buffer_id = buffer_store::get_session_buffer_ids(&session_id)
    .into_iter()
    .find(|id| /* buffer_type == Bytes */);
// Create derived frame buffer, also owned by session
let frame_buffer_id = buffer_store::create_buffer_inactive(BufferType::Frames, ...);
buffer_store::set_buffer_owner(&frame_buffer_id, &session_id);
```

#### `stop_and_switch_to_buffer()` in `io/mod.rs`

Before:
```rust
session.device.stop().await?;  // triggers finalize via emit_stream_ended
let metadata = buffer_store::get_buffer_for_session(session_id)...;
buffer_store::set_active_buffer(bid);
```

After:
```rust
session.device.stop().await?;  // triggers finalize_session_buffers via emit_stream_ended
let buffer_ids = buffer_store::get_session_buffer_ids(session_id);
// Pick the frame buffer for the BufferReader
let frame_buffer = buffer_ids.iter()
    .find(|id| buffer_store::get_buffer_metadata(id)
        .map(|m| m.buffer_type == BufferType::Frames).unwrap_or(false));
if let Some(bid) = frame_buffer {
    buffer_store::mark_buffer_active(bid);
    // ... create BufferReader, replace device, etc.
}
```

#### `emit_state_change()` in `io/mod.rs:737`

Currently uses `get_active_buffer_id()` to attach a buffer ID to state-change events. After the fix, this function needs a `buffer_id: Option<String>` parameter threaded from the caller. Each caller of `emit_state_change` already has `session_id` in scope — resolve via `get_session_buffer_ids(session_id)` and pick the frame buffer (or pass `None` if the session has no buffers yet).

#### `join_session()` (`io/mod.rs:1605`) and `register_listener()` (`io/mod.rs:2909`)

Both populate `buffer_id` in their result payload via `get_active_buffer_id()`. Replace with `get_session_buffer_ids(session_id)` — the joiner needs the buffers belonging to the session they're joining, not a global singleton. Return the frame buffer ID (or all buffer IDs if the payload supports it).

#### `step_frame()` in `io/timeline/buffer.rs:214`

Currently calls `find_frame_buffer_id()` to resolve the buffer. This function already receives `session_id` — use `get_session_buffer_ids(session_id)` to find the frame buffer, or add an explicit `buffer_id` parameter since the caller (a Tauri command) can pass it.

#### `resolve_buffer_id()` in `io/timeline/buffer.rs:309`

Falls back to `find_frame_buffer_id()` when `buffer_id` is `None`. Remove the fallback — require `buffer_id` to always be `Some`. The `BufferReader` that spawns the stream already holds its `buffer_id` field and passes it through.

#### `BufferReader::new()` in `io/timeline/buffer.rs:43`

The no-buffer constructor is used as a fallback from two Tauri commands in `sessions.rs` (lines 1131, 1173) when `buffer_id` is `None`. It guesses the buffer by checking if the `session_id` itself is a known buffer ID.

After this migration, `BufferReader::new()` should be removed. Both callers (`create_buffer_reader_session` and `transition_to_buffer_reader`) must require an explicit `buffer_id`. The `None` fallback path is eliminated — the frontend must always supply a buffer ID. `new_with_buffer()` becomes the only constructor.

#### `run_buffer_stream()` logging in `io/timeline/buffer.rs:522`

Calls `get_metadata()` just for the buffer name in a log line. Replace with `get_buffer_metadata(&buf_id)` — `buf_id` is already in scope at this point.

#### Backward compat read functions in `buffers.rs`

Tauri commands (`get_buffer_frames`, `find_buffer_bytes_offset_for_timestamp`, etc.) receive `buffer_id` as a parameter from the frontend. The functions that currently use implicit active buffer lookups (`buffers.rs:297,303,347,476,491,520`) are updated to accept and use explicit buffer IDs. Where these are Tauri commands, the frontend passes the buffer ID it holds for the relevant session.

### Session lifecycle cleanup

**Destroy path** (`destroy_session`):
1. `finalize_session_buffers(session_id)` — removes from `streaming_ids`, persists final metadata
2. `orphan_buffers_for_session(session_id)` — clears `owning_session_id`
3. Orphaned buffers may remain in `active_ids` if still being rendered — this is correct (user can view historical data)

**Stop-and-switch path** (`stop_and_switch_to_buffer`):
1. `device.stop()` triggers `emit_stream_ended` which calls `finalize_session_buffers` — buffers are removed from `streaming_ids`
2. `get_session_buffer_ids(session_id)` finds the session's buffers (still owned, just no longer streaming)
3. `mark_buffer_active(bid)` for the buffer being switched to
4. `orphan_buffers_for_session(session_id)` — clears ownership, buffer remains in `active_ids`
5. Replace device with `BufferReader`

**Important:** `finalize_session_buffers` is idempotent — calling it on a session with no streaming buffers returns an empty vec. This prevents double-finalize in the switch path where `emit_stream_ended` already finalized during `device.stop()`.

### Error handling

- `append_frames_to_session` with no matching buffer: silent no-op (matches current behaviour)
- `finalize_session_buffers` with no streaming buffers: returns empty vec (not an error)
- `mark_buffer_active` with unknown buffer ID: returns `Err`

## Call site inventory

### `append_frames()` → `append_frames_to_session()` (15 sites)

| File | Lines | Context |
|------|-------|---------|
| `io/multi_source/merge.rs` | 235, 262 | Session reader |
| `io/gs_usb/nusb_driver.rs` | 781, 808 | Session reader |
| `io/virtual_device/mod.rs` | 528, 557, 580, 642 | Session reader |
| `io/mqtt/reader.rs` | 313 | Session reader |
| `io/modbus_tcp/reader.rs` | 346 | Session reader |
| `io/timeline/postgres.rs` | 512, 572, 597, 618, 635 | Session reader |
| `buffers.rs` | 214 | `import_csv_batch_with_mapping` — now session-scoped |
| `buffers.rs` | 442 | `create_frame_buffer_from_frames` — now session-scoped |

### `append_raw_bytes()` → `append_raw_bytes_to_session()` (4 sites)

| File | Lines |
|------|-------|
| `io/virtual_device/mod.rs` | 593, 656 |
| `io/multi_source/merge.rs` | 245, 272 |

### `finalize_buffer()` → `finalize_session_buffers()` (3 sites)

| File | Lines | Context |
|------|-------|---------|
| `io/mod.rs` | 1261 (`emit_stream_ended`) | Session-scoped finalize |
| `buffers.rs` | 230 (`import_csv_batch_with_mapping`) | Now session-scoped |
| `buffers.rs` | 445 (`create_frame_buffer_from_frames`) | Now session-scoped |

### `set_active_buffer()` → `mark_buffer_active()` (3 sites)

| File | Lines |
|------|-------|
| `io/mod.rs` | 2183, 2583 |
| `buffers.rs` | 424 |

### `get_active_buffer_id()` → session-scoped or explicit buffer ID (8 sites)

| File | Lines | Migration |
|------|-------|-----------|
| `io/mod.rs` | 743 (`emit_state_change`) | Add `buffer_id` param, resolve via `get_session_buffer_ids` |
| `io/mod.rs` | 1605 (`join_session`) | Use `get_session_buffer_ids(session_id)` |
| `io/mod.rs` | 2909 (`register_listener`) | Use `get_session_buffer_ids(session_id)` |
| `framing.rs` | 171 (`apply_framing_to_buffer`) | Add `session_id: String` Tauri command param, resolve byte buffer via session |
| `buffers.rs` | 347, 476, 491 | Accept explicit `buffer_id` from frontend |

### `set_buffer()` (legacy) → session-scoped import (2 sites)

| File | Lines | Context |
|------|-------|---------|
| `buffers.rs` | 67 | `import_csv_to_buffer` — add `session_id`, use session-scoped API |
| `buffers.rs` | 111 | `import_csv_with_mapping` — add `session_id`, use session-scoped API |

### `BufferReader::new()` → removed (2 sites)

| File | Lines | Migration |
|------|-------|-----------|
| `sessions.rs` | 1131 (`create_buffer_reader_session`) | Require explicit `buffer_id`, use `new_with_buffer` |
| `sessions.rs` | 1173 (`transition_to_buffer_reader`) | Require explicit `buffer_id`, use `new_with_buffer` |

### `get_buffer_for_session()` → `get_session_buffer_ids()` (2 sites)

| File | Lines |
|------|-------|
| `io/mod.rs` | 2011 (`suspend_session`) |
| `io/mod.rs` | 2162 (`stop_and_switch_to_buffer`) |

### Legacy read functions → removed (callers migrated to session-scoped or explicit ID)

| Function | Callers | Migration |
|----------|---------|-----------|
| `find_frame_buffer_id()` | `io/timeline/buffer.rs:222` (`step_frame`) | Use `get_session_buffer_ids(session_id)` or add `buffer_id` param |
| `find_frame_buffer_id()` | `io/timeline/buffer.rs:313` (`resolve_buffer_id`) | Remove fallback; require `buffer_id` to always be `Some` |
| `find_frame_buffer_id()` | 5 internal in `buffer_store.rs` | Remove — callers updated to pass explicit IDs |
| `get_metadata()` | `buffers.rs:70,113` | Use `get_buffer_metadata(&buffer_id)` with ID from create |
| `get_metadata()` | `buffers.rs:297` | Accept `buffer_id` from frontend |
| `get_metadata()` | `io/timeline/buffer.rs:522` | Use `get_buffer_metadata(&buf_id)` — `buf_id` already in scope |
| `get_frames()` | `buffers.rs:303` | Use `get_buffer_frames(&buffer_id)` with explicit ID |
| `find_buffer_bytes_offset_for_timestamp()` | `buffers.rs:520` | Accept `buffer_id` from frontend, pass to explicit variant |
