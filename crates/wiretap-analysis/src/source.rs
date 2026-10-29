//! The analysis levers over a store of recorded frames, whatever holds them: a
//! [`PayloadSource`] answers byte profiles, a checksum scan and catalogue
//! coverage, and a [`FrameSource`] message order. The store's impls are the
//! consumer's; with `testing`, `MemorySource` holds frames for a test.
//!
//! Each lever is the one implementation behind every door onto it, a panel and
//! an MCP tool alike, so the two cannot describe one capture differently.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;

use serde::{Deserialize, Serialize};
use wslib_wiretap_protocol::format_frame_id;

use crate::order::{analyse_order, OrderAnalysis, TimedFrame};
use crate::roles::{profile_bytes, ByteProfile};
use crate::scan::{scan_groups, ChecksumScanOptions, ChecksumScanResult, FrameKey};

mod coverage;
#[cfg(feature = "testing")]
mod memory;

pub use coverage::{
    catalog_coverage, ConfidenceTally, CoverageConfidence, CoverageReport, MissingFrame,
    PresentFrame, SignalCoverage, UncataloguedFrame,
};
#[cfg(feature = "testing")]
pub use memory::MemorySource;
pub use wslib_wiretap_protocol::{
    FrameSelection, InventoryRow, PayloadQuery, ProtocolFrames, Sampling,
};

/// A store of recorded frames, owning the one error its reads return.
pub trait Source: Sync {
    type Error;
}

/// A store of recorded frames the analysis levers read: what frames it holds and
/// a sample of each one's payloads. Time bounds are epoch µs.
pub trait PayloadSource: Source {
    fn inventory(
        &self,
        start_us: Option<i64>,
        end_us: Option<i64>,
    ) -> impl Future<Output = Result<Vec<InventoryRow>, Self::Error>> + Send;

    fn payloads(
        &self,
        query: PayloadQuery<'_>,
    ) -> impl Future<Output = Result<Vec<Vec<u8>>, Self::Error>> + Send;
}

/// One frame as a [`FrameSource`] holds it: its protocol, and the frame as
/// message order reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFrame {
    pub protocol: String,
    pub frame: TimedFrame,
}

/// A store of recorded frames with their timing: a selection's frames, oldest
/// first, the newest `newest` of them when given.
pub trait FrameSource: Source {
    fn frames(
        &self,
        selection: &FrameSelection,
        newest: Option<usize>,
    ) -> impl Future<Output = Result<Vec<SourceFrame>, Self::Error>> + Send;
}

/// One frame's byte profile, as the Changes view and the MCP tools report it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FrameByteProfile {
    #[cfg_attr(feature = "ts", ts(optional))]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    pub frame_id: u32,
    pub is_extended: bool,
    pub frame_id_hex: String,
    #[serde(flatten)]
    pub profile: ByteProfile,
}

impl FrameByteProfile {
    pub fn new(
        protocol: Option<&str>,
        frame_id: u32,
        is_extended: bool,
        payloads: &[Vec<u8>],
    ) -> Self {
        Self {
            protocol: protocol.map(str::to_owned),
            frame_id,
            is_extended,
            frame_id_hex: format_frame_id(frame_id, is_extended),
            profile: profile_bytes(payloads),
        }
    }
}

/// One frame's profile over its most recent `sample_limit` payloads.
pub async fn byte_profile<S: PayloadSource>(
    source: &S,
    protocol: Option<&str>,
    frame_id: u32,
    is_extended: Option<bool>,
    sample_limit: u32,
) -> Result<FrameByteProfile, S::Error> {
    let payloads = source
        .payloads(PayloadQuery {
            protocol,
            frame_id,
            is_extended,
            limit: sample_limit,
            sampling: Sampling::Recent,
        })
        .await?;
    Ok(FrameByteProfile::new(
        protocol,
        frame_id,
        is_extended.unwrap_or(false),
        &payloads,
    ))
}

