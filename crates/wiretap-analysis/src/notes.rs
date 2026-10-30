//! Byte notes: what a [`ByteProfile`] says, as codes for the caller to word, frame
//! first and then each mux case. Which notes a view shows is the caller's choice.

use serde::{Deserialize, Serialize};

use crate::roles::{
    ByteColumn, ByteProfile, ByteRole, Direction, Endianness, Loop, MultiBytePattern, MuxSelector,
    Trend,
};

/// One note, in the order the desktop shows them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ByteNote {
    /// The only note when there are no samples.
    NoSamples,
    /// The profile's byte order, and how many noted patterns have one.
    Endianness {
        endianness: Endianness,
        pattern_count: usize,
    },
    VaryingLength {
        min: usize,
        max: usize,
    },
    /// The caller knows the frame comes in bursts.
    Burst {
        mux: bool,
    },
    Identical {
        sample_count: usize,
        payload: Vec<u8>,
    },
    Multiplexed {
        selector: MuxSelector,
        cases: Vec<u16>,
    },
    /// For each mux case with a counter or a static byte.
    CaseSummary {
        value: u16,
        counters: usize,
        statics: usize,
    },
    /// Every static column, inside patterns too.
    Statics {
        bytes: Vec<StaticByte>,
    },
    /// Outside patterns.
    Counter {
        position: usize,
        direction: Direction,
        step: u8,
        rollover: bool,
        looping: Option<Loop>,
    },
    /// Outside patterns.
    Sensor {
        position: usize,
        trend: Trend,
        strength: f64,
        min: u8,
        max: u8,
    },
    Pattern(MultiBytePattern),
    /// Columns that vary when nothing else outside patterns was noted; frames only.
    VaryingValues {
        count: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct StaticByte {
    pub position: usize,
    pub value: u8,
}

/// A frame's notes and its mux cases'.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ByteNotes {
    pub frame: Vec<ByteNote>,
    /// Every case, in key order.
    pub cases: Vec<MuxCaseNotes>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MuxCaseNotes {
    pub value: u16,
    pub notes: Vec<ByteNote>,
}

/// The notes for `profile`, a frame the caller has found comes in bursts when
/// `burst` is set. A mux frame's own patterns are not noted; its cases' are.
pub fn byte_notes(profile: &ByteProfile, burst: bool) -> ByteNotes {
    if profile.sample_count == 0 {
        return ByteNotes {
            frame: vec![ByteNote::NoSamples],
            cases: Vec::new(),
        };
    }
    let mut frame = Vec::new();
    if profile.min_len != profile.max_len {
        frame.push(ByteNote::VaryingLength {
            min: profile.min_len,
            max: profile.max_len,
        });
    }
    if burst {
        frame.push(ByteNote::Burst {
            mux: profile.mux.is_some(),
        });
    }
    if let Some(payload) = &profile.identical {
        frame.push(ByteNote::Identical {
            sample_count: profile.sample_count,
            payload: payload.clone(),
        });
    }

    let mut cases = Vec::new();
    let noted_patterns: Vec<&MultiBytePattern> = match &profile.mux {
        Some(mux) => {
            frame.push(ByteNote::Multiplexed {
                selector: mux.detection.selector,
                cases: mux.cases.iter().map(|c| c.value).collect(),
            });
            for case in &mux.cases {
                let count = |role: fn(&ByteRole) -> bool| {
                    case.columns.iter().filter(|c| role(&c.role)).count()
                };
                let counters = count(|r| matches!(r, ByteRole::Counter { .. }));
                let statics = count(|r| matches!(r, ByteRole::Static { .. }));
                if counters > 0 || statics > 0 {
                    frame.push(ByteNote::CaseSummary {
                        value: case.value,
                        counters,
                        statics,
                    });
                }
                cases.push(MuxCaseNotes {
                    value: case.value,
                    notes: column_notes(&case.columns, &case.patterns),
                });
            }
            mux.cases.iter().flat_map(|c| &c.patterns).collect()
        }
        None => {
            let notes = column_notes(&profile.columns, &profile.patterns);
            let explained = notes.iter().any(|n| !matches!(n, ByteNote::Statics { .. }));
            let varying = outside_patterns(&profile.columns, &profile.patterns)
                .filter(|c| c.role == ByteRole::Value)
                .count();
            frame.extend(notes);
            if varying > 0 && !explained {
                frame.push(ByteNote::VaryingValues { count: varying });
            }
            profile.patterns.iter().collect()
        }
    };

    if let Some(endianness) = profile.endianness {
        frame.insert(
            0,
            ByteNote::Endianness {
                endianness,
                pattern_count: noted_patterns
                    .iter()
                    .filter(|p| p.endianness.is_some())
                    .count(),
            },
        );
    }
    ByteNotes { frame, cases }
}

fn outside_patterns<'a>(
    columns: &'a [ByteColumn],
    patterns: &'a [MultiBytePattern],
) -> impl Iterator<Item = &'a ByteColumn> {
    columns.iter().filter(|c| {
        let at = c.stats.position as usize;
        !patterns
            .iter()
            .any(|p| (p.start..p.start + p.len).contains(&at))
    })
}

/// Statics, then counters and sensors outside patterns, then the patterns.
fn column_notes(columns: &[ByteColumn], patterns: &[MultiBytePattern]) -> Vec<ByteNote> {
    let statics: Vec<StaticByte> = columns
        .iter()
        .filter_map(|c| match c.role {
            ByteRole::Static { value } => Some(StaticByte {
                position: c.stats.position as usize,
                value,
            }),
            _ => None,
        })
        .collect();
    let mut notes = Vec::new();
    if !statics.is_empty() {
        notes.push(ByteNote::Statics { bytes: statics });
    }
    notes.extend(
        outside_patterns(columns, patterns).filter_map(|c| match c.role {
            ByteRole::Counter {
                direction,
                step,
                rollover,
                looping,
            } => Some(ByteNote::Counter {
                position: c.stats.position as usize,
                direction,
                step,
                rollover,
                looping,
            }),
            _ => None,
        }),
    );
    notes.extend(
        outside_patterns(columns, patterns).filter_map(|c| match c.role {
            ByteRole::Sensor {
                trend, strength, ..
            } => Some(ByteNote::Sensor {
                position: c.stats.position as usize,
                trend,
                strength,
                min: c.stats.min,
                max: c.stats.max,
            }),
            _ => None,
        }),
    );
    notes.extend(patterns.iter().cloned().map(ByteNote::Pattern));
    notes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::profile_bytes;

    #[test]
    fn notes_serialise_as_codes() {
        let payloads: Vec<Vec<u8>> = (0..10u8).map(|i| vec![0xC0, i]).collect();
        let notes = byte_notes(&profile_bytes(&payloads), false);
        let json = serde_json::to_value(&notes.frame).unwrap();
        assert_eq!(json[0]["code"], "statics");
        assert_eq!(json[0]["bytes"][0]["value"], 0xC0);
        assert_eq!(json[1]["code"], "counter");
        assert_eq!(json[1]["position"], 1);
    }
}
