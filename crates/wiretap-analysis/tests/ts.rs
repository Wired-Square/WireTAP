#![cfg(feature = "ts")]
//! Each declaration under the desktop's `Config` (`large_int` as `number`), doc
//! comments aside, as the desktop's generated file declares it where it has one.

use serde_json::json;
use ts_rs::{Config, TS};
use wiretap_analysis::dashboard::HistogramBin;
use wiretap_analysis::draft::FrameDraft;
use wiretap_analysis::hypothesis::CandidateReason as HypothesisReason;
use wiretap_analysis::order::MuxTiming;
use wiretap_analysis::source::{FrameByteProfile, PresentFrame, UncataloguedFrame};
use wiretap_analysis::{
    ByteColumn, ByteNote, CandidateReason, ChecksumScanOptions, Endianness, MuxAnalysis, MuxCase,
};

fn decl<T: TS>() -> String {
    T::decl(&Config::new().with_large_int("number"))
        .lines()
        .filter(|line| !line.starts_with("/**") && !line.starts_with(" *"))
        .collect()
}

#[test]
fn a_histogram_bin_is_four_numbers() {
    let bin = HistogramBin {
        min: 0.0,
        max: 1.5,
        centre: 0.75,
        count: 3,
    };
    assert_eq!(
        serde_json::to_value(bin).unwrap(),
        json!({ "min": 0.0, "max": 1.5, "centre": 0.75, "count": 3 })
    );
    assert_eq!(
        decl::<HistogramBin>(),
        "type HistogramBin = { min: number, max: number, centre: number, count: number, };"
    );
}

#[test]
fn names_shared_with_the_catalogue_and_decode_are_renamed() {
    assert_eq!(
        decl::<Endianness>(),
        r#"type NoteEndianness = "little" | "big" | "mixed";"#
    );
    assert_eq!(
        decl::<MuxCase>(),
        "type MuxCaseProfile = { value: number, sampleCount: number, \
         columns: Array<ByteColumn>, patterns: Array<MultiBytePattern>, };"
    );
    assert_eq!(
        decl::<MuxAnalysis>(),
        "type MuxAnalysis = { detection: MuxDetection, cases: Array<MuxCaseProfile>, };"
    );
}

#[test]
fn the_two_candidate_reasons_are_tagged_by_code_under_their_own_names() {
    assert_eq!(
        decl::<HypothesisReason>(),
        r#"type HypothesisReason = { "code": "role", role: RoleKind, } | { "code": "pattern", kind: PatternKind, exact: boolean, } | { "code": "endiannessAgrees" } | { "code": "endiannessMixed" } | { "code": "highVariance" } | { "code": "strongTrend" } | { "code": "noProfile" };"#
    );
    assert_eq!(
        decl::<CandidateReason>(),
        r#"type CandidateReason = { "code": "protocolMarkers" } | { "code": "commandIds" } | { "code": "typeSubtype", firstByteValues: number, } | { "code": "deviceCount", count: number, } | { "code": "addressCount", count: number, } | { "code": "twelveBitRange" } | { "code": "evenDistribution" } | { "code": "smallAddresses" } | { "code": "noZeroAddress" };"#
    );
}

#[test]
fn a_byte_note_is_tagged_by_code() {
    assert_eq!(
        decl::<ByteNote>(),
        r#"type ByteNote = { "code": "noSamples" } | { "code": "endianness", endianness: NoteEndianness, patternCount: number, } | { "code": "varyingLength", min: number, max: number, } | { "code": "burst", mux: boolean, } | { "code": "identical", sampleCount: number, payload: Array<number>, } | { "code": "multiplexed", selector: MuxSelector, cases: Array<number>, } | { "code": "caseSummary", value: number, counters: number, statics: number, } | { "code": "statics", bytes: Array<StaticByte>, } | { "code": "counter", position: number, direction: Direction, step: number, rollover: boolean, looping: Loop | null, } | { "code": "sensor", position: number, trend: Trend, strength: number, min: number, max: number, } | { "code": "pattern" } & MultiBytePattern | { "code": "varyingValues", count: number, };"#
    );
}

#[test]
fn a_flattened_frame_key_comes_last() {
    assert_eq!(
        decl::<FrameDraft>(),
        "type FrameDraft = { protocol: Protocol, length: number, bus: number | null, \
         signals: Array<DraftSignal>, patterns: Array<MultiBytePattern>, mux: MuxDraft | null, \
         intervalMs: number | null, burst: BurstDraft | null, buses: { [key in number]: number }, \
         notes: Array<ByteNote>, frameId: number, isExtended: boolean, };"
    );
    assert_eq!(
        decl::<MuxTiming>(),
        "type MuxTiming = { muxPeriodMs: number | null, interMessageMs: number, frameId: number, \
         isExtended: boolean, selector: MuxSelector, occurrences: { [key in number]: number }, };"
    );
}

#[test]
fn a_byte_column_is_its_stats_and_its_role() {
    assert_eq!(
        decl::<ByteColumn>(),
        r#"type ByteColumn = { position: number, distinctValues: number, min: number, max: number, constantValue: number | null, changes: number, transitions: number, entropyBits: number, sampleCount: number, } & ({ "role": "static", value: number, } | { "role": "counter", direction: Direction, step: number, rollover: boolean, looping: Loop | null, } | { "role": "sensor", trend: Trend, strength: number, rollover: boolean, } | { "role": "value" } | { "role": "unknown" });"#
    );
}

#[test]
fn a_field_serde_skips_when_absent_is_optional() {
    assert_eq!(
        decl::<FrameByteProfile>(),
        "type FrameByteProfile = { protocol?: string, frameId: number, isExtended: boolean, \
         frameIdHex: string, sampleCount: number, minLen: number, maxLen: number, \
         identical: Array<number> | null, analysedFrom: number, columns: Array<ByteColumn>, \
         patterns: Array<MultiBytePattern>, endianness: NoteEndianness | null, \
         mux: MuxAnalysis | null, };"
    );
    assert_eq!(
        decl::<PresentFrame>(),
        "type PresentFrame = { frame_id: number, frame_id_hex: string, name: string | null, \
         count: number, first_us: number, last_us: number, signals: Array<SignalCoverage>, \
         byte_roles?: ByteProfile, };"
    );
    assert_eq!(
        decl::<UncataloguedFrame>(),
        "type UncataloguedFrame = { frame_id: number, frame_id_hex: string, \
         is_extended: boolean, count: number, seen_as_hex?: string, unit?: number, \
         register_type?: RegisterType, };"
    );
}

#[test]
fn every_scan_option_may_be_left_out() {
    assert_eq!(
        decl::<ChecksumScanOptions>(),
        "type ChecksumScanOptions = { minSamples?: number, positions?: Array<number>, \
         searchCustomPolynomials?: boolean, minLikeness?: number, };"
    );
}
