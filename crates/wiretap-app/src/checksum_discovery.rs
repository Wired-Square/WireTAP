// ui/crates/wiretap-app/src/checksum_discovery.rs
//
// The Tauri command surface for checksum discovery. The scan itself —
// grouping, sampling, identification, sweep, solve, ranking — lives in
// `wiretap_analysis::scan`, because all of it is a pure function of payloads
// and because the other consumers (the MCP scan, and a catalogue validator
// asking "does this declared checksum hold?") cannot reach into an app binary.

use serde::Deserialize;
use tauri::AppHandle;

use wiretap_analysis::{scan_frames, ChecksumScanOptions, ChecksumScanResult, FrameKey};

use crate::analysis::{QuerySource, ScanFilter};
use crate::capture_store::{FrameSelection, ProtocolFrames};

/// Payloads to read per frame id, for every door onto the scan — the MCP tool's
/// `sample_limit` defaults to this too, so the panel and an agent sample
/// identically. The panel has no knob for it: nothing about a sample ceiling is
/// a judgement a user is placed to make.
pub const DEFAULT_SAMPLE_LIMIT: u32 = 5000;

/// Scan a capture for checksums, one call for the whole run.
///
/// Takes the capture id and the selection rather than the frames: the payloads
/// are already in the capture database, and shipping them to the frontend only
/// to hand them back cost roughly a megabyte of JSON to compute something that
/// reads 200 sampled payloads per frame id.
#[tauri::command(rename_all = "snake_case")]
pub async fn discover_checksums_in_capture_cmd(
    app: AppHandle,
    capture_id: String,
    selection: Vec<ProtocolFrames>,
    options: Option<ChecksumScanOptions>,
) -> Result<ChecksumScanResult, String> {
    // Empty reads as "every frame", the same as everywhere else a selection is
    // accepted; Discovery guards its own "nothing selected" case before calling.
    let filter = ScanFilter::Selection(FrameSelection::from_groups(selection));
    crate::analysis::checksum_scan(
        &app,
        &QuerySource::Capture(capture_id),
        &filter,
        DEFAULT_SAMPLE_LIMIT,
        options.unwrap_or_default(),
    )
    .await
}

/// Just enough of a `FrameMessage` to group and analyse. Serde ignores the rest
/// of the fields the frontend sends.
#[derive(Debug, Clone, Deserialize)]
pub struct DiscoveryFrame {
    pub frame_id: u32,
    pub bytes: Vec<u8>,
    #[serde(default)]
    pub is_extended: bool,
}

/// Scan frames the frontend holds and no capture does.
///
/// Not scaffolding — the permanent path for sessions with nothing behind them:
/// serial data framed on the client before any framing has been applied, and a
/// live session running without a capture. Everything capture-backed goes
/// through [`discover_checksums_in_capture_cmd`]; both call the same crate
/// engine, so there are two input shapes and one implementation.
#[tauri::command]
pub fn discover_checksums_cmd(
    frames: Vec<DiscoveryFrame>,
    options: Option<ChecksumScanOptions>,
) -> ChecksumScanResult {
    scan_frames(
        frames
            .into_iter()
            .map(|f| (FrameKey::new(f.frame_id, f.is_extended), f.bytes)),
        &options.unwrap_or_default(),
    )
}
