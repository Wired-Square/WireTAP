//! Hypothesis ranking against the desktop's TypeScript, over the profiles of the
//! `byte_roles` cases; `expected.json` came from the TypeScript with the B3 fixes applied.

use std::path::PathBuf;

use serde_json::Value;
use wiretap_analysis::hypothesis::{rank_fields, Candidate, Sweep};
use wiretap_analysis::profile_bytes;
use wslib_bits::{Endianness, PayloadField};

fn read(path: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(path);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Equal, with numbers within `1e-9`: entropy is summed in hash order.
fn close(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            (x.as_f64().unwrap() - y.as_f64().unwrap()).abs() < 1e-9
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| close(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| close(v, w)))
        }
        _ => a == b,
    }
}

fn sweep(ts: &Value) -> Sweep {
    let u32_of = |v: &Value| v.as_u64().unwrap() as u32;
    Sweep {
        start_bits: u32_of(&ts["startBitMin"])..=u32_of(&ts["startBitMax"]),
        bit_step: u32_of(&ts["bitStep"]),
        bit_lengths: ts["bitLengths"]
            .as_array()
            .unwrap()
            .iter()
            .map(u32_of)
            .collect(),
        endiannesses: serde_json::from_value(ts["endiannesses"].clone()).unwrap(),
        signed: ts["signed"].as_bool().unwrap(),
    }
}

/// The TypeScript's reason string; it gives the endianness points no words.
fn ts_reason(candidate: &Candidate) -> String {
    let words: Vec<String> = serde_json::to_value(&candidate.reasons)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|reason| match reason["code"].as_str().unwrap() {
            "role" => Some(format!("{} byte", reason["role"].as_str().unwrap())),
            "pattern" => Some(reason["kind"].as_str().unwrap().into()),
            "highVariance" => Some("high variance".into()),
            "strongTrend" => Some("strong trend".into()),
            "noProfile" => Some("no analysis data".into()),
            _ => None,
        })
        .collect();
    if words.is_empty() {
        "low interest".into()
    } else {
        words.join(", ")
    }
}

fn as_ts(candidate: &Candidate) -> Value {
    let mut ts = serde_json::to_value(candidate.field).unwrap();
    ts["score"] = candidate.score.into();
    ts["reason"] = ts_reason(candidate).into();
    ts
}

#[test]
fn ranking_matches_the_desktop() {
    let inputs = read("hypothesis/inputs.json");
    let byte_roles = read("byte_roles/cases.json");
    let expected = read("hypothesis/expected.json");
    let sweeps = inputs["sweeps"].as_array().unwrap();
    let mut expected = expected.as_array().unwrap().iter();

    for case in inputs["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let payload_len = case["payloadLen"].as_u64().unwrap() as usize;
        let profile = (!case["profile"].is_null()).then(|| {
            let source = byte_roles
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"] == name)
                .unwrap();
            let payloads: Vec<Vec<u8>> =
                serde_json::from_value(source["payloads"].clone()).unwrap();
            let profile = profile_bytes(&payloads);
            assert!(
                close(&serde_json::to_value(&profile).unwrap(), &case["profile"]),
                "{name}: the profile the fixture was made from has changed"
            );
            assert_eq!(profile.max_len, payload_len, "{name}");
            profile
        });

        for ts_sweep in sweeps {
            let ts = expected.next().unwrap();
            assert_eq!(
                (&ts["case"], &ts["sweep"]),
                (&case["name"], &ts_sweep["name"])
            );
            let lib: Vec<Value> = rank_fields(&sweep(ts_sweep), profile.as_ref(), payload_len)
                .iter()
                .map(as_ts)
                .collect();
            assert_eq!(
                Value::from(lib),
                ts["candidates"],
                "{name}, sweep {}",
                ts_sweep["name"]
            );
        }
    }
    assert!(expected.next().is_none());
}

#[test]
fn bit_step_one_stays_inside_a_64_byte_payload() {
    let sweep = Sweep {
        start_bits: 0..=600,
        bit_step: 1,
        bit_lengths: vec![1, 8, 12, 16, 32, 64],
        endiannesses: vec![Endianness::Little, Endianness::Big],
        signed: false,
    };
    let candidates = rank_fields(&sweep, None, 64);
    assert!(candidates
        .iter()
        .all(|c| c.field.start_bit + c.field.bit_length <= 512));
    let last_64 = PayloadField {
        start_bit: 448,
        bit_length: 64,
        endianness: Endianness::Big,
        signed: false,
    };
    assert!(candidates.iter().any(|c| c.field == last_64));
}

#[test]
fn eight_bit_orders_are_deduplicated_only_on_byte_boundaries() {
    let sweep = Sweep {
        start_bits: 0..=8,
        bit_step: 1,
        bit_lengths: vec![8],
        endiannesses: vec![Endianness::Little, Endianness::Big],
        signed: false,
    };
    let starts = |order| -> Vec<u32> {
        let mut starts: Vec<u32> = rank_fields(&sweep, None, 2)
            .iter()
            .filter(|c| c.field.endianness == order)
            .map(|c| c.field.start_bit)
            .collect();
        starts.sort();
        starts
    };
    assert_eq!(starts(Endianness::Little), (0..=8).collect::<Vec<_>>());
    assert_eq!(starts(Endianness::Big), (1..=7).collect::<Vec<_>>());

    let big_only = Sweep {
        endiannesses: vec![Endianness::Big],
        ..sweep
    };
    assert_eq!(rank_fields(&big_only, None, 2).len(), 9);
}
