//! Byte notes against the desktop's TypeScript, case by case, from
//! `fixtures/analysis/byteNotes.json`. The lib returns codes; `render` words them
//! as the desktop does, US spelling and all, so the notes compare as text. Where
//! the lib differs, the expected notes are replaced below and the reason named by
//! the plan's decision (D#) or the facts note's item (facts #).

mod common;

use std::path::PathBuf;

use common::{list, profile};
use serde_json::Value;
use wiretap_analysis::{
    byte_notes, ByteNote, Direction, Endianness, MultiBytePattern, MuxSelector, PatternKind, Trend,
};

fn cases() -> Vec<Value> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/analysis/byteNotes.json");
    let text = std::fs::read_to_string(path).unwrap();
    let fixture: Value = serde_json::from_str(&text).unwrap();
    fixture["cases"].as_array().unwrap().clone()
}

fn hex(bytes: impl IntoIterator<Item = u8>) -> Vec<String> {
    bytes.into_iter().map(|b| format!("{b:02X}")).collect()
}

fn endian_word(e: Option<Endianness>) -> &'static str {
    match e {
        Some(Endianness::Little) => "little",
        Some(Endianness::Big) => "big",
        Some(Endianness::Mixed) => "mixed",
        None => "undefined",
    }
}

fn arrow(trend: Trend) -> &'static str {
    match trend {
        Trend::Increasing => "↑",
        Trend::Decreasing => "↓",
        Trend::Mixed => "↕",
    }
}

fn case_value(value: u16, selector: MuxSelector) -> String {
    match selector {
        MuxSelector::TwoByte => format!("{}:{}", value / 256, value % 256),
        MuxSelector::OneByte => value.to_string(),
    }
}

/// The desktop's wording: `short` is a mux case's.
fn render(note: &ByteNote, selector: Option<MuxSelector>, short: bool) -> String {
    match note {
        ByteNote::NoSamples => "No frames to analyze".into(),
        ByteNote::Endianness {
            endianness,
            pattern_count,
        } => {
            let label = match endianness {
                Endianness::Mixed => "Mixed endianness",
                Endianness::Little => "Little-endian",
                Endianness::Big => "Big-endian",
            };
            format!("{label} (inferred from {pattern_count} multi-byte pattern(s))")
        }
        ByteNote::VaryingLength { min, max } => format!("Varying length: {min}–{max} bytes"),
        ByteNote::Burst { mux: true } => {
            "Burst frame with mux: analyzing stable payload portion only".into()
        }
        ByteNote::Burst { mux: false } => {
            "Burst frame: analyzing stable payload portion only".into()
        }
        ByteNote::Identical {
            sample_count,
            payload,
        } => format!(
            "Identical payload across all {sample_count} samples: {}",
            hex(payload.iter().copied()).join(" ")
        ),
        ByteNote::Multiplexed { selector, cases } => {
            let values: Vec<String> = cases.iter().map(|v| v.to_string()).collect();
            let info = match selector {
                MuxSelector::TwoByte => format!("byte[0:1], {} cases", cases.len()),
                _ if cases.len() <= 6 => format!("byte[0], cases: {}", values.join(", ")),
                _ => format!(
                    "byte[0], {} cases ({}-{})",
                    cases.len(),
                    values[0],
                    values[values.len() - 1]
                ),
            };
            format!("Multiplexed frame: {info}")
        }
        ByteNote::CaseSummary {
            value,
            counters,
            statics,
        } => format!(
            "Case {}: {counters} counter, {statics} static",
            case_value(*value, selector.unwrap())
        ),
        ByteNote::Statics { bytes } => {
            let list: Vec<String> = bytes
                .iter()
                .map(|b| format!("byte[{}]=0x{:02X}", b.position, b.value))
                .collect();
            let label = if short { "Static" } else { "Static bytes" };
            format!("{label}: {}", list.join(", "))
        }
        ByteNote::Counter {
            position,
            direction,
            step,
            rollover,
            looping,
        } => {
            let up = *direction == Direction::Up;
            match (looping, short) {
                (Some(l), false) => format!(
                    "Looping counter at byte[{position}]: {}, step={step}, range {}–{} (mod {})",
                    if up { "incrementing" } else { "decrementing" },
                    l.min,
                    l.max,
                    l.modulo
                ),
                (Some(l), true) => format!(
                    "Loop counter byte[{position}]: {}, step={step}, {}–{} (mod {})",
                    if up { "inc" } else { "dec" },
                    l.min,
                    l.max,
                    l.modulo
                ),
                (None, false) => format!(
                    "Counter at byte[{position}]: {}, step={step}{}",
                    if up { "incrementing" } else { "decrementing" },
                    suffix(*rollover, short, " (rollover detected)", "")
                ),
                (None, true) => format!(
                    "Counter byte[{position}]: {}, step={step}{}",
                    if up { "inc" } else { "dec" },
                    suffix(*rollover, short, "", " +rollover")
                ),
            }
        }
        ByteNote::Sensor {
            position,
            trend,
            min,
            max,
            ..
        } if short => format!(
            "Sensor byte[{position}]: {} range {min}–{max}",
            arrow(*trend)
        ),
        ByteNote::Sensor {
            position,
            trend,
            strength,
            min,
            max,
        } => {
            let strength = if *strength != 0.0 {
                format!(" ({}% trend)", (strength * 100.0).round())
            } else {
                String::new()
            };
            format!(
                "Sensor at byte[{position}]: {} range {min}–{max}{strength}",
                arrow(*trend)
            )
        }
        ByteNote::Pattern(p) => render_pattern(p, short),
        ByteNote::VaryingValues { count } => {
            format!("{count} byte(s) with varying values detected")
        }
    }
}

