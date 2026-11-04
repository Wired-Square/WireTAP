// crates/wiretap-app/src/report/notes.rs
//
// Byte notes worded for the reports, in the Changes view's words and as
// `byteNoteText.ts` composes them.

use wiretap_analysis::notes::ByteNote;
use wiretap_analysis::roles::{Direction, Endianness, MultiBytePattern, MuxSelector, PatternKind, Trend};

use super::ReportLocale;

const MAX_CASE_SUMMARIES: usize = 4;
const MAX_LISTED_CASES: usize = 6;

pub fn mux_value(value: u16, selector: MuxSelector) -> String {
    match selector {
        MuxSelector::TwoByte => format!("{}:{}", value >> 8, value & 0xFF),
        MuxSelector::OneByte => value.to_string(),
    }
}

/// A frame's notes; its case summaries only when there are at most four.
pub fn frame_lines(l: &ReportLocale, notes: &[ByteNote], selector: Option<MuxSelector>) -> Vec<String> {
    let summaries = notes.iter().filter(|n| matches!(n, ByteNote::CaseSummary { .. })).count();
    notes
        .iter()
        .filter(|n| !matches!(n, ByteNote::CaseSummary { .. }) || summaries <= MAX_CASE_SUMMARIES)
        .map(|n| text(l, n, selector.unwrap_or(MuxSelector::OneByte), false))
        .collect()
}

/// A mux case's notes, in the short form.
pub fn case_lines(l: &ReportLocale, notes: &[ByteNote], selector: MuxSelector) -> Vec<String> {
    notes.iter().map(|n| text(l, n, selector, true)).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
}

type Words<'a> = &'a dyn Fn(&str, &[(&str, &str)]) -> String;

fn text(l: &ReportLocale, note: &ByteNote, selector: MuxSelector, short: bool) -> String {
    let form = if short { "caseNote" } else { "note" };
    let key = |name: &str, params: &[(&str, &str)]| l.t(&format!("discovery:changes.{form}.{name}"), params);
    let long = |name: &str, params: &[(&str, &str)]| l.t(&format!("discovery:changes.note.{name}"), params);
    let flag = |on: bool, name: &str| if on { key(name, &[]) } else { String::new() };
    match note {
        ByteNote::NoSamples => long("noSamples", &[]),
        ByteNote::Endianness { endianness, pattern_count } => {
            let name = match endianness {
                Endianness::Little => "endianness.little",
                Endianness::Big => "endianness.big",
                Endianness::Mixed => "endianness.mixed",
            };
            long(name, &[("patterns", &pattern_count.to_string())])
        }
        ByteNote::VaryingLength { min, max } => {
            long("varyingLength", &[("min", &min.to_string()), ("max", &max.to_string())])
        }
        ByteNote::Burst { mux } => long(if *mux { "burstMux" } else { "burst" }, &[]),
        ByteNote::Identical { sample_count, payload } => {
            long("identical", &[("samples", &sample_count.to_string()), ("payload", &hex(payload))])
        }
        ByteNote::Multiplexed { selector: MuxSelector::TwoByte, cases } => {
            long("multiplexedTwoByte", &[("cases", &cases.len().to_string())])
        }
        ByteNote::Multiplexed { cases, .. } if cases.len() <= MAX_LISTED_CASES => {
            let values: Vec<String> = cases.iter().map(u16::to_string).collect();
            long("multiplexedList", &[("values", &values.join(", "))])
        }
        ByteNote::Multiplexed { cases, .. } => long(
            "multiplexedRange",
            &[
                ("cases", &cases.len().to_string()),
                ("first", &cases.first().unwrap_or(&0).to_string()),
                ("last", &cases.last().unwrap_or(&0).to_string()),
            ],
        ),
        ByteNote::CaseSummary { value, counters, statics } => long(
            "caseSummary",
            &[
                ("value", &mux_value(*value, selector)),
                ("counters", &counters.to_string()),
                ("statics", &statics.to_string()),
            ],
        ),
        ByteNote::Statics { bytes } => {
            let list: Vec<String> = bytes
                .iter()
                .map(|b| long("staticByte", &[("position", &b.position.to_string()), ("value", &format!("{:02X}", b.value))]))
                .collect();
            key("statics", &[("bytes", &list.join(", "))])
        }
        ByteNote::Counter { position, direction, step, rollover, looping } => {
            let direction = key(
                match direction {
                    Direction::Up => "up",
                    Direction::Down => "down",
                },
                &[],
            );
            let (position, step) = (position.to_string(), step.to_string());
            match looping {
                Some(lp) => {
                    let [min, max, modulo] = [lp.min.to_string(), lp.max.to_string(), lp.modulo.to_string()];
                    key(
                        "loopingCounter",
                        &[
                            ("position", &position),
                            ("direction", &direction),
                            ("step", &step),
                            ("min", &min),
                            ("max", &max),
                            ("modulo", &modulo),
                        ],
                    )
                }
                None => key(
                    "counter",
                    &[
                        ("position", &position),
                        ("direction", &direction),
                        ("step", &step),
                        ("rollover", &flag(*rollover, "rollover")),
                    ],
                ),
            }
        }
        ByteNote::Sensor { position, trend, strength, min, max } => {
            let arrow = match trend {
                Trend::Increasing => "↑",
                Trend::Decreasing => "↓",
                Trend::Mixed => "↕",
            };
            let strength = if *strength > 0.0 {
                long("strength", &[("percent", &(strength * 100.0).round().to_string())])
            } else {
                String::new()
            };
            key(
                "sensor",
                &[
                    ("position", &position.to_string()),
                    ("trend", arrow),
                    ("min", &min.to_string()),
                    ("max", &max.to_string()),
                    ("strength", &strength),
                ],
            )
        }
        ByteNote::Pattern(p) => pattern(p, &key, &long),
        ByteNote::VaryingValues { count } => long("varyingValues", &[("bytes", &count.to_string())]),
    }
}

