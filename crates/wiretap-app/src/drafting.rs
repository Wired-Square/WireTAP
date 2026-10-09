// crates/wiretap-app/src/drafting.rs
//
// Discovery's catalogue draft: `wiretap_analysis::draft`, carried by the frontend
// between analyses and handed back here to grow, to preview and to write. Frames
// are seeded under their own protocol and key as the capture holds them.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wiretap_analysis::draft::{default_signals, ByteSpan, CandidateSignal, Draft, DraftSignal, FrameDraft};
use wiretap_analysis::{ByteColumn, ByteRole, Direction, FrameKey};
use wiretap_catalog::edit::EditOp;
use wiretap_catalog::model::Protocol;
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
    #[cfg_attr(test, ts(as = "crate::analysis_ts::ByteOrder"))]
    pub default_endianness: Endianness,
    pub default_interval_ms: Option<f64>,
    /// What every serial frame's header and checksum take.
    #[cfg_attr(test, ts(as = "Vec<crate::analysis_ts::ByteSpan>"))]
    pub serial_reserved: Vec<ByteSpan>,
    /// Key CAN and serial frames by decimal id rather than hex.
    pub decimal_ids: bool,
}

/// The ops writing `write.frames` from the draft, after the caller's `head`.
pub fn catalog_ops(draft: Option<Draft>, write: DraftWrite) -> Vec<EditOp> {
    let source = draft.unwrap_or_default();
    let mut draft = Draft::default();
    draft.default_endianness = write.default_endianness;
    draft.default_interval_ms = write.default_interval_ms;
    draft.serial_reserved = write.serial_reserved;
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

/// A catalogue of the draft's frames after the caller's meta and config `head`,
/// refused with its findings unless it validates.
#[tauri::command]
pub fn draft_catalog_cmd(draft: Option<Draft>, head: Vec<EditOp>, write: DraftWrite) -> Result<String, String> {
    let ops: Vec<EditOp> = head.into_iter().chain(catalog_ops(draft, write)).collect();
    let text = wiretap_catalog::edit::apply_edits("", &ops)?;
    crate::catalog::refuse_unless_valid(&text)?;
    Ok(text)
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
    use crate::analysis::memory::MemorySource;
    use crate::analysis::FrameSource;
    use crate::byte_roles::payload_changes;
    use crate::capture_store::FrameSelection;

    fn frame(protocol: &str, frame_id: u32, is_extended: bool, length: usize) -> DraftFrame {
        DraftFrame { protocol: protocol.into(), frame_id, is_extended, length }
    }

    fn write(frames: Vec<DraftFrame>, decimal_ids: bool) -> DraftWrite {
        DraftWrite {
            notes: vec![Vec::new(); frames.len()],
            frames,
            default_endianness: Endianness::Little,
            default_interval_ms: Some(100.0),
            serial_reserved: Vec::new(),
            decimal_ids,
        }
    }

    fn build(draft: Option<Draft>, write: DraftWrite) -> String {
        let head = serde_json::from_value(serde_json::json!([
            { "op": "SetMeta", "meta": { "name": "draft", "version": 1 } },
            { "op": "SetSerialConfig", "config": { "encoding": "raw" } },
        ]))
        .unwrap();
        draft_catalog_cmd(draft, head, write).unwrap()
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

        let toml = build(
            Some(draft),
            write(vec![frame("can", 0x18FF_0001, true, 4), frame("serial", 0x10, false, 2)], false),
        );
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
        seed(&mut draft, frames.iter().map(|f| (f.protocol.as_str(), FrameKey::new(f.frame_id, f.is_extended), f.bytes.len())));
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
    fn decimal_ids_key_every_op_of_the_frame() {
        let toml = build(None, write(vec![frame("can", 0x100, false, 2)], true));
        assert!(toml.contains("[frame.can.256]"), "{toml}");
        assert!(!toml.contains("0x100"), "{toml}");
    }

    #[test]
    fn a_serial_frame_leaves_its_header_and_checksum_bytes_unclaimed() {
        let mut w = write(vec![frame("serial", 0x10, false, 4)], false);
        w.serial_reserved = vec![ByteSpan { start: 0, len: 1 }, ByteSpan { start: -1, len: 1 }];
        let toml = build(None, w);
        assert!(toml.contains("name = \"data_1\""), "{toml}");
        assert!(toml.contains("start_bit = 8\nbit_length = 16"), "{toml}");
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
