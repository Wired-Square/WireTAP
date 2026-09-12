// ui/src-tauri/src/capture_db.rs
//
// SQLite-backed storage for capture frame and byte data.
// Replaces the in-memory Vec<FrameMessage> / Vec<TimestampedByte> storage
// to prevent OOM crashes during long captures.
//
// The public API of capture_store.rs is unchanged — this module provides
// the underlying storage layer only.
//
// Schema changes MUST be recorded migrations — see
// docs/capture-db-migrations.md. Never issue ad-hoc DDL from feature code.

use once_cell::sync::Lazy;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

use crate::capture_store::{CaptureFrameInfo, CaptureMetadata, CaptureKind, FrameSelection, TimestampedByte};
use crate::io::FrameMessage;

/// Global database connection, protected by a Mutex.
/// rusqlite::Connection is !Sync, so we use Mutex (not RwLock).
static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

/// Table creation only. Indexes are created in a separate step AFTER the
/// buffer→capture migration, because pre-migration legacy databases have
/// `buffer_id` columns that our new index definitions can't reference yet.
const SCHEMA_TABLES_SQL: &str = "
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
";

/// Index creation — runs AFTER the buffer→capture migration has renamed
/// columns on the `frames` and `bytes` tables.
const SCHEMA_INDEXES_SQL: &str = "
CREATE INDEX IF NOT EXISTS idx_frames_capture_ts ON frames (capture_id, timestamp_us);
CREATE INDEX IF NOT EXISTS idx_frames_capture_fid ON frames (capture_id, frame_id);
CREATE INDEX IF NOT EXISTS idx_bytes_capture_ts ON bytes (capture_id, timestamp_us);
";

/// True when `table` has a column named `col`. A missing table yields an
/// empty `pragma_table_info` set, i.e. `false`.
fn has_column(conn: &Connection, table: &str, col: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        params![table, col],
        |row| row.get(0),
    )
    .map_err(|e| format!("Failed to inspect {table} schema: {}", e))
}

// ============================================================================
// Schema migrations
//
// Recorded, run-once migrations. `PRAGMA user_version` is the authoritative
// gate; the `schema_migrations` table is the human-queryable audit trail
// (version, name, applied_at). Each migration is applied in its own
// transaction together with its audit row and version stamp, so a crash can
// never leave a step half-applied or applied-but-unrecorded.
//
// ALL schema changes go through this mechanism — see
// docs/capture-db-migrations.md for how to add a migration and the rules
// (never edit or renumber a shipped migration; never infer state from
// schema shape).
// ============================================================================

enum MigrationStep {
    /// Conditional logic SQL can't express. Avoid for new migrations —
    /// prefer `Sql` so the change is reviewable as plain text.
    Rust(fn(&rusqlite::Transaction) -> Result<(), String>),
    /// A migration file from `src-tauri/migrations/`, applied verbatim.
    Sql(&'static str),
}

struct Migration {
    version: i64,
    name: &'static str,
    step: MigrationStep,
}

/// All migrations, ascending and contiguous from version 1.
/// `user_version` 0 = unstamped (any pre-versioning shape).
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "baseline_capture_schema",
        step: MigrationStep::Rust(baseline_capture_schema),
    },
    Migration {
        version: 2,
        name: "frames_capture_rowid_index",
        step: MigrationStep::Sql(include_str!("../migrations/0002_frames_capture_rowid_index.sql")),
    },
    Migration {
        version: 3,
        name: "frames_fid_protocol_index",
        step: MigrationStep::Sql(include_str!("../migrations/0003_frames_fid_protocol_index.sql")),
    },
];

fn schema_version(conn: &Connection) -> Result<i64, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("Failed to read schema version: {}", e))
}

/// Apply every migration newer than the database's stamped version.
fn run_migrations(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             applied_at INTEGER NOT NULL
         );",
    )
    .map_err(|e| format!("Failed to create schema_migrations table: {}", e))?;

    let current = schema_version(conn)?;
    for m in MIGRATIONS {
        if m.version <= current {
            continue;
        }
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to begin migration {} transaction: {}", m.version, e))?;

        match m.step {
            MigrationStep::Rust(f) => f(&tx)
                .map_err(|e| format!("Migration {} ({}) failed: {}", m.version, m.name, e))?,
            MigrationStep::Sql(sql) => tx
                .execute_batch(sql)
                .map_err(|e| format!("Migration {} ({}) failed: {}", m.version, m.name, e))?,
        }

        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at)
             VALUES (?1, ?2, strftime('%s','now'))",
            params![m.version, m.name],
        )
        .map_err(|e| format!("Failed to record migration {}: {}", m.version, e))?;
        tx.pragma_update(None, "user_version", m.version)
            .map_err(|e| format!("Failed to stamp schema version {}: {}", m.version, e))?;
        tx.commit()
            .map_err(|e| format!("Failed to commit migration {}: {}", m.version, e))?;

        tlog!("[capture_db] Applied migration {} ({})", m.version, m.name);
    }
    Ok(())
}

/// Migration 1 — baseline. Normalises any unstamped database (fresh, legacy
/// `buffer_*`, fully migrated, or mixed-generation) to the v1 shape.
///
/// This is the one migration that must infer state from the schema itself:
/// pre-versioning databases carry no stamp, and a pre-rename build running
/// against an already-migrated file re-creates an empty legacy
/// `buffer_metadata` beside renamed tables (its CREATE TABLE IF NOT EXISTS).
/// Each object is therefore migrated on its own evidence; a blanket
/// "legacy detected → rename everything" aborts on the first
/// already-renamed column and rolls back, failing initialisation on every
/// launch of such a database.
fn baseline_capture_schema(tx: &rusqlite::Transaction) -> Result<(), String> {
    // Tables first (idempotent). Indexes are deferred until after the
    // buffer→capture normalisation because they reference the renamed
    // `capture_id` columns.
    tx.execute_batch(SCHEMA_TABLES_SQL)
        .map_err(|e| format!("Failed to create tables: {}", e))?;

    let has_legacy: bool = tx
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='buffer_metadata'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);

    if has_legacy {
        tlog!("[capture_db] Legacy buffer_* schema detected — normalising to capture_*");

        // Legacy indexes reference the old column names; they are recreated
        // below under the new `idx_*_capture_*` names.
        if has_column(tx, "frames", "buffer_id")? {
            tx.execute_batch(
                "ALTER TABLE frames RENAME COLUMN buffer_id TO capture_id;
                 DROP INDEX IF EXISTS idx_frames_buffer_ts;
                 DROP INDEX IF EXISTS idx_frames_buffer_fid;",
            )
            .map_err(|e| format!("Failed to migrate frames table: {}", e))?;
        }
        if has_column(tx, "bytes", "buffer_id")? {
            tx.execute_batch(
                "ALTER TABLE bytes RENAME COLUMN buffer_id TO capture_id;
                 DROP INDEX IF EXISTS idx_bytes_buffer_ts;",
            )
            .map_err(|e| format!("Failed to migrate bytes table: {}", e))?;
        }

        // Fold legacy metadata rows into `capture_metadata` (created by
        // SCHEMA_TABLES_SQL above if it didn't already exist), then drop the
        // legacy table. Row copy rather than table rename: in the mixed case
        // `capture_metadata` already holds migrated — possibly pinned —
        // captures that a drop-and-rename would destroy.
        tx.execute_batch(
            "INSERT OR IGNORE INTO capture_metadata
                 (capture_id, capture_kind, name, count, start_time_us, end_time_us,
                  created_at, owning_session_id)
             SELECT buffer_id, buffer_type, name, count, start_time_us, end_time_us,
                    created_at, owning_session_id
             FROM buffer_metadata;
             DROP TABLE buffer_metadata;",
        )
        .map_err(|e| format!("Failed to migrate capture metadata: {}", e))?;
    }

    tx.execute_batch(SCHEMA_INDEXES_SQL)
        .map_err(|e| format!("Failed to create indexes: {}", e))?;

    // Columns added after the original schema shipped; absent only on old
    // pre-rename databases (duplicate-column errors ignored).
    let _ = tx.execute(
        "ALTER TABLE capture_metadata ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = tx.execute(
        "ALTER TABLE capture_metadata ADD COLUMN buses TEXT NOT NULL DEFAULT '[]'",
        [],
    );

    Ok(())
}

