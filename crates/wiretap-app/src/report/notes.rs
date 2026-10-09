// crates/wiretap-app/src/report/notes.rs
//
// Byte notes worded for the reports, in the en-AU words the Changes view uses.

use wiretap_analysis::notes::ByteNote;
use wiretap_analysis::roles::{Direction, Endianness, MultiBytePattern, MuxSelector, PatternKind, Trend};

const MAX_CASE_SUMMARIES: usize = 4;
const MAX_LISTED_CASES: usize = 6;

pub fn mux_value(value: u16, selector: MuxSelector) -> String {
    match selector {
        MuxSelector::TwoByte => format!("{}:{}", value >> 8, value & 0xFF),
        MuxSelector::OneByte => value.to_string(),
    }
}

/// A frame's notes; its case summaries only when there are at most four.
pub fn frame_lines(notes: &[ByteNote], selector: Option<MuxSelector>) -> Vec<String> {
    let summaries = notes.iter().filter(|n| matches!(n, ByteNote::CaseSummary { .. })).count();
    notes
        .iter()
        .filter(|n| !matches!(n, ByteNote::CaseSummary { .. }) || summaries <= MAX_CASE_SUMMARIES)
        .map(|n| text(n, selector.unwrap_or(MuxSelector::OneByte), false))
        .collect()
}

/// A mux case's notes, in the short form.
pub fn case_lines(notes: &[ByteNote], selector: MuxSelector) -> Vec<String> {
    notes.iter().map(|n| text(n, selector, true)).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
}

fn order(e: Endianness) -> &'static str {
    match e {
        Endianness::Little => "little",
        Endianness::Big => "big",
        Endianness::Mixed => "mixed",
    }
}

fn text(note: &ByteNote, selector: MuxSelector, short: bool) -> String {
    let flag = |on: bool, long: &str, brief: &str| if on { if short { brief } else { long } } else { "" }.to_string();
    match note {
        ByteNote::NoSamples => "No frames to analyse".into(),
        ByteNote::Endianness { endianness, pattern_count } => {
            let name = match endianness {
                Endianness::Little => "Little-endian",
                Endianness::Big => "Big-endian",
                Endianness::Mixed => "Mixed endianness",
            };
            format!("{name} (inferred from {pattern_count} multi-byte pattern(s))")
        }
        ByteNote::VaryingLength { min, max } => format!("Varying length: {min}–{max} bytes"),
        ByteNote::Burst { mux: false } => "Burst frame: analysing stable payload portion only".into(),
        ByteNote::Burst { mux: true } => "Burst frame with mux: analysing stable payload portion only".into(),
        ByteNote::Identical { sample_count, payload } => {
            format!("Identical payload across all {sample_count} samples: {}", hex(payload))
        }
        ByteNote::Multiplexed { selector: MuxSelector::TwoByte, cases } => {
            format!("Multiplexed frame: byte[0:1], {} cases", cases.len())
        }
        ByteNote::Multiplexed { cases, .. } if cases.len() <= MAX_LISTED_CASES => {
            let values: Vec<String> = cases.iter().map(u16::to_string).collect();
            format!("Multiplexed frame: byte[0], cases: {}", values.join(", "))
        }
        ByteNote::Multiplexed { cases, .. } => format!(
            "Multiplexed frame: byte[0], {} cases ({}-{})",
            cases.len(),
            cases.first().unwrap_or(&0),
            cases.last().unwrap_or(&0)
        ),
        ByteNote::CaseSummary { value, counters, statics } => {
            format!("Case {}: {counters} counter, {statics} static", mux_value(*value, selector))
        }
        ByteNote::Statics { bytes } => {
            let list: Vec<String> =
                bytes.iter().map(|b| format!("byte[{}]=0x{:02X}", b.position, b.value)).collect();
            format!("{}: {}", if short { "Static" } else { "Static bytes" }, list.join(", "))
        }
        ByteNote::Counter { position, direction, step, rollover, looping } => {
            let direction = match (direction, short) {
                (Direction::Up, false) => "incrementing",
                (Direction::Down, false) => "decrementing",
                (Direction::Up, true) => "inc",
                (Direction::Down, true) => "dec",
            };
            match (looping, short) {
                (Some(l), false) => format!(
                    "Looping counter at byte[{position}]: {direction}, step={step}, range {}–{} (mod {})",
                    l.min, l.max, l.modulo
                ),
                (Some(l), true) => format!(
                    "Loop counter byte[{position}]: {direction}, step={step}, {}–{} (mod {})",
                    l.min, l.max, l.modulo
                ),
                (None, false) => format!(
                    "Counter at byte[{position}]: {direction}, step={step}{}",
                    flag(*rollover, " (rollover detected)", "")
                ),
                (None, true) => {
                    format!("Counter byte[{position}]: {direction}, step={step}{}", flag(*rollover, "", " +rollover"))
                }
            }
        }
        ByteNote::Sensor { position, trend, strength, min, max } => {
            let arrow = match trend {
                Trend::Increasing => "↑",
                Trend::Decreasing => "↓",
                Trend::Mixed => "↕",
            };
            if short {
                format!("Sensor byte[{position}]: {arrow} range {min}–{max}")
            } else {
                let strength = if *strength > 0.0 {
                    format!(" ({}% trend)", (strength * 100.0).round())
                } else {
                    String::new()
                };
                format!("Sensor at byte[{position}]: {arrow} range {min}–{max}{strength}")
            }
        }
        ByteNote::Pattern(p) => pattern(p, short),
        ByteNote::VaryingValues { count } => format!("{count} byte(s) with varying values detected"),
    }
}

