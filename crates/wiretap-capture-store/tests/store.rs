//! Opening files: fresh, from the legacy ladder's shapes, and copies.

use std::future::Future;
use std::path::Path;
use std::time::{Duration, Instant};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::{ConnectOptions, Row, SqliteConnection};
use wiretap_capture_store::{chain, Cancel, CaptureError, Sql, Store, StoredFrame};
use wslib_db_sqlite::Database;

/// The legacy layout before the ladder: `buffer_*`, unstamped.
const UNSTAMPED_BUFFER_SHAPE: &str = "
    CREATE TABLE buffer_metadata (
        buffer_id TEXT PRIMARY KEY, buffer_type TEXT NOT NULL, name TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, start_time_us INTEGER, end_time_us INTEGER,
        created_at INTEGER NOT NULL, owning_session_id TEXT
    );
    CREATE TABLE frames (
        rowid INTEGER PRIMARY KEY, buffer_id TEXT NOT NULL, protocol TEXT NOT NULL,
        timestamp_us INTEGER NOT NULL, frame_id INTEGER NOT NULL, bus INTEGER NOT NULL,
        dlc INTEGER NOT NULL, payload BLOB NOT NULL, is_extended INTEGER NOT NULL DEFAULT 0,
        is_fd INTEGER NOT NULL DEFAULT 0, source_address INTEGER, incomplete INTEGER,
        direction TEXT
    );
    CREATE TABLE bytes (
        rowid INTEGER PRIMARY KEY, buffer_id TEXT NOT NULL, byte_val INTEGER NOT NULL,
        timestamp_us INTEGER NOT NULL, bus INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO buffer_metadata (buffer_id, buffer_type, name, count, created_at)
    VALUES ('b1', 'frames', 'old capture', 1, 1700000000);
    INSERT INTO frames (buffer_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
    VALUES ('b1', 'can', 1, 256, 0, 2, x'AABB');
";

/// A file at ladder version 5, as that build left it: no `crc_valid`.
const V5_SHAPE: &str = "
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations VALUES
        (1, 'baseline_capture_schema', 0), (2, 'frames_capture_rowid_index', 0),
        (3, 'frames_fid_protocol_index', 0), (4, 'capture_events', 0), (5, 'frames_can_flags', 0);
    CREATE TABLE frames (
        rowid INTEGER PRIMARY KEY, capture_id TEXT NOT NULL, protocol TEXT NOT NULL,
        timestamp_us INTEGER NOT NULL, frame_id INTEGER NOT NULL, bus INTEGER NOT NULL,
        dlc INTEGER NOT NULL, payload BLOB NOT NULL, is_extended INTEGER NOT NULL DEFAULT 0,
        is_fd INTEGER NOT NULL DEFAULT 0, source_address INTEGER, incomplete INTEGER,
        direction TEXT, is_rtr INTEGER NOT NULL DEFAULT 0, is_brs INTEGER NOT NULL DEFAULT 0,
        is_esi INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bytes (
        rowid INTEGER PRIMARY KEY, capture_id TEXT NOT NULL, byte_val INTEGER NOT NULL,
        timestamp_us INTEGER NOT NULL, bus INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE capture_metadata (
        capture_id TEXT PRIMARY KEY, capture_kind TEXT NOT NULL, name TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, start_time_us INTEGER, end_time_us INTEGER,
        created_at INTEGER NOT NULL, owning_session_id TEXT,
        persistent INTEGER NOT NULL DEFAULT 0, buses TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE capture_events (
        id INTEGER PRIMARY KEY, capture_id TEXT NOT NULL, timestamp_us INTEGER NOT NULL,
        duration_us INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
        created_at_us INTEGER NOT NULL, updated_at_us INTEGER NOT NULL
    );
    CREATE INDEX idx_frames_capture_ts ON frames (capture_id, timestamp_us);
    CREATE INDEX idx_frames_capture_fid ON frames (capture_id, frame_id, protocol);
    CREATE INDEX idx_frames_capture_rowid ON frames (capture_id, rowid);
    CREATE INDEX idx_bytes_capture_ts ON bytes (capture_id, timestamp_us);
    CREATE INDEX idx_capture_events_capture_ts ON capture_events (capture_id, timestamp_us);
    INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
    VALUES ('c1', 'modbus_rtu', 1, 259, 0, 4, x'01030000');
    PRAGMA user_version = 5;
";

const LONG: &str = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 200000) SELECT COUNT(*) FROM n";

async fn connect(path: &Path) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap()
}

async fn write_file(path: &Path, sql: &str) {
    let mut conn = connect(path).await;
    sqlx::Executor::execute(&mut conn, sqlx::raw_sql(sql))
        .await
        .unwrap();
    sqlx::Connection::close(conn).await.unwrap();
}

async fn scalar(store: &Store, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(store.database().pool())
        .await
        .unwrap()
}

async fn chain_versions(store: &Store) -> Vec<i64> {
    sqlx::query_scalar("SELECT version FROM _capture_migrations ORDER BY version")
        .fetch_all(store.database().pool())
        .await
        .unwrap()
}

#[tokio::test]
async fn a_fresh_file_takes_the_chain_and_reads_version_6() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("captures.db");

    let (store, applied) = Store::open(&path).await.unwrap();

    assert!(applied.is_empty());
    assert_eq!(scalar(&store, "PRAGMA user_version").await, 6);
    assert_eq!(chain_versions(&store).await, [1]);
    assert_eq!(
        scalar(
            &store,
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'schema_migrations'"
        )
        .await,
        0
    );
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(store.database().pool())
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    assert_eq!(scalar(&store, "PRAGMA cache_size").await, -10 * 1024);
    assert_eq!(scalar(&store, "PRAGMA temp_store").await, 2);
    store.close().await;

    let (reopened, applied) = Store::open(&path).await.unwrap();
    assert!(applied.is_empty());
    assert_eq!(chain_versions(&reopened).await, [1]);
}

#[tokio::test]
async fn an_unstamped_buffer_file_climbs_the_ladder_then_records_the_chain() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.db");
    write_file(&path, UNSTAMPED_BUFFER_SHAPE).await;

    let (store, applied) = Store::open(&path).await.unwrap();

    assert_eq!(
        applied.iter().map(|a| a.version).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6]
    );
    assert_eq!(scalar(&store, "PRAGMA user_version").await, 6);
    assert_eq!(
        scalar(&store, "SELECT COUNT(*) FROM schema_migrations").await,
        6
    );
    assert_eq!(chain_versions(&store).await, [1]);
    let frames = store.get_all_frames("b1").await.unwrap();
    assert_eq!(frames[0].payload, [0xAA, 0xBB]);
    let meta = store.load_all_capture_metadata().await.unwrap();
    assert_eq!(meta[0].name, "old capture");
}

