use wslib_wiretap_protocol::{PayloadQuery, Sampling};

use super::error::Result;
use crate::filter::{FrameRowFilter, Sql, SqlValue};
use crate::Store;

/// At most `limit` items spread evenly across `items`. The step rounds up: rounding
/// down over 5,001 items for 5,000 takes the first 5,000 and drops the tail.
fn strided<T: Copy>(items: &[T], limit: u32) -> Vec<T> {
    let limit = limit.max(1) as usize;
    if items.len() <= limit {
        return items.to_vec();
    }
    items
        .iter()
        .step_by(items.len().div_ceil(limit))
        .copied()
        .collect()
}

fn frame_filter(capture_id: &str, q: &PayloadQuery<'_>) -> Sql {
    let filter = FrameRowFilter {
        frame_id: Some(q.frame_id),
        is_extended: q.is_extended,
        ..Default::default()
    };
    filter.sql_where_named(capture_id, q.protocol.as_slice())
}

fn payload(row: &sqlx::sqlite::SqliteRow) -> sqlx::Result<Vec<u8>> {
    sqlx::Row::try_get(row, 0)
}

impl Store {
    /// Up to `q.limit` of one frame's payloads, oldest first: the newest
    /// contiguous run, or spread evenly across the whole capture. Passing
    /// `is_extended` costs a row lookup per row, so leave it `None` when the id
    /// is unambiguous.
    pub async fn payloads(&self, capture_id: &str, q: &PayloadQuery<'_>) -> Result<Vec<Vec<u8>>> {
        let filter = frame_filter(capture_id, q);
        match q.sampling {
            Sampling::Spread => self.spread_payloads(filter, q.limit).await,
            Sampling::Recent => self.recent_payloads(filter, q.limit).await,
        }
    }

    /// Two passes, not `ROW_NUMBER() OVER (ORDER BY rowid)`: the window sorts every
    /// match into a temp b-tree, though the covering index already yields rowid order.
    async fn spread_payloads(&self, filter: Sql, limit: u32) -> Result<Vec<Vec<u8>>> {
        let rowids = self
            .rows(
                &Sql {
                    sql: format!(
                        "SELECT rowid FROM frames WHERE {} ORDER BY rowid",
                        filter.sql
                    ),
                    values: filter.values,
                },
                |row| sqlx::Row::try_get::<i64, _>(row, 0),
            )
            .await?;
        let picked = strided(&rowids, limit);
        if picked.is_empty() {
            return Ok(Vec::new());
        }
        self.rows(
            &Sql {
                sql: "SELECT payload FROM frames WHERE rowid IN (SELECT value FROM json_each(?)) ORDER BY rowid".into(),
                values: vec![SqlValue::Text(serde_json::Value::from(picked).to_string())],
            },
            payload,
        )
        .await
    }

    async fn recent_payloads(&self, filter: Sql, limit: u32) -> Result<Vec<Vec<u8>>> {
        let mut statement = Sql {
            sql: format!(
                "SELECT payload FROM frames WHERE {} ORDER BY rowid DESC LIMIT ?",
                filter.sql
            ),
            values: filter.values,
        };
        statement
            .values
            .push(SqlValue::Integer(limit.max(1).into()));
        let mut payloads = self.rows(&statement, payload).await?;
        payloads.reverse();
        Ok(payloads)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testing::{execute, multi_protocol_capture, plan, store, TestStore};

    /// `n` CAN frames of one id, each payload its own position.
    async fn can_capture_of(n: i64) -> TestStore {
        let store = store().await;
        execute(
            &store,
            &format!(
                "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload)
                 WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < {n} - 1)
                 SELECT 'c1', 'can', i, 256, 0, 1, unhex(printf('%02X', i)) FROM n"
            ),
        )
        .await;
        store
    }

