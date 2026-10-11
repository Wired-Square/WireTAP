// crates/wiretap-app/src/drafting.rs
//
// Discovery's catalogue draft: `wiretap_analysis::draft`, carried by the frontend
// between analyses and handed back here to grow, to preview and to write. Frames
// are seeded under their own protocol and key as the capture holds them.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wiretap_analysis::draft::{
    default_signals, frames_ops, head_ops, modbus_ops, ByteSpan, CandidateSignal, Draft, DraftSignal, ExportFinding,
    ExportFrame, ExportMeta, FrameDraft, ModbusExportConfig, ModbusRegister,
};
use wiretap_analysis::{ByteColumn, ByteRole, Direction, FrameKey};
use wiretap_catalog::edit::EditOp;
use wiretap_catalog::model::{Protocol, SerialConfig};
use wiretap_checksum::columns::ColumnStats;
use wiretap_decode::Endianness;

use crate::byte_roles::PayloadChanges;

/// The catalogue protocol a capture's protocol drafts into, if any.
pub fn catalog_protocol(protocol: &str) -> Option<Protocol> {
    match protocol {
        "can" => Some(Protocol::Can),
        "modbus" => Some(Protocol::Modbus),
        "serial" => Some(Protocol::Serial),
        _ => None,
    }
}

/// Seed each frame `frames` names, at its longest length.
pub fn seed<'a>(draft: &mut Draft, frames: impl IntoIterator<Item = (&'a str, FrameKey, usize)>) {
    for (protocol, key, length) in frames {
        if let Some(protocol) = catalog_protocol(protocol) {
            let frame = draft.seed(protocol, key, length, None);
            frame.length = frame.length.max(length);
        }
    }
}

/// Payload Changes into the draft, every profiled frame seeded first.
pub fn apply_changes(draft: &mut Draft, changes: &PayloadChanges) {
    let frames: Vec<_> = changes
        .frames
        .iter()
        .filter_map(|f| {
            let protocol = catalog_protocol(f.profile.protocol.as_deref().unwrap_or("can"))?;
            Some((protocol, FrameKey::new(f.profile.frame_id, f.profile.is_extended), f))
        })
        .collect();
    for (protocol, key, f) in &frames {
        let frame = draft.seed(*protocol, *key, f.profile.profile.max_len, None);
        frame.length = frame.length.max(f.profile.profile.max_len);
    }
    draft.apply_profiles(frames.iter().map(|(p, k, f)| (*p, *k, &f.profile.profile, f.notes.frame.as_slice())));
}

/// A frame the draft is previewed or written with: Discovery's own, which an
/// analysis may not have reached.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DraftFrame {
    pub protocol: String,
    pub frame_id: u32,
    pub is_extended: bool,
    pub length: usize,
}

fn with_frames(draft: Option<Draft>, frames: &[DraftFrame]) -> Draft {
    let mut draft = draft.unwrap_or_default();
    seed(&mut draft, frames.iter().map(|f| (f.protocol.as_str(), FrameKey::new(f.frame_id, f.is_extended), f.length)));
    draft
}

/// What `frame` is written with: its own signals, then patterns and hex over the
/// bytes nothing else claims. A mux frame's selector is claimed.
fn frame_signals(draft: &Draft, frame: &FrameDraft) -> Vec<DraftSignal> {
    let mut reserved = match frame.protocol {
        Protocol::Serial => draft.serial_reserved.clone(),
        _ => Vec::new(),
    };
    reserved.extend(frame.mux.as_ref().map(|m| ByteSpan::selector(m.selector)));
    let drafted = default_signals(frame.length, &reserved, &frame.signals, &frame.patterns, draft.default_endianness);
    frame.signals.iter().cloned().chain(drafted).collect()
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DraftPreview {
    #[cfg_attr(test, ts(as = "crate::analysis_ts::Draft"))]
    pub draft: Draft,
    #[cfg_attr(test, ts(as = "Option<crate::analysis_ts::CatalogProtocol>"))]
    pub default_frame: Option<Protocol>,
    /// Each of `draft`'s frames' signals, as it would be written.
    #[cfg_attr(test, ts(as = "Vec<Vec<crate::analysis_ts::DraftSignal>>"))]
    pub signals: Vec<Vec<DraftSignal>>,
}

/// The draft with Discovery's frames in it, and what each would be written with.
#[tauri::command]
pub fn draft_preview_cmd(draft: Option<Draft>, frames: Vec<DraftFrame>) -> DraftPreview {
    let draft = with_frames(draft, &frames);
    let signals = draft.frames().iter().map(|f| frame_signals(&draft, f)).collect();
    DraftPreview { default_frame: draft.default_frame(), signals, draft }
}

/// How the draft is written into a catalogue.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DraftWrite {
    /// The frames to write, each with its notes worded.
    pub frames: Vec<DraftFrame>,
    pub notes: Vec<Vec<String>>,
    pub default_endianness: Endianness,
    pub default_interval_ms: Option<f64>,
    /// Key CAN and serial frames by decimal id rather than hex.
    pub decimal_ids: bool,
}

