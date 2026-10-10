// crates/wiretap-app/src/adhoc.rs
//
// The Dashboard's ad-hoc signals: bit fields charted without a catalogue. The
// saved names (`byte[i]`, `byte_*`, `hyp_*`) are read and written here, each
// Dashboard window registers the fields it charts, and every frame batch is
// decoded against them beside the catalogue decode. Hypothesis ranking is
// `wiretap_analysis`'s; merging frames and the cap are the Dashboard's.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use wiretap_analysis::hypothesis::{rank_fields, Candidate, CandidateReason, Sweep};
use wiretap_decode::{parse_byte_name, Endianness, PayloadField, ScaledField};

use crate::dashboard_history::{self, HeatmapCounts, History};
use crate::io::FrameMessage;

/// The most candidates the explorer lists, best first across every frame.
const MAX_CANDIDATES: usize = 500;

// ── Names ────────────────────────────────────────────────────────────────────

/// `hyp_<idHex>_b<start>_<len><le|be>[s]`. Its scaling is saved beside it.
fn hypothesis_name(frame_id: u32, field: &PayloadField) -> String {
    let order = match field.endianness {
        Endianness::Little => "le",
        Endianness::Big => "be",
    };
    let sign = if field.signed { "s" } else { "" };
    format!("hyp_{frame_id:X}_b{}_{}{order}{sign}", field.start_bit, field.bit_length)
}

// ── Registry ─────────────────────────────────────────────────────────────────

/// One charted signal, as the Dashboard names it. `params` is a `hyp_*` name's
/// saved scaling; every other name is parsed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalRef {
    frame_id: u32,
    name: String,
    params: Option<ScaledField>,
}

impl SignalRef {
    fn field(&self) -> Option<ScaledField> {
        self.params.or_else(|| {
            parse_byte_name(&self.name).map(|field| ScaledField { field, factor: 1.0, offset: 0.0 })
        })
    }
}

/// What one Dashboard window charts from one session, by masked frame id.
#[derive(Default)]
struct Watch {
    fields: HashMap<u32, HashMap<PayloadField, Vec<(String, ScaledField)>>>,
    heatmaps: Vec<u32>,
}

impl Watch {
    fn set(&mut self, signals: &[SignalRef], heatmaps: &[u32]) -> usize {
        self.fields.clear();
        let mut registered = 0;
        for signal in signals {
            let Some(field) = signal.field() else { continue };
            let names = self.fields.entry(signal.frame_id).or_default().entry(field.field).or_default();
            if !names.iter().any(|(name, _)| *name == signal.name) {
                names.push((signal.name.clone(), field));
                registered += 1;
            }
        }
        self.heatmaps = heatmaps.to_vec();
        registered
    }

    fn named(&self, id: u32) -> impl Iterator<Item = &(String, ScaledField)> {
        self.fields.get(&id).into_iter().flat_map(HashMap::values).flatten()
    }

    fn batch(&self, frames: &[FrameMessage], mask: Option<u32>, history: Option<&History>) -> AdhocBatch {
        let mut batch = AdhocBatch::default();
        let mut seen = HashSet::new();
        for f in frames {
            let id = mask.map_or(f.frame_id, |m| f.frame_id & m);
            if seen.insert(id) {
                batch.frame_ids.push(id);
            }
            for (name, field) in self.named(id) {
                if let Some(value) = field.decode(&f.bytes) {
                    batch.values.push(AdhocValue { frame_id: id, t: f.timestamp_us, name: name.clone(), value });
                }
            }
        }
        batch.toggles = batch
            .frame_ids
            .iter()
            .filter(|id| self.heatmaps.contains(id))
            .filter_map(|&id| history?.heatmap(id))
            .collect();
        batch
    }
}

/// A Dashboard window's ad-hoc signals for one frame batch.
#[derive(Debug, Default, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "AdhocSignalsMsg"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdhocBatch {
    /// Masked ids in first-seen order.
    frame_ids: Vec<u32>,
    values: Vec<AdhocValue>,
    toggles: Vec<HeatmapCounts>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
