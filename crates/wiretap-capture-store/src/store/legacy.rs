use sqlx::{Connection, SqliteConnection};

use crate::store::error::{CaptureError, Result};

/// Tables only: a legacy database's `buffer_id` columns can't carry the indexes
/// until the baseline has renamed them.
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

const SCHEMA_INDEXES_SQL: &str = "
CREATE INDEX IF NOT EXISTS idx_frames_capture_ts ON frames (capture_id, timestamp_us);
CREATE INDEX IF NOT EXISTS idx_frames_capture_fid ON frames (capture_id, frame_id);
CREATE INDEX IF NOT EXISTS idx_bytes_capture_ts ON bytes (capture_id, timestamp_us);
";

enum Step {
    Baseline,
    Sql(&'static str),
}

struct Migration {
    version: i64,
    name: &'static str,
    step: Step,
}

/// Frozen: files written before the migration chain are stamped 1 to 6 by
/// these steps, each in one transaction with its audit row and stamp.
const LADDER: &[Migration] = &[
    Migration {
        version: 1,
        name: "baseline_capture_schema",
        step: Step::Baseline,
    },
    Migration {
        version: 2,
        name: "frames_capture_rowid_index",
        step: Step::Sql(include_str!(
            "../../legacy/0002_frames_capture_rowid_index.sql"
        )),
    },
    Migration {
        version: 3,
        name: "frames_fid_protocol_index",
        step: Step::Sql(include_str!(
            "../../legacy/0003_frames_fid_protocol_index.sql"
        )),
    },
    Migration {
        version: 4,
        name: "capture_events",
        step: Step::Sql(include_str!("../../legacy/0004_capture_events.sql")),
    },
    Migration {
        version: 5,
        name: "frames_can_flags",
        step: Step::Sql(include_str!("../../legacy/0005_frames_can_flags.sql")),
    },
    Migration {
        version: 6,
        name: "frames_crc_valid",
        step: Step::Sql(include_str!("../../legacy/0006_frames_crc_valid.sql")),
    },
];

/// A legacy step [`upgrade_legacy`] applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Applied {
    pub version: i64,
    pub name: &'static str,
}

/// Bring a capture file an older build wrote, one with `frames` or
/// `buffer_metadata` and no chain table, to the shape
/// [`chain`](crate::chain)'s first migration takes over; any other file is
/// left alone.
///
/// Run it on a plain connection before the chain applies.
pub async fn upgrade_legacy(conn: &mut SqliteConnection) -> Result<Vec<Applied>> {
    let chain_table = format!("_{}_migrations", crate::chain().name());
    let legacy = !table_exists(conn, &chain_table).await?
        && (table_exists(conn, "frames").await? || table_exists(conn, "buffer_metadata").await?);
    if !legacy {
        return Ok(Vec::new());
    }
    apply_migrations(conn, LADDER).await
}

async fn table_exists(conn: &mut SqliteConnection, name: &str) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)")
        .bind(name)
        .fetch_one(conn)
        .await
}

async fn has_column(conn: &mut SqliteConnection, table: &str, col: &str) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)")
        .bind(table)
        .bind(col)
        .fetch_one(conn)
        .await
}

async fn schema_version(conn: &mut SqliteConnection) -> sqlx::Result<i64> {
    sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(conn)
        .await
}

async fn batch(conn: &mut SqliteConnection, sql: &str) -> sqlx::Result<()> {
    sqlx::Executor::execute(conn, sqlx::raw_sql(sql)).await?;
    Ok(())
}

async fn apply_migrations(
    conn: &mut SqliteConnection,
    migrations: &[Migration],
) -> Result<Vec<Applied>> {
    batch(
        conn,
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             applied_at INTEGER NOT NULL
         );",
    )
    .await?;

    let current = schema_version(conn).await?;
    let mut applied = Vec::new();
    for m in migrations.iter().filter(|m| m.version > current) {
        apply(conn, m)
            .await
            .map_err(|source| CaptureError::Migration {
                version: m.version,
                name: m.name,
                source,
            })?;
        applied.push(Applied {
            version: m.version,
            name: m.name,
        });
    }
    Ok(applied)
}

async fn apply(conn: &mut SqliteConnection, m: &Migration) -> sqlx::Result<()> {
    let mut tx = conn.begin().await?;
    match m.step {
        Step::Baseline => baseline_capture_schema(&mut tx).await?,
        Step::Sql(sql) => batch(&mut tx, sql).await?,
    }
    sqlx::query(
        "INSERT INTO schema_migrations (version, name, applied_at)
         VALUES (?1, ?2, strftime('%s','now'))",
    )
    .bind(m.version)
    .bind(m.name)
    .execute(&mut *tx)
    .await?;
    batch(&mut tx, &format!("PRAGMA user_version = {}", m.version)).await?;
    tx.commit().await
}

