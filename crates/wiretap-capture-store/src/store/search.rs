use wslib_wiretap_protocol::FrameSelection;

use crate::store::error::Result;
use crate::store::read::{selection_json, selection_predicate};
use crate::Store;

impl Store {
    /// The 0-based offsets, among a selection's frames, of those whose lowercase hex id
    /// (`search_id`, an `0x` prefix dropped) or uppercase hex payload (`search_data`)
    /// contains `query`. The caller strips whitespace; `LIKE` wildcards are not escaped.
    pub async fn search_frames(
        &self,
        capture_id: &str,
        query: &str,
        search_id: bool,
        search_data: bool,
        selection: &FrameSelection,
    ) -> Result<Vec<usize>> {
        if query.is_empty() || (!search_id && !search_data) {
            return Ok(Vec::new());
        }
        let q = query
            .strip_prefix("0x")
            .or_else(|| query.strip_prefix("0X"))
            .unwrap_or(query);
        let mut clauses = Vec::new();
        let mut patterns = Vec::new();
        for (searched, column, text) in [
            (search_id, "printf('%x', frame_id)", q.to_lowercase()),
            (search_data, "upper(hex(payload))", q.to_uppercase()),
        ] {
            if searched {
                clauses.push(format!("{column} LIKE ?{}", patterns.len() + 3));
                patterns.push(format!("%{text}%"));
            }
        }
        let id_filter = if selection.is_empty() {
            String::new()
        } else {
            format!(" {}", selection_predicate(2, selection))
        };
        let sql = format!(
            "WITH numbered AS (
                SELECT frame_id, payload,
                       CAST(ROW_NUMBER() OVER (ORDER BY rowid) AS INTEGER) - 1 AS offset
                FROM frames
                WHERE capture_id = ?1{id_filter}
            )
            SELECT offset FROM numbered WHERE {}",
            clauses.join(" OR ")
        );

        let statement = patterns.into_iter().fold(
            sqlx::query_scalar::<_, i64>(&sql)
                .bind(capture_id)
                .bind(selection_json(selection)),
            |statement, pattern| statement.bind(pattern),
        );
        let offsets = statement.fetch_all(self.pool()).await?;
        Ok(offsets.into_iter().map(|n| n as usize).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::{can_frame, StoredFrame};
    use crate::store::testing::{selection, store};

    async fn capture(frames: &[(u32, &[u8])]) -> crate::store::testing::TestStore {
        let store = store().await;
        let frames: Vec<StoredFrame> = frames
            .iter()
            .map(|&(frame_id, payload)| can_frame(frame_id, payload))
            .collect();
        store.insert_frames("c1", &frames).await.unwrap();
        store
    }

    async fn search(store: &Store, query: &str, search_id: bool, search_data: bool) -> Vec<usize> {
        store
            .search_frames(
                "c1",
                query,
                search_id,
                search_data,
                &FrameSelection::default(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_search_matches_a_substring_of_the_unpadded_lowercase_hex_id() {
        let store = capture(&[(0x100, &[]), (0x210, &[]), (0x7AB, &[])]).await;
        assert_eq!(search(&store, "10", true, false).await, [0, 1]);
        assert_eq!(search(&store, "0x7AB", true, false).await, [2]);
        assert_eq!(search(&store, "", true, false).await, Vec::<usize>::new());
        assert_eq!(
            search(&store, "10", false, false).await,
            Vec::<usize>::new()
        );
    }

    #[tokio::test]
    async fn a_data_search_matches_hex_across_byte_boundaries_in_either_case() {
        let store = capture(&[(1, &[0xDE, 0xAD]), (2, &[0xBE, 0xEF]), (3, &[0x0E, 0xAD])]).await;
        assert_eq!(search(&store, "ead", false, true).await, [0, 2]);
        assert_eq!(
            search(&store, "EADB", false, true).await,
            Vec::<usize>::new()
        );
        assert_eq!(search(&store, "2", true, true).await, [1]);
    }

    #[tokio::test]
    async fn like_wildcards_in_a_query_are_not_escaped() {
        let store = capture(&[(0x100, &[0x01]), (0x200, &[0x02])]).await;
        assert_eq!(search(&store, "_", true, false).await, [0, 1]);
        assert_eq!(search(&store, "1%0", true, false).await, [0]);
        assert_eq!(search(&store, "'", true, true).await, Vec::<usize>::new());
    }

    #[tokio::test]
    async fn a_search_offset_counts_only_the_selected_frames() {
        let store = capture(&[(0x100, &[]), (0x200, &[]), (0x100, &[])]).await;
        let only_0x100 = selection(&[("can", &[0x100])]);
        assert_eq!(
            store
                .search_frames("c1", "100", true, false, &only_0x100)
                .await
                .unwrap(),
            [0, 1]
        );
    }
}
