//! The query kernels against the desktop's capture queries (`capturequery.rs`,
//! `queryresults.rs`, WireTAP `ebab8d9d`). A test named for a deviation pins
//! where the kernel differs on purpose.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use wiretap_analysis::query::*;
use wslib_wiretap_catalogue::Catalogue;
use wslib_wiretap_gateway::{FirstLastResult, FrequencyQueryResult};

fn row(timestamp_us: i64, payload: &[u8]) -> QueryRow {
    QueryRow {
        timestamp_us,
        frame_id: 0x100,
        is_extended: false,
        payload: payload.to_vec(),
    }
}

fn rows(of: &[(i64, &[u8])]) -> Vec<QueryRow> {
    of.iter().map(|&(t, p)| row(t, p)).collect()
}

fn at(timestamps: &[i64]) -> Vec<QueryRow> {
    timestamps.iter().map(|&t| row(t, &[0])).collect()
}

#[test]
fn byte_changes_compare_only_rows_that_both_have_the_byte() {
    let rows = rows(&[
        (1, &[0, 1]),
        (2, &[0, 2]),
        (3, &[0]),
        (4, &[0, 9]),
        (5, &[0, 9]),
    ]);
    let changes = byte_changes(&rows, 1, None);
    let found: Vec<_> = changes
        .results
        .iter()
        .map(|c| (c.timestamp_us, c.old_value, c.new_value))
        .collect();
    assert_eq!(found, [(2, 1, 2)]);
    assert_eq!(changes.stats.rows_scanned, 5);
    assert_eq!(changes.stats.results_count, 1);
}

/// The desktop fetches `limit × 10` rows and may come back short of `limit`.
#[test]
fn deviation_byte_changes_limit_counts_changes_not_rows_fetched() {
    let mut payloads = vec![(0, [0u8].as_slice()); 30];
    payloads.extend([(1, [1u8].as_slice()), (2, [2].as_slice())]);
    assert_eq!(byte_changes(&rows(&payloads), 0, Some(2)).results.len(), 2);
}

/// The desktop pushes before it checks the limit, so 0 returns one.
#[test]
fn deviation_a_zero_limit_returns_nothing() {
    let rows = rows(&[(1, &[1]), (2, &[2])]);
    assert!(byte_changes(&rows, 0, Some(0)).results.is_empty());
    assert!(frame_changes(&rows, Some(0)).results.is_empty());
    assert!(pattern_search(&rows, &[2], &[0xFF], Some(0))
        .unwrap()
        .results
        .is_empty());
}

#[test]
fn frame_changes_mark_the_bytes_a_length_change_adds() {
    let rows = rows(&[(1, &[1, 2]), (2, &[1, 2]), (3, &[1, 3, 0]), (4, &[1])]);
    let changes: Vec<_> = frame_changes(&rows, None)
        .results
        .into_iter()
        .map(|c| (c.timestamp_us, c.changed_indices))
        .collect();
    assert_eq!(changes, [(3, vec![1, 2]), (4, vec![1, 2])]);
}

#[test]
fn differing_bytes_read_the_shorter_payload_as_zero_padded() {
    assert_eq!(
        differing_byte_indices(&[1, 0], &[1], None),
        Vec::<u64>::new()
    );
    assert_eq!(differing_byte_indices(&[1, 5, 6], &[2], None), [0, 1, 2]);
    let compare = BTreeSet::from([1]);
    assert_eq!(differing_byte_indices(&[1, 5], &[2], Some(&compare)), [1]);
}

#[test]
fn a_mirror_pairs_with_its_nearest_source_and_reports_mismatches() {
    let mirror = rows(&[(10_000, &[1]), (20_000, &[2]), (90_000, &[3])]);
    let source = rows(&[(9_000, &[9]), (12_000, &[1]), (21_000, &[2])]);
    let found = mirror_validation(&mirror, &source, 5, None, None);
    let pairs: Vec<_> = found
        .results
        .iter()
        .map(|r| {
            (
                r.mirror_timestamp_us,
                r.source_timestamp_us,
                r.mismatch_indices.clone(),
            )
        })
        .collect();
    assert_eq!(
        pairs,
        [(10_000, 9_000, vec![0])],
        "90 000 has no source in reach"
    );
    assert_eq!(found.stats.rows_scanned, 6);
}

#[test]
fn the_mirror_tolerance_window_is_inclusive() {
    let mirror = rows(&[(10_000, &[1]), (40_000, &[1])]);
    let source = rows(&[(15_000, &[2]), (45_001, &[2])]);
    let found = mirror_validation(&mirror, &source, 5, None, None);
    let pairs: Vec<_> = found
        .results
        .iter()
        .map(|r| (r.mirror_timestamp_us, r.source_timestamp_us))
        .collect();
    assert_eq!(pairs, [(10_000, 15_000)]);
}

#[test]
fn a_tie_between_sources_goes_to_the_earlier() {
    let mirror = rows(&[(10_000, &[1])]);
    let source = rows(&[(8_000, &[2]), (12_000, &[3])]);
    let found = mirror_validation(&mirror, &source, 5, None, None);
    assert_eq!(found.results[0].source_timestamp_us, 8_000);
}