fn pattern(p: &MultiBytePattern, key: Words, long: Words) -> String {
    let (start, end) = (p.start.to_string(), (p.start + p.len - 1).to_string());
    let flag = |on: bool, name: &str| if on { key(name, &[]) } else { String::new() };
    let endian = p.endianness.map_or_else(String::new, |e| {
        let order = match e {
            Endianness::Little => "little",
            Endianness::Big => "big",
            Endianness::Mixed => "mixed",
        };
        key("endian", &[("order", &long(order, &[]))])
    });
    match p.kind {
        PatternKind::Counter16 => key(
            "counter16",
            &[("start", &start), ("end", &end), ("endian", &endian), ("rollover", &flag(p.rollover, "rollover"))],
        ),
        PatternKind::Sensor16 | PatternKind::Sensor32 => {
            let bits = if p.kind == PatternKind::Sensor16 { "16" } else { "32" };
            let range = p.range.map_or_else(String::new, |(min, max)| {
                key("range", &[("min", &min.to_string()), ("max", &max.to_string())])
            });
            key(
                "sensorPattern",
                &[
                    ("bits", bits),
                    ("start", &start),
                    ("end", &end),
                    ("endian", &endian),
                    ("range", &range),
                    ("slow", &flag(p.slow_upper_bytes, "slowUpper")),
                    ("correlated", &flag(p.correlated_rollover, "correlated")),
                ],
            )
        }
        PatternKind::Text => {
            let sample = p.sample_text.as_ref().map_or_else(String::new, |t| long("sample", &[("text", t)]));
            key("text", &[("start", &start), ("end", &end), ("sample", &sample)])
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
            assert_eq!(text(&ReportLocale::default(), &n, MuxSelector::TwoByte, false), expected, "{n:?}");
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
            assert_eq!(text(&ReportLocale::default(), &n, MuxSelector::OneByte, true), expected, "{n:?}");
        }
    }
}
