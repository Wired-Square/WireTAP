//! Mirror groups: frame ids that carry the same changing payload at the same time.
//!
//! A pair is scored from the sparser id's side, so a fast mirror of a slow frame is
//! not penalised for the repeats in between, and an id whose payload never changes
//! is left out, since a constant matches anything that holds still beside it.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::scan::FrameKey;

pub const DEFAULT_MIRROR_WINDOW_US: u64 = 50_000;
/// Fewer samples than this on either side and a pair is not compared.
const MIN_SAMPLES: usize = 3;

/// One payload and when it was seen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimedPayload {
    pub timestamp_us: u64,
    pub payload: Vec<u8>,
}

/// Ids whose payloads mirror each other, directly or through another member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MirrorGroup {
    /// Ascending.
    pub keys: Vec<FrameKey>,
    /// Sparser-side samples with a partner in the window, over the group's mirrored
    /// pairs.
    pub sample_count: usize,
    /// The share of those with an equal payload in the window, rounded, 80–100.
    pub match_percentage: u8,
    pub sample_payload: Vec<u8>,
}

struct PairScore {
    paired: usize,
    matched: usize,
    sample_payload: Vec<u8>,
}

/// Mirror groups among oldest-first `streams`, a sample pairing with the other
/// id's samples within `window_us` of it; largest group first.
pub fn mirror_groups(
    streams: &BTreeMap<FrameKey, Vec<TimedPayload>>,
    window_us: u64,
) -> Vec<MirrorGroup> {
    let changing: Vec<(&FrameKey, &Vec<TimedPayload>)> = streams
        .iter()
        .filter(|(_, s)| s.len() >= MIN_SAMPLES && s.iter().any(|p| p.payload != s[0].payload))
        .collect();

    let mut pairs: Vec<(usize, usize, PairScore)> = Vec::new();
    for (i, (_, a)) in changing.iter().enumerate() {
        for (j, (_, b)) in changing.iter().enumerate().skip(i + 1) {
            let (sparse, dense) = if b.len() < a.len() { (b, a) } else { (a, b) };
            pairs.extend(
                score(sparse, dense, window_us)
                    .filter(|s| s.matched * 5 >= s.paired * 4)
                    .map(|s| (i, j, s)),
            );
        }
    }

    let mut root: Vec<usize> = (0..changing.len()).collect();
    for &(i, j, _) in &pairs {
        let (ri, rj) = (find(&mut root, i), find(&mut root, j));
        root[rj] = ri;
    }

    let mut groups: BTreeMap<usize, (MirrorGroup, usize)> = BTreeMap::new();
    for (i, j, s) in pairs {
        let (group, matched) = groups.entry(find(&mut root, i)).or_insert_with(|| {
            let group = MirrorGroup {
                keys: Vec::new(),
                sample_count: 0,
                match_percentage: 0,
                sample_payload: s.sample_payload.clone(),
            };
            (group, 0)
        });
        group.keys.extend([*changing[i].0, *changing[j].0]);
        group.sample_count += s.paired;
        *matched += s.matched;
    }

    let mut result: Vec<MirrorGroup> = groups
        .into_values()
        .map(|(mut group, matched)| {
            group.keys.sort();
            group.keys.dedup();
            group.match_percentage =
                (matched as f64 / group.sample_count as f64 * 100.0).round() as u8;
            group
        })
        .collect();
    result.sort_by(|a, b| b.keys.len().cmp(&a.keys.len()).then(a.keys.cmp(&b.keys)));
    result
}

fn find(root: &mut [usize], x: usize) -> usize {
    if root[x] != x {
        root[x] = find(root, root[x]);
    }
    root[x]
}

/// Each `sparse` sample is paired when `dense` has one within the window, and
/// matched when one of those is equal; `None` when nothing matched.
fn score(sparse: &[TimedPayload], dense: &[TimedPayload], window_us: u64) -> Option<PairScore> {
    let (mut paired, mut matched, mut sample_payload) = (0, 0, None);
    for s in sparse {
        let from =
            dense.partition_point(|d| d.timestamp_us < s.timestamp_us.saturating_sub(window_us));
        let mut near = dense[from..]
            .iter()
            .take_while(|d| d.timestamp_us <= s.timestamp_us.saturating_add(window_us))
            .peekable();
        if near.peek().is_none() {
            continue;
        }
        paired += 1;
        if near.any(|d| d.payload == s.payload) {
            matched += 1;
            sample_payload.get_or_insert_with(|| s.payload.clone());
        }
    }
    Some(PairScore {
        paired,
        matched,
        sample_payload: sample_payload?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(start_ms: u64, every_ms: u64, payloads: &[u8]) -> Vec<TimedPayload> {
        payloads
            .iter()
            .enumerate()
            .map(|(i, &p)| TimedPayload {
                timestamp_us: (start_ms + i as u64 * every_ms) * 1000,
                payload: vec![p],
            })
            .collect()
    }

    #[test]
    fn eighty_percent_is_a_mirror_and_counts_paired_samples() {
        let key = |id| FrameKey::new(id, false);
        let streams = BTreeMap::from([
            (key(1), stream(0, 100, &[0, 1, 2, 3, 4])),
            (key(2), stream(1, 100, &[0, 1, 2, 3, 9])),
        ]);
        let groups = mirror_groups(&streams, DEFAULT_MIRROR_WINDOW_US);
        assert_eq!(groups.len(), 1);
        assert_eq!(
            (groups[0].sample_count, groups[0].match_percentage),
            (5, 80)
        );
    }
}
