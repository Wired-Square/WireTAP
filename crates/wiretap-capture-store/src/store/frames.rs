use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection};

use super::captures::WINDOW;
use super::error::Result;
use crate::frames::{FrameRecord, StoredFrame};
use crate::model::Direction;
use crate::Store;

/// Every column [`row_to_frame`] reads; one it reads and a query omits fails at run time.
pub(crate) const FRAME_COLUMNS: &str = "rowid, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, is_rtr, is_brs, is_esi, source_address, incomplete, direction, crc_valid";

fn direction_text(direction: Direction) -> &'static str {
    match direction {
        Direction::Rx => "rx",
        Direction::Tx => "tx",
    }
}

/// Only `rx` and `tx` were ever written, so anything else reads as unknown.
fn parse_direction(text: &str) -> Option<Direction> {
    match text {
        "rx" => Some(Direction::Rx),
        "tx" => Some(Direction::Tx),
        _ => None,
    }
}

pub(crate) fn row_to_frame(row: &SqliteRow) -> sqlx::Result<StoredFrame> {
    let payload: Vec<u8> = row.try_get("payload")?;
    Ok(StoredFrame {
        protocol: row.try_get("protocol")?,
        timestamp_us: row.try_get::<i64, _>("timestamp_us")? as u64,
        frame_id: row.try_get::<i64, _>("frame_id")? as u32,
        bus: row.try_get::<i64, _>("bus")? as u8,
        len: (row.try_get::<i64, _>("dlc")? as u16).max(payload.len() as u16),
        payload,
        extended: row.try_get("is_extended")?,
        fd: row.try_get("is_fd")?,
        rtr: row.try_get("is_rtr")?,
        brs: row.try_get("is_brs")?,
        esi: row.try_get("is_esi")?,
        source_address: row
            .try_get::<Option<i64>, _>("source_address")?
            .map(|v| v as u16),
        incomplete: row.try_get::<Option<i64>, _>("incomplete")?.map(|v| v != 0),
        direction: row
            .try_get::<Option<String>, _>("direction")?
            .as_deref()
            .and_then(parse_direction),
        crc_valid: row.try_get("crc_valid")?,
    })
}

pub(crate) fn row_to_frame_with_rowid(row: &SqliteRow) -> sqlx::Result<(i64, StoredFrame)> {
    Ok((row.try_get("rowid")?, row_to_frame(row)?))
}

impl Store {
    /// Append `frames` to a capture in one transaction, in order.
    pub async fn insert_frames(
        &self,
        capture_id: &str,
        frames: &[impl FrameRecord + Sync],
    ) -> Result<()> {
        if frames.is_empty() {
            return Ok(());
        }
        let mut tx = self.db.begin().await?;
        insert_frame_rows(&mut tx, capture_id, frames).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Replace a capture's frames with `frames`.
    ///
    /// The old frames go, then the new ones arrive, a window at a time, so a
    /// reader sees the capture empty and refill in order, and an error or a
    /// crash part-way leaves part of either: refill again to finish.
    pub async fn clear_and_refill(
        &self,
        capture_id: &str,
        frames: &[impl FrameRecord + Sync],
    ) -> Result<()> {
        self.delete_by_window("frames", capture_id).await?;
        for window in frames.chunks(WINDOW as usize) {
            let mut tx = self.db.begin().await?;
            insert_frame_rows(&mut tx, capture_id, window).await?;
            tx.commit().await?;
        }
        Ok(())
    }
}

async fn insert_frame_rows(
    conn: &mut SqliteConnection,
    capture_id: &str,
    frames: &[impl FrameRecord + Sync],
) -> Result<()> {
    for f in frames {
        sqlx::query(
            "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_extended, is_fd, is_rtr, is_brs, is_esi, source_address, incomplete, direction, crc_valid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        )
        .bind(capture_id)
        .bind(f.protocol())
        .bind(f.timestamp_us() as i64)
        .bind(i64::from(f.frame_id()))
        .bind(i64::from(f.bus()))
        .bind(i64::from(f.length()))
        .bind(f.payload())
        .bind(f.extended())
        .bind(f.fd())
        .bind(f.rtr())
        .bind(f.brs())
        .bind(f.esi())
        .bind(f.source_address().map(i64::from))
        .bind(f.incomplete().map(i64::from))
        .bind(f.direction().map(direction_text))
        .bind(f.crc_valid())
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::can_frame;
    use crate::store::testing::{rows, store};

    async fn stored_rows(store: &Store) -> Vec<StoredFrame> {
        sqlx::query(&format!(
            "SELECT {FRAME_COLUMNS} FROM frames ORDER BY rowid"
        ))
        .try_map(|r: SqliteRow| row_to_frame(&r))
        .fetch_all(store.database().pool())
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn every_column_round_trips_through_an_insert() {
        let store = store().await;
        let frames = [
            StoredFrame {
                protocol: "serial".into(),
                timestamp_us: 1_700_000_000_000_000,
                frame_id: 0x10,
                bus: 3,
                source_address: Some(0x0102),
                incomplete: Some(true),
                direction: Some(Direction::Rx),
                ..can_frame(0x10, &[0xAA, 0xBB])
            },
            StoredFrame {
                fd: true,
                brs: true,
                esi: true,
                extended: true,
                direction: Some(Direction::Tx),
                ..can_frame(0x1FFF_FFFF, &[7; 64])
            },
            StoredFrame {
                protocol: "future-protocol".into(),
                ..can_frame(9, &[])
            },
            StoredFrame {
                protocol: wslib_wiretap_protocol::MODBUS_RTU_PROTOCOL.into(),
                crc_valid: Some(false),
                ..can_frame(0x0103, &[0x01, 0x03, 0x00, 0x00])
            },
        ];

        store.insert_frames("c1", &frames).await.unwrap();

        assert_eq!(stored_rows(&store).await, frames);
        let directions: Vec<Option<String>> =
            rows(&store, "SELECT direction FROM frames ORDER BY rowid").await;
        assert_eq!(
            directions,
            [Some("rx".into()), Some("tx".into()), None, None]
        );
    }

    #[tokio::test]
    async fn an_unknown_direction_reads_as_none() {
        let store = store().await;
        sqlx::query(
            "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload, direction)
             VALUES ('c1', 'can', 1, 1, 0, 0, x'', 'sideways')",
        )
        .execute(store.database().pool())
        .await
        .unwrap();
        assert_eq!(stored_rows(&store).await[0].direction, None);
    }

    #[tokio::test]
    async fn clearing_and_refilling_replaces_only_that_capture() {
        let store = store().await;
        store
            .insert_frames("c1", &[can_frame(1, &[1]), can_frame(2, &[2])])
            .await
            .unwrap();
        store
            .insert_frames("c2", &[can_frame(3, &[3])])
            .await
            .unwrap();

        store
            .clear_and_refill("c1", &[can_frame(4, &[4])])
            .await
            .unwrap();

        let ids: Vec<(String, i64)> =
            sqlx::query_as("SELECT capture_id, frame_id FROM frames ORDER BY rowid")
                .fetch_all(store.database().pool())
                .await
                .unwrap();
        assert_eq!(ids, [("c2".into(), 3), ("c1".into(), 4)]);
    }

    #[tokio::test]
    async fn a_batch_keeps_its_order_within_the_capture() {
        let store = store().await;
        let batch: Vec<StoredFrame> = (0..500).map(|i| can_frame(i, &[])).collect();

        store.insert_frames("c1", &batch).await.unwrap();

        assert_eq!(stored_rows(&store).await, batch);
    }
}