/// The ops writing `write.frames` from the draft, every serial frame leaving
/// `serial_reserved` to its header and checksum.
pub fn catalog_ops(draft: Option<Draft>, write: DraftWrite, serial_reserved: Vec<ByteSpan>) -> Vec<EditOp> {
    let source = draft.unwrap_or_default();
    let mut draft = Draft::default();
    draft.default_endianness = write.default_endianness;
    draft.default_interval_ms = write.default_interval_ms;
    draft.serial_reserved = serial_reserved;
    let mut notes = HashMap::new();
    for (f, lines) in write.frames.iter().zip(write.notes) {
        let Some(protocol) = catalog_protocol(&f.protocol) else { continue };
        let key = FrameKey::new(f.frame_id, f.is_extended);
        let frame = draft.seed(protocol, key, f.length, None);
        if let Some(known) = source.frame(protocol, key) {
            *frame = known.clone();
        }
        frame.length = f.length;
        notes.insert((protocol, key), lines);
    }
    draft
        .frames()
        .iter()
        .flat_map(|frame| {
            let lines = notes.remove(&(frame.protocol, frame.key)).unwrap_or_default();
            let ops = draft.frame_ops(frame, lines);
            match (write.decimal_ids, frame.protocol) {
                (true, Protocol::Can | Protocol::Serial) => {
                    rekey(ops, &frame.catalogue_key(), &frame.key.frame_id.to_string())
                }
                _ => ops,
            }
        })
        .collect()
}

fn rekey(ops: Vec<EditOp>, from: &str, to: &str) -> Vec<EditOp> {
    let path = |mut path: Vec<String>| {
        if path.get(2).is_some_and(|k| k == from) {
            path[2] = to.into();
        }
        path
    };
    ops.into_iter()
        .map(|op| match op {
            EditOp::SetFrame { protocol, key, rename_from, frame } if key == from => {
                EditOp::SetFrame { protocol, key: to.into(), rename_from, frame }
            }
            EditOp::UpsertSignal { owner_path, index, signal } => {
                EditOp::UpsertSignal { owner_path: path(owner_path), index, signal }
            }
            EditOp::SetMux { owner_path, mux } => EditOp::SetMux { owner_path: path(owner_path), mux },
            EditOp::SetTable { path: p, value, managed_keys, replace_contents, sort_parent_numeric, skip_if_exists, error_if_exists } => {
                EditOp::SetTable {
                    path: path(p),
                    value,
                    managed_keys,
                    replace_contents,
                    sort_parent_numeric,
                    skip_if_exists,
                    error_if_exists,
                }
            }
            op => op,
        })
        .collect()
}

/// A catalogue the export wrote, and what it left out.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ExportedCatalog {
    pub text: String,
    pub findings: Vec<ExportFinding>,
}

/// A new catalogue from `ops`, refused with its findings unless it validates.
fn built(ops: &[EditOp]) -> Result<String, String> {
    let text = wiretap_catalog::edit::apply_edits("", ops)?;
    crate::catalog::refuse_unless_valid(&text)?;
    Ok(text)
}

