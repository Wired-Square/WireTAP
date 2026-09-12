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
    captures: HashMap<String, NamedCapture>,  // each holds an Option<CaptureRole>
    streaming_ids: HashSet<String>, // receiving appends from a live source
    active_ids:    HashSet<String>, // being rendered by a UI panel
    ...
}
```

The two sets are **independent**:

- A capture in `streaming_ids` is the write target of a currently-running
  source. `is_streaming` on `CaptureMetadata` is computed from this set.
- A capture in `active_ids` is currently visible in a UI panel. Marking a
  capture active is a pure UI concern and does not affect writing.

A capture can be in both (a live capture being rendered), either, or neither
(e.g. an orphaned capture that nothing is viewing).

**A session owns captures it never streamed into.** `apply_framing_to_capture`
derives a `Frames` capture from a `Bytes` one and assigns it to the session so it
is cleaned up with it, but it is a result, not a write target. So ownership alone
cannot answer "what is this session's capture?": choosing by it picks the derived
capture, and a raw serial session looks like a frames session the moment
client-side framing runs.

`CaptureRole` is what separates the two. It sits on `NamedCapture` beside
`owning_session_id`, is written whenever an owner is written, and is cleared with
it by `orphan_captures_for_session` — the two are one relation, so they cannot
drift, and a re-owned capture cannot inherit a stale claim:

- `CaptureRole::Stream` — the session's own: it streams into this capture, or
  replays from it.
- `CaptureRole::Derived` — owned for cleanup only, never "the session's capture".
  Framing results. `is_derived_capture` is also what lets framing refill its own
  previous output without ever clearing a capture a session is recording into.

Every session-scoped lookup filters on the role, so callers get the right answer
without knowing any of this — `get_session_frame_capture_id`,
`get_session_bytes_capture_id` and `get_session_capture` (frames first, with the
kind, for a caller that just wants "the session's capture"). The role outlives
`stop()`, unlike `streaming_ids`, so the answer no longer changes under a caller
when the session stops.

The role is in memory only: `hydrate_from_db` orphans every capture on startup,
so no owner — and no role — survives a restart.

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
| `create_session_capture(session_id, kind, name)` | Create as the session's own (`Stream`) and add to `streaming_ids`. Returns the new `capture_id`. |
| `create_session_capture_inactive(session_id, kind, name)` | Same, without adding to `streaming_ids` (the bytes capture beside a framed serial session's frames capture). |
| `create_derived_capture(session_id, kind, name)` | Create as a `Derived` result of the session — owned for cleanup, never the session's own, never a write target. |

Every capture is created with its owner and role already set, so there is no
window in which one is visible without the other, and the SQLite row is written
once. Creation never touches `active_ids` — starting a capture never hijacks the
user's view.

### Session ownership

| Function | Purpose |
|----------|---------|
| `set_capture_owner(capture_id, session_id, role)` | Assign an existing capture. `role` is required, so the Stream/Derived choice cannot be made by omission. Used by `CaptureSource` to adopt what it replays. |
| `orphan_captures_for_session(session_id)` | Clear ownership **and role** on every capture the session owns, return `OrphanedCaptureInfo` list. |
| `get_session_frame_capture_id(session_id)` | The session's frames capture, if any. |
| `get_session_bytes_capture_id(session_id)` | Same, for the session's bytes capture. |
| `get_session_capture(session_id)` | The session's capture and its kind, frames first — for callers that report one capture, so id and kind cannot desync. |
| `is_derived_capture(capture_id, session_id)` | Whether framing may clear and refill this capture. |

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
| `get_capture_frames(id)` / `_paginated` / `_paginated_filtered` / `_tail` | Read frame data. The filter is a `FrameSelection`: `(protocol, frame_id)` pairs, plus protocols selected whole (`all_ids`) — what Discovery's Modbus tab sends, so a protocol's every id matches, seen or not. Empty means everything. |
| `get_capture_latest_frames(id)` | The newest frame per `(protocol, frame_id)` — "the current value of each thing" rather than the history. |
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
     ├─ create_session_capture(session_id, Frames, session_name) → new capture_id
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
captures are already finalised returns an empty vec.

Call sites: [io/mod.rs:1160](../src-tauri/src/io/mod.rs#L1160) (`emit_stream_ended`).

### Stop-and-switch to capture replay

```
stop_and_switch_to_capture(session_id, speed)
     │
     ├─ get_session_frame_capture_id(session_id)
     │      └─ must precede the orphan below, which releases ownership
     │
     ├─ session.source.stop()              // triggers emit_stream_ended
     │      └─ finalize_session_captures   // capture now finalised & persisted
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

