//! Scanning a whole capture for checksums, frame id by frame id.
//!
//! This is the orchestration: group by frame id, sample twice, identify, sweep,
//! solve, rank. It sits here rather than in the application because everything
//! it does is a pure function of payloads, and because a second consumer — a
//! catalogue validator asking "does this declared checksum hold?" — cannot reach
//! into an app binary.
//!
//! # Two sample sets, because the halves want opposite things
//!
//! The sweep measures a *rate*, so it needs the population with its repeats:
//! "this column never moved in 400 frames" is exactly the claim the
//! constant-column rejection rests on, and deduplicating first leaves it one
//! sample to judge on — which is how an all-zero frame gets reported as a
//! flawless XOR. The solvers are killed only by disagreements, so repeats are
//! dead weight and what they want is *distinct* payloads.

use std::collections::HashMap;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use wslib_checksum::{
    analyse_columns, detect_checksum_with_columns, diverse_samples, solve_all, strided_samples,
    volume_bonus, CalcRange, ChecksumCandidate, ChecksumDetectionOptions, ChecksumNote,
    ChecksumSpecification, ColumnStats, CrcSolveOptions, SolveTarget, SolvedChecksum, MAX_SAMPLES,
    MIN_CONFIDENCE, STRONG_MATCH_RATE,
};

use crate::checksum::{checksum_evidence_with_columns, solve_targets, ChecksumEvidence};

pub use wslib_wiretap_protocol::FrameKey;

/// Default for [`ChecksumScanOptions::min_likeness`].
pub const DEFAULT_MIN_LIKENESS: u8 = 50;

/// Cap on candidates reported per frame id.
const MAX_CANDIDATES_PER_ID: usize = 6;

/// Serialisable both ways so a result can echo the settings that produced it —
/// the first thing an agent reading a headless scan wants to know.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", default)]
pub struct ChecksumScanOptions {
    /// Frames an id needs before it is worth analysing.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub min_samples: usize,
    /// Checksum offsets to try, end-relative.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub positions: Vec<i32>,
    /// Recover arbitrary CRC polynomials, not only the named algorithms.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub search_custom_polynomials: bool,
    /// How checksum-shaped a byte column must look before the solver is asked
    /// about it. Zero solves every column that was not rejected outright.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub min_likeness: u8,
}

impl Default for ChecksumScanOptions {
    fn default() -> Self {
        Self {
            min_samples: 10,
            positions: vec![-1, -2, -3],
            search_custom_polynomials: false,
            min_likeness: DEFAULT_MIN_LIKENESS,
        }
    }
}

/// One configuration that explains a frame id, with the evidence for it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredChecksum {
    pub specification: ChecksumSpecification,
    pub position: i32,
    pub length: usize,
    pub big_endian: bool,
    pub calc_start_byte: i32,
    pub calc_end_byte: i32,
    /// Samples the configuration reproduced.
    pub match_count: usize,
    /// Samples it was measured against.
    pub total_count: usize,
    /// 0-100, and `None` for a solved configuration.
    ///
    /// A solve reproduces every sample it was verified against or is not
    /// reported at all, so there is no rate to state — this used to be a
    /// hard-coded 100 rendered as `100.0% (40/40)` beside genuinely measured
    /// rates, which reads as a measurement and is not one.
    pub match_rate: Option<f64>,
    /// Samples left out because their calculation range was a different length.
    pub excluded_count: usize,
    /// 0-100 composite score.
    pub confidence: u8,
    pub notes: Vec<ChecksumNote>,
    pub equivalent_ranges: Vec<CalcRange>,
}

impl From<ChecksumCandidate> for DiscoveredChecksum {
    fn from(c: ChecksumCandidate) -> Self {
        Self {
            specification: ChecksumSpecification::Named {
                algorithm: c.algorithm,
            },
            position: c.position,
            length: c.length,
            big_endian: c.big_endian,
            calc_start_byte: c.calc_start_byte,
            calc_end_byte: c.calc_end_byte,
            match_count: c.match_count,
            total_count: c.total_count,
            match_rate: Some(c.match_rate),
            excluded_count: 0,
            confidence: c.confidence,
            notes: c.notes,
            equivalent_ranges: c.equivalent_ranges,
        }
    }
}

