//! Which bytes are worth solving as a checksum.
//!
//! [`wslib_checksum`] answers *what algorithm is this byte*. It is now cheap
//! enough to ask blindly — an exhaustive CRC-16 sweep is milliseconds — but
//! asking blindly still means asking the wrong question of most of a bus. On a
//! Sungrow BMS link, 62 of 62 frame ids get a full sweep to conclude nothing.
//!
//! This module asks the prior question, from one pass over consecutive payloads.
//!
//! # The decisive test is a rejection, not a score
//!
//! A checksum is a *function of the other bytes*. So if two payloads agree on
//! every byte except this column, and this column differs, no function can
//! produce both — the column cannot be a checksum over any subset of the rest.
//! That is not a heuristic and it needs no threshold; it is arithmetic, and it
//! removes counters, sequence numbers and free-running timers outright.
//!
//! # What is left is separated by two conditional rates
//!
//! For the survivors, the useful signal is how reliably the column moves *with*
//! the payload:
//!
//! - a real checksum changes almost every time the payload does — it collides
//!   only about one time in `2^bits`;
//! - a sensor byte often sits still while other bytes move, because it measures
//!   one quantity and they measure others.
//!
//! Entropy alone cannot make this distinction, which is the trap worth naming.
//! On the same link, the cell-voltage frames carry four 16-bit readings that
//! jitter constantly — 120 distinct payloads in 121 frames, entropy near the
//! maximum, and not a checksum among them.

use serde::Serialize;
use wslib_checksum::columns::{analyse_columns, ColumnStats};
use wslib_checksum::{calc_ranges, strided_samples, SolveTarget, MAX_SAMPLES};

/// Below this many payload pairs, the conditional rates are noise.
const MIN_TRANSITIONS: usize = 8;

/// A column changing while every other byte held still is disqualifying, but one
/// such pair on a long capture is more likely a dropped or interleaved frame
/// than proof. Tolerate this fraction before rejecting.
const VIOLATION_TOLERANCE: f64 = 0.02;

/// How many values a column must take, as a fraction of the distinct payloads
/// it saw.
///
/// A checksum is near-injective: `n` distinct payloads produce close to
/// `256(1 - e^(-n/256))` distinct bytes, which stays above 0.6 of `min(n, 256)`
/// for every sample size. A quarter is well under that curve and still an order
/// of magnitude above a slow sensor byte, which is the thing being separated.
const MIN_DISTINCT_FRACTION: f64 = 0.25;

/// Why a column was ruled out. Kept so a scan can say what it decided rather
/// than silently omitting the byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Rejection {
    /// One value across every payload — padding.
    Constant,
    /// Changed while every other byte stayed the same, so it is not a function
    /// of them. A counter or a timer.
    NotAFunctionOfTheOtherBytes,
    /// Sat still too often while the payload moved around it.
    TooOftenUnchanged,
    /// Not enough consecutive payload pairs to judge.
    TooFewTransitions,
    /// Took far fewer values than there were distinct payloads to checksum. A
    /// checksum is near-injective; a byte oscillating over four values while a
    /// hundred different payloads go past is measuring something else.
    TooFewDistinctValues,
}

/// What one column looks like as a checksum candidate.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChecksumEvidence {
    /// End-relative index: -1 is the last byte.
    pub position: i32,
    /// Payload pairs where the rest of the payload changed.
    pub payload_changed: usize,
    /// ...and this column changed with it. A checksum misses only on collision.
    pub changed_with_payload: usize,
    /// Payload pairs where the rest held still but this column moved. Any of
    /// these at all is disqualifying.
    pub changed_alone: usize,
    /// `changed_with_payload / payload_changed`.
    pub responsiveness: f64,
    pub entropy_bits: f64,
    pub distinct_ratio: f64,
    /// 0-100. Zero when `rejected` is set.
    pub likeness: u8,
    pub rejected: Option<Rejection>,
}

impl ChecksumEvidence {
    pub fn is_candidate(&self) -> bool {
        self.rejected.is_none()
    }
}