// ============================================================================
// Initialisation
// ============================================================================

/// Initialise the capture database. Must be called once at app startup.
/// When `clear_on_start` is true, leftover data from previous sessions is deleted.
pub fn initialise(app_data_dir: &Path, clear_on_start: bool) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    let db_path = app_data_dir.join("buffers.db");
    let mut conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open capture database: {}", e))?;

    run_migrations(&mut conn)?;

    // Conditionally clear leftover data and reclaim disk space
    // Persistent (pinned) captures survive the clear.
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

/// Insert a batch of frames for a capture. Uses a single transaction.
pub fn insert_frames(capture_id: &str, frames: &[FrameMessage]) -> Result<(), String> {
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
                capture_id,
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

/// Insert a batch of timestamped bytes for a capture. Uses a single transaction.
pub fn insert_bytes(capture_id: &str, bytes: &[TimestampedByte]) -> Result<(), String> {
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
                capture_id,
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

/// Get paginated frames for a capture. Returns (frames, rowids).
pub fn get_frames_paginated(
    capture_id: &str,
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
        .query_map(params![capture_id, limit as i64, offset as i64], |row| {
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
    capture_id: &str,
    offset: usize,
    limit: usize,
    selection: &FrameSelection,
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize), String> {
    if selection.is_empty() {
        let (frames, rowids) = get_frames_paginated(capture_id, offset, limit)?;
        let total = get_frame_count(capture_id)?;
        return Ok((frames, rowids, total));
    }

    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;
    get_frames_paginated_filtered_with_conn(conn, capture_id, offset, limit, selection)
}

fn get_frames_paginated_filtered_with_conn(
    conn: &Connection,
    capture_id: &str,
    offset: usize,
    limit: usize,
    selection: &FrameSelection,
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize), String> {
    let pairs = selection_json(selection);

    // Get total filtered count
    let total: usize = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM frames WHERE capture_id = ?1 {}", selection_predicate(2, selection)),
            params![capture_id, pairs],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))? as usize;

    // Get page
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 {} \
             ORDER BY rowid LIMIT ?2 OFFSET ?3",
            selection_predicate(4, selection)
        ))
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![capture_id, limit as i64, offset as i64, pairs], |row| {
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

/// Column list for every `SELECT` feeding `row_to_frame_with_rowid`. Kept in one place
/// because the mapper reads by position — a mismatch is a runtime error, not a build one.
const FRAME_COLUMNS: &str =
    "rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction";

/// Restrict a frame query to a selection: the identity pair rather than the bare
/// id — CAN 0x100 and Modbus register 256 are different frames — and, for a
/// protocol selected whole, the protocol alone.
///
/// The selection rides in as one bound JSON parameter rather than an interpolated list,
/// which buys three things: the SQL text is constant per shape, so `prepare_cached`
/// hits whatever the selection is; there is no parameter-count ceiling; and protocol,
/// being TEXT, is bound rather than quoted into the statement. The text follows the
/// shape because the planner does not: a pair-only selection seeks
/// `idx_frames_capture_fid` as a covering index, and an `OR` on the protocol arm
/// turns that seek into a scan of the capture for every caller.
fn selection_predicate(param: usize, selection: &FrameSelection) -> String {
    let by_pair = format!(
        "(frame_id, protocol) IN (SELECT j.value ->> 0, j.value ->> 1 FROM json_each(?{param}, '$.pairs') j)"
    );
    let by_protocol = format!("protocol IN (SELECT value FROM json_each(?{param}, '$.protocols'))");
    match (selection.protocols().is_empty(), selection.pairs().is_empty()) {
        (true, _) => format!("AND {by_pair}"),
        (false, true) => format!("AND {by_protocol}"),
        (false, false) => format!("AND ({by_protocol} OR {by_pair})"),
    }
}

/// `{"protocols": [...], "pairs": [[frame_id, protocol], …]}` for
/// [`selection_predicate`]'s bound parameter.
fn selection_json(selection: &FrameSelection) -> String {
    serde_json::json!({ "protocols": selection.protocols(), "pairs": selection.pairs() }).to_string()
}

/// Run a `... ORDER BY rowid DESC LIMIT n` tail query and return it chronologically.
fn collect_tail(
    stmt: &mut rusqlite::CachedStatement<'_>,
    params: &[&dyn rusqlite::ToSql],
    limit: usize,
) -> Result<(Vec<FrameMessage>, Vec<i64>), String> {
    let rows = stmt
        .query_map(params, row_to_frame_with_rowid)
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
    Ok((frames, rowids))
}

/// Get the last N frames for a capture, unfiltered. Returns (frames, rowids) in
/// chronological order (oldest first).
///
/// Rows only — the caller supplies the total and end time from the capture registry,
/// which already tracks both. Used by the live view, which refetches on every
/// frame-count signal, so this must not scan the capture.
pub fn get_frames_tail_rows(
    capture_id: &str,
    limit: usize,
) -> Result<(Vec<FrameMessage>, Vec<i64>), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 ORDER BY rowid DESC LIMIT ?2"
        ))
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    collect_tail(&mut stmt, params![capture_id, limit as i64], limit)
}

/// Get the last N frames for a capture, restricted to `frame_ids` (which must not be
/// empty — use `get_frames_tail_rows` otherwise). Returns (frames, rowids, total_matching).
/// Frames are returned in chronological order (oldest first).
pub fn get_frames_tail_filtered(
    capture_id: &str,
    limit: usize,
    selection: &FrameSelection,
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;
    get_frames_tail_filtered_with_conn(conn, capture_id, limit, selection)
}

