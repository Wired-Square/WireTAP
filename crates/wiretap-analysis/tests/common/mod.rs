//! Reading the desktop fixtures' byte profiles, which are the lib's JSON.

use std::collections::BTreeMap;

use serde_json::Value;
use wiretap_analysis::{
    ByteColumn, ByteProfile, ByteRole, Direction, Endianness, Loop, MultiBytePattern, MuxAnalysis,
    MuxCase, MuxDetection, MuxSelector, PatternKind, Trend,
};
use wslib_checksum::columns::ColumnStats;

pub fn list<T>(value: &Value, item: impl Fn(&Value) -> T) -> Vec<T> {
    value
        .as_array()
        .map_or(vec![], |a| a.iter().map(item).collect())
}

fn uint(value: &Value) -> usize {
    value.as_u64().unwrap() as usize
}

fn enumerated<T: Copy>(value: &Value, options: &[(&str, T)]) -> T {
    options.iter().find(|(name, _)| value == *name).unwrap().1
}

fn endianness(value: &Value) -> Option<Endianness> {
    (!value.is_null()).then(|| {
        enumerated(
            value,
            &[
                ("little", Endianness::Little),
                ("big", Endianness::Big),
                ("mixed", Endianness::Mixed),
            ],
        )
    })
}

fn column(c: &Value) -> ByteColumn {
    let role = match c["role"].as_str().unwrap() {
        "static" => ByteRole::Static {
            value: uint(&c["value"]) as u8,
        },
        "counter" => ByteRole::Counter {
            direction: enumerated(
                &c["direction"],
                &[("up", Direction::Up), ("down", Direction::Down)],
            ),
            step: uint(&c["step"]) as u8,
            rollover: c["rollover"].as_bool().unwrap(),
            looping: (!c["looping"].is_null()).then(|| Loop {
                min: uint(&c["looping"]["min"]) as u8,
                max: uint(&c["looping"]["max"]) as u8,
                modulo: uint(&c["looping"]["modulo"]) as u16,
            }),
        },
        "sensor" => ByteRole::Sensor {
            trend: enumerated(
                &c["trend"],
                &[
                    ("increasing", Trend::Increasing),
                    ("decreasing", Trend::Decreasing),
                    ("mixed", Trend::Mixed),
                ],
            ),
            strength: c["strength"].as_f64().unwrap(),
            rollover: c["rollover"].as_bool().unwrap(),
        },
        "value" => ByteRole::Value,
        _ => ByteRole::Unknown,
    };
    ByteColumn {
        stats: ColumnStats {
            position: c["position"].as_i64().unwrap() as i32,
            distinct_values: uint(&c["distinctValues"]),
            min: uint(&c["min"]) as u8,
            max: uint(&c["max"]) as u8,
            constant_value: c["constantValue"].as_u64().map(|v| v as u8),
            changes: uint(&c["changes"]),
            transitions: uint(&c["transitions"]),
            entropy_bits: c["entropyBits"].as_f64().unwrap(),
            sample_count: uint(&c["sampleCount"]),
        },
        role,
    }
}

pub fn pattern(p: &Value) -> MultiBytePattern {
    MultiBytePattern {
        start: uint(&p["start"]),
        len: uint(&p["len"]),
        kind: enumerated(
            &p["kind"],
            &[
                ("counter16", PatternKind::Counter16),
                ("sensor16", PatternKind::Sensor16),
                ("sensor32", PatternKind::Sensor32),
                ("text", PatternKind::Text),
            ],
        ),
        endianness: endianness(&p["endianness"]),
        rollover: p["rollover"].as_bool().unwrap(),
        correlated_rollover: p["correlatedRollover"].as_bool().unwrap(),
        slow_upper_bytes: p["slowUpperBytes"].as_bool().unwrap(),
        range: p["range"]
            .as_array()
            .map(|r| (r[0].as_u64().unwrap() as u32, r[1].as_u64().unwrap() as u32)),
        sample_text: p["sampleText"].as_str().map(String::from),
    }
}

pub fn profile(p: &Value) -> ByteProfile {
    let mux = &p["mux"];
    ByteProfile {
        sample_count: uint(&p["sampleCount"]),
        min_len: uint(&p["minLen"]),
        max_len: uint(&p["maxLen"]),
        identical: (!p["identical"].is_null()).then(|| list(&p["identical"], |b| uint(b) as u8)),
        analysed_from: uint(&p["analysedFrom"]),
        columns: list(&p["columns"], column),
        patterns: list(&p["patterns"], pattern),
        endianness: endianness(&p["endianness"]),
        mux: (!mux.is_null()).then(|| MuxAnalysis {
            detection: MuxDetection {
                selector: enumerated(
                    &mux["detection"]["selector"],
                    &[
                        ("oneByte", MuxSelector::OneByte),
                        ("twoByte", MuxSelector::TwoByte),
                    ],
                ),
                occurrences: mux["detection"]["occurrences"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, n)| (k.parse().unwrap(), uint(n)))
                    .collect::<BTreeMap<u16, usize>>(),
            },
            cases: list(&mux["cases"], |c| MuxCase {
                value: uint(&c["value"]) as u16,
                sample_count: uint(&c["sampleCount"]),
                columns: list(&c["columns"], column),
                patterns: list(&c["patterns"], pattern),
            }),
        }),
    }
}
