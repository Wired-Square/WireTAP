//! Hypothesis ranking: a sweep of candidate bit fields over one frame's payload,
//! each scored 0–100 against its [`ByteProfile`].
//!
//! The weights are the desktop's TypeScript ones, which the golden fixture under
//! `tests/fixtures/hypothesis` pins. Capping the list and naming the fields are the
//! caller's.

use std::ops::RangeInclusive;

use serde::Serialize;
use wslib_bits::{Endianness, PayloadField};

use crate::roles::{self, ByteColumn, ByteProfile, ByteRole, PatternKind};

/// The fields to try: every start bit in `start_bits` at `bit_step`, crossed with
/// every length and byte order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sweep {
    pub start_bits: RangeInclusive<u32>,
    pub bit_step: u32,
    pub bit_lengths: Vec<u32>,
    pub endiannesses: Vec<Endianness>,
    pub signed: bool,
}

/// One field and how interesting its bytes look.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub field: PayloadField,
    /// 0–100.
    pub score: u8,
    pub reasons: Vec<CandidateReason>,
}

/// A byte role without its detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RoleKind {
    Static,
    Counter,
    Sensor,
    Value,
    Unknown,
}

impl From<&ByteRole> for RoleKind {
    fn from(role: &ByteRole) -> Self {
        match role {
            ByteRole::Static { .. } => Self::Static,
            ByteRole::Counter { .. } => Self::Counter,
            ByteRole::Sensor { .. } => Self::Sensor,
            ByteRole::Value => Self::Value,
            ByteRole::Unknown => Self::Unknown,
        }
    }
}

/// Why a candidate scored as it did; the caller renders these as text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "HypothesisReason"))]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum CandidateReason {
    /// The best-scoring role among the bytes the field spans.
    Role {
        role: RoleKind,
    },
    /// The first pattern the field overlaps; `exact` when it starts and ends with it.
    Pattern {
        kind: PatternKind,
        exact: bool,
    },
    EndiannessAgrees,
    EndiannessMixed,
    /// The spanned bytes average over 50 distinct values.
    HighVariance,
    /// A spanned sensor byte trends over 80 % of its moves.
    StrongTrend,
    NoProfile,
}

/// One frame's candidates, best first, then by start bit. Fields end within
/// `payload_len` bytes, and a byte-aligned 8-bit big-endian field is left out
/// when the sweep also reads it little-endian.
pub fn rank_fields(
    sweep: &Sweep,
    profile: Option<&ByteProfile>,
    payload_len: usize,
) -> Vec<Candidate> {
    let reads_little = sweep.endiannesses.contains(&Endianness::Little);
    let mut candidates: Vec<Candidate> = sweep
        .start_bits
        .clone()
        .step_by(sweep.bit_step.max(1) as usize)
        .flat_map(|start_bit| {
            sweep.bit_lengths.iter().flat_map(move |&bit_length| {
                sweep
                    .endiannesses
                    .iter()
                    .map(move |&endianness| PayloadField {
                        start_bit,
                        bit_length,
                        endianness,
                        signed: sweep.signed,
                    })
            })
        })
        .filter(|f| {
            f.fits_in(payload_len)
                && !(reads_little
                    && f.endianness == Endianness::Big
                    && f.bit_length == 8
                    && f.start_bit % 8 == 0)
        })
        .map(|field| match profile {
            Some(profile) => score(field, profile),
            None => Candidate {
                field,
                score: 50,
                reasons: vec![CandidateReason::NoProfile],
            },
        })
        .collect();
    candidates.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.field.start_bit.cmp(&b.field.start_bit))
    });
    candidates
}

fn role_points(role: RoleKind) -> u32 {
    match role {
        RoleKind::Sensor => 30,
        RoleKind::Value => 20,
        RoleKind::Unknown => 10,
        RoleKind::Counter => 2,
        RoleKind::Static => 0,
    }
}

fn pattern_points(kind: PatternKind) -> u32 {
    match kind {
        PatternKind::Sensor16 | PatternKind::Sensor32 => 30,
        PatternKind::Counter16 => 5,
        PatternKind::Text => 3,
    }
}