struct AdhocValue {
    frame_id: u32,
    t: u64,
    name: String,
    value: f64,
}

type SharedWatch = Arc<Mutex<Watch>>;

/// Watches by session, then by the WS connection (window) that set them.
static WATCHES: Lazy<RwLock<HashMap<String, HashMap<usize, SharedWatch>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

fn watches(session_id: &str) -> Vec<(usize, SharedWatch)> {
    WATCHES
        .read()
        .ok()
        .and_then(|m| m.get(session_id).map(|w| w.iter().map(|(c, w)| (*c, w.clone())).collect()))
        .unwrap_or_default()
}

/// Record every window's ad-hoc fields into the session's history, once per name.
pub fn record(session_id: &str, frames: &[FrameMessage], mask: Option<u32>, history: &mut History) {
    let watches = watches(session_id);
    let locked: Vec<_> = watches.iter().filter_map(|(_, w)| w.lock().ok()).collect();
    let mut fields: HashMap<u32, HashMap<&str, &ScaledField>> = HashMap::new();
    for watch in &locked {
        for &id in watch.fields.keys() {
            for (name, field) in watch.named(id) {
                fields.entry(id).or_default().entry(name.as_str()).or_insert(field);
            }
        }
    }
    for f in frames {
        let id = mask.map_or(f.frame_id, |m| f.frame_id & m);
        for (name, field) in fields.get(&id).into_iter().flatten() {
            if let Some(value) = field.decode(&f.bytes) {
                history.record(f, id, name, value, true);
            }
        }
    }
}

/// Each watching connection's `AdhocSignals` payload for a frame batch.
pub fn batch_messages(
    session_id: &str,
    frames: &[FrameMessage],
    mask: Option<u32>,
    history: Option<&History>,
) -> Vec<(usize, Vec<u8>)> {
    watches(session_id)
        .into_iter()
        .filter_map(|(conn_id, watch)| {
            let batch = watch.lock().ok()?.batch(frames, mask, history);
            Some((conn_id, serde_json::to_vec(&batch).ok()?))
        })
        .collect()
}

pub fn forget_session(session_id: &str) {
    if let Ok(mut m) = WATCHES.write() {
        m.remove(session_id);
    }
    dashboard_history::forget(session_id);
}

pub fn forget_connection(conn_id: usize) {
    if let Ok(mut m) = WATCHES.write() {
        m.values_mut().for_each(|session| {
            session.remove(&conn_id);
        });
        m.retain(|session_id, session| {
            if session.is_empty() {
                dashboard_history::forget(session_id);
            }
            !session.is_empty()
        });
    }
}

