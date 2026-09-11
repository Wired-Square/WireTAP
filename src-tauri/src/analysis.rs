// ui/src-tauri/src/analysis.rs
//
// Source-backed analysis levers. Works against either a SQLite capture
// (`capture_id`) or a WireTAP backend (`profile_id`):
//
//   - frame_inventory   — per-frame-id rollup (count, first/last, dlc)
//   - byte_profile      — per-byte static/counter/sensor roles for one frame
//   - checksum_scan     — what explains each frame id, if anything
//   - catalog_coverage  — diff a catalog against a source + confidence rollup
//
// Most of these serve the MCP read tools and need no view open. `checksum_scan`
// serves the Discovery panel as well, which is what stops the two from giving
// different answers about one capture.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tauri::AppHandle;
use wiretap_catalog::model::{Confidence, Signal};

use crate::capture_db::{hex_id, InventoryRow};

/// Where a query runs: a SQLite capture or a WireTAP backend profile.
pub enum QuerySource {
    Capture(String),
    Backend(String),
}

/// Resolve the source from the dual `capture_id` / `profile_id` MCP params.
pub fn resolve(
    capture_id: Option<String>,
    profile_id: Option<String>,
) -> Result<QuerySource, String> {
    match (capture_id, profile_id) {
        (Some(c), None) => Ok(QuerySource::Capture(c)),
        (None, Some(p)) => Ok(QuerySource::Backend(p)),
        (Some(_), Some(_)) => Err("Provide exactly one of capture_id / profile_id, not both".into()),
        (None, None) => Err("Provide one of capture_id or profile_id".into()),
    }
}

// ── Result types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ByteStat {
    pub index: usize,
    pub distinct: usize,
    pub min: u8,
    pub max: u8,
    pub changes: usize,
    /// "static" (never changes), "counter" (dominant fixed step) or "sensor".
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ByteProfile {
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub sampled: usize,
    pub max_len: usize,
    pub bytes: Vec<ByteStat>,
}

// ── Pure byte-role analysis ──────────────────────────────────────────────────

/// Classify each byte position across a set of payloads into static / counter /
/// sensor, with distinct/min/max/change counts. Pure and headless.
pub fn compute_byte_profile(payloads: &[Vec<u8>]) -> (usize, Vec<ByteStat>) {
    let max_len = payloads.iter().map(|p| p.len()).max().unwrap_or(0);
    let mut bytes = Vec::with_capacity(max_len);

    for index in 0..max_len {
        // Values at this position, in order, from payloads long enough to have it.
        let values: Vec<u8> = payloads.iter().filter_map(|p| p.get(index).copied()).collect();
        if values.is_empty() {
            continue;
        }

        let distinct: HashSet<u8> = values.iter().copied().collect();
        let min = *values.iter().min().unwrap();
        let max = *values.iter().max().unwrap();

        // Transition deltas (wrapping) to detect counters and count changes.
        let mut deltas: HashMap<u8, usize> = HashMap::new();
        for w in values.windows(2) {
            *deltas.entry(w[1].wrapping_sub(w[0])).or_default() += 1;
        }
        let transitions = values.len().saturating_sub(1);
        let changes: usize = deltas.iter().filter(|(d, _)| **d != 0).map(|(_, c)| c).sum();

        let role = if changes == 0 {
            "static"
        } else {
            // A counter has one dominant non-zero step covering most transitions.
            let modal = deltas.iter().filter(|(d, _)| **d != 0).map(|(_, c)| *c).max().unwrap_or(0);
            if transitions > 0 && (modal as f64 / transitions as f64) >= 0.8 {
                "counter"
            } else {
                "sensor"
            }
        };

        bytes.push(ByteStat { index, distinct: distinct.len(), min, max, changes, role: role.into() });
    }

    (max_len, bytes)
}

/// Parse an RFC3339 timestamp into epoch microseconds (capture timeline). Also
/// accepts a bare integer treated as already-µs.
pub fn iso_to_micros(s: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_micros());
    }
    s.trim().parse::<i64>().ok()
}

// ── Source-dispatching orchestrators ─────────────────────────────────────────

pub async fn frame_inventory(
    app: &AppHandle,
    src: &QuerySource,
    start_time: Option<String>,
    end_time: Option<String>,
) -> Result<Vec<InventoryRow>, String> {
    match src {
        QuerySource::Backend(pid) => {
            crate::dbquery::db_frame_inventory(app, pid, start_time, end_time).await
        }
        QuerySource::Capture(cid) => crate::capture_db::frame_inventory(
            cid,
            start_time.as_deref().and_then(iso_to_micros),
            end_time.as_deref().and_then(iso_to_micros),
        ),
    }
}

