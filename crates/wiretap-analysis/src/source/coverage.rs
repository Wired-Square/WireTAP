use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::Hash;

use serde::Serialize;
use wslib_modbus::Direction;
use wslib_wiretap_catalogue::model::{Confidence, Frame, Protocol, RegisterType};
use wslib_wiretap_catalogue::Catalogue;
use wslib_wiretap_catalogue::RtuSettings;
use wslib_wiretap_protocol::format_frame_id;
use wslib_wiretap_protocol::MODBUS_RTU_PROTOCOL;

use super::{InventoryRow, PayloadQuery, PayloadSource, Sampling};
use crate::roles::{profile_bytes, ByteProfile};

/// A catalogue signal's confidence as coverage reports it: `unset` both where
/// the catalogue says `none` and where it says nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum CoverageConfidence {
    Low,
    Medium,
    High,
    Unset,
}

impl From<Option<Confidence>> for CoverageConfidence {
    fn from(confidence: Option<Confidence>) -> Self {
        match confidence {
            Some(Confidence::Low) => Self::Low,
            Some(Confidence::Medium) => Self::Medium,
            Some(Confidence::High) => Self::High,
            Some(Confidence::None) | None => Self::Unset,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ConfidenceTally {
    pub high: usize,
    pub medium: usize,
    pub low: usize,
    pub unset: usize,
}

impl ConfidenceTally {
    fn add(&mut self, confidence: CoverageConfidence) {
        match confidence {
            CoverageConfidence::High => self.high += 1,
            CoverageConfidence::Medium => self.medium += 1,
            CoverageConfidence::Low => self.low += 1,
            CoverageConfidence::Unset => self.unset += 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct SignalCoverage {
    pub name: String,
    pub confidence: CoverageConfidence,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct PresentFrame {
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub name: Option<String>,
    pub count: i64,
    pub first_us: i64,
    pub last_us: i64,
    pub signals: Vec<SignalCoverage>,
    #[cfg_attr(feature = "ts", ts(optional))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_roles: Option<ByteProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct MissingFrame {
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct UncataloguedFrame {
    /// The id to add to the catalogue — masked, when the catalogue is.
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub is_extended: bool,
    pub count: i64,
    /// A raw id this was actually seen as, when that differs from `frame_id`.
    /// Absent without a `frame_id_mask`, so an ordinary report is unchanged.
    #[cfg_attr(feature = "ts", ts(optional))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen_as_hex: Option<String>,
    /// For a Modbus RTU read, the unit it addressed; `frame_id` is its start
    /// register.
    #[cfg_attr(feature = "ts", ts(optional))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<u8>,
    #[cfg_attr(feature = "ts", ts(optional))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub register_type: Option<RegisterType>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct CoverageReport {
    pub catalog: String,
    pub catalog_frames: usize,
    /// Distinct frames in the data, counted the way the catalogue counts them:
    /// under a `frame_id_mask`, fewer than the ids on the wire.
    pub data_frames: usize,
    pub present: Vec<PresentFrame>,
    pub missing: Vec<MissingFrame>,
    pub uncatalogued: Vec<UncataloguedFrame>,
    /// Over the catalogue's directly-defined signals, not mirror or copy
    /// duplicates.
    pub confidence: ConfidenceTally,
}

/// A frame's catalogue name, falling back to the transmitter.
fn frame_label(f: &Frame) -> Option<String> {
    f.name.clone().or_else(|| f.transmitter.clone())
}

fn register_label(unit: Option<u8>, bank: RegisterType, register: u32) -> String {
    let unit = unit.map(|u| format!("unit {u} ")).unwrap_or_default();
    format!("{unit}{} {register}", bank.as_str())
}

fn frame_id_hex(f: &Frame, is_extended: bool) -> String {
    match (f.protocol, f.modbus_register_type) {
        (Protocol::Modbus, Some(bank)) => register_label(f.modbus_device_address, bank, f.frame_id),
        _ => format_frame_id(f.frame_id, is_extended),
    }
}

/// How often, and over what span, the data shows one frame.
#[derive(Clone, Copy)]
struct Seen {
    count: i64,
    first_us: i64,
    last_us: i64,
}

impl Seen {
    fn add(&mut self, other: Seen) {
        self.count += other.count;
        self.first_us = self.first_us.min(other.first_us);
        self.last_us = self.last_us.max(other.last_us);
    }
}

/// The data side of one catalogue frame: every inventory row whose id maps onto
/// it, rolled up.
struct DataFrame<'a> {
    /// The most-seen contributing row. Decides how the id renders, and is the
    /// raw id payloads are sampled by: a masked catalogue id never appears in
    /// the data.
    top: &'a InventoryRow,
    count: i64,
    first_us: i64,
    last_us: i64,
}

impl<'a> DataFrame<'a> {
    fn new(row: &'a InventoryRow) -> Self {
        Self {
            top: row,
            count: row.count,
            first_us: row.first_us,
            last_us: row.last_us,
        }
    }

    fn seen(&self) -> Seen {
        Seen {
            count: self.count,
            first_us: self.first_us,
            last_us: self.last_us,
        }
    }

    fn merge(&mut self, row: &'a InventoryRow) {
        self.count += row.count;
        self.first_us = self.first_us.min(row.first_us);
        self.last_us = self.last_us.max(row.last_us);
        if row.count > self.top.count {
            self.top = row;
        }
    }
}

const STANDARD_CAN_ID: u32 = 0x7FF;

/// The id the catalogue counts `row` under. A mask reaching past 11 bits was
/// written for extended ids, so it leaves a standard CAN id as it is.
fn catalogue_id(row: &InventoryRow, mask: u32) -> u32 {
    let standard_can = row.protocol == Protocol::Can.as_str() && !row.is_extended;
    if standard_can && mask & !STANDARD_CAN_ID != 0 {
        row.frame_id
    } else {
        row.frame_id & mask
    }
}

/// The inventory rolled up onto the ids the catalogue is keyed by. `mask` is the
/// catalogue's `frame_id_mask`, or `u32::MAX` for none, when the only merge is a
/// std/extended pair.
fn roll_up<'a>(
    inventory: impl IntoIterator<Item = &'a InventoryRow>,
    mask: u32,
) -> HashMap<u32, DataFrame<'a>> {
    let mut by_id: HashMap<u32, DataFrame> = HashMap::new();
    for row in inventory {
        by_id
            .entry(catalogue_id(row, mask))
            .and_modify(|d| d.merge(row))
            .or_insert_with(|| DataFrame::new(row));
    }
    by_id
}

#[derive(Default)]
struct RtuReads<'c> {
    /// By frame key, with the newest register bytes of the reads carrying it.
    present: HashMap<&'c str, (Seen, VecDeque<Vec<u8>>)>,
    uncatalogued: HashMap<(u8, RegisterType, u16), Seen>,
    /// Messages addressing no register bank, by unit and function code.
    unbanked: HashMap<(u8, u8), Seen>,
}

fn tally<K: Eq + Hash>(seen_by: &mut HashMap<K, Seen>, key: K, seen: Seen) {
    seen_by
        .entry(key)
        .and_modify(|s| s.add(seen))
        .or_insert(seen);
}

/// Every `modbus_rtu` row re-framed whole, in order, one stream per row so a
/// response pairs with its request. A read's span is its row's: payloads carry
/// no timestamps.
async fn rtu_reads<'c, S: PayloadSource>(
    source: &S,
    inventory: &[InventoryRow],
    catalog: &'c Catalogue,
    sample_limit: usize,
) -> Result<RtuReads<'c>, S::Error> {
    let options = RtuSettings::tapped().options(Some(catalog));
    let mut reads = RtuReads::default();
    for row in inventory
        .iter()
        .filter(|r| r.protocol == MODBUS_RTU_PROTOCOL)
    {
        let seen = Seen {
            count: 1,
            first_us: row.first_us,
            last_us: row.last_us,
        };
        let payloads = source
            .payloads(PayloadQuery {
                protocol: Some(MODBUS_RTU_PROTOCOL),
                frame_id: row.frame_id,
                is_extended: None,
                limit: u32::MAX,
                sampling: Sampling::Recent,
            })
            .await?;
        let mut stream = options.stream();
        for msg in payloads.iter().filter_map(|raw| stream.interpret(raw)) {
            if msg.exception.is_some() {
                continue;
            }
            let Some(bank) = RegisterType::from_function_code(msg.function) else {
                tally(
                    &mut reads.unbanked,
                    (msg.device_address, msg.function),
                    seen,
                );
                continue;
            };
            // One count per exchange: the response, placed by its request.
            let (Direction::Response, Some(start), Some(quantity)) =
                (msg.direction, msg.start_register, msg.quantity)
            else {
                continue;
            };
            let unit = msg.device_address;
            let frames = catalog.modbus_register_frames_within(start, quantity, bank, unit);
            if frames.is_empty() {
                tally(&mut reads.uncatalogued, (unit, bank, start), seen);
            }
            let bytes = if bank.is_register_bank() && sample_limit > 0 {
                msg.register_bytes()
            } else {
                Vec::new()
            };
            for (offset, frame) in frames {
                let (_, samples) = reads
                    .present
                    .entry(frame.key.as_str())
                    .and_modify(|(s, _)| s.add(seen))
                    .or_insert((seen, VecDeque::new()));
                let at = usize::from(offset) * 2;
                let len = usize::from(frame.modbus_register_count.unwrap_or_default()) * 2;
                if let Some(slice) = bytes.get(at..at + len).filter(|b| !b.is_empty()) {
                    if samples.len() == sample_limit {
                        samples.pop_front();
                    }
                    samples.push_back(slice.to_vec());
                }
            }
        }
    }
    Ok(reads)
}

/// `catalog`, reported under `catalog_name`, diffed against a source keyed the
/// way the catalogue is, its `frame_id_mask` applied. A `modbus_rtu` row holds
/// whole messages under `unit << 8 | function`, so it is re-framed into reads and
/// matched by register window instead; a register number and a row id never
/// match each other.
///
/// A frame whose byte-role payloads fail to read is profiled over none, so one
/// unreadable frame costs its byte roles and not the report. A `modbus_rtu` row
/// is counted from its payloads, so its read error is returned.
pub async fn catalog_coverage<S: PayloadSource>(
    source: &S,
    catalog_name: &str,
    catalog: &Catalogue,
    include_byte_roles: bool,
    sample_limit: u32,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<CoverageReport, S::Error> {
    let mask = wslib_wiretap_catalogue::decode::frame_id_mask(catalog).unwrap_or(u32::MAX);
    let inventory = source.inventory(start_us, end_us).await?;
    let rolled_up = |registers: bool| {
        let rows = inventory.iter().filter(move |r| {
            r.protocol != MODBUS_RTU_PROTOCOL
                && (r.protocol == Protocol::Modbus.as_str()) == registers
        });
        roll_up(rows, mask)
    };
    let by_register = rolled_up(true);
    let by_id = rolled_up(false);
    let profile_limit = if include_byte_roles {
        sample_limit as usize
    } else {
        0
    };
    let mut rtu = rtu_reads(source, &inventory, catalog, profile_limit).await?;
    let data_frames = by_register.len()
        + by_id.len()
        + rtu.present.len()
        + rtu.uncatalogued.len()
        + rtu.unbanked.len();
    // A register both polled and read off the line is one frame of data.
    let mut polled_and_read = HashSet::new();

    let mut confidence = ConfidenceTally::default();
    let mut present = Vec::new();
    let mut missing = Vec::new();
    let catalog_ids: HashSet<(bool, u32)> = catalog
        .frames
        .iter()
        .map(|f| (f.protocol == Protocol::Modbus, f.frame_id))
        .collect();

    for frame in &catalog.frames {
        let sigs = frame.own_signals();
        for s in &sigs {
            confidence.add(s.confidence.into());
        }

        let is_modbus = frame.protocol == Protocol::Modbus;
        let rolled = if is_modbus { &by_register } else { &by_id }.get(&frame.frame_id);
        let read = is_modbus
            .then(|| rtu.present.remove(frame.key.as_str()))
            .flatten();
        if rolled.is_some() && read.is_some() {
            polled_and_read.insert(frame.frame_id);
        }
        let seen = rolled
            .map(DataFrame::seen)
            .into_iter()
            .chain(read.as_ref().map(|r| r.0));
        let Some(seen) = seen.reduce(|mut a, b| {
            a.add(b);
            a
        }) else {
            missing.push(MissingFrame {
                frame_id: frame.frame_id,
                frame_id_hex: frame_id_hex(frame, frame.is_extended.unwrap_or(false)),
                name: frame_label(frame),
            });
            continue;
        };

        let byte_roles = match (include_byte_roles, read, rolled) {
            (false, ..) => None,
            (true, Some((_, mut samples)), _) => Some(profile_bytes(samples.make_contiguous())),
            (true, None, Some(data)) => {
                let payloads = source
                    .payloads(PayloadQuery {
                        protocol: Some(&data.top.protocol),
                        frame_id: data.top.frame_id,
                        is_extended: Some(data.top.is_extended),
                        limit: sample_limit,
                        sampling: Sampling::Recent,
                    })
                    .await
                    .unwrap_or_default();
                Some(profile_bytes(&payloads))
            }
            (true, None, None) => None,
        };
        present.push(PresentFrame {
            frame_id: frame.frame_id,
            frame_id_hex: frame_id_hex(frame, rolled.is_some_and(|d| d.top.is_extended)),
            name: frame_label(frame),
            count: seen.count,
            first_us: seen.first_us,
            last_us: seen.last_us,
            signals: sigs
                .iter()
                .filter_map(|s| {
                    s.name.clone().map(|name| SignalCoverage {
                        name,
                        confidence: s.confidence.into(),
                    })
                })
                .collect(),
            byte_roles,
        });
    }

    // Reported by the id to add to the catalogue, so under a mask one unknown
    // message from five nodes is one frame; the raw id rides along.
    let rolled_up_unknown = [(true, &by_register), (false, &by_id)]
        .into_iter()
        .flat_map(|(registers, by)| by.iter().map(move |(id, d)| (registers, *id, d)))
        .filter(|&(registers, id, _)| !catalog_ids.contains(&(registers, id)))
        .map(|(_, id, d)| UncataloguedFrame {
            frame_id: id,
            frame_id_hex: format_frame_id(id, d.top.is_extended),
            is_extended: d.top.is_extended,
            count: d.count,
            seen_as_hex: (d.top.frame_id != id)
                .then(|| format_frame_id(d.top.frame_id, d.top.is_extended)),
            unit: None,
            register_type: None,
        });
    let unknown_reads = rtu
        .uncatalogued
        .into_iter()
        .map(|((unit, bank, start), seen)| UncataloguedFrame {
            frame_id: start.into(),
            frame_id_hex: register_label(Some(unit), bank, start.into()),
            is_extended: false,
            count: seen.count,
            seen_as_hex: None,
            unit: Some(unit),
            register_type: Some(bank),
        });
    let unknown_functions =
        rtu.unbanked
            .into_iter()
            .map(|((unit, function), seen)| UncataloguedFrame {
                frame_id: u32::from(unit) << 8 | u32::from(function),
                frame_id_hex: format!("unit {unit} fn 0x{function:02X}"),
                is_extended: false,
                count: seen.count,
                seen_as_hex: None,
                unit: Some(unit),
                register_type: None,
            });
    let mut uncatalogued: Vec<UncataloguedFrame> = rolled_up_unknown
        .chain(unknown_reads)
        .chain(unknown_functions)
        .collect();
    uncatalogued.sort_by(|a, b| (a.frame_id, &a.frame_id_hex).cmp(&(b.frame_id, &b.frame_id_hex)));

    Ok(CoverageReport {
        catalog: catalog_name.to_owned(),
        catalog_frames: catalog.frames.len(),
        data_frames: data_frames - polled_and_read.len(),
        present,
        missing,
        uncatalogued,
        confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(frame_id: u32, count: i64, first_us: i64, last_us: i64) -> InventoryRow {
        InventoryRow::new("can", frame_id, true, count, first_us, last_us, 8)
    }

    /// A J1939 mask strips the source address, so several ids on the wire are
    /// one catalogue frame. Diffing raw ids reported `present=0` on a bus the
    /// catalogue decoded in full.
    #[test]
    fn a_masked_catalogue_frame_rolls_up_every_id_that_maps_onto_it() {
        let inventory = [
            row(0x1802_FF01, 10, 500, 900),
            row(0x1802_FF02, 30, 100, 700),
            row(0x1802_FF03, 5, 300, 3000),
        ];
        let rolled = roll_up(&inventory, 0x1FFF_FF00);

        assert_eq!(
            rolled.len(),
            1,
            "three source addresses, one catalogue frame"
        );
        let data = &rolled[&0x1802_FF00];
        assert_eq!(data.count, 45, "counts sum across contributing ids");
        assert_eq!(data.first_us, 100, "the window starts at the earliest");
        assert_eq!(data.last_us, 3000, "and ends at the latest");
        assert_eq!(
            data.top.frame_id, 0x1802_FF02,
            "payloads sample by the most-seen raw id — the masked id is not on the wire"
        );
    }

    /// `sbrxxx_inter_tower.toml`'s mask is for bus 0's 29-bit ids; folding
    /// bus 1's 11-bit `0x700`–`0x73F` under it made them one `0x700` row.
    #[test]
    fn a_mask_for_extended_ids_leaves_standard_can_ids_apart() {
        let inventory = [
            row(0x1802_FF01, 10, 0, 1),
            row(0x1802_FF02, 10, 0, 1),
            InventoryRow::new("can", 0x700, false, 1, 0, 1, 8),
            InventoryRow::new("can", 0x701, false, 1, 0, 1, 8),
            InventoryRow::new("can", 0x73F, false, 1, 0, 1, 8),
        ];
        let rolled = roll_up(&inventory, 0x1FFF_FF00);
        let mut ids: Vec<u32> = rolled.keys().copied().collect();
        ids.sort_unstable();
        assert_eq!(ids, [0x700, 0x701, 0x73F, 0x1802_FF00]);

        let serial = [
            InventoryRow::new("serial", 0x1201, false, 1, 0, 1, 8),
            InventoryRow::new("serial", 0x1202, false, 1, 0, 1, 8),
        ];
        assert_eq!(
            roll_up(&serial, 0xFF00).len(),
            1,
            "a serial id has no width"
        );
        let standard = [
            InventoryRow::new("can", 0x701, false, 1, 0, 1, 8),
            InventoryRow::new("can", 0x702, false, 1, 0, 1, 8),
        ];
        assert_eq!(
            roll_up(&standard, 0x7F0).len(),
            1,
            "an 11-bit mask still applies"
        );
    }

    /// `u32::MAX` is what a catalogue declaring no mask resolves to, and must
    /// leave every id in its own bucket.
    #[test]
    fn no_mask_keeps_every_id_apart() {
        let inventory = [row(0x1802_FF01, 10, 0, 1), row(0x1802_FF02, 30, 0, 1)];
        assert_eq!(roll_up(&inventory, u32::MAX).len(), 2);
    }

    /// Without a mask the only merge is a std/extended pair, and the bigger row
    /// still decides how the id renders.
    #[test]
    fn an_unmasked_frame_keeps_the_bigger_rows_identity() {
        let inventory = [
            InventoryRow::new("can", 0x100, false, 3, 10, 20, 8),
            InventoryRow::new("can", 0x100, true, 90, 5, 50, 8),
        ];
        let rolled = roll_up(&inventory, u32::MAX);
        let data = &rolled[&0x100];

        assert!(
            data.top.is_extended,
            "the most-seen row decides how the id renders"
        );
        assert_eq!(data.count, 93);
        assert_eq!(data.first_us, 5);
        assert_eq!(data.last_us, 50);
    }
}