### Modbus scan capture

A discovery sweep owns a Frames capture like any other source, which is what
makes its results analysable, exportable and pageable rather than a throwaway
list in a panel.

A sweep launched from Discovery touches one capture — its own. The tools run
from "No source" (see [session-flow.md](session-flow.md) § Modbus discovery), so
there is no session being scanned and nothing to stop or resume.

`stop_target` is still on `create_modbus_scan_session` for callers that name a
live session and want the device released outright, MCP among them. That path
touches two captures: the target's is finalised by the stop, and
`resume_session_to_live` afterwards gives it a *new* capture rather than
reopening the finalised one.

```
create_modbus_scan_session(session_id, job)   // creates the session STOPPED
  └─ (frontend subscribes / joins)
       └─ start_reader_session(session_id)
            ├─ create_session_capture(session_id, Frames, session_id)
            ├─ sweep → append_frames_to_session + throttled signal_frames_ready
            └─ emit_stream_ended(session_id, "complete"|"cancelled"|"stopped")
                 └─ finalize_session_captures
```

**The session must be created stopped.** `ws::dispatch::reset_frame_offset`
snapshots a capture's *current* frame count when a subscriber attaches, so
anything appended before the frontend subscribes is never pushed over the
WebSocket. Starting the sweep at creation time would silently drop its opening
registers and present as an intermittent "some registers missing" bug. The
headless MCP path starts immediately because it has no subscriber to race and
reads its results back through `get_capture_frames`.

One register becomes one frame, keyed by its address (`frame_id` = register
number, `dlc` 2). That granularity is what lets the Payload Changes tool answer
"which *register* moved" across a repeated sweep. Catalogue-driven polling keeps
the opposite shape — one frame per poll group — because a catalogue's signals are
bit offsets into the whole block and would decode to nonsense if split.

**A sweep writes each register once per pass, which is why
`get_capture_latest_frames` exists.** At the caps a 20-pass sweep of 4096
registers is ~80k rows for a results table of 4096 values, so the scan view asks
for the newest row per identity and lets SQLite do the reduction — the same
`GROUP BY protocol, frame_id` that `get_frame_info` already uses. Reading the lot
and keeping the last of each is the same answer for twenty times the IPC.

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
capture_store::create_session_capture(&session_id, CaptureKind::Frames, name);
capture_store::append_frames_to_session(&session_id, frames);
capture_store::finalize_session_captures(&session_id);
```

`apply_framing_to_capture` reads the source byte capture via
`get_session_bytes_capture_id` and makes its output with `create_derived_capture`
— owned for cleanup, never mistaken for the session's own, and the only kind of
capture it will clear and refill on a re-frame.

**The Framed tab reads whichever capture holds the frames.** `FramedDataView`
pages from `framedCaptureId ?? sessionFramesCaptureId`: client-side framing
derives a capture and puts its id in the serial store, while a reader that frames
on the wire (SLIP, Modbus RTU) writes straight into the session's own capture and
derives nothing. Discovery passes the session capture only when its kind is
`frames` — a raw serial session's own capture is *bytes*, and handing that to a
frame pager would be a fresh bug — and passes the **live** count
(`liveFrameCount`), because the pager gives up on a zero count and `captureCount`
reads 0 while streaming.

Getting that wrong is invisible in the obvious way: the tab's own count comes
from a different source, so it increments happily over an empty table. **That
split is only half closed** — the tab counts, the min-length filter and the
Filtered tab still assume client-side framing, so on a reader-framed session the
filter silently does nothing and the Filtered tab renders no rows. The register
carries it, along with the shape of the fix: both halves of the pair belong in
`discoverySerialStore` (as `ByteView` already gets its byte pair), and this
component's paging belongs in `useCaptureFrameView`, which `DiscoveryFramesView`
already uses and which owns the tail refetch and its in-flight guard.

Until then this path carries its own copy of that guard: the frame count moves at
2 Hz (`SIGNAL_INTERVAL_MS`), a tail fetch on a large capture can outlast that, and
fetches must neither queue on the capture-store mutex nor land out of order and
overwrite newer rows with older.

`apply_framing_to_capture` produces **two** captures when a minimum frame length
is set: the framed result and the too-short frames the filter set aside. Both are refilled in place
(`refill_or_derive`), and the caller passes both previous ids back. The filtered
one used to be created fresh every call and never reused or deleted, so with a
filter set each re-frame left another session-owned capture behind — and framing
runs on every stop. A run that filters nothing deletes the previous filtered
capture rather than leaving it showing the last run's rows.

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
| `getCaptureLatestFrames(id)` | `get_capture_latest_frames` |
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

### The capture is the display source

Because every session owns a capture from its first frame, apps read their rows
from the capture rather than keeping their own copy — live tail, a stopped page
and capture playback are the same query at different offsets.
[useCaptureFrameView](../src/apps/discovery/hooks/useCaptureFrameView.ts) is the
reference implementation: it refetches the tail when the session's
Rust-reported `frameCount` moves (`MsgType 0x16`, the same 2 Hz signal above),
and pages via `get_capture_frames_paginated_filtered` when stopped.

**Byte captures work the same way.** `ByteCounts` (`MsgType 0x19`) carries the
byte total and the byte capture's id; the serial byte view refetches from that
capture — `get_capture_bytes_tail` while streaming, `get_capture_bytes_paginated`
when stopped. Raw bytes are never pushed over the wire, so a byte view that is
not reading from a capture is not going to show anything (see
[session-flow.md § Raw serial bytes](session-flow.md#raw-serial-bytes--counted-not-streamed)).

Two consequences worth knowing before changing it:

- **Rows carry their capture position.** `capture_indices` are SQLite rowids,
  parallel to `frames`. They are the row's identity — the `#` column and the
  React key both come from them, via `frameRowKey` in
  [src/utils/frameKey.ts](../src/utils/frameKey.ts). Frames have no identity of
  their own: `(timestamp_us, frame_id, bus)` collides whenever a source emits
  the same ID twice in one microsecond, and duplicate keys make React orphan
  rows it can never remove, so they accumulate on every render.
