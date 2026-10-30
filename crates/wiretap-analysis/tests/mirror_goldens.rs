//! Mirror groups against the desktop's TypeScript, case by case, from
//! `fixtures/analysis/mirrorFrames.json`. Where the lib differs, the expected
//! value is replaced below and the reason named by the plan's decision (D#) or the
//! facts note's item (facts #).

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{json, Value};
use wiretap_analysis::{mirror_groups, FrameKey, TimedPayload, DEFAULT_MIRROR_WINDOW_US};

fn cases() -> Vec<Value> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/analysis/mirrorFrames.json");
    let text = std::fs::read_to_string(path).unwrap();
    let fixture: Value = serde_json::from_str(&text).unwrap();
    fixture["cases"].as_array().unwrap().clone()
}

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn streams(input: &Value) -> BTreeMap<FrameKey, Vec<TimedPayload>> {
    input["framePayloads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let payloads = s["payloads"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| TimedPayload {
                    timestamp_us: p["timestamp"].as_u64().unwrap(),
                    payload: bytes(&p["payload"]),
                })
                .collect();
            (
                FrameKey::new(s["frameId"].as_u64().unwrap() as u32, false),
                payloads,
            )
        })
        .collect()
}

/// (case, the lib's groups in the TypeScript's shape, why).
fn deviations() -> Vec<(&'static str, Value, &'static str)> {
    vec![
        (
            "70 % is not a mirror, 80 % is",
            json!([{ "frameIds": [48, 49], "sampleCount": 10, "matchPercentage": 80, "samplePayload": [48, 0] }]),
            "D8, facts 7: sampleCount is the 10 paired samples, not the 8 matched",
        ),
        (
            "a fast mirror of a slow frame, default window",
            json!([{ "frameIds": [96, 97], "sampleCount": 5, "matchPercentage": 100, "samplePayload": [0] }]),
            "D8, facts 7: each 0x060 sample has an equal 0x061 within 50 ms",
        ),
        (
            "constant payloads pair every sample in the window",
            json!([]),
            "D8, facts 7: ids whose payload never changes are left out",
        ),
    ]
}

#[test]
fn mirror_groups_match_the_typescript_but_for_named_deviations() {
    let deviations = deviations();
    let cases = cases();
    for (name, _, _) in &deviations {
        assert!(cases.iter().any(|c| c["name"] == *name), "no case {name}");
    }
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let input = &case["input"];
        let window = input["toleranceUs"]
            .as_u64()
            .unwrap_or(DEFAULT_MIRROR_WINDOW_US);
        let lib: Value = mirror_groups(&streams(input), window)
            .iter()
            .map(|g| {
                json!({
                    "frameIds": g.keys.iter().map(|k| k.frame_id).collect::<Vec<_>>(),
                    "sampleCount": g.sample_count,
                    "matchPercentage": g.match_percentage,
                    "samplePayload": g.sample_payload,
                })
            })
            .collect();
        let expected = deviations
            .iter()
            .find(|d| d.0 == name)
            .map_or(&case["expected"], |d| &d.1);
        assert_eq!(&lib, expected, "{name}");
    }
}
