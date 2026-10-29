use sqlx::sqlite::SqliteRow;
use sqlx::Row;
use wslib_wiretap_protocol::InventoryRow;

use super::error::Result;
use crate::filter::FrameRowFilter;
use crate::inventory::inventory_statement;
use crate::Store;

pub fn inventory_row(row: &SqliteRow) -> sqlx::Result<InventoryRow> {
    Ok(InventoryRow::new(
        row.try_get(0)?,
        row.try_get::<i64, _>(1)? as u32,
        row.try_get::<i64, _>(2)? != 0,
        row.try_get(3)?,
        row.try_get(4)?,
        row.try_get(5)?,
        row.try_get::<i64, _>(6)? as u16,
    ))
}

impl Store {
    /// Every identity in a capture within `start_us..end_us`, with its rollup.
    pub async fn frame_inventory(
        &self,
        capture_id: &str,
        start_us: Option<i64>,
        end_us: Option<i64>,
    ) -> Result<Vec<InventoryRow>> {
        let filter = FrameRowFilter {
            start_us,
            end_us,
            ..Default::default()
        };
        self.rows(
            &inventory_statement(capture_id, &filter, None),
            inventory_row,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::SqlValue;
    use crate::store::testing::{multi_protocol_capture, store};

    /// The inventory decides which groups a scan reads, so it splits the identity pair too.
    #[tokio::test]
    async fn inventory_reports_one_row_per_protocol() {
        let store = multi_protocol_capture().await;

        let rows = store.frame_inventory("c1", None, None).await.unwrap();

        let for_256: Vec<(&str, i64)> = rows
            .iter()
            .filter(|r| r.frame_id == 256)
            .map(|r| (r.protocol.as_str(), r.count))
            .collect();
        assert_eq!(for_256, [("can", 1), ("modbus", 1), ("serial", 1)]);
        assert_eq!(rows.len(), 4);
    }

    #[tokio::test]
    async fn the_window_is_start_inclusive_and_end_exclusive() {
        let store = multi_protocol_capture().await;

        let rows = store
            .frame_inventory("c1", Some(20), Some(40))
            .await
            .unwrap();

        assert_eq!(
            rows.iter()
                .map(|r| (r.protocol.as_str(), r.first_us, r.last_us))
                .collect::<Vec<_>>(),
            [("modbus", 20, 20), ("serial", 30, 30)]
        );
    }

    #[tokio::test]
    async fn the_stored_length_is_the_inventorys_max_dlc() {
        let store = store().await;
        sqlx::query(
            "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_fd, is_rtr)
             VALUES ('c1', 'can', 1, 256, 0, 15, ?1, 1, 0), ('c1', 'can', 2, 257, 0, 6, x'', 0, 1)",
        )
        .bind(vec![0u8; 64])
        .execute(store.database().pool())
        .await
        .unwrap();

        let rows = store.frame_inventory("c1", None, None).await.unwrap();

        assert_eq!(rows.iter().map(|r| r.max_dlc).collect::<Vec<_>>(), [64, 6]);
    }

    #[tokio::test]
    async fn a_limit_is_bound_last() {
        let store = multi_protocol_capture().await;
        let statement = inventory_statement("c1", &FrameRowFilter::default(), Some(2));

        assert!(statement.sql.ends_with(" LIMIT ?"));
        assert_eq!(statement.values.last(), Some(&SqlValue::Integer(2)));
        assert_eq!(
            store.rows(&statement, inventory_row).await.unwrap().len(),
            2
        );
    }
}