/// The Query app's per-id rollup, over either source. Time bounds are RFC3339.
#[tauri::command]
pub async fn query_frame_inventory(
    app: AppHandle,
    capture_id: Option<String>,
    profile_id: Option<String>,
    start_time: Option<String>,
    end_time: Option<String>,
) -> Result<Vec<InventoryRow>, String> {
    let src = resolve(capture_id, profile_id)?;
    frame_inventory(&app, &src, start_time, end_time).await
}

/// `protocol` is the identity's other half; `None` matches any.
async fn fetch_payloads(
    app: &AppHandle,
    src: &QuerySource,
    protocol: Option<&str>,
    frame_id: u32,
    is_extended: Option<bool>,
    sample_limit: u32,
) -> Result<Vec<Vec<u8>>, String> {
    match src {
        // No protocol and no stride: a backend profile reads one protocol, and a
        // modulo window over a multi-month archive is a full scan where the
        // tail query is an index seek. A capture is bounded and local, which is
        // what makes striding it affordable.
        QuerySource::Backend(pid) => {
            crate::dbquery::db_fetch_frame_payloads(app, pid, frame_id, is_extended, sample_limit)
                .await
        }
        QuerySource::Capture(cid) => crate::capture_db::sample_frame_payloads(
            cid,
            protocol,
            frame_id,
            is_extended,
            sample_limit,
        ),
    }
}

