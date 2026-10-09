// ui/crates/wiretap-app/src/byte_roles.rs
//
// The Tauri command surface for Discovery's capture analyses: Payload Changes,
// Frame Order and serial structure. The classifiers are `wiretap_analysis`'s;
// what stays here is reading the capture they need.

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;
use wiretap_analysis::{
    analyse_order, byte_notes, mirror_groups, serial_structure, ByteNotes, FrameKey, MirrorGroup,
    SerialStructure, TimedPayload, DEFAULT_MIRROR_WINDOW_US,
};

use crate::analysis::{
    byte_profiles, orders_of, timed_by_protocol, FrameByteProfile, FrameSource,
    OrderStart, PayloadSource, ProtocolOrder, ScanFilter,
};
use crate::drafting;
use wiretap_analysis::draft::Draft;
use crate::capture_store::{FrameSelection, ProtocolFrames};
use crate::checksum_discovery::DEFAULT_SAMPLE_LIMIT;
use crate::payload_source::Capture;
use crate::report::{held, ReportFormat};

/// One protocol's mirror groups.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ProtocolMirrors {
    pub protocol: String,
    #[cfg_attr(test, ts(as = "Vec<crate::analysis_ts::MirrorGroup>"))]
    pub groups: Vec<MirrorGroup>,
}

