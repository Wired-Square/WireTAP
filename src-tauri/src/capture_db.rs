// ui/src-tauri/src/capture_db.rs
//
// SQLite-backed storage for capture frame and byte data.
// Replaces the in-memory Vec<FrameMessage> / Vec<TimestampedByte> storage
// to prevent OOM crashes during long captures.
//
// The public API of capture_store.rs is unchanged — this module provides
// the underlying storage layer only.

use once_cell::sync::Lazy;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

use crate::capture_store::{CaptureFrameInfo, CaptureMetadata, CaptureKind, TimestampedByte};
use crate::io::FrameMessage;

/// Global database connection, protected by a Mutex.
/// rusqlite::Connection is !Sync, so we use Mutex (not RwLock).
static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS frames (
    rowid INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    timestamp_us INTEGER NOT NULL,
    frame_id INTEGER NOT NULL,
    bus INTEGER NOT NULL,
    dlc INTEGER NOT NULL,
    payload BLOB NOT NULL,
    is_extended INTEGER NOT NULL DEFAULT 0,
    is_fd INTEGER NOT NULL DEFAULT 0,
    source_address INTEGER,
    incomplete INTEGER,
    direction TEXT
);

CREATE TABLE IF NOT EXISTS bytes (
    rowid INTEGER PRIMARY KEY,
    capture_id TEXT NOT NULL,
    byte_val INTEGER NOT NULL,
    timestamp_us INTEGER NOT NULL,
    bus INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS capture_metadata (
    capture_id TEXT PRIMARY KEY,
    capture_kind TEXT NOT NULL,
    name TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    start_time_us INTEGER,
    end_time_us INTEGER,
    created_at INTEGER NOT NULL,
    owning_session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_frames_capture_ts ON frames (capture_id, timestamp_us);
CREATE INDEX IF NOT EXISTS idx_frames_capture_fid ON frames (capture_id, frame_id);
CREATE INDEX IF NOT EXISTS idx_bytes_capture_ts ON bytes (capture_id, timestamp_us);
";

/// Migration: rename legacy `buffer_*` tables/columns to `capture_*`.
/// Detects pre-rename schema and migrates in a single transaction.
/// Idempotent — safely no-ops on fresh installs and already-migrated DBs.
fn migrate_buffer_to_capture(conn: &mut Connection) -> Result<(), String> {
    // Detect whether legacy `buffer_metadata` table exists
    let has_legacy: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='buffer_metadata'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);

    if !has_legacy {
        return Ok(());
    }

    tlog!("[capture_db] Legacy buffer_* schema detected — migrating to capture_* names");

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin migration transaction: {}", e))?;

    // The CREATE TABLE IF NOT EXISTS above will have already created an EMPTY
    // `capture_metadata` table on this run. Drop it so we can rename the
    // legacy table into place (with all its data).
    tx.execute_batch(
        "DROP TABLE IF EXISTS capture_metadata;
         ALTER TABLE buffer_metadata RENAME TO capture_metadata;
         ALTER TABLE capture_metadata RENAME COLUMN buffer_id TO capture_id;
         ALTER TABLE capture_metadata RENAME COLUMN buffer_type TO capture_kind;
         ALTER TABLE frames RENAME COLUMN buffer_id TO capture_id;
         ALTER TABLE bytes RENAME COLUMN buffer_id TO capture_id;
         DROP INDEX IF EXISTS idx_frames_buffer_ts;
         DROP INDEX IF EXISTS idx_frames_buffer_fid;
         DROP INDEX IF EXISTS idx_bytes_buffer_ts;
         CREATE INDEX IF NOT EXISTS idx_frames_capture_ts ON frames (capture_id, timestamp_us);
         CREATE INDEX IF NOT EXISTS idx_frames_capture_fid ON frames (capture_id, frame_id);
         CREATE INDEX IF NOT EXISTS idx_bytes_capture_ts ON bytes (capture_id, timestamp_us);",
    )
    .map_err(|e| format!("Failed to execute buffer→capture migration: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit migration: {}", e))?;

    tlog!("[capture_db] Buffer → Capture schema migration complete");
    Ok(())
}

// ============================================================================
// Initialisation
// ============================================================================

/// Initialise the buffer database. Must be called once at app startup.
/// When `clear_on_start` is true, leftover data from previous sessions is deleted.
pub fn initialise(app_data_dir: &Path, clear_on_start: bool) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    let db_path = app_data_dir.join("buffers.db");
    let mut conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open capture database: {}", e))?;

    // Create tables and indexes first (idempotent — IF NOT EXISTS)
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("Failed to create schema: {}", e))?;

    // Migrate legacy buffer_* schema to capture_* if present.
    // Must run BEFORE the ADD COLUMN migrations below so we're targeting the
    // correct table name.
    migrate_buffer_to_capture(&mut conn)?;

    // Schema migration: add persistent column (idempotent — ignores duplicate column error)
    let _ = conn.execute(
        "ALTER TABLE capture_metadata ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0",
        [],
    );

    // Schema migration: add buses column (idempotent — ignores duplicate column error)
    let _ = conn.execute(
        "ALTER TABLE capture_metadata ADD COLUMN buses TEXT NOT NULL DEFAULT '[]'",
        [],
    );

    // Conditionally clear leftover data and reclaim disk space
    // Persistent (pinned) buffers survive the clear.
    if clear_on_start {
        // The database file persists WAL mode from the previous session.
        // VACUUM cannot shrink a WAL-mode database, so switch to DELETE mode first.
        conn.execute_batch("PRAGMA journal_mode=DELETE;")
            .map_err(|e| format!("Failed to switch to DELETE journal mode: {}", e))?;
        // Delete frames/bytes belonging to non-persistent captures
        conn.execute(
            "DELETE FROM frames WHERE capture_id IN (SELECT capture_id FROM capture_metadata WHERE persistent = 0)",
            [],
        )
        .map_err(|e| format!("Failed to clear non-persistent frames: {}", e))?;
        conn.execute(
            "DELETE FROM bytes WHERE capture_id IN (SELECT capture_id FROM capture_metadata WHERE persistent = 0)",
            [],
        )
        .map_err(|e| format!("Failed to clear non-persistent bytes: {}", e))?;
        conn.execute("DELETE FROM capture_metadata WHERE persistent = 0", [])
            .map_err(|e| format!("Failed to clear non-persistent capture metadata: {}", e))?;
        // Also delete orphaned data (frames/bytes with no metadata row at all)
        conn.execute(
            "DELETE FROM frames WHERE capture_id NOT IN (SELECT capture_id FROM capture_metadata)",
            [],
        )
        .map_err(|e| format!("Failed to clear orphaned frames: {}", e))?;
        conn.execute(
            "DELETE FROM bytes WHERE capture_id NOT IN (SELECT capture_id FROM capture_metadata)",
            [],
        )
        .map_err(|e| format!("Failed to clear orphaned bytes: {}", e))?;
        conn.execute_batch("VACUUM;")
            .map_err(|e| format!("Failed to vacuum database: {}", e))?;
        tlog!("[capture_db] Initialised at {:?} (cleared non-persistent and vacuumed)", db_path);
    } else {
        tlog!("[capture_db] Initialised at {:?} (preserving previous data)", db_path);
    }

    // Set WAL mode and performance pragmas after vacuum (VACUUM resets journal mode)
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("Failed to set WAL mode: {}", e))?;
    conn.execute_batch("PRAGMA synchronous=NORMAL;")
        .map_err(|e| format!("Failed to set synchronous mode: {}", e))?;
    conn.execute_batch("PRAGMA cache_size=-65536;")
        .map_err(|e| format!("Failed to set cache size: {}", e))?;
    conn.execute_batch("PRAGMA temp_store=MEMORY;")
        .map_err(|e| format!("Failed to set temp store: {}", e))?;

    *DB.lock().unwrap() = Some(conn);
    Ok(())
}


