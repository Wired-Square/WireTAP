use sqlx::sqlite::SqliteRow;
use sqlx::Row;

use crate::model::TimestampedByte;
use crate::store::error::Result;
use crate::Store;

const BYTE_COLUMNS: &str = "byte_val, timestamp_us, bus";

fn row_to_byte(row: SqliteRow) -> sqlx::Result<TimestampedByte> {
    Ok(TimestampedByte {
        byte: row.try_get::<i64, _>(0)? as u8,
        timestamp_us: row.try_get::<i64, _>(1)? as u64,
        bus: row.try_get::<i64, _>(2)? as u8,
    })
}

impl Store {
    /// Append `bytes` to a capture in one transaction, in order.
    pub async fn insert_bytes(&self, capture_id: &str, bytes: &[TimestampedByte]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let mut tx = self.db.begin().await?;
        for b in bytes {
            sqlx::query(
                "INSERT INTO bytes (capture_id, byte_val, timestamp_us, bus) VALUES (?1, ?2, ?3, ?4)",
            )
            .bind(capture_id)
            .bind(i64::from(b.byte))
            .bind(b.timestamp_us as i64)
            .bind(i64::from(b.bus))
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// A page of a capture's bytes in capture order, with how many it holds.
    pub async fn get_bytes_paginated(
        &self,
        capture_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<TimestampedByte>, usize)> {
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bytes WHERE capture_id = ?1")
            .bind(capture_id)
            .fetch_one(self.pool())
            .await?;
        let sql = format!(
            "SELECT {BYTE_COLUMNS} FROM bytes WHERE capture_id = ?1 ORDER BY rowid LIMIT ?2 OFFSET ?3"
        );
        let bytes = sqlx::query(&sql)
            .bind(capture_id)
            .bind(limit as i64)
            .bind(offset as i64)
            .try_map(row_to_byte)
            .fetch_all(self.pool())
            .await?;
        Ok((bytes, total as usize))
    }

    /// A capture's newest `limit` bytes, oldest first. No `OFFSET`, so the cost is
    /// independent of the capture's length.
    pub async fn get_bytes_tail_rows(
        &self,
        capture_id: &str,
        limit: usize,
    ) -> Result<Vec<TimestampedByte>> {
        let sql = format!(
            "SELECT {BYTE_COLUMNS} FROM bytes WHERE capture_id = ?1 ORDER BY rowid DESC LIMIT ?2"
        );
        let mut bytes = sqlx::query(&sql)
            .bind(capture_id)
            .bind(limit as i64)
            .try_map(row_to_byte)
            .fetch_all(self.pool())
            .await?;
        bytes.reverse();
        Ok(bytes)
    }

    /// Every byte in a capture, in capture order.
    pub async fn get_all_bytes(&self, capture_id: &str) -> Result<Vec<TimestampedByte>> {
        let sql = format!("SELECT {BYTE_COLUMNS} FROM bytes WHERE capture_id = ?1 ORDER BY rowid");
        Ok(sqlx::query(&sql)
            .bind(capture_id)
            .try_map(row_to_byte)
            .fetch_all(self.pool())
            .await?)
    }

    /// How many of a capture's bytes come before `target_us`.
    pub async fn find_bytes_offset_for_timestamp(
        &self,
        capture_id: &str,
        target_us: u64,
    ) -> Result<usize> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM bytes WHERE capture_id = ?1 AND timestamp_us < ?2",
        )
        .bind(capture_id)
        .bind(target_us as i64)
        .fetch_one(self.pool())
        .await?;
        Ok(count as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Six bytes in `b1`, and a decoy capture whose rows must never appear in its tail.
    async fn byte_capture() -> crate::store::testing::TestStore {
        let store = crate::store::testing::store().await;
        let byte = |byte, timestamp_us, bus| TimestampedByte {
            byte,
            timestamp_us,
            bus,
        };
        store
            .insert_bytes(
                "b1",
                &[
                    byte(10, 100, 0),
                    byte(11, 101, 0),
                    byte(12, 102, 1),
                    byte(13, 103, 0),
                    byte(14, 104, 0),
                    byte(15, 105, 0),
                ],
            )
            .await
            .unwrap();
        store.insert_bytes("b2", &[byte(99, 106, 0)]).await.unwrap();
        store
    }

    fn values(bytes: &[TimestampedByte]) -> Vec<u8> {
        bytes.iter().map(|b| b.byte).collect()
    }

    #[tokio::test]
    async fn bytes_tail_returns_last_rows_chronologically() {
        let store = byte_capture().await;

        let bytes = store.get_bytes_tail_rows("b1", 3).await.unwrap();

        assert_eq!(values(&bytes), [13, 14, 15]);
        assert_eq!(
            bytes.iter().map(|b| b.timestamp_us).collect::<Vec<_>>(),
            [103, 104, 105]
        );
        assert_eq!(bytes[0].bus, 0);
    }

    #[tokio::test]
    async fn bytes_tail_limit_past_start_returns_all() {
        let store = byte_capture().await;

        let bytes = store.get_bytes_tail_rows("b1", 100).await.unwrap();

        assert_eq!(values(&bytes), [10, 11, 12, 13, 14, 15]);
    }

    #[tokio::test]
    async fn bytes_tail_matches_equivalent_page() {
        let store = byte_capture().await;

        let tail = store.get_bytes_tail_rows("b1", 2).await.unwrap();
        let (page, total) = store.get_bytes_paginated("b1", 4, 2).await.unwrap();

        assert_eq!(total, 6);
        assert_eq!(tail, page);
    }

    #[tokio::test]
    async fn all_bytes_and_the_offset_for_a_timestamp_stay_in_their_capture() {
        let store = byte_capture().await;

        assert_eq!(
            store.get_all_bytes("b1").await.unwrap()[2],
            TimestampedByte {
                byte: 12,
                timestamp_us: 102,
                bus: 1
            }
        );
        assert_eq!(values(&store.get_all_bytes("b2").await.unwrap()), [99]);
        assert_eq!(
            store
                .find_bytes_offset_for_timestamp("b1", 103)
                .await
                .unwrap(),
            3
        );
        assert_eq!(
            store
                .find_bytes_offset_for_timestamp("b1", 1000)
                .await
                .unwrap(),
            6
        );
    }
}