impl DiscoveredChecksum {
    /// The rate to rank on. An absent one means exact, which is at least as good
    /// as any measured rate — stated here once rather than at each comparison.
    pub fn rank_rate(&self) -> f64 {
        self.match_rate.unwrap_or(100.0)
    }

    fn solved(solved: SolvedChecksum, confidence: u8) -> Self {
        let target = solved.target;
        Self {
            specification: solved.specification,
            position: target.position,
            length: target.byte_length,
            big_endian: target.big_endian,
            calc_start_byte: target.calc_start_byte,
            calc_end_byte: target.calc_end_byte,
            match_count: solved.sample_count,
            total_count: solved.sample_count,
            match_rate: None,
            excluded_count: solved.excluded_count,
            confidence,
            notes: Vec::new(),
            equivalent_ranges: solved.equivalent_ranges,
        }
    }
}

/// Which frame a payload belongs to.
///
/// What the scan found for one frame id — including when it found nothing, so
/// the reason is visible rather than the id simply vanishing from the results.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FrameChecksumFinding {
    #[serde(flatten)]
    pub key: FrameKey,
    /// Frames seen for this id.
    pub frame_count: usize,
    /// Distinct payloads among them. A checksum cannot be recovered from
    /// repeats, so this is the number that actually bounds the search.
    pub distinct_payloads: usize,
    pub candidates: Vec<DiscoveredChecksum>,
    /// What identification decided about each byte column, rejections included.
    /// This is the useful half of an empty result: not "nothing found" but
    /// "byte -1 never changes, byte -2 is a counter".
    pub columns: Vec<ChecksumEvidence>,
    pub notes: Vec<ChecksumNote>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChecksumScanResult {
    pub findings: Vec<FrameChecksumFinding>,
    pub frame_count: usize,
    pub unique_frame_ids: usize,
    /// Ids skipped for having fewer than `min_samples` frames.
    pub skipped_frame_ids: usize,
}

/// Confidence for a solved configuration.
///
/// Evidence weight is shared with the sweep through [`volume_bonus`], because
/// the two rank into one list; the rest is how checksum-shaped the column looked
/// before the solver was asked, which identification has already measured.
fn score_solved(likeness: u8, sample_count: usize) -> u8 {
    (55 + volume_bonus(sample_count) + likeness as i32 * 25 / 100).clamp(0, 100) as u8
}

/// Confidence, then rate, then parsimony.
fn compare(a: &DiscoveredChecksum, b: &DiscoveredChecksum) -> std::cmp::Ordering {
    b.confidence
        .cmp(&a.confidence)
        .then_with(|| b.rank_rate().total_cmp(&a.rank_rate()))
        .then_with(|| a.length.cmp(&b.length))
        .then_with(|| a.calc_start_byte.cmp(&b.calc_start_byte))
}

/// Analyse one frame id's payloads.
pub fn analyse_group(
    key: FrameKey,
    frames: &[Vec<u8>],
    options: &ChecksumScanOptions,
) -> FrameChecksumFinding {
    let samples = strided_samples(frames, MAX_SAMPLES);
    let solver_samples = diverse_samples(frames, MAX_SAMPLES);
    let distinct_payloads = solver_samples.len();

    // Profiled once and handed to both halves, so identification and the sweep
    // cannot reach different verdicts about the same byte.
    let column_stats = analyse_columns(&samples);

    // Identification first. Most byte columns on a real link are padding,
    // counters or sensor readings, and each one ruled out here is a whole
    // polynomial search not run.
    let columns = checksum_evidence_with_columns(&samples, &column_stats);

    let swept = detect_checksum_with_columns(
        &samples,
        &ChecksumDetectionOptions {
            positions: options.positions.clone(),
            lengths: Vec::new(),
            // A CAN frame declares no header fields to pass on — the chips that
            // produce these are the serial view's. The 0/1/2 starts `calc_ranges`
            // always offers cover a leading id or type byte here.
            header_boundaries: Vec::new(),
            min_match_rate: STRONG_MATCH_RATE,
            min_confidence: MIN_CONFIDENCE,
        },
        &column_stats,
    );

    let mut candidates: Vec<DiscoveredChecksum> = swept
        .candidates
        .into_iter()
        .map(DiscoveredChecksum::from)
        .chain(solved_candidates(
            &columns,
            &column_stats,
            &solver_samples,
            options,
        ))
        .collect();

    candidates.sort_by(compare);
    candidates.truncate(MAX_CANDIDATES_PER_ID);

    FrameChecksumFinding {
        key,
        frame_count: frames.len(),
        distinct_payloads,
        candidates,
        columns,
        notes: swept.notes,
    }
}

