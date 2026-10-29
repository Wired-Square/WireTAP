//! Discovery's catalogue export against the desktop's TypeScript
//! `frameExport.ts`, every case of `fixtures/desktop/frame_export_golden.json`.
//! The golden's ops are what the desktop hands `apply_edits`, so they are read
//! as [`EditOp`]s and compared with ours. The cases R17 overrides are listed
//! below with their new answers.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::{json, Map, Value};
use wiretap_analysis::draft::{
    frames_ops, head_ops, modbus_ops, ByteSpan, ExportFrame, ExportMeta, ModbusExportConfig,
    ModbusRegister,
};
use wslib_wiretap_catalogue::edit::EditOp;
use wslib_wiretap_catalogue::model::{Protocol, SerialConfig};

/// A field's name, start byte and bytes.
type Placed = &'static [(&'static str, i32, u32)];

/// R17 D1, D2: a header field no mask over bytes 0–3 can say is written as
/// `start_byte` + `bytes`, where the TypeScript writes a mask past `u32` (or
/// nothing, for an end-relative one). Each serial config here is a `headOps`
/// case under both metas.
const POSITIONED: &[(&str, Placed)] = &[
    (
        "id 2/2 big, source 4/2 little, crc16 at -2 big",
        &[("source_address", 4, 2)],
    ),
    (
        "id 3/3, source 6/1",
        &[("id", 3, 3), ("source_address", 6, 1)],
    ),
    ("id 4/4 (mask past 2^53)", &[("id", 4, 4)]),
    ("id 0/7 (mask past 2^53)", &[("id", 0, 7)]),
    ("id 0/8 (mask past 2^53)", &[("id", 0, 8)]),
    ("id 6/2", &[("id", 6, 2)]),
    ("negative id start is no field", &[("id", -2, 2)]),
];

/// R17 D4: a start with no bytes is 1 byte, as the catalogue reads it, where
/// the TypeScript writes no field.
const ONE_BYTE: &[(&str, &[(&str, u32)])] = &[
    (
        "negative id start is no field",
        &[("source_address", 0xFF00)],
    ),
    ("id start without bytes", &[("id", 0xFF00)]),
];

/// R17 D4 again: the spans those configs reserve, the 1-byte field included.
const ONE_BYTE_SPANS: &[(&str, &[(i32, u32)])] = &[
    ("negative id start is no field", &[(-2, 2), (1, 1)]),
    ("id start without bytes", &[(1, 1)]),
];

fn cases() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/desktop/frame_export_golden.json");
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    golden["cases"].as_array().unwrap().clone()
}

fn from<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap()
}

fn camel(key: &str) -> String {
    let mut words = key.split('_');
    let first = words.next().unwrap().to_string();
    words.fold(first, |mut out, w| {
        out.push_str(&w[..1].to_uppercase());
        out.push_str(&w[1..]);
        out
    })
}

/// The TypeScript `SerialFrameConfig` as the lib's `SerialConfig`.
fn serial_config(ts: &Value) -> SerialConfig {
    fn walk(v: &Value) -> Value {
        let Some(object) = v.as_object() else {
            return v.clone();
        };
        let fields: Map<String, Value> = object
            .iter()
            .map(|(k, v)| match k.as_str() {
                "default_byte_order" => ("byteOrder".into(), v.clone()),
                _ => (camel(k), walk(v)),
            })
            .collect();
        Value::Object(fields)
    }
    from(&walk(ts))
}

fn ops_text(ops: &[EditOp]) -> String {
    format!("{ops:#?}")
}

fn golden_ops(expected: &Value) -> String {
    ops_text(&from::<Vec<EditOp>>(expected))
}

