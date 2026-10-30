//! Drafting against the desktop's TypeScript, every case of
//! `fixtures/desktop/drafting.json` (`decoderKnowledge.ts`, the Discovery toolbox
//! and `candidateSignals`). The TypeScript keys a frame by its bare id and words
//! its notes; here a frame is its protocol and [`FrameKey`], and notes are codes.
//! Each case's expected value is translated into the lib's JSON, rules that hold
//! for every case in [`translate_frame`], and where the lib differs the
//! translation is patched below, the reason named by the plan's decision (D#) or
//! the facts note's item (facts #).

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use common::{list, pattern, profile};
use serde_json::{json, Value};
use wiretap_analysis::draft::{
    candidate_signals, default_interval, default_signals, ByteSpan, Draft, DraftSignal,
    SignalSource,
};
use wiretap_analysis::order::{BurstTiming, IntervalGroup, MultiBusFrame, MuxTiming};
use wiretap_analysis::{
    byte_notes, BusOrder, ByteNote, ByteProfile, FrameKey, MuxDetection, MuxSelector, OrderAnalysis,
};
use wslib_bits::Endianness;
use wslib_wiretap_catalogue::edit::{apply_edits, EditOp, MetaFields};
use wslib_wiretap_catalogue::model::{Catalogue, Confidence, Protocol};

fn read(path: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(path);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// JSON with every number as a float: the desktop writes `10` where the lib's
/// `f64` writes `10.0`.
fn floats(v: &impl serde::Serialize) -> Value {
    fn walk(v: Value) -> Value {
        match v {
            Value::Number(n) => json!(n.as_f64().unwrap()),
            Value::Array(a) => Value::Array(a.into_iter().map(walk).collect()),
            Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, walk(v))).collect()),
            other => other,
        }
    }
    walk(serde_json::to_value(v).unwrap())
}

/// Frame by frame, so a failure names the frame.
fn assert_frames(lib: &BTreeMap<String, Value>, ts: &BTreeMap<String, Value>, what: &str) {
    assert_eq!(
        lib.keys().collect::<Vec<_>>(),
        ts.keys().collect::<Vec<_>>(),
        "{what}"
    );
    for (frame, value) in lib {
        assert_eq!(floats(value), floats(&ts[frame]), "{what}: {frame}");
    }
}

fn uint(v: &Value) -> u32 {
    v.as_u64().unwrap() as u32
}

fn key(v: &Value) -> FrameKey {
    FrameKey::new(uint(&v["frameId"]), v["isExtended"].as_bool().unwrap())
}

fn protocol(name: &str) -> Protocol {
    match name {
        "can" => Protocol::Can,
        "serial" => Protocol::Serial,
        "modbus" | "modbus_rtu" => Protocol::Modbus,
        other => panic!("protocol {other}"),
    }
}

fn endianness(name: &str) -> Endianness {
    match name {
        "little" | "le" => Endianness::Little,
        _ => Endianness::Big,
    }
}

fn group(g: &Value) -> IntervalGroup {
    IntervalGroup {
        interval_ms: g["intervalMs"].as_f64().unwrap(),
        tolerance_ms: g["toleranceMs"].as_f64().unwrap(),
        keys: list(&g["keys"], key),
    }
}

fn selector(name: &Value) -> MuxSelector {
    if name == "twoByte" {
        MuxSelector::TwoByte
    } else {
        MuxSelector::OneByte
    }
}

fn mux_timing(m: &Value) -> MuxTiming {
    MuxTiming {
        key: key(m),
        detection: MuxDetection {
            selector: selector(&m["selector"]),
            occurrences: m["occurrences"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, n)| (k.parse().unwrap(), n.as_u64().unwrap() as usize))
                .collect(),
        },
        mux_period_ms: m["muxPeriodMs"].as_f64(),
        inter_message_ms: m["interMessageMs"].as_f64().unwrap(),
    }
}

