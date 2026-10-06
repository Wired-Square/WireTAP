// Copyright 2026 Wired Square Pty Ltd

//! The JSON entries of a `DecodedSignals` or `DecodedBacklog` batch, one per
//! frame. Fields are declared in key order so the bytes match what `json!`
//! wrote before these structs replaced it.

use serde::Serialize;
use wiretap_catalog::decode::{Decoded, HeaderFieldValue, MuxSelector};
use wiretap_catalog::MirrorVerdict;
use wiretap_checksum::ChecksumValidationResult;

use super::tunnel_signals::DecodedTunnelMessage;

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DecodedSignalValue {
    pub display: String,
    #[cfg_attr(test, ts(as = "Option<String>"))]
    pub format: Option<wiretap_catalog::SignalFormat>,
    /// On a mirror frame, whether the bytes this signal covers differed from the source.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub mirror_mismatch: Option<bool>,
    pub mux_value: Option<i64>,
    pub name: String,
    /// Null when the scaled value is out of range.
    #[cfg_attr(test, ts(type = "number | null"))]
    pub scaled: f64,
    pub unit: Option<String>,
    pub value: f64,
}

impl From<Decoded> for DecodedSignalValue {
    fn from(s: Decoded) -> Self {
        Self {
            display: s.display,
            format: s.format,
            mirror_mismatch: None,
            mux_value: s.mux_value,
            name: s.name,
            scaled: s.scaled,
            unit: s.unit,
            value: s.value,
        }
    }
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DecodedMuxSelector {
    pub bit_length: u32,
    pub matched_case: Option<String>,
    pub name: Option<String>,
    pub start_bit: u32,
    pub value: i64,
}

impl From<MuxSelector> for DecodedMuxSelector {
    fn from(s: MuxSelector) -> Self {
        Self {
            bit_length: s.bit_length,
            matched_case: s.matched_case,
            name: s.name,
            start_bit: s.start_bit,
            value: s.value,
        }
    }
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DecodedHeaderField {
    pub display: String,
    /// `hex` or `decimal`.
    pub format: String,
    pub name: String,
    pub value: u64,
}

impl From<HeaderFieldValue> for DecodedHeaderField {
    fn from(h: HeaderFieldValue) -> Self {
        Self { display: h.display, format: h.format, name: h.name, value: h.value }
    }
}

/// A mirror frame's live comparison with its source.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DecodedMirrorVerdict<'a> {
    /// Null until a first comparison has run.
    pub is_valid: Option<bool>,
    pub mismatched_byte_indices: &'a [usize],
    pub source_frame_id: u32,
    pub time_delta_ms: f64,
}

impl<'a> From<&'a MirrorVerdict> for DecodedMirrorVerdict<'a> {
    fn from(v: &'a MirrorVerdict) -> Self {
        Self {
            is_valid: v.is_valid,
            mismatched_byte_indices: &v.mismatched_byte_indices,
            source_frame_id: v.source_frame_id,
            time_delta_ms: v.time_delta_ms,
        }
    }
}

/// The serial catalogue's checksum over a frame.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ChecksumVerdict {
    pub calculated: u16,
    pub extracted: u16,
    pub valid: bool,
}

impl From<ChecksumValidationResult> for ChecksumVerdict {
    fn from(c: ChecksumValidationResult) -> Self {
        Self { calculated: c.calculated, extracted: c.extracted, valid: c.valid }
    }
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DecodedFrameMsg<'a> {
    pub bus: u8,
    /// The payload this decode came from, for a byte row per mux case.
    pub bytes: &'a [u8],
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub checksum: Option<ChecksumVerdict>,
    pub dlc: u16,
    pub frame_id: u32,
    pub header_fields: Vec<DecodedHeaderField>,
    pub is_brs: bool,
    pub is_fd: bool,
    /// `frame_id` under the catalogue's `frame_id_mask`: the frame it decoded as.
    pub masked_frame_id: u32,
    /// Present only on a mirror frame, so absence means "not a mirror".
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub mirror: Option<DecodedMirrorVerdict<'a>>,
    pub selectors: Vec<DecodedMuxSelector>,
    pub signals: Vec<DecodedSignalValue>,
    pub source_address: Option<u64>,
    /// Host timestamp (µs).
    pub t: u64,
    /// The tunnel messages this frame completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub tunnel: Option<Vec<DecodedTunnelMessage<'a>>>,
}

#[derive(Serialize, Clone, Copy)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum UnroutedKind {
    /// The catalogue has no frame for the id.
    Unmatched,
    /// Shorter than the serial catalogue's `min_frame_length`.
    Short,
}

/// A frame the catalogue did not decode, and why.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct UnroutedFrameMsg<'a> {
    pub bus: u8,
    pub bytes: &'a [u8],
    pub dlc: u16,
    pub frame_id: u32,
    pub is_brs: bool,
    pub is_fd: bool,
    pub is_rtr: bool,
    pub kind: UnroutedKind,
    pub protocol: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub source_address: Option<u16>,
    pub t: u64,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(untagged)]
pub enum DecodedSignalsEntry<'a> {
    Decoded(DecodedFrameMsg<'a>),
    Unrouted(UnroutedFrameMsg<'a>),
}