// ============================================================================
// Helper: row → FrameMessage
// ============================================================================

fn row_to_frame(row: &rusqlite::Row) -> rusqlite::Result<FrameMessage> {
    let payload: Vec<u8> = row.get("payload")?;
    let is_extended: i32 = row.get("is_extended")?;
    let is_fd: i32 = row.get("is_fd")?;
    let source_address: Option<i64> = row.get("source_address")?;
    let incomplete: Option<i32> = row.get("incomplete")?;

    Ok(FrameMessage {
        protocol: row.get("protocol")?,
        timestamp_us: row.get::<_, i64>("timestamp_us")? as u64,
        frame_id: row.get::<_, i64>("frame_id")? as u32,
        bus: row.get::<_, i64>("bus")? as u8,
        dlc: row.get::<_, i64>("dlc")? as u8,
        bytes: payload,
        is_extended: is_extended != 0,
        is_fd: is_fd != 0,
        source_address: source_address.map(|v| v as u16),
        incomplete: incomplete.map(|v| v != 0),
        direction: row.get("direction")?,
    })
}

fn row_to_frame_with_rowid(row: &rusqlite::Row) -> rusqlite::Result<(i64, FrameMessage)> {
    let rowid: i64 = row.get("rowid")?;
    let frame = row_to_frame(row)?;
    Ok((rowid, frame))
}