/// Solve the columns identification let through.
fn solved_candidates(
    columns: &[ChecksumEvidence],
    column_stats: &[ColumnStats],
    solver_samples: &[Vec<u8>],
    options: &ChecksumScanOptions,
) -> Vec<DiscoveredChecksum> {
    let crc_options = CrcSolveOptions {
        known_polynomials_only: !options.search_custom_polynomials,
        max_solutions: 2,
    };

    let ranked = solve_targets(columns, column_stats, options.min_likeness);
    let likeness_of = |target: &SolveTarget| {
        ranked
            .iter()
            .find(|r| &r.target == target)
            .map(|r| r.likeness)
            .unwrap_or(0)
    };
    let targets: Vec<SolveTarget> = ranked.iter().map(|r| r.target).collect();

    solve_all(solver_samples, &targets, &crc_options)
        .into_iter()
        // Only the variants the fixed algorithm list cannot express are news;
        // the rest the sweep already reported, with a measured rate.
        //
        // Filtering *after* the fold matters: a constant prefix moves the
        // offset, so the narrow range of a plain sum looks like a sum-with-
        // offset until the widest range wins and reveals it for what it is.
        .filter(|s| !s.specification.is_expressible_by_sweep())
        .filter_map(|solved| {
            let confidence = score_solved(likeness_of(&solved.target), solver_samples.len());
            (confidence >= MIN_CONFIDENCE).then(|| DiscoveredChecksum::solved(solved, confidence))
        })
        .collect()
}

/// Scan payloads already grouped by frame id.
///
/// The shape a database-backed caller wants: it queried per id, so it should not
/// have to flatten only for the grouping to be redone.
pub fn scan_groups(
    groups: &[(FrameKey, Vec<Vec<u8>>)],
    options: &ChecksumScanOptions,
) -> ChecksumScanResult {
    let findings: Vec<FrameChecksumFinding> = groups
        .par_iter()
        .filter(|(_, payloads)| payloads.len() >= options.min_samples)
        .map(|(key, payloads)| analyse_group(*key, payloads, options))
        .collect();

    ChecksumScanResult {
        frame_count: groups.iter().map(|(_, p)| p.len()).sum(),
        unique_frame_ids: groups.len(),
        skipped_frame_ids: groups.len() - findings.len(),
        findings,
    }
}

