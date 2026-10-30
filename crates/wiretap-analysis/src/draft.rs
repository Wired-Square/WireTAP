//! Drafting a catalogue from analysis: what Payload Changes and Frame Order say
//! about each frame, merged into a [`Draft`] keyed by protocol and [`FrameKey`],
//! and the typed catalogue ops that write it. Notes stay codes; the caller words
//! them when it writes the ops. Also the `byte_*` signals offered for a frame
//! with no catalogue, which read byte roles and so live here, not beside
//! [`wslib_bits::PayloadField`], and Discovery's catalogue export.

use std::collections::BTreeMap;
use std::ops::Range;

use serde::{Deserialize, Serialize};
use wslib_bits::Endianness;
use wslib_checksum::resolve_byte_index;
use wslib_wiretap_catalogue::byte_name;
use wslib_wiretap_catalogue::edit::{mux_name, EditOp, FrameFields, MuxFields, SignalFields};
use wslib_wiretap_catalogue::model::{Confidence, Protocol, SerialConfig};
use wslib_wiretap_protocol::format_frame_id;

use crate::notes::ByteNote;
use crate::order::{BurstFlag, BusOrder, IntervalGroup, OrderAnalysis};
use crate::roles::{self, ByteColumn, ByteProfile, ByteRole, MultiBytePattern, MuxSelector};
use crate::scan::FrameKey;

mod export;
pub use export::{
    catalog_protocol, frames_ops, head_ops, modbus_ops, ExportError, ExportFinding, ExportFrame,
    ExportMeta, ModbusExportConfig, ModbusRegister,
};

/// Bytes a frame's header, checksum or mux selector takes; a negative `start`
/// counts from the end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ByteSpan {
    pub start: i32,
    pub len: u32,
}

impl ByteSpan {
    pub fn selector(selector: MuxSelector) -> Self {
        Self {
            start: 0,
            len: selector.width() as u32,
        }
    }

