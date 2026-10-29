//! Whole-capture operations against a live appender and a busy pool.

use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use sqlx::Row;
use wiretap_capture::{Cancel, CaptureError, Sql, Store, StoredFrame};

const POOL: usize = 5;
const BIG: i64 = 100_000;

struct Fixture {
    store: Store,
    dir: tempfile::TempDir,
}

impl Fixture {
    fn wal(&self) -> PathBuf {
        self.dir.path().join("captures.db-wal")
    }
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = Store::open(dir.path().join("captures.db")).await.unwrap();
    Fixture { store, dir }
}

fn frames(n: usize) -> Vec<StoredFrame> {
    (0..n)
        .map(|i| StoredFrame {
            protocol: "can".into(),
            timestamp_us: i as u64,
            frame_id: (i % 2048) as u32,
            len: 8,
            payload: vec![i as u8; 8],
            ..Default::default()
        })
        .collect()
}

/// `n` frames in `capture_id`, with metadata that a sweep removes.
async fn capture(store: &Store, capture_id: &str, n: i64) {
    let sql = format!(
        "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
         WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < {n})
         SELECT '{capture_id}', 'can', x, x % 2048, 0, 8, randomblob(8) FROM n;
         INSERT INTO bytes (capture_id, byte_val, timestamp_us)
         WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < {n})
         SELECT '{capture_id}', x % 256, x FROM n;
         INSERT INTO capture_metadata (capture_id, capture_kind, name, created_at, persistent)
         VALUES ('{capture_id}', 'frames', '{capture_id}', 0, 0);
         PRAGMA wal_checkpoint(TRUNCATE);"
    );
    sqlx::Executor::execute(store.database().pool(), sqlx::raw_sql(&sql))
        .await
        .unwrap();
}

async fn count(store: &Store, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(store.database().pool())
        .await
        .unwrap()
}

/// How many single-frame appends land while `op` runs.
async fn appends_during<T>(
    store: &Store,
    op: impl Future<Output = Result<T, CaptureError>>,
) -> usize {
    let mut landed = 0;
    let appender = async {
        loop {
            store.insert_frames("live", &frames(1)).await.unwrap();
            landed += 1;
        }
    };
    tokio::select! {
        biased;
        done = op => { done.unwrap(); }
        _ = appender => unreachable!(),
    }
    landed
}

fn assert_interleaved(op: &str, landed: usize) {
    assert!(
        landed >= 5,
        "{op}: only {landed} appends landed while it ran; it held the write lock throughout"
    );
}

#[tokio::test]
async fn a_copy_lets_a_live_appender_in_and_copies_everything() {
    let f = fixture().await;
    capture(&f.store, "big", BIG).await;

    let landed = appends_during(&f.store, f.store.copy_capture_data("big", "copy")).await;

    assert_interleaved("copy", landed);
    let copied = f.store.get_all_frames("copy").await.unwrap();
    assert_eq!(copied.len() as i64, BIG);
    assert_eq!(copied, f.store.get_all_frames("big").await.unwrap());
    assert_eq!(
        f.store.get_all_bytes("copy").await.unwrap(),
        f.store.get_all_bytes("big").await.unwrap()
    );
}

#[tokio::test]
async fn a_delete_lets_a_live_appender_in_and_deletes_everything() {
    let f = fixture().await;
    capture(&f.store, "big", BIG).await;

    let landed = appends_during(&f.store, f.store.delete_capture_data("big")).await;

    assert_interleaved("delete", landed);
    for table in ["frames", "bytes"] {
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE capture_id = 'big'");
        assert_eq!(count(&f.store, &sql).await, 0, "{table}");
    }
}

#[tokio::test]
async fn a_refill_lets_a_live_appender_in_and_leaves_only_the_new_frames() {
    let f = fixture().await;
    capture(&f.store, "big", BIG).await;
    let refill = frames(BIG as usize);

    let landed = appends_during(&f.store, f.store.clear_and_refill("big", &refill)).await;

    assert_interleaved("refill", landed);
    assert_eq!(f.store.get_all_frames("big").await.unwrap(), refill);
}

