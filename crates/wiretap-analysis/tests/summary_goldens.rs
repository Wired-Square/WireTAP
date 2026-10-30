//! The report summaries against the desktop's Payload Changes and Frame Order
//! goldens in `fixtures/desktop/`, every format. Each golden's summary block
//! and section counts are read back as numbers and compared with the lib's
//! counts over the same input: Payload Changes over `analysis/byteNotes.json`'s
//! profiles, ids renumbered from 0x100 as the desktop's fixture does, and Frame
//! Order over `frameOrder.input.json`. The rows and wording are the desktop's.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use serde_json::{json, Value};
use wiretap_analysis::order::{CyclePattern, MultiBusFrame};
use wiretap_analysis::{
    changes_counts, order_totals, BusOrder, ByteProfile, FrameKey, MirrorGroup, MuxAnalysis,
    MuxDetection, MuxSelector, OrderAnalysis,
};

fn read(path: &str) -> String {
    std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(path),
    )
    .unwrap()
}

fn json_file(path: &str) -> Value {
    serde_json::from_str(&read(path)).unwrap()
}

const FORMATS: [&str; 4] = ["txt", "md", "screen.html", "print.html"];

/// The golden's summary block, by label: text `  Label: value` lines, the
/// markdown overview table, or the HTML summary cards.
fn summary_block(text: &str, format: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut started = false;
    for line in text.lines() {
        let pair = match format {
            "txt" => {
                if line == "SUMMARY" {
                    started = true;
                    continue;
                }
                if started && line.starts_with(|c: char| c != ' ' && c != '─') {
                    break;
                }
                line.strip_prefix("  ").and_then(|l| l.split_once(':'))
            }
            "md" => {
                let cells: Vec<&str> = line.split('|').map(str::trim).collect();
                (cells.len() == 4 && !cells[1].starts_with('-') && cells[1] != "Metric")
                    .then(|| (cells[1], cells[2]))
            }
            _ => line
                .split_once("<div class=\"value\">")
                .and_then(|(_, rest)| rest.split_once("</div><div class=\"label\">"))
                .map(|(value, rest)| (rest.split('<').next().unwrap(), value)),
        };
        if let Some((label, value)) = pair.filter(|_| started || format != "txt") {
            out.insert(label.trim().into(), value.trim().into());
        }
        if format == "md" && line.starts_with("## ") && !out.is_empty() {
            break;
        }
    }
    out
}

fn number(text: &str) -> Value {
    json!(text.replace(',', "").parse::<u64>().unwrap())
}

/// The golden's figures under the lib's names.
fn figures(block: &BTreeMap<String, String>, names: &[(&str, &str)]) -> Value {
    let mut out = serde_json::Map::new();
    for (label, value) in block {
        let name = names
            .iter()
            .find(|(l, _)| l == label)
            .unwrap_or_else(|| panic!("unmapped {label}"))
            .1;
        if !name.is_empty() {
            out.insert(name.into(), number(value));
        }
    }
    Value::Object(out)
}

fn key(v: &Value) -> FrameKey {
    FrameKey::new(
        v["frameId"].as_u64().unwrap() as u32,
        v["isExtended"].as_bool().unwrap(),
    )
}

/// The fields the counts read; the rest of the profile is the notes' concern.
fn profile(p: &Value) -> ByteProfile {
    let len = |k: &str| p[k].as_u64().unwrap() as usize;
    ByteProfile {
        sample_count: len("sampleCount"),
        min_len: len("minLen"),
        max_len: len("maxLen"),
        identical: p["identical"]
            .as_array()
            .map(|b| b.iter().map(|x| x.as_u64().unwrap() as u8).collect()),
        analysed_from: 0,
        columns: vec![],
        patterns: vec![],
        endianness: None,
        mux: (!p["mux"].is_null()).then(|| MuxAnalysis {
            detection: MuxDetection {
                selector: MuxSelector::OneByte,
                occurrences: BTreeMap::new(),
            },
            cases: vec![],
        }),
    }
}

fn group(
    keys: [FrameKey; 2],
    sample_count: usize,
    match_percentage: u8,
    sample: &[u8],
) -> MirrorGroup {
    MirrorGroup {
        keys: keys.to_vec(),
        sample_count,
        match_percentage,
        sample_payload: sample.to_vec(),
    }
}

