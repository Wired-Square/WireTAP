// crates/wiretap-app/src/analysis_ts.rs
//
// The TypeScript declarations of the `wiretap_analysis` shapes the frontend reads.
// The lib carries no `ts-rs` derive, so these stand in for its types through
// `#[ts(as = …)]`; `generated_types` serialises the lib's own values against them.

#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::Serialize;
use ts_rs::TS;

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FrameKey {
    pub frame_id: u32,
    pub is_extended: bool,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrderAnalysis {
    pub total_frames: usize,
    pub unique_keys: usize,
    pub time_span_ms: f64,
    pub buses: Vec<BusOrder>,
    pub multi_bus: Vec<MultiBusFrame>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BusOrder {
    pub bus: u8,
    pub frame_count: usize,
    pub patterns: Vec<CyclePattern>,
    pub interval_groups: Vec<IntervalGroup>,
    pub start_candidates: Vec<StartCandidate>,
    pub mux: Vec<MuxTiming>,
    pub bursts: Vec<BurstTiming>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CyclePattern {
    pub start: FrameKey,
    pub sequence: Vec<FrameKey>,
    pub occurrences: usize,
    pub confidence: f64,
    pub cycle_ms: Option<f64>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IntervalGroup {
    pub interval_ms: f64,
    pub tolerance_ms: f64,
    pub keys: Vec<FrameKey>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StartCandidate {
    #[serde(flatten)]
    pub key: FrameKey,
    pub max_gap_before_ms: f64,
    pub avg_gap_before_ms: f64,
    pub min_gap_before_ms: f64,
    pub occurrences: usize,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MuxTiming {
    #[serde(flatten)]
    pub key: FrameKey,
    #[serde(flatten)]
    pub detection: MuxDetection,
    pub mux_period_ms: Option<f64>,
    pub inter_message_ms: f64,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MuxDetection {
    pub selector: MuxSelector,
    pub occurrences: BTreeMap<u16, usize>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MuxSelector {
    OneByte,
    TwoByte,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BurstTiming {
    #[serde(flatten)]
    pub key: FrameKey,
    pub frames_per_burst: f64,
    pub burst_period_ms: f64,
    pub inter_message_ms: f64,
    pub lengths: Vec<usize>,
    pub flags: Vec<BurstFlag>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum BurstFlag {
    VariableLength,
    BurstPattern,
    RequestResponse,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MultiBusFrame {
    #[serde(flatten)]
    pub key: FrameKey,
    pub frames_per_bus: BTreeMap<u8, usize>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MirrorGroup {
    pub keys: Vec<FrameKey>,
    pub sample_count: usize,
    pub match_percentage: u8,
    pub sample_payload: Vec<u8>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ByteNotes {
    pub frame: Vec<ByteNote>,
    pub cases: Vec<MuxCaseNotes>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MuxCaseNotes {
    pub value: u16,
    pub notes: Vec<ByteNote>,
}

#[derive(Serialize, TS)]
#[serde(tag = "code", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ByteNote {
    NoSamples,
    Endianness { endianness: Endianness, pattern_count: usize },
    VaryingLength { min: usize, max: usize },
    Burst { mux: bool },
    Identical { sample_count: usize, payload: Vec<u8> },
    Multiplexed { selector: MuxSelector, cases: Vec<u16> },
    CaseSummary { value: u16, counters: usize, statics: usize },
    Statics { bytes: Vec<StaticByte> },
    Counter { position: usize, direction: Direction, step: u8, rollover: bool, looping: Option<Loop> },
    Sensor { position: usize, trend: Trend, strength: f64, min: u8, max: u8 },
    Pattern(MultiBytePattern),
    VaryingValues { count: usize },
}

#[derive(Serialize, TS)]
pub struct StaticByte {
    pub position: usize,
    pub value: u8,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Endianness {
    Little,
    Big,
    Mixed,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Up,
    Down,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Trend {
    Increasing,
    Decreasing,
    Mixed,
}

#[derive(Serialize, TS)]
pub struct Loop {
    pub min: u8,
    pub max: u8,
    pub modulo: u16,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MultiBytePattern {
    pub start: usize,
    pub len: usize,
    pub kind: PatternKind,
    pub endianness: Option<Endianness>,
    pub rollover: bool,
    pub correlated_rollover: bool,
    pub slow_upper_bytes: bool,
    pub range: Option<(u32, u32)>,
    pub sample_text: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PatternKind {
    Counter16,
    Sensor16,
    Sensor32,
    Text,
}