// ============================================================================
// Hot-Path Writes (called per batch during streaming)
// ============================================================================

/// Insert a batch of frames for a buffer. Uses a single transaction.
pub fn insert_frames(buffer_id: &str, frames: &[FrameMessage]) -> Result<(), String> {
    if frames.is_empty() {
        return Ok(());
    }

    let mut guard = DB.lock().unwrap();
    let conn = guard.as_mut().ok_or("Database not initialised")?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )
            .map_err(|e| format!("Failed to prepare statement: {}", e))?;

        for frame in frames {
            stmt.execute(params![
                buffer_id,
                &frame.protocol,
                frame.timestamp_us as i64,
                frame.frame_id as i64,
                frame.bus as i64,
                frame.dlc as i64,
                &frame.bytes,
                frame.is_extended as i32,
                frame.is_fd as i32,
                frame.source_address.map(|v| v as i64),
                frame.incomplete.map(|v| v as i32),
                &frame.direction,
            ])
            .map_err(|e| format!("Failed to insert frame: {}", e))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(())
}

/// Insert a batch of timestamped bytes for a buffer. Uses a single transaction.
pub fn insert_bytes(buffer_id: &str, bytes: &[TimestampedByte]) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }

    let mut guard = DB.lock().unwrap();
    let conn = guard.as_mut().ok_or("Database not initialised")?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO bytes (capture_id, byte_val, timestamp_us, bus)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("Failed to prepare statement: {}", e))?;

        for b in bytes {
            stmt.execute(params![
                buffer_id,
                b.byte as i64,
                b.timestamp_us as i64,
                b.bus as i64,
            ])
            .map_err(|e| format!("Failed to insert byte: {}", e))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    Ok(())
}

// ============================================================================
// Cold-Path Reads (on-demand, frontend-initiated)
// ============================================================================

/// Get paginated frames for a buffer. Returns (frames, rowids).
pub fn get_frames_paginated(
    buffer_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<FrameMessage>, Vec<i64>), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 ORDER BY rowid LIMIT ?2 OFFSET ?3",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id, limit as i64, offset as i64], |row| {
            row_to_frame_with_rowid(row)
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut frames = Vec::with_capacity(limit);
    let mut rowids = Vec::with_capacity(limit);
    for row in rows {
        let (rowid, frame) = row.map_err(|e| format!("Failed to read row: {}", e))?;
        rowids.push(rowid);
        frames.push(frame);
    }
    Ok((frames, rowids))
}

/// Get paginated frames filtered by frame ID set. Returns (frames, rowids, total_filtered_count).
pub fn get_frames_paginated_filtered(
    buffer_id: &str,
    offset: usize,
    limit: usize,
    frame_ids: &[u32],
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize), String> {
    if frame_ids.is_empty() {
        let (frames, rowids) = get_frames_paginated(buffer_id, offset, limit)?;
        let total = get_frame_count(buffer_id)?;
        return Ok((frames, rowids, total));
    }

    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let placeholders = frame_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");

    // Get total filtered count
    let total: usize = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND frame_id IN ({})",
                placeholders
            ),
            params![buffer_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))? as usize;

    // Get page
    let sql = format!(
        "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
         FROM frames WHERE capture_id = ?1 AND frame_id IN ({}) ORDER BY rowid LIMIT ?2 OFFSET ?3",
        placeholders
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id, limit as i64, offset as i64], |row| {
            row_to_frame_with_rowid(row)
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut frames = Vec::with_capacity(limit);
    let mut rowids = Vec::with_capacity(limit);
    for row in rows {
        let (rowid, frame) = row.map_err(|e| format!("Failed to read row: {}", e))?;
        rowids.push(rowid);
        frames.push(frame);
    }

    Ok((frames, rowids, total))
}