/// Q8: the compared-byte filter runs before the limit, so the limit counts the
/// mismatches that are reported, not the ones a catalogue then hides.
#[test]
fn q8_the_compared_bytes_are_filtered_before_the_limit() {
    let mirror = rows(&[(1_000, &[1, 1]), (2_000, &[1, 1]), (3_000, &[1, 1])]);
    let source = rows(&[(1_000, &[1, 2]), (2_000, &[2, 1]), (3_000, &[2, 1])]);
    let compare = BTreeSet::from([0]);
    let found = mirror_validation(&mirror, &source, 0, Some(&compare), Some(1));
    assert_eq!(found.results.len(), 1);
    assert_eq!(found.results[0].mirror_timestamp_us, 2_000);
    assert_eq!(found.results[0].mismatch_indices, [0]);
}

const MASKED_MIRROR: &str = r#"
[meta]
name = "masked"
[meta.can]
frame_id_mask = 0xFFF
[frame.can."0x705"]
length = 8
[[frame.can."0x705".signals]]
name = "current"
start_bit = 0
bit_length = 16
[[frame.can."0x705".signals]]
name = "end_stop"
start_bit = 16
bit_length = 8
[frame.can."0x005"]
length = 8
mirror_of = "0x705"
[[frame.can."0x005".signals]]
name = "local_end_stop"
start_bit = 16
bit_length = 8
"#;

/// The desktop reads the catalogue from a path; the kernel takes it parsed.
#[test]
fn the_mirror_compare_set_is_the_mirrors_inherited_bytes() {
    let catalog = Catalogue::parse(MASKED_MIRROR).unwrap();
    assert_eq!(
        mirror_compare_set(&catalog, 0x7005),
        Some(BTreeSet::from([0, 1]))
    );
    assert_eq!(
        mirror_compare_set(&catalog, 0x705),
        None,
        "a source inherits nothing"
    );
    assert_eq!(
        mirror_compare_set(&catalog, 0x123),
        None,
        "not in the catalogue"
    );
}

#[test]
fn mux_statistics_group_by_the_selector() {
    let rows = rows(&[
        (1, &[1, 0x10, 0x00, 7]),
        (2, &[1, 0x30, 0x01, 7]),
        (3, &[0, 0xFF, 0xFF]),
        (4, &[]),
    ]);
    let stats = mux_statistics(&rows, 0, true, 4, None).results;
    assert_eq!(stats.total_frames, 3);
    assert_eq!(
        stats.cases.iter().map(|c| c.mux_value).collect::<Vec<_>>(),
        [0, 1]
    );

    let one = &stats.cases[1];
    assert_eq!(one.frame_count, 2);
    let byte1 = &one.byte_stats[0];
    assert_eq!(
        (byte1.byte_index, byte1.min, byte1.max, byte1.avg),
        (1, 0x10, 0x30, 32.0)
    );
    assert_eq!((byte1.distinct_count, byte1.sample_count), (2, 2));
    assert_eq!(one.byte_stats[2].distinct_count, 1);
    let words: Vec<_> = one
        .word16_stats
        .iter()
        .map(|w| (w.start_byte, w.endianness.as_str(), w.min, w.max))
        .collect();
    assert_eq!(
        words,
        [(1, "le", 0x0010, 0x0130), (1, "be", 0x1000, 0x3001)]
    );

    let zero = &stats.cases[0];
    assert_eq!(zero.byte_stats.len(), 2, "byte 3 is past this payload");
    assert_eq!(zero.word16_stats.len(), 2);
}

#[test]
fn mux_statistics_without_words_have_none() {
    let rows = rows(&[(1, &[1, 2, 3, 4])]);
    assert!(mux_statistics(&rows, 0, false, 4, None).results.cases[0]
        .word16_stats
        .is_empty());
}