/// Group a flat run of frames by id, in arrival order, then scan.
pub fn scan_frames(
    frames: impl IntoIterator<Item = (FrameKey, Vec<u8>)>,
    options: &ChecksumScanOptions,
) -> ChecksumScanResult {
    // Groups in arrival order, so the results read the way the capture does;
    // the map holds indices into them rather than a second copy.
    let mut groups: Vec<(FrameKey, Vec<Vec<u8>>)> = Vec::new();
    let mut index: HashMap<FrameKey, usize> = HashMap::new();

    for (key, bytes) in frames {
        if bytes.is_empty() {
            continue;
        }
        let slot = *index.entry(key).or_insert_with(|| {
            groups.push((key, Vec::new()));
            groups.len() - 1
        });
        groups[slot].1.push(bytes);
    }

    scan_groups(&groups, options)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::Rejection;
    use wslib_checksum::algorithms::{crc8_parameterised, sum8_checksum};
    use wslib_checksum::AdditiveOp;

    /// One frame as `scan_frames` takes them.
    fn frame(frame_id: u32, bytes: Vec<u8>) -> (FrameKey, Vec<u8>) {
        (FrameKey::new(frame_id, false), bytes)
    }

    /// A frame id whose last byte is a checksum over the rest.
    fn signed_frames<F: Fn(&[u8]) -> u8>(
        frame_id: u32,
        count: u32,
        sign: F,
    ) -> Vec<(FrameKey, Vec<u8>)> {
        (0..count)
            .map(|i| {
                let mut body = vec![
                    0x10,
                    i as u8,
                    (i >> 8) as u8,
                    (i.wrapping_mul(37) ^ 0x5A) as u8,
                    (i.wrapping_mul(211)) as u8,
                    0xC3,
                    (i.wrapping_mul(7) ^ 0xF0) as u8,
                ];
                let checksum = sign(&body);
                body.push(checksum);
                frame(frame_id, body)
            })
            .collect()
    }

    fn best(result: &ChecksumScanResult, frame_id: u32) -> &DiscoveredChecksum {
        let finding = result
            .findings
            .iter()
            .find(|f| f.key.frame_id == frame_id)
            .unwrap_or_else(|| panic!("no finding for {frame_id:#X}"));
        finding
            .candidates
            .first()
            .unwrap_or_else(|| panic!("no candidate for {frame_id:#X}"))
    }

    /// The two scorers rank into one list, so the tier table they share is a
    /// contract. It used to be written out twice, and retuning the sweep's copy
    /// silently reweighted where solved answers landed against it.
    #[test]
    fn both_scorers_credit_evidence_on_the_same_tiers() {
        for samples in [0, 3, 8, 20, 50, 200, 1000] {
            assert_eq!(
                score_solved(0, samples) as i32 - 55,
                volume_bonus(samples),
                "solved confidence drifted from the shared tiers at {samples} samples"
            );
        }
    }

    /// A solved configuration reproduces every sample or is not reported, so it
    /// has no rate. Ranking it as though the missing number were zero would bury
    /// the exact answer under a partial match, which is the wrong way round.
    #[test]
    fn an_exact_solution_is_not_ranked_below_a_partial_match() {
        let base = DiscoveredChecksum {
            specification: ChecksumSpecification::Additive {
                op: AdditiveOp::NegatedSum,
                offset: 0x11,
            },
            position: -1,
            length: 1,
            big_endian: true,
            calc_start_byte: 0,
            calc_end_byte: -1,
            match_count: 40,
            total_count: 40,
            match_rate: None,
            excluded_count: 0,
            confidence: 70,
            notes: Vec::new(),
            equivalent_ranges: Vec::new(),
        };
        let partial = DiscoveredChecksum {
            match_rate: Some(96.0),
            ..base.clone()
        };

        assert_eq!(compare(&base, &partial), std::cmp::Ordering::Less);
    }

    #[test]
    fn finds_a_named_algorithm() {
        let result = scan_frames(signed_frames(0x100, 40, sum8_checksum), &Default::default());

        assert_eq!(
            best(&result, 0x100).specification,
            ChecksumSpecification::Named {
                algorithm: wslib_checksum::ChecksumAlgorithm::Sum8
            }
        );
        assert_eq!(best(&result, 0x100).match_rate, Some(100.0));
    }

    /// The reason a solver exists: no named algorithm can express this, and the
    /// old brute force could not have found it either — it only varied the
    /// polynomial, never the offset.
    #[test]
    fn finds_a_sum_with_an_offset_no_named_algorithm_carries() {
        let frames = signed_frames(0x101, 40, |d| sum8_checksum(d).wrapping_add(0xA5));
        let result = scan_frames(frames, &Default::default());

        assert_eq!(
            best(&result, 0x101).specification,
            ChecksumSpecification::Additive {
                op: AdditiveOp::Sum,
                offset: 0xA5
            }
        );
    }

    #[test]
    fn recovers_an_arbitrary_polynomial_only_when_asked() {
        let frames = signed_frames(0x102, 60, |d| {
            crc8_parameterised(d, 0x4D, 0xB7, 0x2C, false)
        });

        let off = scan_frames(frames.clone(), &Default::default());
        assert!(off.findings[0].candidates.is_empty());

        let on = scan_frames(
            frames.clone(),
            &ChecksumScanOptions {
                search_custom_polynomials: true,
                ..Default::default()
            },
        );
        let ChecksumSpecification::Crc(parameters) = &best(&on, 0x102).specification else {
            panic!("expected a CRC, got {:?}", best(&on, 0x102).specification);
        };
        assert_eq!(parameters.polynomial, 0x4D);
    }

    /// The capability gap this milestone closes. The type byte *varies*, so it
    /// is not absorbed into an offset and only the range that excludes it can
    /// reproduce the frames. The solver used to calculate from byte 0 and
    /// nowhere else, so ticking "search custom polynomials" on a frame shaped
    /// like this reported nothing, with no knob to turn.
    #[test]
    fn solves_a_checksum_that_skips_a_varying_type_byte() {
        let frames: Vec<(FrameKey, Vec<u8>)> = (0..60u32)
            .map(|i| {
                let mut body = vec![
                    (i % 7) as u8,
                    (i.wrapping_mul(37) ^ 0x5A) as u8,
                    (i.wrapping_mul(211)) as u8,
                    0xC3,
                    (i.wrapping_mul(7) ^ 0xF0) as u8,
                ];
                let checksum = sum8_checksum(&body[1..]).wrapping_add(0xA5);
                body.push(checksum);
                frame(0x110, body)
            })
            .collect();

        let result = scan_frames(frames, &Default::default());
        let best = best(&result, 0x110);

        assert_eq!(
            best.specification,
            ChecksumSpecification::Additive {
                op: AdditiveOp::Sum,
                offset: 0xA5
            }
        );
        assert_eq!(best.calc_start_byte, 1);
        // Byte 0 moves, so no other start reproduces the data and there is
        // nothing to be ambiguous about.
        assert!(best.equivalent_ranges.is_empty(), "{best:?}");
    }

    /// The other half of the same change. When the excluded bytes *are*
    /// constant every start solves — with a different offset each — because a
    /// constant range contributes a constant. That is one answer written three
    /// ways, and it has to come back as one candidate or the widened search
    /// reads as noise.
    #[test]
    fn ranges_the_data_cannot_tell_apart_collapse_into_one_candidate() {
        // Bytes 0 and 1 are constant; byte -2 varies, so the range's end is not
        // ambiguous and only the start is.
        let frames: Vec<(FrameKey, Vec<u8>)> = (0..60u32)
            .map(|i| {
                let mut body = vec![
                    0x10,
                    0x20,
                    (i.wrapping_mul(37) ^ 0x5A) as u8,
                    (i.wrapping_mul(211)) as u8,
                    (i.wrapping_mul(7) ^ 0xF0) as u8,
                ];
                let checksum = sum8_checksum(&body).wrapping_add(0xA5);
                body.push(checksum);
                frame(0x111, body)
            })
            .collect();

        let finding = &scan_frames(frames, &Default::default()).findings[0];
        let sums: Vec<&DiscoveredChecksum> = finding
            .candidates
            .iter()
            .filter(|c| matches!(c.specification, ChecksumSpecification::Additive { .. }))
            .collect();

        assert_eq!(sums.len(), 1, "one answer, reported many ways: {sums:?}");
        // The widest range wins; the narrower ones are kept as alternatives
        // rather than dropped, because none of them is more true than another.
        assert_eq!(sums[0].calc_start_byte, 0);
        let starts: Vec<i32> = sums[0]
            .equivalent_ranges
            .iter()
            .map(|r| r.calc_start_byte)
            .collect();
        assert_eq!(starts, vec![1, 2]);
    }

    /// The live bug this milestone fixes. Every byte is zero, so XOR and Sum8
    /// over the body both reproduce the trailing 0x00 perfectly — and the old
    /// path reported a 100% XOR match because its simple-algorithm phase used
    /// the raw sweep, which has no constant-column rejection.
    #[test]
    fn an_all_zero_frame_is_padding_not_a_perfect_xor() {
        let frames: Vec<(FrameKey, Vec<u8>)> =
            (0..40).map(|_| frame(0x000, vec![0u8; 8])).collect();
        let result = scan_frames(frames, &Default::default());

        assert!(
            result.findings[0].candidates.is_empty(),
            "reported {:?}",
            result.findings[0].candidates
        );
    }

    /// A constant trailing byte beside varying data is padding too, and this is
    /// the shape most of the Sungrow bus actually has.
    #[test]
    fn a_constant_trailing_byte_beside_real_data_is_padding() {
        let frames: Vec<(FrameKey, Vec<u8>)> = (0..40u32)
            .map(|i| {
                frame(
                    0x013,
                    vec![0x01, 0x07, i as u8, 0x00, 0x02, 0x02, (i * 3) as u8, 0x00],
                )
            })
            .collect();

        let result = scan_frames(frames, &Default::default());
        assert!(result.findings[0]
            .candidates
            .iter()
            .all(|c| c.position != -1));
    }

    /// The trap the two sample sets exist for. Deduplicating before the sweep
    /// collapses 40 identical frames to one, and the constant-column rejection
    /// needs eight before it will call a column padding — so the guard goes
    /// quiet and the padding comes back as a flawless XOR. The evidence sample
    /// keeps the repeats; only the solvers see the deduplicated set.
    #[test]
    fn deduplication_does_not_disarm_the_padding_rejection() {
        let frames: Vec<(FrameKey, Vec<u8>)> =
            (0..40).map(|_| frame(0x001, vec![0u8; 8])).collect();
        let finding = &scan_frames(frames, &Default::default()).findings[0];

        assert_eq!(finding.distinct_payloads, 1);
        assert!(finding.candidates.is_empty(), "{:?}", finding.candidates);
    }

    /// An empty result has to say what it decided about each byte. "Nothing
    /// found" is not actionable; "byte -1 never changes, byte -2 is a counter"
    /// tells you where to look next.
    #[test]
    fn every_byte_column_comes_back_with_a_verdict() {
        // Byte -1 counts every frame, -3 moves once every twenty, -2 is
        // constant. The counter therefore advances while the rest holds still,
        // which is the shape that disqualifies it.
        let frames: Vec<(FrameKey, Vec<u8>)> = (0..60u32)
            .map(|i| frame(0x300, vec![0x10, (i / 20) as u8, 0x00, i as u8]))
            .collect();

        let finding = &scan_frames(frames, &Default::default()).findings[0];
        assert!(finding.candidates.is_empty());

        let verdict = |position: i32| {
            finding
                .columns
                .iter()
                .find(|c| c.position == position)
                .unwrap_or_else(|| panic!("no verdict for byte {position}"))
                .rejected
        };

        assert_eq!(verdict(-1), Some(Rejection::NotAFunctionOfTheOtherBytes));
        assert_eq!(verdict(-2), Some(Rejection::Constant));
    }

    #[test]
    fn reports_repeats_as_repeats_rather_than_as_evidence() {
        // 400 frames, two distinct payloads. The sample count must not read as
        // 400 anywhere a reader would take it for search strength.
        let frames: Vec<(FrameKey, Vec<u8>)> = [vec![0x01u8, 0x02, 0x03], vec![0x04, 0x05, 0x09]]
            .into_iter()
            .cycle()
            .take(400)
            .map(|b| frame(0x200, b))
            .collect();

        let finding = &scan_frames(frames, &Default::default()).findings[0];
        assert_eq!(finding.frame_count, 400);
        assert_eq!(finding.distinct_payloads, 2);
    }

    #[test]
    fn separates_frame_ids_and_counts_the_ones_it_skipped() {
        let mut frames = signed_frames(0x100, 40, sum8_checksum);
        frames.extend(signed_frames(0x101, 40, |d| {
            sum8_checksum(d).wrapping_add(0xA5)
        }));
        // Too few samples to be worth analysing.
        frames.extend(signed_frames(0x102, 3, sum8_checksum));

        let result = scan_frames(frames, &Default::default());
        assert_eq!(result.unique_frame_ids, 3);
        assert_eq!(result.skipped_frame_ids, 1);
        assert_eq!(result.findings.len(), 2);
        assert_eq!(result.frame_count, 83);
    }

    /// The gate has to pay for itself. A bus of padding and counters must reach
    /// the solver with nothing at all, which is what makes an exhaustive
    /// polynomial search affordable across a whole capture.
    #[test]
    fn a_bus_with_no_checksum_offers_the_solver_nothing() {
        let frames: Vec<(FrameKey, Vec<u8>)> = (0..60u32)
            .map(|i| frame(0x301, vec![0x10, 0x00, 0x00, i as u8]))
            .collect();
        let finding = &scan_frames(
            frames,
            &ChecksumScanOptions {
                search_custom_polynomials: true,
                ..Default::default()
            },
        )
        .findings[0];

        assert!(finding.candidates.is_empty());
        assert!(finding.columns.iter().all(|c| !c.is_candidate()));
    }

    /// Standard and extended ids sharing a number are different frames.
    #[test]
    fn an_extended_id_is_not_the_same_frame_as_a_standard_one() {
        let mut frames = signed_frames(0x100, 20, sum8_checksum);
        frames.extend(
            signed_frames(0x100, 20, sum8_checksum)
                .into_iter()
                .map(|(k, b)| (FrameKey::new(k.frame_id, true), b)),
        );

        let result = scan_frames(frames, &Default::default());
        assert_eq!(result.unique_frame_ids, 2);
        assert_eq!(result.findings.len(), 2);
    }
}
