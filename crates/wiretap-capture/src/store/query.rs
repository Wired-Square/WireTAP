use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteArguments, SqliteRow};
use sqlx::Sqlite;

use crate::filter::{Sql, SqlValue};
use crate::store::error::{CaptureError, Result};
use crate::Store;

/// SQLite VM steps between checks of a [`Cancel`].
const CANCEL_CHECK_STEPS: i32 = 1000;

/// A flag that interrupts a [`Store::read_rows`] statement between SQLite VM steps.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

impl From<Arc<AtomicBool>> for Cancel {
    fn from(flag: Arc<AtomicBool>) -> Self {
        Self(flag)
    }
}

fn bound(statement: &Sql) -> sqlx::query::Query<'_, Sqlite, SqliteArguments<'_>> {
    statement
        .values
        .iter()
        .fold(sqlx::query(&statement.sql), |query, value| match value {
            SqlValue::Integer(n) => query.bind(*n),
            SqlValue::Text(s) => query.bind(s.as_str()),
        })
}

/// A pooled connection, read-only and carrying a progress handler that stops
/// its statement on a [`Cancel`] or once this is dropped.
struct Interruptible {
    conn: PoolConnection<Sqlite>,
    dropped: Arc<AtomicBool>,
    armed: bool,
}

impl Interruptible {
    async fn arm(conn: PoolConnection<Sqlite>, cancel: &Cancel) -> Result<Self> {
        // Armed before its first await, so a drop at any of them closes the connection.
        let mut this = Self {
            conn,
            dropped: Arc::default(),
            armed: true,
        };
        sqlx::query("PRAGMA query_only = ON")
            .execute(&mut *this.conn)
            .await?;
        let (cancel, dropped) = (Arc::clone(&cancel.0), Arc::clone(&this.dropped));
        // sqlx interrupts when the handler returns false, the reverse of SQLite's own sense.
        this.conn
            .lock_handle()
            .await?
            .set_progress_handler(CANCEL_CHECK_STEPS, move || {
                !(cancel.load(Ordering::Relaxed) || dropped.load(Ordering::Relaxed))
            });
        Ok(this)
    }

