use sqlx::sqlite::{SqliteArguments, SqliteRow};
use sqlx::{Row, Sqlite};
use wslib_wiretap_protocol::FrameSelection;

use crate::frames::{StoredFrame, STORED_LENGTH};
use crate::model::CaptureFrameInfo;
use crate::store::error::Result;
use crate::store::frames::{row_to_frame, row_to_frame_with_rowid, FRAME_COLUMNS};
use crate::Store;

/// Frames and their rowids, parallel and oldest first.
type Page = (Vec<StoredFrame>, Vec<i64>);

type Query<'q> = sqlx::query::Query<'q, Sqlite, SqliteArguments<'q>>;

/// Restrict a frame query to a selection bound as the one JSON parameter `?{param}`.
/// No `OR` for a pair-only selection: it would turn the covering-index seek into a scan.
pub(crate) fn selection_predicate(param: usize, selection: &FrameSelection) -> String {
    let by_pair = format!(
        "(frame_id, protocol) IN (SELECT j.value ->> 0, j.value ->> 1 FROM json_each(?{param}, '$.pairs') j)"
    );
    let by_protocol = format!("protocol IN (SELECT value FROM json_each(?{param}, '$.protocols'))");
    match (
        selection.protocols().is_empty(),
        selection.pairs().is_empty(),
    ) {
        (true, _) => format!("AND {by_pair}"),
        (false, true) => format!("AND {by_protocol}"),
        (false, false) => format!("AND ({by_protocol} OR {by_pair})"),
    }
}

pub(crate) fn selection_json(selection: &FrameSelection) -> String {
    serde_json::json!({ "protocols": selection.protocols(), "pairs": selection.pairs() })
        .to_string()
}

/// The predicate and its parameter, both empty for an empty selection.
fn optional_selection(param: usize, selection: &FrameSelection) -> (String, Option<String>) {
    if selection.is_empty() {
        (String::new(), None)
    } else {
        (
            selection_predicate(param, selection),
            Some(selection_json(selection)),
        )
    }
}

fn page(rows: Vec<(i64, StoredFrame)>) -> Page {
    let (rowids, frames) = rows.into_iter().unzip();
    (frames, rowids)
}

fn tail(mut rows: Vec<(i64, StoredFrame)>) -> Page {
    rows.reverse();
    page(rows)
}

impl Store {
    async fn frames_with_rowids(&self, query: Query<'_>) -> Result<Vec<(i64, StoredFrame)>> {
        Ok(query
            .try_map(|row: SqliteRow| row_to_frame_with_rowid(&row))
            .fetch_all(self.pool())
            .await?)
    }

    async fn frames(&self, sql: &str, capture_id: &str) -> Result<Vec<StoredFrame>> {
        Ok(sqlx::query(sql)
            .bind(capture_id)
            .try_map(|row: SqliteRow| row_to_frame(&row))
            .fetch_all(self.pool())
            .await?)
    }

    async fn count(&self, query: Query<'_>) -> Result<usize> {
        let row = query.fetch_one(self.pool()).await?;
        Ok(row.try_get::<i64, _>(0)? as usize)
    }

    async fn selection_count(
        &self,
        capture_id: &str,
        selection: &FrameSelection,
        pairs: &str,
    ) -> Result<usize> {
        let sql = format!(
            "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 {}",
            selection_predicate(2, selection)
        );
        self.count(sqlx::query(&sql).bind(capture_id).bind(pairs))
            .await
    }

    /// A page of a capture's frames in capture order.
    pub async fn get_frames_paginated(
        &self,
        capture_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Page> {
        let sql = format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 ORDER BY rowid LIMIT ?2 OFFSET ?3"
        );
        let query = sqlx::query(&sql)
            .bind(capture_id)
            .bind(limit as i64)
            .bind(offset as i64);
        self.frames_with_rowids(query).await.map(page)
    }

