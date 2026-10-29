//! Message order against the desktop's TypeScript, case by case, from
//! `fixtures/analysis/messageOrder.json`. The lib's result is put back into the
//! TypeScript's shape; where it differs, the expected value is replaced below and
//! the reason named by the plan's decision (D#) or the facts note's item (facts #).

use std::path::PathBuf;

use serde_json::{json, Value};
use wiretap_analysis::order::BurstFlag;
use wiretap_analysis::{analyse_order, BusOrder, FrameKey, MuxSelector, OrderAnalysis, TimedFrame};

fn cases() -> Vec<Value> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/analysis/messageOrder.json");
    let text = std::fs::read_to_string(path).unwrap();
    let fixture: Value = serde_json::from_str(&text).unwrap();
    fixture["cases"].as_array().unwrap().clone()
}

fn frames(input: &Value) -> Vec<TimedFrame> {
    input["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| TimedFrame {
            bus: f["bus"].as_u64().unwrap_or(0) as u8,
            key: FrameKey::new(
                f["frame_id"].as_u64().unwrap() as u32,
                f["is_extended"].as_bool().unwrap(),
            ),
            timestamp_us: f["timestamp_us"].as_u64().unwrap(),
            payload: f["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect(),
        })
        .collect()
}

fn analyse(case: &Value) -> OrderAnalysis {
    let input = &case["input"];
    let start = input["options"]["startMessageId"]
        .as_u64()
        .map(|id| FrameKey::new(id as u32, false));
    analyse_order(&frames(input), start)
}

fn ids(keys: &[FrameKey]) -> Value {
    keys.iter().map(|k| k.frame_id).collect()
}

fn flag(flag: &BurstFlag) -> &'static str {
    match flag {
        BurstFlag::VariableLength => "variable-dlc",
        BurstFlag::BurstPattern => "burst-pattern",
        BurstFlag::RequestResponse => "request-response",
    }
}

