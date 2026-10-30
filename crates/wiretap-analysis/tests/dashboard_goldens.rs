//! The Dashboard counters against the desktop's goldens in `fixtures/desktop/`
//! (WireTAP `ebab8d9d`): `dashboardHistogram.json` from `computeHistogram`, and
//! `bitToggles.json`, the `toggles` of `adhoc/ts-golden.json` that `BitToggles`
//! was pinned to before it moved here. [`expected`] names where the histogram differs.

use std::path::PathBuf;

use serde_json::{json, Value};
use wiretap_analysis::dashboard::{histogram, BitToggles};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/desktop")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// What the kernel answers, or `None` where the bin count is not a `usize`. Skipping
/// non-finite values changes the NaN and Infinity cases (H4). The golden's last
/// "Float steps" centre is `0.95`, but `computeHistogram` itself gives
/// `0.9500000000000001` under node, as here.
fn expected(case: &Value) -> Option<Value> {
    Some(match case["name"].as_str().unwrap() {
        "Negative bins" | "A fractional bin count throws" => return None,
        "A NaN value throws (its bin index is NaN)" => json!([
            { "min": 1.0, "max": 2.0, "centre": 1.5, "count": 1 },
            { "min": 2.0, "max": 3.0, "centre": 2.5, "count": 1 },
        ]),
        "Infinity gives no bins" => json!([{ "min": 1.0, "max": 2.0, "centre": 1.0, "count": 1 }]),
        "Float steps: 0.1 widths" => {
            let mut bins = case["expected"].clone();
            bins[9]["centre"] = json!(9.5 * 0.1);
            bins
        }
        _ => case["expected"].clone(),
    })
}

#[test]
fn the_histogram_matches_the_golden_but_for_skipping_non_finite_values() {
    let golden = fixture("dashboardHistogram.json");
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 12);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let Some(expected) = expected(case) else {
            continue;
        };
        let values: Vec<f64> = case["input"]["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().parse().unwrap())
            .collect();
        let bins = case["input"]["binCount"].as_u64().unwrap() as usize;
        let got: Vec<_> = histogram(&values, bins)
            .iter()
            .map(|b| (b.min, b.max, b.centre, b.count))
            .collect();
        let want: Vec<_> = expected
            .as_array()
            .unwrap()
            .iter()
            .map(|b| {
                let f = |k: &str| b[k].as_f64().unwrap();
                (
                    f("min"),
                    f("max"),
                    f("centre"),
                    b["count"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn one_distinct_value_counts_only_its_finite_samples() {
    let bins = histogram(&[4.0, f64::NAN, 4.0], 10);
    assert_eq!(bins.len(), 1);
    assert_eq!(bins[0].count, 2);
}

#[test]
fn toggle_counts_match_the_golden() {
    for case in fixture("bitToggles.json")["cases"].as_array().unwrap() {
        let mut toggles = BitToggles::default();
        for bytes in case["sequence"].as_array().unwrap() {
            toggles.record(&serde_json::from_value::<Vec<u8>>(bytes.clone()).unwrap());
        }
        let mut counts = toggles.counts.clone();
        counts.resize(64, 0);
        assert_eq!(json!(counts), case["counts"]);
        assert_eq!(json!(toggles.frames), case["totalFrames"]);
    }
}

#[test]
fn toggles_cover_a_whole_fd_payload() {
    let mut toggles = BitToggles::default();
    toggles.record(&[0; 64]);
    let mut changed = [0; 64];
    changed[63] = 0x80;
    toggles.record(&changed);
    assert_eq!(toggles.counts.len(), 512);
    assert_eq!(toggles.counts[511], 1);
    assert_eq!(toggles.counts.iter().sum::<u32>(), 1);
}

#[test]
fn toggles_serialise_without_the_baseline() {
    let mut toggles = BitToggles::default();
    toggles.record(&[1]);
    assert_eq!(
        serde_json::to_value(&toggles).unwrap(),
        json!({ "counts": [0, 0, 0, 0, 0, 0, 0, 0], "frames": 1 })
    );
}
