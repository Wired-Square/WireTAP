// crates/wiretap-app/src/query/ts.rs
//
// The TypeScript declarations of the `wiretap_gateway` query shapes. The lib
// carries no `ts-rs` derive at the pinned tag, so these stand in for its types
// through `#[ts(as = …)]`; `generated_types` serialises the lib's own values
// against them.

#![allow(dead_code)]

use serde::Serialize;
use ts_rs::TS;

#[derive(Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename = "ArchiveProtocol")]
pub enum Protocol {
    Can,
    Modbus,
    Serial,
}

#[derive(Serialize, TS)]
pub struct RowWindow {
    #[ts(optional)]
    pub protocol: Option<Protocol>,
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}

#[derive(Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QuerySpec {
    ByteChanges {
        frame_id: u32,
        is_extended: Option<bool>,
        #[serde(flatten)]
        window: RowWindow,
        byte_index: u8,
        limit: Option<u32>,
    },
    FrameChanges {
        frame_id: u32,
        is_extended: Option<bool>,
        #[serde(flatten)]
        window: RowWindow,
        limit: Option<u32>,
    },
    MirrorValidation {
        mirror_frame_id: u32,
        source_frame_id: u32,
        is_extended: Option<bool>,
        #[serde(flatten)]
        window: RowWindow,
        tolerance_ms: u32,
        limit: Option<u32>,
    },
    MuxStatistics {
        frame_id: u32,
        is_extended: Option<bool>,
        #[serde(flatten)]
        window: RowWindow,
        mux_selector_byte: u8,
        include_16bit: bool,
        payload_length: u8,
        limit: Option<u32>,
    },
    FirstLast {
        frame_id: u32,
        is_extended: Option<bool>,
        #[serde(flatten)]
        window: RowWindow,
    },
    Frequency {
        frame_id: u32,
        is_extended: Option<bool>,
        #[serde(flatten)]
        window: RowWindow,
        bucket_size_ms: u32,
        limit: Option<u32>,
    },
    Distribution {
        frame_id: u32,
        is_extended: Option<bool>,
        #[serde(flatten)]
        window: RowWindow,
        byte_index: u8,
    },
    GapAnalysis {
        frame_id: u32,
        is_extended: Option<bool>,
        #[serde(flatten)]
        window: RowWindow,
        gap_threshold_ms: f64,
        limit: Option<u32>,
    },
    PatternSearch {
        #[serde(flatten)]
        window: RowWindow,
        pattern: Vec<u8>,
        pattern_mask: Vec<u8>,
        limit: Option<u32>,
    },
    FrameInventory {
        #[serde(flatten)]
        window: RowWindow,
        limit: Option<u32>,
    },
}

#[derive(Serialize, TS)]
pub struct QueryStats {
    pub rows_scanned: u64,
    pub results_count: u64,
    pub execution_time_ms: u64,
}

#[derive(Serialize, TS)]
pub struct ByteChangeResult {
    pub timestamp_us: i64,
    pub old_value: u8,
    pub new_value: u8,
}

#[derive(Serialize, TS)]
pub struct FrameChangeResult {
    pub timestamp_us: i64,
    pub old_payload: Vec<u8>,
    pub new_payload: Vec<u8>,
    pub changed_indices: Vec<u64>,
}

#[derive(Serialize, TS)]
pub struct MirrorValidationResult {
    pub mirror_timestamp_us: i64,
    pub source_timestamp_us: i64,
    pub mirror_payload: Vec<u8>,
    pub source_payload: Vec<u8>,
    pub mismatch_indices: Vec<u64>,
}

#[derive(Serialize, TS)]
pub struct BytePositionStats {
    pub byte_index: u8,
    pub min: u8,
    pub max: u8,
    pub avg: f64,
    pub distinct_count: u32,
    pub sample_count: u64,
}

#[derive(Serialize, TS)]
pub struct Word16Stats {
    pub start_byte: u8,
    pub endianness: String,
    pub min: u16,
    pub max: u16,
    pub avg: f64,
    pub distinct_count: u32,
}

#[derive(Serialize, TS)]
pub struct MuxCaseStats {
    pub mux_value: u16,
    pub frame_count: u64,
    pub byte_stats: Vec<BytePositionStats>,
    pub word16_stats: Vec<Word16Stats>,
}

#[derive(Serialize, TS)]
pub struct MuxStatisticsResult {
    pub mux_byte: u8,
    pub total_frames: u64,
    pub cases: Vec<MuxCaseStats>,
}

#[derive(Serialize, TS)]
pub struct FirstLastResult {
    pub first_timestamp_us: i64,
    pub first_payload: Vec<u8>,
    pub last_timestamp_us: i64,
    pub last_payload: Vec<u8>,
    pub total_count: i64,
}

#[derive(Serialize, TS)]
pub struct FrequencyBucket {
    pub bucket_start_us: i64,
    pub frame_count: i64,
    pub min_interval_us: f64,
    pub max_interval_us: f64,
    pub avg_interval_us: f64,
}

#[derive(Serialize, TS)]
pub struct DistributionResult {
    pub value: u8,
    pub count: i64,
    pub percentage: f64,
}

#[derive(Serialize, TS)]
pub struct GapResult {
    pub gap_start_us: i64,
    pub gap_end_us: i64,
    pub duration_ms: f64,
}

#[derive(Serialize, TS)]
pub struct PatternSearchResult {
    pub timestamp_us: i64,
    pub frame_id: u32,
    pub is_extended: bool,
    pub payload: Vec<u8>,
    pub match_positions: Vec<u64>,
}

#[derive(Serialize, TS)]
#[serde(untagged)]
pub enum QueryResults {
    ByteChanges(Vec<ByteChangeResult>),
    FrameChanges(Vec<FrameChangeResult>),
    MirrorValidation(Vec<MirrorValidationResult>),
    MuxStatistics(MuxStatisticsResult),
    FirstLast(FirstLastResult),
    Frequency(Vec<FrequencyBucket>),
    Distribution(Vec<DistributionResult>),
    GapAnalysis(Vec<GapResult>),
    PatternSearch(Vec<PatternSearchResult>),
    FrameInventory(Vec<crate::capture_db::InventoryRow>),
}
