//! The byte-role classifier against the desktop's TypeScript and its
//! `compute_byte_profile`, case by case, from `expected.json` beside `cases.json`.
//!
//! Only the differences the API note's table allows are tolerated, each listed
//! below by case and row. Row 9 holds for the CAN cases: `uniqueValues` is
//! compared by count. The serial cases compare their sorted values, and render
//! the lib's reason codes as the TypeScript's notes.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::Value;
use wiretap_analysis::{
    detect_mux, profile_bytes, serial_structure, ByteColumn, FieldCandidate, MultiBytePattern,
    MuxSelector,
};

/// (case, row, the path prefix the difference is at).
const ALLOWED: &[(&str, u8, &str)] = &[
    ("varying_lengths", 1, "columns.count"),
    ("runt_in_middle", 1, "columns.count"),
    ("runt_in_middle", 1, "patterns.count"),
    ("runt_in_middle", 1, "endianness"),
    ("runt_in_middle", 2, "rust.bytes[1].changes"),
    ("runt_in_middle", 2, "rust.bytes[2].changes"),
    ("mux_one_byte", 8, "columns[1]."),
    ("mux_one_byte", 8, "columns[2]."),
    ("mux_one_byte", 8, "columns[3]."),
    ("mux_two_byte", 8, "columns[2]."),
    ("sensor32_le_high_word_over_8000", 7, "patterns[0].range"),
];

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/byte_roles")
        .join(name)
}

fn read(name: &str) -> Option<Value> {
    let text = std::fs::read_to_string(fixture(name)).ok()?;
    Some(serde_json::from_str(&text).unwrap())
}

/// (path, what differs).
struct Diffs(Vec<(String, String)>);

impl Diffs {
    fn check(&mut self, path: impl Into<String>, lib: impl Into<Value>, ts: &Value) {
        let lib = lib.into();
        if !same(&lib, ts) {
            self.0
                .push((path.into(), format!("lib {lib}, expected {ts}")));
        }
    }
}

fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => (x - y).abs() < 1e-9,
        _ => a == b,
    }
}

fn ts_role(stats: &Value) -> Value {
    let role = stats["role"].as_str().unwrap();
    let mut out = serde_json::json!({ "role": role });
    match role {
        "static" => out["value"] = stats["staticValue"].clone(),
        "counter" => {
            out["direction"] = stats["counterDirection"].clone();
            out["step"] = stats["counterStep"].clone();
            out["rollover"] = stats["rolloverDetected"].clone();
            out["looping"] = if stats["isLoopingCounter"] == true {
                serde_json::json!({
                    "min": stats["loopingRange"]["min"],
                    "max": stats["loopingRange"]["max"],
                    "modulo": stats["loopingModulo"],
                })
            } else {
                Value::Null
            };
        }
        "sensor" => {
            out["trend"] = stats["sensorTrend"].clone();
            out["strength"] = stats["trendStrength"].clone();
            out["rollover"] = stats["rolloverDetected"].clone();
        }
        _ => {}
    }
    out
}

/// One column against a TypeScript `ByteStats`.
fn compare_column(diffs: &mut Diffs, path: &str, lib: Option<&ByteColumn>, ts: &Value) {
    let Some(lib) = lib else {
        diffs.check(path, "missing", &Value::from("present"));
        return;
    };
    diffs.check(format!("{path}.min"), lib.stats.min, &ts["min"]);
    diffs.check(format!("{path}.max"), lib.stats.max, &ts["max"]);
    diffs.check(
        format!("{path}.distinct"),
        lib.stats.distinct_values,
        &ts["uniqueValues"].as_array().unwrap().len().into(),
    );
    let (lib, ts) = (serde_json::to_value(&lib.role).unwrap(), ts_role(ts));
    for key in ts.as_object().unwrap().keys() {
        diffs.check(format!("{path}.{key}"), lib[key].clone(), &ts[key]);
    }
}

fn compare_columns(diffs: &mut Diffs, prefix: &str, lib: &[ByteColumn], ts: &Value) {
    for stats in ts.as_array().unwrap() {
        let index = stats["byteIndex"].as_u64().unwrap() as i32;
        let column = lib.iter().find(|c| c.stats.position == index);
        compare_column(diffs, &format!("{prefix}[{index}]"), column, stats);
    }
}

fn ts_pattern(ts: &Value) -> Value {
    let flag = |key: &str| ts.get(key).cloned().unwrap_or(false.into());
    let range = match (ts.get("minValue"), ts.get("maxValue")) {
        (Some(min), Some(max)) => serde_json::json!([min, max]),
        _ => Value::Null,
    };
    serde_json::json!({
        "start": ts["startByte"],
        "len": ts["length"],
        "kind": ts["pattern"],
        "endianness": ts.get("endianness").cloned().unwrap_or(Value::Null),
        "rollover": flag("rolloverDetected"),
        "correlatedRollover": flag("correlatedRollover"),
        "slowUpperBytes": flag("slowUpperBytes"),
        "range": range,
        "sampleText": ts.get("sampleText").cloned().unwrap_or(Value::Null),
    })
}