/// Get the last N frames for a buffer, optionally filtered. Returns (frames, rowids, total_filtered_count, end_time).
/// Frames are returned in chronological order (oldest first).
pub fn get_frames_tail(
    buffer_id: &str,
    limit: usize,
    frame_ids: &[u32],
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize, Option<u64>), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let (sql_data, sql_count, sql_end_time) = if frame_ids.is_empty() {
        (
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 ORDER BY rowid DESC LIMIT ?2"
                .to_string(),
            "SELECT COUNT(*) FROM frames WHERE capture_id = ?1".to_string(),
            "SELECT MAX(timestamp_us) FROM frames WHERE capture_id = ?1".to_string(),
        )
    } else {
        let placeholders = frame_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        (
            format!(
                "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
                 FROM frames WHERE capture_id = ?1 AND frame_id IN ({}) ORDER BY rowid DESC LIMIT ?2",
                placeholders
            ),
            format!(
                "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND frame_id IN ({})",
                placeholders
            ),
            format!(
                "SELECT MAX(timestamp_us) FROM frames WHERE capture_id = ?1 AND frame_id IN ({})",
                placeholders
            ),
        )
    };

    let total: usize = conn
        .query_row(&sql_count, params![buffer_id], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("Failed to count: {}", e))? as usize;

    let end_time_us: Option<u64> = conn
        .query_row(&sql_end_time, params![buffer_id], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .map_err(|e| format!("Failed to get end time: {}", e))?
        .map(|v| v as u64);

    let mut stmt = conn
        .prepare(&sql_data)
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id, limit as i64], |row| row_to_frame_with_rowid(row))
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut frames = Vec::with_capacity(limit);
    let mut rowids = Vec::with_capacity(limit);
    for row in rows {
        let (rowid, frame) = row.map_err(|e| format!("Failed to read row: {}", e))?;
        rowids.push(rowid);
        frames.push(frame);
    }

    // Results came in DESC order, reverse to chronological
    frames.reverse();
    rowids.reverse();

    Ok((frames, rowids, total, end_time_us))
}

/// Get total frame count for a buffer.
pub fn get_frame_count(buffer_id: &str) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM frames WHERE capture_id = ?1",
            params![buffer_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
}

/// Get unique frame info via aggregation query.
pub fn get_frame_info(buffer_id: &str) -> Result<Vec<CaptureFrameInfo>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT frame_id, MAX(dlc) as max_dlc, MIN(bus) as bus, MAX(is_extended) as is_extended,
                    (MIN(dlc) != MAX(dlc)) as has_dlc_mismatch
             FROM frames WHERE capture_id = ?1 GROUP BY frame_id",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id], |row| {
            Ok(CaptureFrameInfo {
                frame_id: row.get::<_, i64>("frame_id")? as u32,
                max_dlc: row.get::<_, i64>("max_dlc")? as u8,
                bus: row.get::<_, i64>("bus")? as u8,
                is_extended: row.get::<_, i64>("is_extended")? != 0,
                has_dlc_mismatch: row.get::<_, i64>("has_dlc_mismatch")? != 0,
            })
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(result)
}

/// Find the offset (row count) for a given timestamp, optionally filtered by frame IDs.
pub fn find_offset_for_timestamp(
    buffer_id: &str,
    target_us: u64,
    frame_ids: &[u32],
) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let count: i64 = if frame_ids.is_empty() {
        conn.query_row(
            "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND timestamp_us < ?2",
            params![buffer_id, target_us as i64],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?
    } else {
        let placeholders = frame_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND timestamp_us < ?2 AND frame_id IN ({})",
                placeholders
            ),
            params![buffer_id, target_us as i64],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?
    };

    Ok(count as usize)
}