/// The fields a `headOps serial` case lists in `table`, by the config its name ends with.
fn listed<T>(table: &[(&str, &'static [T])], name: &str) -> &'static [T] {
    let Some(config) = name.strip_prefix("headOps serial ") else {
        return &[];
    };
    table
        .iter()
        .find(|(c, _)| config.ends_with(&format!(" {c}")))
        .map_or(&[], |(_, fields)| *fields)
}

fn is_overridden(name: &str) -> bool {
    !listed(POSITIONED, name).is_empty() || !listed(ONE_BYTE, name).is_empty()
}

fn check_head(name: &str, input: &Value, expected: &Value) {
    let protocol: Protocol = from(&input["protocol"]);
    let serial = input
        .get("serialConfig")
        .map(serial_config)
        .unwrap_or_default();
    let (ops, findings) = head_ops(protocol, &from(&input["meta"]), &serial);
    let mut expected = expected.clone();
    if let Some(written) = expected
        .pointer_mut("/1/config/fields")
        .and_then(Value::as_object_mut)
    {
        for &(field, start_byte, bytes) in listed(POSITIONED, name) {
            let order = written
                .get(field)
                .and_then(|f| f.get("endianness"))
                .cloned();
            let mut placed = json!({ "start_byte": start_byte, "bytes": bytes });
            if let Some(order) = order {
                placed["endianness"] = order;
            }
            written.insert(field.into(), placed);
        }
        for &(field, mask) in listed(ONE_BYTE, name) {
            written.insert(field.into(), json!({ "mask": mask }));
        }
    }
    assert!(findings.is_empty(), "{name}: {findings:?}");
    assert_eq!(ops_text(&ops), golden_ops(&expected), "{name}");
}

fn check_frames(name: &str, input: &Value, expected: &Value) {
    let frames: Vec<ExportFrame> = from(&input["frames"]);
    let decimal_ids = input["formatId"].as_str().unwrap().contains("\"decimal\"");
    match frames_ops(&frames, &from(&input["meta"]), decimal_ids) {
        Ok((ops, findings)) => {
            assert!(findings.is_empty(), "{name}");
            assert_eq!(ops_text(&ops), golden_ops(expected), "{name}");
        }
        Err(e) => assert_eq!(
            json!({ "error": format!("Error: {e}") }),
            *expected,
            "{name}"
        ),
    }
}

fn check_modbus(name: &str, input: &Value, expected: &Value) {
    let registers: Vec<ModbusRegister> = from(&input["registers"]);
    let meta: ExportMeta = from(&input["meta"]);
    let config: ModbusExportConfig = from(&input["config"]);
    let ops = modbus_ops(&registers, &meta, &config);
    assert_eq!(ops_text(&ops), golden_ops(expected), "{name}");
}

fn spans_override(name: &str) -> Option<Value> {
    let config = name.strip_prefix("serialReservedSpans ")?;
    let (_, spans) = ONE_BYTE_SPANS.iter().find(|(c, _)| *c == config)?;
    let spans: Vec<Value> = spans
        .iter()
        .map(|&(start, len)| json!({ "start": start, "len": len }))
        .collect();
    Some(Value::Array(spans))
}

fn check_spans(name: &str, input: &Value, expected: &Value) {
    let got = serde_json::to_value(ByteSpan::serial(&serial_config(input))).unwrap();
    let expected = spans_override(name).unwrap_or_else(|| expected.clone());
    assert_eq!(got, expected, "{name}");
}

#[test]
fn every_case_matches_the_golden_but_the_listed_overrides() {
    let cases = cases();
    assert_eq!(cases.len(), 65);
    let mut overridden = 0;
    let mut spans_overridden = 0;
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let (input, expected) = (&case["input"], &case["expected"]);
        match name.split(' ').next().unwrap() {
            "headOps" => {
                overridden += usize::from(is_overridden(name));
                check_head(name, input, expected);
            }
            "framesCatalogOps" => check_frames(name, input, expected),
            "modbusCatalogOps" => check_modbus(name, input, expected),
            "serialReservedSpans" => {
                spans_overridden += usize::from(spans_override(name).is_some());
                check_spans(name, input, expected);
            }
            other => panic!("{name}: no function {other}"),
        }
    }
    let configs: BTreeSet<_> = POSITIONED
        .iter()
        .map(|(c, _)| c)
        .chain(ONE_BYTE.iter().map(|(c, _)| c))
        .collect();
    assert_eq!(overridden, 2 * configs.len());
    assert_eq!(spans_overridden, ONE_BYTE_SPANS.len());
}