    async fn disarm(mut self) -> Result<()> {
        self.conn.lock_handle().await?.remove_progress_handler();
        sqlx::query("PRAGMA query_only = OFF")
            .execute(&mut *self.conn)
            .await?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for Interruptible {
    fn drop(&mut self) {
        if self.armed {
            self.dropped.store(true, Ordering::Relaxed);
            // `lock_handle` is async, so the handler can't be cleared here; the connection closes instead.
            self.conn.close_on_drop();
        }
    }
}

impl Store {
    /// Run `statement` read-only, one `T` per row; a [`Cancel`] set before or
    /// during it ends it with [`CaptureError::Cancelled`], and so does dropping
    /// the future.
    pub async fn read_rows<T: Send + Unpin>(
        &self,
        statement: &Sql,
        cancel: &Cancel,
        map: impl FnMut(&SqliteRow) -> sqlx::Result<T> + Send,
    ) -> Result<Vec<T>> {
        if cancel.is_cancelled() {
            return Err(CaptureError::Cancelled);
        }
        let mut conn = Interruptible::arm(self.pool().acquire().await?, cancel).await?;
        let rows = fetch(&mut conn.conn, statement, map).await;
        conn.disarm().await?;
        rows
    }

    /// Run `statement` on a pooled connection as it is, one `T` per row, with
    /// no cancel and no read-only guard: for statements the application wrote.
    pub async fn rows<T: Send + Unpin>(
        &self,
        statement: &Sql,
        map: impl FnMut(&SqliteRow) -> sqlx::Result<T> + Send,
    ) -> Result<Vec<T>> {
        fetch(&mut *self.pool().acquire().await?, statement, map).await
    }
}

async fn fetch<T: Send + Unpin>(
    conn: &mut sqlx::SqliteConnection,
    statement: &Sql,
    mut map: impl FnMut(&SqliteRow) -> sqlx::Result<T> + Send,
) -> Result<Vec<T>> {
    Ok(bound(statement)
        .try_map(move |row: SqliteRow| map(&row))
        .fetch_all(conn)
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    const LONG: &str = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 200000) SELECT COUNT(*) FROM n";

    fn sql(sql: &str) -> Sql {
        Sql {
            sql: sql.into(),
            values: Vec::new(),
        }
    }

    fn first(row: &SqliteRow) -> sqlx::Result<i64> {
        row.try_get(0)
    }

    #[tokio::test]
    async fn a_set_cancel_flag_stops_the_statement_and_is_then_forgotten() {
        let store = crate::store::testing::store().await;
        let cancel = Cancel::new();
        cancel.cancel();

        let cancelled = store.read_rows(&sql(LONG), &cancel, first).await;

        assert!(
            matches!(cancelled, Err(CaptureError::Cancelled)),
            "{cancelled:?}"
        );
        let after = store
            .read_rows(&sql(LONG), &Cancel::new(), first)
            .await
            .unwrap();
        assert_eq!(after, [200_000]);
    }

    /// The in-memory store is one connection, so the query after the cancel runs
    /// on the connection the handler was set on, its flag still set.
    #[tokio::test]
    async fn a_flag_set_mid_query_interrupts_it_and_leaves_no_handler_behind() {
        let store = crate::store::testing::memory_store().await;
        crate::store::testing::execute(
            &store,
            "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
             WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000)
             SELECT 'c1', 'can', x, x % 2048, 0, 1, x'AA' FROM n",
        )
        .await;
        let cancel = Cancel::new();
        let flag = cancel.clone();
        let setter = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(20));
            flag.cancel();
        });

        let cancelled = store
            .read_rows(
                &sql("SELECT SUM(a.timestamp_us + b.timestamp_us) FROM frames a, (SELECT timestamp_us FROM frames LIMIT 1000) b"),
                &cancel,
                first,
            )
            .await;
        setter.join().unwrap();

        assert!(
            matches!(cancelled, Err(CaptureError::Cancelled)),
            "{cancelled:?}"
        );
        let after: i64 = sqlx::query_scalar(LONG)
            .fetch_one(store.database().pool())
            .await
            .unwrap();
        assert_eq!(after, 200_000);
    }

    /// The in-memory store is one connection, so the write after the refused
    /// one runs on the connection the read had.
    #[tokio::test]
    async fn a_statement_is_read_only_and_the_connection_writes_after() {
        let store = crate::store::testing::memory_store().await;
        let insert = "INSERT INTO bytes (capture_id, byte_val, timestamp_us) VALUES ('b1', 1, 1)";

        let refused = store.read_rows(&sql(insert), &Cancel::new(), first).await;

        assert!(
            matches!(refused, Err(CaptureError::Sqlite(_))),
            "{refused:?}"
        );
        crate::store::testing::execute(&store, insert).await;
    }

    #[tokio::test]
    async fn a_plain_read_runs_the_statement_as_it_is() {
        let store = crate::store::testing::store().await;
        let statement = Sql {
            sql: "INSERT INTO bytes (capture_id, byte_val, timestamp_us) VALUES (?, 1, 1) RETURNING rowid".into(),
            values: vec![SqlValue::Text("b1".into())],
        };

        assert_eq!(store.rows(&statement, first).await.unwrap(), [1]);
        assert_eq!(store.get_all_bytes("b1").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn values_bind_in_order() {
        let store = crate::store::testing::store().await;
        let statement = Sql {
            sql: "SELECT ? || ?".into(),
            values: vec![SqlValue::Text("a'".into()), SqlValue::Integer(7)],
        };

        let rows = store
            .read_rows(&statement, &Cancel::new(), |r| r.try_get::<String, _>(0))
            .await
            .unwrap();

        assert_eq!(rows, ["a'7"]);
    }
}
