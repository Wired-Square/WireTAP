use sqlx::sqlite::SqliteRow;
use sqlx::Row;

use crate::model::{CaptureKind, CaptureMetadata};
use crate::store::error::Result;
use crate::Store;

fn row_to_metadata(row: SqliteRow) -> sqlx::Result<CaptureMetadata> {
    Ok(CaptureMetadata {
        id: row.try_get("capture_id")?,
        kind: CaptureKind::from_stored(row.try_get("capture_kind")?),
        name: row.try_get("name")?,
        count: row.try_get::<i64, _>("count")? as usize,
        start_time_us: row
            .try_get::<Option<i64>, _>("start_time_us")?
            .map(|v| v as u64),
        end_time_us: row
            .try_get::<Option<i64>, _>("end_time_us")?
            .map(|v| v as u64),
        created_at: row.try_get::<i64, _>("created_at")? as u64,
        is_streaming: false,
        owning_session_id: row.try_get("owning_session_id")?,
        persistent: row.try_get::<i64, _>("persistent")? != 0,
        buses: serde_json::from_str(row.try_get("buses")?).unwrap_or_default(),
    })
}

impl Store {
    /// Insert or replace a capture's metadata row; `is_streaming` isn't stored.
    pub async fn save_capture_metadata(&self, meta: &CaptureMetadata) -> Result<()> {
        let buses = serde_json::to_string(&meta.buses).unwrap_or_else(|_| "[]".into());
        sqlx::query(
            "INSERT OR REPLACE INTO capture_metadata (capture_id, capture_kind, name, count, start_time_us, end_time_us, created_at, owning_session_id, persistent, buses)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind(&meta.id)
        .bind(meta.kind.as_str())
        .bind(&meta.name)
        .bind(meta.count as i64)
        .bind(meta.start_time_us.map(|v| v as i64))
        .bind(meta.end_time_us.map(|v| v as i64))
        .bind(meta.created_at as i64)
        .bind(&meta.owning_session_id)
        .bind(meta.persistent)
        .bind(buses)
        .execute(self.writer())
        .await?;
        Ok(())
    }

    /// Every capture's metadata, each loading as not streaming.
    pub async fn load_all_capture_metadata(&self) -> Result<Vec<CaptureMetadata>> {
        Ok(sqlx::query(
            "SELECT capture_id, capture_kind, name, count, start_time_us, end_time_us, created_at, owning_session_id, persistent, buses FROM capture_metadata",
        )
        .try_map(row_to_metadata)
        .fetch_all(self.pool())
        .await?)
    }

    pub async fn update_capture_name(&self, capture_id: &str, new_name: &str) -> Result<()> {
        sqlx::query("UPDATE capture_metadata SET name = ?2 WHERE capture_id = ?1")
            .bind(capture_id)
            .bind(new_name)
            .execute(self.writer())
            .await?;
        Ok(())
    }

    pub async fn update_capture_persistent(
        &self,
        capture_id: &str,
        persistent: bool,
    ) -> Result<()> {
        sqlx::query("UPDATE capture_metadata SET persistent = ?2 WHERE capture_id = ?1")
            .bind(capture_id)
            .bind(persistent)
            .execute(self.writer())
            .await?;
        Ok(())
    }

    /// The distinct buses in a capture's data, ascending; backfills metadata stored
    /// before buses were tracked.
    pub async fn get_distinct_buses(&self, capture_id: &str, kind: CaptureKind) -> Result<Vec<u8>> {
        let sql = match kind {
            CaptureKind::Frames => {
                "SELECT DISTINCT bus FROM frames WHERE capture_id = ?1 ORDER BY bus"
            }
            CaptureKind::Bytes => {
                "SELECT DISTINCT bus FROM bytes WHERE capture_id = ?1 ORDER BY bus"
            }
        };
        let buses: Vec<i64> = sqlx::query_scalar(sql)
            .bind(capture_id)
            .fetch_all(self.pool())
            .await?;
        Ok(buses.into_iter().map(|b| b as u8).collect())
    }

    /// Delete a capture's metadata and its events, in one transaction.
    pub async fn delete_capture_metadata(&self, capture_id: &str) -> Result<()> {
        let mut tx = self.db.begin().await?;
        for table in ["capture_metadata", "capture_events"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE capture_id = ?1"))
                .bind(capture_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::{can_frame, StoredFrame};
    use crate::store::testing::{count, execute, store};

    fn meta(id: &str) -> CaptureMetadata {
        CaptureMetadata {
            id: id.into(),
            kind: CaptureKind::Bytes,
            name: "Serial dump".into(),
            count: 12,
            start_time_us: Some(1),
            end_time_us: None,
            created_at: 1_700_000_000,
            is_streaming: true,
            owning_session_id: Some("s1".into()),
            persistent: true,
            buses: vec![0, 3],
        }
    }

    #[tokio::test]
    async fn metadata_round_trips_except_streaming() {
        let store = store().await;
        store.save_capture_metadata(&meta("m1")).await.unwrap();

        let loaded = store.load_all_capture_metadata().await.unwrap();

        assert_eq!(
            loaded,
            [CaptureMetadata {
                is_streaming: false,
                ..meta("m1")
            }]
        );
    }

    #[tokio::test]
    async fn saving_again_replaces_and_updates_touch_one_capture() {
        let store = store().await;
        store.save_capture_metadata(&meta("m1")).await.unwrap();
        store
            .save_capture_metadata(&CaptureMetadata {
                count: 13,
                ..meta("m1")
            })
            .await
            .unwrap();
        store.save_capture_metadata(&meta("m2")).await.unwrap();

        store.update_capture_name("m1", "renamed").await.unwrap();
        store.update_capture_persistent("m1", false).await.unwrap();

        let mut loaded = store.load_all_capture_metadata().await.unwrap();
        loaded.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(
            loaded
                .iter()
                .map(|m| (m.name.as_str(), m.count, m.persistent))
                .collect::<Vec<_>>(),
            [("renamed", 13, false), ("Serial dump", 12, true)]
        );
    }

    #[tokio::test]
    async fn a_legacy_row_loads_with_defaults() {
        let store = store().await;
        execute(
            &store,
            "INSERT INTO capture_metadata (capture_id, capture_kind, name, created_at, buses)
             VALUES ('old', 'buffer_type_from_before', 'old', 5, 'not json')",
        )
        .await;

        let loaded = store.load_all_capture_metadata().await.unwrap();

        assert_eq!(loaded[0].kind, CaptureKind::Frames);
        assert!(loaded[0].buses.is_empty() && !loaded[0].persistent);
    }

    #[tokio::test]
    async fn distinct_buses_read_the_kinds_own_table() {
        let store = store().await;
        store
            .insert_frames(
                "c1",
                &[
                    StoredFrame {
                        bus: 2,
                        ..can_frame(1, &[])
                    },
                    StoredFrame {
                        bus: 0,
                        ..can_frame(1, &[])
                    },
                ],
            )
            .await
            .unwrap();

        assert_eq!(
            store
                .get_distinct_buses("c1", CaptureKind::Frames)
                .await
                .unwrap(),
            [0, 2]
        );
        assert!(store
            .get_distinct_buses("c1", CaptureKind::Bytes)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn deleting_metadata_deletes_its_events() {
        let store = store().await;
        store.save_capture_metadata(&meta("m1")).await.unwrap();
        execute(
            &store,
            "INSERT INTO capture_events (capture_id, timestamp_us, created_at_us, updated_at_us)
             VALUES ('m1', 1, 1, 1), ('m2', 1, 1, 1)",
        )
        .await;

        store.delete_capture_metadata("m1").await.unwrap();

        assert!(store.load_all_capture_metadata().await.unwrap().is_empty());
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM capture_events").await,
            1
        );
    }
}