/// Search frames in a buffer for a text query, returning 0-based offsets in the
/// selected-ID-filtered result set.
///
/// `query` must have whitespace stripped by the caller.
/// `search_id` matches against the hex representation of frame_id.
/// `search_data` matches against the hex representation of the payload BLOB.
/// `frame_ids` filters which frames are included (empty = all frames).
pub fn search_frames(
    buffer_id: &str,
    query: &str,
    search_id: bool,
    search_data: bool,
    frame_ids: &[u32],
) -> Result<Vec<usize>, String> {
    if query.is_empty() || (!search_id && !search_data) {
        return Ok(Vec::new());
    }

    // Strip any 0x/0X prefix for hex ID matching
    let q = if query.starts_with("0x") || query.starts_with("0X") {
        &query[2..]
    } else {
        query
    };
    let q_lower = q.to_lowercase();
    let q_upper = q.to_uppercase();

    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    // Build optional frame_id IN (...) filter
    let id_filter = if frame_ids.is_empty() {
        String::new()
    } else {
        let placeholders = frame_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        format!(" AND frame_id IN ({})", placeholders)
    };

    // ROW_NUMBER gives us the 0-based offset in the filtered result set.
    // ID search: printf('%x', frame_id) for lowercase hex (matches the stripped query).
    // Data search: hex(payload) returns uppercase hex (match against upper query).
    let search_clauses: Vec<String> = {
        let mut clauses = Vec::new();
        if search_id {
            clauses.push(format!(
                "printf('%x', frame_id) LIKE '%{}%'",
                q_lower.replace('\'', "''")
            ));
        }
        if search_data {
            clauses.push(format!(
                "upper(hex(payload)) LIKE '%{}%'",
                q_upper.replace('\'', "''")
            ));
        }
        clauses
    };

    let where_clause = search_clauses.join(" OR ");

    let sql = format!(
        "WITH numbered AS (
            SELECT frame_id, payload,
                   CAST(ROW_NUMBER() OVER (ORDER BY rowid) AS INTEGER) - 1 AS offset
            FROM frames
            WHERE capture_id = ?1{}
        )
        SELECT offset FROM numbered WHERE {}",
        id_filter, where_clause
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare search: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id], |row| row.get::<_, i64>(0))
        .map_err(|e| format!("Failed to execute search: {}", e))?;

    let mut offsets = Vec::new();
    for row in rows {
        offsets.push(row.map_err(|e| format!("Failed to read row: {}", e))? as usize);
    }

    Ok(offsets)
}

/// Copy all frame and byte data from one buffer to another using INSERT SELECT.
pub fn copy_capture_data(source_id: &str, dest_id: &str) -> Result<usize, String> {
    let mut guard = DB.lock().unwrap();
    let conn = guard.as_mut().ok_or("Database not initialised")?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    let frame_count = tx
        .execute(
            "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction)
             SELECT ?2, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 ORDER BY rowid",
            params![source_id, dest_id],
        )
        .map_err(|e| format!("Failed to copy frames: {}", e))?;

    let byte_count = tx
        .execute(
            "INSERT INTO bytes (capture_id, byte_val, timestamp_us, bus)
             SELECT ?2, byte_val, timestamp_us, bus
             FROM bytes WHERE capture_id = ?1 ORDER BY rowid",
            params![source_id, dest_id],
        )
        .map_err(|e| format!("Failed to copy bytes: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit: {}", e))?;

    Ok(frame_count + byte_count)
}

/// Delete all data for a specific buffer.
pub fn delete_capture_data(buffer_id: &str) -> Result<(), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    conn.execute("DELETE FROM frames WHERE capture_id = ?1", params![buffer_id])
        .map_err(|e| format!("Failed to delete frames: {}", e))?;
    conn.execute("DELETE FROM bytes WHERE capture_id = ?1", params![buffer_id])
        .map_err(|e| format!("Failed to delete bytes: {}", e))?;

    Ok(())
}

