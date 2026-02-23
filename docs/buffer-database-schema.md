# Buffer Database Schema

SQLite database used for ephemeral storage of captured CAN frames and raw serial bytes during a session. Data is stored on disk to avoid unbounded memory growth during long captures.

**Location:** `{app_data_dir}/buffers.db` (e.g. `~/Library/Application Support/com.wired.candor/buffers.db` on macOS)

**Lifecycle:** Cleared on each app launch. Buffer data is ephemeral and not intended to persist across sessions.

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
| `buffer_id` | TEXT | NO | | Logical buffer this frame belongs to (e.g. `buf_1`, `buf_2`). Multiple buffers coexist in the same table. |
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
| `buffer_id` | TEXT | NO | | Logical buffer this byte belongs to. |
| `byte_val` | INTEGER | NO | | The byte value (0-255). |
| `timestamp_us` | INTEGER | NO | | Timestamp in microseconds. |
| `bus` | INTEGER | NO | 0 | Bus/interface number. |

## Indexes

| Index | Columns | Purpose |
|-------|---------|---------|
| `idx_frames_buffer_ts` | `(buffer_id, timestamp_us)` | Timestamp-based seeks and lookback window queries. |
| `idx_frames_buffer_fid` | `(buffer_id, frame_id)` | Filtered pagination by frame ID. |
| `idx_bytes_buffer_ts` | `(buffer_id, timestamp_us)` | Timestamp-based seeks for byte buffers. |

## Query Patterns

### Hot path (per batch during streaming)

- **Insert frames:** Batched `INSERT` in a single transaction using `prepare_cached`. Typically 50-100 frames per call.
- **Insert bytes:** Same pattern for raw serial bytes.

### Cold path (on-demand from frontend)

- **Paginated read:** `SELECT ... WHERE buffer_id = ? ORDER BY rowid LIMIT ? OFFSET ?`
- **Filtered paginated read:** Adds `AND frame_id IN (...)` clause.
- **Tail read:** `ORDER BY rowid DESC LIMIT ?`, then reverse in application code.
- **Frame info aggregation:** `SELECT frame_id, MAX(dlc), MIN(bus), MAX(is_extended), (MIN(dlc) != MAX(dlc)) ... GROUP BY frame_id`
- **Offset for timestamp:** `SELECT COUNT(*) WHERE buffer_id = ? AND timestamp_us < ?`

### Buffer reader (chunked streaming for playback)

- **Forward chunk:** `SELECT ... WHERE buffer_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT 2000`
- **Reverse chunk:** `SELECT ... WHERE buffer_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 2000`
- **Snapshot (seek while paused):** Most recent frame per unique `frame_id` within a lookback window:
  ```sql
  SELECT f.* FROM frames f
  INNER JOIN (
      SELECT frame_id, MAX(rowid) as max_rowid
      FROM frames
      WHERE buffer_id = ? AND rowid <= ? AND timestamp_us >= ?
      GROUP BY frame_id
  ) latest ON f.rowid = latest.max_rowid
  ```
- **Step frame:** `SELECT ... WHERE buffer_id = ? AND rowid > ? [AND frame_id IN (...)] ORDER BY rowid ASC LIMIT 1`

### Buffer management

- **Copy buffer:** `INSERT INTO frames (...) SELECT ... FROM frames WHERE buffer_id = ? ORDER BY rowid` (no memory spike).
- **Delete buffer:** `DELETE FROM frames WHERE buffer_id = ?` (+ same for bytes).
- **Clear all:** `DELETE FROM frames; DELETE FROM bytes;`

## Architecture

### Module layout

| Module | File | Role |
|--------|------|------|
| `buffer_db` | `src-tauri/src/buffer_db.rs` | All SQLite operations. Owns the `Mutex<Connection>`. |
| `buffer_store` | `src-tauri/src/buffer_store.rs` | Public API. Metadata in RAM (`RwLock<BufferRegistry>`), delegates data ops to `buffer_db`. |
| `BufferReader` | `src-tauri/src/io/timeline/buffer.rs` | Playback engine. Reads chunks from `buffer_db` for streaming. |

### Data flow

```
Device/Import → buffer_store::append_frames()
                  ├─ Update metadata in RAM (count, timestamps)
                  └─ buffer_db::insert_frames() → SQLite

Frontend pagination → Tauri command → buffer_store::get_buffer_frames_paginated()
                                        └─ buffer_db::get_frames_paginated() → SQLite

Playback → BufferReader::run_buffer_stream()
             └─ buffer_db::read_frame_chunk() → SQLite (2000 frames at a time)
```

### Lock ordering

The system uses two locks:

1. `BUFFER_REGISTRY` (`RwLock`) — protects buffer metadata in RAM
2. `DB` (`Mutex`) — protects the SQLite connection

**Rule:** Always acquire `BUFFER_REGISTRY` first, release it, then call `buffer_db` (which acquires `DB`). Never hold both simultaneously. This prevents deadlocks.

### Why SQLite instead of in-memory storage

Long-running CAN captures (~480k frames, ~17 minutes) previously crashed consistently. The old `buffer_store` kept all frames in an unbounded `Vec<FrameMessage>` — at 480k frames that's ~72 MB, and functions like `get_frames()` and `copy_buffer()` cloned the entire Vec, temporarily doubling memory. Combined with WebView memory in the Tauri process, this exceeded the memory budget and caused WebKit to kill the WebView.

With SQLite, steady-state RAM at 480k frames drops from ~72 MB (+ clone overhead) to ~5-10 MB (metadata only). Bulk data lives on disk with efficient indexed access.

## Debugging

### Inspecting the database while the app is running

The database uses WAL mode, so you can open it read-only while the app is actively writing:

```bash
sqlite3 ~/Library/Application\ Support/com.wired.candor/buffers.db
```

### Useful queries

```sql
-- List all buffers and their frame counts
SELECT buffer_id, COUNT(*) as frame_count,
       MIN(timestamp_us) as first_ts, MAX(timestamp_us) as last_ts
FROM frames GROUP BY buffer_id;

-- Check database size
SELECT page_count * page_size as size_bytes
FROM pragma_page_count(), pragma_page_size();

-- List unique frame IDs in a buffer
SELECT frame_id, COUNT(*) as count, MAX(dlc) as max_dlc
FROM frames WHERE buffer_id = 'buf_1'
GROUP BY frame_id ORDER BY frame_id;

-- Get the last 10 frames
SELECT rowid, frame_id, dlc, hex(payload), timestamp_us
FROM frames WHERE buffer_id = 'buf_1'
ORDER BY rowid DESC LIMIT 10;

-- Check WAL mode is active
PRAGMA journal_mode;
```

### Platform paths

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/com.wired.candor/buffers.db` |
| Windows | `%APPDATA%\com.wired.candor\buffers.db` |
| Linux | `~/.local/share/com.wired.candor/buffers.db` |
| iOS | App sandbox (not user-accessible) |