/// Which frames a scan covers. Both read empty as "everything", as
/// [`FrameSelection`] does.
#[derive(Debug, Clone)]
pub enum ScanFilter {
    /// These ids under any protocol: what a caller holding bare numbers means,
    /// and all a CAN-only archive can be asked for.
    Ids(Vec<u32>),
    /// These (protocol, id) pairs.
    Selection(FrameSelection),
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
        *seen
            .entry((row.protocol.as_str(), row.frame_id))
            .or_default() += 1;
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

/// Frame ids fetched before a batch is analysed. Bounds resident payloads while
/// leaving [`scan_groups`] enough groups to be worth parallelising.
const SCAN_CHUNK_IDS: usize = 16;

/// A whole source scanned for checksums, frame id by frame id, each sampled
/// across the recording.
pub async fn checksum_scan<S: PayloadSource>(
    source: &S,
    filter: &ScanFilter,
    sample_limit: u32,
    options: ChecksumScanOptions,
) -> Result<ChecksumScanResult, S::Error> {
    let inventory = source.inventory(None, None).await?;

    let mut result = ChecksumScanResult {
        findings: Vec::new(),
        frame_count: 0,
        unique_frame_ids: 0,
        skipped_frame_ids: 0,
    };
    let mut chunk: Vec<(FrameKey, Vec<Vec<u8>>)> = Vec::new();
    let mut accumulate = |chunk: &[(FrameKey, Vec<Vec<u8>>)]| {
        let part = scan_groups(chunk, &options);
        result.findings.extend(part.findings);
        result.frame_count += part.frame_count;
        result.unique_frame_ids += part.unique_frame_ids;
        result.skipped_frame_ids += part.skipped_frame_ids;
    };

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
        chunk.push((FrameKey::new(row.frame_id, row.is_extended), payloads));
        if chunk.len() == SCAN_CHUNK_IDS {
            accumulate(&chunk);
            chunk.clear();
        }
    }
    if !chunk.is_empty() {
        accumulate(&chunk);
    }

    Ok(result)
}

/// Byte profiles for the frames a filter selects, at most `max_frames` of them.
#[derive(Debug, Clone, PartialEq)]
pub struct ByteProfiles {
    pub frames: Vec<FrameByteProfile>,
    /// Selected frames past `max_frames`, not profiled.
    pub skipped_frames: usize,
}

/// Each frame of a source profiled over its most recent `sample_limit` payloads.
pub async fn byte_profiles<S: PayloadSource>(
    source: &S,
    filter: &ScanFilter,
    sample_limit: u32,
    max_frames: usize,
) -> Result<ByteProfiles, S::Error> {
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
    Ok(ByteProfiles {
        skipped_frames: rows.len().saturating_sub(max_frames),
        frames,
    })
}

/// One protocol's message order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct ProtocolOrder {
    pub protocol: String,
    pub order: OrderAnalysis,
}

/// The frame a cycle is walked from, in place of the likeliest start ids; under
/// every protocol when none is named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OrderStart {
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub protocol: Option<String>,
    pub frame_id: u32,
    pub is_extended: bool,
}

/// Each protocol's frames as message order reads them, oldest first.
pub fn timed_by_protocol(frames: Vec<SourceFrame>) -> BTreeMap<String, Vec<TimedFrame>> {
    let mut by_protocol: BTreeMap<String, Vec<TimedFrame>> = BTreeMap::new();
    for f in frames {
        by_protocol.entry(f.protocol).or_default().push(f.frame);
    }
    for frames in by_protocol.values_mut() {
        frames.sort_by_key(|f| f.timestamp_us);
    }
    by_protocol
}

/// Message order per protocol over a source's selected frames.
pub async fn message_order<S: FrameSource>(
    source: &S,
    selection: &FrameSelection,
    newest: Option<usize>,
    start: Option<&OrderStart>,
) -> Result<Vec<ProtocolOrder>, S::Error> {
    let frames = source.frames(selection, newest).await?;
    Ok(orders_of(timed_by_protocol(frames), start))
}

/// Message order per protocol over frames already read.
pub fn orders_of(
    timed: BTreeMap<String, Vec<TimedFrame>>,
    start: Option<&OrderStart>,
) -> Vec<ProtocolOrder> {
    timed
        .into_iter()
        .map(|(protocol, frames)| {
            let start = start
                .filter(|s| s.protocol.as_ref().is_none_or(|p| *p == protocol))
                .map(|s| FrameKey::new(s.frame_id, s.is_extended));
            ProtocolOrder {
                order: analyse_order(&frames, start),
                protocol,
            }
        })
        .collect()
}