fn get_frames_tail_filtered_with_conn(
    conn: &Connection,
    capture_id: &str,
    limit: usize,
    selection: &FrameSelection,
) -> Result<(Vec<FrameMessage>, Vec<i64>, usize), String> {
    debug_assert!(!selection.is_empty(), "caller must use get_frames_tail_rows instead");
    let pairs = selection_json(selection);

    let total: usize = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM frames WHERE capture_id = ?1 {}", selection_predicate(2, selection)),
            params![capture_id, pairs],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))? as usize;

    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 {} \
             ORDER BY rowid DESC LIMIT ?2",
            selection_predicate(3, selection)
        ))
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let (frames, rowids) = collect_tail(&mut stmt, params![capture_id, limit as i64, pairs], limit)?;
    Ok((frames, rowids, total))
}

/// Get total frame count for a capture.
pub fn get_frame_count(capture_id: &str) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM frames WHERE capture_id = ?1",
            params![capture_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
}

/// Get unique frame info via aggregation query.
pub fn get_frame_info(capture_id: &str) -> Result<Vec<CaptureFrameInfo>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT protocol, frame_id, MAX(dlc) as max_dlc, MIN(bus) as bus, MAX(is_extended) as is_extended,
                    (MIN(dlc) != MAX(dlc)) as has_dlc_mismatch
             FROM frames WHERE capture_id = ?1 GROUP BY protocol, frame_id",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![capture_id], |row| {
            Ok(CaptureFrameInfo {
                protocol: row.get::<_, String>("protocol")?,
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

/// Format a frame id as hex with the conventional padding (3 nibbles for
/// standard ids, 8 for extended), matching the frontend's `formatFrameId`.
pub fn hex_id(id: u32, is_extended: bool) -> String {
    let width = if is_extended { 8 } else { 3 };
    format!("0x{:0width$X}", id, width = width)
}

/// One frame identity in a source, with its rollup.
///
/// Identity is (protocol, frame_id, is_extended): CAN `0x100` and Modbus
/// register 256 are different frames that happen to share a number, and a
/// standard id is not its extended namesake. This is the shape every source
/// reports, and the one the MCP `frame_inventory` tool serialises.
#[derive(Debug, Clone, Serialize)]
pub struct InventoryRow {
    pub protocol: String,
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub is_extended: bool,
    pub count: i64,
    pub first_us: i64,
    pub last_us: i64,
    pub max_dlc: u8,
}

impl InventoryRow {
    pub fn new(
        protocol: &str,
        frame_id: u32,
        is_extended: bool,
        count: i64,
        first_us: i64,
        last_us: i64,
        max_dlc: u8,
    ) -> Self {
        Self {
            protocol: protocol.to_string(),
            frame_id,
            frame_id_hex: hex_id(frame_id, is_extended),
            is_extended,
            count,
            first_us,
            last_us,
            max_dlc,
        }
    }
}

/// Per-frame-id rollup for a capture. Optional time bounds in microseconds.
pub fn frame_inventory(
    capture_id: &str,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<Vec<InventoryRow>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;
    frame_inventory_with_conn(conn, capture_id, start_us, end_us)
}

fn frame_inventory_with_conn(
    conn: &Connection,
    capture_id: &str,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<Vec<InventoryRow>, String> {
    let mut sql = String::from(
        "SELECT protocol, frame_id, is_extended, COUNT(*) AS cnt, \
         MIN(timestamp_us) AS first_us, MAX(timestamp_us) AS last_us, MAX(dlc) AS max_dlc \
         FROM frames WHERE capture_id = ?1",
    );
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(capture_id.to_string())];
    let mut idx = 2;
    if let Some(s) = start_us {
        sql.push_str(&format!(" AND timestamp_us >= ?{}", idx));
        bind.push(Box::new(s));
        idx += 1;
    }
    if let Some(e) = end_us {
        sql.push_str(&format!(" AND timestamp_us < ?{}", idx));
        bind.push(Box::new(e));
    }
    sql.push_str(
        " GROUP BY protocol, frame_id, is_extended ORDER BY frame_id, protocol, is_extended",
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Failed to prepare: {}", e))?;
    let refs: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(refs), |row| {
            Ok(InventoryRow::new(
                &row.get::<_, String>("protocol")?,
                row.get::<_, i64>("frame_id")? as u32,
                row.get::<_, i64>("is_extended")? != 0,
                row.get::<_, i64>("cnt")?,
                row.get::<_, i64>("first_us")?,
                row.get::<_, i64>("last_us")?,
                row.get::<_, i64>("max_dlc")? as u8,
            ))
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(out)
}

/// Pick at most `limit` items spread evenly across `items`.
///
/// Ceiling division on the step, not floor: a step of 1 over 5,001 items with a
/// limit of 5,000 would return the first 5,000 and drop the tail, which is the
/// same end-of-recording bias in the other direction.
fn strided<T: Copy>(items: &[T], limit: u32) -> Vec<T> {
    let limit = limit.max(1) as usize;
    if items.len() <= limit {
        return items.to_vec();
    }
    items.iter().step_by(items.len().div_ceil(limit)).copied().collect()
}

/// Up to `sample_limit` payloads for one frame, spread evenly across everything
/// the capture holds for it. `protocol` is the identity's other half; `None`
/// matches any, which is what a caller holding only a numeric id can ask for.
/// See [`InventoryRow`] for why the pair is the identity.
///
/// A tail query (`ORDER BY rowid DESC LIMIT n`) confines the analysis to the end
/// of the recording, which for anything that samples again afterwards is a
/// different answer than striding the whole population — the two doors onto the
/// checksum scan disagreed for exactly that reason.
///
/// Two passes rather than one window function. `ROW_NUMBER() OVER (ORDER BY
/// rowid)` costs a temp b-tree sort of every matching row even though index
/// entries within an equality span are already rowid-ordered, and that sort
/// dominated the query — measured at 7x the cost of taking the rowids from the
/// covering index, striding them here, and reading back only the payloads that
/// survived. Passing `is_extended` costs a row lookup per row for the same
/// reason (it is not in `idx_frames_capture_fid`), so callers that know a frame
/// id is unambiguous should leave it `None`.
pub fn sample_frame_payloads(
    capture_id: &str,
    protocol: Option<&str>,
    frame_id: u32,
    is_extended: Option<bool>,
    sample_limit: u32,
) -> Result<Vec<Vec<u8>>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;
    sample_frame_payloads_with_conn(conn, capture_id, protocol, frame_id, is_extended, sample_limit)
}

fn sample_frame_payloads_with_conn(
    conn: &Connection,
    capture_id: &str,
    protocol: Option<&str>,
    frame_id: u32,
    is_extended: Option<bool>,
    sample_limit: u32,
) -> Result<Vec<Vec<u8>>, String> {
    let mut filter = String::from("capture_id = ?1 AND frame_id = ?2");
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> =
        vec![Box::new(capture_id.to_string()), Box::new(frame_id as i64)];
    if let Some(p) = protocol {
        filter.push_str(&format!(" AND protocol = ?{}", bind.len() + 1));
        bind.push(Box::new(p.to_string()));
    }
    if let Some(ext) = is_extended {
        filter.push_str(&format!(" AND is_extended = ?{}", bind.len() + 1));
        bind.push(Box::new(ext as i32));
    }

    let mut stmt = conn
        .prepare_cached(&format!("SELECT rowid FROM frames WHERE {filter} ORDER BY rowid"))
        .map_err(|e| format!("Failed to prepare: {}", e))?;
    let refs: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(rusqlite::params_from_iter(refs), |row| row.get::<_, i64>(0))
        .map_err(|e| format!("Failed to query: {}", e))?;
    let mut rowids = Vec::new();
    for r in rows {
        rowids.push(r.map_err(|e| format!("Failed to read row: {}", e))?);
    }

    let picked = strided(&rowids, sample_limit);
    if picked.is_empty() {
        return Ok(Vec::new());
    }
    // One bound JSON parameter rather than an interpolated list, the idiom
    // `selection_predicate` already uses: constant SQL text so `prepare_cached`
    // hits, and no ceiling on how many rowids a caller may ask for.
    let json = serde_json::to_string(&picked).map_err(|e| format!("Failed to encode: {}", e))?;
    query_payloads_with_conn(
        conn,
        "SELECT payload FROM frames WHERE rowid IN (SELECT value FROM json_each(?1)) ORDER BY rowid",
        &[&json],
    )
}

/// Find the offset (row count) for a given timestamp, optionally filtered by frame IDs.
pub fn find_offset_for_timestamp(
    capture_id: &str,
    target_us: u64,
    selection: &FrameSelection,
) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let sql = format!(
        "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND timestamp_us < ?2 {}",
        if selection.is_empty() { String::new() } else { selection_predicate(3, selection) }
    );
    let count: i64 = if selection.is_empty() {
        conn.query_row(&sql, params![capture_id, target_us as i64], |row| row.get(0))
    } else {
        conn.query_row(&sql, params![capture_id, target_us as i64, selection_json(selection)], |row| {
            row.get(0)
        })
    }
    .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
}

/// Search frames in a capture for a text query, returning 0-based offsets in the
/// selected-ID-filtered result set.
///
/// `query` must have whitespace stripped by the caller.
/// `search_id` matches against the hex representation of frame_id.
/// `search_data` matches against the hex representation of the payload BLOB.
/// `selection` filters which frames are included (empty = all frames).
pub fn search_frames(
    capture_id: &str,
    query: &str,
    search_id: bool,
    search_data: bool,
    selection: &FrameSelection,
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

    let id_filter = if selection.is_empty() {
        String::new()
    } else {
        format!(" {}", selection_predicate(2, selection))
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

    let offset_of = |row: &rusqlite::Row| row.get::<_, i64>(0);
    let rows = if selection.is_empty() {
        stmt.query_map(params![capture_id], offset_of)
    } else {
        stmt.query_map(params![capture_id, selection_json(selection)], offset_of)
    }
    .map_err(|e| format!("Failed to execute search: {}", e))?;

    let mut offsets = Vec::new();
    for row in rows {
        offsets.push(row.map_err(|e| format!("Failed to read row: {}", e))? as usize);
    }

    Ok(offsets)
}

/// Copy all frame and byte data from one capture to another using INSERT SELECT.
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

/// Delete all data for a specific capture.
pub fn delete_capture_data(capture_id: &str) -> Result<(), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    conn.execute("DELETE FROM frames WHERE capture_id = ?1", params![capture_id])
        .map_err(|e| format!("Failed to delete frames: {}", e))?;
    conn.execute("DELETE FROM bytes WHERE capture_id = ?1", params![capture_id])
        .map_err(|e| format!("Failed to delete bytes: {}", e))?;

    Ok(())
}

/// Clear and refill a capture with new frames (used by framing to reuse capture IDs).
pub fn clear_and_refill(capture_id: &str, frames: &[FrameMessage]) -> Result<(), String> {
    let mut guard = DB.lock().unwrap();
    let conn = guard.as_mut().ok_or("Database not initialised")?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin transaction: {}", e))?;

    tx.execute("DELETE FROM frames WHERE capture_id = ?1", params![capture_id])
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
                capture_id,
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

/// Get all frames for a capture (loads everything — use sparingly).
pub fn get_all_frames(capture_id: &str) -> Result<Vec<FrameMessage>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 ORDER BY rowid",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![capture_id], |row| row_to_frame(row))
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut frames = Vec::new();
    for row in rows {
        frames.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(frames)
}

/// The newest frame per identity in a capture — one row per `(protocol, frame_id)`.
///
/// For a Modbus sweep this is the whole point: the scanner writes every register
/// once per pass, so a 20-pass sweep of 4096 registers is ~80k rows for a result
/// that is 4096 values. Reading them all and keeping the last of each is the same
/// answer for 20× the rows over IPC, so the reduction belongs here, next to
/// `get_frame_info`, which already groups the same way.
pub fn get_latest_frames(capture_id: &str) -> Result<Vec<FrameMessage>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames
             WHERE rowid IN (
                 SELECT MAX(rowid) FROM frames WHERE capture_id = ?1 GROUP BY protocol, frame_id
             )
             ORDER BY frame_id",
        )
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![capture_id], |row| row_to_frame(row))
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut frames = Vec::new();
    for row in rows {
        frames.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(frames)
}

// ============================================================================
// Capture Reader Streaming (chunked reads for playback)
// ============================================================================

/// Read a chunk of frames starting after the given rowid (forward).
/// Returns Vec of (rowid, FrameMessage) for position tracking.
pub fn read_frame_chunk(
    capture_id: &str,
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
        .query_map(params![capture_id, after_rowid, limit as i64], |row| {
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
    capture_id: &str,
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
        .query_map(params![capture_id, before_rowid, limit as i64], |row| {
            row_to_frame_with_rowid(row)
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut result = Vec::with_capacity(limit);
    for row in rows {
        result.push(row.map_err(|e| format!("Failed to read row: {}", e))?);
    }
    Ok(result)
}

/// Get min and max rowid for a capture (for determining bounds).
pub fn get_rowid_range(capture_id: &str) -> Result<Option<(i64, i64)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let result: Option<(i64, i64)> = conn
        .query_row(
            "SELECT MIN(rowid), MAX(rowid) FROM frames WHERE capture_id = ?1",
            params![capture_id],
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
    capture_id: &str,
    timestamp_us: u64,
) -> Result<Option<i64>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let result: Option<i64> = conn
        .query_row(
            "SELECT rowid FROM frames WHERE capture_id = ?1 AND timestamp_us >= ?2 ORDER BY timestamp_us ASC, rowid ASC LIMIT 1",
            params![capture_id, timestamp_us as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query: {}", e))?;

    Ok(result)
}


/// Get the frame at a specific index (0-based) within a capture.
/// Returns (rowid, FrameMessage) or None if index out of bounds.
pub fn get_frame_at_index(
    capture_id: &str,
    index: usize,
) -> Result<Option<(i64, FrameMessage)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let result = conn
        .query_row(
            "SELECT rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, source_address, incomplete, direction
             FROM frames WHERE capture_id = ?1 ORDER BY rowid LIMIT 1 OFFSET ?2",
            params![capture_id, index as i64],
            |row| row_to_frame_with_rowid(row),
        )
        .optional()
        .map_err(|e| format!("Failed to query: {}", e))?;

    Ok(result)
}

/// Get the next (or previous) frame matching an optional filter, starting after (or before) a given rowid.
/// Returns (rowid, frame_index, FrameMessage) where frame_index is the 0-based position.
pub fn get_next_filtered_frame(
    capture_id: &str,
    current_rowid: i64,
    selection: &FrameSelection,
    backward: bool,
) -> Result<Option<(i64, usize, FrameMessage)>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let (op, order) = if backward {
        ("<", "DESC")
    } else {
        (">", "ASC")
    };

    let sql = format!(
        "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 AND rowid {op} ?2 {} \
         ORDER BY rowid {order} LIMIT 1",
        if selection.is_empty() { String::new() } else { selection_predicate(3, selection) }
    );

    let row_result = if selection.is_empty() {
        conn.query_row(&sql, params![capture_id, current_rowid], row_to_frame_with_rowid)
    } else {
        conn.query_row(
            &sql,
            params![capture_id, current_rowid, selection_json(selection)],
            row_to_frame_with_rowid,
        )
    }
    .optional()
    .map_err(|e| format!("Failed to query: {}", e))?;

    if let Some((rowid, frame)) = row_result {
        // Compute the frame_index (0-based position within the capture)
        let frame_index: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND rowid < ?2",
                params![capture_id, rowid],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("Failed to count: {}", e))? as usize;

        Ok(Some((rowid, frame_index, frame)))
    } else {
        Ok(None)
    }
}

/// Count the number of frames before a given rowid in a capture (for computing 0-based frame index).
pub fn count_frames_before_rowid(capture_id: &str, rowid: i64) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND rowid < ?2",
            params![capture_id, rowid],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
}

// ============================================================================
// Byte Capture Operations
// ============================================================================

/// Columns every byte query selects, in the order [`row_to_byte`] reads them.
const BYTE_COLUMNS: &str = "byte_val, timestamp_us, bus";

fn row_to_byte(row: &rusqlite::Row) -> rusqlite::Result<TimestampedByte> {
    Ok(TimestampedByte {
        byte: row.get::<_, i64>(0)? as u8,
        timestamp_us: row.get::<_, i64>(1)? as u64,
        bus: row.get::<_, i64>(2)? as u8,
    })
}

fn collect_bytes(
    stmt: &mut rusqlite::CachedStatement<'_>,
    params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<TimestampedByte>, String> {
    stmt.query_map(params, row_to_byte)
        .map_err(|e| format!("Failed to query: {}", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("Failed to read row: {}", e))
}

/// Get paginated bytes for a capture. Returns (bytes, total_count).
pub fn get_bytes_paginated(
    capture_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<TimestampedByte>, usize), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;
    get_bytes_paginated_with_conn(conn, capture_id, offset, limit)
}

fn get_bytes_paginated_with_conn(
    conn: &Connection,
    capture_id: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<TimestampedByte>, usize), String> {
    let total: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM bytes WHERE capture_id = ?1",
            params![capture_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))? as usize;

    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {BYTE_COLUMNS} FROM bytes WHERE capture_id = ?1 ORDER BY rowid LIMIT ?2 OFFSET ?3"
        ))
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let bytes = collect_bytes(&mut stmt, params![capture_id, limit as i64, offset as i64])?;
    Ok((bytes, total))
}