- **Frames arrive chronological.** The merge task sorts each batch by
  `timestamp_us` before appending, queries are `ORDER BY rowid`, and the tail
  query reverses its `DESC` result in Rust. Views must not re-sort or reverse.
- **The window is addressed by row, not by page.** State is `anchorRow` — the
  ordinal of the row at the top — and `pageStartIndex` is the offset actually
  fetched. `currentPage` is derived from it for the toolbar and is display-only.
  Use `pageStartIndex` / `goToRow` for anything positional; `currentPage *
  pageSize` disagrees whenever the anchor is not page-aligned, which is exactly
  what happens once the page size can change under a fixed anchor (see § Auto
  rows-per-page) or once the window is clamped against the end of the capture.

Discovery still keeps `_frameBuffer` in memory, but only for analysis, replay,
bulk-add and the MCP live frame map — not for rendering the frames table.

### Auto rows-per-page

Tables default to fitting their page to the height available.
[useAutoRowCount](../src/hooks/useAutoRowCount.ts) observes one element — the
scroll container — which already reflects Dockview resizes, window resizes and
every chrome row appearing or disappearing, so nothing enumerates the chrome.
`FrameDataTable` calls it on its callers' behalf (`autoFit` / `onFitChange`),
because it is the only thing that knows its own container, sticky header and
trailing spacer; `ResultsPanel` is div-based and calls the hook directly.

Two types carry this, both in
[src/utils/pageSize.ts](../src/utils/pageSize.ts). A `PageSize` is what the
control holds — `number | "auto" | "all"` — and a `ResolvedPageSize` is a
concrete count, `null` until the fit has been measured. Views hold the setting
so the select can match an option, and pass `resolvePageSize(...)` to their
data layer.

Both of those used to be numbers, and both bit. The modes rode as `-2` / `-1`
in the same field as a row count, so a missed resolution was a negative offset
with no error; and the unmeasured state was `0`, so a missed guard divided into
`Infinity`. Keeping the modes as strings and the unmeasured state as `null`
makes each of those a compile error instead. One rule survives, because the
compiler cannot check it:

- **The null guard must sit in the effect's *condition*,** with the size in its
  dependencies, so the fetch re-runs when the measurement lands. Reading the
  size from a ref instead leaves the effect parked forever, which silently
  disables the live tail.

`pageCount` and `pageForOffset` own the two divisions, so page arithmetic
cannot go infinite even where a size is legitimately unresolved.

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
