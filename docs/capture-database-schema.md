# Capture Database Schema

SQLite database used for on-disk storage of captured CAN frames and raw
serial bytes. Bulk data lives on disk to avoid unbounded memory growth
during long captures; metadata lives in RAM.

**Location:** `{app_data_dir}/buffers.db` (e.g.
`~/Library/Application Support/com.wired.wiretap/buffers.db` on macOS).
The file name is a legacy carry-over from the pre-rename era; it will be
renamed in a future cleanup.

**Lifecycle:** Non-pinned captures can optionally be cleared on each app
launch (setting: *Clear captures on start*). Pinned (persistent) captures
always survive restart. See [capture-flow.md § Persistence](capture-flow.md#7-persistence).

**Schema migration:** On first launch of a post-rename build, the database
detects the legacy `buffer_metadata` table and atomically renames it to
`capture_metadata`, plus renames the `buffer_id` / `buffer_type` columns
on `frames`, `bytes`, and `capture_metadata` to `capture_id` / `capture_kind`.
The migration is idempotent — safe to run multiple times. See
`migrate_buffer_to_capture` in
[src-tauri/src/capture_db.rs](../src-tauri/src/capture_db.rs).

**PRAGMAs:**

| PRAGMA | Value | Reason |
|--------|-------|--------|
| `journal_mode` | WAL | Concurrent read/write during streaming |
| `synchronous` | NORMAL | Safe with WAL, faster than FULL |
| `cache_size` | -65536 | 64 MB page cache for read performance |
| `temp_store` | MEMORY | Temp tables/indexes in memory |

## Tables

### `frames`

Stores CAN frames and framed serial messages. One row per frame received.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `rowid` | INTEGER | NO | autoincrement | Primary key. Insertion order is preserved and used for pagination, chunked streaming, and position tracking. |
| `capture_id` | TEXT | NO | | Logical capture this frame belongs to (6–8 char random ID, e.g. `xk9m2p`). Multiple captures coexist in the same table. |
| `protocol` | TEXT | NO | | Protocol identifier (e.g. `can`, `j1939`, `obd2`, `isotp`). |
| `timestamp_us` | INTEGER | NO | | Timestamp in microseconds. Source-dependent (device clock or import timestamp). |
| `frame_id` | INTEGER | NO | | CAN arbitration ID (11-bit or 29-bit). Stored as unsigned 32-bit value. |
| `bus` | INTEGER | NO | | Bus/interface number. `0` for single-bus sources. |
| `dlc` | INTEGER | NO | | Data length code (0-8 for classic CAN, 0-64 for CAN FD). |
| `payload` | BLOB | NO | | Raw frame payload bytes. Length may differ from `dlc` in some protocols. |
| `is_extended` | INTEGER | NO | 0 | Boolean (0/1). `1` if the frame uses a 29-bit extended ID. |
| `is_fd` | INTEGER | NO | 0 | Boolean (0/1). `1` if the frame is CAN FD. |
| `source_address` | INTEGER | YES | NULL | J1939 source address, if applicable. |
| `incomplete` | INTEGER | YES | NULL | Boolean (0/1). `1` if the frame is an incomplete ISO-TP reassembly. |
| `direction` | TEXT | YES | NULL | `tx` or `rx`, if the device reports direction. |

### `bytes`

Stores raw serial bytes for unframed serial sessions.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `rowid` | INTEGER | NO | autoincrement | Primary key. Insertion order preserved. |
| `capture_id` | TEXT | NO | | Logical capture this byte belongs to. |
| `byte_val` | INTEGER | NO | | The byte value (0-255). |
| `timestamp_us` | INTEGER | NO | | Timestamp in microseconds. |
| `bus` | INTEGER | NO | 0 | Bus/interface number. |

### `capture_metadata`

One row per capture. Survives `ALTER TABLE RENAME` from the legacy
`buffer_metadata` during Stage 1 migration.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `capture_id` | TEXT | NO | | Primary key. Matches `frames.capture_id` / `bytes.capture_id`. |
| `capture_kind` | TEXT | NO | | `"frames"` or `"bytes"`. |
| `name` | TEXT | NO | | Display name (user-editable). |
| `count` | INTEGER | NO | 0 | Item count (frames or bytes). |
| `start_time_us` | INTEGER | YES | NULL | Timestamp of first item, or NULL if empty. |
| `end_time_us` | INTEGER | YES | NULL | Timestamp of last item, or NULL if empty. |
| `created_at` | INTEGER | NO | | Unix timestamp (seconds) when the capture was created. |
| `owning_session_id` | TEXT | YES | NULL | Session ID that owns this capture. NULL = orphaned. |
| `persistent` | INTEGER | NO | 0 | Boolean (0/1). `1` if pinned (survives restart). |
| `buses` | TEXT | NO | `'[]'` | JSON array of distinct bus numbers seen in this capture's data. |

## Indexes

| Index | Columns | Purpose |
|-------|---------|---------|
| `idx_frames_capture_ts` | `(capture_id, timestamp_us)` | Timestamp-based seeks and lookback window queries. |
| `idx_frames_capture_fid` | `(capture_id, frame_id)` | Filtered pagination by frame ID. |
| `idx_bytes_capture_ts` | `(capture_id, timestamp_us)` | Timestamp-based seeks for byte captures. |

## Query Patterns

### Hot path (per batch during streaming)

- **Insert frames:** Batched `INSERT` in a single transaction using `prepare_cached`. Typically 50-100 frames per call.
- **Insert bytes:** Same pattern for raw serial bytes.

### Cold path (on-demand from frontend)

- **Paginated read:** `SELECT ... WHERE capture_id = ? ORDER BY rowid LIMIT ? OFFSET ?`
- **Filtered paginated read:** Adds `AND frame_id IN (...)` clause.
- **Tail read:** `ORDER BY rowid DESC LIMIT ?`, then reverse in application code.
- **Frame info aggregation:** `SELECT frame_id, MAX(dlc), MIN(bus), MAX(is_extended), (MIN(dlc) != MAX(dlc)) ... GROUP BY frame_id`
- **Offset for timestamp:** `SELECT COUNT(*) WHERE capture_id = ? AND timestamp_us < ?`

### Capture replay (chunked streaming for playback)

- **Forward chunk:** `SELECT ... WHERE capture_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT 2000`
- **Reverse chunk:** `SELECT ... WHERE capture_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 2000`
- **Snapshot (seek while paused):** Most recent frame per unique `frame_id` within a lookback window:
  ```sql
  SELECT f.* FROM frames f
  INNER JOIN (
      SELECT frame_id, MAX(rowid) as max_rowid
      FROM frames
      WHERE capture_id = ? AND rowid <= ? AND timestamp_us >= ?
      GROUP BY frame_id
  ) latest ON f.rowid = latest.max_rowid
  ```
- **Step frame:** `SELECT ... WHERE capture_id = ? AND rowid > ? [AND frame_id IN (...)] ORDER BY rowid ASC LIMIT 1`

### Capture management

- **Copy capture:** `INSERT INTO frames (...) SELECT ... FROM frames WHERE capture_id = ? ORDER BY rowid` (no memory spike).
- **Delete capture:** `DELETE FROM frames WHERE capture_id = ?` (+ same for bytes).
- **Clear all:** `DELETE FROM frames; DELETE FROM bytes;`

## Architecture

### Module layout

| Module | File | Role |
|--------|------|------|
| `capture_db` | `src-tauri/src/capture_db.rs` | All SQLite operations. Owns the `Mutex<Connection>`. |
| `capture_store` | `src-tauri/src/capture_store.rs` | Public API. Metadata in RAM (`RwLock<CaptureRegistry>`), delegates data ops to `capture_db`. |
| `CaptureSource` | `src-tauri/src/io/timeline/capture.rs` | Playback engine. Reads chunks from `capture_db` for streaming. |

### Data flow

```
Device/Import → capture_store::append_frames_to_session()
                  ├─ Update metadata in RAM (count, timestamps)
                  └─ capture_db::insert_frames() → SQLite

Frontend pagination → Tauri command → capture_store::get_capture_frames_paginated()
                                        └─ capture_db::get_frames_paginated() → SQLite

Playback → CaptureSource::run_buffer_stream()
             └─ capture_db::read_frame_chunk() → SQLite (2000 frames at a time)
```

### Lock ordering

The system uses two locks:

1. `CAPTURE_REGISTRY` (`RwLock`) — protects capture metadata in RAM
2. `DB` (`Mutex`) — protects the SQLite connection

**Rule:** Always acquire `CAPTURE_REGISTRY` first, release it, then call `capture_db` (which acquires `DB`). Never hold both simultaneously. This prevents deadlocks.

### Why SQLite instead of in-memory storage

Long-running CAN captures (~480k frames, ~17 minutes) previously crashed consistently. The old in-memory store kept all frames in an unbounded `Vec<FrameMessage>` — at 480k frames that's ~72 MB, and functions like `get_frames()` and `copy_capture()` cloned the entire Vec, temporarily doubling memory. Combined with WebView memory in the Tauri process, this exceeded the memory budget and caused WebKit to kill the WebView.

With SQLite, steady-state RAM at 480k frames drops from ~72 MB (+ clone overhead) to ~5-10 MB (metadata only). Bulk data lives on disk with efficient indexed access.

## Debugging

### Inspecting the database while the app is running

The database uses WAL mode, so you can open it read-only while the app is actively writing:

```bash
sqlite3 ~/Library/Application\ Support/com.wired.wiretap/buffers.db
```

### Useful queries

```sql
-- List all captures and their frame counts
SELECT capture_id, COUNT(*) as frame_count,
       MIN(timestamp_us) as first_ts, MAX(timestamp_us) as last_ts
FROM frames GROUP BY capture_id;

-- List all captures with metadata (name, kind, persistence)
SELECT capture_id, capture_kind, name, count, persistent, owning_session_id
FROM capture_metadata;

-- Check database size
SELECT page_count * page_size as size_bytes
FROM pragma_page_count(), pragma_page_size();

-- List unique frame IDs in a capture
SELECT frame_id, COUNT(*) as count, MAX(dlc) as max_dlc
FROM frames WHERE capture_id = 'xk9m2p'
GROUP BY frame_id ORDER BY frame_id;

-- Get the last 10 frames
SELECT rowid, frame_id, dlc, hex(payload), timestamp_us
FROM frames WHERE capture_id = 'xk9m2p'
ORDER BY rowid DESC LIMIT 10;

-- Check WAL mode is active
PRAGMA journal_mode;
```

### Platform paths

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/com.wired.wiretap/buffers.db` |
| Windows | `%APPDATA%\com.wired.wiretap\buffers.db` |
| Linux | `~/.local/share/com.wired.wiretap/buffers.db` |
| iOS | App sandbox (not user-accessible) |

---

# Transmit History Database Schema

SQLite database used to record every frame transmitted via the Transmit panel — single-shot CAN, single-shot serial, queue repeats, and replay. Replaces the previous unbounded Zustand `history[]` array that caused frontend performance issues at high transmit rates.

**Location:** `{app_data_dir}/transmit_history.db` (e.g. `~/Library/Application Support/com.wired.wiretap/transmit_history.db` on macOS)

**Lifecycle:** Persists across app launches. Can be cleared manually via the History tab toolbar in the Transmit panel.

**PRAGMAs:**

| PRAGMA | Value | Reason |
|--------|-------|--------|
| `journal_mode` | WAL | Concurrent read from frontend while Rust writes per-frame |
| `synchronous` | NORMAL | Safe with WAL, faster than FULL |

## Tables

### `transmit_history`

One row per transmitted frame or serial payload.

| Column         | Type    | Nullable | Default       | Description                                                   |
| -------------- | ------- | -------- | ------------- | ------------------------------------------------------------- |
| `id`           | INTEGER | NO       | AUTOINCREMENT | Primary key. Insertion (chronological) order.                 |
| `session_id`   | TEXT    | NO       |               | Session that transmitted this frame.                          |
| `timestamp_us` | INTEGER | NO       |               | Wall-clock timestamp in microseconds at time of transmission. |
| `kind`         | TEXT    | NO       |               | `"can"` or `"serial"`.                                        |
| `frame_id`     | INTEGER | YES      | NULL          | CAN arbitration ID. NULL for serial payloads.                 |
| `dlc`          | INTEGER | YES      | NULL          | Data length code. NULL for serial payloads.                   |
| `bytes`        | BLOB    | NO       |               | Transmitted payload bytes.                                    |
| `bus`          | INTEGER | NO       | 0             | CAN bus number. `0` for serial.                               |
| `is_extended`  | INTEGER | NO       | 0             | Boolean (0/1). `1` if 29-bit extended CAN ID.                 |
| `is_fd`        | INTEGER | NO       | 0             | Boolean (0/1). `1` if CAN FD frame.                           |
| `success`      | INTEGER | NO       | 1             | Boolean (0/1). `1` if the device accepted the frame.          |
| `error_msg`    | TEXT    | YES      | NULL          | Error string from the device if `success = 0`.                |

## Indexes

| Index | Columns | Purpose |
|-------|---------|---------|
| `idx_ts` | `id DESC` | Fast reverse-chronological pagination (most-recent-first). |

## Query Patterns

- **Paginated read (most recent first):** `SELECT * FROM transmit_history ORDER BY id DESC LIMIT ? OFFSET ?`
- **Count:** `SELECT COUNT(*) FROM transmit_history`
- **Clear:** `DELETE FROM transmit_history`

## Architecture

### Module layout

| Module | File | Role |
|--------|------|------|
| `transmit_history` | `src-tauri/src/transmit_history.rs` | All SQLite operations. Owns the `Mutex<Connection>`. |

### Data flow

```
io_transmit_can_frame / io_transmit_serial
  └─ transmit_history::write_entry() → SQLite
     └─ app.emit("transmit-history-updated") → frontend refetches count

io_start_repeat_transmit / io_start_serial_repeat_transmit / io_start_repeat_group
  └─ transmit_history::write_entry() per frame (rate-limited emit every 250 ms)

io_start_replay (replay.rs)
  └─ transmit_history::write_entry() per frame (piggybacked on replay-progress emit)
```

### Frontend integration

The frontend never receives individual history rows via events. Instead:

1. Rust emits `"transmit-history-updated"` (rate-limited, max once per 250 ms) after writing rows.
2. `useTransmitHistorySubscription` listens for this event and calls `transmitHistoryCount()`.
3. The count is stored as `historyDbCount` in `transmitStore`.
4. `TransmitHistoryView` subscribes to `historyDbCount` and re-fetches a paginated page when it changes.

This keeps the Zustand store lightweight — no `history[]` array, just a single integer counter.

### Platform paths

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/com.wired.wiretap/transmit_history.db` |
| Windows | `%APPDATA%\com.wired.wiretap\transmit_history.db` |
| Linux | `~/.local/share/com.wired.wiretap/transmit_history.db` |
