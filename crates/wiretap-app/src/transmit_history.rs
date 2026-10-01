// ui/crates/wiretap-app/src/transmit_history.rs
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
CREATE INDEX IF NOT EXISTS idx_transmit_history_session ON transmit_history(session_id, id DESC);
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

/// Count every row in the history table; its change is the `TransmitUpdated` signal.
pub fn count() -> i64 {
    with_db(0, |conn| {
        conn.query_row("SELECT COUNT(*) FROM transmit_history", [], |r| r.get(0))
            .unwrap_or(0)
    })
}

fn with_db<T>(fallback: T, read: impl FnOnce(&Connection) -> T) -> T {
    match DB.lock() {
        Ok(db) => db.as_ref().map_or(fallback, read),
        Err(_) => fallback,
    }
}

fn clear_session(conn: &Connection, session_id: &str) {
    let _ = conn.execute("DELETE FROM transmit_history WHERE session_id = ?1", params![session_id]);
}

fn session_count(conn: &Connection, session_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM transmit_history WHERE session_id = ?1",
        params![session_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Return up to `limit` of the session's rows, newest first, starting at `offset`.
///
/// Unsigned deliberately, matching the capture readers: SQLite reads a negative `LIMIT`
/// as *no limit*, so a bad value would quietly return the whole table instead of erroring.
fn session_rows(conn: &Connection, session_id: &str, offset: usize, limit: usize) -> Vec<TransmitHistoryRow> {
    let mut stmt = match conn.prepare(
        "SELECT id, session_id, timestamp_us, kind, frame_id, dlc, bytes, \
         bus, is_extended, is_fd, success, error_msg \
         FROM transmit_history WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3",
    ) {
        Ok(s) => s,
        Err(e) => {
            tlog!("[transmit_history] prepare failed: {}", e);
            return vec![];
        }
    };

    let rows = stmt.query_map(params![session_id, limit, offset], |row| {
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

fn session_time_range(conn: &Connection, session_id: &str) -> Option<(i64, i64)> {
    conn.query_row(
        "SELECT MIN(timestamp_us), MAX(timestamp_us) FROM transmit_history WHERE session_id = ?1",
        params![session_id],
        |r| {
            let min: Option<i64> = r.get(0)?;
            let max: Option<i64> = r.get(1)?;
            Ok(min.zip(max))
        },
    )
    .unwrap_or(None)
}

/// The row offset of `timestamp_us` in `session_rows`' newest-first order.
fn session_offset_after(conn: &Connection, session_id: &str, timestamp_us: i64) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM transmit_history WHERE session_id = ?1 AND timestamp_us > ?2",
        params![session_id, timestamp_us],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub fn transmit_history_query(session_id: String, offset: usize, limit: usize) -> Result<Vec<TransmitHistoryRow>, String> {
    Ok(with_db(vec![], |conn| session_rows(conn, &session_id, offset, limit)))
}

#[tauri::command]
pub fn transmit_history_count(session_id: String) -> Result<i64, String> {
    Ok(with_db(0, |conn| session_count(conn, &session_id)))
}

#[tauri::command]
pub fn transmit_history_clear(session_id: String) -> Result<i64, String> {
    with_db((), |conn| clear_session(conn, &session_id));
    let remaining = count();
    crate::ws::dispatch::send_transmit_updated(remaining);
    Ok(remaining)
}

#[tauri::command]
pub fn transmit_history_time_range(session_id: String) -> Result<Option<(i64, i64)>, String> {
    Ok(with_db(None, |conn| session_time_range(conn, &session_id)))
}

#[tauri::command]
pub fn transmit_history_find_offset(session_id: String, timestamp_us: i64) -> Result<i64, String> {
    Ok(with_db(0, |conn| session_offset_after(conn, &session_id, timestamp_us)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history_with(rows: &[(&str, i64)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        for (session_id, timestamp_us) in rows {
            conn.execute(
                "INSERT INTO transmit_history (session_id, timestamp_us, kind, bytes) VALUES (?1, ?2, 'can', x'00')",
                params![session_id, timestamp_us],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn a_session_reads_only_its_own_history() {
        let conn = history_with(&[("mine", 10), ("agent", 20), ("mine", 30), ("agent", 40)]);
        assert_eq!(session_count(&conn, "mine"), 2);
        let stamps: Vec<i64> = session_rows(&conn, "mine", 0, 10).iter().map(|r| r.timestamp_us).collect();
        assert_eq!(stamps, vec![30, 10]);
        assert_eq!(session_time_range(&conn, "mine"), Some((10, 30)));
        assert_eq!(session_offset_after(&conn, "mine", 10), 1);
        assert_eq!(session_count(&conn, "none"), 0);
        assert_eq!(session_time_range(&conn, "none"), None);
    }

    #[test]
    fn clearing_a_session_leaves_the_others_history() {
        let conn = history_with(&[("mine", 10), ("agent", 20)]);
        clear_session(&conn, "mine");
        assert_eq!(session_count(&conn, "mine"), 0);
        assert_eq!(session_count(&conn, "agent"), 1);
    }
}