/// `adhoc.set` { session_id, signals, heatmaps } and `adhoc.clear` { session_id },
/// each for the calling window only. A session keeps its history while any window watches it.
pub fn dispatch_adhoc_command(
    op_name: &str,
    params: serde_json::Value,
    conn_id: usize,
) -> Result<serde_json::Value, String> {
    #[derive(Deserialize)]
    struct Params {
        session_id: String,
        #[serde(default)]
        signals: Vec<SignalRef>,
        #[serde(default)]
        heatmaps: Vec<u32>,
    }
    let p: Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
    let mut all = WATCHES.write().map_err(|e| e.to_string())?;
    match op_name {
        "adhoc.set" => {
            dashboard_history::open(&p.session_id);
            let watch = all.entry(p.session_id).or_default().entry(conn_id).or_default();
            let registered = watch.lock().map_err(|e| e.to_string())?.set(&p.signals, &p.heatmaps);
            Ok(serde_json::json!({ "registered": registered }))
        }
        "adhoc.clear" => {
            if let Some(session) = all.get_mut(&p.session_id) {
                session.remove(&conn_id);
                if session.is_empty() {
                    all.remove(&p.session_id);
                    dashboard_history::forget(&p.session_id);
                }
            }
            Ok(serde_json::Value::Null)
        }
        _ => Err(format!("Unknown command: {op_name}")),
    }
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/// The explorer's sweep. `end_bit` absent means each frame's whole payload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankRequest {
    frame_ids: Vec<u32>,
    start_bit: u32,
    end_bit: Option<u32>,
    bit_step: u32,
    bit_lengths: Vec<u32>,
    endiannesses: Vec<Endianness>,
    signed: bool,
    factor: f64,
    offset: f64,
    use_profile: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedHypotheses {
    /// Best first, at most `MAX_CANDIDATES`.
    candidates: Vec<RankedCandidate>,
    /// Before the cap.
    total: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RankedCandidate {
    frame_id: u32,
    name: String,
    params: ScaledField,
    score: u8,
    reasons: Vec<CandidateReason>,
}

impl RankRequest {
    fn sweep(&self, payload_len: usize) -> Sweep {
        let last_bit = (payload_len as u32 * 8).saturating_sub(1);
        Sweep {
            start_bits: self.start_bit..=self.end_bit.unwrap_or(last_bit).min(last_bit),
            bit_step: self.bit_step,
            bit_lengths: self.bit_lengths.clone(),
            endiannesses: self.endiannesses.clone(),
            signed: self.signed,
        }
    }
}

/// Every frame's candidates merged best first, ties in frame then start-bit
/// order, scaled as asked and capped.
fn merge_ranked(per_frame: Vec<(u32, Vec<Candidate>)>, factor: f64, offset: f64) -> RankedHypotheses {
    let mut all: Vec<(u32, Candidate)> = per_frame
        .into_iter()
        .flat_map(|(id, candidates)| candidates.into_iter().map(move |c| (id, c)))
        .collect();
    all.sort_by(|(_, a), (_, b)| b.score.cmp(&a.score).then(a.field.start_bit.cmp(&b.field.start_bit)));
    let total = all.len();
    let candidates = all
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|(frame_id, c)| RankedCandidate {
            frame_id,
            name: hypothesis_name(frame_id, &c.field),
            params: ScaledField { field: c.field, factor, offset },
            score: c.score,
            reasons: c.reasons,
        })
        .collect();
    RankedHypotheses { candidates, total }
}

/// Rank hypotheses over the session capture's frames, each against the byte
/// profile of its most-seen raw id under the catalogue's frame-id mask.
#[tauri::command]
pub async fn rank_hypotheses(
    session_id: String,
    request: RankRequest,
) -> Result<RankedHypotheses, String> {
    use crate::analysis::{byte_profile, PayloadSource};
    use crate::payload_source::Capture;

    let capture_id = crate::capture_store::get_session_frame_capture_id(&session_id)
        .ok_or_else(|| format!("session '{session_id}' has no frame capture"))?;
    let mask = crate::ws::dispatch::attached_catalog(&session_id)
        .and_then(|c| wiretap_catalog::decode::frame_id_mask(&c));
    let src = Capture(&capture_id);
    let inventory = src.inventory(None, None).await?;
    let mut per_frame = Vec::new();
    for &id in &request.frame_ids {
        let Some(row) = inventory
            .iter()
            .filter(|r| mask.map_or(r.frame_id, |m| r.frame_id & m) == id)
            .max_by_key(|r| r.count)
        else {
            continue;
        };
        let profile = byte_profile(
            &src,
            Some(&row.protocol),
            row.frame_id,
            None,
            crate::checksum_discovery::DEFAULT_SAMPLE_LIMIT,
        )
        .await?
        .profile;
        let ranked = rank_fields(
            &request.sweep(profile.max_len),
            request.use_profile.then_some(&profile),
            profile.max_len,
        );
        per_frame.push((id, ranked));
    }
    Ok(merge_ranked(per_frame, request.factor, request.offset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use wiretap_analysis::dashboard::BitToggles;
    use wiretap_analysis::hypothesis::RoleKind;

    /// Captured from the TypeScript decode and bit-toggle counting before they were deleted.
    fn ts_golden() -> Value {
        serde_json::from_str(include_str!("adhoc/ts-golden.json")).unwrap()
    }

    fn payload(v: &Value) -> Vec<u8> {
        serde_json::from_value(v.clone()).unwrap()
    }

    fn frame(frame_id: u32, t: u64, bytes: Vec<u8>) -> FrameMessage {
        serde_json::from_value(json!({
            "protocol": "can", "timestamp_us": t, "frame_id": frame_id, "bus": 0, "dlc": bytes.len(), "bytes": bytes,
        }))
        .unwrap()
    }

    fn signal(frame_id: u32, name: &str, params: Option<Value>) -> SignalRef {
        serde_json::from_value(json!({ "frameId": frame_id, "name": name, "params": params })).unwrap()
    }

    #[test]
    fn golden_byte_names_decode_as_the_typescript_did() {
        for case in ts_golden()["bytes"].as_array().unwrap() {
            let bytes = payload(&case["payload"]);
            for (name, expected) in case["names"].as_object().unwrap() {
                let field = signal(1, name, None).field().unwrap();
                assert_eq!(field.decode(&bytes), expected.as_f64(), "{name} over {bytes:02X?}");
            }
        }
    }

    /// Unscaled values match exactly; scaled ones differ only by the float noise
    /// that `Decimal` scaling removes.
    #[test]
    fn golden_hypotheses_decode_as_the_typescript_did() {
        let golden = ts_golden();
        let params = golden["hyp"]["params"].as_array().unwrap();
        for case in golden["hyp"]["payloads"].as_array().unwrap() {
            let bytes = payload(&case["payload"]);
            for (p, expected) in params.iter().zip(case["values"].as_array().unwrap()) {
                let field = signal(1, "hyp_1_b0_8le", Some(p.clone())).field().unwrap();
                let got = field.decode(&bytes);
                match (got, expected.as_f64()) {
                    (Some(got), Some(want)) if field.factor == 1.0 && field.offset == 0.0 => {
                        assert_eq!(got, want, "{p} over {bytes:02X?}")
                    }
                    (Some(got), Some(want)) => {
                        assert!((got - want).abs() <= want.abs().max(1.0) * 1e-12, "{p}: {got} vs {want}")
                    }
                    (got, want) => assert_eq!(got, want, "{p} over {bytes:02X?}"),
                }
            }
        }
    }

    #[test]
    fn golden_toggle_counts_match_the_typescript() {
        for case in ts_golden()["toggles"].as_array().unwrap() {
            let mut toggles = BitToggles::default();
            for bytes in case["sequence"].as_array().unwrap() {
                toggles.record(&payload(bytes));
            }
            let mut counts = toggles.counts.clone();
            counts.resize(64, 0);
            assert_eq!(json!(counts), case["counts"]);
            assert_eq!(json!(toggles.frames), case["totalFrames"]);
        }
    }

    #[test]
    fn toggles_cover_a_whole_fd_payload() {
        let mut toggles = BitToggles::default();
        toggles.record(&[0; 64]);
        let mut changed = [0; 64];
        changed[63] = 0x80;
        toggles.record(&changed);
        assert_eq!(toggles.counts.len(), 512);
        assert_eq!(toggles.counts[511], 1);
        assert_eq!(toggles.counts.iter().sum::<u32>(), 1);
    }

    #[test]
    fn saved_byte_names_still_parse() {
        assert_eq!(parse_byte_name("byte[3]"), Some(PayloadField::bytes(3, 1, Endianness::Little)));
        assert_eq!(parse_byte_name("byte_2_16b_be"), Some(PayloadField::bytes(2, 2, Endianness::Big)));
    }

    /// The names the TypeScript `buildSignalName` wrote, which saved dashboards hold.
    #[test]
    fn golden_hypothesis_names_match_the_saved_format() {
        let field = |start_bit, bit_length, endianness, signed| PayloadField { start_bit, bit_length, endianness, signed };
        assert_eq!(hypothesis_name(0x1A0, &field(12, 16, Endianness::Big, true)), "hyp_1A0_b12_16bes");
        assert_eq!(hypothesis_name(0x18FF50E5, &field(0, 8, Endianness::Little, false)), "hyp_18FF50E5_b0_8le");
    }

    #[test]
    fn a_hypothesis_needs_its_saved_params() {
        assert!(signal(1, "hyp_1_b0_8le", None).field().is_none());
    }

    #[test]
    fn a_field_scaled_past_decimals_range_registers_and_charts_nothing() {
        let mut watch = Watch::default();
        let huge = json!({ "startBit": 0, "bitLength": 64, "endianness": "little", "signed": false, "factor": 1e30, "offset": 0.0 });
        assert_eq!(watch.set(&[signal(1, "hyp_1_b0_64le", Some(huge)), signal(1, "byte[0]", None)], &[]), 2);

        let batch = watch.batch(&[frame(1, 0, vec![0xFF; 8])], None, None);

        let values: Vec<_> = batch.values.iter().map(|v| (v.name.as_str(), v.value)).collect();
        assert_eq!(values, vec![("byte[0]", 255.0)]);
    }

    #[test]
    fn a_batch_decodes_registered_fields_under_the_mask() {
        let mut watch = Watch::default();
        let hyp = json!({ "startBit": 0, "bitLength": 16, "endianness": "big", "signed": false, "factor": 0.1, "offset": 0.0 });
        let registered = watch.set(
            &[
                signal(0x100, "byte[0]", None),
                signal(0x100, "byte_0_8b_le", None),
                signal(0x100, "byte[0]", None),
                signal(0x100, "hyp_100_b0_16be", Some(hyp)),
                signal(0x100, "Speed", None),
            ],
            &[0x100],
        );
        assert_eq!(registered, 3);

        let frames = [frame(0x1100, 10, vec![0x0D, 0x2E]), frame(0x200, 20, vec![1]), frame(0x2100, 30, vec![0x0C, 0x2E])];
        let mut history = History::default();
        history.record_toggles(&frames, Some(0xFFF));
        let batch = watch.batch(&frames, Some(0xFFF), Some(&history));

        assert_eq!(batch.frame_ids, vec![0x100, 0x200]);
        let mut values: Vec<_> = batch.values.iter().map(|v| (v.t, v.name.as_str(), v.value)).collect();
        values.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(
            values,
            vec![
                (10, "byte[0]", 13.0),
                (10, "byte_0_8b_le", 13.0),
                (10, "hyp_100_b0_16be", 337.4),
                (30, "byte[0]", 12.0),
                (30, "byte_0_8b_le", 12.0),
                (30, "hyp_100_b0_16be", 311.8),
            ]
        );
        assert_eq!(
            serde_json::to_value(&batch.toggles).unwrap(),
            json!([{ "frameId": 0x100, "counts": [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "frames": 2 }])
        );
    }

    #[test]
    fn a_window_is_sent_the_toggles_of_its_own_heatmaps_only() {
        let mut watch = Watch::default();
        watch.set(&[], &[1]);
        let frames = [frame(1, 0, vec![0]), frame(1, 0, vec![1]), frame(2, 0, vec![0])];
        let mut history = History::default();
        history.record_toggles(&frames, None);

        let batch = watch.batch(&frames, None, Some(&history));

        assert_eq!(batch.frame_ids, vec![1, 2]);
        let sent: Vec<_> = batch.toggles.iter().map(|t| serde_json::to_value(t).unwrap()["frameId"].clone()).collect();
        assert_eq!(sent, vec![json!(1)]);
        assert!(history.heatmap(2).is_some());
    }

    #[test]
    fn every_window_s_fields_are_recorded_once_per_name() {
        let session = "adhoc-record";
        let set = |conn_id, names: &[&str]| {
            let signals: Vec<_> = names.iter().map(|n| json!({ "frameId": 1, "name": n })).collect();
            dispatch_adhoc_command("adhoc.set", json!({ "session_id": session, "signals": signals }), conn_id).unwrap();
        };
        set(1, &["byte[0]"]);
        set(2, &["byte[0]", "byte[1]"]);
        let mut history = History::default();

        record(session, &[frame(1, 5, vec![7, 9])], None, &mut history);

        let r = |name: &str| dashboard_history::SignalRef { frame_id: 1, name: name.into(), protocol: None, bus: None };
        assert_eq!(history.values(&r("byte[0]")), vec![7.0]);
        assert_eq!(history.values(&r("byte[1]")), vec![9.0]);
        forget_session(session);
    }


    #[test]
    fn each_window_sets_and_clears_only_its_own_watch_and_the_history_lasts_while_one_watches() {
        let session = "adhoc-windows";
        let command = |op: &str, conn_id| {
            dispatch_adhoc_command(op, json!({ "session_id": session }), conn_id).unwrap()
        };
        command("adhoc.set", 1);
        command("adhoc.set", 2);
        let frames = [frame(7, 0, vec![0])];
        assert_eq!(batch_messages(session, &frames, None, None).len(), 2);
        assert!(dashboard_history::get(session).is_some());

        command("adhoc.clear", 1);
        assert_eq!(batch_messages(session, &frames, None, None).len(), 1);
        command("adhoc.set", 3);
        forget_connection(3);
        assert_eq!(batch_messages(session, &frames, None, None).len(), 1);
        assert!(dashboard_history::get(session).is_some());

        forget_connection(2);
        assert!(batch_messages(session, &frames, None, None).is_empty());
        assert!(dashboard_history::get(session).is_none());
    }

    fn candidate(start_bit: u32, score: u8) -> Candidate {
        Candidate {
            field: PayloadField { start_bit, bit_length: 8, endianness: Endianness::Little, signed: false },
            score,
            reasons: vec![CandidateReason::Role { role: RoleKind::Sensor }],
        }
    }

    #[test]
    fn ranking_merges_every_frame_best_first_then_caps() {
        let low: Vec<_> = (0..400).map(|bit| candidate(bit, 10)).collect();
        let high: Vec<_> = (0..300).map(|bit| candidate(bit, 90)).collect();

        let ranked = merge_ranked(vec![(0x100, low), (0x200, high)], 0.5, 1.0);

        assert_eq!(ranked.total, 700);
        assert_eq!(ranked.candidates.len(), MAX_CANDIDATES);
        assert!(ranked.candidates[..300].iter().all(|c| c.frame_id == 0x200 && c.score == 90));
        assert!(ranked.candidates[300..].iter().all(|c| c.frame_id == 0x100));
        assert_eq!(ranked.candidates[0].name, "hyp_200_b0_8le");
        assert_eq!((ranked.candidates[0].params.factor, ranked.candidates[0].params.offset), (0.5, 1.0));
    }

    #[test]
    fn ranking_ties_keep_frame_order_and_pass_any_scale_through() {
        let ranked = merge_ranked(vec![(2, vec![candidate(8, 50)]), (1, vec![candidate(8, 50), candidate(0, 50)])], 1e30, -1e30);
        let order: Vec<_> = ranked.candidates.iter().map(|c| (c.frame_id, c.params.field.start_bit)).collect();
        assert_eq!(order, vec![(1, 0), (2, 8), (1, 8)]);
        let params = ranked.candidates[0].params;
        assert_eq!((params.factor, params.offset), (1e30, -1e30));
        assert_eq!(params.decode(&[0xFF]), None);
    }

    #[test]
    fn a_sweep_ends_within_the_payload() {
        let request: RankRequest = serde_json::from_value(json!({
            "frameIds": [1], "startBit": 0, "endBit": null, "bitStep": 8, "bitLengths": [8],
            "endiannesses": ["little"], "signed": false, "factor": 1.0, "offset": 0.0, "useProfile": false,
        }))
        .unwrap();
        assert_eq!(request.sweep(64).start_bits, 0..=511);
        let capped = RankRequest { end_bit: Some(4000), ..request };
        assert_eq!(capped.sweep(8).start_bits, 0..=63);
        assert_eq!(rank_fields(&capped.sweep(64), None, 64).len(), 64);
    }
}
