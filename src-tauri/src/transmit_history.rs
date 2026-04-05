// ui/src-tauri/src/transmit_history.rs
//
// SQLite-backed storage for transmit history.
// Records every transmitted frame (CAN or serial) from repeat loops and
// single-shot transmits so the frontend can display a scrollable, paginated
// history without unbounded Zustand array growth.
//
// Pattern mirrors capture_db.rs: one global Mutex<Connection>.

use once_cell::sync::Lazy;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

/// Global database connection, protected by a Mutex.
/// rusqlite::Connection is !Sync, so we use Mutex (not RwLock).
static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS transmit_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT    NOT NULL,
    timestamp_us INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    frame_id     INTEGER,
    dlc          INTEGER,
    bytes        BLOB    NOT NULL,
    bus          INTEGER NOT NULL DEFAULT 0,
    is_extended  INTEGER NOT NULL DEFAULT 0,
    is_fd        INTEGER NOT NULL DEFAULT 0,
    success      INTEGER NOT NULL DEFAULT 1,
    error_msg    TEXT
);

CREATE INDEX IF NOT EXISTS idx_transmit_history_id ON transmit_history(id DESC);
CREATE INDEX IF NOT EXISTS idx_transmit_history_ts ON transmit_history(timestamp_us);
";

// ============================================================================
// Public row type
// ============================================================================

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransmitHistoryRow {
    pub id: i64,
    pub session_id: String,
    pub timestamp_us: i64,
    pub kind: String,
    pub frame_id: Option<i64>,
    pub dlc: Option<i64>,
    pub bytes: Vec<u8>,
    pub bus: i64,
    pub is_extended: bool,
    pub is_fd: bool,
    pub success: bool,
    pub error_msg: Option<String>,
}

// ============================================================================
// Initialisation
// ============================================================================

/// Initialise the transmit history database. Must be called once at app startup.
pub fn initialise(data_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("Failed to create data dir: {}", e))?;

    let db_path = data_dir.join("transmit_history.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open transmit history database: {}", e))?;

    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("Failed to create schema: {}", e))?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

    let mut db = DB.lock().map_err(|_| "DB mutex poisoned".to_string())?;
    *db = Some(conn);

    Ok(())
}

// ============================================================================
// Write / Query / Clear
// ============================================================================

/// Insert a single transmit history entry. Returns the new row ID (0 on error).
///
/// Called from both async repeat loops and single-shot transmit commands.
/// The mutex lock is held only for the duration of the INSERT (~microseconds).
pub fn write_entry(
    session_id: &str,
    kind: &str,
    frame_id: Option<i64>,
    dlc: Option<i64>,
    bytes: &[u8],
    bus: i64,
    is_extended: bool,
    is_fd: bool,
    success: bool,
    error_msg: Option<&str>,
) -> i64 {
    let timestamp_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as i64;

    let db = match DB.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    let conn = match db.as_ref() {
        Some(c) => c,
        None => return 0,
    };

    let result = conn.execute(
        "INSERT INTO transmit_history \
         (session_id, timestamp_us, kind, frame_id, dlc, bytes, bus, is_extended, is_fd, success, error_msg) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            session_id,
            timestamp_us,
            kind,
            frame_id,
            dlc,
            bytes,
            bus,
            is_extended as i64,
            is_fd as i64,
            success as i64,
            error_msg,
        ],
    );

    match result {
        Ok(_) => conn.last_insert_rowid(),
        Err(e) => {
            tlog!("[transmit_history] INSERT failed: {}", e);
            0
        }
    }
}

/// Delete all rows from the history table.
pub fn clear() {
    let db = match DB.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(conn) = db.as_ref() {
        let _ = conn.execute("DELETE FROM transmit_history", []);
    }
}

/// Count total rows in the history table.
pub fn count() -> i64 {
    let db = match DB.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    let conn = match db.as_ref() {
        Some(c) => c,
        None => return 0,
    };
    conn.query_row("SELECT COUNT(*) FROM transmit_history", [], |r| r.get(0))
        .unwrap_or(0)
}

/// Return up to `limit` rows ordered by newest first, starting at `offset`.
pub fn query(offset: i64, limit: i64) -> Vec<TransmitHistoryRow> {
    let db = match DB.lock() {
        Ok(g) => g,
        Err(_) => return vec![],
    };
    let conn = match db.as_ref() {
        Some(c) => c,
        None => return vec![],
    };

    let mut stmt = match conn.prepare(
        "SELECT id, session_id, timestamp_us, kind, frame_id, dlc, bytes, \
         bus, is_extended, is_fd, success, error_msg \
         FROM transmit_history ORDER BY id DESC LIMIT ?1 OFFSET ?2",
    ) {
        Ok(s) => s,
        Err(e) => {
            tlog!("[transmit_history] prepare failed: {}", e);
            return vec![];
        }
    };

    let rows = stmt.query_map(params![limit, offset], |row| {
        Ok(TransmitHistoryRow {
            id: row.get(0)?,
            session_id: row.get(1)?,
            timestamp_us: row.get(2)?,
            kind: row.get(3)?,
            frame_id: row.get(4)?,
            dlc: row.get(5)?,
            bytes: row.get(6)?,
            bus: row.get(7)?,
            is_extended: row.get::<_, i64>(8)? != 0,
            is_fd: row.get::<_, i64>(9)? != 0,
            success: row.get::<_, i64>(10)? != 0,
            error_msg: row.get(11)?,
        })
    });

    match rows {
        Ok(iter) => iter.filter_map(|r| r.ok()).collect(),
        Err(e) => {
            tlog!("[transmit_history] query failed: {}", e);
            vec![]
        }
    }
}

/// Return the min and max timestamp_us in the history table, or None if empty.
pub fn time_range() -> Option<(i64, i64)> {
    let db = match DB.lock() {
        Ok(g) => g,
        Err(_) => return None,
    };
    let conn = match db.as_ref() {
        Some(c) => c,
        None => return None,
    };
    conn.query_row(
        "SELECT MIN(timestamp_us), MAX(timestamp_us) FROM transmit_history",
        [],
        |r| {
            let min: Option<i64> = r.get(0)?;
            let max: Option<i64> = r.get(1)?;
            Ok(min.zip(max))
        },
    )
    .unwrap_or(None)
}

/// Find the row offset for a given timestamp (number of rows with timestamp >= target,
/// matching the DESC ordering used by query()).
pub fn find_offset(timestamp_us: i64) -> i64 {
    let db = match DB.lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    let conn = match db.as_ref() {
        Some(c) => c,
        None => return 0,
    };
    conn.query_row(
        "SELECT COUNT(*) FROM transmit_history WHERE timestamp_us > ?1",
        params![timestamp_us],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub fn transmit_history_query(offset: i64, limit: i64) -> Result<Vec<TransmitHistoryRow>, String> {
    Ok(query(offset, limit))
}

#[tauri::command]
pub fn transmit_history_count() -> Result<i64, String> {
    Ok(count())
}

#[tauri::command]
pub fn transmit_history_clear() -> Result<(), String> {
    clear();
    Ok(())
}

#[tauri::command]
pub fn transmit_history_time_range() -> Result<Option<(i64, i64)>, String> {
    Ok(time_range())
}

#[tauri::command]
pub fn transmit_history_find_offset(timestamp_us: i64) -> Result<i64, String> {
    Ok(find_offset(timestamp_us))
}