/// The parts of message order drafting reads.
fn order(v: &Value) -> OrderAnalysis {
    OrderAnalysis {
        total_frames: 0,
        unique_keys: 0,
        time_span_ms: 0.0,
        buses: list(&v["buses"], |b| BusOrder {
            bus: uint(&b["bus"]) as u8,
            frame_count: 0,
            patterns: vec![],
            interval_groups: list(&b["intervalGroups"], group),
            start_candidates: vec![],
            mux: list(&b["mux"], mux_timing),
            bursts: list(&b["bursts"], |t| BurstTiming {
                key: key(t),
                frames_per_burst: t["framesPerBurst"].as_f64().unwrap(),
                burst_period_ms: t["burstPeriodMs"].as_f64().unwrap(),
                inter_message_ms: t["interMessageMs"].as_f64().unwrap(),
                lengths: list(&t["lengths"], |l| uint(l) as usize),
                flags: serde_json::from_value(t["flags"].clone()).unwrap(),
            }),
        }),
        multi_bus: list(&v["multiBus"], |m| MultiBusFrame {
            key: key(m),
            frames_per_bus: m["framesPerBus"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, n)| (k.parse().unwrap(), n.as_u64().unwrap() as usize))
                .collect(),
        }),
    }
}

fn frame_orders() -> Vec<(Protocol, OrderAnalysis)> {
    list(&read("desktop/frameOrder.input.json")["orders"], |o| {
        (
            protocol(o["protocol"].as_str().unwrap()),
            order(&o["order"]),
        )
    })
}

/// Payload Changes as the desktop's fixture builds it: `byteNotes.json`'s
/// profiles, ids renumbered from 0x100, each with its frame notes.
struct Changes {
    protocol: Protocol,
    key: FrameKey,
    profile: ByteProfile,
    notes: Vec<ByteNote>,
}

fn changes() -> Vec<Changes> {
    list(&read("analysis/byteNotes.json")["cases"], |c| c.clone())
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let p = &c["input"]["profile"];
            let profile = profile(p);
            let notes = byte_notes(&profile, c["input"]["isBurstFrame"].as_bool().unwrap()).frame;
            Changes {
                protocol: protocol(p["protocol"].as_str().unwrap_or("can")),
                key: FrameKey::new(0x100 + i as u32, p["isExtended"].as_bool().unwrap()),
                profile,
                notes,
            }
        })
        .collect()
}

fn apply_changes(draft: &mut Draft, changes: &[Changes]) {
    draft.apply_profiles(
        changes
            .iter()
            .map(|c| (c.protocol, c.key, &c.profile, c.notes.as_slice())),
    );
}

fn apply_orders(draft: &mut Draft, orders: &[(Protocol, OrderAnalysis)]) {
    draft.apply_orders(orders.iter().map(|(p, o)| (*p, o)));
}

const ORDER_IDS: [u32; 10] = [
    0x100, 0x101, 0x200, 0x108, 0x301, 0x400, 0x401, 0x10, 0x103, 0x18FF0010,
];

/// `knowledgeFor`: each id an 8-byte frame on bus 0, extended past 0x7FF.
fn known(protocol: Protocol, ids: impl IntoIterator<Item = u32>) -> Draft {
    let mut draft = Draft::default();
    for id in ids {
        draft.seed(protocol, FrameKey::new(id, id > 0x7FF), 8, Some(0));
    }
    draft
}

/// A frame's key in a case's frame map.
fn label(protocol: Protocol, id: u32) -> String {
    format!("{}:{id}", protocol.as_str())
}

/// The lib's frames, notes aside: they are checked against the codes.
fn lib_frames(draft: &Draft) -> BTreeMap<String, Value> {
    draft
        .frames()
        .iter()
        .map(|f| {
            let mut v = serde_json::to_value(f).unwrap();
            v.as_object_mut().unwrap().remove("notes");
            (label(f.protocol, f.key.frame_id), v)
        })
        .collect()
}