fn pattern(p: &MultiBytePattern, short: bool) -> String {
    let (start, end) = (p.start, p.start + p.len - 1);
    let flag = |on: bool, long: &str, brief: &str| if on { if short { brief } else { long } } else { "" }.to_string();
    let endian = p.endianness.map_or_else(String::new, |e| {
        if short { format!(" {}", order(e)) } else { format!(", {} endian", order(e)) }
    });
    match p.kind {
        PatternKind::Counter16 => {
            let (lead, rollover) = if short { ("16b counter", " +rollover") } else { ("16-bit counter at", " (rollover detected)") };
            format!("{lead} byte[{start}:{end}]{endian}{}", flag(p.rollover, rollover, rollover))
        }
        PatternKind::Sensor16 | PatternKind::Sensor32 => {
            let bits = if p.kind == PatternKind::Sensor16 { 16 } else { 32 };
            let range = p.range.map_or_else(String::new, |(min, max)| {
                if short { format!(" {min}–{max}") } else { format!(", range {min}–{max}") }
            });
            let lead = if short { format!("{bits}b sensor") } else { format!("{bits}-bit sensor at") };
            format!(
                "{lead} byte[{start}:{end}]{endian}{range}{}{}",
                flag(p.slow_upper_bytes, " (slow-changing upper bytes)", " +slow-upper"),
                flag(p.correlated_rollover, " (rollover correlation detected)", " +correlated"),
            )
        }
        PatternKind::Text => {
            let sample = p.sample_text.as_ref().map_or_else(String::new, |t| format!(" \"{t}\""));
            format!("{} byte[{start}:{end}]{sample}", if short { "Text" } else { "Text at" })
        }
    }
}

