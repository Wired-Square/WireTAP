// ui/crates/wiretap-app/src/analysis.rs
//
// Source-backed analysis levers over a `PayloadSource` — a SQLite capture or a
// WireTAP backend, whose impls are `payload_source.rs`'s:
//
//   - byte_profile(s)   — per-byte roles, patterns and mux cases
//   - checksum_scan     — what explains each frame id, if anything
//   - catalog_coverage  — diff a catalog against a source + confidence rollup
//   - message_order     — per protocol and bus, over a `FrameSource`'s timed frames
//
// Most of these serve the MCP read tools and need no view open. `checksum_scan`
// and `byte_profiles` serve the Discovery panels as well, which is what stops
// the two from giving different answers about one capture.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;

use serde::{Deserialize, Serialize};
use wiretap_analysis::{analyse_order, profile_bytes, ByteProfile, FrameKey, OrderAnalysis, TimedFrame};
use wiretap_catalog::model::Confidence;

use wiretap_decode::frame_id::format_frame_id;

use crate::capture_db::InventoryRow;
use crate::capture_store::FrameSelection;
use crate::io::FrameMessage;

/// One frame's byte profile, as the Changes view and the MCP tools report it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameByteProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    pub frame_id: u32,
    pub is_extended: bool,
    pub frame_id_hex: String,
    #[serde(flatten)]
    pub profile: ByteProfile,
}

impl FrameByteProfile {
    pub fn new(protocol: Option<&str>, frame_id: u32, is_extended: bool, payloads: &[Vec<u8>]) -> Self {
        Self {
            protocol: protocol.map(str::to_owned),
            frame_id,
            is_extended,
            frame_id_hex: format_frame_id(frame_id, is_extended),
            profile: profile_bytes(payloads),
        }
    }
}

// ── The orchestrators, over any `PayloadSource` ──────────────────────────────

/// How a capture is sampled. Byte roles read consecutive pairs and want the most
/// recent contiguous run; a checksum scan wants spread across the recording.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sampling {
    Spread,
    Recent,
}

/// Which payloads to read: up to `limit` of them, oldest first. `protocol` is the
/// identity's other half and `is_extended` the tie-break; `None` matches any.
#[derive(Clone, Copy, Debug)]
pub struct PayloadQuery<'a> {
    pub protocol: Option<&'a str>,
    pub frame_id: u32,
    pub is_extended: Option<bool>,
    pub limit: u32,
    pub sampling: Sampling,
}

/// A store of recorded frames the analysis levers read: what frames it holds and
/// a sample of each one's payloads. Time bounds are RFC3339.
pub trait PayloadSource: Sync {
    fn inventory(
        &self,
        start_time: Option<&str>,
        end_time: Option<&str>,
    ) -> impl Future<Output = Result<Vec<InventoryRow>, String>> + Send;

    fn payloads(
        &self,
        query: PayloadQuery<'_>,
    ) -> impl Future<Output = Result<Vec<Vec<u8>>, String>> + Send;
}

pub async fn byte_profile(
    source: &impl PayloadSource,
    protocol: Option<&str>,
    frame_id: u32,
    is_extended: Option<bool>,
    sample_limit: u32,
) -> Result<FrameByteProfile, String> {
    let payloads = source
        .payloads(PayloadQuery {
            protocol,
            frame_id,
            is_extended,
            limit: sample_limit,
            sampling: Sampling::Recent,
        })
        .await?;
    Ok(FrameByteProfile::new(protocol, frame_id, is_extended.unwrap_or(false), &payloads))
}

/// Which frames a scan covers.
///
/// Both variants read empty as "everything", the convention `FrameSelection`
/// already documents — so neither door needs a third way to say "no filter".
pub enum ScanFilter {
    /// These ids under any protocol. What a caller holding bare numbers means,
    /// and all a CAN-only PostgreSQL archive can be asked for.
    Ids(Vec<u32>),
    /// These (protocol, id) pairs — Discovery's frame selection.
    Selection(crate::capture_store::FrameSelection),
}

impl ScanFilter {
    fn matches(&self, protocol: &str, frame_id: u32) -> bool {
        match self {
            ScanFilter::Ids(ids) => ids.is_empty() || ids.contains(&frame_id),
            ScanFilter::Selection(sel) => sel.is_empty() || sel.contains(protocol, frame_id),
        }
    }
}