/// One TypeScript `FrameKnowledge` as the lib's `FrameDraft`, rules that hold
/// for every frame:
/// - D1: the key is the protocol and a `FrameKey`, so `isExtended` is always
///   there, false where the desktop knew none.
/// - The mux is its selector and its cases; the selector byte, start bit, bit
///   length and `isTwoByte` are the selector's, and the `source` tag is not kept.
/// - `isBurst` and `isMultiBus` are `burst` and `buses` being set; `burstCount`
///   is `framesPerBurst`.
fn translate_frame(protocol: Protocol, ts: &Value) -> Value {
    let mux = (!ts["mux"].is_null()).then(|| {
        let m = &ts["mux"];
        let known = &m["caseKnowledge"];
        let mut cases: BTreeSet<u64> = list(&m["cases"], |c| c.as_u64().unwrap())
            .into_iter()
            .collect();
        cases.extend(
            known
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, _)| k.parse::<u64>().unwrap()),
        );
        let cases: serde_json::Map<String, Value> = cases
            .into_iter()
            .map(|c| {
                let patterns = known[c.to_string()]["multiBytePatterns"].clone();
                let patterns = if patterns.is_null() {
                    json!([])
                } else {
                    patterns
                };
                (
                    c.to_string(),
                    json!({ "signals": [], "patterns": patterns }),
                )
            })
            .collect();
        json!({
            "selector": if m["isTwoByte"] == true { "twoByte" } else { "oneByte" },
            "cases": cases,
        })
    });
    let burst = (!ts["burstInfo"].is_null()).then(|| {
        let b = &ts["burstInfo"];
        json!({
            "framesPerBurst": b["burstCount"],
            "burstPeriodMs": b["burstPeriodMs"],
            "interMessageMs": b["interMessageMs"],
            "flags": b["flags"],
        })
    });
    let or = |v: &Value, d: Value| if v.is_null() { d } else { v.clone() };
    json!({
        "protocol": protocol.as_str(),
        "frameId": ts["frameId"],
        "isExtended": or(&ts["isExtended"], json!(false)),
        "length": ts["length"],
        "bus": ts["bus"],
        "signals": ts["signals"],
        "patterns": or(&ts["multiBytePatterns"], json!([])),
        "mux": mux,
        "intervalMs": ts["intervalMs"],
        "burst": burst,
        "buses": or(&ts["multiBusInfo"]["countPerBus"], json!({})),
    })
}

/// The TypeScript frame map, each bare id under the protocol that wrote it last.
fn translate_frames(ts: &Value, protocol_of: impl Fn(u32) -> Protocol) -> BTreeMap<String, Value> {
    ts.as_object()
        .unwrap()
        .values()
        .map(|f| {
            let protocol = protocol_of(uint(&f["frameId"]));
            (
                label(protocol, uint(&f["frameId"])),
                translate_frame(protocol, f),
            )
        })
        .collect()
}