/// Clear and refill a buffer with new frames (used by framing to reuse buffer IDs).
pub fn clear_and_refill(buffer_id: &str, frames: &[FrameMessage]) -> Result<(), String> {
    let mut guard = DB.lock().unwrap();
    let conn = guard.as_mut().ok_or("Database not initialised")?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    tx.execute("DELETE FROM frames WHERE capture_id = ?1", params![buffer_id])
        .map_err(|e| format!("Failed to clear frames: {}", e))?;

    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )
            .map_err(|e| format!("Failed to prepare: {}", e))?;

        for frame in frames {
            stmt.execute(params![
                buffer_id,
                &frame.protocol,
                frame.timestamp_us as i64,
                frame.frame_id as i64,
                frame.bus as i64,
                frame.dlc as i64,
                &frame.bytes,
                frame.is_extended as i32,
                frame.is_fd as i32,
                frame.source_address.map(|v| v as i64),
                frame.incomplete.map(|v| v as i32),
                &frame.direction,
            ])
            .map_err(|e| format!("Failed to insert frame: {}", e))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit: {}", e))?;

    Ok(())
}

/// Get all frames for a buffer (loads everything — use sparingly).
pub fn get_all_frames(buffer_id: &str) -> Result<Vec<FrameMessage>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 ORDER BY rowid",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id], |row| row_to_frame(row))
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut frames = Vec::new();
    for row in rows {
        frames.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(frames)
}

// ============================================================================
// Buffer Reader Streaming (chunked reads for playback)
// ============================================================================

/// Read a chunk of frames starting after the given rowid (forward).
/// Returns Vec of (rowid, FrameMessage) for position tracking.
pub fn read_frame_chunk(
    buffer_id: &str,
    after_rowid: i64,
    limit: usize,
) -> Result<Vec<(i64, FrameMessage)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 AND rowid > ?2 ORDER BY rowid ASC LIMIT ?3",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id, after_rowid, limit as i64], |row| {
            row_to_frame_with_rowid(row)
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut result = Vec::with_capacity(limit);
    for row in rows {
        result.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(result)
}

/// Read a chunk of frames before the given rowid (reverse).
/// Returns in reverse chronological order (most recent first).
pub fn read_frame_chunk_reverse(
    buffer_id: &str,
    before_rowid: i64,
    limit: usize,
) -> Result<Vec<(i64, FrameMessage)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 AND rowid < ?2 ORDER BY rowid DESC LIMIT ?3",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id, before_rowid, limit as i64], |row| {
            row_to_frame_with_rowid(row)
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut result = Vec::with_capacity(limit);
    for row in rows {
        result.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(result)
}

/// Get min and max rowid for a buffer (for determining bounds).
pub fn get_rowid_range(buffer_id: &str) -> Result<Option<(i64, i64)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let result: Option<(i64, i64)> = conn
        .query_row(
            "SELECT MIN(rowid), MAX(rowid) FROM frames WHERE capture_id = ?1",
            params![buffer_id],
            |row| {
                let min: Option<i64> = row.get(0)?;
                let max: Option<i64> = row.get(1)?;
                Ok(min.zip(max))
            },
        )
        .map_err(|e| format!("Failed to query: {}", e))?;

    Ok(result)
}

/// Find the rowid nearest to (at or after) a given timestamp.
pub fn find_rowid_for_timestamp(
    buffer_id: &str,
    timestamp_us: u64,
) -> Result<Option<i64>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let result: Option<i64> = conn
        .query_row(
            "SELECT rowid FROM frames WHERE capture_id = ?1 AND timestamp_us >= ?2 ORDER BY timestamp_us ASC, rowid ASC LIMIT 1",
            params![buffer_id, timestamp_us as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query: {}", e))?;

    Ok(result)
}


/// Get the frame at a specific index (0-based) within a buffer.
/// Returns (rowid, FrameMessage) or None if index out of bounds.
pub fn get_frame_at_index(
    buffer_id: &str,
    index: usize,
) -> Result<Option<(i64, FrameMessage)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let result = conn
        .query_row(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 ORDER BY rowid LIMIT 1 OFFSET ?2",
            params![buffer_id, index as i64],
            |row| row_to_frame_with_rowid(row),
        )
        .optional()
        .map_err(|e| format!("Failed to query: {}", e))?;

    Ok(result)
}