/// The words here are the Changes view's: each note against the en-AU locale,
/// composed as `byteNoteText.ts` composes it.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use wiretap_analysis::notes::StaticByte;
    use wiretap_analysis::roles::Loop;

    fn locale() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../frontend/wiretap-ui/src/locales/en-AU/discovery.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// `changes.<form>.<key>` with each `{{name}}` filled.
    fn t(locale: &Value, form: &str, key: &str, params: &[(&str, &str)]) -> String {
        let mut text = key
            .split('.')
            .fold(&locale["changes"][form], |v, k| &v[k])
            .as_str()
            .unwrap_or_else(|| panic!("no changes.{form}.{key}"))
            .to_string();
        for (name, value) in params {
            text = text.replace(&format!("{{{{{name}}}}}"), value);
        }
        assert!(!text.contains("{{"), "unfilled {text}");
        text
    }

    fn pattern(kind: PatternKind) -> MultiBytePattern {
        MultiBytePattern {
            start: 2,
            len: 2,
            kind,
            endianness: Some(Endianness::Big),
            rollover: true,
            correlated_rollover: true,
            slow_upper_bytes: true,
            range: Some((3, 900)),
            sample_text: Some("OK".into()),
        }
    }

    #[test]
    fn report_notes_are_worded_as_the_locale_words_them() {
        let l = &locale();
        let note = |key: &str, params: &[(&str, &str)]| t(l, "note", key, params);
        let case = |key: &str, params: &[(&str, &str)]| t(l, "caseNote", key, params);
        let looping = Some(Loop { min: 0, max: 9, modulo: 10 });
        let counter = |looping| ByteNote::Counter { position: 1, direction: Direction::Down, step: 2, rollover: true, looping };
        let sensor = ByteNote::Sensor { position: 3, trend: Trend::Increasing, strength: 0.5, min: 0, max: 15 };
        let statics = ByteNote::Statics { bytes: vec![StaticByte { position: 0, value: 0x1F }] };
        let static_byte = note("staticByte", &[("position", "0"), ("value", "1F")]);
        let sensor16 = ByteNote::Pattern(pattern(PatternKind::Sensor16));
        let counter16 = ByteNote::Pattern(pattern(PatternKind::Counter16));
        let text_pattern = ByteNote::Pattern(pattern(PatternKind::Text));

        let long = [
            (ByteNote::NoSamples, note("noSamples", &[])),
            (
                ByteNote::Endianness { endianness: Endianness::Mixed, pattern_count: 2 },
                note("endianness.mixed", &[("patterns", "2")]),
            ),
            (ByteNote::VaryingLength { min: 1, max: 8 }, note("varyingLength", &[("min", "1"), ("max", "8")])),
            (ByteNote::Burst { mux: false }, note("burst", &[])),
            (ByteNote::Burst { mux: true }, note("burstMux", &[])),
            (
                ByteNote::Identical { sample_count: 3, payload: vec![1, 0xAB] },
                note("identical", &[("samples", "3"), ("payload", "01 AB")]),
            ),
            (
                ByteNote::Multiplexed { selector: MuxSelector::TwoByte, cases: vec![1, 258] },
                note("multiplexedTwoByte", &[("cases", "2")]),
            ),
            (
                ByteNote::Multiplexed { selector: MuxSelector::OneByte, cases: vec![1, 2] },
                note("multiplexedList", &[("values", "1, 2")]),
            ),
            (
                ByteNote::Multiplexed { selector: MuxSelector::OneByte, cases: (1..=7).collect() },
                note("multiplexedRange", &[("cases", "7"), ("first", "1"), ("last", "7")]),
            ),
            (
                ByteNote::CaseSummary { value: 258, counters: 1, statics: 2 },
                note("caseSummary", &[("value", "1:2"), ("counters", "1"), ("statics", "2")]),
            ),
            (statics.clone(), note("statics", &[("bytes", &static_byte)])),
            (
                counter(None),
                note("counter", &[("position", "1"), ("direction", &note("down", &[])), ("step", "2"), ("rollover", &note("rollover", &[]))]),
            ),
            (
                counter(looping),
                note("loopingCounter", &[("position", "1"), ("direction", &note("down", &[])), ("step", "2"), ("min", "0"), ("max", "9"), ("modulo", "10")]),
            ),
            (
                sensor.clone(),
                note("sensor", &[("position", "3"), ("trend", "↑"), ("min", "0"), ("max", "15"), ("strength", &note("strength", &[("percent", "50")]))]),
            ),
            (
                counter16.clone(),
                note("counter16", &[("start", "2"), ("end", "3"), ("endian", &note("endian", &[("order", &note("big", &[]))])), ("rollover", &note("rollover", &[]))]),
            ),
            (
                sensor16.clone(),
                note("sensorPattern", &[
                    ("bits", "16"),
                    ("start", "2"),
                    ("end", "3"),
                    ("endian", &note("endian", &[("order", &note("big", &[]))])),
                    ("range", &note("range", &[("min", "3"), ("max", "900")])),
                    ("slow", &note("slowUpper", &[])),
                    ("correlated", &note("correlated", &[])),
                ]),
            ),
            (text_pattern.clone(), note("text", &[("start", "2"), ("end", "3"), ("sample", &note("sample", &[("text", "OK")]))])),
            (ByteNote::VaryingValues { count: 2 }, note("varyingValues", &[("bytes", "2")])),
        ];
        for (n, expected) in long {
            assert_eq!(text(&n, MuxSelector::TwoByte, false), expected, "{n:?}");
        }

        let short = [
            (statics, case("statics", &[("bytes", &static_byte)])),
            (
                counter(None),
                case("counter", &[("position", "1"), ("direction", &case("down", &[])), ("step", "2"), ("rollover", &case("rollover", &[]))]),
            ),
            (
                counter(looping),
                case("loopingCounter", &[("position", "1"), ("direction", &case("down", &[])), ("step", "2"), ("min", "0"), ("max", "9"), ("modulo", "10")]),
            ),
            (sensor, case("sensor", &[("position", "3"), ("trend", "↑"), ("min", "0"), ("max", "15")])),
            (
                counter16,
                case("counter16", &[("start", "2"), ("end", "3"), ("endian", &case("endian", &[("order", &note("big", &[]))])), ("rollover", &case("rollover", &[]))]),
            ),
            (
                sensor16,
                case("sensorPattern", &[
                    ("bits", "16"),
                    ("start", "2"),
                    ("end", "3"),
                    ("endian", &case("endian", &[("order", &note("big", &[]))])),
                    ("range", &case("range", &[("min", "3"), ("max", "900")])),
                    ("slow", &case("slowUpper", &[])),
                    ("correlated", &case("correlated", &[])),
                ]),
            ),
            (text_pattern, case("text", &[("start", "2"), ("end", "3"), ("sample", &note("sample", &[("text", "OK")]))])),
        ];
        for (n, expected) in short {
            assert_eq!(text(&n, MuxSelector::OneByte, true), expected, "{n:?}");
        }
    }
}