/// One bus in the TypeScript's shape, with the capture-wide counts beside it.
fn ts_shape(analysis: &OrderAnalysis, bus: Option<&BusOrder>) -> Value {
    let empty = BusOrder {
        bus: 0,
        frame_count: 0,
        patterns: vec![],
        interval_groups: vec![],
        start_candidates: vec![],
        mux: vec![],
        bursts: vec![],
    };
    let bus = bus.unwrap_or(&empty);
    json!({
        "patterns": bus.patterns.iter().map(|p| json!({
            "startId": p.start.frame_id,
            "sequence": ids(&p.sequence),
            "occurrences": p.occurrences,
            "confidence": p.confidence,
            "avgCycleTimeMs": p.cycle_ms,
        })).collect::<Vec<_>>(),
        "intervalGroups": bus.interval_groups.iter().map(|g| json!({
            "intervalMs": g.interval_ms,
            "tolerance": g.tolerance_ms,
            "frameIds": ids(&g.keys),
        })).collect::<Vec<_>>(),
        "startIdCandidates": bus.start_candidates.iter().map(|c| json!({
            "id": c.key.frame_id,
            "maxGapBeforeMs": c.max_gap_before_ms,
            "avgGapBeforeMs": c.avg_gap_before_ms,
            "minGapBeforeMs": c.min_gap_before_ms,
            "occurrences": c.occurrences,
        })).collect::<Vec<_>>(),
        "multiplexedFrames": bus.mux.iter().map(|m| json!({
            "frameId": m.key.frame_id,
            "selectorByte": if m.detection.selector == MuxSelector::TwoByte { -1 } else { 0 },
            "selectorValues": m.detection.occurrences.keys().collect::<Vec<_>>(),
            "occurrencesPerValue": m.detection.occurrences,
            "muxPeriodMs": m.mux_period_ms,
            "interMessageMs": m.inter_message_ms,
        })).collect::<Vec<_>>(),
        "burstFrames": bus.bursts.iter().map(|b| json!({
            "frameId": b.key.frame_id,
            "burstCount": b.frames_per_burst,
            "burstPeriodMs": b.burst_period_ms,
            "interMessageMs": b.inter_message_ms,
            "dlcVariation": b.lengths,
            "flags": b.flags.iter().map(flag).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "multiBusFrames": analysis.multi_bus.iter().map(|m| json!({
            "frameId": m.key.frame_id,
            "buses": m.frames_per_bus.keys().collect::<Vec<_>>(),
            "countPerBus": m.frames_per_bus,
        })).collect::<Vec<_>>(),
        "totalFramesAnalyzed": analysis.total_frames,
        "uniqueFrameIds": analysis.unique_keys,
        "timeSpanMs": analysis.time_span_ms,
    })
}

/// Equal, with doubles to 1e-9.
fn diffs(path: &str, lib: &Value, ts: &Value, out: &mut Vec<String>) {
    match (lib, ts) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys().filter(|k| !a.contains_key(*k))) {
                let (x, y) = (&a.get(key), &b.get(key));
                diffs(
                    &format!("{path}/{key}"),
                    x.unwrap_or(&Value::Null),
                    y.unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                diffs(&format!("{path}/{i}"), x, y, out);
            }
        }
        _ => match (lib.as_f64(), ts.as_f64()) {
            (Some(x), Some(y)) if (x - y).abs() < 1e-9 => {}
            _ if lib == ts => {}
            _ => out.push(format!("{path}: lib {lib}, expected {ts}")),
        },
    }
}

/// (case, JSON pointer into the expected value, the lib's value, why).
fn deviations() -> Vec<(&'static str, &'static str, Value, &'static str)> {
    const CYCLIC: &str = "cyclic schedule, auto start";
    const TWO_BYTE: &str =
        "two-byte mux; one-byte when byte-1 sets differ or combined keys are lopsided";
    const REJECTIONS: &str =
        "mux rejections: sparse, unbalanced, high start, RTR, too few, too many, sparse but four";
    const LEFTOVERS: &str = "periods outside every bucket, and a mux seen once per value";
    const BURSTS: &str = "bursts: request-response, variable DLC, uneven, long";
    let groups = |list: &[(f64, f64, &[u32])]| -> Value {
        list.iter()
            .map(|(interval, tolerance, ids)| {
                json!({ "intervalMs": interval, "tolerance": tolerance, "frameIds": ids })
            })
            .collect()
    };
    vec![
        ("fewer than two frames", "/totalFramesAnalyzed", json!(1),
            "D11, facts 9: a single frame is counted"),
        (CYCLIC, "/patterns/1/avgCycleTimeMs", json!(100.0),
            "D7, facts 6: 0x200's modal sequence starts every 100 ms; 36.67 ms was the mean gap to the next 0x200"),
        (TWO_BYTE, "/patterns/0/avgCycleTimeMs", json!(50.0),
            "D7: 0x720's modal sequence [0x720, 0x721, 0x71F] starts every other 0x720, at 4, 54, 104, 154 ms"),
        (REJECTIONS, "/multiplexedFrames", json!([
            { "frameId": 307, "selectorByte": 0, "selectorValues": [0, 1, 2, 3],
              "occurrencesPerValue": { "0": 2, "1": 2, "2": 2, "3": 2 },
              "muxPeriodMs": 400.0, "interMessageMs": 100.0 },
            { "frameId": 310, "selectorByte": 0, "selectorValues": [0, 2, 9, 30],
              "occurrencesPerValue": { "0": 2, "2": 2, "9": 2, "30": 2 },
              "muxPeriodMs": 400.0, "interMessageMs": 100.0 },
        ]), "D3, facts 5: roles::detect_mux skips the RTR's empty payload, so 0x133 is a mux"),
        (REJECTIONS, "/intervalGroups", groups(&[
            (100.0, 30.0, &[304, 305, 306, 308, 309]),
            (500.0, 150.0, &[307, 310]),
        ]), "D3, facts 5: 0x133 as a mux takes its 400 ms mux period"),
        (LEFTOVERS, "/intervalGroups", groups(&[
            (3.0, 3.0 * 0.3, &[320]),
            (10.0, 3.0, &[321, 336]),
            (14.0, 14.0 * 0.3, &[322]),
            (30.0, 9.0, &[323]),
            (3000.0, 900.0, &[324]),
        ]), "D5, facts 3: leftovers cluster (3, 13.5, 30, 3000 ms); D6, facts 4: 0x150 takes its 10 ms inter-message period"),
        (LEFTOVERS, "/multiplexedFrames/0/muxPeriodMs", Value::Null,
            "D6, facts 4: no case of 0x150 repeats"),
        (LEFTOVERS, "/patterns/0/avgCycleTimeMs", Value::Null,
            "D7: 0x144's modal sequence starts once"),
        (BURSTS, "/patterns/0/avgCycleTimeMs", json!(184.0),
            "D7: 0x7E1's modal sequence starts at 336 and 520 ms"),
        (BURSTS, "/patterns/1/avgCycleTimeMs", json!(200.0),
            "D7: 0x7E0's modal sequence starts at 10 and 210 ms"),
    ]
}

#[test]
fn message_order_matches_the_typescript_but_for_named_deviations() {
    let deviations = deviations();
    let cases = cases();
    for (name, ..) in &deviations {
        assert!(cases.iter().any(|c| c["name"] == *name), "no case {name}");
    }
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        if name.starts_with("multi-bus") {
            continue;
        }
        let analysis = analyse(&case);
        assert!(analysis.buses.len() <= 1, "{name}: one bus");
        let mut expected = case["expected"].clone();
        for (_, pointer, value, _) in deviations.iter().filter(|d| d.0 == name) {
            *expected
                .pointer_mut(pointer)
                .unwrap_or_else(|| panic!("{name}: no {pointer}")) = value.clone();
        }
        let mut out = Vec::new();
        diffs(
            "",
            &ts_shape(&analysis, analysis.buses.first()),
            &expected,
            &mut out,
        );
        failures.extend(out.into_iter().map(|d| format!("{name}: {d}")));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// D1, D2, facts 1 and 2: the TypeScript merged the buses, and 0x001 standard with
/// 0x001 extended, into one schedule; each bus is its own here.
#[test]
fn multi_bus_case_splits_by_bus_and_by_frame_format() {
    let case = cases()
        .into_iter()
        .find(|c| c["name"].as_str().unwrap().starts_with("multi-bus"))
        .unwrap();
    let analysis = analyse(&case);
    let std = |id| FrameKey::new(id, false);
    let ext = |id| FrameKey::new(id, true);
    let diag = ext(0x18DA_F110);

    assert_eq!((analysis.total_frames, analysis.unique_keys), (31, 5));
    assert_eq!(analysis.time_span_ms, 470.0);
    let multi: Vec<(FrameKey, Vec<(u8, usize)>)> = analysis
        .multi_bus
        .iter()
        .map(|m| (m.key, m.frames_per_bus.clone().into_iter().collect()))
        .collect();
    assert_eq!(
        multi,
        vec![
            (std(0x100), vec![(0, 5), (1, 5)]),
            (diag, vec![(0, 3), (2, 3)]),
        ]
    );

    let bus = |n: u8| analysis.buses.iter().find(|b| b.bus == n).unwrap();
    let patterns = |b: &BusOrder| -> Vec<(Vec<FrameKey>, usize, f64, Option<f64>)> {
        b.patterns
            .iter()
            .map(|p| (p.sequence.clone(), p.occurrences, p.confidence, p.cycle_ms))
            .collect()
    };
    let candidates = |b: &BusOrder| -> Vec<(FrameKey, f64, f64, f64, usize)> {
        b.start_candidates
            .iter()
            .map(|c| {
                let gaps = (
                    c.max_gap_before_ms,
                    c.avg_gap_before_ms,
                    c.min_gap_before_ms,
                );
                (c.key, gaps.0, gaps.1, gaps.2, c.occurrences)
            })
            .collect()
    };
    let groups = |b: &BusOrder| -> Vec<(f64, Vec<FrameKey>)> {
        b.interval_groups
            .iter()
            .map(|g| (g.interval_ms, g.keys.clone()))
            .collect()
    };

    let zero = bus(0);
    assert_eq!(zero.frame_count, 18);
    assert_eq!(
        patterns(zero),
        vec![
            (vec![diag, ext(1), std(0x100), std(1)], 3, 1.0, Some(100.0)),
            (vec![std(0x100), std(1), diag, ext(1)], 5, 0.6, Some(100.0)),
            (vec![ext(1), std(0x100), std(1), diag], 4, 0.5, Some(100.0)),
        ]
    );
    assert_eq!(
        candidates(zero),
        vec![
            (ext(1), 50.0, 37.4, 29.0, 5),
            (std(0x100), 30.0, 30.0, 30.0, 5),
            (diag, 21.0, 21.0, 21.0, 3),
            (std(1), 20.0, 20.0, 20.0, 5),
        ]
    );
    assert_eq!(
        groups(zero),
        vec![(100.0, vec![std(1), ext(1), std(0x100), diag])]
    );
    assert!(zero.mux.is_empty() && zero.bursts.is_empty());

    let one = bus(1);
    assert_eq!(
        patterns(one),
        vec![
            (vec![std(0x100), std(0x300)], 5, 1.0, Some(100.0)),
            (vec![std(0x300), std(0x100)], 4, 1.0, Some(100.0)),
        ]
    );
    assert_eq!(
        candidates(one),
        vec![
            (std(0x100), 99.0, 99.0, 99.0, 5),
            (std(0x300), 1.0, 1.0, 1.0, 5),
        ]
    );
    assert_eq!(groups(one), vec![(100.0, vec![std(0x100), std(0x300)])]);
    assert!(one.bursts.is_empty());

    let two = bus(2);
    assert!(two.patterns.is_empty() && two.bursts.is_empty());
    assert_eq!(candidates(two), vec![(diag, 100.0, 100.0, 100.0, 3)]);
    assert_eq!(groups(two), vec![(100.0, vec![diag])]);
}