/// Get the next (or previous) frame matching an optional filter, starting after (or before) a given rowid.
/// Returns (rowid, frame_index, FrameMessage) where frame_index is the 0-based position.
pub fn get_next_filtered_frame(
    buffer_id: &str,
    current_rowid: i64,
    frame_ids: &[u32],
    backward: bool,
) -> Result<Option<(i64, usize, FrameMessage)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let (op, order) = if backward {
        ("<", "DESC")
    } else {
        (">", "ASC")
    };

    let sql = if frame_ids.is_empty() {
        format!(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 AND rowid {} ?2 ORDER BY rowid {} LIMIT 1",
            op, order
        )
    } else {
        let placeholders = frame_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 AND rowid {} ?2 AND frame_id IN ({}) ORDER BY rowid {} LIMIT 1",
            op, placeholders, order
        )
    };

    let row_result = conn
        .query_row(&sql, params![buffer_id, current_rowid], |row| {
            row_to_frame_with_rowid(row)
        })
        .optional()
        .map_err(|e| format!("Failed to query: {}", e))?;

    if let Some((rowid, frame)) = row_result {
        // Compute the frame_index (0-based position within the buffer)
        let frame_index: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND rowid < ?2",
                params![buffer_id, rowid],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("Failed to count: {}", e))? as usize;

        Ok(Some((rowid, frame_index, frame)))
    } else {
        Ok(None)
    }
}

/// Count the number of frames before a given rowid in a buffer (for computing 0-based frame index).
pub fn count_frames_before_rowid(buffer_id: &str, rowid: i64) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND rowid < ?2",
            params![buffer_id, rowid],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
}

// ============================================================================
// Byte Buffer Operations
// ============================================================================

/// Get paginated bytes for a buffer. Returns (bytes, total_count).
pub fn get_bytes_paginated(
    buffer_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<TimestampedByte>, usize), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let total: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM bytes WHERE capture_id = ?1",
            params![buffer_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))? as usize;

    let mut stmt = conn
        .prepare_cached(
            "SELECT byte_val, timestamp_us, bus FROM bytes WHERE capture_id = ?1 ORDER BY rowid LIMIT ?2 OFFSET ?3",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id, limit as i64, offset as i64], |row| {
            Ok(TimestampedByte {
                byte: row.get::<_, i64>(0)? as u8,
                timestamp_us: row.get::<_, i64>(1)? as u64,
                bus: row.get::<_, i64>(2)? as u8,
            })
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut bytes = Vec::with_capacity(limit);
    for row in rows {
        bytes.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    Ok((bytes, total))
}

/// Get all bytes for a buffer (used by framing which needs the full stream).
pub fn get_all_bytes(buffer_id: &str) -> Result<Vec<TimestampedByte>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT byte_val, timestamp_us, bus FROM bytes WHERE capture_id = ?1 ORDER BY rowid",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id], |row| {
            Ok(TimestampedByte {
                byte: row.get::<_, i64>(0)? as u8,
                timestamp_us: row.get::<_, i64>(1)? as u64,
                bus: row.get::<_, i64>(2)? as u8,
            })
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut bytes = Vec::new();
    for row in rows {
        bytes.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(bytes)
}


// ============================================================================
// Raw query helpers (for bufferquery.rs)
// ============================================================================

/// Execute a raw SQL query returning (timestamp_us, prev_payload, payload) tuples.
/// Used by buffer_query_byte_changes and buffer_query_frame_changes.
pub fn query_raw(
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<(i64, Vec<u8>, Vec<u8>)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|e| format!("Failed to execute query: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    Ok(results)
}

/// Execute a raw SQL query returning (timestamp_us, payload) tuples.
/// Used by buffer_query_mirror_validation.
pub fn query_raw_two_col(
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<(i64, Vec<u8>)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .map_err(|e| format!("Failed to execute query: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    Ok(results)
}

/// Query payloads only (single BLOB column) from the buffer database.
pub fn query_payloads(
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<Vec<u8>>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            row.get::<_, Vec<u8>>(0)
        })
        .map_err(|e| format!("Failed to execute query: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    Ok(results)
}

/// Execute a raw SQL query returning (timestamp_us, frame_id, is_extended, payload) tuples.
/// Used by buffer_query_pattern_search.
pub fn query_raw_four_col(
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<(i64, i64, bool, Vec<u8>)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            let is_ext: i32 = row.get(2)?;
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                is_ext != 0,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|e| format!("Failed to execute query: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    Ok(results)
}

/// Find the byte offset for a given timestamp in a buffer.
pub fn find_bytes_offset_for_timestamp(
    buffer_id: &str,
    target_us: u64,
) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM bytes WHERE capture_id = ?1 AND timestamp_us < ?2",
            params![buffer_id, target_us as i64],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
}

// ============================================================================
// Buffer Metadata Persistence
// ============================================================================

/// Upsert capture metadata into SQLite.
pub fn save_capture_metadata(meta: &CaptureMetadata) -> Result<(), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let kind_str = match &meta.buffer_type {
        CaptureKind::Frames => "frames",
        CaptureKind::Bytes => "bytes",
    };

    let buses_json = serde_json::to_string(&meta.buses).unwrap_or_else(|_| "[]".to_string());

    conn.execute(
        "INSERT OR REPLACE INTO capture_metadata (capture_id, capture_kind, name, count, start_time_us, end_time_us, created_at, owning_session_id, persistent, buses)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            &meta.id,
            kind_str,
            &meta.name,
            meta.count as i64,
            meta.start_time_us.map(|v| v as i64),
            meta.end_time_us.map(|v| v as i64),
            meta.created_at as i64,
            &meta.owning_session_id,
            meta.persistent as i64,
            buses_json,
        ],
    )
    .map_err(|e| format!("Failed to save capture metadata: {}", e))?;

    Ok(())
}

/// Load all capture metadata from SQLite.
pub fn load_all_capture_metadata() -> Result<Vec<CaptureMetadata>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare("SELECT capture_id, capture_kind, name, count, start_time_us, end_time_us, created_at, owning_session_id, persistent, buses FROM capture_metadata")
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let kind_str: String = row.get("capture_kind")?;
            let buffer_type = if kind_str == "bytes" {
                CaptureKind::Bytes
            } else {
                CaptureKind::Frames
            };

            let buses_json: String = row.get::<_, String>("buses").unwrap_or_else(|_| "[]".to_string());
            let buses: Vec<u8> = serde_json::from_str(&buses_json).unwrap_or_default();

            Ok(CaptureMetadata {
                id: row.get("capture_id")?,
                buffer_type,
                name: row.get("name")?,
                count: row.get::<_, i64>("count")? as usize,
                start_time_us: row.get::<_, Option<i64>>("start_time_us")?.map(|v| v as u64),
                end_time_us: row.get::<_, Option<i64>>("end_time_us")?.map(|v| v as u64),
                created_at: row.get::<_, i64>("created_at")? as u64,
                is_streaming: false,
                owning_session_id: row.get("owning_session_id")?,
                persistent: row.get::<_, i64>("persistent").unwrap_or(0) != 0,
                buses,
            })
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(result)
}

/// Update the name of a capture in SQLite.
pub fn update_capture_name(capture_id: &str, new_name: &str) -> Result<(), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    conn.execute(
        "UPDATE capture_metadata SET name = ?2 WHERE capture_id = ?1",
        params![capture_id, new_name],
    )
    .map_err(|e| format!("Failed to update capture name: {}", e))?;

    Ok(())
}

