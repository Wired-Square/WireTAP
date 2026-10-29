use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::sqlite::SqliteRow;
use sqlx::Row;

use super::error::{CaptureError, Result};
use crate::events::{CaptureEvent, NewCaptureEvent};
use crate::Store;

const EVENT_COLUMNS: &str = "id, timestamp_us, duration_us, note, created_at_us, updated_at_us";

fn now_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as i64)
}

fn row_to_event(row: SqliteRow) -> sqlx::Result<CaptureEvent> {
    Ok(CaptureEvent {
        id: row.try_get(0)?,
        ts_us: row.try_get(1)?,
        duration_us: row.try_get(2)?,
        note: row.try_get(3)?,
        created_at_us: row.try_get(4)?,
        updated_at_us: row.try_get(5)?,
    })
}

impl Store {
    /// A capture's events by time, then by id.
    pub async fn list_capture_events(&self, capture_id: &str) -> Result<Vec<CaptureEvent>> {
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM capture_events WHERE capture_id = ?1 ORDER BY timestamp_us, id"
        );
        Ok(sqlx::query(&sql)
            .bind(capture_id)
            .try_map(row_to_event)
            .fetch_all(self.pool())
            .await?)
    }

    pub async fn insert_capture_event(
        &self,
        capture_id: &str,
        event: &NewCaptureEvent,
    ) -> Result<CaptureEvent> {
        let sql = format!(
            "INSERT INTO capture_events (capture_id, timestamp_us, duration_us, note, created_at_us, updated_at_us)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING {EVENT_COLUMNS}"
        );
        Ok(sqlx::query(&sql)
            .bind(capture_id)
            .bind(event.ts_us)
            .bind(event.duration_us)
            .bind(&event.note)
            .bind(now_us())
            .try_map(row_to_event)
            .fetch_one(self.writer())
            .await?)
    }

    /// Replace an event's time, duration and note; [`CaptureError::EventNotFound`] unless
    /// the capture holds `id`.
    pub async fn update_capture_event(
        &self,
        capture_id: &str,
        id: i64,
        event: &NewCaptureEvent,
    ) -> Result<CaptureEvent> {
        let sql = format!(
            "UPDATE capture_events SET timestamp_us = ?3, duration_us = ?4, note = ?5, updated_at_us = ?6
             WHERE capture_id = ?1 AND id = ?2 RETURNING {EVENT_COLUMNS}"
        );
        sqlx::query(&sql)
            .bind(capture_id)
            .bind(id)
            .bind(event.ts_us)
            .bind(event.duration_us)
            .bind(&event.note)
            .bind(now_us())
            .try_map(row_to_event)
            .fetch_optional(self.writer())
            .await?
            .ok_or(CaptureError::EventNotFound)
    }

    /// [`CaptureError::EventNotFound`] unless the capture holds `id`.
    pub async fn delete_capture_event(&self, capture_id: &str, id: i64) -> Result<()> {
        let deleted = sqlx::query("DELETE FROM capture_events WHERE capture_id = ?1 AND id = ?2")
            .bind(capture_id)
            .bind(id)
            .execute(self.writer())
            .await?;
        if deleted.rows_affected() == 0 {
            return Err(CaptureError::EventNotFound);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::event;

    #[tokio::test]
    async fn events_round_trip_in_timestamp_order() {
        let store = crate::store::testing::store().await;
        let later = store
            .insert_capture_event("c1", &event(30, 0, "later"))
            .await
            .unwrap();
        let earlier = store
            .insert_capture_event("c1", &event(10, 5, "earlier"))
            .await
            .unwrap();
        store
            .insert_capture_event("c2", &event(20, 0, "other capture"))
            .await
            .unwrap();

        let listed = store.list_capture_events("c1").await.unwrap();
        assert_eq!(
            listed.iter().map(|e| e.id).collect::<Vec<_>>(),
            [earlier.id, later.id]
        );
        assert_eq!(listed[0].duration_us, 5);
        assert_eq!(listed[0].created_at_us, listed[0].updated_at_us);

        let updated = store
            .update_capture_event("c1", later.id, &event(30, 7, "renamed"))
            .await
            .unwrap();
        assert_eq!(
            (updated.ts_us, updated.duration_us, updated.note.as_str()),
            (30, 7, "renamed")
        );
        assert!(updated.updated_at_us >= updated.created_at_us);

        store.delete_capture_event("c1", earlier.id).await.unwrap();
        assert_eq!(store.list_capture_events("c1").await.unwrap().len(), 1);
        assert!(matches!(
            store.delete_capture_event("c1", earlier.id).await,
            Err(CaptureError::EventNotFound)
        ));
        assert!(matches!(
            store
                .update_capture_event("c2", later.id, &event(30, 7, "wrong capture"))
                .await,
            Err(CaptureError::EventNotFound)
        ));
        assert_eq!(store.list_capture_events("c2").await.unwrap().len(), 1);
    }
}
