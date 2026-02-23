// ui/src-tauri/src/buffer_db.rs
//
// SQLite-backed storage for buffer frame and byte data.
// Replaces the in-memory Vec<FrameMessage> / Vec<TimestampedByte> storage
// to prevent OOM crashes during long captures.
//
// The public API of buffer_store.rs is unchanged — this module provides
// the underlying storage layer only.

use once_cell::sync::Lazy;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

use crate::buffer_store::{BufferFrameInfo, TimestampedByte};
use crate::io::FrameMessage;

/// Global database connection, protected by a Mutex.
/// rusqlite::Connection is !Sync, so we use Mutex (not RwLock).
static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS frames (
    rowid INTEGER PRIMARY KEY,
    buffer_id TEXT NOT NULL,
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
    buffer_id TEXT NOT NULL,
    byte_val INTEGER NOT NULL,
    timestamp_us INTEGER NOT NULL,
    bus INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_frames_buffer_ts ON frames (buffer_id, timestamp_us);
CREATE INDEX IF NOT EXISTS idx_frames_buffer_fid ON frames (buffer_id, frame_id);
CREATE INDEX IF NOT EXISTS idx_bytes_buffer_ts ON bytes (buffer_id, timestamp_us);
";

// ============================================================================
// Initialisation
// ============================================================================

/// Initialise the buffer database. Must be called once at app startup.
pub fn initialise(app_data_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    let db_path = app_data_dir.join("buffers.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open buffer database: {}", e))?;

    // WAL mode for concurrent read/write
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("Failed to set WAL mode: {}", e))?;
    // Synchronous NORMAL is safe with WAL and faster than FULL
    conn.execute_batch("PRAGMA synchronous=NORMAL;")
        .map_err(|e| format!("Failed to set synchronous mode: {}", e))?;
    // 64 MB page cache for better read performance
    conn.execute_batch("PRAGMA cache_size=-65536;")
        .map_err(|e| format!("Failed to set cache size: {}", e))?;
    // Temp store in memory
    conn.execute_batch("PRAGMA temp_store=MEMORY;")
        .map_err(|e| format!("Failed to set temp store: {}", e))?;

    // Create tables and indexes
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("Failed to create schema: {}", e))?;

    // Clear leftover data from previous sessions (buffer data is ephemeral)
    conn.execute("DELETE FROM frames", [])
        .map_err(|e| format!("Failed to clear frames: {}", e))?;
    conn.execute("DELETE FROM bytes", [])
        .map_err(|e| format!("Failed to clear bytes: {}", e))?;

    tlog!("[buffer_db] Initialised at {:?}", db_path);

    *DB.lock().unwrap() = Some(conn);
    Ok(())
}