/// Get the last N bytes for a capture, in chronological order (oldest first).
///
/// Rows only — the caller supplies the total from the capture registry, which already
/// tracks it. Used by the live view, which refetches on every byte-count signal, so
/// this must not scan the capture. `LIMIT ?2 OFFSET total - n` would walk every skipped
/// row on each call, which is quadratic over a session.
pub fn get_bytes_tail_rows(capture_id: &str, limit: usize) -> Result<Vec<TimestampedByte>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;
    get_bytes_tail_rows_with_conn(conn, capture_id, limit)
}

fn get_bytes_tail_rows_with_conn(
    conn: &Connection,
    capture_id: &str,
    limit: usize,
) -> Result<Vec<TimestampedByte>, String> {
    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {BYTE_COLUMNS} FROM bytes WHERE capture_id = ?1 ORDER BY rowid DESC LIMIT ?2"
        ))
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let mut bytes = collect_bytes(&mut stmt, params![capture_id, limit as i64])?;
    // Results came in DESC order, reverse to chronological
    bytes.reverse();
    Ok(bytes)
}

/// Get all bytes for a capture (used by framing which needs the full stream).
pub fn get_all_bytes(capture_id: &str) -> Result<Vec<TimestampedByte>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let mut stmt = conn
        .prepare_cached(&format!(
            "SELECT {BYTE_COLUMNS} FROM bytes WHERE capture_id = ?1 ORDER BY rowid"
        ))
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    collect_bytes(&mut stmt, params![capture_id])
}


