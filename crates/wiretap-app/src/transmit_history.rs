// ui/crates/wiretap-app/src/transmit_history.rs
//
// SQLite-backed storage for transmit history.
// Records every transmitted frame (CAN or serial) from repeat loops and
// single-shot transmits so the frontend can display a scrollable, paginated
// history without unbounded Zustand array growth.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;
use wslib_db_sqlite::{Chain, Database};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/transmit_history");

static DB: OnceLock<Database> = OnceLock::new();

fn chain() -> Chain {
    Chain::new("transmit_history", &MIGRATOR)
}

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
    std::fs::create_dir_all(data_dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    let db = crate::blocking::wait(Database::open(data_dir.join("transmit_history.db"), &[chain()]))
        .map_err(|e| format!("Failed to open transmit history database: {e}"))?;
    DB.set(db).map_err(|_| "Transmit history database already initialised".to_string())
}

// ============================================================================
// Write / Query / Clear
// ============================================================================

/// Insert a single transmit history entry; a failure is logged, not returned.
pub async fn write_entry(
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
) {
    let Some(db) = DB.get() else { return };
    let timestamp_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as i64;
    let result = sqlx::query(
        "INSERT INTO transmit_history \
         (session_id, timestamp_us, kind, frame_id, dlc, bytes, bus, is_extended, is_fd, success, error_msg) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )
    .bind(session_id)
    .bind(timestamp_us)
    .bind(kind)
    .bind(frame_id)
    .bind(dlc)
    .bind(bytes)
    .bind(bus)
    .bind(is_extended)
    .bind(is_fd)
    .bind(success)
    .bind(error_msg)
    .execute(db.pool())
    .await;
    if let Err(e) = result {
        tlog!("[transmit_history] INSERT failed: {}", e);
    }
}

#[cfg(test)]
async fn scratch_database() -> Database {
    static NEXT: AtomicI64 = AtomicI64::new(0);
    let dir = std::env::temp_dir().join(format!("wiretap-transmit-tests-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    Database::open(dir.join(format!("{n}.db")), &[chain()]).await.unwrap()
}

#[cfg(test)]
pub(crate) fn use_in_memory_database() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        let _ = DB.set(crate::blocking::wait(scratch_database()));
    });
}

static REVISION: AtomicI64 = AtomicI64::new(0);

/// The `TransmitUpdated` signal for a history write or clear: a row count can repeat, this cannot.
pub fn next_revision() -> i64 {
    REVISION.fetch_add(1, Ordering::Relaxed) + 1
}

/// Logs a failed read and answers `fallback`, as a missing database does.
async fn read<T>(fallback: T, query: impl AsyncFnOnce(&SqlitePool) -> sqlx::Result<T>) -> T {
    let Some(db) = DB.get() else { return fallback };
    query(db.pool()).await.unwrap_or_else(|e| {
        tlog!("[transmit_history] query failed: {}", e);
        fallback
    })
}

async fn clear_session(pool: &SqlitePool, session_id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM transmit_history WHERE session_id = ?1")
        .bind(session_id)
        .execute(pool)
        .await
        .map(drop)
}

async fn session_count(pool: &SqlitePool, session_id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM transmit_history WHERE session_id = ?1")
        .bind(session_id)
        .fetch_one(pool)
        .await
}

/// Return up to `limit` of the session's rows, newest first, starting at `offset`.
///
/// Unsigned deliberately, matching the capture readers: SQLite reads a negative `LIMIT`
/// as *no limit*, so a bad value would quietly return the whole table instead of erroring.
async fn session_rows(
    pool: &SqlitePool,
    session_id: &str,
    offset: usize,
    limit: usize,
) -> sqlx::Result<Vec<TransmitHistoryRow>> {
    sqlx::query(
        "SELECT id, session_id, timestamp_us, kind, frame_id, dlc, bytes, \
         bus, is_extended, is_fd, success, error_msg \
         FROM transmit_history WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3",
    )
    .bind(session_id)
    .bind(limit as i64)
    .bind(offset as i64)
    .try_map(|row: sqlx::sqlite::SqliteRow| {
        Ok(TransmitHistoryRow {
            id: row.try_get(0)?,
            session_id: row.try_get(1)?,
            timestamp_us: row.try_get(2)?,
            kind: row.try_get(3)?,
            frame_id: row.try_get(4)?,
            dlc: row.try_get(5)?,
            bytes: row.try_get(6)?,
            bus: row.try_get(7)?,
            is_extended: row.try_get(8)?,
            is_fd: row.try_get(9)?,
            success: row.try_get(10)?,
            error_msg: row.try_get(11)?,
        })
    })
    .fetch_all(pool)
    .await
}