/// Rate a single column.
fn evaluate(
    column: &ColumnStats,
    payloads: &[Vec<u8>],
    depth: usize,
    distinct_payloads: usize,
) -> ChecksumEvidence {
    let mut evidence = ChecksumEvidence {
        position: column.position,
        payload_changed: 0,
        changed_with_payload: 0,
        changed_alone: 0,
        responsiveness: 0.0,
        entropy_bits: column.entropy_bits,
        distinct_ratio: column.distinct_ratio(),
        likeness: 0,
        rejected: None,
    };

    // Padding, not a checksum.
    if column.padding_value().is_some() {
        evidence.rejected = Some(Rejection::Constant);
        return evidence;
    }

    // Walk consecutive payloads that both reach this column, splitting each pair
    // on whether anything *other* than this byte moved.
    let mut previous: Option<&Vec<u8>> = None;
    for payload in payloads {
        if payload.len() < depth {
            previous = None;
            continue;
        }
        if let Some(prev) = previous {
            if prev.len() == payload.len() {
                let index = payload.len() - depth;
                let column_moved = prev[index] != payload[index];
                let rest_moved = prev
                    .iter()
                    .zip(payload.iter())
                    .enumerate()
                    .any(|(i, (a, b))| i != index && a != b);

                match (rest_moved, column_moved) {
                    (true, true) => {
                        evidence.payload_changed += 1;
                        evidence.changed_with_payload += 1;
                    }
                    (true, false) => evidence.payload_changed += 1,
                    (false, true) => evidence.changed_alone += 1,
                    (false, false) => {}
                }
            }
        }
        previous = Some(payload);
    }

    let considered = evidence.payload_changed + evidence.changed_alone;
    if considered < MIN_TRANSITIONS {
        evidence.rejected = Some(Rejection::TooFewTransitions);
        return evidence;
    }

    // The arithmetic rejection. A function of the other bytes cannot produce two
    // different outputs from the same input.
    if evidence.changed_alone as f64 / considered as f64 > VIOLATION_TOLERANCE {
        evidence.rejected = Some(Rejection::NotAFunctionOfTheOtherBytes);
        return evidence;
    }

    if evidence.payload_changed == 0 {
        evidence.rejected = Some(Rejection::TooFewTransitions);
        return evidence;
    }

    evidence.responsiveness =
        evidence.changed_with_payload as f64 / evidence.payload_changed as f64;

    // An 8-bit checksum collides about 1 in 256, so anything below ~0.9 is a
    // byte that tracks something narrower than the whole payload.
    if evidence.responsiveness < 0.9 {
        evidence.rejected = Some(Rejection::TooOftenUnchanged);
        return evidence;
    }

    // Near-injectivity, checked last of the rejections: a byte that fails both
    // this and the responsiveness test is better described as not tracking the
    // payload than as having a narrow range, since the narrow range follows.
    let reachable = distinct_payloads.min(256);
    if (column.distinct_values as f64) < MIN_DISTINCT_FRACTION * reachable as f64 {
        evidence.rejected = Some(Rejection::TooFewDistinctValues);
        return evidence;
    }

    // Responsiveness carries most of the weight; entropy and spread corroborate
    // it. A checksum should look close to uniform over the values it takes.
    let mut score = 40.0 * ((evidence.responsiveness - 0.9) / 0.1).clamp(0.0, 1.0) + 20.0;
    score += 25.0 * (evidence.entropy_bits / 8.0).clamp(0.0, 1.0);
    score += 15.0 * evidence.distinct_ratio.clamp(0.0, 1.0);

    evidence.likeness = score.clamp(0.0, 100.0) as u8;
    evidence
}

/// Rate every column of a frame id's payloads as a possible checksum.
///
/// Returned in column order (-1 first), rejections included, so a caller can
/// report what it decided about each byte rather than only what survived.
pub fn checksum_evidence(payloads: &[Vec<u8>]) -> Vec<ChecksumEvidence> {
    // Strided, not truncated: handed a whole capture, a prefix would judge every
    // column on its first seconds. `strided_samples` owns that rule.
    let sample = strided_samples(payloads, MAX_SAMPLES);
    let columns = analyse_columns(&sample);
    checksum_evidence_with_columns(&sample, &columns)
}

