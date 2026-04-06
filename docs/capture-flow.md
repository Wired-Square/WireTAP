# Capture Flow

This document describes how captures are created, written, finalised, owned,
orphaned, persisted, and replayed. For the session subsystem that sits above
captures, see [session-flow.md](session-flow.md). For the on-disk schema, see
[capture-database-schema.md](capture-database-schema.md).

## 1. What is a capture?

A **capture** is an append-only store for a single session's frame or byte
data. While a session is running, its source writes frames or raw bytes into
the capture. When the session stops, the capture is finalised but remains
available for replay, export, or analysis.

Capture metadata lives in RAM (`CaptureRegistry`); bulk data lives in SQLite
via the `capture_db` module (see [capture-database-schema.md](capture-database-schema.md)).
Pinned captures survive app restart; ephemeral (unpinned) captures are
cleaned up when no longer referenced.

---

## 2. Capture kinds

```rust
pub enum CaptureKind {
    Frames,  // CAN frames, framed serial messages, Modbus messages
    Bytes,   // raw unframed serial bytes
}
```

See [src-tauri/src/capture_store.rs:22-29](../src-tauri/src/capture_store.rs#L22-L29).

A single session may own **at most one capture of each kind**. A framed
serial session owns one `Frames` capture. A raw serial session owns one
`Bytes` capture. A multi-source session that mixes framed and raw streams
can own one of each.

---

## 3. Identity

- `capture_id` — 6–8 character random base36 string (e.g. `xk9m2p`,
  `r7f3kw`). **Immutable.** Primary key in the on-disk database and the
  in-memory registry.
- `name` — mutable display name (e.g. `"GVRET 10:30am"`). Freely renameable.
  New captures start with the session name.
- `owning_session_id` — the `session_id` that currently owns the capture, or
  `None` if the capture is orphaned.

Capture IDs are **not** session IDs. A session replaying a capture gets its
own `b_`-prefixed session ID (see
[session-flow.md § Session ID prefixes](session-flow.md#session-id-prefixes)).

---

## 4. Registry state

`CaptureRegistry` in [src-tauri/src/capture_store.rs:89-100](../src-tauri/src/capture_store.rs#L89-L100):

```rust
struct CaptureRegistry {
    buffers: HashMap<String, NamedCapture>,
    streaming_ids: HashSet<String>,   // receiving appends from a live source
    active_ids:    HashSet<String>,   // being rendered by a UI panel
    ...
}
```

`streaming_ids` and `active_ids` are **independent** sets:

- A capture in `streaming_ids` is the write target of a currently-running
  source. `is_streaming` on `CaptureMetadata` is computed from this set.
- A capture in `active_ids` is currently visible in a UI panel. Marking a
  capture active is a pure UI concern and does not affect writing.

A capture can be in both sets (live capture being rendered), either one, or
neither (e.g. an orphaned capture that nothing is viewing).

This split replaced the old `Option<String>` globals that caused cross-session
contamination when two sessions ran concurrently (see git commit `a320fb8`).

---

## 5. Public API

All of these are in [src-tauri/src/capture_store.rs](../src-tauri/src/capture_store.rs).
Session sources and lifecycle code should use the session-scoped API; direct
capture-ID calls exist for queries and pagination.

### Creation

| Function | Purpose |
|----------|---------|
| `create_capture(kind, name)` | Create and add to `streaming_ids`. Returns new `capture_id`. |
| `create_capture_inactive(kind, name)` | Create without adding to `streaming_ids` (e.g. framing-derived captures). |

After creation the caller must `set_capture_owner(capture_id, session_id)`.
`create_capture` no longer touches `active_ids` — starting a capture never
hijacks the user's view.

### Session ownership

| Function | Purpose |
|----------|---------|
| `set_capture_owner(capture_id, session_id)` | Assign a capture to a session; persists metadata. |
| `orphan_captures_for_session(session_id)` | Clear ownership on every capture the session owns, return `OrphanedCaptureInfo` list. |
| `get_session_capture_ids(session_id)` | Every capture currently owned by this session (frames + bytes). |
| `get_session_frame_capture_id(session_id)` | Convenience: the session's frames capture, if any. |

### Data writes (session-scoped)

| Function | Purpose |
|----------|---------|
| `append_frames_to_session(session_id, frames)` | Resolves the session's frame capture, then appends. No-op if the session has no frame capture (warns in log). |
| `append_raw_bytes_to_session(session_id, bytes)` | Same, for byte captures. |

Sources only need their `session_id` — they never carry a `capture_id`
through the streaming loop.

### Lifecycle

| Function | Purpose |
|----------|---------|
| `finalize_session_captures(session_id)` | Remove all streaming captures for the session from `streaming_ids`, persist final metadata, return the finalised `CaptureMetadata` list. Idempotent. |
| `mark_capture_active(capture_id)` | Add to `active_ids` (UI viewing). |
| `delete_capture(id)` / `clear_capture(id)` | Remove / reset a capture. Cleans both sets. |
| `rename_capture(id, new_name)` | Rename (display name only). |
| `set_capture_persistent(id, persistent)` | Pin or unpin. Pinned captures survive restart. |

### Queries

| Function | Purpose |
|----------|---------|
| `list_captures()` | All captures with live `is_streaming` flag. |
| `list_orphaned_captures()` | Captures with no owning session — pickable as standalone sources. |
| `get_capture_metadata(id)` | Single capture metadata. |
| `get_capture_frames(id)` / `_paginated` / `_paginated_filtered` / `_tail` | Read frame data. |
| `get_capture_bytes(id)` / `_paginated` | Read byte data. |
| `find_capture_offset_for_timestamp(...)` / `find_capture_bytes_offset_for_timestamp_by_id(...)` | Seek helpers. |
| `get_capture_count(id)` / `get_capture_kind(id)` / `has_any_data()` | Misc. |
| `copy_capture(source_id, new_name)` | Create an orphaned copy (used when an app detaches from a shared capture). |
| `is_known_capture(id)` / `list_capture_ids()` | ID existence checks. |

---

## 6. Lifecycle flows

### Live capture

```
Source task starts (e.g. gs_usb, multi_source)
     │
     ├─ create_capture(Frames, session_name) → new capture_id
     ├─ set_capture_owner(capture_id, session_id)
     │  (for dual-stream sessions, also create a Bytes capture)
     │
     ▼
Source loop:
  read frames from device
  append_frames_to_session(session_id, frames)
  signal_frames_ready(session_id)      ← 2 Hz throttled (see session-flow.md § WebSocket transport)
     │
     ▼
On stop (device.stop() or stream end):
  emit_stream_ended(session_id, reason, prefix)
     └─ finalize_session_captures(session_id)
          ├─ remove each owned capture from streaming_ids
          └─ persist final metadata to capture_db
```

`finalize_session_captures` is idempotent — calling it on a session whose
captures are already finalised returns an empty vec. This is critical for the
stop-and-switch path below, where `device.stop()` indirectly finalises the
capture before the caller calls `get_session_capture_ids`.

Call sites: [io/mod.rs:1160](../src-tauri/src/io/mod.rs#L1160) (`emit_stream_ended`).

### Stop-and-switch to capture replay

```
stop_and_switch_to_buffer(session_id, speed)
     │
     ├─ session.source.stop()              // triggers emit_stream_ended
     │      └─ finalize_session_captures   // capture now finalised & persisted
     │
     ├─ get_session_capture_ids(session_id)
     │      └─ pick the one with CaptureKind::Frames
     │
     ├─ mark_capture_active(capture_id)
     │
     ├─ orphan_captures_for_session(session_id)
     │      └─ clears owning_session_id — capture is now standalone
     │
     └─ replace_session_source(
            sessions, session_id,
            CaptureSource::new(session_id, capture_id, speed),
            ...
        )
            └─ session continues on historical data; all listeners receive
               a SessionLifecycle WS message with the new capabilities.
```

### Resume to live

A new `IOBroker` is built from the session's retained `source_configs`
and swapped in via `replace_session_source(..., auto_start=true)`. The orphaned
historical capture remains in the registry and can be re-selected later from
the source picker.

### Destroy

```
destroy_session(session_id)
  ├─ finalize_session_captures(session_id)        // if still streaming
  ├─ orphan_captures_for_session(session_id)      // clears ownership
  │      └─ emit_capture_orphaned_as_changed       // post_session cache + WS CaptureChanged
  └─ remove from IO_SESSIONS
```

Orphaned captures may still be in `active_ids` (an app is still rendering the
historical data) — that is correct and intended. The user can keep reading
the capture after the session is gone.

### Import flows

Imports are session-scoped end-to-end. The Tauri command accepts a
`session_id`; if no session exists yet the caller creates a stopped
`CaptureSource` session that will own the imported capture.

| Command | File |
|---------|------|
| `import_csv_to_capture` | [src-tauri/src/captures.rs](../src-tauri/src/captures.rs) |
| `import_csv_with_mapping` | [src-tauri/src/captures.rs](../src-tauri/src/captures.rs) |
| `import_csv_batch_with_mapping` | [src-tauri/src/captures.rs](../src-tauri/src/captures.rs) |
| `create_frame_capture_from_frames` | [src-tauri/src/captures.rs](../src-tauri/src/captures.rs) |
| `apply_framing_to_capture` | [src-tauri/src/framing.rs](../src-tauri/src/framing.rs) |

Each import follows the same pattern:

```rust
let capture_id = capture_store::create_capture(CaptureKind::Frames, name);
capture_store::set_capture_owner(&capture_id, &session_id)?;
capture_store::append_frames_to_session(&session_id, frames);
capture_store::finalize_session_captures(&session_id);
```

`apply_framing_to_capture` additionally reads the source byte capture via
`get_session_capture_ids` and assigns the derived frame capture to the same
session.

---

## 7. Persistence

`CaptureMetadata.persistent` controls whether a capture survives app restart:

- **Pinned** (`persistent: true`): metadata + SQLite frame rows survive
  restart. On startup `hydrate_from_db()` restores them into the registry.
- **Ephemeral** (`persistent: false`, the default): cleaned up when the app
  exits or when the user clears ephemeral captures.

`set_capture_persistent(id, true)` pins a capture; `false` unpins. The source
picker exposes this as a pin toggle next to each capture in its list.

Schema details — columns, indexes, cleanup policies — are in
[capture-database-schema.md](capture-database-schema.md).

---

## 8. CaptureSource — replaying a capture as a session

[src-tauri/src/io/recorded/capture.rs](../src-tauri/src/io/recorded/capture.rs)
implements `CaptureSource`, the `IOSource` that exposes a stored capture as
a timeline session. It is constructed with an **explicit** `capture_id` —
there is no fallback / guess path; frontends must pass the ID they want to
replay.

Playback supports pause, resume, seek (forward and reverse), and playback
speed. On reaching the end of data it pauses itself and emits a
`StreamEnded` WS message; a subsequent seek or resume continues from the new
position.

A `CaptureSource` session lives under a `b_` session ID and never streams
frames into a new capture of its own — it reads from the existing one.

---

## 9. Frontend surface

TypeScript wrappers mirror the session-scoped API:

| TS function | Tauri command |
|-------------|---------------|
| `listCaptures()` / `listOrphanedCaptures()` | `list_captures` / `list_orphaned_captures` |
| `getCaptureMetadata(id)` | `get_capture_metadata` |
| `getCaptureFrames(id, offset, limit)` | `get_capture_frames_paginated` |
| `renameCapture(id, name)` | `rename_capture` |
| `setCapturePersistent(id, pinned)` | `set_capture_persistent` |
| `deleteCapture(id)` / `clearCaptureData(id)` | `delete_capture` / `clear_capture` |
| `importCsvToCapture(sessionId, …)` | `import_csv_to_capture` |
| `createFrameCaptureFromFrames(sessionId, …)` | `create_frame_capture_from_frames` |
| `applyFramingToCapture(sessionId, …)` | `apply_framing_to_capture` |

See [src/api/capture.ts](../src/api/capture.ts) for the full list.

The WS `CaptureChanged` message (`MsgType 0x07`) signals "something changed
about this session's captures"; the frontend reacts by re-querying
`listCaptures()` or `getSessionCaptureIds` rather than trying to diff a
payload.

---

## 10. Key files

| File | Role |
|------|------|
| [src-tauri/src/capture_store.rs](../src-tauri/src/capture_store.rs) | Registry, session-scoped API, streaming/active sets |
| [src-tauri/src/capture_db.rs](../src-tauri/src/capture_db.rs) | SQLite persistence |
| [src-tauri/src/captures.rs](../src-tauri/src/captures.rs) | Tauri commands (list/read/import/delete) |
| [src-tauri/src/framing.rs](../src-tauri/src/framing.rs) | `apply_framing_to_capture` — byte capture → frame capture |
| [src-tauri/src/io/recorded/capture.rs](../src-tauri/src/io/recorded/capture.rs) | `CaptureSource` timeline device |
| [src/api/capture.ts](../src/api/capture.ts) | TypeScript wrappers |
| [docs/capture-database-schema.md](capture-database-schema.md) | On-disk schema reference |