/// A flag's wording when it is set, long or short.
fn suffix(on: bool, short: bool, long: &'static str, brief: &'static str) -> &'static str {
    match (on, short) {
        (false, _) => "",
        (true, false) => long,
        (true, true) => brief,
    }
}

fn render_pattern(p: &MultiBytePattern, short: bool) -> String {
    let span = format!("byte[{}:{}]", p.start, p.start + p.len - 1);
    let endian = endian_word(p.endianness);
    let text = p
        .sample_text
        .as_ref()
        .map_or(String::new(), |t| format!(" \"{t}\""));
    match p.kind {
        PatternKind::Counter16 if short => format!(
            "16b counter {span} {endian}{}",
            suffix(p.rollover, short, "", " +rollover")
        ),
        PatternKind::Counter16 => format!(
            "16-bit counter at {span}, {endian} endian{}",
            suffix(p.rollover, short, " (rollover detected)", "")
        ),
        PatternKind::Sensor16 | PatternKind::Sensor32 => {
            let bits = if p.kind == PatternKind::Sensor16 {
                16
            } else {
                32
            };
            let range = p.range.map_or(String::new(), |(lo, hi)| {
                format!("{}{lo}–{hi}", if short { " " } else { ", range " })
            });
            let slow = suffix(
                p.slow_upper_bytes,
                short,
                " (slow-changing upper bytes)",
                " +slow-upper",
            );
            let correlated = suffix(
                p.correlated_rollover,
                short,
                " (rollover correlation detected)",
                " +correlated",
            );
            if short {
                format!("{bits}b sensor {span} {endian}{range}{slow}{correlated}")
            } else {
                format!("{bits}-bit sensor at {span}, {endian} endian{range}{slow}{correlated}")
            }
        }
        PatternKind::Text if short => format!("Text {span}{text}"),
        PatternKind::Text => format!("Text at {span}{text}"),
    }
}

/// (case, `None` for the frame or the mux case value, the lib's notes, why).
type Deviation = (
    &'static str,
    Option<u16>,
    &'static [&'static str],
    &'static str,
);

fn deviations() -> Vec<Deviation> {
    vec![
        (
            "down counter, mixed sensor with no strength, looping counter with modulo 0",
            None,
            &[
                "Counter at byte[0]: decrementing, step=2",
                "Looping counter at byte[3]: incrementing, step=3, range 1–3 (mod 0)",
                "Sensor at byte[1]: ↕ range 3–200",
                "Sensor at byte[2]: ↑ range 0–15 (50% trend)",
            ],
            "D9, facts 8: a looping counter stays one, its modulo the profile's; 0 cannot come from profile_bytes",
        ),
        (
            "one-byte mux, cases summarised and noted in short",
            None,
            &[
                "Mixed endianness (inferred from 3 multi-byte pattern(s))",
                "Multiplexed frame: byte[0], cases: 0, 1, 2",
                "Case 0: 2 counter, 1 static",
                "Case 1: 1 counter, 0 static",
            ],
            "D9, facts 8: the frame's own counter16 is never noted, so it is not counted",
        ),
        (
            "one-byte mux with more than six cases and more than four summaries",
            None,
            &[
                "Multiplexed frame: byte[0], 7 cases (0-6)",
                "Case 0: 0 counter, 1 static",
                "Case 1: 0 counter, 1 static",
                "Case 2: 0 counter, 1 static",
                "Case 3: 0 counter, 1 static",
                "Case 4: 0 counter, 1 static",
                "Case 5: 0 counter, 1 static",
                "Case 6: 0 counter, 1 static",
            ],
            "D9, facts 8: case summaries are never truncated",
        ),
    ]
}

#[test]
fn byte_notes_match_the_typescript_but_for_named_deviations() {
    let deviations = deviations();
    let cases = cases();
    for (name, ..) in &deviations {
        assert!(cases.iter().any(|c| c["name"] == *name), "no case {name}");
    }
    let expected_for = |name: &str, at: Option<u16>, ts: &Value| -> Vec<String> {
        deviations
            .iter()
            .find(|d| d.0 == name && d.1 == at)
            .map_or_else(
                || list(ts, |n| n.as_str().unwrap().to_string()),
                |d| d.2.iter().map(|n| n.to_string()).collect(),
            )
    };

    for case in cases {
        let name = case["name"].as_str().unwrap();
        let profile = profile(&case["input"]["profile"]);
        let burst = case["input"]["isBurstFrame"].as_bool().unwrap();
        let notes = byte_notes(&profile, burst);
        let selector = profile.mux.as_ref().map(|m| m.detection.selector);
        let expected = &case["expected"];

        let frame: Vec<String> = notes
            .frame
            .iter()
            .map(|n| render(n, selector, false))
            .collect();
        assert_eq!(
            frame,
            expected_for(name, None, &expected["notes"]),
            "{name}"
        );

        let ts_cases = list(&expected["muxCaseAnalyses"], Clone::clone);
        assert_eq!(notes.cases.len(), ts_cases.len(), "{name}: case count");
        for (case, ts) in notes.cases.iter().zip(&ts_cases) {
            assert_eq!(case.value as u64, ts["muxValue"].as_u64().unwrap());
            let lib: Vec<String> = case
                .notes
                .iter()
                .map(|n| render(n, selector, true))
                .collect();
            assert_eq!(
                lib,
                expected_for(name, Some(case.value), &ts["notes"]),
                "{name}: case {}",
                case.value
            );
        }
    }
}