#[tokio::test]
async fn a_sweep_lets_a_live_appender_in_and_removes_everything_unkept() {
    let f = fixture().await;
    capture(&f.store, "big", BIG).await;
    f.store
        .save_capture_metadata(&wiretap_capture::CaptureMetadata {
            id: "live".into(),
            kind: wiretap_capture::CaptureKind::Frames,
            name: "live".into(),
            count: 0,
            start_time_us: None,
            end_time_us: None,
            created_at: 0,
            is_streaming: true,
            owning_session_id: None,
            persistent: true,
            buses: Vec::new(),
        })
        .await
        .unwrap();

    let landed = appends_during(&f.store, f.store.sweep_non_persistent()).await;

    assert_interleaved("sweep", landed);
    assert_eq!(
        count(
            &f.store,
            "SELECT COUNT(*) FROM frames WHERE capture_id != 'live'"
        )
        .await,
        0
    );
    assert_eq!(count(&f.store, "SELECT COUNT(*) FROM bytes").await, 0);
}

#[tokio::test]
async fn a_write_waits_for_no_reader_when_every_pooled_connection_is_reading() {
    let f = fixture().await;
    let mut readers = Vec::new();
    for _ in 0..POOL {
        readers.push(f.store.database().pool().acquire().await.unwrap());
    }

    let write = tokio::time::timeout(
        Duration::from_secs(1),
        f.store.insert_frames("live", &frames(1)),
    )
    .await;

    assert!(
        matches!(write, Ok(Ok(()))),
        "the write queued behind the readers: {write:?}"
    );
}

const WAL_LIMIT: u64 = 16 << 20;

/// A reader holding its snapshot keeps the WAL from restarting, so it grows
/// past the limit; once the reader is done, the next restart cuts it back.
#[tokio::test]
async fn the_wal_shrinks_back_to_its_limit_once_a_reader_lets_it_restart() {
    let f = fixture().await;
    capture(&f.store, "big", 2 * BIG).await;
    let mut reader = f.store.database().pool().begin().await.unwrap();
    count_on(&mut reader, "SELECT COUNT(*) FROM frames").await;

    f.store.copy_capture_data("big", "copy").await.unwrap();
    let grown = std::fs::metadata(f.wal()).unwrap().len();
    reader.rollback().await.unwrap();
    for _ in 0..2 {
        f.store.insert_frames("live", &frames(1)).await.unwrap();
    }

    let wal = std::fs::metadata(f.wal()).unwrap().len();
    assert!(
        grown > WAL_LIMIT,
        "the reader held the WAL at {grown} bytes"
    );
    assert!(wal <= WAL_LIMIT, "the WAL is still {wal} bytes");
}

async fn count_on(conn: &mut sqlx::SqliteConnection, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(conn).await.unwrap()
}

#[tokio::test]
#[ignore = "soak: a 544k-frame capture under a live appender and ten readers"]
async fn soak_heavy_operations_never_hold_up_the_appender() {
    const FRAMES: i64 = 544_000;
    let f = fixture().await;
    capture(&f.store, "big", FRAMES).await;
    let refill = frames(FRAMES as usize);
    let worst = std::cell::Cell::new(Duration::ZERO);
    let appender = async {
        loop {
            let started = std::time::Instant::now();
            f.store.insert_frames("live", &frames(100)).await.unwrap();
            worst.set(worst.get().max(started.elapsed()));
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    let readers: Vec<_> = (0..10)
        .map(|_| {
            let store = f.store.clone();
            tokio::spawn(async move {
                let statement = Sql {
                    sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000000) SELECT COUNT(*) FROM n".into(),
                    values: Vec::new(),
                };
                loop {
                    store.get_frame_count("big").await.unwrap();
                    store.read_rows(&statement, &Cancel::new(), |r| r.try_get::<i64, _>(0)).await.unwrap();
                }
            })
        })
        .collect();
    let heavy = async {
        f.store.copy_capture_data("big", "copy").await.unwrap();
        f.store.clear_and_refill("copy", &refill).await.unwrap();
        f.store.delete_capture_data("copy").await.unwrap();
        f.store.sweep_non_persistent().await.unwrap();
    };

    tokio::select! {
        biased;
        () = heavy => {}
        _ = appender => unreachable!(),
    }
    readers.iter().for_each(|reader| reader.abort());

    eprintln!("the slowest append took {:?}", worst.get());
    assert!(worst.get() < Duration::from_secs(1), "{:?}", worst.get());
}