/// One frame as Payload Changes reports it: its byte profile, what the profile
/// says, and whether message order finds it sent in bursts.
#[derive(Debug, Clone, Serialize)]
pub struct ChangesFrame {
    #[serde(flatten)]
    pub profile: FrameByteProfile,
    pub notes: ByteNotes,
    pub burst: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadChanges {
    /// The frames read for mirrors and bursts.
    pub frame_count: usize,
    pub frames: Vec<ChangesFrame>,
    /// Selected frames past `max_frames`, not profiled.
    pub skipped_frames: usize,
    pub mirrors: Vec<ProtocolMirrors>,
}

/// An analysis' answer, and the catalogue draft it was folded into.
#[derive(Debug, Serialize)]
pub struct Drafted<T> {
    pub result: T,
    pub draft: Draft,
}

/// Payload Changes over a capture's selection: each frame profiled over its most
/// recent `DEFAULT_SAMPLE_LIMIT` payloads, mirrors and bursts over its newest
/// `newest` frames, or all of them; folded into `draft`.
#[tauri::command(rename_all = "snake_case")]
pub async fn payload_changes_cmd(
    capture_id: String,
    selection: Vec<ProtocolFrames>,
    newest: Option<usize>,
    draft: Option<Draft>,
) -> Result<Drafted<PayloadChanges>, String> {
    let key = held::window_key(&capture_id, &selection, newest, None);
    let result = payload_changes(&Capture(&capture_id), selection, newest, usize::MAX).await?;
    held::hold_changes(key, result.clone());
    let mut draft = draft.unwrap_or_default();
    drafting::apply_changes(&mut draft, &result);
    Ok(Drafted { result, draft })
}

/// The Changes view's answer, shared with MCP `get_discovery_analysis`.
pub async fn payload_changes<S: PayloadSource + FrameSource>(
    source: &S,
    selection: Vec<ProtocolFrames>,
    newest: Option<usize>,
    max_frames: usize,
) -> Result<PayloadChanges, String> {
    let selection = FrameSelection::from_groups(selection);
    let frames = source.frames(&selection, newest).await?;
    let frame_count = frames.len();
    let timed = timed_by_protocol(frames);

    let bursts: HashSet<(&str, FrameKey)> = timed
        .iter()
        .flat_map(|(protocol, frames)| {
            analyse_order(frames, None)
                .buses
                .into_iter()
                .flat_map(|bus| bus.bursts)
                .map(move |b| (protocol.as_str(), b.key))
        })
        .collect();
    let mirrors = timed
        .iter()
        .map(|(protocol, frames)| {
            let mut streams: BTreeMap<FrameKey, Vec<TimedPayload>> = BTreeMap::new();
            for f in frames {
                streams.entry(f.key).or_default().push(TimedPayload {
                    timestamp_us: f.timestamp_us,
                    payload: f.payload.clone(),
                });
            }
            ProtocolMirrors {
                protocol: protocol.clone(),
                groups: mirror_groups(&streams, DEFAULT_MIRROR_WINDOW_US),
            }
        })
        .filter(|m| !m.groups.is_empty())
        .collect();

    let profiles =
        byte_profiles(source, &ScanFilter::Selection(selection), DEFAULT_SAMPLE_LIMIT, max_frames)
            .await?;
    let frames = profiles
        .frames
        .into_iter()
        .map(|profile| {
            let key = FrameKey::new(profile.frame_id, profile.is_extended);
            let burst = bursts.contains(&(profile.protocol.as_deref().unwrap_or_default(), key));
            ChangesFrame { notes: byte_notes(&profile.profile, burst), burst, profile }
        })
        .collect();
    Ok(PayloadChanges { frame_count, frames, skipped_frames: profiles.skipped_frames, mirrors })
}

/// Message order per protocol over a capture's selection, its newest `newest`
/// frames or all of them; folded into `draft`, every frame read seeded.
#[tauri::command(rename_all = "snake_case")]
pub async fn frame_order_cmd(
    capture_id: String,
    selection: Vec<ProtocolFrames>,
    newest: Option<usize>,
    start: Option<OrderStart>,
    draft: Option<Draft>,
) -> Result<Drafted<Vec<ProtocolOrder>>, String> {
    let key = held::window_key(&capture_id, &selection, newest, start.as_ref());
    let selection = FrameSelection::from_groups(selection);
    let frames = Capture(&capture_id).frames(&selection, newest).await?;
    let mut draft = draft.unwrap_or_default();
    drafting::seed(
        &mut draft,
        frames.iter().map(|f| (f.protocol.as_str(), FrameKey::new(f.frame_id, f.is_extended), f.bytes.len())),
    );
    let result = orders_of(timed_by_protocol(frames), start.as_ref());
    held::hold_orders(key, result.clone());
    draft.apply_orders(
        result.iter().filter_map(|o| Some((drafting::catalog_protocol(&o.protocol)?, &o.order))),
    );
    Ok(Drafted { result, draft })
}

/// The Payload Changes report on what `payload_changes_cmd` last returned for this window.
#[tauri::command(rename_all = "snake_case")]
pub fn payload_changes_report_cmd(
    capture_id: String,
    selection: Vec<ProtocolFrames>,
    newest: Option<usize>,
    format: ReportFormat,
) -> Result<String, String> {
    held::render_changes(&held::window_key(&capture_id, &selection, newest, None), format)
}

/// The Frame Order report on what `frame_order_cmd` last returned for this window.
#[tauri::command(rename_all = "snake_case")]
pub fn frame_order_report_cmd(
    capture_id: String,
    selection: Vec<ProtocolFrames>,
    newest: Option<usize>,
    start: Option<OrderStart>,
    format: ReportFormat,
) -> Result<String, String> {
    held::render_orders(&held::window_key(&capture_id, &selection, newest, start.as_ref()), format)
}

/// Id and source-address candidates over one serial link's framed payloads.
#[tauri::command]
pub fn serial_structure_cmd(payloads: Vec<Vec<u8>>) -> SerialStructure {
    serial_structure(&payloads)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::memory::MemorySource;
    use crate::analysis::message_order;
    use wiretap_analysis::{profile_bytes, ByteNote};

    #[tokio::test]
    async fn the_changes_sample_is_each_frames_most_recent_default_limit() {
        let mut source = MemorySource::default();
        for i in 0..DEFAULT_SAMPLE_LIMIT + 1000 {
            source.push("can", 0x100, false, i.to_be_bytes().to_vec());
        }
        source.push("modbus", 0x100, false, vec![0]);

        let changes =
            payload_changes(&source, vec![ProtocolFrames::ids("can", vec![0x100])], None, usize::MAX)
                .await
                .unwrap();

        assert_eq!(changes.frames.len(), 1, "the selection's protocol, not every 0x100");
        let profile = &changes.frames[0].profile.profile;
        assert_eq!(profile.sample_count, DEFAULT_SAMPLE_LIMIT as usize);
        assert_eq!(profile.columns[2].stats.min, 0x03, "starts at frame 1000 = 0x03E8");
        assert_eq!(source.asked.lock().unwrap()[0].2, crate::analysis::Sampling::Recent);
    }

    /// Two ids carrying one counter together, and a third sent in bursts of two.
    fn mirrored_and_bursty() -> MemorySource {
        let mut source = MemorySource::default();
        for i in 0..20u8 {
            let t = i as u64 * 100_000;
            source.push_at("can", 0, 0x100, false, t, vec![i, 0xA0]);
            source.push_at("can", 0, 0x200, false, t + 1_000, vec![i, 0xA0]);
            source.push_at("can", 1, 0x300, false, t + 2_000, vec![0x80 + i, 0x55]);
            source.push_at("can", 1, 0x300, false, t + 4_000, vec![0x80 + i, 0x66]);
        }
        source
    }

    #[tokio::test]
    async fn payload_changes_return_the_libs_notes_mirrors_and_bursts() {
        let source = mirrored_and_bursty();

        let changes = payload_changes(&source, vec![], None, usize::MAX).await.unwrap();

        assert_eq!(changes.frame_count, 80);
        let groups = &changes.mirrors[0].groups;
        assert_eq!(changes.mirrors[0].protocol, "can");
        assert_eq!(groups[0].keys, vec![FrameKey::new(0x100, false), FrameKey::new(0x200, false)]);
        for frame in &changes.frames {
            let payloads = (0..20u8)
                .flat_map(|i| match frame.profile.frame_id {
                    0x300 => vec![vec![0x80 + i, 0x55], vec![0x80 + i, 0x66]],
                    _ => vec![vec![i, 0xA0]],
                })
                .collect::<Vec<_>>();
            assert_eq!(frame.burst, frame.profile.frame_id == 0x300);
            assert_eq!(frame.notes, byte_notes(&profile_bytes(&payloads), frame.burst));
        }
        let bursty = changes.frames.iter().find(|f| f.burst).unwrap();
        assert!(bursty.notes.frame.contains(&ByteNote::Burst { mux: bursty.profile.profile.mux.is_some() }));
    }

    #[tokio::test]
    async fn frame_order_is_the_libs_answer_per_protocol() {
        let mut source = mirrored_and_bursty();
        source.push_at("modbus", 0, 0x100, false, 5_000_000, vec![1]);
        let start = OrderStart { protocol: Some("can".into()), frame_id: 0x200, is_extended: false };

        let orders = message_order(&source, &FrameSelection::default(), None, Some(&start)).await.unwrap();

        let protocols: Vec<&str> = orders.iter().map(|o| o.protocol.as_str()).collect();
        assert_eq!(protocols, vec!["can", "modbus"]);
        let frames = timed_by_protocol(source.frames(&FrameSelection::default(), None).await.unwrap());
        assert_eq!(orders[0].order, analyse_order(&frames["can"], Some(FrameKey::new(0x200, false))));
        assert_eq!(orders[1].order, analyse_order(&frames["modbus"], None));
        assert_eq!(orders[0].order.buses.len(), 2, "each bus its own schedule");
    }

    #[tokio::test]
    async fn a_live_window_reads_only_the_newest_frames() {
        let source = mirrored_and_bursty();

        let orders = message_order(&source, &FrameSelection::default(), Some(10), None).await.unwrap();

        assert_eq!(orders[0].order.total_frames, 10);
    }
}