/// (frame, field or `""` for the whole frame, the lib's value, why).
type Patch = (&'static str, &'static str, Value, &'static str);

fn patched(mut frames: BTreeMap<String, Value>, patches: &[Patch]) -> BTreeMap<String, Value> {
    for (frame, field, value, _) in patches {
        if field.is_empty() {
            frames.insert(frame.to_string(), value.clone());
        } else {
            frames
                .get_mut(*frame)
                .unwrap_or_else(|| panic!("no {frame}"))[field] = value.clone();
        }
    }
    frames
}

fn patterns_at(changes: &[Changes], id: u32, case: u16) -> Value {
    let profile = &changes
        .iter()
        .find(|c| c.key.frame_id == id)
        .unwrap()
        .profile;
    let case = profile
        .mux
        .as_ref()
        .unwrap()
        .cases
        .iter()
        .find(|c| c.value == case);
    serde_json::to_value(&case.unwrap().patterns).unwrap()
}

/// D13, facts 17: 0x100 is in bus 0's 100 ms group and bus 1's 10 ms group; it
/// takes its own bus's, where the desktop took the last written. A frame that
/// names no bus takes the lowest bus with a result for it.
fn own_bus_interval() -> Patch {
    ("can:256", "intervalMs", json!(100.0), "D13, facts 17")
}

/// Each frame's notes are its profile's codes, unioned once: a second pass adds
/// none. The desktop words a code a line, but for the case summaries it drops
/// past four (0x109's seven), which is wording, not merging.
fn assert_notes(draft: &Draft, changes: &[Changes], ts: &Value, name: &str) {
    for c in changes {
        let Some(frame) = draft.frame(c.protocol, c.key) else {
            continue;
        };
        assert_eq!(
            frame.notes, c.notes,
            "{name}: notes of {:#x}",
            c.key.frame_id
        );
        let lines = ts[c.key.frame_id.to_string()]["notes"]
            .as_array()
            .unwrap()
            .len();
        let codes = if c.key.frame_id == 0x109 {
            1
        } else {
            c.notes.len()
        };
        assert_eq!(codes, lines, "{name}: note count of {:#x}", c.key.frame_id);
    }
}

fn check_default_signals(name: &str, input: &Value, expected: &Value) {
    let length = uint(&input[0]) as usize;
    let mut reserved = Vec::new();
    if input[1].is_object() {
        let two = input[1]["isTwoByte"] == true;
        reserved.push(ByteSpan::selector(if two {
            MuxSelector::TwoByte
        } else {
            MuxSelector::OneByte
        }));
    }
    let serial = &input[5];
    let span = |start: &Value, len: &Value| {
        (!start.is_null()).then(|| ByteSpan {
            start: start.as_i64().unwrap() as i32,
            len: uint(len),
        })
    };
    reserved.extend(span(
        &serial["frame_id_start_byte"],
        &serial["frame_id_bytes"],
    ));
    reserved.extend(span(
        &serial["source_address_start_byte"],
        &serial["source_address_bytes"],
    ));
    reserved.extend(span(
        &serial["checksum"]["start_byte"],
        &serial["checksum"]["byte_length"],
    ));
    let known = list(&input[2], |s| DraftSignal {
        name: s["name"].as_str().unwrap().into(),
        start_bit: uint(&s["startBit"]),
        bit_length: uint(&s["bitLength"]),
        source: SignalSource::Known,
        confidence: serde_json::from_value(s["confidence"].clone()).unwrap(),
        byte_order: None,
    });
    let patterns = list(&input[3], pattern);
    let default = input[4].as_str().map_or(Endianness::Little, endianness);

    let lib: Vec<Value> = default_signals(length, &reserved, &known, &patterns, default)
        .iter()
        .map(|s| {
            let mut v = json!({
                "name": s.name,
                "startBit": s.start_bit,
                "bitLength": s.bit_length,
                "source": match s.source {
                    SignalSource::Known => "user",
                    SignalSource::Pattern => "payload-analysis",
                    SignalSource::Fill => "default",
                },
                "confidence": s.confidence,
            });
            if let Some(order) = s.byte_order {
                v["endianness"] = json!(order);
            }
            if s.source == SignalSource::Fill {
                v["format"] = json!("hex");
            }
            v
        })
        .collect();
    assert_eq!(floats(&lib), floats(expected), "{name}");
}

fn check_candidates(name: &str, input: &Value, expected: &Value) {
    // The dialog's `parseInt(…) || fallback`, its text boxes' parse.
    let parse = |v: &Value, fallback: u32| {
        v.as_str()
            .unwrap()
            .parse()
            .ok()
            .filter(|n| *n != 0)
            .unwrap_or(fallback)
    };
    let widths = list(&input["bitLengths"], uint);
    let orders = list(&input["endianness"], |e| endianness(e.as_str().unwrap()));
    let hints = input["hints"]
        .as_u64()
        .map(|i| changes().swap_remove(i as usize).profile.columns);
    let lib = candidate_signals(
        parse(&input["startByte"], 0),
        parse(&input["endByte"], 7),
        &widths,
        &orders,
        hints.as_deref(),
    );
    // The label is English, the desktop's to word.
    let ts: Vec<Value> = list(expected, |c| {
        json!({
            "name": c["signalName"],
            "offset": c["offset"],
            "bits": c["bits"],
            "endianness": endianness(c["endianness"].as_str().unwrap()),
        })
    });
    assert_eq!(floats(&lib), floats(&ts), "{name}");
}

/// `toolbox` seeds from these: the Frame Order ids on bus 0, then the Payload
/// Changes ids (no bus, replacing the first entry for the same key), then
/// `serial:16`, 12 bytes.
fn seed_toolbox(draft: &mut Draft, keys: &Value) {
    let mut info: BTreeMap<String, (Option<u8>, usize)> = BTreeMap::new();
    for id in ORDER_IDS {
        info.insert(format!("can:{id}"), (Some(0), 8));
    }
    for c in changes() {
        info.insert(format!("can:{}", c.key.frame_id), (None, 8));
    }
    info.insert("serial:16".into(), (None, 12));
    for k in list(keys, |k| k.as_str().unwrap().to_string()) {
        let (p, id) = k.split_once(':').unwrap();
        let id: u32 = id.parse().unwrap();
        let (bus, length) = info[&k];
        draft.seed(protocol(p), FrameKey::new(id, id > 0x7FF), length, bus);
    }
}

fn toolbox_patches(changes: &[Changes], changes_first: bool) -> Vec<Patch> {
    let mut patches = vec![
        own_bus_interval(),
        (
            "can:16",
            "",
            json!({
                "protocol": "can", "frameId": 16, "isExtended": false, "length": 8, "bus": 0,
                "signals": [], "patterns": [], "mux": null, "intervalMs": null, "burst": null,
                "buses": {},
            }),
            "D1, facts 17: serial:16 no longer replaces can:16; both are frames",
        ),
        (
            "serial:16",
            "",
            json!({
                "protocol": "serial", "frameId": 16, "isExtended": false, "length": 12,
                "bus": null, "signals": [], "patterns": [], "mux": null, "intervalMs": null,
                "burst": null, "buses": {},
            }),
            "D1, facts 17: as above",
        ),
    ];
    if changes_first {
        let cases: serde_json::Map<String, Value> = [0, 1, 2]
            .into_iter()
            .map(|c| {
                (
                    c.to_string(),
                    json!({ "signals": [], "patterns": patterns_at(changes, 0x108, c) }),
                )
            })
            .collect();
        patches.push((
            "can:264",
            "mux",
            json!({ "selector": "oneByte", "cases": cases }),
            "D13, facts 16: Frame Order keeps the case patterns Payload Changes found",
        ));
    }
    patches
}

fn check(case: &Value) {
    let name = case["name"].as_str().unwrap();
    let (input, expected) = (&case["input"], &case["expected"]);

    if name.starts_with("default signals: ") {
        return check_default_signals(name, input, expected);
    }
    if name.starts_with("candidate signals: ") {
        return check_candidates(name, input, expected);
    }
    match name {
        "default interval from the group with the most frames, first on a tie" => {
            // The tie goes to the shortest interval, not the first group: the
            // same answer here, and one that doesn't hang on input order.
            let lib: Vec<Option<f64>> = list(input, |groups| {
                let groups = list(groups, group);
                default_interval(&groups)
            });
            assert_eq!(floats(&lib), floats(expected), "{name}");
        }
        "mux knowledge from message order" => {
            let timings = [
                json!({ "muxPeriodMs": 100, "interMessageMs": 10, "frameId": 0x300, "isExtended": false, "selector": "oneByte", "occurrences": { "0": 5, "1": 5 } }),
                json!({ "muxPeriodMs": null, "interMessageMs": 2.5, "frameId": 0x301, "isExtended": false, "selector": "twoByte", "occurrences": { "1": 1, "257": 1 } }),
            ];
            let order = order(&json!({
                "buses": [{ "bus": 0, "intervalGroups": [], "mux": timings, "bursts": [] }],
                "multiBus": [],
            }));
            let mut draft = known(Protocol::Can, [0x300, 0x301]);
            draft.apply_orders([(Protocol::Can, &order)]);
            let lib: Vec<Value> = draft
                .frames()
                .iter()
                .map(|f| serde_json::to_value(&f.mux).unwrap())
                .collect();
            let ts: Vec<Value> = list(expected, |m| {
                translate_frame(Protocol::Can, &json!({ "mux": m }))["mux"].clone()
            });
            assert_eq!(floats(&lib), floats(&ts), "{name}");
        }
        "Frame Order folded onto bare ids: every protocol and bus, last writer wins" => {
            let mut draft = known(Protocol::Can, ORDER_IDS);
            apply_orders(&mut draft, &frame_orders());
            let ts = translate_frames(&expected["frames"], |_| Protocol::Can);
            assert_frames(&lib_frames(&draft), &patched(ts, &[own_bus_interval()]), name);
            assert_eq!(floats(&draft.default_interval_ms), floats(&expected["meta"]["defaultInterval"]));
        }
        "Payload Changes folded onto bare ids: notes worded, mux kept from Frame Order, patterns deduplicated by start" =>
        {
            let changes = changes();
            let mut draft = Draft::default();
            for c in &changes {
                draft.seed(c.protocol, c.key, 8, Some(0));
            }
            for (pass, ts) in list(expected, Clone::clone).iter().enumerate() {
                apply_changes(&mut draft, &changes);
                let protocol_of = |id| changes.iter().find(|c| c.key.frame_id == id).unwrap().protocol;
                // D1: 0x106 is a serial frame, so it is seeded as one.
                let frames = patched(
                    translate_frames(&ts["frames"], protocol_of),
                    &[(
                        "can:258",
                        "isExtended",
                        json!(true),
                        "D1: 0x102 is extended in its profile; the desktop's standard seed took it by bare id",
                    )],
                );
                assert_frames(&lib_frames(&draft), &frames, &format!("{name}: pass {pass}"));
                assert_notes(&draft, &changes, &ts["frames"], name);
                assert_eq!(json!(draft.default_endianness), ts["meta"]["defaultEndianness"]);
            }
        }
        "Payload Changes default endianness: set when 67% of frames agree, so two of three is not enough" =>
        {
            let base = &changes()[1].profile;
            let lib: Vec<Value> = list(input, |orders| {
                let profiles: Vec<ByteProfile> = list(orders, |e| ByteProfile {
                    endianness: serde_json::from_value(e.clone()).unwrap(),
                    ..base.clone()
                });
                let mut draft = Draft::default();
                draft.default_endianness = Endianness::Big;
                draft.apply_profiles(
                    profiles
                        .iter()
                        .enumerate()
                        .map(|(i, p)| (Protocol::Can, FrameKey::new(i as u32, false), p, &[][..])),
                );
                json!(draft.default_endianness)
            });
            let mut ts: Vec<Value> = list(expected, |m| m["defaultEndianness"].clone());
            // D12, facts 15: two of three is a strict majority.
            ts[0] = json!("little");
            assert_eq!(floats(&lib), floats(&ts), "{name}");
        }
        "notes added once each" => {
            let code = |n: &Value| ByteNote::VaryingValues {
                count: n.as_str().unwrap().as_bytes()[0] as usize,
            };
            let mut draft = known(Protocol::Can, [0x100]);
            let frame = draft.frame_mut(Protocol::Can, FrameKey::new(0x100, false)).unwrap();
            frame.add_notes(&list(&input["notes"], code));
            frame.add_notes(&list(&json!(["b", "c"]), code));
            assert_eq!(frame.notes, list(expected, code), "{name}");
        }
        "toolbox: Frame Order then Payload Changes, seeded from the discovered frames"
        | "toolbox: Payload Changes then Frame Order" => {
            let changes_first = input["steps"][0] == "changes";
            let changes = changes();
            let mut draft = Draft::default();
            seed_toolbox(&mut draft, &input["frameInfo"]);
            for step in list(&input["steps"], Clone::clone) {
                if step == "order" {
                    apply_orders(&mut draft, &frame_orders());
                } else {
                    apply_changes(&mut draft, &changes);
                }
            }
            let ts = translate_frames(&expected["frames"], |_| Protocol::Can);
            let ts = patched(ts, &toolbox_patches(&changes, changes_first));
            assert_frames(&lib_frames(&draft), &ts, name);
            // D1, facts 17: the extended profile renumbered 0x102 and the serial
            // one renumbered 0x106 land on no seeded frame (can:258 and can:262
            // are standard CAN), where the bare id gave both the notes.
            let (landed, unseeded): (Vec<Changes>, Vec<Changes>) = changes
                .into_iter()
                .partition(|c| draft.frame(c.protocol, c.key).is_some());
            assert_eq!(
                unseeded.iter().map(|c| c.key.frame_id).collect::<Vec<_>>(),
                [0x102, 0x106]
            );
            for c in &unseeded {
                let seeded = FrameKey::new(c.key.frame_id, false);
                assert!(draft.frame(Protocol::Can, seeded).unwrap().notes.is_empty());
            }
            assert_notes(&draft, &landed, &expected["frames"], name);
            assert_eq!(floats(&draft.default_interval_ms), floats(&expected["meta"]["defaultInterval"]));
            assert_eq!(json!(draft.default_endianness), expected["meta"]["defaultEndianness"]);
        }
        "toolbox: the info view's protocol is the majority, a tie is CAN" => {
            for (entries, ts) in list(input, Clone::clone).iter().zip(list(expected, Clone::clone)) {
                let mut draft = Draft::default();
                let mut last = BTreeMap::new();
                for e in list(entries, Clone::clone) {
                    let (p, id) = e[0].as_str().unwrap().split_once(':').unwrap();
                    let id: u32 = id.parse().unwrap();
                    draft.seed(protocol(p), FrameKey::new(id, false), 8, None);
                    last.insert(id, protocol(p));
                }
                assert_eq!(json!(draft.default_frame()), ts["meta"]["defaultFrame"], "{name}");
                let mut frames = translate_frames(&ts["frames"], |id| last[&id]);
                // D1, facts 17: serial:1 and can:1 are two frames, not one.
                if last.len() < draft.frames().len() {
                    frames.insert(
                        "serial:1".into(),
                        translate_frame(Protocol::Serial, &ts["frames"]["1"]),
                    );
                }
                assert_frames(&lib_frames(&draft), &frames, name);
            }
        }
        _ => panic!("no check for {name}"),
    }
}

#[test]
fn drafting_matches_the_typescript_but_for_named_deviations() {
    let cases = list(&read("desktop/drafting.json")["cases"], Clone::clone);
    assert_eq!(cases.len(), 22);
    for case in &cases {
        check(case);
    }
}

#[test]
fn a_draft_round_trips_through_json() {
    let mut draft = Draft::default();
    seed_toolbox(&mut draft, &json!(["can:264", "can:256", "can:257"]));
    apply_orders(&mut draft, &frame_orders());
    apply_changes(&mut draft, &changes());
    let json = serde_json::to_value(&draft).unwrap();
    assert_eq!(serde_json::from_value::<Draft>(json).unwrap(), draft);
}

#[test]
fn a_toolbox_draft_writes_a_catalogue_that_reads_back() {
    let mut draft = Draft::default();
    seed_toolbox(
        &mut draft,
        &json!([
            "can:256",
            "can:257",
            "can:264",
            "can:769",
            "can:419364880",
            "can:1024"
        ]),
    );
    apply_orders(&mut draft, &frame_orders());
    apply_changes(&mut draft, &changes());

    let mut ops = vec![EditOp::SetMeta {
        meta: MetaFields {
            name: "draft".into(),
            version: 1,
            default_frame: draft.default_frame(),
        },
    }];
    ops.extend(draft.to_ops(|f| vec![format!("{} notes", f.notes.len())]));
    let catalog = Catalogue::parse(&apply_edits("", &ops).unwrap()).unwrap();
    let frame = |key: &str| catalog.frame_by_key(Protocol::Can, key).unwrap();

    let plain = frame("0x101");
    assert_eq!(
        (plain.length, plain.interval),
        (8, None),
        "the default interval is not written"
    );
    assert_eq!(plain.notes, ["9 notes"]);
    let names: Vec<&str> = plain
        .signals
        .iter()
        .map(|s| s.name.as_deref().unwrap())
        .collect();
    assert_eq!(names, ["data_0", "counter_4_5", "data_6_7"]);
    assert_eq!(plain.signals[1].confidence, Some(Confidence::Medium));

    assert_eq!(frame("0x18FF0010").is_extended, Some(true));
    assert_eq!(frame("0x18FF0010").interval, Some(1500));
    assert_eq!(frame("0x400").interval, Some(1000));

    let mux = frame("0x108").mux.as_ref().unwrap();
    assert_eq!(
        (mux.name.as_deref(), mux.start_bit, mux.bit_length),
        (Some("mux_264_0_8"), 0, 8)
    );
    let case_names = |case: &str| -> Vec<String> {
        mux.cases[case]
            .signals
            .iter()
            .map(|s| s.name.clone().unwrap())
            .collect()
    };
    assert_eq!(case_names("0"), ["data_1"]);
    assert_eq!(case_names("1"), ["sensor_1_2", "counter_3_4", "data_5_7"]);

    let outer = frame("0x301").mux.as_ref().unwrap();
    assert_eq!(outer.cases.keys().collect::<Vec<_>>(), ["0", "1", "2", "4"]);
    let inner = outer.cases["2"].mux.as_ref().unwrap();
    assert_eq!(
        (inner.name.as_deref(), inner.start_bit),
        (Some("mux_769_2_8_8"), 8)
    );
    assert_eq!(inner.cases.keys().collect::<Vec<_>>(), ["0", "1", "2", "3"]);
    assert_eq!(inner.cases["3"].signals[0].name.as_deref(), Some("data_2"));
}