#[tokio::test]
async fn a_v5_file_takes_the_last_step_and_reads_its_frames_crc_unchecked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v5.db");
    write_file(&path, V5_SHAPE).await;

    let (store, applied) = Store::open(&path).await.unwrap();

    assert_eq!(
        applied.iter().map(|a| a.name).collect::<Vec<_>>(),
        ["frames_crc_valid"]
    );
    assert_eq!(scalar(&store, "PRAGMA user_version").await, 6);
    assert_eq!(
        scalar(&store, "SELECT MAX(version) FROM schema_migrations").await,
        6
    );
    assert_eq!(chain_versions(&store).await, [1]);
    let frames = store.get_all_frames("c1").await.unwrap();
    assert_eq!(
        frames,
        [StoredFrame {
            protocol: "modbus_rtu".into(),
            timestamp_us: 1,
            frame_id: 259,
            len: 4,
            payload: vec![1, 3, 0, 0],
            ..Default::default()
        }]
    );
}

#[tokio::test]
async fn a_copy_is_upgraded_with_the_wal_s_rows_and_the_original_is_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("handed-over.db");
    let mut writer = SqliteConnectOptions::new()
        .filename(&original)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .pragma("wal_autocheckpoint", "0")
        .connect()
        .await
        .unwrap();
    sqlx::Executor::execute(&mut writer, sqlx::raw_sql(UNSTAMPED_BUFFER_SHAPE))
        .await
        .unwrap();
    let wal = dir.path().join("handed-over.db-wal");
    let before = (
        std::fs::read(&original).unwrap(),
        std::fs::read(&wal).unwrap(),
    );

    let (store, _) = Store::open_copy(&original, dir.path().join("working.db"))
        .await
        .unwrap();

    assert_eq!(store.get_all_frames("b1").await.unwrap().len(), 1);
    assert_eq!(scalar(&store, "PRAGMA user_version").await, 6);
    assert_eq!(
        (
            std::fs::read(&original).unwrap(),
            std::fs::read(&wal).unwrap()
        ),
        before
    );
    let unchanged: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut writer)
        .await
        .unwrap();
    assert_eq!(unchanged, 0);
}