fn score(field: PayloadField, profile: &ByteProfile) -> Candidate {
    let first = (field.start_bit / 8) as usize;
    let last = ((field.start_bit + field.bit_length - 1) / 8) as usize;
    let spanned: Vec<&ByteColumn> = (first..=last)
        .filter_map(|b| {
            profile
                .columns
                .iter()
                .find(|c| c.stats.position as usize == b)
        })
        .collect();
    let mut points = 0;
    let mut reasons = Vec::new();

    let best_role = spanned
        .iter()
        .map(|c| RoleKind::from(&c.role))
        .fold(None, |best: Option<RoleKind>, role| match best {
            Some(b) if role_points(b) >= role_points(role) => Some(b),
            _ => Some(role),
        })
        .filter(|&role| role_points(role) > 0);
    if let Some(role) = best_role {
        points += role_points(role);
        reasons.push(CandidateReason::Role { role });
    }

    let patterns = match &profile.mux {
        Some(mux) => mux.cases.iter().flat_map(|c| &c.patterns).collect(),
        None => profile.patterns.iter().collect::<Vec<_>>(),
    };
    if let Some(p) = patterns
        .into_iter()
        .find(|p| first < p.start + p.len && last >= p.start)
    {
        let exact = p.start == first && p.len as u32 * 8 == field.bit_length;
        let full = pattern_points(p.kind);
        points += if exact { full } else { full / 2 };
        reasons.push(CandidateReason::Pattern {
            kind: p.kind,
            exact,
        });
    }

    if field.bit_length > 8 {
        match (profile.endianness, field.endianness) {
            (Some(roles::Endianness::Little), Endianness::Little)
            | (Some(roles::Endianness::Big), Endianness::Big) => {
                points += 15;
                reasons.push(CandidateReason::EndiannessAgrees);
            }
            (Some(roles::Endianness::Mixed), _) => {
                points += 7;
                reasons.push(CandidateReason::EndiannessMixed);
            }
            _ => {}
        }
    }

    if !spanned.is_empty() {
        let distinct: usize = spanned.iter().map(|c| c.stats.distinct_values).sum();
        let average = distinct as f64 / spanned.len() as f64;
        points += match average {
            a if a > 50.0 => 15,
            a if a > 20.0 => 10,
            a if a > 5.0 => 5,
            _ => 2,
        };
        if average > 50.0 {
            reasons.push(CandidateReason::HighVariance);
        }
    }

    let trend = spanned.iter().find_map(|c| match c.role {
        ByteRole::Sensor { strength, .. } if strength > 0.6 => Some(strength),
        _ => None,
    });
    if let Some(strength) = trend {
        points += (strength * 10.0).round() as u32;
        if strength > 0.8 {
            reasons.push(CandidateReason::StrongTrend);
        }
    }

    Candidate {
        field,
        score: points.min(100) as u8,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::profile_bytes;

    #[test]
    fn a_reason_serialises_as_its_code() {
        let reasons = [
            CandidateReason::Role {
                role: RoleKind::Sensor,
            },
            CandidateReason::Pattern {
                kind: PatternKind::Sensor16,
                exact: true,
            },
            CandidateReason::NoProfile,
        ];
        assert_eq!(
            serde_json::to_value(reasons).unwrap(),
            serde_json::json!([
                { "code": "role", "role": "sensor" },
                { "code": "pattern", "kind": "sensor16", "exact": true },
                { "code": "noProfile" },
            ])
        );
    }

    /// A little-endian counter in bytes 0–1 beside a big-endian one in bytes 2–3.
    fn mixed_profile() -> ByteProfile {
        let payloads: Vec<Vec<u8>> = (0..60u16)
            .map(|i| {
                let little = (0x00F0 + i * 3).to_le_bytes();
                let big = (0x0100 + i * 97).to_be_bytes();
                [little, big].concat()
            })
            .collect();
        let profile = profile_bytes(&payloads);
        assert_eq!(profile.endianness, Some(roles::Endianness::Mixed));
        profile
    }

    fn ordered(profile: &ByteProfile, endianness: Option<roles::Endianness>) -> ByteProfile {
        ByteProfile {
            endianness,
            ..profile.clone()
        }
    }

    fn field(bit_length: u32, endianness: Endianness) -> PayloadField {
        PayloadField {
            start_bit: 0,
            bit_length,
            endianness,
            signed: false,
        }
    }

    /// The points `profile`'s byte order adds over no order, and its reasons.
    fn order_bonus(field: PayloadField, profile: &ByteProfile) -> (i32, Vec<CandidateReason>) {
        let with = score(field, profile);
        let without = score(field, &ordered(profile, None));
        let reasons = with
            .reasons
            .into_iter()
            .filter(|r| {
                matches!(
                    r,
                    CandidateReason::EndiannessAgrees | CandidateReason::EndiannessMixed
                )
            })
            .collect();
        (with.score as i32 - without.score as i32, reasons)
    }

    #[test]
    fn a_mixed_profile_gives_a_field_over_8_bits_seven_points_in_either_order() {
        let profile = mixed_profile();
        for order in [Endianness::Little, Endianness::Big] {
            assert_eq!(
                order_bonus(field(16, order), &profile),
                (7, vec![CandidateReason::EndiannessMixed]),
                "{order:?}"
            );
        }
    }

    #[test]
    fn a_mixed_profile_gives_an_8_bit_field_nothing() {
        let profile = mixed_profile();
        for order in [Endianness::Little, Endianness::Big] {
            assert_eq!(
                order_bonus(field(8, order), &profile),
                (0, vec![]),
                "{order:?}"
            );
        }
    }

    #[test]
    fn a_little_profile_gives_fifteen_points_to_a_little_field_over_8_bits_and_none_to_a_big_one() {
        let profile = ordered(&mixed_profile(), Some(roles::Endianness::Little));
        assert_eq!(
            order_bonus(field(16, Endianness::Little), &profile),
            (15, vec![CandidateReason::EndiannessAgrees])
        );
        assert_eq!(
            order_bonus(field(16, Endianness::Big), &profile),
            (0, vec![])
        );
    }

    #[test]
    fn every_fitting_field_is_ranked_uncapped_best_first_then_by_start_bit() {
        let payloads: Vec<Vec<u8>> = (0..60u32)
            .map(|i| (0..64u32).map(|j| (i * (j + 1) + j * j) as u8).collect())
            .collect();
        let profile = profile_bytes(&payloads);
        let lengths = [8, 16, 32];
        let sweep = Sweep {
            start_bits: 0..=511,
            bit_step: 1,
            bit_lengths: lengths.to_vec(),
            endiannesses: vec![Endianness::Little, Endianness::Big],
            signed: false,
        };

        let ranked = rank_fields(&sweep, Some(&profile), 64);

        let fitting: u32 = lengths.iter().map(|&len| 2 * (512 - len + 1)).sum();
        let aligned_big_bytes = 512 / 8;
        assert_eq!(ranked.len(), (fitting - aligned_big_bytes) as usize);
        assert!(ranked.len() > 500);
        assert!(ranked.windows(2).all(|w| {
            w[0].score > w[1].score
                || (w[0].score == w[1].score && w[0].field.start_bit <= w[1].field.start_bit)
        }));
    }
}