// ============================================================================
// Raw query helpers (for capturequery.rs)
// ============================================================================

/// Execute a raw SQL query returning (timestamp_us, prev_payload, payload) tuples.
/// Used by capture_query_byte_changes and capture_query_frame_changes.
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
/// Used by capture_query_mirror_validation.
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

/// Query payloads only (single BLOB column) from the capture database.
pub fn query_payloads(
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<Vec<u8>>, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;
    query_payloads_with_conn(conn, sql, params)
}

fn query_payloads_with_conn(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<Vec<Vec<u8>>, String> {
    let mut stmt = conn
        .prepare_cached(sql)
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
/// Used by capture_query_pattern_search.
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

/// Find the byte offset for a given timestamp in a capture.
pub fn find_bytes_offset_for_timestamp(
    capture_id: &str,
    target_us: u64,
) -> Result<usize, String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM bytes WHERE capture_id = ?1 AND timestamp_us < ?2",
            params![capture_id, target_us as i64],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count: {}", e))?;

    Ok(count as usize)
}

// ============================================================================
// Capture Metadata Persistence
// ============================================================================

/// Upsert capture metadata into SQLite.
pub fn save_capture_metadata(meta: &CaptureMetadata) -> Result<(), String> {
    let guard = DB.lock().unwrap();
    let conn = guard.as_ref().ok_or("Database not initialised")?;

    let kind_str = meta.kind.as_str();

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
            let kind = CaptureKind::from_str(&kind_str);

            let buses_json: String = row.get::<_, String>("buses").unwrap_or_else(|_| "[]".to_string());
            let buses: Vec<u8> = serde_json::from_str(&buses_json).unwrap_or_default();

            Ok(CaptureMetadata {
                id: row.get("capture_id")?,
                kind,
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

/// Get distinct bus numbers from a capture's data.
/// Used to backfill bus metadata for captures created before bus tracking was added.
/// `table` should be "frames" or "bytes".
pub fn get_distinct_buses(capture_id: &str, table: &str) -> Result<Vec<u8>, String> {
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
        .query_map(params![capture_id], |row| row.get::<_, u8>(0))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_store::ProtocolFrames;

    /// The pre-rename schema as shipped before April 2026 — used to build
    /// legacy databases the baseline must normalise.
    const LEGACY_SCHEMA_SQL: &str = "
        CREATE TABLE buffer_metadata (
            buffer_id TEXT PRIMARY KEY,
            buffer_type TEXT NOT NULL,
            name TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            start_time_us INTEGER,
            end_time_us INTEGER,
            created_at INTEGER NOT NULL,
            owning_session_id TEXT
        );
        CREATE TABLE frames (
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
        CREATE TABLE bytes (
            rowid INTEGER PRIMARY KEY,
            buffer_id TEXT NOT NULL,
            byte_val INTEGER NOT NULL,
            timestamp_us INTEGER NOT NULL,
            bus INTEGER NOT NULL DEFAULT 0
        );
    ";

    fn version_of(conn: &Connection) -> i64 {
        schema_version(conn).unwrap()
    }

    /// A migrated capture `c1` holding the same numeric id under three protocols, plus a
    /// second CAN id. Rowids run in insertion order, so the tail sees them last-first.
    fn multi_protocol_capture() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
             VALUES ('c1', 'can',    10, 256, 0, 8, x'AA'),
                    ('c1', 'modbus', 20, 256, 0, 2, x'BB'),
                    ('c1', 'serial', 30, 256, 0, 1, x'CC'),
                    ('c1', 'can',    40, 257, 0, 8, x'DD');",
        )
        .unwrap();
        conn
    }

    /// A migrated capture `c1` holding `n` CAN frames of one id, each payload
    /// carrying its own position so a sample can be checked for spread.
    fn can_capture_of(n: i64) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        for i in 0..n {
            conn.execute(
                "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
                 VALUES ('c1', 'can', ?1, 256, 0, 1, ?2)",
                rusqlite::params![i, vec![i as u8]],
            )
            .unwrap();
        }
        conn
    }

    /// A migrated byte capture `b1` holding six bytes, plus a decoy capture whose rows
    /// must never appear in `b1`'s tail.
    fn byte_capture() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO bytes (capture_id, byte_val, timestamp_us, bus)
             VALUES ('b1', 10, 100, 0), ('b1', 11, 101, 0), ('b1', 12, 102, 1),
                    ('b1', 13, 103, 0), ('b1', 14, 104, 0), ('b1', 15, 105, 0),
                    ('b2', 99, 106, 0);",
        )
        .unwrap();
        conn
    }

    /// The tail must be the *last* N rows, chronological, scoped to one capture — the
    /// live byte view refetches this on every count signal.
    #[test]
    fn bytes_tail_returns_last_rows_chronologically() {
        let conn = byte_capture();

        let bytes = get_bytes_tail_rows_with_conn(&conn, "b1", 3).unwrap();

        assert_eq!(bytes.iter().map(|b| b.byte).collect::<Vec<_>>(), vec![13, 14, 15]);
        assert_eq!(bytes.iter().map(|b| b.timestamp_us).collect::<Vec<_>>(), vec![103, 104, 105]);
        assert_eq!(bytes[0].bus, 0);
    }

    /// A limit past the end returns the whole capture rather than padding or erroring.
    #[test]
    fn bytes_tail_limit_past_start_returns_all() {
        let conn = byte_capture();

        let bytes = get_bytes_tail_rows_with_conn(&conn, "b1", 100).unwrap();

        assert_eq!(bytes.len(), 6);
        assert_eq!(bytes.first().unwrap().byte, 10);
        assert_eq!(bytes.last().unwrap().byte, 15);
    }

    /// The tail and the equivalent page agree, so switching between live and stopped
    /// views cannot shift the rows under the reader.
    #[test]
    fn bytes_tail_matches_equivalent_page() {
        let conn = byte_capture();

        let tail = get_bytes_tail_rows_with_conn(&conn, "b1", 2).unwrap();
        let (page, total) = get_bytes_paginated_with_conn(&conn, "b1", 4, 2).unwrap();

        assert_eq!(total, 6);
        assert_eq!(
            tail.iter().map(|b| b.byte).collect::<Vec<_>>(),
            page.iter().map(|b| b.byte).collect::<Vec<_>>()
        );
    }

    fn selection(groups: &[(&str, &[u32])]) -> FrameSelection {
        FrameSelection::from_groups(
            groups.iter().map(|(protocol, ids)| ProtocolFrames::ids(*protocol, ids.to_vec())).collect(),
        )
    }

    fn whole(protocol: &str) -> FrameSelection {
        FrameSelection::from_groups(vec![ProtocolFrames::whole(protocol)])
    }

    /// A protocol tab asks for its protocol whole, ids it has seen or not: every
    /// row of that protocol and nothing of the others, in both the page and the tail.
    #[test]
    fn a_whole_protocol_selects_all_its_rows_and_no_others() {
        let conn = multi_protocol_capture();

        let (frames, _rowids, total) =
            get_frames_paginated_filtered_with_conn(&conn, "c1", 0, 50, &whole("can")).unwrap();
        assert_eq!(total, 2);
        assert_eq!(frames.iter().map(|f| f.frame_id).collect::<Vec<_>>(), vec![256, 257]);
        assert!(frames.iter().all(|f| f.protocol == "can"));

        let (tail, _rowids, total) =
            get_frames_tail_filtered_with_conn(&conn, "c1", 50, &whole("modbus")).unwrap();
        assert_eq!(total, 1);
        assert_eq!(tail[0].protocol, "modbus");

        // Whole and by-id combine in one predicate.
        let combined = FrameSelection::from_groups(vec![
            ProtocolFrames::whole("serial"),
            ProtocolFrames::ids("can", vec![257]),
        ]);
        let (frames, _rowids, total) =
            get_frames_paginated_filtered_with_conn(&conn, "c1", 0, 50, &combined).unwrap();
        assert_eq!(total, 2);
        let mut got: Vec<(&str, u32)> = frames.iter().map(|f| (f.protocol.as_str(), f.frame_id)).collect();
        got.sort_unstable();
        assert_eq!(got, vec![("can", 257), ("serial", 256)]);
    }

    /// The bug: a bare `frame_id IN (…)` filter matched CAN 0x100 and Modbus register 256
    /// against each other. Selecting one identity must return only that identity's rows.
    #[test]
    fn filtered_page_does_not_cross_protocols() {
        let conn = multi_protocol_capture();

        let (frames, _rowids, total) = get_frames_paginated_filtered_with_conn(
            &conn,
            "c1",
            0,
            50,
            &selection(&[("can", &[256])]),
        )
        .unwrap();

        assert_eq!(total, 1);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].protocol, "can");
        assert_eq!(frames[0].dlc, 8);
    }

    #[test]
    fn filtered_tail_does_not_cross_protocols() {
        let conn = multi_protocol_capture();

        let (frames, _rowids, total) =
            get_frames_tail_filtered_with_conn(&conn, "c1", 50, &selection(&[("modbus", &[256])]))
                .unwrap();

        assert_eq!(total, 1);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].protocol, "modbus");
    }

    /// The bug: sampling a "frame id" pulled CAN 0x100 and Modbus register 256
    /// into one payload set and analysed the mixture, which describes neither.
    #[test]
    fn sampled_payloads_do_not_cross_protocols() {
        let conn = multi_protocol_capture();

        let can = sample_frame_payloads_with_conn(&conn, "c1", Some("can"), 256, None, 100).unwrap();
        let modbus =
            sample_frame_payloads_with_conn(&conn, "c1", Some("modbus"), 256, None, 100).unwrap();

        assert_eq!(can, vec![vec![0xAA]]);
        assert_eq!(modbus, vec![vec![0xBB]]);
    }

    /// No protocol means any — the behaviour a caller holding only a numeric id
    /// gets, and what the byte-profile tool defaults to.
    #[test]
    fn sampled_payloads_without_a_protocol_span_all_of_them() {
        let conn = multi_protocol_capture();

        let all = sample_frame_payloads_with_conn(&conn, "c1", None, 256, None, 100).unwrap();

        assert_eq!(all, vec![vec![0xAA], vec![0xBB], vec![0xCC]]);
    }

    /// A capture of 100 frames sampled 10 at a time must describe the whole
    /// recording, not its first or last tenth. A tail query returned 90..=99;
    /// taking the first N returns 0..=9. Both are a different answer to the same
    /// question depending on which door the caller came in.
    #[test]
    fn sampling_strides_the_whole_capture() {
        let conn = can_capture_of(100);

        let sampled =
            sample_frame_payloads_with_conn(&conn, "c1", Some("can"), 256, None, 10).unwrap();

        let positions: Vec<u8> = sampled.iter().map(|p| p[0]).collect();
        assert_eq!(positions, vec![0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    }

    /// Ceiling division on the step, not floor: a floor step of 1 over 101 rows
    /// with a limit of 100 would return the first 100 and drop the tail.
    #[test]
    fn sampling_never_degenerates_into_the_first_n() {
        let conn = can_capture_of(101);

        let sampled =
            sample_frame_payloads_with_conn(&conn, "c1", Some("can"), 256, None, 100).unwrap();

        assert_eq!(sampled.first().unwrap()[0], 0);
        assert_eq!(sampled.last().unwrap()[0], 100);
    }

    /// A limit past the population returns every payload in capture order,
    /// rather than padding, erroring or striding something out.
    #[test]
    fn sampling_limit_past_the_end_returns_everything() {
        let conn = can_capture_of(40);

        let all = sample_frame_payloads_with_conn(&conn, "c1", Some("can"), 256, None, 500).unwrap();

        assert_eq!(all.len(), 40);
        assert_eq!(all.iter().map(|p| p[0]).collect::<Vec<u8>>(), (0..40u8).collect::<Vec<u8>>());
    }

    /// The inventory is what decides which groups the scan reads, so it has to
    /// split the identity pair too — otherwise the protocol filter below it
    /// never sees the Modbus row at all.
    #[test]
    fn inventory_reports_one_row_per_protocol() {
        let conn = multi_protocol_capture();

        let rows = frame_inventory_with_conn(&conn, "c1", None, None).unwrap();

        let for_256: Vec<(&str, i64)> = rows
            .iter()
            .filter(|r| r.frame_id == 256)
            .map(|r| (r.protocol.as_str(), r.count))
            .collect();
        assert_eq!(for_256, vec![("can", 1), ("modbus", 1), ("serial", 1)]);
        assert_eq!(rows.len(), 4);
    }

    /// The same numeric id under two protocols is two selectable frames, not one.
    #[test]
    fn selecting_one_id_on_two_protocols_returns_both() {
        let conn = multi_protocol_capture();

        let (frames, _rowids, total) = get_frames_paginated_filtered_with_conn(
            &conn,
            "c1",
            0,
            50,
            &selection(&[("can", &[256]), ("modbus", &[256])]),
        )
        .unwrap();

        assert_eq!(total, 2);
        let mut protocols: Vec<&str> = frames.iter().map(|f| f.protocol.as_str()).collect();
        protocols.sort_unstable();
        assert_eq!(protocols, vec!["can", "modbus"]);
    }

    /// Chronological order and paging still hold once the predicate is a pair.
    #[test]
    fn filtered_page_keeps_capture_order() {
        let conn = multi_protocol_capture();
        let all_can = selection(&[("can", &[256, 257])]);

        let (frames, _rowids, total) =
            get_frames_paginated_filtered_with_conn(&conn, "c1", 0, 50, &all_can).unwrap();
        assert_eq!(total, 2);
        assert_eq!(frames.iter().map(|f| f.frame_id).collect::<Vec<_>>(), vec![256, 257]);

        let (page_two, _rowids, total) =
            get_frames_paginated_filtered_with_conn(&conn, "c1", 1, 1, &all_can).unwrap();
        assert_eq!(total, 2);
        assert_eq!(page_two.iter().map(|f| f.frame_id).collect::<Vec<_>>(), vec![257]);
    }

    /// Protocol is TEXT, so it is bound rather than interpolated. A selection naming a
    /// protocol that does not exist matches nothing and leaves the table alone.
    #[test]
    fn protocol_is_bound_not_interpolated() {
        let conn = multi_protocol_capture();

        let (frames, _rowids, total) = get_frames_paginated_filtered_with_conn(
            &conn,
            "c1",
            0,
            50,
            &selection(&[("can'); DROP TABLE frames;--", &[256])]),
        )
        .unwrap();

        assert_eq!(total, 0);
        assert!(frames.is_empty());
        let survived: i64 = conn
            .query_row("SELECT COUNT(*) FROM frames", [], |r| r.get(0))
            .unwrap();
        assert_eq!(survived, 4);
    }

    /// The filtered COUNT is the only query the frame-id index covers, and one of the two
    /// runs on the live tail path twice a second. Reshaping the predicate must not cost
    /// it: a seek on the id, not a walk of the capture — which is what an `OR` on the
    /// protocol arm produced, at 200× the cost, while still reading as "covering".
    #[test]
    fn filtered_count_uses_the_covering_index() {
        let conn = multi_protocol_capture();
        let by_id = selection(&[("can", &[256])]);

        let plan: String = conn
            .query_row(
                &format!(
                    "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM frames WHERE capture_id = 'c1' {}",
                    selection_predicate(1, &by_id)
                ),
                params![selection_json(&by_id)],
                |row| row.get(3),
            )
            .unwrap();

        assert!(
            plan.contains("COVERING INDEX idx_frames_capture_fid") && plan.contains("frame_id=?"),
            "filtered count should seek the id on the covering index, got: {plan}"
        );
    }

    /// The rowid pass is the one that reads every row of a frame id, so it has
    /// to stay on the index. Two things take it off: filtering on `is_extended`,
    /// which is not in `idx_frames_capture_fid` and so forces a row lookup per
    /// row, and a `ROW_NUMBER() OVER (ORDER BY rowid)` window, which sorts the
    /// span into a temp b-tree even though the index already yields it ordered.
    /// Both were measured at several times the cost of the covering plan.
    #[test]
    fn payload_sampling_takes_its_rowids_from_the_covering_index() {
        let conn = multi_protocol_capture();

        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT rowid FROM frames \
                 WHERE capture_id = ?1 AND frame_id = ?2 AND protocol = ?3 ORDER BY rowid",
                params!["c1", 256i64, "can"],
                |row| row.get(3),
            )
            .unwrap();

        assert!(
            plan.contains("COVERING INDEX idx_frames_capture_fid"),
            "rowid pass should stay covering, got: {plan}"
        );
        assert!(!plan.contains("TEMP B-TREE"), "rowid pass should not sort, got: {plan}");
    }

    fn audit_rows(conn: &Connection) -> Vec<(i64, String)> {
        let mut stmt = conn
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn fresh_database_migrates_to_current_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();

        assert_eq!(version_of(&conn), MIGRATIONS.last().unwrap().version);
        assert_eq!(
            audit_rows(&conn),
            vec![
                (1, "baseline_capture_schema".to_string()),
                (2, "frames_capture_rowid_index".to_string()),
                (3, "frames_fid_protocol_index".to_string()),
            ]
        );
        assert!(has_column(&conn, "frames", "capture_id").unwrap());
        assert!(has_column(&conn, "capture_metadata", "persistent").unwrap());
        assert!(has_column(&conn, "capture_metadata", "buses").unwrap());
    }

    #[test]
    fn legacy_database_is_renamed_and_data_preserved() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(LEGACY_SCHEMA_SQL).unwrap();
        conn.execute_batch(
            "INSERT INTO buffer_metadata (buffer_id, buffer_type, name, count, created_at)
             VALUES ('b1', 'frames', 'old capture', 2, 1700000000);
             INSERT INTO frames (buffer_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
             VALUES ('b1', 'can', 1, 256, 0, 4, x'DEADBEEF'),
                    ('b1', 'can', 2, 257, 0, 4, x'01020304');",
        )
        .unwrap();

        run_migrations(&mut conn).unwrap();

        assert_eq!(version_of(&conn), MIGRATIONS.last().unwrap().version);
        assert!(!has_column(&conn, "frames", "buffer_id").unwrap());
        let (name, count): (String, i64) = conn
            .query_row(
                "SELECT name, count FROM capture_metadata WHERE capture_id = 'b1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "old capture");
        assert_eq!(count, 2);
        let frames: i64 = conn
            .query_row("SELECT COUNT(*) FROM frames WHERE capture_id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(frames, 2);
    }

    /// Mixed-generation state: new-schema tables beside a stale legacy
    /// `buffer_metadata` re-created by a pre-rename build. The baseline must
    /// fold it without touching the already-renamed tables.
    #[test]
    fn mixed_generation_database_is_normalised() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_TABLES_SQL).unwrap();
        conn.execute_batch(
            "ALTER TABLE capture_metadata ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE capture_metadata ADD COLUMN buses TEXT NOT NULL DEFAULT '[]';
             INSERT INTO capture_metadata (capture_id, capture_kind, name, count, created_at, persistent)
             VALUES ('pinned', 'frames', 'keep me', 1, 1700000000, 1);
             CREATE TABLE buffer_metadata (
                 buffer_id TEXT PRIMARY KEY,
                 buffer_type TEXT NOT NULL,
                 name TEXT NOT NULL,
                 count INTEGER NOT NULL DEFAULT 0,
                 start_time_us INTEGER,
                 end_time_us INTEGER,
                 created_at INTEGER NOT NULL,
                 owning_session_id TEXT
             );",
        )
        .unwrap();

        run_migrations(&mut conn).unwrap();

        assert_eq!(version_of(&conn), MIGRATIONS.last().unwrap().version);
        // Legacy husk gone, migrated (pinned) data untouched.
        let legacy_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='buffer_metadata'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy_tables, 0);
        let persistent: i64 = conn
            .query_row(
                "SELECT persistent FROM capture_metadata WHERE capture_id = 'pinned'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(persistent, 1);
    }

    #[test]
    fn rerunning_migrations_is_a_recorded_noop() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        run_migrations(&mut conn).unwrap();

        assert_eq!(version_of(&conn), MIGRATIONS.last().unwrap().version);
        assert_eq!(audit_rows(&conn).len(), MIGRATIONS.len());
    }

    #[test]
    fn rowid_index_serves_the_live_tail_query() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();

        let index_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_frames_capture_rowid'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_exists, 1);

        // The point of the index: without it SQLite sorts the whole capture into a temp
        // b-tree to return the tail, on a query Discovery reissues twice a second.
        let plan: String = conn
            .query_row(
                &format!(
                    "EXPLAIN QUERY PLAN SELECT {FRAME_COLUMNS} FROM frames
                     WHERE capture_id = 'c1' ORDER BY rowid DESC LIMIT 50"
                ),
                [],
                |row| row.get(3),
            )
            .unwrap();
        assert!(
            plan.contains("idx_frames_capture_rowid"),
            "tail query should use the rowid index, got: {plan}"
        );
    }

    fn index_columns(conn: &Connection, index: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA index_info({index})"))
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(2))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// Frame identity is (protocol, frame_id), so the filtered COUNT tests protocol too
    /// and the index has to carry it or stop being covering — and one of the two counts
    /// is on the live tail path. Migration 3 replaces the v1 index rather than adding
    /// one, so a database holding the narrow version must end up with the wide one, not
    /// both. A fresh database takes the same path: migration 1 creates the narrow index.
    #[test]
    fn frame_id_index_is_widened_to_carry_protocol() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_TABLES_SQL).unwrap();
        conn.execute_batch(SCHEMA_INDEXES_SQL).unwrap();
        assert_eq!(
            index_columns(&conn, "idx_frames_capture_fid"),
            vec!["capture_id", "frame_id"]
        );

        run_migrations(&mut conn).unwrap();

        assert_eq!(
            index_columns(&conn, "idx_frames_capture_fid"),
            vec!["capture_id", "frame_id", "protocol"]
        );
        let matching: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND tbl_name = 'frames' AND name LIKE 'idx_frames_capture_fid%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(matching, 1);
    }

    #[test]
    fn migration_versions_are_ascending_and_contiguous() {
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert_eq!(m.version, i as i64 + 1, "MIGRATIONS must be contiguous from 1");
        }
    }
}