/// [`checksum_evidence`] for a caller that has already profiled the columns and
/// already chosen its sample.
///
/// The sweep needs the same columns, so handing them over is one pass instead of
/// two and — the part that matters — leaves one verdict per byte rather than two
/// that can disagree.
pub fn checksum_evidence_with_columns(
    sample: &[Vec<u8>],
    columns: &[ColumnStats],
) -> Vec<ChecksumEvidence> {
    let distinct_payloads = {
        let mut seen: Vec<&[u8]> = sample.iter().map(|p| p.as_slice()).collect();
        seen.sort_unstable();
        seen.dedup();
        seen.len()
    };

    columns
        .iter()
        // Depth comes off the column's own position rather than its index, so
        // the slice need not arrive in any particular order.
        .map(|column| evaluate(column, sample, -column.position as usize, distinct_payloads))
        .collect()
}

/// A geometry to solve, with the identification score that justified it.
///
/// The score travels with the target because the pass that chose it had the
/// score in hand; making the caller search the columns again to recover it
/// rebuilds the two-byte keying rule at the wrong end.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RankedTarget {
    pub target: SolveTarget,
    /// 0-100, across the bytes the checksum occupies.
    pub likeness: u8,
}

/// The geometries worth handing to the solver, best first.
///
/// One target per surviving column, plus the two-byte target that column would
/// form with the byte before it — a 16-bit checksum shows up as two adjacent
/// responsive columns. Each is crossed with every range [`calc_ranges`] offers,
/// so the solver searches the same calculation ranges the sweep does; see that
/// function for why it must, and for why the caller has to fold the duplicate
/// solutions the cross product produces.
pub fn solve_targets(
    evidence: &[ChecksumEvidence],
    columns: &[ColumnStats],
    min_likeness: u8,
) -> Vec<RankedTarget> {
    let mut ranked: Vec<&ChecksumEvidence> = evidence
        .iter()
        .filter(|e| e.is_candidate() && e.likeness >= min_likeness)
        .collect();
    ranked.sort_by_key(|e| std::cmp::Reverse(e.likeness));

    let mut targets = Vec::new();
    for candidate in ranked {
        let mut geometries: Vec<(i32, usize)> = vec![(candidate.position, 1)];

        // A 16-bit checksum occupies this column and the one before it, so the
        // pair is only worth trying when that neighbour also survived.
        let neighbour = candidate.position - 1;
        if evidence
            .iter()
            .any(|e| e.position == neighbour && e.is_candidate())
        {
            geometries.push((neighbour, 2));
        }

        for (position, byte_length) in geometries {
            // Endianness only means something for a multi-byte checksum, the
            // same rule `build_checksum_specs` applies to the sweep.
            let endiannesses: &[bool] = if byte_length == 2 {
                &[false, true]
            } else {
                &[true]
            };

            // The likeness that justified this target, taken across the bytes
            // it actually covers — a two-byte target is keyed on the lower of
            // the pair. Carried with the target because the caller would
            // otherwise search the columns again to recover it.
            let likeness = (0..byte_length as i32)
                .filter_map(|offset| evidence.iter().find(|e| e.position == position + offset))
                .map(|e| e.likeness)
                .max()
                .unwrap_or(0);

            for range in calc_ranges(position, columns, &[]) {
                for &big_endian in endiannesses {
                    targets.push(RankedTarget {
                        target: SolveTarget {
                            position,
                            byte_length,
                            big_endian,
                            calc_start_byte: range.calc_start_byte,
                            calc_end_byte: range.calc_end_byte,
                        },
                        likeness,
                    });
                }
            }
        }
    }

    targets
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use wslib_checksum::algorithms::{crc8_checksum, sum8_checksum};

    fn at(evidence: &[ChecksumEvidence], position: i32) -> &ChecksumEvidence {
        evidence.iter().find(|e| e.position == position).unwrap()
    }

    /// The targets a caller would hand the solver for these payloads.
    fn targets(payloads: &[Vec<u8>], min_likeness: u8) -> Vec<SolveTarget> {
        let columns = analyse_columns(payloads);
        let evidence = checksum_evidence_with_columns(payloads, &columns);
        solve_targets(&evidence, &columns, min_likeness)
            .into_iter()
            .map(|r| r.target)
            .collect()
    }

    /// Independently varying data with a real checksum appended.
    ///
    /// The fields must not all derive from one counter: if they do, every byte
    /// really is a function of every other and the pass is right to keep them
    /// all — which makes such a fixture useless for telling the checksum apart.
    fn signed<F: Fn(&[u8]) -> u8>(count: u32, sign: F) -> Vec<Vec<u8>> {
        let mut seeds = [0x1234u32, 0x9E37, 0x5A5A, 0x0BAD];
        (0..count)
            .map(|_| {
                for seed in seeds.iter_mut() {
                    *seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                }
                let mut body: Vec<u8> = seeds.iter().map(|s| (s >> 16) as u8).collect();
                body.push(sign(&body));
                body
            })
            .collect()
    }

    #[test]
    fn a_real_checksum_column_is_a_candidate() {
        let evidence = checksum_evidence(&signed(120, crc8_checksum));
        let last = at(&evidence, -1);

        assert!(last.is_candidate(), "{last:?}");
        assert!(last.responsiveness > 0.95, "{}", last.responsiveness);
        assert!(last.likeness > 70, "{}", last.likeness);
    }

    #[test]
    fn a_sum_is_a_candidate_too() {
        let last = &checksum_evidence(&signed(120, sum8_checksum))[0];
        assert!(last.is_candidate(), "{last:?}");
    }

    #[test]
    fn padding_is_rejected_as_constant() {
        let payloads: Vec<Vec<u8>> = (0..40u8).map(|i| vec![0x10, i, 0x00]).collect();
        let evidence = checksum_evidence(&payloads);
        assert_eq!(at(&evidence, -1).rejected, Some(Rejection::Constant));
    }

    /// The arithmetic rejection: a counter advances even when nothing else in
    /// the payload moved, so it cannot be a function of those bytes.
    #[test]
    fn a_free_running_counter_cannot_be_a_function_of_the_other_bytes() {
        let payloads: Vec<Vec<u8>> = (0..60u8).map(|i| vec![0x10, 0x20, 0x30, i]).collect();
        let evidence = checksum_evidence(&payloads);
        let last = at(&evidence, -1);

        assert_eq!(last.rejected, Some(Rejection::NotAFunctionOfTheOtherBytes));
        // And it would have looked good on entropy alone — which is the point.
        assert!(last.distinct_ratio > 0.9, "{}", last.distinct_ratio);
    }

    /// The trap this module exists for. Four 16-bit cell voltages jittering
    /// independently: entropy near maximum, nearly every payload distinct, and
    /// no checksum anywhere — because each byte tracks its own reading and sits
    /// still while the others move.
    #[test]
    fn high_entropy_sensor_data_is_not_mistaken_for_a_checksum() {
        let mut state = [0x809Bu16, 0x80B4, 0x8096, 0x80B0];
        let payloads: Vec<Vec<u8>> = (0..160u32)
            .map(|i| {
                // Three readings drift every frame; the fourth is a slower cell
                // that only moves occasionally. That last one is the case a
                // checksum test has to get right — it sits still while the
                // payload around it moves.
                for (cell, value) in state.iter_mut().enumerate().take(3) {
                    let up = (i / (cell as u32 + 1)).is_multiple_of(2);
                    *value = value.wrapping_add(if up { 1 } else { 0xFFFF });
                }
                if i % 5 == 0 {
                    state[3] = state[3].wrapping_add(1);
                }
                state.iter().flat_map(|v| v.to_le_bytes()).collect()
            })
            .collect();

        let evidence = checksum_evidence(&payloads);
        let candidates: Vec<&ChecksumEvidence> =
            evidence.iter().filter(|e| e.is_candidate()).collect();

        assert!(
            candidates.is_empty(),
            "sensor bytes read as checksums: {candidates:?}"
        );
        // Both reasons are represented: the slow fourth cell sits still while
        // the payload moves, and the fast ones take far too few values to be
        // checksumming anything.
        assert!(evidence
            .iter()
            .any(|e| e.rejected == Some(Rejection::TooOftenUnchanged)));
        assert!(evidence
            .iter()
            .any(|e| e.rejected == Some(Rejection::TooFewDistinctValues)));
    }

    #[test]
    fn a_thin_sample_is_declined_rather_than_guessed_at() {
        let payloads: Vec<Vec<u8>> = (0..4u8).map(|i| vec![0x10, i, i]).collect();
        let evidence = checksum_evidence(&payloads);
        assert_eq!(
            at(&evidence, -1).rejected,
            Some(Rejection::TooFewTransitions)
        );
    }

    /// The property that actually matters. A false positive costs a few
    /// milliseconds of solving; a false negative loses the answer, so the real
    /// checksum must always reach the solver.
    #[test]
    fn the_real_checksum_column_is_never_filtered_out() {
        let payloads = signed(120, crc8_checksum);
        let evidence = checksum_evidence(&payloads);
        assert!(at(&evidence, -1).is_candidate(), "{:?}", at(&evidence, -1));

        let targets = targets(&payloads, 50);
        assert!(
            targets
                .iter()
                .any(|t| t.position == -1 && t.byte_length == 1),
            "the checksum byte was not offered to the solver: {targets:?}"
        );
    }

    /// Honest about the limit. When every field moves on every frame, a data
    /// byte is as responsive as a checksum and identification cannot separate
    /// them — it narrows the search, it does not decide the answer. What it must
    /// never do is drop the real one, which the test above pins.
    #[test]
    fn data_bytes_that_move_constantly_also_survive_identification() {
        let evidence = checksum_evidence(&signed(120, crc8_checksum));
        let survivors = evidence.iter().filter(|e| e.is_candidate()).count();

        assert!(survivors > 1, "expected the pass to be permissive here");
    }

    #[test]
    fn a_rejected_bus_yields_no_targets_at_all() {
        let payloads: Vec<Vec<u8>> = (0..60u8).map(|i| vec![0x10, 0x20, 0x30, i]).collect();
        assert!(targets(&payloads, 50).is_empty());
    }

    /// The gap this milestone closes. A leading type byte that *varies* is not
    /// absorbed into an offset, so only the range that excludes it can solve —
    /// and until the solver was offered that range, ticking "search custom
    /// polynomials" on this frame reported nothing at all.
    #[test]
    fn the_solver_is_offered_a_range_that_excludes_a_leading_type_byte() {
        let payloads: Vec<Vec<u8>> = (0..120u32)
            .map(|i| {
                let mut body = vec![
                    (i % 7) as u8,
                    (i.wrapping_mul(37) ^ 0x5A) as u8,
                    (i.wrapping_mul(211)) as u8,
                    (i.wrapping_mul(7) ^ 0xF0) as u8,
                ];
                let checksum = sum8_checksum(&body[1..]);
                body.push(checksum);
                body
            })
            .collect();

        let offered = targets(&payloads, 50);
        assert!(
            offered
                .iter()
                .any(|t| t.position == -1 && t.byte_length == 1 && t.calc_start_byte == 1),
            "no target skips the type byte: {offered:?}"
        );
    }

    /// Every start the sweep tries, the solver now tries too. Nothing about the
    /// checksum's own geometry should decide which calculation ranges are on
    /// offer — that was the asymmetry.
    #[test]
    fn the_solver_sees_the_same_starts_the_sweep_does() {
        let payloads = signed(120, crc8_checksum);
        let starts: BTreeSet<i32> = targets(&payloads, 50)
            .iter()
            .filter(|t| t.position == -1)
            .map(|t| t.calc_start_byte)
            .collect();

        assert_eq!(starts, BTreeSet::from([0, 1, 2]));
    }

    /// A 16-bit checksum leaves two adjacent responsive columns, and the pair is
    /// worth trying both ways round.
    #[test]
    fn adjacent_survivors_produce_a_two_byte_target() {
        let payloads: Vec<Vec<u8>> = (0..160u32)
            .map(|i| {
                let mut body = vec![0x10, i as u8, (i >> 8) as u8, (i.wrapping_mul(37)) as u8];
                let crc =
                    wslib_checksum::crc16_parameterised(&body, 0x1021, 0xFFFF, 0, false, false);
                body.extend_from_slice(&crc.to_le_bytes());
                body
            })
            .collect();

        let evidence = checksum_evidence(&payloads);
        let offered = targets(&payloads, 40);

        assert!(
            offered
                .iter()
                .any(|t| t.byte_length == 2 && t.position == -2),
            "no two-byte target: {evidence:?}"
        );
    }
}