#[tokio::test]
async fn a_copy_never_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("a.db");
    let working = dir.path().join("b.db");
    write_file(&original, UNSTAMPED_BUFFER_SHAPE).await;
    std::fs::write(&working, b"mine").unwrap();

    let refused = Store::open_copy(&original, &working).await;

    assert!(
        matches!(&refused, Err(CaptureError::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists),
        "{refused:?}"
    );
    assert_eq!(std::fs::read(&working).unwrap(), b"mine");
}

/// With its cancel never set, a read dropped mid-statement still stops: the
/// pool's last connection is free well before the statement would end, and
/// no connection it hands out carries a handler.
#[tokio::test]
async fn a_dropped_read_stops_its_statement_and_returns_no_handler() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = Store::open(dir.path().join("captures.db")).await.unwrap();
    let endless = Sql {
        sql: LONG.replace("200000", "10000000000"),
        values: Vec::new(),
    };

    let dropped = tokio::time::timeout(
        Duration::from_millis(50),
        store.read_rows(&endless, &Cancel::new(), |r| r.try_get::<i64, _>(0)),
    )
    .await;
    assert!(dropped.is_err(), "the read should still have been running");

    let started = Instant::now();
    let mut held = Vec::new();
    for _ in 0..5 {
        let mut conn = store.database().pool().acquire().await.unwrap();
        let n: i64 = sqlx::query_scalar(LONG)
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(n, 200_000);
        held.push(conn);
    }
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_host_database_keeps_its_own_user_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.db");
    write_file(
        &path,
        "CREATE TABLE widgets (id INTEGER PRIMARY KEY); PRAGMA user_version = 42;",
    )
    .await;

    let store = Store::from_database(Database::open(&path, &[chain()]).await.unwrap());

    assert_eq!(scalar(&store, "PRAGMA user_version").await, 42);
    assert_eq!(chain_versions(&store).await, [1]);
    assert!(store.load_all_capture_metadata().await.unwrap().is_empty());
}

#[test]
fn the_store_s_futures_are_send() {
    fn send<T: Send>(_: T) {}
    let path = Path::new("never-opened.db");
    send(Store::open(path));
    send(Store::open_copy(path, path));
    send(async {
        let (store, _) = Store::open(path).await.unwrap();
        store
            .insert_frames("c1", &[StoredFrame::default()])
            .await
            .unwrap();
        let statement = Sql {
            sql: String::new(),
            values: Vec::new(),
        };
        store
            .read_rows(&statement, &Cancel::new(), |r| r.try_get::<i64, _>(0))
            .await
            .unwrap();
    });
}

/// Whatever await an open is dropped at, a file that has the chain is stamped
/// for the older ladder, as a crash there would leave it.
#[tokio::test]
async fn an_open_dropped_anywhere_never_leaves_the_chain_unstamped() {
    for polls in 1..=60 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("captures.db");
        {
            let mut open = std::pin::pin!(Store::open(&path));
            for _ in 0..polls {
                let ready = std::future::poll_fn(|cx| {
                    std::task::Poll::Ready(open.as_mut().poll(cx).is_ready())
                })
                .await;
                if ready {
                    break;
                }
                tokio::time::sleep(Duration::from_micros(200)).await;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;

        let mut conn = connect(&path).await;
        let chained: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = '_capture_migrations'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let stamp: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert!(
            chained == 0 || stamp == 6,
            "dropped after {polls} polls: the chain is applied, user_version is {stamp}"
        );
    }
}

#[tokio::test]
async fn a_file_from_a_newer_build_is_refused_and_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("captures.db");
    let (store, _) = Store::open(&path).await.unwrap();
    store.close().await;
    write_file(&path, "PRAGMA user_version = 7;").await;

    let refused = Store::open(&path).await;

    assert!(
        matches!(refused, Err(CaptureError::NewerFile { found: 7, known: 6 })),
        "{refused:?}"
    );
    let mut conn = connect(&path).await;
    let stamp: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(stamp, 7);
}