/// The inventory rows `filter` selects, each with the `is_extended` to fetch it by.
///
/// A frame id is almost never both standard and extended, and filtering on
/// `is_extended` takes the payload query off its covering index. Pay for it only
/// where the inventory says the pair is genuinely ambiguous.
fn selected_rows<'a>(
    inventory: &'a [InventoryRow],
    filter: &ScanFilter,
) -> Vec<(&'a InventoryRow, Option<bool>)> {
    let mut seen: HashMap<(&str, u32), usize> = HashMap::new();
    for row in inventory {
        *seen.entry((row.protocol.as_str(), row.frame_id)).or_default() += 1;
    }
    inventory
        .iter()
        .filter(|row| filter.matches(&row.protocol, row.frame_id))
        .map(|row| {
            let ambiguous = seen[&(row.protocol.as_str(), row.frame_id)] > 1;
            (row, ambiguous.then_some(row.is_extended))
        })
        .collect()
}

/// Scan a whole source for checksums, frame id by frame id.
///
/// The one implementation behind both doors — Discovery's Checksum Discovery
/// panel and the `frame_checksum_scan` MCP tool — reading payloads straight out
/// of the capture or Postgres rather than having them shipped in over IPC.
/// The source's inventory decides which frames exist; each is then sampled and
/// analysed by the same crate code, so the two cannot give different answers
/// about the same capture.
pub async fn checksum_scan(
    source: &impl PayloadSource,
    filter: &ScanFilter,
    sample_limit: u32,
    options: wiretap_analysis::ChecksumScanOptions,
) -> Result<wiretap_analysis::ChecksumScanResult, String> {
    let inventory = source.inventory(None, None).await?;

    let mut result = wiretap_analysis::ChecksumScanResult {
        findings: Vec::new(),
        frame_count: 0,
        unique_frame_ids: 0,
        skipped_frame_ids: 0,
    };
    // Fetched a chunk at a time so at most `SCAN_CHUNK_IDS` groups are resident
    // — `sample_limit` and the id count are both unbounded — while `scan_groups`
    // still gets several ids to spread across cores. One id at a time held the
    // memory floor but cost the fan-out, which on a 60-id bus is most of the run.
    let mut chunk: Vec<(wiretap_analysis::FrameKey, Vec<Vec<u8>>)> = Vec::new();

    for (row, is_extended) in selected_rows(&inventory, filter) {
        let payloads = source
            .payloads(PayloadQuery {
                protocol: Some(&row.protocol),
                frame_id: row.frame_id,
                is_extended,
                limit: sample_limit,
                sampling: Sampling::Spread,
            })
            .await?;
        chunk.push((
            wiretap_analysis::FrameKey::new(row.frame_id, row.is_extended),
            payloads,
        ));
        if chunk.len() == SCAN_CHUNK_IDS {
            accumulate(&mut result, wiretap_analysis::scan_groups(&chunk, &options));
            chunk.clear();
        }
    }
    if !chunk.is_empty() {
        accumulate(&mut result, wiretap_analysis::scan_groups(&chunk, &options));
    }

    Ok(result)
}

/// Byte profiles for the frames `filter` selects, at most `max_frames` of them.
pub struct ByteProfiles {
    pub frames: Vec<FrameByteProfile>,
    /// Selected frames past `max_frames`, not profiled.
    pub skipped_frames: usize,
}

/// Profile each frame of a source over its most recent `sample_limit` payloads.
/// The one implementation behind Discovery's Changes view and the MCP
/// `get_discovery_analysis`, so the two describe a capture alike.
pub async fn byte_profiles(
    source: &impl PayloadSource,
    filter: &ScanFilter,
    sample_limit: u32,
    max_frames: usize,
) -> Result<ByteProfiles, String> {
    let inventory = source.inventory(None, None).await?;
    let rows = selected_rows(&inventory, filter);
    let mut frames = Vec::with_capacity(rows.len().min(max_frames));
    for &(row, is_extended) in rows.iter().take(max_frames) {
        let payloads = source
            .payloads(PayloadQuery {
                protocol: Some(&row.protocol),
                frame_id: row.frame_id,
                is_extended,
                limit: sample_limit,
                sampling: Sampling::Recent,
            })
            .await?;
        frames.push(FrameByteProfile::new(
            Some(&row.protocol),
            row.frame_id,
            row.is_extended,
            &payloads,
        ));
    }
    Ok(ByteProfiles { skipped_frames: rows.len().saturating_sub(max_frames), frames })
}

