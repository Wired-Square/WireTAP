//! A future dropped mid-flight leaves no pooled connection holding the write
//! lock or refusing writes.

use std::future::Future;
use std::time::{Duration, Instant};

use sqlx::Row;
use wiretap_capture_store::{Cancel, Sql, Store, StoredFrame};

const POOL: usize = 5;

struct Fixture {
    store: Store,
    _dir: tempfile::TempDir,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = Store::open(dir.path().join("captures.db")).await.unwrap();
    Fixture { store, _dir: dir }
}

fn batch(n: usize) -> Vec<StoredFrame> {
    (0..n)
        .map(|i| StoredFrame {
            protocol: "can".into(),
            timestamp_us: i as u64,
            frame_id: i as u32,
            len: 1,
            payload: vec![1],
            ..Default::default()
        })
        .collect()
}

fn long_read() -> Sql {
    Sql {
        sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000000) SELECT COUNT(*) FROM n".into(),
        values: Vec::new(),
    }
}

/// Poll `future` `polls` times, spinning the thread `spin` between polls so
/// SQLite's worker moves on, then drop it.
async fn poll_then_drop(future: impl Future, polls: u32, spin: Duration) {
    let mut future = std::pin::pin!(future);
    for _ in 0..polls {
        let ready =
            std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx).is_ready()))
                .await;
        if ready {
            return;
        }
        let until = Instant::now() + spin;
        while Instant::now() < until {
            std::hint::spin_loop();
        }
    }
}

/// Every connection the pool can hand out at once writes, and none is read-only.
async fn every_connection_writes(store: &Store) -> Result<(), String> {
    let pool = store.database().pool();
    let mut held = Vec::new();
    for _ in 0..POOL {
        held.push(pool.acquire().await.map_err(|e| e.to_string())?);
    }
    for (i, conn) in held.iter_mut().enumerate() {
        let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
            .fetch_one(&mut **conn)
            .await
            .map_err(|e| e.to_string())?;
        let write = sqlx::query(
            "INSERT INTO bytes (capture_id, byte_val, timestamp_us) VALUES ('probe', 1, 1)",
        )
        .execute(&mut **conn)
        .await;
        if query_only != 0 || write.is_err() {
            return Err(format!(
                "connection {i}: query_only {query_only}, write {write:?}"
            ));
        }
    }
    Ok(())
}

async fn next_write_lands(store: &Store) -> Result<(), String> {
    match tokio::time::timeout(
        Duration::from_secs(1),
        store.insert_frames("after", &batch(1)),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("still waiting on the write lock after 1 s".into()),
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(20)).await;
}

#[tokio::test]
async fn a_write_dropped_at_any_point_leaves_the_next_write_working() {
    let f = fixture().await;
    let frames = batch(200);
    for polls in 1..=6 {
        for spin_us in [0, 20, 50, 100, 200, 400] {
            poll_then_drop(
                f.store.insert_frames("dropped", &frames),
                polls,
                Duration::from_micros(spin_us),
            )
            .await;
            settle().await;
            if let Err(e) = next_write_lands(&f.store).await {
                panic!("after a drop at poll {polls}, spin {spin_us} µs: {e}");
            }
        }
    }
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM frames WHERE capture_id = 'dropped'")
        .fetch_one(f.store.database().pool())
        .await
        .unwrap();
    assert_eq!(rows % 200, 0, "a dropped batch lands whole or not at all");
}

#[tokio::test]
async fn a_read_dropped_while_arming_leaves_no_connection_read_only() {
    let f = fixture().await;
    let (statement, cancel) = (long_read(), Cancel::new());
    for polls in 1..=8 {
        for spin_us in [0, 10, 30, 60, 100, 200, 400] {
            poll_then_drop(
                f.store
                    .read_rows(&statement, &cancel, |r| r.try_get::<i64, _>(0)),
                polls,
                Duration::from_micros(spin_us),
            )
            .await;
            settle().await;
            if let Err(e) = every_connection_writes(&f.store).await {
                panic!("after a drop at poll {polls}, spin {spin_us} µs: {e}");
            }
            settle().await;
        }
    }
}

#[tokio::test]
#[ignore = "soak: thousands of drops at random points"]
async fn soak_drops_never_poison_the_pool() {
    let f = fixture().await;
    let frames = batch(1000);
    let (statement, cancel) = (long_read(), Cancel::new());
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = |below: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % below
    };
    for i in 0..2000 {
        let (polls, spin) = (1 + next(40) as u32, Duration::from_micros(next(500)));
        if i % 2 == 0 {
            poll_then_drop(f.store.insert_frames("dropped", &frames), polls, spin).await;
        } else {
            let read = f
                .store
                .read_rows(&statement, &cancel, |r| r.try_get::<i64, _>(0));
            poll_then_drop(read, polls.min(6), spin).await;
        }
        settle().await;
        next_write_lands(&f.store)
            .await
            .unwrap_or_else(|e| panic!("drop {i}: {e}"));
        every_connection_writes(&f.store)
            .await
            .unwrap_or_else(|e| panic!("drop {i}: {e}"));
    }
}
