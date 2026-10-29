use crate::filter::{FrameRowFilter, Sql, SqlValue};
use crate::frames::STORED_LENGTH;

/// The statement for a filter's identities, one row each, in the column order
/// `inventory_row` reads; `limit` adds a bound `LIMIT`.
pub fn inventory_statement(capture_id: &str, filter: &FrameRowFilter, limit: Option<u32>) -> Sql {
    let filter = filter.sql_where(capture_id);
    let mut statement = Sql {
        sql: format!(
            "SELECT protocol, frame_id, is_extended, COUNT(*), MIN(timestamp_us), MAX(timestamp_us), MAX({STORED_LENGTH}) \
             FROM frames WHERE {} \
             GROUP BY protocol, frame_id, is_extended ORDER BY frame_id, protocol, is_extended{}",
            filter.sql,
            if limit.is_some() { " LIMIT ?" } else { "" }
        ),
        values: filter.values,
    };
    statement
        .values
        .extend(limit.map(|n| SqlValue::Integer(n.into())));
    statement
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_statement_is_the_one_shown_for_it() {
        let filter = FrameRowFilter {
            start_us: Some(1),
            end_us: Some(2),
            ..Default::default()
        };
        assert_eq!(
            inventory_statement("c'1", &filter, None).inlined(),
            "SELECT protocol, frame_id, is_extended, COUNT(*), MIN(timestamp_us), MAX(timestamp_us), \
             MAX(MAX(dlc, length(payload))) FROM frames WHERE capture_id = 'c''1' AND timestamp_us >= 1 \
             AND timestamp_us < 2 GROUP BY protocol, frame_id, is_extended ORDER BY frame_id, protocol, is_extended"
        );
    }
}