async fn session_time_range(pool: &SqlitePool, session_id: &str) -> sqlx::Result<Option<(i64, i64)>> {
    let (min, max): (Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT MIN(timestamp_us), MAX(timestamp_us) FROM transmit_history WHERE session_id = ?1")
            .bind(session_id)
            .fetch_one(pool)
            .await?;
    Ok(min.zip(max))
}

/// The row offset of `timestamp_us` in `session_rows`' newest-first order.
async fn session_offset_after(pool: &SqlitePool, session_id: &str, timestamp_us: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM transmit_history WHERE session_id = ?1 AND timestamp_us > ?2")
        .bind(session_id)
        .bind(timestamp_us)
        .fetch_one(pool)
        .await
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn transmit_history_query(session_id: String, offset: usize, limit: usize) -> Result<Vec<TransmitHistoryRow>, String> {
    Ok(read(vec![], async |pool| session_rows(pool, &session_id, offset, limit).await).await)
}

#[tauri::command]
pub async fn transmit_history_count(session_id: String) -> Result<i64, String> {
    Ok(read(0, async |pool| session_count(pool, &session_id).await).await)
}

#[tauri::command]
pub async fn transmit_history_clear(session_id: String) -> Result<i64, String> {
    Ok(clear_and_announce(&session_id).await)
}

async fn clear_and_announce(session_id: &str) -> i64 {
    read((), async |pool| clear_session(pool, session_id).await).await;
    let revision = next_revision();
    crate::ws::dispatch::send_transmit_updated(revision);
    revision
}

#[tauri::command]
pub async fn transmit_history_time_range(session_id: String) -> Result<Option<(i64, i64)>, String> {
    Ok(read(None, async |pool| session_time_range(pool, &session_id).await).await)
}

#[tauri::command]
pub async fn transmit_history_find_offset(session_id: String, timestamp_us: i64) -> Result<i64, String> {
    Ok(read(0, async |pool| session_offset_after(pool, &session_id, timestamp_us).await).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn history_with(rows: &[(&str, i64)]) -> Database {
        let db = scratch_database().await;
        for (session_id, timestamp_us) in rows {
            sqlx::query("INSERT INTO transmit_history (session_id, timestamp_us, kind, bytes) VALUES (?1, ?2, 'can', x'00')")
                .bind(session_id)
                .bind(timestamp_us)
                .execute(db.pool())
                .await
                .unwrap();
        }
        db
    }

    #[tokio::test]
    async fn a_session_reads_only_its_own_history() {
        let db = history_with(&[("mine", 10), ("agent", 20), ("mine", 30), ("agent", 40)]).await;
        let pool = db.pool();
        assert_eq!(session_count(pool, "mine").await.unwrap(), 2);
        let stamps: Vec<i64> = session_rows(pool, "mine", 0, 10).await.unwrap().iter().map(|r| r.timestamp_us).collect();
        assert_eq!(stamps, vec![30, 10]);
        assert_eq!(session_time_range(pool, "mine").await.unwrap(), Some((10, 30)));
        assert_eq!(session_offset_after(pool, "mine", 10).await.unwrap(), 1);
        assert_eq!(session_count(pool, "none").await.unwrap(), 0);
        assert_eq!(session_time_range(pool, "none").await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_clear_then_a_write_never_repeats_a_history_signal() {
        use_in_memory_database();
        async fn write(session_id: &str) -> i64 {
            write_entry(session_id, "can", Some(0x100), Some(1), &[1], 0, false, false, true, None).await;
            next_revision()
        }
        let signals = [
            write("signal_mine").await,
            clear_and_announce("signal_mine").await,
            write("signal_agent").await,
        ];
        assert!(signals[0] < signals[1] && signals[1] < signals[2], "signals repeated: {signals:?}");
    }

    #[tokio::test]
    async fn clearing_a_session_leaves_the_others_history() {
        let db = history_with(&[("mine", 10), ("agent", 20)]).await;
        clear_session(db.pool(), "mine").await.unwrap();
        assert_eq!(session_count(db.pool(), "mine").await.unwrap(), 0);
        assert_eq!(session_count(db.pool(), "agent").await.unwrap(), 1);
    }
}