pub async fn byte_profile(
    app: &AppHandle,
    src: &QuerySource,
    protocol: Option<&str>,
    frame_id: u32,
    is_extended: Option<bool>,
    sample_limit: u32,
) -> Result<ByteProfile, String> {
    let payloads = fetch_payloads(app, src, protocol, frame_id, is_extended, sample_limit).await?;
    let (max_len, bytes) = compute_byte_profile(&payloads);
    Ok(ByteProfile {
        frame_id,
        frame_id_hex: hex_id(frame_id, is_extended.unwrap_or(false)),
        sampled: payloads.len(),
        max_len,
        bytes,
    })
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

/// Scan a whole source for checksums, frame id by frame id.
///
/// The one implementation behind both doors — Discovery's Checksum Discovery
/// panel and the `frame_checksum_scan` MCP tool — reading payloads straight out
/// of the capture or Postgres rather than having them shipped in over IPC.
/// `frame_inventory` decides which frames exist; each is then sampled and
/// analysed by the same crate code, so the two cannot give different answers
/// about the same capture.
pub async fn checksum_scan(
    app: &AppHandle,
    src: &QuerySource,
    filter: &ScanFilter,
    sample_limit: u32,
    options: wiretap_analysis::ChecksumScanOptions,
) -> Result<wiretap_analysis::ChecksumScanResult, String> {
    let inventory = frame_inventory(app, src, None, None).await?;

    // A frame id is almost never both standard and extended, and filtering on
    // `is_extended` takes the payload query off its covering index. Pay for it
    // only where the inventory says the pair is genuinely ambiguous.
    let mut seen: HashMap<(&str, u32), usize> = HashMap::new();
    for row in &inventory {
        *seen.entry((row.protocol.as_str(), row.frame_id)).or_default() += 1;
    }

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

    for row in &inventory {
        if !filter.matches(&row.protocol, row.frame_id) {
            continue;
        }
        let ambiguous = seen[&(row.protocol.as_str(), row.frame_id)] > 1;
        let payloads = fetch_payloads(
            app,
            src,
            Some(&row.protocol),
            row.frame_id,
            ambiguous.then_some(row.is_extended),
            sample_limit,
        )
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
    pub byte_roles: Option<Vec<ByteStat>>,
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

/// Collect every directly-defined signal of a frame (own + mux cases, nested),
/// skipping mirror/copy-inherited duplicates so each definition counts once.
fn collect_signals<'a>(signals: &'a [Signal], out: &mut Vec<&'a Signal>) {
    for s in signals {
        if !s.inherited {
            out.push(s);
        }
    }
}

fn collect_frame_signals(frame: &wiretap_catalog::model::Frame) -> Vec<&Signal> {
    let mut out = Vec::new();
    collect_signals(&frame.signals, &mut out);
    if let Some(mux) = &frame.mux {
        collect_mux(mux, &mut out);
    }
    out
}

fn collect_mux<'a>(mux: &'a wiretap_catalog::model::Mux, out: &mut Vec<&'a Signal>) {
    for case in mux.cases.values() {
        collect_signals(&case.signals, out);
        if let Some(inner) = &case.mux {
            collect_mux(inner, out);
        }
    }
}

fn confidence_str(c: Option<Confidence>) -> &'static str {
    match c {
        Some(Confidence::High) => "high",
        Some(Confidence::Medium) => "medium",
        Some(Confidence::Low) => "low",
        Some(Confidence::None) | None => "unset",
    }
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

pub async fn catalog_coverage(
    app: &AppHandle,
    src: &QuerySource,
    catalog_name: &str,
    include_byte_roles: bool,
    sample_limit: u32,
    start_time: Option<String>,
    end_time: Option<String>,
) -> Result<CoverageReport, String> {
    // 1. Load + parse the catalog (reuse the MCP catalog resolution).
    let catalogs = crate::catalog::list_catalogs(app.clone()).await?;
    let entry = catalogs
        .iter()
        .find(|c| c.filename == catalog_name || c.name == catalog_name)
        .ok_or_else(|| format!("Catalog '{}' not found — use list_catalogs", catalog_name))?;
    let toml = crate::catalog::open_catalog(entry.path.clone()).await?;
    let catalog = wiretap_catalog::Catalog::parse(&toml).map_err(|e| e.to_string())?;

    // 2. Inventory the data source, keyed the way the catalogue is keyed.
    //
    // A catalogue may declare a `frame_id_mask` — a J1939 one strips the source
    // address, so it names each message once and matches whichever node sent it.
    // Diffing raw ids against a masked catalogue reports every frame missing:
    // measured at `present=0, missing=292` on a bus the catalogue decodes in
    // full. `decode_by_id` has always masked; this is the same rule applied to
    // the other side of the comparison.
    let mask = wiretap_catalog::decode::frame_id_mask(&catalog).unwrap_or(u32::MAX);
    let inventory = frame_inventory(app, src, start_time, end_time).await?;
    let data_by_id = roll_up(&inventory, mask);

    // 3. Diff + confidence rollup.
    let mut confidence = ConfidenceTally::default();
    let mut present = Vec::new();
    let mut missing = Vec::new();
    let catalog_ids: HashSet<u32> = catalog.frames.iter().map(|f| f.frame_id).collect();

    for frame in &catalog.frames {
        let sigs = collect_frame_signals(frame);
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
                    let payloads = fetch_payloads(
                        app,
                        src,
                        None,
                        data.top.frame_id,
                        // The sampled row's own answer, not the catalogue's — a
                        // disagreement here filters out the very id being
                        // sampled and returns nothing.
                        Some(data.top.is_extended),
                        sample_limit,
                    )
                    .await
                    .unwrap_or_default();
                    Some(compute_byte_profile(&payloads).1)
                } else {
                    None
                };
                present.push(PresentFrame {
                    frame_id: frame.frame_id,
                    frame_id_hex: hex_id(frame.frame_id, data.top.is_extended),
                    name: frame_label(frame),
                    count: data.count,
                    first_us: data.first_us,
                    last_us: data.last_us,
                    signals: sigs
                        .iter()
                        .filter_map(|s| {
                            s.name.clone().map(|name| SignalCoverage {
                                name,
                                confidence: confidence_str(s.confidence).into(),
                            })
                        })
                        .collect(),
                    byte_roles,
                });
            }
            None => missing.push(MissingFrame {
                frame_id: frame.frame_id,
                frame_id_hex: hex_id(frame.frame_id, frame.is_extended.unwrap_or(false)),
                name: frame_label(frame),
            }),
        }
    }

    // 4. Data frames the catalog doesn't describe — read off the same rollup, so
    //    all three sections of the report count the same things. Reported by the
    //    id you would *add to the catalogue*: under a mask, one unknown message
    //    sent by five nodes is one missing frame, not five. The raw id rides
    //    along so it can still be found on the wire. (The rollup already merged
    //    the std/extended pair, so there is nothing left to de-dup.)
    let mut uncatalogued: Vec<UncataloguedFrame> = data_by_id
        .iter()
        .filter(|(id, _)| !catalog_ids.contains(id))
        .map(|(id, d)| UncataloguedFrame {
            frame_id: *id,
            frame_id_hex: hex_id(*id, d.top.is_extended),
            is_extended: d.top.is_extended,
            count: d.count,
            seen_as_hex: (d.top.frame_id != *id)
                .then(|| hex_id(d.top.frame_id, d.top.is_extended)),
        })
        .collect();
    uncatalogued.sort_by_key(|f| f.frame_id);

    Ok(CoverageReport {
        catalog: entry.name.clone(),
        catalog_frames: catalog.frames.len(),
        data_frames: data_by_id.len(),
        present,
        missing,
        uncatalogued,
        confidence,
    })
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