/// Migration 1 normalises any unstamped database (fresh, legacy `buffer_*`,
/// fully migrated or mixed-generation) to the v1 shape. It alone infers state
/// from the schema, and does so per object: a pre-rename build re-creates an
/// empty `buffer_metadata` beside renamed tables, and a blanket "legacy, rename
/// everything" aborts on the first renamed column on every open.
async fn baseline_capture_schema(tx: &mut SqliteConnection) -> sqlx::Result<()> {
    batch(tx, SCHEMA_TABLES_SQL).await?;

    if table_exists(tx, "buffer_metadata").await? {
        if has_column(tx, "frames", "buffer_id").await? {
            batch(
                tx,
                "ALTER TABLE frames RENAME COLUMN buffer_id TO capture_id;
                 DROP INDEX IF EXISTS idx_frames_buffer_ts;
                 DROP INDEX IF EXISTS idx_frames_buffer_fid;",
            )
            .await?;
        }
        if has_column(tx, "bytes", "buffer_id").await? {
            batch(
                tx,
                "ALTER TABLE bytes RENAME COLUMN buffer_id TO capture_id;
                 DROP INDEX IF EXISTS idx_bytes_buffer_ts;",
            )
            .await?;
        }
        // Rows, not a table rename: in the mixed case `capture_metadata` already
        // holds migrated, possibly pinned, captures.
        batch(
            tx,
            "INSERT OR IGNORE INTO capture_metadata
                 (capture_id, capture_kind, name, count, start_time_us, end_time_us,
                  created_at, owning_session_id)
             SELECT buffer_id, buffer_type, name, count, start_time_us, end_time_us,
                    created_at, owning_session_id
             FROM buffer_metadata;
             DROP TABLE buffer_metadata;",
        )
        .await?;
    }

    batch(tx, SCHEMA_INDEXES_SQL).await?;

    if !has_column(tx, "capture_metadata", "persistent").await? {
        batch(
            tx,
            "ALTER TABLE capture_metadata ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0",
        )
        .await?;
    }
    if !has_column(tx, "capture_metadata", "buses").await? {
        batch(
            tx,
            "ALTER TABLE capture_metadata ADD COLUMN buses TEXT NOT NULL DEFAULT '[]'",
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::{ConnectOptions, Row};

    use super::*;

    /// The pre-rename schema.
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

    async fn memory() -> SqliteConnection {
        SqliteConnectOptions::new()
            .in_memory(true)
            .connect()
            .await
            .unwrap()
    }

    async fn ladder_top() -> SqliteConnection {
        let mut conn = memory().await;
        apply_migrations(&mut conn, LADDER).await.unwrap();
        conn
    }

    async fn version_of(conn: &mut SqliteConnection) -> i64 {
        schema_version(conn).await.unwrap()
    }

    async fn count(conn: &mut SqliteConnection, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(conn).await.unwrap()
    }

    async fn audit_rows(conn: &mut SqliteConnection) -> Vec<(i64, String)> {
        sqlx::query_as("SELECT version, name FROM schema_migrations ORDER BY version")
            .fetch_all(conn)
            .await
            .unwrap()
    }

    async fn index_columns(conn: &mut SqliteConnection, index: &str) -> Vec<String> {
        sqlx::query(&format!("PRAGMA index_info({index})"))
            .try_map(|r: sqlx::sqlite::SqliteRow| r.try_get::<String, _>(2))
            .fetch_all(conn)
            .await
            .unwrap()
    }

    /// Every capture table's columns and every `idx_` index's columns, by name.
    async fn shape(conn: &mut SqliteConnection) -> Vec<String> {
        let mut shape: Vec<String> = sqlx::query_scalar(
            "SELECT m.name || '.' || c.name || ' ' || c.type || ' ' || c.\"notnull\" || ' ' || IFNULL(c.dflt_value, '-') || ' ' || c.pk
             FROM sqlite_master m, pragma_table_info(m.name) c
             WHERE m.type = 'table' AND m.name IN ('frames', 'bytes', 'capture_metadata', 'capture_events')
             ORDER BY m.name, c.cid",
        )
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        let indexes: Vec<(String, String)> = sqlx::query_as(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        for (index, table) in indexes {
            let columns = index_columns(conn, &index).await.join(",");
            shape.push(format!("{index} ON {table} ({columns})"));
        }
        shape
    }

    const LADDER_NAMES: [&str; 6] = [
        "baseline_capture_schema",
        "frames_capture_rowid_index",
        "frames_fid_protocol_index",
        "capture_events",
        "frames_can_flags",
        "frames_crc_valid",
    ];

    #[tokio::test]
    async fn the_ladder_takes_an_empty_database_to_version_6() {
        let mut conn = memory().await;
        let applied = apply_migrations(&mut conn, LADDER).await.unwrap();

        let expected: Vec<(i64, &str)> = (1..).zip(LADDER_NAMES).collect();
        assert_eq!(version_of(&mut conn).await, 6);
        assert_eq!(
            applied
                .iter()
                .map(|a| (a.version, a.name))
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            audit_rows(&mut conn)
                .await
                .iter()
                .map(|(v, n)| (*v, n.as_str()))
                .collect::<Vec<_>>(),
            expected
        );
    }

    #[tokio::test]
    async fn rerunning_the_ladder_is_a_recorded_noop() {
        let mut conn = ladder_top().await;
        assert!(apply_migrations(&mut conn, LADDER)
            .await
            .unwrap()
            .is_empty());

        assert_eq!(version_of(&mut conn).await, 6);
        assert_eq!(audit_rows(&mut conn).await.len(), LADDER.len());
    }

    #[test]
    fn ladder_versions_are_ascending_and_contiguous() {
        for (i, m) in LADDER.iter().enumerate() {
            assert_eq!(m.version, i as i64 + 1);
        }
        assert_eq!(LADDER.len(), 6);
    }

    /// The chain's first migration is a no-op on a laddered file only while
    /// it writes exactly what the ladder leaves.
    #[tokio::test]
    async fn the_chain_writes_the_shape_the_ladder_leaves() {
        let db = wslib_db_sqlite::Database::open_in_memory(&[crate::chain()])
            .await
            .unwrap();
        let mut chained = db.pool().acquire().await.unwrap();

        assert_eq!(
            shape(&mut chained).await,
            shape(&mut ladder_top().await).await
        );
    }

    #[tokio::test]
    async fn a_fresh_or_chained_file_is_left_alone() {
        let mut fresh = memory().await;
        assert!(upgrade_legacy(&mut fresh).await.unwrap().is_empty());
        assert_eq!(
            count(&mut fresh, "SELECT COUNT(*) FROM sqlite_master").await,
            0
        );

        let db = wslib_db_sqlite::Database::open_in_memory(&[crate::chain()])
            .await
            .unwrap();
        let mut chained = db.pool().acquire().await.unwrap();
        assert!(upgrade_legacy(&mut chained).await.unwrap().is_empty());
        assert_eq!(
            count(
                &mut chained,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'schema_migrations'"
            )
            .await,
            0
        );
    }

    #[tokio::test]
    async fn a_file_with_only_other_tables_is_left_alone() {
        let mut conn = memory().await;
        batch(
            &mut conn,
            "CREATE TABLE widgets (id INTEGER PRIMARY KEY); PRAGMA user_version = 42;",
        )
        .await
        .unwrap();

        assert!(upgrade_legacy(&mut conn).await.unwrap().is_empty());

        assert_eq!(version_of(&mut conn).await, 42);
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) FROM sqlite_master WHERE name != 'widgets'"
            )
            .await,
            0
        );
    }

    #[tokio::test]
    async fn legacy_database_is_renamed_and_data_preserved() {
        let mut conn = memory().await;
        batch(&mut conn, LEGACY_SCHEMA_SQL).await.unwrap();
        batch(
            &mut conn,
            "INSERT INTO buffer_metadata (buffer_id, buffer_type, name, count, created_at)
             VALUES ('b1', 'frames', 'old capture', 2, 1700000000);
             INSERT INTO frames (buffer_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
             VALUES ('b1', 'can', 1, 256, 0, 4, x'DEADBEEF'),
                    ('b1', 'can', 2, 257, 0, 4, x'01020304');",
        )
        .await
        .unwrap();

        upgrade_legacy(&mut conn).await.unwrap();

        assert_eq!(version_of(&mut conn).await, 6);
        assert!(!has_column(&mut conn, "frames", "buffer_id").await.unwrap());
        let (name, n): (String, i64) =
            sqlx::query_as("SELECT name, count FROM capture_metadata WHERE capture_id = 'b1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!((name.as_str(), n), ("old capture", 2));
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) FROM frames WHERE capture_id = 'b1'"
            )
            .await,
            2
        );
        assert_eq!(shape(&mut conn).await, shape(&mut ladder_top().await).await);
    }

    /// New-schema tables beside a stale `buffer_metadata` a pre-rename build
    /// re-created: folded without touching the renamed tables.
    #[tokio::test]
    async fn mixed_generation_database_is_normalised() {
        let mut conn = memory().await;
        batch(&mut conn, SCHEMA_TABLES_SQL).await.unwrap();
        batch(
            &mut conn,
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
        .await
        .unwrap();

        upgrade_legacy(&mut conn).await.unwrap();

        assert_eq!(version_of(&mut conn).await, 6);
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='buffer_metadata'"
            )
            .await,
            0
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT persistent FROM capture_metadata WHERE capture_id = 'pinned'"
            )
            .await,
            1
        );
    }

    #[tokio::test]
    async fn a_failing_step_applies_nothing_of_itself() {
        let mut conn = memory().await;
        let broken = [
            Migration {
                version: 1,
                name: "baseline_capture_schema",
                step: Step::Baseline,
            },
            Migration {
                version: 2,
                name: "broken",
                step: Step::Sql("CREATE TABLE half (x); SELECT * FROM no_such_table;"),
            },
        ];

        let err = apply_migrations(&mut conn, &broken).await.unwrap_err();

        assert!(matches!(
            err,
            CaptureError::Migration {
                version: 2,
                name: "broken",
                ..
            }
        ));
        assert_eq!(version_of(&mut conn).await, 1);
        assert_eq!(audit_rows(&mut conn).await.len(), 1);
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'half'"
            )
            .await,
            0
        );
    }

    #[tokio::test]
    async fn a_v4_database_migrates_to_v5_with_its_frames_unflagged() {
        let mut conn = memory().await;
        apply_migrations(&mut conn, &LADDER[..4]).await.unwrap();
        batch(
            &mut conn,
            "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_fd)
             VALUES ('c1', 'can', 1, 256, 0, 2, x'AABB', 1);",
        )
        .await
        .unwrap();

        let applied = apply_migrations(&mut conn, &LADDER[..5]).await.unwrap();

        assert_eq!(
            applied,
            [Applied {
                version: 5,
                name: "frames_can_flags"
            }]
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT is_fd * 1000 + is_rtr * 100 + is_brs * 10 + is_esi FROM frames"
            )
            .await,
            1000
        );
    }

    #[tokio::test]
    async fn a_v5_database_migrates_to_v6_with_its_frames_crc_unchecked() {
        let mut conn = memory().await;
        apply_migrations(&mut conn, &LADDER[..5]).await.unwrap();
        batch(
            &mut conn,
            "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
             VALUES ('c1', 'modbus_rtu', 1, 259, 0, 4, x'01030000');",
        )
        .await
        .unwrap();

        let applied = upgrade_legacy(&mut conn).await.unwrap();

        assert_eq!(
            applied,
            [Applied {
                version: 6,
                name: "frames_crc_valid"
            }]
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) FROM frames WHERE crc_valid IS NULL"
            )
            .await,
            1
        );
    }

    #[tokio::test]
    async fn the_index_names_are_the_contract() {
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .fetch_all(&mut ladder_top().await)
        .await
        .unwrap();
        assert_eq!(
            names,
            [
                "idx_bytes_capture_ts",
                "idx_capture_events_capture_ts",
                "idx_frames_capture_fid",
                "idx_frames_capture_rowid",
                "idx_frames_capture_ts",
            ]
        );
    }

    /// Migration 3 replaces the v1 frame-id index rather than adding one, so the
    /// filtered COUNT, which tests the protocol too, stays covering.
    #[tokio::test]
    async fn frame_id_index_is_widened_to_carry_protocol() {
        let mut conn = memory().await;
        batch(&mut conn, SCHEMA_TABLES_SQL).await.unwrap();
        batch(&mut conn, SCHEMA_INDEXES_SQL).await.unwrap();
        assert_eq!(
            index_columns(&mut conn, "idx_frames_capture_fid").await,
            ["capture_id", "frame_id"]
        );

        apply_migrations(&mut conn, LADDER).await.unwrap();

        assert_eq!(
            index_columns(&mut conn, "idx_frames_capture_fid").await,
            ["capture_id", "frame_id", "protocol"]
        );
        assert_eq!(
            count(
                &mut conn,
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND tbl_name = 'frames' AND name LIKE 'idx_frames_capture_fid%'"
            )
            .await,
            1
        );
    }
}