/// A catalogue of the draft's frames under `meta` and the first protocol they
/// name, a serial one framed by `serial`, refused unless it validates.
#[tauri::command(rename_all = "snake_case")]
pub fn draft_catalog_cmd(
    draft: Option<Draft>,
    meta: ExportMeta,
    serial: Option<SerialConfig>,
    write: DraftWrite,
) -> Result<ExportedCatalog, String> {
    let named: Vec<ExportFrame> = write
        .frames
        .iter()
        .map(|f| ExportFrame {
            id: f.frame_id,
            len: f.length as u32,
            is_extended: f.is_extended,
            protocol: Some(f.protocol.clone()),
        })
        .collect();
    let protocol = wiretap_analysis::draft::catalog_protocol(&named).map_err(|e| e.to_string())?;
    let serial = serial.unwrap_or_default();
    let (head, findings) = head_ops(protocol, &meta, &serial);
    let ops: Vec<EditOp> = head.into_iter().chain(catalog_ops(draft, write, ByteSpan::serial(&serial))).collect();
    Ok(ExportedCatalog { text: built(&ops)?, findings })
}

/// A catalogue declaring each frame's id and length, keyed in hex or, under
/// `decimal_ids`, decimal.
#[tauri::command(rename_all = "snake_case")]
pub fn export_frames_catalog_cmd(
    frames: Vec<ExportFrame>,
    meta: ExportMeta,
    decimal_ids: bool,
) -> Result<String, String> {
    let (ops, _) = frames_ops(&frames, &meta, decimal_ids).map_err(|e| e.to_string())?;
    built(&ops)
}

/// A catalogue with one frame per register a Modbus scan found.
#[tauri::command(rename_all = "snake_case")]
pub fn export_modbus_catalog_cmd(
    registers: Vec<ModbusRegister>,
    meta: ExportMeta,
    config: ModbusExportConfig,
) -> Result<String, String> {
    built(&modbus_ops(&registers, &meta, &config))
}

/// A byte column's role, as Payload Changes reports it.
#[derive(Debug, Deserialize)]
pub struct ColumnHint {
    position: i32,
    role: String,
}

impl ColumnHint {
    fn column(&self) -> ByteColumn {
        let role = match self.role.as_str() {
            "static" => ByteRole::Static { value: 0 },
            "counter" => ByteRole::Counter { direction: Direction::Up, step: 1, rollover: false, looping: None },
            _ => ByteRole::Value,
        };
        let stats = ColumnStats {
            position: self.position,
            distinct_values: 0,
            min: 0,
            max: 0,
            constant_value: None,
            changes: 0,
            transitions: 0,
            entropy_bits: 0.0,
            sample_count: 0,
        };
        ByteColumn { stats, role }
    }
}

