//! Each row filter, as `FrameRowFilter::sql_where` writes it, run against a
//! capture, selects exactly the rows the filter describes.

use sqlx::Row;
use wiretap_capture::{chain, Cancel, CaptureProtocol, FrameRowFilter, Sql, Store, StoredFrame};
use wslib_db_sqlite::Database;
use wslib_wiretap_protocol::Protocol;

const CAPTURE: &str = "c1";

async fn seeded() -> (Store, Vec<StoredFrame>) {
    let store = Store::from_database(Database::open_in_memory(&[chain()]).await.unwrap());
    let mut frames = Vec::new();
    for (i, protocol) in ["can", "canfd", "modbus", "modbus_rtu", "serial"]
        .into_iter()
        .enumerate()
    {
        for frame_id in [0x100, 0x101, 0x200] {
            for extended in [false, true] {
                for timestamp_us in [999_999, 1_000_000, 1_500_000, 2_000_000] {
                    frames.push(StoredFrame {
                        protocol: protocol.into(),
                        timestamp_us: timestamp_us + i as u64,
                        frame_id,
                        extended,
                        len: 1,
                        payload: vec![0xAA],
                        ..Default::default()
                    });
                }
            }
        }
    }
    store.insert_frames(CAPTURE, &frames).await.unwrap();
    store.insert_frames("decoy", &frames).await.unwrap();
    (store, frames)
}

fn selects(filter: &FrameRowFilter, f: &StoredFrame) -> bool {
    let ts = f.timestamp_us as i64;
    filter.frame_id.is_none_or(|id| id == f.frame_id)
        && filter.is_extended.is_none_or(|e| e == f.extended)
        && (filter.protocols.is_empty()
            || f.capture_protocol()
                .is_some_and(|p| filter.protocols.contains(&p)))
        && filter.start_us.is_none_or(|s| ts >= s)
        && filter.end_us.is_none_or(|e| ts < e)
}

#[tokio::test]
async fn every_row_filter_selects_exactly_its_rows() {
    let (store, frames) = seeded().await;
    let protocols = [
        None,
        Some(Protocol::Can),
        Some(Protocol::ModbusRtu),
        Some(Protocol::Serial),
    ];
    let mut checked = 0;
    for protocol in protocols {
        for (start_us, end_us) in [(None, None), (Some(1_000_000), Some(2_000_000))] {
            for is_extended in [None, Some(true)] {
                for frame_id in [None, Some(0x100), Some(0x101)] {
                    let filter = FrameRowFilter {
                        frame_id,
                        is_extended,
                        protocols: protocol
                            .map_or_else(Vec::new, |p| CaptureProtocol::of(p).to_vec()),
                        start_us,
                        end_us,
                    };
                    let condition = filter.sql_where(CAPTURE);
                    let statement = Sql {
                        sql: format!(
                            "SELECT rowid FROM frames WHERE {} ORDER BY rowid",
                            condition.sql
                        ),
                        values: condition.values,
                    };
                    let got = store
                        .read_rows(&statement, &Cancel::new(), |r| r.try_get::<i64, _>(0))
                        .await
                        .unwrap();
                    let expected: Vec<i64> = frames
                        .iter()
                        .zip(1..)
                        .filter(|(f, _)| selects(&filter, f))
                        .map(|(_, rowid)| rowid)
                        .collect();
                    assert!(
                        !expected.is_empty(),
                        "{filter:?} selects nothing to compare"
                    );
                    assert_eq!(got, expected, "{filter:?}\n{}", statement.sql);
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 4 * 2 * 2 * 3);
}