fn compare_patterns(diffs: &mut Diffs, prefix: &str, lib: &[MultiBytePattern], ts: &Value) {
    let ts = ts.as_array().unwrap();
    diffs.check(format!("{prefix}.count"), lib.len(), &ts.len().into());
    for (i, (lib, ts)) in lib.iter().zip(ts).enumerate() {
        let (lib, ts) = (serde_json::to_value(lib).unwrap(), ts_pattern(ts));
        for key in ts.as_object().unwrap().keys() {
            diffs.check(format!("{prefix}[{i}].{key}"), lib[key].clone(), &ts[key]);
        }
    }
}

fn compare_can(diffs: &mut Diffs, payloads: &[Vec<u8>], expected: &Value) {
    let ts = &expected["ts"]["analysis"];
    let profile = profile_bytes(payloads);

    diffs.check("sampleCount", profile.sample_count, &ts["sampleCount"]);
    diffs.check(
        "analysedFrom",
        profile.analysed_from,
        &ts["analyzedFromByte"],
    );
    if payloads.is_empty() {
        return;
    }
    diffs.check(
        "varyingLength",
        profile.min_len != profile.max_len,
        &ts["hasVaryingLength"],
    );
    if let Some(range) = ts.get("lengthRange") {
        diffs.check("minLen", profile.min_len, &range["min"]);
        diffs.check("maxLen", profile.max_len, &range["max"]);
    }
    diffs.check("identical", profile.identical.is_some(), &ts["isIdentical"]);
    if let Some(bytes) = ts.get("identicalPayload") {
        diffs.check(
            "identicalPayload",
            serde_json::to_value(&profile.identical).unwrap(),
            bytes,
        );
    }

    let ts_columns = ts["byteStats"].as_array().unwrap();
    diffs.check(
        "columns.count",
        profile.columns.len(),
        &ts_columns.len().into(),
    );
    compare_columns(diffs, "columns", &profile.columns, &ts["byteStats"]);
    compare_patterns(
        diffs,
        "patterns",
        &profile.patterns,
        &ts["multiBytePatterns"],
    );
    diffs.check(
        "endianness",
        serde_json::to_value(profile.endianness).unwrap(),
        ts.get("inferredEndianness").unwrap_or(&Value::Null),
    );

    compare_mux(diffs, payloads, &expected["ts"]["mux"]);
    diffs.check("muxFrame", profile.mux.is_some(), &ts["isMuxFrame"]);
    if let (Some(mux), Some(ts_cases)) = (&profile.mux, ts["muxCaseAnalyses"].as_array()) {
        diffs.check("mux.cases.count", mux.cases.len(), &ts_cases.len().into());
        for (i, (case, ts_case)) in mux.cases.iter().zip(ts_cases).enumerate() {
            diffs.check(
                format!("mux.cases[{i}].value"),
                case.value,
                &ts_case["muxValue"],
            );
            diffs.check(
                format!("mux.cases[{i}].sampleCount"),
                case.sample_count,
                &ts_case["sampleCount"],
            );
            compare_columns(
                diffs,
                &format!("mux.cases[{i}].columns"),
                &case.columns,
                &ts_case["byteStats"],
            );
            compare_patterns(
                diffs,
                &format!("mux.cases[{i}].patterns"),
                &case.patterns,
                &ts_case["multiBytePatterns"],
            );
        }
    }

    for column in &profile.columns {
        let index = column.stats.position;
        let rust = expected["rust"]["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["index"] == index);
        let Some(rust) = rust else {
            diffs.check(format!("rust.bytes[{index}]"), "present", &Value::Null);
            continue;
        };
        let path = format!("rust.bytes[{index}]");
        diffs.check(
            format!("{path}.distinct"),
            column.stats.distinct_values,
            &rust["distinct"],
        );
        diffs.check(format!("{path}.min"), column.stats.min, &rust["min"]);
        diffs.check(format!("{path}.max"), column.stats.max, &rust["max"]);
        diffs.check(
            format!("{path}.changes"),
            column.stats.changes,
            &rust["changes"],
        );
    }
}

fn compare_mux(diffs: &mut Diffs, payloads: &[Vec<u8>], ts: &Value) {
    let detection = detect_mux(payloads);
    diffs.check("mux.detected", detection.is_some(), &(!ts.is_null()).into());
    let Some(detection) = detection.filter(|_| !ts.is_null()) else {
        return;
    };
    let two_byte = detection.selector == MuxSelector::TwoByte;
    diffs.check("mux.isTwoByte", two_byte, &ts["isTwoByte"]);
    diffs.check(
        "mux.selectorByte",
        if two_byte { -1 } else { 0 },
        &ts["selectorByte"],
    );
    diffs.check(
        "mux.selectorValues",
        detection.occurrences.keys().copied().collect::<Vec<_>>(),
        &ts["selectorValues"],
    );
    diffs.check(
        "mux.occurrences",
        serde_json::to_value(&detection.occurrences).unwrap(),
        &ts["occurrencesPerValue"],
    );
}

/// The TypeScript's English for a reason code, which the desktop renders.
fn ts_note(reason: &Value, len: u8) -> String {
    let wide = len == 2;
    let count = &reason["count"];
    match reason["code"].as_str().unwrap() {
        "protocolMarkers" => "Contains common protocol markers (0xFB-0xFE)".into(),
        "commandIds" => "Contains small sequential values (likely command IDs)".into(),
        "typeSubtype" => format!(
            "First byte has only {} values (type + subtype pattern)",
            reason["firstByteValues"]
        ),
        "deviceCount" if wide => format!("{count} unique 16-bit addresses (strong pattern)"),
        "deviceCount" => format!("{count} unique addresses (typical device count)"),
        "addressCount" if wide => format!("{count} unique 16-bit addresses"),
        "addressCount" => format!("{count} unique addresses"),
        "twelveBitRange" => "12-bit address range".into(),
        "evenDistribution" if wide => "Even distribution".into(),
        "evenDistribution" => "Even distribution across addresses".into(),
        "smallAddresses" => "Small address values (0x00-0x20)".into(),
        "noZeroAddress" if wide => "No zero address".into(),
        "noZeroAddress" => "No zero address (typical for device IDs)".into(),
        code => panic!("no note for {code}"),
    }
}

fn compare_candidates(diffs: &mut Diffs, prefix: &str, lib: &[FieldCandidate], ts: &Value) {
    let ts = ts.as_array().unwrap();
    diffs.check(format!("{prefix}.count"), lib.len(), &ts.len().into());
    for (i, (lib, ts)) in lib.iter().zip(ts).enumerate() {
        let path = format!("{prefix}[{i}]");
        diffs.check(format!("{path}.start"), lib.start, &ts["startByte"]);
        diffs.check(format!("{path}.len"), lib.len, &ts["length"]);
        diffs.check(
            format!("{path}.values"),
            lib.values.clone(),
            &ts["uniqueValues"],
        );
        diffs.check(
            format!("{path}.sampleCount"),
            lib.sample_count,
            &ts["sampleCount"],
        );
        diffs.check(
            format!("{path}.confidence"),
            lib.confidence,
            &ts["confidence"],
        );
        let notes: Vec<String> = serde_json::to_value(&lib.reasons)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|reason| ts_note(reason, lib.len))
            .collect();
        diffs.check(format!("{path}.reasons"), notes, &ts["notes"]);
    }
}