/// Update the persistent flag of a capture in SQLite.
pub fn update_capture_persistent(capture_id: &str, persistent: bool) -> Result<(), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    conn.execute(
        "UPDATE capture_metadata SET persistent = ?2 WHERE capture_id = ?1",
        params![capture_id, persistent as i64],
    )
    .map_err(|e| format!("Failed to update capture persistent flag: {}", e))?;

    Ok(())
}

/// Get distinct bus numbers from a buffer's data.
/// Used to backfill bus metadata for buffers created before bus tracking was added.
/// `table` should be "frames" or "bytes".
pub fn get_distinct_buses(buffer_id: &str, table: &str) -> Result<Vec<u8>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    // table is an internal constant ("frames" or "bytes"), not user input
    let sql = format!(
        "SELECT DISTINCT bus FROM {} WHERE capture_id = ?1 ORDER BY bus",
        table
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id], |row| row.get::<_, u8>(0))
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut buses = Vec::new();
    for row in rows {
        buses.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(buses)
}

/// Delete metadata for a specific capture.
pub fn delete_capture_metadata(capture_id: &str) -> Result<(), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    conn.execute(
        "DELETE FROM capture_metadata WHERE capture_id = ?1",
        params![capture_id],
    )
    .map_err(|e| format!("Failed to delete capture metadata: {}", e))?;

    Ok(())
}