/// A store of recorded frames with their timing: a selection's frames, oldest
/// first, the newest `newest` of them when given.
pub trait FrameSource: Sync {
    fn frames(
        &self,
        selection: &FrameSelection,
        newest: Option<usize>,
    ) -> impl Future<Output = Result<Vec<FrameMessage>, String>> + Send;
}

/// One protocol's message order.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProtocolOrder {
    pub protocol: String,
    #[cfg_attr(test, ts(as = "crate::analysis_ts::OrderAnalysis"))]
    pub order: OrderAnalysis,
}

/// The frame a cycle is walked from, in place of the likeliest start ids; under
/// every protocol when none is named.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OrderStart {
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub protocol: Option<String>,
    pub frame_id: u32,
    pub is_extended: bool,
}

/// Each protocol's frames as message order reads them, oldest first.
pub fn timed_by_protocol(frames: Vec<FrameMessage>) -> BTreeMap<String, Vec<TimedFrame>> {
    let mut by_protocol: BTreeMap<String, Vec<TimedFrame>> = BTreeMap::new();
    for f in frames {
        by_protocol.entry(f.protocol).or_default().push(TimedFrame {
            bus: f.bus,
            key: FrameKey::new(f.frame_id, f.is_extended),
            timestamp_us: f.timestamp_us,
            payload: f.bytes,
        });
    }
    for frames in by_protocol.values_mut() {
        frames.sort_by_key(|f| f.timestamp_us);
    }
    by_protocol
}

/// Message order per protocol over a source's selected frames. The one
/// implementation behind Discovery's Frame Order and the MCP `get_frame_order`.
pub async fn message_order(
    source: &impl FrameSource,
    selection: &FrameSelection,
    newest: Option<usize>,
    start: Option<&OrderStart>,
) -> Result<Vec<ProtocolOrder>, String> {
    let frames = source.frames(selection, newest).await?;
    Ok(timed_by_protocol(frames)
        .into_iter()
        .map(|(protocol, frames)| {
            let start = start
                .filter(|s| s.protocol.as_ref().is_none_or(|p| *p == protocol))
                .map(|s| FrameKey::new(s.frame_id, s.is_extended));
            ProtocolOrder { order: analyse_order(&frames, start), protocol }
        })
        .collect())
}

/// Frame ids fetched before a batch is analysed. Bounds resident payloads while
/// leaving `scan_groups` enough groups to be worth parallelising.
const SCAN_CHUNK_IDS: usize = 16;

fn accumulate(
    total: &mut wiretap_analysis::ChecksumScanResult,
    part: wiretap_analysis::ChecksumScanResult,
) {
    total.findings.extend(part.findings);
    total.frame_count += part.frame_count;
    total.unique_frame_ids += part.unique_frame_ids;
    total.skipped_frame_ids += part.skipped_frame_ids;
}

// ── Catalog coverage ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
pub struct ConfidenceTally {
    pub high: usize,
    pub medium: usize,
    pub low: usize,
    pub unset: usize,
}