    /// A page of a selection's frames in capture order, with how many the selection holds.
    pub async fn get_frames_paginated_filtered(
        &self,
        capture_id: &str,
        offset: usize,
        limit: usize,
        selection: &FrameSelection,
    ) -> Result<(Vec<StoredFrame>, Vec<i64>, usize)> {
        if selection.is_empty() {
            let (frames, rowids) = self.get_frames_paginated(capture_id, offset, limit).await?;
            return Ok((frames, rowids, self.get_frame_count(capture_id).await?));
        }
        let pairs = selection_json(selection);
        let total = self.selection_count(capture_id, selection, &pairs).await?;
        let sql = format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 {} ORDER BY rowid LIMIT ?2 OFFSET ?3",
            selection_predicate(4, selection)
        );
        let query = sqlx::query(&sql)
            .bind(capture_id)
            .bind(limit as i64)
            .bind(offset as i64)
            .bind(&pairs);
        let (frames, rowids) = page(self.frames_with_rowids(query).await?);
        Ok((frames, rowids, total))
    }

    /// A capture's newest `limit` frames, oldest first. Seeks `idx_frames_capture_rowid`
    /// with no `OFFSET`, so the cost is independent of the capture's length.
    pub async fn get_frames_tail_rows(&self, capture_id: &str, limit: usize) -> Result<Page> {
        let sql = format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 ORDER BY rowid DESC LIMIT ?2"
        );
        let query = sqlx::query(&sql).bind(capture_id).bind(limit as i64);
        self.frames_with_rowids(query).await.map(tail)
    }

    /// A non-empty selection's newest `limit` frames, oldest first, with how many it holds.
    pub async fn get_frames_tail_filtered(
        &self,
        capture_id: &str,
        limit: usize,
        selection: &FrameSelection,
    ) -> Result<(Vec<StoredFrame>, Vec<i64>, usize)> {
        debug_assert!(!selection.is_empty(), "use get_frames_tail_rows");
        let pairs = selection_json(selection);
        let total = self.selection_count(capture_id, selection, &pairs).await?;
        let sql = format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 {} ORDER BY rowid DESC LIMIT ?2",
            selection_predicate(3, selection)
        );
        let query = sqlx::query(&sql)
            .bind(capture_id)
            .bind(limit as i64)
            .bind(&pairs);
        let (frames, rowids) = tail(self.frames_with_rowids(query).await?);
        Ok((frames, rowids, total))
    }

    pub async fn get_frame_count(&self, capture_id: &str) -> Result<usize> {
        self.count(
            sqlx::query("SELECT COUNT(*) FROM frames WHERE capture_id = ?1").bind(capture_id),
        )
        .await
    }

    /// The protocols other than CAN a capture holds, alphabetically.
    pub async fn non_can_protocols(&self, capture_id: &str) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar(
            "SELECT DISTINCT protocol FROM frames WHERE capture_id = ?1 AND protocol != 'can' ORDER BY protocol",
        )
        .bind(capture_id)
        .fetch_all(self.pool())
        .await?)
    }

    /// One row per frame identity in a capture.
    pub async fn get_frame_info(&self, capture_id: &str) -> Result<Vec<CaptureFrameInfo>> {
        let sql = format!(
            "SELECT protocol, frame_id, MAX({STORED_LENGTH}) as max_dlc, MIN(bus) as bus, MAX(is_extended) as is_extended,
                    (MIN({STORED_LENGTH}) != MAX({STORED_LENGTH})) as has_dlc_mismatch
             FROM frames WHERE capture_id = ?1 GROUP BY protocol, frame_id",
        );
        Ok(sqlx::query(&sql)
            .bind(capture_id)
            .try_map(|row: SqliteRow| {
                Ok(CaptureFrameInfo {
                    protocol: row.try_get("protocol")?,
                    frame_id: row.try_get::<i64, _>("frame_id")? as u32,
                    max_dlc: row.try_get::<i64, _>("max_dlc")? as u16,
                    bus: row.try_get::<i64, _>("bus")? as u8,
                    is_extended: row.try_get::<i64, _>("is_extended")? != 0,
                    has_dlc_mismatch: row.try_get::<i64, _>("has_dlc_mismatch")? != 0,
                })
            })
            .fetch_all(self.pool())
            .await?)
    }

    /// How many of a selection's frames come before `target_us`.
    pub async fn find_offset_for_timestamp(
        &self,
        capture_id: &str,
        target_us: u64,
        selection: &FrameSelection,
    ) -> Result<usize> {
        let (predicate, json) = optional_selection(3, selection);
        let sql = format!(
            "SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND timestamp_us < ?2 {predicate}"
        );
        let mut query = sqlx::query(&sql).bind(capture_id).bind(target_us as i64);
        if let Some(json) = json {
            query = query.bind(json);
        }
        self.count(query).await
    }

    /// Every frame in a capture, in capture order; for a capture known to be small.
    pub async fn get_all_frames(&self, capture_id: &str) -> Result<Vec<StoredFrame>> {
        self.frames(
            &format!("SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 ORDER BY rowid"),
            capture_id,
        )
        .await
    }

    /// The newest frame of each identity in a capture, by frame id: a Modbus sweep's
    /// values without every pass that wrote them.
    pub async fn get_latest_frames(&self, capture_id: &str) -> Result<Vec<StoredFrame>> {
        self.frames(
            &format!(
                "SELECT {FRAME_COLUMNS} FROM frames
                 WHERE rowid IN (
                     SELECT MAX(rowid) FROM frames WHERE capture_id = ?1 GROUP BY protocol, frame_id
                 )
                 ORDER BY frame_id"
            ),
            capture_id,
        )
        .await
    }

    /// Up to `limit` frames after `after_rowid`, oldest first.
    pub async fn read_frame_chunk(
        &self,
        capture_id: &str,
        after_rowid: i64,
        limit: usize,
    ) -> Result<Vec<(i64, StoredFrame)>> {
        let sql = format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 AND rowid > ?2 ORDER BY rowid ASC LIMIT ?3"
        );
        self.frames_with_rowids(
            sqlx::query(&sql)
                .bind(capture_id)
                .bind(after_rowid)
                .bind(limit as i64),
        )
        .await
    }

    /// Up to `limit` frames before `before_rowid`, newest first.
    pub async fn read_frame_chunk_reverse(
        &self,
        capture_id: &str,
        before_rowid: i64,
        limit: usize,
    ) -> Result<Vec<(i64, StoredFrame)>> {
        let sql = format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 AND rowid < ?2 ORDER BY rowid DESC LIMIT ?3"
        );
        self.frames_with_rowids(
            sqlx::query(&sql)
                .bind(capture_id)
                .bind(before_rowid)
                .bind(limit as i64),
        )
        .await
    }

    /// A capture's first and last rowid, `None` when it holds no frames.
    pub async fn get_rowid_range(&self, capture_id: &str) -> Result<Option<(i64, i64)>> {
        let (first, last): (Option<i64>, Option<i64>) =
            sqlx::query_as("SELECT MIN(rowid), MAX(rowid) FROM frames WHERE capture_id = ?1")
                .bind(capture_id)
                .fetch_one(self.pool())
                .await?;
        Ok(first.zip(last))
    }

    /// The first frame at or after `timestamp_us`.
    pub async fn find_rowid_for_timestamp(
        &self,
        capture_id: &str,
        timestamp_us: u64,
    ) -> Result<Option<i64>> {
        Ok(sqlx::query_scalar(
            "SELECT rowid FROM frames WHERE capture_id = ?1 AND timestamp_us >= ?2 ORDER BY timestamp_us ASC, rowid ASC LIMIT 1",
        )
        .bind(capture_id)
        .bind(timestamp_us as i64)
        .fetch_optional(self.pool())
        .await?)
    }

    /// The frame at 0-based `index` in capture order.
    pub async fn get_frame_at_index(
        &self,
        capture_id: &str,
        index: usize,
    ) -> Result<Option<(i64, StoredFrame)>> {
        let sql = format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 ORDER BY rowid LIMIT 1 OFFSET ?2"
        );
        Ok(sqlx::query(&sql)
            .bind(capture_id)
            .bind(index as i64)
            .try_map(|row: SqliteRow| row_to_frame_with_rowid(&row))
            .fetch_optional(self.pool())
            .await?)
    }

    /// The selection's next frame after `current_rowid`, or previous one before it, with
    /// its 0-based index in the whole capture.
    pub async fn get_next_filtered_frame(
        &self,
        capture_id: &str,
        current_rowid: i64,
        selection: &FrameSelection,
        backward: bool,
    ) -> Result<Option<(i64, usize, StoredFrame)>> {
        let (op, order) = if backward {
            ("<", "DESC")
        } else {
            (">", "ASC")
        };
        let (predicate, json) = optional_selection(3, selection);
        let sql = format!(
            "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = ?1 AND rowid {op} ?2 {predicate} \
             ORDER BY rowid {order} LIMIT 1"
        );
        let mut query = sqlx::query(&sql).bind(capture_id).bind(current_rowid);
        if let Some(json) = json {
            query = query.bind(json);
        }
        let Some((rowid, frame)) = query
            .try_map(|row: SqliteRow| row_to_frame_with_rowid(&row))
            .fetch_optional(self.pool())
            .await?
        else {
            return Ok(None);
        };
        let index = self.count_frames_before_rowid(capture_id, rowid).await?;
        Ok(Some((rowid, index, frame)))
    }

    /// How many of a capture's frames come before `rowid`: its 0-based index.
    pub async fn count_frames_before_rowid(&self, capture_id: &str, rowid: i64) -> Result<usize> {
        self.count(
            sqlx::query("SELECT COUNT(*) FROM frames WHERE capture_id = ?1 AND rowid < ?2")
                .bind(capture_id)
                .bind(rowid),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::can_frame;
    use crate::store::testing::{multi_protocol_capture, plan, selection, store, whole};
    use wslib_wiretap_protocol::ProtocolFrames;

    fn ids(frames: &[StoredFrame]) -> Vec<(&str, u32)> {
        frames
            .iter()
            .map(|f| (f.protocol.as_str(), f.frame_id))
            .collect()
    }

    #[tokio::test]
    async fn a_whole_protocol_selects_all_its_rows_and_no_others() {
        let store = multi_protocol_capture().await;

        let (frames, _, total) = store
            .get_frames_paginated_filtered("c1", 0, 50, &whole("can"))
            .await
            .unwrap();
        assert_eq!(total, 2);
        assert_eq!(ids(&frames), [("can", 256), ("can", 257)]);

        let (tail, _, total) = store
            .get_frames_tail_filtered("c1", 50, &whole("modbus"))
            .await
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(tail[0].protocol, "modbus");

        let combined = FrameSelection::from_groups(vec![
            ProtocolFrames::whole("serial"),
            ProtocolFrames::ids("can", vec![257]),
        ]);
        let (frames, _, total) = store
            .get_frames_paginated_filtered("c1", 0, 50, &combined)
            .await
            .unwrap();
        assert_eq!(total, 2);
        let mut got = ids(&frames);
        got.sort_unstable();
        assert_eq!(got, [("can", 257), ("serial", 256)]);
    }

    /// A bare `frame_id IN (…)` matched CAN 0x100 and Modbus register 256 against each other.
    #[tokio::test]
    async fn filtered_page_does_not_cross_protocols() {
        let store = multi_protocol_capture().await;

        let (frames, _, total) = store
            .get_frames_paginated_filtered("c1", 0, 50, &selection(&[("can", &[256])]))
            .await
            .unwrap();

        assert_eq!(total, 1);
        assert_eq!(ids(&frames), [("can", 256)]);
        assert_eq!(frames[0].len, 8);
    }

    #[tokio::test]
    async fn filtered_tail_does_not_cross_protocols() {
        let store = multi_protocol_capture().await;

        let (frames, _, total) = store
            .get_frames_tail_filtered("c1", 50, &selection(&[("modbus", &[256])]))
            .await
            .unwrap();

        assert_eq!(total, 1);
        assert_eq!(ids(&frames), [("modbus", 256)]);
    }

    #[tokio::test]
    async fn selecting_one_id_on_two_protocols_returns_both() {
        let store = multi_protocol_capture().await;

        let (frames, _, total) = store
            .get_frames_paginated_filtered(
                "c1",
                0,
                50,
                &selection(&[("can", &[256]), ("modbus", &[256])]),
            )
            .await
            .unwrap();

        assert_eq!(total, 2);
        assert_eq!(ids(&frames), [("can", 256), ("modbus", 256)]);
    }

    #[tokio::test]
    async fn filtered_page_keeps_capture_order() {
        let store = multi_protocol_capture().await;
        let all_can = selection(&[("can", &[256, 257])]);

        let (frames, _, total) = store
            .get_frames_paginated_filtered("c1", 0, 50, &all_can)
            .await
            .unwrap();
        assert_eq!(total, 2);
        assert_eq!(ids(&frames), [("can", 256), ("can", 257)]);

        let (page_two, _, total) = store
            .get_frames_paginated_filtered("c1", 1, 1, &all_can)
            .await
            .unwrap();
        assert_eq!(total, 2);
        assert_eq!(ids(&page_two), [("can", 257)]);
    }

    #[tokio::test]
    async fn protocol_is_bound_not_interpolated() {
        let store = multi_protocol_capture().await;

        let (frames, _, total) = store
            .get_frames_paginated_filtered(
                "c1",
                0,
                50,
                &selection(&[("can'); DROP TABLE frames;--", &[256])]),
            )
            .await
            .unwrap();

        assert_eq!(total, 0);
        assert!(frames.is_empty());
        assert_eq!(store.get_frame_count("c1").await.unwrap(), 4);
    }

    /// An `OR` on the protocol arm turned this seek into a walk of the capture.
    #[tokio::test]
    async fn filtered_count_uses_the_covering_index() {
        let store = multi_protocol_capture().await;
        let by_id = selection(&[("can", &[256])]);

        let plan = plan(
            &store,
            &format!(
                "SELECT COUNT(*) FROM frames WHERE capture_id = 'c1' {}",
                selection_predicate(1, &by_id)
            ),
            Some(selection_json(&by_id)),
        )
        .await;

        assert!(
            plan.contains("COVERING INDEX idx_frames_capture_fid") && plan.contains("frame_id=?"),
            "filtered count should seek the id on the covering index, got: {plan}"
        );
    }

    /// Without `idx_frames_capture_rowid` the tail sorts the whole capture into a
    /// temp b-tree.
    #[tokio::test]
    async fn rowid_index_serves_the_tail_query() {
        let store = store().await;

        let plan = plan(
            &store,
            &format!(
                "SELECT {FRAME_COLUMNS} FROM frames WHERE capture_id = 'c1' ORDER BY rowid DESC LIMIT 50"
            ),
            None,
        )
        .await;

        assert!(
            plan.contains("idx_frames_capture_rowid"),
            "tail query should use the rowid index, got: {plan}"
        );
    }

    #[tokio::test]
    async fn a_stored_length_code_reads_as_the_payload_length_and_an_rtr_keeps_its_requested_length(
    ) {
        let store = store().await;
        sqlx::query(
            "INSERT INTO frames (capture_id, protocol, timestamp_us, frame_id, bus, dlc, payload, is_fd, is_rtr)
             VALUES ('c1', 'can', 1, 256, 0, 15, ?1, 1, 0), ('c1', 'can', 2, 257, 0, 6, x'', 0, 1)",
        )
        .bind(vec![0u8; 64])
        .execute(store.database().pool())
        .await
        .unwrap();

        let (frames, _, _) = store
            .get_frames_paginated_filtered("c1", 0, 10, &whole("can"))
            .await
            .unwrap();
        assert_eq!(frames.iter().map(|f| f.len).collect::<Vec<_>>(), [64, 6]);

        let info = store.get_frame_info("c1").await.unwrap();
        assert_eq!(
            info.iter()
                .map(|i| (i.max_dlc, i.has_dlc_mismatch))
                .collect::<Vec<_>>(),
            [(64, false), (6, false)]
        );
    }

    #[tokio::test]
    async fn frame_info_flags_a_length_that_varies() {
        let store = store().await;
        store
            .insert_frames(
                "c1",
                &[
                    can_frame(1, &[1, 2]),
                    StoredFrame {
                        bus: 2,
                        extended: true,
                        ..can_frame(1, &[1, 2, 3])
                    },
                ],
            )
            .await
            .unwrap();

        let info = store.get_frame_info("c1").await.unwrap();

        assert_eq!(
            info,
            [CaptureFrameInfo {
                protocol: "can".into(),
                frame_id: 1,
                max_dlc: 3,
                bus: 0,
                is_extended: true,
                has_dlc_mismatch: true,
            }]
        );
    }

    #[tokio::test]
    async fn all_frames_come_back_in_insertion_order_with_their_bytes() {
        let store = store().await;
        store
            .insert_frames("c1", &[can_frame(0x200, &[1, 2]), can_frame(0x100, &[3])])
            .await
            .unwrap();

        let frames = store.get_all_frames("c1").await.unwrap();

        let summary: Vec<_> = frames
            .iter()
            .map(|f| (f.frame_id, f.payload.clone()))
            .collect();
        assert_eq!(summary, [(0x200, vec![1, 2]), (0x100, vec![3])]);
        assert!(store
            .get_all_frames("no-such-capture")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn the_latest_frames_are_one_per_identity_and_the_newest() {
        let store = multi_protocol_capture().await;
        store
            .insert_frames("c1", &[can_frame(256, &[0xEE])])
            .await
            .unwrap();

        let latest = store.get_latest_frames("c1").await.unwrap();

        let mut got: Vec<_> = latest
            .iter()
            .map(|f| (f.protocol.as_str(), f.frame_id, f.payload[0]))
            .collect();
        got.sort_unstable();
        assert_eq!(
            got,
            [
                ("can", 256, 0xEE),
                ("can", 257, 0xDD),
                ("modbus", 256, 0xBB),
                ("serial", 256, 0xCC)
            ]
        );
        assert_eq!(
            store.non_can_protocols("c1").await.unwrap(),
            ["modbus", "serial"]
        );
    }

    #[tokio::test]
    async fn the_unfiltered_tail_is_the_newest_rows_oldest_first() {
        let store = multi_protocol_capture().await;

        let (frames, rowids) = store.get_frames_tail_rows("c1", 2).await.unwrap();

        assert_eq!(ids(&frames), [("serial", 256), ("can", 257)]);
        assert_eq!(rowids, [3, 4]);
        let (page, page_rowids) = store.get_frames_paginated("c1", 2, 2).await.unwrap();
        assert_eq!((page, page_rowids), (frames, rowids));
    }

    #[tokio::test]
    async fn playback_walks_the_capture_by_rowid_and_time() {
        let store = multi_protocol_capture().await;

        assert_eq!(store.get_rowid_range("c1").await.unwrap(), Some((1, 4)));
        assert_eq!(store.get_rowid_range("empty").await.unwrap(), None);

        let forward = store.read_frame_chunk("c1", 1, 2).await.unwrap();
        assert_eq!(forward.iter().map(|(r, _)| *r).collect::<Vec<_>>(), [2, 3]);
        let backward = store.read_frame_chunk_reverse("c1", 4, 2).await.unwrap();
        assert_eq!(backward.iter().map(|(r, _)| *r).collect::<Vec<_>>(), [3, 2]);

        assert_eq!(
            store.find_rowid_for_timestamp("c1", 25).await.unwrap(),
            Some(3)
        );
        assert_eq!(
            store.find_rowid_for_timestamp("c1", 41).await.unwrap(),
            None
        );

        let (rowid, frame) = store.get_frame_at_index("c1", 1).await.unwrap().unwrap();
        assert_eq!((rowid, frame.protocol.as_str()), (2, "modbus"));
        assert!(store.get_frame_at_index("c1", 4).await.unwrap().is_none());
        assert_eq!(store.count_frames_before_rowid("c1", 3).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn the_next_filtered_frame_skips_the_unselected_and_knows_its_index() {
        let store = multi_protocol_capture().await;
        let can = whole("can");

        let next = store
            .get_next_filtered_frame("c1", 1, &can, false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((next.0, next.1, next.2.frame_id), (4, 3, 257));
        let previous = store
            .get_next_filtered_frame("c1", 4, &can, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((previous.0, previous.1), (1, 0));
        assert!(store
            .get_next_filtered_frame("c1", 4, &can, false)
            .await
            .unwrap()
            .is_none());

        let unfiltered = store
            .get_next_filtered_frame("c1", 1, &FrameSelection::default(), false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!((unfiltered.0, unfiltered.1), (2, 1));
    }

    #[tokio::test]
    async fn the_offset_for_a_timestamp_counts_the_selected_frames_before_it() {
        let store = multi_protocol_capture().await;

        assert_eq!(
            store
                .find_offset_for_timestamp("c1", 35, &FrameSelection::default())
                .await
                .unwrap(),
            3
        );
        assert_eq!(
            store
                .find_offset_for_timestamp("c1", 35, &whole("can"))
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .find_offset_for_timestamp("c1", 0, &whole("can"))
                .await
                .unwrap(),
            0
        );
    }
}