    /// A serial frame's id, source address and checksum.
    pub fn serial(config: &SerialConfig) -> Vec<Self> {
        let field = |start: Option<i32>, len: Option<u32>| {
            Some(Self {
                start: start?,
                len: len.unwrap_or(1),
            })
        };
        [
            field(config.frame_id_start_byte, config.frame_id_bytes),
            field(
                config.source_address_start_byte,
                config.source_address_bytes,
            ),
            config.checksum.as_ref().map(|c| Self {
                start: c.start_byte,
                len: c.byte_length,
            }),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    fn bytes(self, length: usize) -> Range<usize> {
        let start = resolve_byte_index(self.start, length);
        start..(start + self.len as usize).min(length)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SignalSource {
    /// The caller's.
    Known,
    /// A multi-byte pattern's.
    Pattern,
    /// Hex over bytes nothing else claims.
    Fill,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DraftSignal {
    pub name: String,
    pub start_bit: u32,
    pub bit_length: u32,
    pub source: SignalSource,
    pub confidence: Confidence,
    /// Only when it is not the draft's default.
    pub byte_order: Option<Endianness>,
}

impl DraftSignal {
    fn bytes(&self) -> Range<usize> {
        let end = self.start_bit.saturating_add(self.bit_length).div_ceil(8);
        (self.start_bit / 8) as usize..end as usize
    }

    /// The signal as written: a fill as hex with no confidence.
    pub fn fields(&self) -> SignalFields {
        let fill = self.source == SignalSource::Fill;
        SignalFields {
            name: self.name.clone(),
            start_bit: self.start_bit,
            bit_length: self.bit_length,
            byte_order: self.byte_order,
            format: fill.then(|| "hex".into()),
            confidence: (!fill).then_some(self.confidence),
            ..Default::default()
        }
    }
}

fn claim(claimed: &mut [bool], bytes: Range<usize>) {
    for byte in bytes {
        if let Some(c) = claimed.get_mut(byte) {
            *c = true;
        }
    }
}

/// The signals a frame gets beyond `known`: each pattern clear of `reserved` and
/// `known` bytes and of earlier patterns, then a hex fill over each free run.
pub fn default_signals(
    length: usize,
    reserved: &[ByteSpan],
    known: &[DraftSignal],
    patterns: &[MultiBytePattern],
    default_endianness: Endianness,
) -> Vec<DraftSignal> {
    let mut claimed = vec![false; length];
    for span in reserved {
        claim(&mut claimed, span.bytes(length));
    }
    for signal in known {
        claim(&mut claimed, signal.bytes());
    }

    let mut signals = Vec::new();
    for p in patterns {
        let bytes = p.start..p.start + p.len;
        if bytes.clone().any(|b| claimed.get(b) == Some(&true)) {
            continue;
        }
        let kind = match p.kind {
            roles::PatternKind::Counter16 => "counter",
            roles::PatternKind::Sensor16 => "sensor",
            _ => "data",
        };
        let byte_order = match p.endianness {
            Some(roles::Endianness::Little) => Some(Endianness::Little),
            Some(roles::Endianness::Big) => Some(Endianness::Big),
            _ => None,
        };
        signals.push(DraftSignal {
            name: format!("{kind}_{}_{}", p.start, bytes.end - 1),
            start_bit: (p.start * 8) as u32,
            bit_length: (p.len * 8) as u32,
            source: SignalSource::Pattern,
            confidence: if p.correlated_rollover {
                Confidence::High
            } else {
                Confidence::Medium
            },
            byte_order: byte_order.filter(|e| *e != default_endianness),
        });
        claim(&mut claimed, bytes);
    }

    let mut start = 0;
    for run in claimed.chunk_by(|a, b| a == b) {
        if !run[0] {
            signals.push(DraftSignal {
                name: format!("data_{start}"),
                start_bit: (start * 8) as u32,
                bit_length: (run.len() * 8) as u32,
                source: SignalSource::Fill,
                confidence: Confidence::Low,
                byte_order: None,
            });
        }
        start += run.len();
    }
    signals
}

/// Negative and NaN as 0.
fn whole_ms(ms: f64) -> u64 {
    ms.round() as u64
}

/// The interval of the group with the most ids, the shortest on a tie.
pub fn default_interval<'a>(groups: impl IntoIterator<Item = &'a IntervalGroup>) -> Option<f64> {
    groups
        .into_iter()
        .max_by(|a, b| {
            a.keys
                .len()
                .cmp(&b.keys.len())
                .then(b.interval_ms.total_cmp(&a.interval_ms))
        })
        .map(|g| g.interval_ms)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MuxCaseDraft {
    pub signals: Vec<DraftSignal>,
    pub patterns: Vec<MultiBytePattern>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MuxDraft {
    pub selector: MuxSelector,
    pub cases: BTreeMap<u16, MuxCaseDraft>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BurstDraft {
    pub frames_per_burst: f64,
    pub burst_period_ms: f64,
    pub inter_message_ms: f64,
    pub flags: Vec<BurstFlag>,
}

/// What the draft knows of one frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FrameDraft {
    pub protocol: Protocol,
    #[serde(flatten)]
    pub key: FrameKey,
    /// Bytes.
    pub length: usize,
    /// The bus whose Frame Order results the frame takes; `None` takes the
    /// lowest bus that has one for it.
    pub bus: Option<u8>,
    pub signals: Vec<DraftSignal>,
    /// A frame without a mux's; a mux frame's are its cases'.
    pub patterns: Vec<MultiBytePattern>,
    pub mux: Option<MuxDraft>,
    pub interval_ms: Option<f64>,
    pub burst: Option<BurstDraft>,
    /// Frames per bus, when the frame is seen on more than one.
    pub buses: BTreeMap<u8, usize>,
    pub notes: Vec<ByteNote>,
}

fn merge_patterns(into: &mut Vec<MultiBytePattern>, from: &[MultiBytePattern]) {
    for p in from {
        if !into.iter().any(|q| q.start == p.start) {
            into.push(p.clone());
        }
    }
}

fn mentions(bus: &BusOrder, key: FrameKey) -> bool {
    bus.interval_groups.iter().any(|g| g.keys.contains(&key))
        || bus.mux.iter().any(|m| m.key == key)
        || bus.bursts.iter().any(|b| b.key == key)
}

impl FrameDraft {
    pub fn new(protocol: Protocol, key: FrameKey, length: usize, bus: Option<u8>) -> Self {
        Self {
            protocol,
            key,
            length,
            bus,
            signals: Vec::new(),
            patterns: Vec::new(),
            mux: None,
            interval_ms: None,
            burst: None,
            buses: BTreeMap::new(),
            notes: Vec::new(),
        }
    }

    /// Each note not already here, in order.
    pub fn add_notes(&mut self, notes: &[ByteNote]) {
        for note in notes {
            if !self.notes.contains(note) {
                self.notes.push(note.clone());
            }
        }
    }

    /// The key the frame is written under: hex for CAN and serial, the register
    /// number for Modbus.
    pub fn catalogue_key(&self) -> String {
        match self.protocol {
            Protocol::Modbus => self.key.frame_id.to_string(),
            _ => format_frame_id(self.key.frame_id, self.key.is_extended),
        }
    }

    fn apply_profile(&mut self, profile: &ByteProfile, notes: &[ByteNote]) {
        self.add_notes(notes);
        let Some(analysis) = &profile.mux else {
            merge_patterns(&mut self.patterns, &profile.patterns);
            return;
        };
        let selector = analysis.detection.selector;
        let mux = self.mux.get_or_insert_with(|| MuxDraft {
            selector,
            cases: BTreeMap::new(),
        });
        if mux.selector == selector {
            for case in &analysis.cases {
                let known = mux.cases.entry(case.value).or_default();
                merge_patterns(&mut known.patterns, &case.patterns);
            }
        }
    }

    fn apply_order(&mut self, order: &OrderAnalysis) {
        let key = self.key;
        let bus = match self.bus {
            Some(bus) => order.buses.iter().find(|b| b.bus == bus),
            None => order.buses.iter().find(|b| mentions(b, key)),
        };
        if let Some(bus) = bus {
            if let Some(group) = bus.interval_groups.iter().find(|g| g.keys.contains(&key)) {
                self.interval_ms = Some(group.interval_ms);
            }
            if let Some(timing) = bus.mux.iter().find(|m| m.key == key) {
                let selector = timing.detection.selector;
                if self.mux.as_ref().is_some_and(|m| m.selector != selector) {
                    self.mux = None;
                }
                let mux = self.mux.get_or_insert_with(|| MuxDraft {
                    selector,
                    cases: BTreeMap::new(),
                });
                for case in timing.detection.occurrences.keys() {
                    mux.cases.entry(*case).or_default();
                }
                self.interval_ms = Some(timing.mux_period_ms.unwrap_or(timing.inter_message_ms));
            }
            if let Some(burst) = bus.bursts.iter().find(|b| b.key == key) {
                self.interval_ms = Some(burst.burst_period_ms);
                self.burst = Some(BurstDraft {
                    frames_per_burst: burst.frames_per_burst,
                    burst_period_ms: burst.burst_period_ms,
                    inter_message_ms: burst.inter_message_ms,
                    flags: burst.flags.clone(),
                });
            }
        }
        if let Some(multi) = order.multi_bus.iter().find(|m| m.key == key) {
            self.buses = multi.frames_per_bus.clone();
        }
    }
}

/// A catalogue in the making, one [`FrameDraft`] per protocol and key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub default_endianness: Endianness,
    pub default_interval_ms: Option<f64>,
    /// What every serial frame's header and checksum take.
    pub serial_reserved: Vec<ByteSpan>,
    frames: Vec<FrameDraft>,
}

impl Default for Draft {
    fn default() -> Self {
        Self {
            default_endianness: Endianness::Little,
            default_interval_ms: None,
            serial_reserved: Vec::new(),
            frames: Vec::new(),
        }
    }
}

impl Draft {
    /// By protocol, then key.
    pub fn frames(&self) -> &[FrameDraft] {
        &self.frames
    }

    fn position(&self, protocol: Protocol, key: FrameKey) -> Result<usize, usize> {
        self.frames
            .binary_search_by_key(&(protocol, key), |f| (f.protocol, f.key))
    }

    pub fn frame(&self, protocol: Protocol, key: FrameKey) -> Option<&FrameDraft> {
        self.position(protocol, key).ok().map(|i| &self.frames[i])
    }

    pub fn frame_mut(&mut self, protocol: Protocol, key: FrameKey) -> Option<&mut FrameDraft> {
        self.position(protocol, key)
            .ok()
            .map(|i| &mut self.frames[i])
    }

    /// The frame, added when it is not known yet. Only known frames take results.
    pub fn seed(
        &mut self,
        protocol: Protocol,
        key: FrameKey,
        length: usize,
        bus: Option<u8>,
    ) -> &mut FrameDraft {
        let i = self.position(protocol, key).unwrap_or_else(|i| {
            self.frames
                .insert(i, FrameDraft::new(protocol, key, length, bus));
            i
        });
        &mut self.frames[i]
    }

    /// The protocol with the most frames, the first in [`Protocol`] order on a tie.
    pub fn default_frame(&self) -> Option<Protocol> {
        let mut counts: BTreeMap<Protocol, usize> = BTreeMap::new();
        for frame in &self.frames {
            *counts.entry(frame.protocol).or_default() += 1;
        }
        counts
            .into_iter()
            .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
            .map(|(protocol, _)| protocol)
    }

    /// Payload Changes: each frame's profile and its frame notes. Notes are
    /// unioned and patterns merged by start; a mux is taken only when the frame
    /// has none, and case patterns only under the same selector. The default
    /// byte order is the one a strict majority of the profiles with one share.
    pub fn apply_profiles<'a>(
        &mut self,
        profiles: impl IntoIterator<Item = (Protocol, FrameKey, &'a ByteProfile, &'a [ByteNote])>,
    ) {
        let (mut little, mut big) = (0, 0);
        for (protocol, key, profile, notes) in profiles {
            match profile.endianness {
                Some(roles::Endianness::Little) => little += 1,
                Some(roles::Endianness::Big) => big += 1,
                _ => {}
            }
            if let Some(frame) = self.frame_mut(protocol, key) {
                frame.apply_profile(profile, notes);
            }
        }
        if little * 2 > little + big {
            self.default_endianness = Endianness::Little;
        } else if big * 2 > little + big {
            self.default_endianness = Endianness::Big;
        }
    }

    /// Frame Order, one analysis per protocol. A frame takes its own bus's
    /// interval group, mux and burst timing, in that order, each replacing the
    /// interval; a mux under the same selector keeps its cases' knowledge.
    pub fn apply_orders<'a>(
        &mut self,
        orders: impl IntoIterator<Item = (Protocol, &'a OrderAnalysis)>,
    ) {
        let orders: Vec<_> = orders.into_iter().collect();
        let groups = orders
            .iter()
            .flat_map(|(_, o)| o.buses.iter().flat_map(|b| &b.interval_groups));
        if let Some(ms) = default_interval(groups) {
            self.default_interval_ms = Some(ms);
        }
        for (protocol, order) in orders {
            for frame in self.frames.iter_mut().filter(|f| f.protocol == protocol) {
                frame.apply_order(order);
            }
        }
    }

    /// Every frame's ops, its notes worded by `notes`.
    pub fn to_ops(&self, notes: impl Fn(&FrameDraft) -> Vec<String>) -> Vec<EditOp> {
        self.frames
            .iter()
            .flat_map(|f| self.frame_ops(f, notes(f)))
            .collect()
    }

    /// `SetFrame` with the length, the interval when it is not the default, and
    /// `notes`; then the frame's signals, or its mux and each case's, every byte
    /// nothing else claims filled with hex. A two-byte mux nests: byte 0 selects
    /// the outer case, byte 1 the inner. Interval and defaults are the draft's,
    /// for the caller to write into the protocol's config.
    pub fn frame_ops(&self, frame: &FrameDraft, notes: Vec<String>) -> Vec<EditOp> {
        let key = frame.catalogue_key();
        let owner = vec![
            "frame".to_string(),
            frame.protocol.as_str().into(),
            key.clone(),
        ];
        let interval_ms = frame
            .interval_ms
            .map(whole_ms)
            .filter(|ms| Some(*ms) != self.default_interval_ms.map(whole_ms));
        let length = match frame.protocol {
            Protocol::Modbus => frame.length.div_ceil(2).max(1),
            _ => frame.length,
        };
        let mut ops = vec![EditOp::SetFrame {
            protocol: frame.protocol,
            key,
            rename_from: None,
            frame: FrameFields {
                length: Some(length as u32),
                interval_ms,
                notes,
                extended: (frame.protocol == Protocol::Can && frame.key.is_extended)
                    .then_some(true),
                ..Default::default()
            },
        }];

        let mut reserved = match frame.protocol {
            Protocol::Serial => self.serial_reserved.clone(),
            _ => Vec::new(),
        };
        let Some(mux) = &frame.mux else {
            ops.extend(self.signal_ops(
                &owner,
                frame.length,
                &reserved,
                &frame.signals,
                &frame.patterns,
            ));
            return ops;
        };
        reserved.push(ByteSpan::selector(mux.selector));
        let case_ops = |path: Vec<String>, case: &MuxCaseDraft| {
            let ops = self.signal_ops(
                &path,
                frame.length,
                &reserved,
                &case.signals,
                &case.patterns,
            );
            if !ops.is_empty() {
                return ops;
            }
            vec![EditOp::SetTable {
                path,
                value: Default::default(),
                managed_keys: Vec::new(),
                replace_contents: false,
                sort_parent_numeric: false,
                skip_if_exists: true,
                error_if_exists: false,
            }]
        };

        ops.push(set_mux(&owner, 0));
        let mut outer = None;
        for (value, case) in &mux.cases {
            match mux.selector {
                MuxSelector::OneByte => ops.extend(case_ops(case_path(&owner, *value), case)),
                MuxSelector::TwoByte => {
                    let outer_path = case_path(&owner, value >> 8);
                    if outer != Some(value >> 8) {
                        outer = Some(value >> 8);
                        ops.push(set_mux(&outer_path, 8));
                    }
                    ops.extend(case_ops(case_path(&outer_path, value & 0xFF), case));
                }
            }
        }
        ops
    }

    fn signal_ops(
        &self,
        owner: &[String],
        length: usize,
        reserved: &[ByteSpan],
        known: &[DraftSignal],
        patterns: &[MultiBytePattern],
    ) -> Vec<EditOp> {
        let drafted = default_signals(length, reserved, known, patterns, self.default_endianness);
        known
            .iter()
            .chain(&drafted)
            .map(|s| EditOp::UpsertSignal {
                owner_path: owner.to_vec(),
                index: None,
                signal: s.fields(),
            })
            .collect()
    }
}

fn case_path(owner: &[String], case: u16) -> Vec<String> {
    [owner, &["mux".to_string(), case.to_string()]].concat()
}

/// An 8-bit selector at `start_bit`, named by [`mux_name`].
fn set_mux(owner: &[String], start_bit: u32) -> EditOp {
    EditOp::SetMux {
        owner_path: owner.to_vec(),
        mux: MuxFields {
            name: mux_name(owner, start_bit, 8).unwrap_or_default(),
            start_bit,
            bit_length: 8,
            notes: Vec::new(),
        },
    }
}

/// A `byte_*` signal offered for charting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CandidateSignal {
    pub name: String,
    pub offset: u32,
    pub bits: u32,
    pub endianness: Endianness,
}

/// The [`byte_name`] signals over bytes `start..=end`: from each offset, each
/// width ascending that ends by `end` (whole bytes, 8 to 64 bits), in each byte
/// order given, 8 bits once as little-endian. With `hints`, a byte whose column
/// is static or a counter starts none.
pub fn candidate_signals(
    start: u32,
    end: u32,
    widths: &[u32],
    orders: &[Endianness],
    hints: Option<&[ByteColumn]>,
) -> Vec<CandidateSignal> {
    let mut widths: Vec<u32> = widths
        .iter()
        .copied()
        .filter(|bits| bits.is_multiple_of(8) && (8..=64).contains(bits))
        .collect();
    widths.sort_unstable();
    widths.dedup();
    let skipped = |offset: u32| {
        hints
            .and_then(|columns| columns.iter().find(|c| c.stats.position == offset as i32))
            .is_some_and(|c| matches!(c.role, ByteRole::Static { .. } | ByteRole::Counter { .. }))
    };
    let mut signals = Vec::new();
    for offset in (start..=end).filter(|o| !skipped(*o)) {
        for &bits in widths.iter().filter(|bits| offset + *bits / 8 - 1 <= end) {
            for &endianness in orders
                .iter()
                .filter(|e| bits > 8 || **e == Endianness::Little)
            {
                signals.push(CandidateSignal {
                    name: byte_name(offset, bits, endianness),
                    offset,
                    bits,
                    endianness,
                });
            }
        }
    }
    signals
}

#[cfg(test)]
mod tests {
    use super::*;
    use wslib_wiretap_catalogue::model::ChecksumConfig;

    #[test]
    fn a_serial_config_reserves_its_id_source_and_checksum_bytes() {
        let config = SerialConfig {
            frame_id_start_byte: Some(0),
            frame_id_bytes: Some(2),
            source_address_start_byte: Some(2),
            source_address_bytes: Some(1),
            checksum: Some(ChecksumConfig {
                algorithm: "sum8".into(),
                start_byte: -1,
                byte_length: 1,
                calc_start_byte: 0,
                calc_end_byte: None,
                big_endian: false,
            }),
            ..Default::default()
        };
        let spans = ByteSpan::serial(&config);
        let names: Vec<String> = default_signals(8, &spans, &[], &[], Endianness::Little)
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, ["data_3"]);
        assert_eq!(spans[2].bytes(8), 7..8);
    }

    #[test]
    fn an_end_relative_id_reserves_its_bytes_from_the_end() {
        let config = SerialConfig {
            frame_id_start_byte: Some(-3),
            frame_id_bytes: Some(2),
            ..Default::default()
        };
        let spans = ByteSpan::serial(&config);
        assert_eq!(spans, [ByteSpan { start: -3, len: 2 }]);
        assert_eq!(spans[0].bytes(8), 5..7);
    }
}