impl ConfidenceTally {
    fn add(&mut self, c: Option<Confidence>) {
        match c {
            Some(Confidence::High) => self.high += 1,
            Some(Confidence::Medium) => self.medium += 1,
            Some(Confidence::Low) => self.low += 1,
            Some(Confidence::None) | None => self.unset += 1,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SignalCoverage {
    pub name: String,
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PresentFrame {
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub name: Option<String>,
    pub count: i64,
    pub first_us: i64,
    pub last_us: i64,
    pub signals: Vec<SignalCoverage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_roles: Option<ByteProfile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MissingFrame {
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UncataloguedFrame {
    /// The id to add to the catalogue — masked, when the catalogue is.
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub is_extended: bool,
    pub count: i64,
    /// A raw id this was actually seen as, when that differs from `frame_id`.
    /// Absent without a `frame_id_mask`, so an ordinary report is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen_as_hex: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoverageReport {
    pub catalog: String,
    pub catalog_frames: usize,
    /// Distinct frames in the data, counted the way the catalogue counts them.
    /// Under a `frame_id_mask` that is fewer than the ids on the wire — 292
    /// against 583 on the SBR inter-tower bus — so it stays comparable with
    /// `catalog_frames` and with the `uncatalogued` list beside it.
    pub data_frames: usize,
    pub present: Vec<PresentFrame>,
    pub missing: Vec<MissingFrame>,
    pub uncatalogued: Vec<UncataloguedFrame>,
    /// Confidence rollup over directly-defined catalog signals (excludes
    /// mirror/copy-inherited duplicates).
    pub confidence: ConfidenceTally,
}

/// A human label for a frame: its catalogue name, falling back to the transmitter.
fn frame_label(f: &wiretap_catalog::model::Frame) -> Option<String> {
    f.name.clone().or_else(|| f.transmitter.clone())
}

/// The data side of one catalogue frame: every inventory row whose id maps onto
/// it, rolled up.
///
/// Without a `frame_id_mask` that is a single id, and this is the old
/// keep-the-bigger-row rule for a std/extended pair. With one it is genuinely
/// many — 583 raw ids collapse to 292 catalogue frames on the SBR inter-tower
/// bus — so the counts sum and the window widens rather than one row winning.
struct DataFrame<'a> {
    /// The most-seen contributing row. Decides how the id renders, and supplies
    /// the raw id payloads are sampled by — a masked catalogue frame has no id
    /// of its own that appears in the data, so asking for the masked one samples
    /// nothing.
    top: &'a InventoryRow,
    count: i64,
    first_us: i64,
    last_us: i64,
}

impl<'a> DataFrame<'a> {
    fn new(row: &'a InventoryRow) -> Self {
        Self { top: row, count: row.count, first_us: row.first_us, last_us: row.last_us }
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

/// Roll the inventory up onto the ids the catalogue is keyed by.
///
/// `mask` is the catalogue's `frame_id_mask`, or `u32::MAX` when it declares
/// none — in which case this is one entry per id and the merge only ever folds a
/// std/extended pair.
fn roll_up(inventory: &[InventoryRow], mask: u32) -> HashMap<u32, DataFrame<'_>> {
    let mut by_id: HashMap<u32, DataFrame> = HashMap::new();
    for row in inventory {
        by_id
            .entry(row.frame_id & mask)
            .and_modify(|d| d.merge(row))
            .or_insert_with(|| DataFrame::new(row));
    }
    by_id
}

/// Diff `catalog`, reported under `catalog_name`, against a source.
pub async fn catalog_coverage(
    source: &impl PayloadSource,
    catalog_name: &str,
    catalog: &wiretap_catalog::Catalog,
    include_byte_roles: bool,
    sample_limit: u32,
    start_time: Option<&str>,
    end_time: Option<&str>,
) -> Result<CoverageReport, String> {
    // Inventory the data source, keyed the way the catalogue is keyed.
    //
    // A catalogue may declare a `frame_id_mask` — a J1939 one strips the source
    // address, so it names each message once and matches whichever node sent it.
    // Diffing raw ids against a masked catalogue reports every frame missing:
    // measured at `present=0, missing=292` on a bus the catalogue decodes in
    // full. `decode_by_id` has always masked; this is the same rule applied to
    // the other side of the comparison.
    let mask = wiretap_catalog::decode::frame_id_mask(catalog).unwrap_or(u32::MAX);
    let inventory = source.inventory(start_time, end_time).await?;
    let data_by_id = roll_up(&inventory, mask);

    // Diff + confidence rollup.
    let mut confidence = ConfidenceTally::default();
    let mut present = Vec::new();
    let mut missing = Vec::new();
    let catalog_ids: HashSet<u32> = catalog.frames.iter().map(|f| f.frame_id).collect();

    for frame in &catalog.frames {
        let sigs = frame.own_signals();
        for s in &sigs {
            confidence.add(s.confidence);
        }

        match data_by_id.get(&frame.frame_id) {
            Some(data) => {
                let byte_roles = if include_byte_roles {
                    // `data_by_id` is keyed on the masked id, so this row is not
                    // authoritative about protocol — asking for any keeps the
                    // roles describing the same frames the row was counted from.
                    // Sampled by a raw id that actually occurs: under a mask the
                    // catalogue's own id never does.
                    let payloads = source
                        .payloads(PayloadQuery {
                            protocol: None,
                            frame_id: data.top.frame_id,
                            // The sampled row's own answer, not the catalogue's — a
                            // disagreement here filters out the very id being
                            // sampled and returns nothing.
                            is_extended: Some(data.top.is_extended),
                            limit: sample_limit,
                            sampling: Sampling::Recent,
                        })
                        .await
                        .unwrap_or_default();
                    Some(profile_bytes(&payloads))
                } else {
                    None
                };
                present.push(PresentFrame {
                    frame_id: frame.frame_id,
                    frame_id_hex: format_frame_id(frame.frame_id, data.top.is_extended),
                    name: frame_label(frame),
                    count: data.count,
                    first_us: data.first_us,
                    last_us: data.last_us,
                    signals: sigs
                        .iter()
                        .filter_map(|s| {
                            s.name.clone().map(|name| SignalCoverage {
                                name,
                                confidence: s
                                    .confidence
                                    .filter(|c| *c != Confidence::None)
                                    .map_or("unset", Confidence::as_str)
                                    .into(),
                            })
                        })
                        .collect(),
                    byte_roles,
                });
            }
            None => missing.push(MissingFrame {
                frame_id: frame.frame_id,
                frame_id_hex: format_frame_id(frame.frame_id, frame.is_extended.unwrap_or(false)),
                name: frame_label(frame),
            }),
        }
    }

    // Data frames the catalog doesn't describe — read off the same rollup, so
    // all three sections of the report count the same things. Reported by the
    // id you would *add to the catalogue*: under a mask, one unknown message
    // sent by five nodes is one missing frame, not five. The raw id rides
    // along so it can still be found on the wire. (The rollup already merged
    // the std/extended pair, so there is nothing left to de-dup.)
    let mut uncatalogued: Vec<UncataloguedFrame> = data_by_id
        .iter()
        .filter(|(id, _)| !catalog_ids.contains(id))
        .map(|(id, d)| UncataloguedFrame {
            frame_id: *id,
            frame_id_hex: format_frame_id(*id, d.top.is_extended),
            is_extended: d.top.is_extended,
            count: d.count,
            seen_as_hex: (d.top.frame_id != *id)
                .then(|| format_frame_id(d.top.frame_id, d.top.is_extended)),
        })
        .collect();
    uncatalogued.sort_by_key(|f| f.frame_id);

    Ok(CoverageReport {
        catalog: catalog_name.to_owned(),
        catalog_frames: catalog.frames.len(),
        data_frames: data_by_id.len(),
        present,
        missing,
        uncatalogued,
        confidence,
    })
}

#[cfg(test)]
pub(crate) mod memory {
    use std::sync::Mutex;

    use super::*;

    /// Frames in arrival order. `Recent` reads the tail, `Spread` strides the lot.
    #[derive(Default)]
    pub struct MemorySource {
        frames: Vec<FrameMessage>,
        pub asked: Mutex<Vec<(u32, Option<bool>, Sampling)>>,
    }

    impl MemorySource {
        /// A bus-0 frame stamped with its arrival index.
        pub fn push(&mut self, protocol: &str, frame_id: u32, is_extended: bool, bytes: Vec<u8>) {
            let timestamp_us = self.frames.len() as u64;
            self.push_at(protocol, 0, frame_id, is_extended, timestamp_us, bytes);
        }

        pub fn push_at(
            &mut self,
            protocol: &str,
            bus: u8,
            frame_id: u32,
            is_extended: bool,
            timestamp_us: u64,
            bytes: Vec<u8>,
        ) {
            self.frames.push(FrameMessage {
                protocol: protocol.into(),
                timestamp_us,
                frame_id,
                bus,
                dlc: bytes.len() as u16,
                bytes,
                is_extended,
                ..Default::default()
            });
        }
    }

    impl PayloadSource for MemorySource {
        async fn inventory(
            &self,
            _: Option<&str>,
            _: Option<&str>,
        ) -> Result<Vec<InventoryRow>, String> {
            let mut rows: Vec<InventoryRow> = Vec::new();
            for f in &self.frames {
                let t = f.timestamp_us as i64;
                match rows.iter_mut().find(|r| {
                    r.protocol == f.protocol && r.frame_id == f.frame_id && r.is_extended == f.is_extended
                }) {
                    Some(row) => {
                        row.count += 1;
                        row.last_us = t;
                    }
                    None => rows.push(InventoryRow::new(&f.protocol, f.frame_id, f.is_extended, 1, t, t, f.dlc)),
                }
            }
            Ok(rows)
        }

        async fn payloads(&self, q: PayloadQuery<'_>) -> Result<Vec<Vec<u8>>, String> {
            self.asked.lock().unwrap().push((q.frame_id, q.is_extended, q.sampling));
            let matching: Vec<Vec<u8>> = self
                .frames
                .iter()
                .filter(|f| {
                    f.frame_id == q.frame_id
                        && q.protocol.is_none_or(|p| p == f.protocol)
                        && q.is_extended.is_none_or(|e| e == f.is_extended)
                })
                .map(|f| f.bytes.clone())
                .collect();
            let limit = q.limit as usize;
            Ok(match q.sampling {
                Sampling::Recent => matching[matching.len().saturating_sub(limit)..].to_vec(),
                Sampling::Spread => {
                    let step = matching.len().div_ceil(limit.max(1)).max(1);
                    matching.into_iter().step_by(step).collect()
                }
            })
        }
    }

    impl FrameSource for MemorySource {
        async fn frames(
            &self,
            selection: &FrameSelection,
            newest: Option<usize>,
        ) -> Result<Vec<FrameMessage>, String> {
            let selected: Vec<FrameMessage> = self
                .frames
                .iter()
                .filter(|f| selection.is_empty() || selection.contains(&f.protocol, f.frame_id))
                .cloned()
                .collect();
            let skip = newest.map_or(0, |n| selected.len().saturating_sub(n));
            Ok(selected[skip..].to_vec())
        }
    }
}

#[cfg(test)]
mod orchestrator_tests {
    use wiretap_analysis::{ByteRole, Direction};

    use super::memory::MemorySource;
    use super::*;

    fn counter_source(frames: u8) -> MemorySource {
        let mut source = MemorySource::default();
        for i in 0..frames {
            source.push("can", 0x100, false, vec![0xC0, i]);
        }
        source
    }

    #[tokio::test]
    async fn byte_profiles_read_each_frames_most_recent_run() {
        let source = counter_source(50);

        let profiles = byte_profiles(&source, &ScanFilter::Ids(vec![]), 10, usize::MAX).await.unwrap();

        let profile = &profiles.frames[0].profile;
        assert_eq!(profile.sample_count, 10);
        assert_eq!(profile.columns[1].stats.min, 40, "the newest ten, not the first");
        assert!(matches!(
            profile.columns[1].role,
            ByteRole::Counter { direction: Direction::Up, step: 1, .. }
        ));
    }

    #[tokio::test]
    async fn a_checksum_scan_samples_across_the_recording() {
        let source = counter_source(50);

        checksum_scan(&source, &ScanFilter::Ids(vec![]), 10, Default::default()).await.unwrap();

        assert_eq!(*source.asked.lock().unwrap(), vec![(0x100, None, Sampling::Spread)]);
    }

    #[tokio::test]
    async fn only_an_id_seen_both_standard_and_extended_is_fetched_by_its_width() {
        let mut source = MemorySource::default();
        source.push("can", 0x100, false, vec![1]);
        source.push("can", 0x100, true, vec![2]);
        source.push("can", 0x200, false, vec![3]);

        let profiles = byte_profiles(&source, &ScanFilter::Ids(vec![]), 10, usize::MAX).await.unwrap();

        assert_eq!(profiles.frames.len(), 3);
        let asked: Vec<_> = source.asked.lock().unwrap().iter().map(|a| (a.0, a.1)).collect();
        assert_eq!(asked, vec![(0x100, Some(false)), (0x100, Some(true)), (0x200, None)]);
    }

    #[tokio::test]
    async fn frames_past_max_frames_are_counted_not_profiled() {
        let mut source = MemorySource::default();
        for id in 0..5 {
            source.push("can", id, false, vec![0]);
        }

        let profiles = byte_profiles(&source, &ScanFilter::Ids(vec![]), 10, 2).await.unwrap();

        assert_eq!(profiles.frames.len(), 2);
        assert_eq!(profiles.skipped_frames, 3);
    }
}

#[cfg(test)]
mod coverage_tests {
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

        assert_eq!(rolled.len(), 1, "three source addresses, one catalogue frame");
        let data = &rolled[&0x1802_FF00];
        assert_eq!(data.count, 45, "counts sum across contributing ids");
        assert_eq!(data.first_us, 100, "the window starts at the earliest");
        assert_eq!(data.last_us, 3000, "and ends at the latest");
        assert_eq!(
            data.top.frame_id, 0x1802_FF02,
            "payloads sample by the most-seen raw id — the masked id is not on the wire"
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

        assert!(data.top.is_extended, "the most-seen row decides how the id renders");
        assert_eq!(data.count, 93);
        assert_eq!(data.first_us, 5);
        assert_eq!(data.last_us, 50);
    }
}