fn compare_serial(diffs: &mut Diffs, frames: &[Vec<u8>], expected: &Value) {
    let ts = &expected["ts"]["structure"];
    let structure = serial_structure(frames);
    diffs.check("sampleCount", structure.sample_count, &ts["frameCount"]);
    diffs.check("minLen", structure.min_len, &ts["minLength"]);
    diffs.check("maxLen", structure.max_len, &ts["maxLength"]);
    compare_candidates(diffs, "ids", &structure.ids, &ts["candidateIdGroups"]);
    compare_candidates(
        diffs,
        "sources",
        &structure.sources,
        &ts["candidateSourceAddresses"],
    );
    diffs.check("rust", Value::Null, &expected["rust"]);
}

fn payloads(case: &Value) -> Vec<Vec<u8>> {
    serde_json::from_value(case["payloads"].clone()).unwrap()
}

#[test]
fn byte_roles_match_the_desktop() {
    let Some(expected) = read("expected.json") else {
        eprintln!(
            "skipped: tests/fixtures/byte_roles/expected.json is absent; \
             the desktop writes it from its TypeScript"
        );
        return;
    };
    let cases = read("cases.json").unwrap();
    let (cases, expected) = (cases.as_array().unwrap(), expected.as_array().unwrap());
    assert_eq!(cases.len(), expected.len());

    let mut unexpected = Vec::new();
    let mut used = BTreeSet::new();
    for (case, expected) in cases.iter().zip(expected) {
        let name = case["name"].as_str().unwrap();
        assert_eq!(expected["name"], name);
        let mut diffs = Diffs(Vec::new());
        match case["kind"].as_str().unwrap() {
            "can" => compare_can(&mut diffs, &payloads(case), expected),
            "serial" => compare_serial(&mut diffs, &payloads(case), expected),
            kind => panic!("{name}: unknown kind {kind}"),
        }

        for (path, detail) in diffs.0 {
            match ALLOWED
                .iter()
                .position(|(c, _, prefix)| *c == name && path.starts_with(prefix))
            {
                Some(i) => {
                    used.insert(i);
                }
                None => unexpected.push(format!("{name}: {path}: {detail}")),
            }
        }
    }

    let unused: Vec<_> = ALLOWED
        .iter()
        .enumerate()
        .filter(|(i, _)| !used.contains(i))
        .map(|(_, a)| a)
        .collect();
    assert!(
        unexpected.is_empty() && unused.is_empty(),
        "unexpected differences:\n{}\nallowances no longer needed: {unused:?}",
        unexpected.join("\n")
    );
}