#[test]
fn payload_changes_counts_are_the_reports_summary() {
    let cases = json_file("analysis/byteNotes.json")["cases"]
        .as_array()
        .unwrap()
        .clone();
    let inputs: Vec<(String, FrameKey, ByteProfile, bool)> = cases
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let p = &c["input"]["profile"];
            let protocol = p["protocol"].as_str().unwrap_or("can").to_string();
            let key = FrameKey::new(0x100 + i as u32, p["isExtended"].as_bool().unwrap());
            (
                protocol,
                key,
                profile(p),
                c["input"]["isBurstFrame"].as_bool().unwrap(),
            )
        })
        .collect();
    let bursts: HashSet<(&str, FrameKey)> = inputs
        .iter()
        .filter(|i| i.3)
        .map(|(p, k, ..)| (p.as_str(), *k))
        .collect();
    let can = [group(
        [FrameKey::new(0x100, false), FrameKey::new(0x18FF0010, true)],
        45,
        98,
        &[0, 0x1F, 0xAB, 0xFF],
    )];
    let modbus = [group(
        [FrameKey::new(0x103, false), FrameKey::new(0x203, false)],
        3,
        100,
        &[1],
    )];

    let counts = changes_counts(
        inputs
            .iter()
            .map(|(p, k, profile, _)| (p.as_str(), *k, profile)),
        &bursts,
        [&can[..], &modbus[..]],
    );
    let lib = serde_json::to_value(counts).unwrap();

    // "Unique Frame IDs" is the frame count (facts 13): one per protocol and key.
    // "Total Frames" is the frames the caller read, not a count over profiles.
    let names = [
        ("Total Frames Analysed", ""),
        ("Total Frames", ""),
        ("Unique Frame IDs", "frames"),
        ("Unique IDs", "frames"),
        ("Mirror Groups", "mirrorGroups"),
        ("Identical Frames", "identical"),
        ("Identical Payload Frames", "identical"),
        ("Varying Length", "varyingLength"),
        ("Variable Length Frames", "varyingLength"),
        ("Multiplexed", "mux"),
        ("Multiplexed Frames", "mux"),
        ("Burst Frames", "burst"),
        ("Burst Pattern Frames", "burst"),
    ];
    for format in FORMATS {
        let golden = read(&format!("desktop/payloadChanges.{format}"));
        let ts = figures(&summary_block(&golden, format), &names);
        let ts = ts.as_object().unwrap();
        assert!(ts.len() >= 3, "{format}: {ts:?}");
        for (name, value) in ts {
            assert_eq!(&lib[name], value, "{format} {name}");
        }
    }
    assert_eq!(
        lib,
        json!({ "frames": 11, "identical": 1, "varyingLength": 1, "mux": 3, "burst": 2, "mirrorGroups": 2 })
    );
}

fn order(v: &Value) -> OrderAnalysis {
    let count = |v: &Value, k: &str| v[k].as_u64().unwrap() as usize;
    OrderAnalysis {
        total_frames: count(v, "totalFrames"),
        unique_keys: count(v, "uniqueKeys"),
        time_span_ms: v["timeSpanMs"].as_f64().unwrap(),
        buses: v["buses"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| BusOrder {
                bus: b["bus"].as_u64().unwrap() as u8,
                frame_count: count(b, "frameCount"),
                patterns: b["patterns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| CyclePattern {
                        start: key(&p["start"]),
                        sequence: p["sequence"].as_array().unwrap().iter().map(key).collect(),
                        occurrences: count(p, "occurrences"),
                        confidence: p["confidence"].as_f64().unwrap(),
                        cycle_ms: p["cycleMs"].as_f64(),
                    })
                    .collect(),
                interval_groups: vec![],
                start_candidates: vec![],
                mux: vec![],
                bursts: vec![],
            })
            .collect(),
        multi_bus: v["multiBus"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| MultiBusFrame {
                key: key(m),
                frames_per_bus: BTreeMap::new(),
            })
            .collect(),
    }
}

/// The desktop's `formatMs`, to read the golden's time span back against.
fn format_ms(ms: f64) -> String {
    if ms >= 1000.0 {
        format!("{:.1}s", ms / 1000.0)
    } else {
        format!("{ms:.1}ms")
    }
}

/// Each `Protocol · Bus n (N frames)` section heading, as `[protocol, bus, frames]`.
fn sections(text: &str) -> Value {
    let heads: Vec<Value> = text
        .lines()
        .filter_map(|line| {
            let line = line
                .trim()
                .trim_start_matches("## ")
                .trim_start_matches("<h2>");
            let (protocol, rest) = line.split_once(" · ")?;
            let (bus, rest) = rest.split_once(" (")?;
            let frames = rest.split_once(" frames)")?.0;
            let bus = bus.rsplit(' ').next()?.parse::<u64>().ok()?;
            Some(json!([
                protocol.to_lowercase().replace(' ', "_"),
                bus,
                number(frames)
            ]))
        })
        .collect();
    json!(heads)
}

#[test]
fn frame_order_totals_are_the_reports_summary() {
    let input = json_file("desktop/frameOrder.input.json");
    let orders: Vec<(String, OrderAnalysis)> = input["orders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            (
                o["protocol"].as_str().unwrap().to_string(),
                order(&o["order"]),
            )
        })
        .collect();
    let totals = order_totals(orders.iter().map(|(p, o)| (p.as_str(), o)));

    let buses: Vec<Value> = totals
        .protocols
        .iter()
        .flat_map(|p| p.buses.iter().map(|b| json!([p.protocol, b.bus, b.frames])))
        .collect();
    let mut lib = serde_json::to_value(&totals).unwrap();
    lib["buses"] = json!(buses.len());

    let names = [
        ("Total Frames Analysed", "frames"),
        ("Total Frames", "frames"),
        ("Unique Frame IDs", "uniqueKeys"),
        ("Unique IDs", "uniqueKeys"),
        ("Detected Patterns", "patterns"),
        ("Multi-Bus Frames", "multiBusFrames"),
        ("Buses", "buses"),
        ("Time Span", ""),
    ];
    for format in FORMATS {
        let golden = read(&format!("desktop/frameOrder.{format}"));
        let block = summary_block(&golden, format);
        assert_eq!(
            block["Time Span"],
            format_ms(totals.time_span_ms),
            "{format}"
        );
        let ts = figures(&block, &names);
        let ts = ts.as_object().unwrap();
        assert!(ts.len() >= 2, "{format}: {ts:?}");
        for (name, value) in ts {
            assert_eq!(&lib[name], value, "{format} {name}");
        }
        assert_eq!(sections(&golden), json!(buses), "{format}");
    }
    assert_eq!(
        (
            totals.frames,
            totals.unique_keys,
            totals.time_span_ms,
            totals.patterns,
            totals.multi_bus_frames
        ),
        (12397, 23, 61234.5, 3, 1)
    );
}
