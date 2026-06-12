// ui/src-tauri/src/analysis.rs
//
// Headless analysis levers shared by the MCP read tools. Works against either a
// SQLite capture (`capture_id`) or a PostgreSQL profile (`profile_id`):
//
//   - frame_inventory   — per-frame-id rollup (count, first/last, dlc)
//   - byte_profile      — per-byte static/counter/sensor roles for one frame
//   - catalog_coverage  — diff a catalog against a source + confidence rollup
//
// The byte-role classifier (`compute_byte_profile`) is the headless Rust
// equivalent of the frontend Discovery analysis — it needs no view open.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tauri::AppHandle;
use wiretap_catalog::model::{Confidence, Signal};

/// Format a frame id as hex with the conventional padding (3 nibbles for
/// standard ids, 8 for extended), matching the frontend's `formatFrameId`.
fn hex_id(id: u32, is_extended: bool) -> String {
    let width = if is_extended { 8 } else { 3 };
    format!("0x{:0width$X}", id, width = width)
}

/// Where a query runs: a SQLite capture or a PostgreSQL profile.
pub enum QuerySource {
    Capture(String),
    Postgres(String),
}

/// Resolve the source from the dual `capture_id` / `profile_id` MCP params.
pub fn resolve(
    capture_id: Option<String>,
    profile_id: Option<String>,
) -> Result<QuerySource, String> {
    match (capture_id, profile_id) {
        (Some(c), None) => Ok(QuerySource::Capture(c)),
        (None, Some(p)) => Ok(QuerySource::Postgres(p)),
        (Some(_), Some(_)) => Err("Provide exactly one of capture_id / profile_id, not both".into()),
        (None, None) => Err("Provide one of capture_id or profile_id".into()),
    }
}

// ── Result types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FrameInventoryRow {
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub is_extended: bool,
    pub count: i64,
    pub first_us: i64,
    pub last_us: i64,
    pub max_dlc: u8,
}

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
) -> Result<Vec<FrameInventoryRow>, String> {
    let raw = match src {
        QuerySource::Postgres(pid) => {
            crate::dbquery::db_frame_inventory(app, pid, start_time, end_time).await?
        }
        QuerySource::Capture(cid) => crate::capture_db::frame_inventory(
            cid,
            start_time.as_deref().and_then(iso_to_micros),
            end_time.as_deref().and_then(iso_to_micros),
        )?,
    };
    Ok(raw
        .into_iter()
        .map(|(frame_id, is_extended, count, first_us, last_us, max_dlc)| FrameInventoryRow {
            frame_id,
            frame_id_hex: hex_id(frame_id, is_extended),
            is_extended,
            count,
            first_us,
            last_us,
            max_dlc,
        })
        .collect())
}

/// Fetch up to `sample_limit` payloads for one frame from a capture.
fn capture_payloads(
    capture_id: &str,
    frame_id: u32,
    is_extended: Option<bool>,
    sample_limit: u32,
) -> Result<Vec<Vec<u8>>, String> {
    let mut sql =
        String::from("SELECT payload FROM frames WHERE capture_id = ?1 AND frame_id = ?2");
    let mut bind: Vec<Box<dyn rusqlite::types::ToSql>> =
        vec![Box::new(capture_id.to_string()), Box::new(frame_id as i64)];
    let mut idx = 3;
    if let Some(ext) = is_extended {
        sql.push_str(&format!(" AND is_extended = ?{}", idx));
        bind.push(Box::new(ext as i32));
        idx += 1;
    }
    // Most recent N (rowid is insertion/time order) — see db_fetch_frame_payloads.
    sql.push_str(&format!(" ORDER BY rowid DESC LIMIT ?{}", idx));
    bind.push(Box::new(sample_limit as i64));

    let refs: Vec<&dyn rusqlite::types::ToSql> = bind.iter().map(|b| b.as_ref()).collect();
    crate::capture_db::query_payloads(&sql, &refs)
}

async fn fetch_payloads(
    app: &AppHandle,
    src: &QuerySource,
    frame_id: u32,
    is_extended: Option<bool>,
    sample_limit: u32,
) -> Result<Vec<Vec<u8>>, String> {
    match src {
        QuerySource::Postgres(pid) => {
            crate::dbquery::db_fetch_frame_payloads(app, pid, frame_id, is_extended, sample_limit)
                .await
        }
        QuerySource::Capture(cid) => capture_payloads(cid, frame_id, is_extended, sample_limit),
    }
}

pub async fn byte_profile(
    app: &AppHandle,
    src: &QuerySource,
    frame_id: u32,
    is_extended: Option<bool>,
    sample_limit: u32,
) -> Result<ByteProfile, String> {
    let payloads = fetch_payloads(app, src, frame_id, is_extended, sample_limit).await?;
    let (max_len, bytes) = compute_byte_profile(&payloads);
    Ok(ByteProfile {
        frame_id,
        frame_id_hex: hex_id(frame_id, is_extended.unwrap_or(false)),
        sampled: payloads.len(),
        max_len,
        bytes,
    })
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
    pub frame_id: u32,
    pub frame_id_hex: String,
    pub is_extended: bool,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoverageReport {
    pub catalog: String,
    pub catalog_frames: usize,
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

    // 2. Inventory the data source.
    let inventory = frame_inventory(app, src, start_time, end_time).await?;
    let mut data_by_id: HashMap<u32, &FrameInventoryRow> = HashMap::new();
    for row in &inventory {
        // Keep the highest-count row when an id appears as both std/extended.
        data_by_id
            .entry(row.frame_id)
            .and_modify(|e| {
                if row.count > e.count {
                    *e = row;
                }
            })
            .or_insert(row);
    }

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
            Some(row) => {
                let byte_roles = if include_byte_roles {
                    let payloads =
                        fetch_payloads(app, src, frame.frame_id, frame.is_extended, sample_limit)
                            .await
                            .unwrap_or_default();
                    Some(compute_byte_profile(&payloads).1)
                } else {
                    None
                };
                present.push(PresentFrame {
                    frame_id: frame.frame_id,
                    frame_id_hex: hex_id(frame.frame_id, row.is_extended),
                    name: frame_label(frame),
                    count: row.count,
                    first_us: row.first_us,
                    last_us: row.last_us,
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

    // 4. Data frames the catalog doesn't describe.
    let mut uncatalogued: Vec<UncataloguedFrame> = inventory
        .iter()
        .filter(|r| !catalog_ids.contains(&r.frame_id))
        .map(|r| UncataloguedFrame {
            frame_id: r.frame_id,
            frame_id_hex: r.frame_id_hex.clone(),
            is_extended: r.is_extended,
            count: r.count,
        })
        .collect();
    uncatalogued.sort_by_key(|f| f.frame_id);
    // De-dup ids that appeared as both std + extended.
    uncatalogued.dedup_by_key(|f| f.frame_id);

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