/// The desktop's limit is payloads fetched (default 500 000); here it is cases.
#[test]
fn deviation_mux_limit_keeps_the_lowest_cases() {
    let rows = rows(&[(1, &[3, 0]), (2, &[1, 0]), (3, &[2, 0])]);
    let stats = mux_statistics(&rows, 0, false, 2, Some(2));
    assert_eq!(
        stats
            .results
            .cases
            .iter()
            .map(|c| c.mux_value)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(stats.results.total_frames, 2);
}

/// The desktop's `mux_byte + 1` overflows a `u8` there.
#[test]
fn deviation_a_selector_in_the_last_byte_does_not_overflow() {
    let payloads = BTreeMap::from([(0, vec![vec![0; 255]])]);
    assert!(compute_mux_statistics(&payloads, true, 255, 255).cases[0]
        .byte_stats
        .is_empty());
}

/// The desktop counts its three statements as three rows scanned, and errors without rows.
#[test]
fn deviation_first_last_scans_its_rows_and_is_none_without_any() {
    let found = first_last(&rows(&[(5, &[1]), (7, &[3])])).unwrap();
    assert_eq!(found.results.first_timestamp_us, 5);
    assert_eq!(found.results.last_payload, [3]);
    assert_eq!(found.results.total_count, 2);
    assert_eq!(found.stats.rows_scanned, 2);
    assert!(first_last(&[]).is_none());
}

/// The desktop reads the ends and a `COUNT(*)`, and counts three rows scanned.
#[test]
fn deviation_first_last_from_the_ends_scans_its_two_rows_and_keeps_the_count() {
    let (first, last) = (row(5, &[1]), row(9, &[3]));
    let found = first_last_from_ends(&first, &last, 250);
    let whole = first_last(&rows(&[(5, &[1]), (7, &[2]), (9, &[3])])).unwrap();
    assert_eq!(
        found.results,
        FirstLastResult {
            total_count: 250,
            ..whole.results
        }
    );
    assert_eq!(found.stats.rows_scanned, 2);
}

#[test]
fn stats_count_what_the_caller_scanned_and_found() {
    let found = stats(3, 1, Instant::now());
    assert_eq!((found.rows_scanned, found.results_count), (3, 1));
}

fn buckets(found: &FrequencyQueryResult) -> Vec<(i64, i64, f64, f64, f64)> {
    found
        .results
        .iter()
        .map(|b| {
            (
                b.bucket_start_us,
                b.frame_count,
                b.min_interval_us,
                b.max_interval_us,
                b.avg_interval_us,
            )
        })
        .collect()
}

/// Q10: the desktop counts `intervals + 1` per bucket, so here 3 + 3 for 5 frames.
#[test]
fn q10_an_edge_frame_counts_once_in_its_own_bucket() {
    let found = frequency(
        &at(&[0, 500_000, 999_000, 1_000_000, 1_500_000]),
        1000,
        None,
    );
    assert_eq!(
        buckets(&found),
        [
            (0, 3, 499_000.0, 500_000.0, 499_500.0),
            (1_000_000, 2, 1_000.0, 500_000.0, 250_500.0),
        ]
    );
}

/// The desktop drops a bucket without an interval, and the first frame with it.
#[test]
fn q10_a_bucket_with_only_the_first_frame_reports_no_interval() {
    let found = frequency(&at(&[0, 1_500_000]), 1000, None);
    assert_eq!(
        buckets(&found),
        [
            (0, 1, 0.0, 0.0, 0.0),
            (1_000_000, 1, 1_500_000.0, 1_500_000.0, 1_500_000.0)
        ]
    );
}

/// The desktop's limit is rows fetched (default 100 000), and a 0 ms bucket divides by zero.
#[test]
fn deviation_frequency_limit_counts_buckets_and_a_zero_bucket_has_none() {
    let rows = at(&[0, 1_000_000, 2_000_000]);
    assert_eq!(frequency(&rows, 1000, Some(2)).results.len(), 2);
    assert!(frequency(&rows, 0, None).results.is_empty());
}

#[test]
fn distribution_counts_values_in_order_over_rows_with_the_byte() {
    let rows = rows(&[(1, &[0, 7]), (2, &[0, 3]), (3, &[0, 7]), (4, &[0])]);
    let found: Vec<_> = distribution(&rows, 1)
        .results
        .into_iter()
        .map(|d| (d.value, d.count, d.percentage))
        .collect();
    assert_eq!(
        found,
        [(3, 1, 1.0 / 3.0 * 100.0), (7, 2, 2.0 / 3.0 * 100.0)]
    );
}

#[test]
fn gaps_over_the_threshold_come_longest_first_then_oldest() {
    let found = gap_analysis(
        &at(&[0, 100_000, 300_000, 500_000, 500_500, 900_000]),
        100.0,
        Some(3),
    );
    let gaps: Vec<_> = found
        .results
        .iter()
        .map(|g| (g.gap_start_us, g.gap_end_us, g.duration_ms))
        .collect();
    assert_eq!(
        gaps,
        [
            (500_500, 900_000, 399.5),
            (100_000, 300_000, 200.0),
            (300_000, 500_000, 200.0)
        ],
        "exactly 100 ms is not a gap"
    );
}

#[test]
fn a_masked_pattern_matches_at_every_offset() {
    let mut other = row(9, &[0xAA, 0x00, 0xAA, 0x99]);
    other.frame_id = 0x200;
    other.is_extended = true;
    let rows = vec![row(1, &[0x01]), other, row(10, &[0xAB, 0x12])];
    let found = pattern_search(&rows, &[0xAA, 0xBB], &[0xFF, 0x00], None).unwrap();
    let hits: Vec<_> = found
        .results
        .iter()
        .map(|r| {
            (
                r.timestamp_us,
                r.frame_id,
                r.is_extended,
                r.match_positions.clone(),
            )
        })
        .collect();
    assert_eq!(hits, [(9, 0x200, true, vec![0, 2])]);
    assert_eq!(found.stats.rows_scanned, 3);
}

#[test]
fn a_pattern_needs_bytes_and_a_mask_of_its_length() {
    assert_eq!(
        pattern_search(&[], &[], &[], None).unwrap_err(),
        PatternError::Empty
    );
    assert_eq!(
        pattern_search(&[], &[1], &[], None)
            .unwrap_err()
            .to_string(),
        "Pattern and mask must have the same length"
    );
}