/// The `byte_*` signals the Dashboard offers over bytes `start..=end`.
#[tauri::command]
pub fn candidate_signals_cmd(
    start: u32,
    end: u32,
    widths: Vec<u32>,
    orders: Vec<Endianness>,
    hints: Option<Vec<ColumnHint>>,
) -> Vec<CandidateSignal> {
    let hints: Option<Vec<ByteColumn>> = hints.map(|h| h.iter().map(ColumnHint::column).collect());
    wiretap_analysis::draft::candidate_signals(start, end, &widths, &orders, hints.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::byte_roles::payload_changes;
    use wiretap_analysis::source::{FrameSelection, FrameSource, MemorySource};

    fn frame(protocol: &str, frame_id: u32, is_extended: bool, length: usize) -> DraftFrame {
        DraftFrame { protocol: protocol.into(), frame_id, is_extended, length }
    }

    fn write(frames: Vec<DraftFrame>, decimal_ids: bool) -> DraftWrite {
        DraftWrite {
            notes: vec![Vec::new(); frames.len()],
            frames,
            default_endianness: Endianness::Little,
            default_interval_ms: Some(100.0),
            decimal_ids,
        }
    }

    fn meta() -> ExportMeta {
        ExportMeta { name: "draft".into(), version: 1, default_byte_order: Endianness::Little, default_interval: 100.0 }
    }

    fn build_framed(draft: Option<Draft>, write: DraftWrite, serial: serde_json::Value) -> ExportedCatalog {
        draft_catalog_cmd(draft, meta(), Some(serde_json::from_value(serial).unwrap()), write).unwrap()
    }

    fn build(draft: Option<Draft>, write: DraftWrite) -> String {
        build_framed(draft, write, serde_json::json!({ "encoding": "raw" })).text
    }

    /// An extended CAN counter and a serial frame with a static first byte.
    fn capture() -> MemorySource {
        let mut source = MemorySource::default();
        for i in 0..30u8 {
            let t = i as u64 * 100_000;
            source.push_at("can", 0, 0x18FF_0001, true, t, vec![i, 0x5A, 0, 0]);
            source.push_at("serial", 0, 0x10, false, t + 1000, vec![0xAA, i]);
        }
        source
    }

    #[tokio::test]
    async fn analysed_frames_land_under_their_own_protocol_and_key() {
        let source = capture();
        let changes = payload_changes(&source, vec![], None, usize::MAX).await.unwrap();
        let mut draft = Draft::default();
        apply_changes(&mut draft, &changes);
        let keys: Vec<_> = draft.frames().iter().map(|f| (f.protocol, f.catalogue_key())).collect();
        assert_eq!(keys, [(Protocol::Can, "0x18FF0001".into()), (Protocol::Serial, "0x010".into())]);

        let toml =
            build(Some(draft), write(vec![frame("serial", 0x10, false, 2), frame("can", 0x18FF_0001, true, 4)], false));
        assert!(toml.contains("[frame.can.0x18FF0001]"), "{toml}");
        assert!(toml.contains("[frame.serial.0x010]"), "{toml}");
    }

    #[tokio::test]
    async fn a_mux_frame_is_written_with_named_selectors_and_its_cases() {
        let mut source = MemorySource::default();
        for i in 0..30u8 {
            for case in [1u8, 2] {
                source.push("can", 0x100, false, vec![case, case * 16, i, 0]);
            }
        }
        let changes = payload_changes(&source, vec![], None, usize::MAX).await.unwrap();
        let mut draft = Draft::default();
        apply_changes(&mut draft, &changes);
        let toml = build(Some(draft), write(vec![frame("can", 0x100, false, 4)], false));
        assert!(toml.contains("name = \"mux_256_0_8\""), "{toml}");
        assert!(toml.contains("[frame.can.0x100.mux.1]") || toml.contains("[[frame.can.0x100.mux.1.signals]]"), "{toml}");
    }

    #[tokio::test]
    async fn frames_seen_only_in_frame_order_are_seeded_at_their_longest() {
        let source = capture();
        let frames = source.frames(&FrameSelection::default(), None).await.unwrap();
        let mut draft = Draft::default();
        seed(&mut draft, frames.iter().map(|f| (f.protocol.as_str(), f.frame.key, f.frame.payload.len())));
        let lengths: Vec<usize> = draft.frames().iter().map(|f| f.length).collect();
        assert_eq!(lengths, [4, 2]);
    }

    #[test]
    fn an_unanalysed_frame_is_written_with_hex_over_its_bytes() {
        let toml = build(None, write(vec![frame("can", 0x100, false, 8)], false));
        assert!(toml.contains("[frame.can.0x100]"), "{toml}");
        assert!(toml.contains("name = \"data_0\""), "{toml}");
        assert!(toml.contains("bit_length = 64"), "{toml}");
    }

    #[test]
    fn an_analysed_interval_is_written_in_whole_milliseconds() {
        let meta = ExportMeta { default_interval: 99.6, ..meta() };
        let text = draft_catalog_cmd(None, meta, None, write(vec![frame("can", 0x100, false, 8)], false)).unwrap().text;
        assert!(text.contains("default_interval = 100\n"), "{text}");
    }

    #[test]
    fn decimal_ids_key_every_op_of_the_frame() {
        let toml = build(None, write(vec![frame("can", 0x100, false, 2)], true));
        assert!(toml.contains("[frame.can.256]"), "{toml}");
        assert!(!toml.contains("0x100"), "{toml}");
    }

    #[test]
    fn a_serial_frame_leaves_its_header_and_checksum_bytes_unclaimed() {
        let serial = serde_json::json!({
            "encoding": "slip",
            "frameIdStartByte": 0,
            "frameIdBytes": 1,
            "checksum": {
                "algorithm": "xor", "startByte": -1, "byteLength": 1, "calcStartByte": 0, "calcEndByte": -1, "bigEndian": false,
            },
        });
        let exported = build_framed(None, write(vec![frame("serial", 0x10, false, 4)], false), serial);
        let toml = exported.text;
        assert!(exported.findings.is_empty());
        assert!(toml.contains("name = \"data_1\""), "{toml}");
        assert!(toml.contains("start_bit = 8\nbit_length = 16"), "{toml}");
    }

    #[test]
    fn a_header_field_past_byte_four_comes_back_as_a_finding() {
        let serial = serde_json::json!({
            "encoding": "raw",
            "frameIdStartByte": 0,
            "frameIdBytes": 1,
            "sourceAddressStartByte": 4,
            "sourceAddressBytes": 2,
        });
        let exported = build_framed(None, write(vec![frame("serial", 0x10, false, 8)], false), serial);
        assert_eq!(
            exported.findings,
            [ExportFinding::HeaderFieldOutOfRange { field: "source_address".into(), start_byte: 4, bytes: 2 }]
        );
    }

    /// A field's name, start byte and bytes.
    type Unwritten = &'static [(&'static str, u32, u32)];

    /// wiretap-analysis' D7: a header field ending past byte 4 is not written, and
    /// comes back as a finding. Each serial config is a `headOps` case under both metas.
    const OUT_OF_RANGE: &[(&str, Unwritten)] = &[
        ("id 2/2 big, source 4/2 little, crc16 at -2 big", &[("source_address", 4, 2)]),
        ("id 3/3, source 6/1", &[("id", 3, 3), ("source_address", 6, 1)]),
        ("id 4/4 (mask past 2^53)", &[("id", 4, 4)]),
        ("id 0/7 (mask past 2^53)", &[("id", 0, 7)]),
        ("id 0/8 (mask past 2^53)", &[("id", 0, 8)]),
        ("id 6/2", &[("id", 6, 2)]),
    ];

    /// A start byte counted from the end names no header field, so it reserves no span.
    const NEGATIVE_START_SPANS: &str = "serialReservedSpans negative id start is no field";

    fn from<T: serde::de::DeserializeOwned>(v: &serde_json::Value) -> T {
        serde_json::from_value(v.clone()).unwrap()
    }

    fn ops_text(ops: &[EditOp]) -> String {
        format!("{ops:#?}")
    }

    /// The golden's framing as `serialConfigOf` sends it: camelCase, a start byte
    /// counted from the end dropped.
    fn serial_of(input: &serde_json::Value) -> SerialConfig {
        fn camel(key: &str) -> String {
            let mut words = key.split('_');
            let first = words.next().unwrap().to_string();
            words.fold(first, |out, w| out + &w[..1].to_uppercase() + &w[1..])
        }
        fn walk(v: &serde_json::Value) -> serde_json::Value {
            let Some(object) = v.as_object() else { return v.clone() };
            object
                .iter()
                .filter(|(k, v)| !(k.ends_with("_start_byte") && v.as_i64().is_some_and(|n| n < 0)))
                .map(|(k, v)| match k.as_str() {
                    "default_byte_order" => ("byteOrder".into(), v.clone()),
                    _ => (camel(k), walk(v)),
                })
                .collect::<serde_json::Map<_, _>>()
                .into()
        }
        let mut config = walk(input);
        if let Some(checksum) = config.get_mut("checksum") {
            checksum["bigEndian"] = checksum.get("bigEndian").cloned().unwrap_or(false.into());
        }
        from(&config)
    }

    fn check_head(name: &str, input: &serde_json::Value, expected: &serde_json::Value) {
        let serial = input.get("serialConfig").map(serial_of).unwrap_or_default();
        let (ops, findings) = head_ops(from(&input["protocol"]), &from(&input["meta"]), &serial);
        let mut expected = expected.clone();
        let mut wanted = Vec::new();
        let unwritten = name
            .strip_prefix("headOps serial ")
            .and_then(|config| OUT_OF_RANGE.iter().find(|(c, _)| config.ends_with(&format!(" {c}"))));
        for &(field, start_byte, bytes) in unwritten.map_or(&[][..], |(_, fields)| fields) {
            let written = expected[1]["config"]["fields"].as_object_mut().unwrap();
            assert!(written.remove(field).is_some(), "{name}: golden has no {field}");
            wanted.push(ExportFinding::HeaderFieldOutOfRange { field: field.into(), start_byte, bytes });
        }
        assert_eq!(findings, wanted, "{name}");
        assert_eq!(ops_text(&ops), ops_text(&from::<Vec<EditOp>>(&expected)), "{name}");
    }

    fn check_frames(name: &str, input: &serde_json::Value, expected: &serde_json::Value) {
        let (frames, meta): (Vec<ExportFrame>, ExportMeta) = (from(&input["frames"]), from(&input["meta"]));
        let decimal_ids = input["formatId"].as_str().unwrap().contains("\"decimal\"");
        match frames_ops(&frames, &meta, decimal_ids) {
            Ok((ops, findings)) => {
                assert!(findings.is_empty(), "{name}");
                assert_eq!(ops_text(&ops), ops_text(&from::<Vec<EditOp>>(expected)), "{name}");
                assert_eq!(export_frames_catalog_cmd(frames, meta, decimal_ids), built(&ops), "{name}");
            }
            Err(e) => {
                assert_eq!(serde_json::json!({ "error": format!("Error: {e}") }), *expected, "{name}");
                assert_eq!(export_frames_catalog_cmd(frames, meta, decimal_ids), Err(e.to_string()), "{name}");
            }
        }
    }

    fn check_modbus(name: &str, input: &serde_json::Value, expected: &serde_json::Value) {
        let (registers, meta, config): (Vec<ModbusRegister>, ExportMeta, ModbusExportConfig) =
            (from(&input["registers"]), from(&input["meta"]), from(&input["config"]));
        let ops = modbus_ops(&registers, &meta, &config);
        assert_eq!(ops_text(&ops), ops_text(&from::<Vec<EditOp>>(expected)), "{name}");
        assert_eq!(export_modbus_catalog_cmd(registers, meta, config), built(&ops), "{name}");
    }

    fn check_spans(name: &str, input: &serde_json::Value, expected: &serde_json::Value) {
        let got = serde_json::to_value(ByteSpan::serial(&serial_of(input))).unwrap();
        if name == NEGATIVE_START_SPANS {
            assert_eq!(*expected, serde_json::json!([{ "start": -2, "len": 2 }]), "{name}");
            assert_eq!(got, serde_json::json!([]), "{name}");
        } else {
            assert_eq!(got, *expected, "{name}");
        }
    }

    #[test]
    fn the_catalogue_export_matches_its_golden_but_the_libs_overrides() {
        let golden = crate::small_twin_tables::fixture("frameExportGolden.json");
        let cases = golden["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 65);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let (input, expected) = (&case["input"], &case["expected"]);
            match name.split(' ').next().unwrap() {
                "headOps" => check_head(name, input, expected),
                "framesCatalogOps" => check_frames(name, input, expected),
                "modbusCatalogOps" => check_modbus(name, input, expected),
                "serialReservedSpans" => check_spans(name, input, expected),
                other => panic!("{name}: no function {other}"),
            }
        }
    }

    #[test]
    fn the_preview_seeds_discoverys_frames_and_names_the_default_protocol() {
        let preview = draft_preview_cmd(None, vec![frame("serial", 1, false, 2), frame("serial", 2, false, 2), frame("can", 3, false, 1)]);
        assert_eq!(preview.default_frame, Some(Protocol::Serial));
        assert_eq!(preview.signals.len(), 3);
        assert_eq!(preview.signals[0][0].name, "data_0");
    }

    #[test]
    fn a_static_or_counter_hint_starts_no_candidate() {
        let hints = vec![
            ColumnHint { position: 0, role: "static".into() },
            ColumnHint { position: 1, role: "counter".into() },
            ColumnHint { position: 2, role: "sensor".into() },
        ];
        let names: Vec<String> = candidate_signals_cmd(0, 3, vec![8], vec![Endianness::Little], Some(hints))
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, ["byte_2_8b_le", "byte_3_8b_le"]);
    }
}