/// Shutdown: close the connection cleanly.
pub fn shutdown() {
    let mut guard = DB.lock().unwrap();
    if guard.take().is_some() {
        tlog!("[buffer_db] Connection closed");
    }
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
                "INSERT INTO frames (buffer_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction)
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
                "INSERT INTO bytes (buffer_id, byte_val, timestamp_us, bus)
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

/// Get paginated frames for a buffer.
pub fn get_frames_paginated(
    buffer_id: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<FrameMessage>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE buffer_id = ?1 ORDER BY rowid LIMIT ?2 OFFSET ?3",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id, limit as i64, offset as i64], |row| {
            row_to_frame(row)
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut frames = Vec::with_capacity(limit);
    for row in rows {
        frames.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(frames)
}

/// Get paginated frames filtered by frame ID set. Returns (frames, total_filtered_count).
pub fn get_frames_paginated_filtered(
    buffer_id: &str,
    offset: usize,
    limit: usize,
    frame_ids: &[u32],
) -> Result<(Vec<FrameMessage>, usize), String> {
    if frame_ids.is_empty() {
        let frames = get_frames_paginated(buffer_id, offset, limit)?;
        let total = get_frame_count(buffer_id)?;
        return Ok((frames, total));
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
                "SELECT COUNT(*) FROM frames WHERE buffer_id = ?1 AND frame_id IN ({})",
                placeholders
            ),
            params![buffer_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))? as usize;

    // Get page
    let sql = format!(
        "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
         FROM frames WHERE buffer_id = ?1 AND frame_id IN ({}) ORDER BY rowid LIMIT ?2 OFFSET ?3",
        placeholders
    );

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id, limit as i64, offset as i64], |row| {
            row_to_frame(row)
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut frames = Vec::with_capacity(limit);
    for row in rows {
        frames.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    Ok((frames, total))
}

/// Get the last N frames for a buffer, optionally filtered. Returns (frames, total_filtered_count).
/// Frames are returned in chronological order (oldest first).
pub fn get_frames_tail(
    buffer_id: &str,
    limit: usize,
    frame_ids: &[u32],
) -> Result<(Vec<FrameMessage>, usize, Option<u64>), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let (sql_data, sql_count, sql_end_time) = if frame_ids.is_empty() {
        (
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE buffer_id = ?1 ORDER BY rowid DESC LIMIT ?2"
                .to_string(),
            "SELECT COUNT(*) FROM frames WHERE buffer_id = ?1".to_string(),
            "SELECT MAX(timestamp_us) FROM frames WHERE buffer_id = ?1".to_string(),
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
                 FROM frames WHERE buffer_id = ?1 AND frame_id IN ({}) ORDER BY rowid DESC LIMIT ?2",
                placeholders
            ),
            format!(
                "SELECT COUNT(*) FROM frames WHERE buffer_id = ?1 AND frame_id IN ({})",
                placeholders
            ),
            format!(
                "SELECT MAX(timestamp_us) FROM frames WHERE buffer_id = ?1 AND frame_id IN ({})",
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
        .query_map(params![buffer_id, limit as i64], |row| row_to_frame(row))
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut frames = Vec::with_capacity(limit);
    for row in rows {
        frames.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    // Results came in DESC order, reverse to chronological
    frames.reverse();

    Ok((frames, total, end_time_us))
}

/// Get total frame count for a buffer.
pub fn get_frame_count(buffer_id: &str) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM frames WHERE buffer_id = ?1",
            params![buffer_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
}

/// Get unique frame info via aggregation query.
pub fn get_frame_info(buffer_id: &str) -> Result<Vec<BufferFrameInfo>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT frame_id, MAX(dlc) as max_dlc, MIN(bus) as bus, MAX(is_extended) as is_extended,
                    (MIN(dlc) != MAX(dlc)) as has_dlc_mismatch
             FROM frames WHERE buffer_id = ?1 GROUP BY frame_id",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![buffer_id], |row| {
            Ok(BufferFrameInfo {
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
            "SELECT COUNT(*) FROM frames WHERE buffer_id = ?1 AND timestamp_us < ?2",
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
                "SELECT COUNT(*) FROM frames WHERE buffer_id = ?1 AND timestamp_us < ?2 AND frame_id IN ({})",
                placeholders
            ),
            params![buffer_id, target_us as i64],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?
    };

    Ok(count as usize)
}

/// Copy all frame and byte data from one buffer to another using INSERT SELECT.
pub fn copy_buffer_data(source_id: &str, dest_id: &str) -> Result<usize, String> {
    let mut guard = DB.lock().unwrap();
    let conn = guard.as_mut().ok_or("Database not initialised")?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    let frame_count = tx
        .execute(
            "INSERT INTO frames (buffer_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction)
             SELECT ?2, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE buffer_id = ?1 ORDER BY rowid",
            params![source_id, dest_id],
        )
        .map_err(|e| format!("Failed to copy frames: {}", e))?;

    let byte_count = tx
        .execute(
            "INSERT INTO bytes (buffer_id, byte_val, timestamp_us, bus)
             SELECT ?2, byte_val, timestamp_us, bus
             FROM bytes WHERE buffer_id = ?1 ORDER BY rowid",
            params![source_id, dest_id],
        )
        .map_err(|e| format!("Failed to copy bytes: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit: {}", e))?;

    Ok(frame_count + byte_count)
}

/// Delete all data for a specific buffer.
pub fn delete_buffer_data(buffer_id: &str) -> Result<(), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    conn.execute("DELETE FROM frames WHERE buffer_id = ?1", params![buffer_id])
        .map_err(|e| format!("Failed to delete frames: {}", e))?;
    conn.execute("DELETE FROM bytes WHERE buffer_id = ?1", params![buffer_id])
        .map_err(|e| format!("Failed to delete bytes: {}", e))?;

    Ok(())
}

/// Delete all data from both tables.
pub fn delete_all_data() -> Result<(), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    conn.execute("DELETE FROM frames", [])
        .map_err(|e| format!("Failed to delete frames: {}", e))?;
    conn.execute("DELETE FROM bytes", [])
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

    tx.execute("DELETE FROM frames WHERE buffer_id = ?1", params![buffer_id])
        .map_err(|e| format!("Failed to clear frames: {}", e))?;

    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO frames (buffer_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction)
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
             FROM frames WHERE buffer_id = ?1 ORDER BY rowid",
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
             FROM frames WHERE buffer_id = ?1 AND rowid > ?2 ORDER BY rowid ASC LIMIT ?3",
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
             FROM frames WHERE buffer_id = ?1 AND rowid < ?2 ORDER BY rowid DESC LIMIT ?3",
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
            "SELECT MIN(rowid), MAX(rowid) FROM frames WHERE buffer_id = ?1",
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
            "SELECT rowid FROM frames WHERE buffer_id = ?1 AND timestamp_us >= ?2 ORDER BY timestamp_us ASC, rowid ASC LIMIT 1",
            params![buffer_id, timestamp_us as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query: {}", e))?;

    Ok(result)
}

/// Build a snapshot: most recent frame for each unique frame_id at or before the given rowid,
/// limited by a minimum timestamp (for lookback window).
pub fn build_snapshot(
    buffer_id: &str,
    up_to_rowid: i64,
    min_timestamp_us: u64,
) -> Result<Vec<FrameMessage>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT f.rowid, f.protocol, f.timestamp_us, f.frame_id, f.bus, f.dlc, f.payload,
                    f.is_extended, f.is_fd, f.source_address, f.incomplete, f.direction
             FROM frames f
             INNER JOIN (
                 SELECT frame_id, MAX(rowid) as max_rowid
                 FROM frames
                 WHERE buffer_id = ?1 AND rowid <= ?2 AND timestamp_us >= ?3
                 GROUP BY frame_id
             ) latest ON f.rowid = latest.max_rowid
             ORDER BY f.frame_id",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(
            params![buffer_id, up_to_rowid, min_timestamp_us as i64],
            |row| row_to_frame(row),
        )
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
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
             FROM frames WHERE buffer_id = ?1 ORDER BY rowid LIMIT 1 OFFSET ?2",
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
             FROM frames WHERE buffer_id = ?1 AND rowid {} ?2 ORDER BY rowid {} LIMIT 1",
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
             FROM frames WHERE buffer_id = ?1 AND rowid {} ?2 AND frame_id IN ({}) ORDER BY rowid {} LIMIT 1",
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
                "SELECT COUNT(*) FROM frames WHERE buffer_id = ?1 AND rowid < ?2",
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
            "SELECT COUNT(*) FROM frames WHERE buffer_id = ?1 AND rowid < ?2",
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
            "SELECT COUNT(*) FROM bytes WHERE buffer_id = ?1",
            params![buffer_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))? as usize;

    let mut stmt = conn
        .prepare_cached(
            "SELECT byte_val, timestamp_us, bus FROM bytes WHERE buffer_id = ?1 ORDER BY rowid LIMIT ?2 OFFSET ?3",
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
            "SELECT byte_val, timestamp_us, bus FROM bytes WHERE buffer_id = ?1 ORDER BY rowid",
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

/// Get total byte count for a buffer.
pub fn get_byte_count(buffer_id: &str) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM bytes WHERE buffer_id = ?1",
            params![buffer_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
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
            "SELECT COUNT(*) FROM bytes WHERE buffer_id = ?1 AND timestamp_us < ?2",
            params![buffer_id, target_us as i64],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
}
