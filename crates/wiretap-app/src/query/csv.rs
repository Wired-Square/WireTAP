// crates/wiretap-app/src/query/csv.rs
//
// A query's results as CSV, one row per result at full precision.

use super::QueryResults;

fn byte(value: u8) -> String {
    format!("0x{value:02X}")
}

fn hex(payload: &[u8]) -> String {
    payload.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
}

fn spaced(indices: &[u64]) -> String {
    indices.iter().map(u64::to_string).collect::<Vec<_>>().join(" ")
}

macro_rules! row {
    ($($field:expr),* $(,)?) => { vec![$($field.to_string()),*] };
}

pub fn render(results: &QueryResults) -> String {
    let (header, rows): (&[&str], Vec<Vec<String>>) = match results {
        QueryResults::ByteChanges(r) => (
            &["timestamp_us", "old_value", "new_value"],
            r.iter().map(|r| row![r.timestamp_us, byte(r.old_value), byte(r.new_value)]).collect(),
        ),
        QueryResults::FrameChanges(r) => (
            &["timestamp_us", "changed_count", "changed_indices", "old_payload", "new_payload"],
            r.iter()
                .map(|r| {
                    row![
                        r.timestamp_us,
                        r.changed_indices.len(),
                        spaced(&r.changed_indices),
                        hex(&r.old_payload),
                        hex(&r.new_payload),
                    ]
                })
                .collect(),
        ),
        QueryResults::MirrorValidation(r) => (
            &["mirror_timestamp_us", "source_timestamp_us", "mismatch_count", "mismatch_indices", "mirror_payload", "source_payload"],
            r.iter()
                .map(|r| {
                    row![
                        r.mirror_timestamp_us,
                        r.source_timestamp_us,
                        r.mismatch_indices.len(),
                        spaced(&r.mismatch_indices),
                        hex(&r.mirror_payload),
                        hex(&r.source_payload),
                    ]
                })
                .collect(),
        ),
        QueryResults::MuxStatistics(m) => (
            &["mux_value", "frame_count", "byte_index", "bits", "endianness", "min", "max", "avg", "distinct_count", "sample_count"],
            m.cases
                .iter()
                .flat_map(|c| {
                    let bytes = c.byte_stats.iter().map(|b| {
                        row![c.mux_value, c.frame_count, b.byte_index, 8, "", b.min, b.max, b.avg, b.distinct_count, b.sample_count]
                    });
                    let words = c.word16_stats.iter().map(|w| {
                        row![c.mux_value, c.frame_count, w.start_byte, 16, w.endianness, w.min, w.max, w.avg, w.distinct_count, ""]
                    });
                    bytes.chain(words).collect::<Vec<_>>()
                })
                .collect(),
        ),
        QueryResults::FirstLast(r) => (
            &["position", "timestamp_us", "payload", "total_count"],
            vec![
                row!["first", r.first_timestamp_us, hex(&r.first_payload), r.total_count],
                row!["last", r.last_timestamp_us, hex(&r.last_payload), r.total_count],
            ],
        ),
        QueryResults::Frequency(r) => (
            &["bucket_start_us", "frame_count", "min_interval_us", "max_interval_us", "avg_interval_us"],
            r.iter()
                .map(|r| row![r.bucket_start_us, r.frame_count, r.min_interval_us, r.max_interval_us, r.avg_interval_us])
                .collect(),
        ),
        QueryResults::Distribution(r) => (
            &["value", "count", "percentage"],
            r.iter().map(|r| row![byte(r.value), r.count, r.percentage]).collect(),
        ),
        QueryResults::GapAnalysis(r) => (
            &["gap_start_us", "gap_end_us", "duration_ms"],
            r.iter().map(|r| row![r.gap_start_us, r.gap_end_us, r.duration_ms]).collect(),
        ),
        QueryResults::PatternSearch(r) => (
            &["timestamp_us", "frame_id", "is_extended", "payload", "match_positions"],
            r.iter()
                .map(|r| row![r.timestamp_us, r.frame_id, r.is_extended, hex(&r.payload), spaced(&r.match_positions)])
                .collect(),
        ),
        QueryResults::FrameInventory(r) => (
            &["protocol", "frame_id", "frame_id_hex", "is_extended", "count", "first_us", "last_us", "max_dlc"],
            r.iter()
                .map(|r| row![r.protocol, r.frame_id, r.frame_id_hex, r.is_extended, r.count, r.first_us, r.last_us, r.max_dlc])
                .collect(),
        ),
    };
    std::iter::once(header.join(","))
        .chain(rows.iter().map(|r| r.join(",")))
        .map(|line| line + "\n")
        .collect()
}