    fn query(protocol: Option<&str>, limit: u32, sampling: Sampling) -> PayloadQuery<'_> {
        PayloadQuery {
            protocol,
            frame_id: 256,
            is_extended: None,
            limit,
            sampling,
        }
    }

    async fn spread(store: &Store, protocol: Option<&str>, limit: u32) -> Vec<Vec<u8>> {
        store
            .payloads("c1", &query(protocol, limit, Sampling::Spread))
            .await
            .unwrap()
    }

    async fn recent(store: &Store, protocol: Option<&str>, limit: u32) -> Vec<Vec<u8>> {
        store
            .payloads("c1", &query(protocol, limit, Sampling::Recent))
            .await
            .unwrap()
    }

    fn positions(payloads: &[Vec<u8>]) -> Vec<u8> {
        payloads.iter().map(|p| p[0]).collect()
    }

    #[tokio::test]
    async fn sampled_payloads_do_not_cross_protocols() {
        let store = multi_protocol_capture().await;

        assert_eq!(spread(&store, Some("can"), 100).await, [[0xAA]]);
        assert_eq!(spread(&store, Some("modbus"), 100).await, [[0xBB]]);
    }

    #[tokio::test]
    async fn sampled_payloads_without_a_protocol_span_all_of_them() {
        let store = multi_protocol_capture().await;

        assert_eq!(spread(&store, None, 100).await, [[0xAA], [0xBB], [0xCC]]);
    }

    #[tokio::test]
    async fn a_protocol_no_capture_stored_matches_nothing() {
        let store = multi_protocol_capture().await;

        assert!(spread(&store, Some("lin"), 100).await.is_empty());
        assert!(recent(&store, Some("lin"), 100).await.is_empty());
    }

    /// A tail query answered 90..=99 and a head query 0..=9: each a different answer
    /// depending on the door the caller came in by.
    #[tokio::test]
    async fn sampling_strides_the_whole_capture() {
        let store = can_capture_of(100).await;

        assert_eq!(
            positions(&spread(&store, Some("can"), 10).await),
            [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]
        );
    }

    #[tokio::test]
    async fn sampling_never_degenerates_into_the_first_n() {
        let store = can_capture_of(101).await;

        let sampled = spread(&store, Some("can"), 100).await;

        assert_eq!(
            (sampled.first().unwrap()[0], sampled.last().unwrap()[0]),
            (0, 100)
        );
    }

    #[tokio::test]
    async fn sampling_limit_past_the_end_returns_everything() {
        let store = can_capture_of(40).await;

        assert_eq!(
            positions(&spread(&store, Some("can"), 500).await),
            (0..40u8).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn the_tail_is_the_newest_run_oldest_first() {
        let store = can_capture_of(100).await;

        assert_eq!(
            positions(&recent(&store, Some("can"), 10).await),
            (90..100u8).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn the_tail_past_the_population_is_everything_in_order() {
        let store = can_capture_of(40).await;

        assert_eq!(
            positions(&recent(&store, Some("can"), 500).await),
            (0..40u8).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn the_tail_does_not_cross_protocols() {
        let store = multi_protocol_capture().await;

        assert_eq!(recent(&store, Some("modbus"), 100).await, [[0xBB]]);
    }

    /// Filtering on `is_extended`, which `idx_frames_capture_fid` lacks, or a window
    /// function both take the rowid pass off the covering plan.
    #[tokio::test]
    async fn payload_sampling_takes_its_rowids_from_the_covering_index() {
        let store = multi_protocol_capture().await;
        let filter = frame_filter("c1", &query(Some("can"), 1, Sampling::Spread));
        let inlined = Sql {
            sql: format!(
                "SELECT rowid FROM frames WHERE {} ORDER BY rowid",
                filter.sql
            ),
            values: filter.values,
        }
        .inlined();

        let plan = plan(&store, &inlined, None).await;

        assert!(
            plan.contains("COVERING INDEX idx_frames_capture_fid"),
            "rowid pass should stay covering, got: {plan}"
        );
        assert!(
            !plan.contains("TEMP B-TREE"),
            "rowid pass should not sort, got: {plan}"
        );
    }
}
