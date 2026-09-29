// ui/crates/wiretap-app/src/byte_roles.rs
//
// The Tauri command surface for byte roles and serial structure. The
// classifiers are `wiretap_analysis`'s; what stays here is reading and ordering
// the payloads they need, oldest first and contiguous.

use std::collections::HashMap;

use serde::Deserialize;
use tauri::AppHandle;
use wiretap_analysis::{serial_structure, SerialStructure};

use crate::analysis::{FrameByteProfile, QuerySource, ScanFilter};
use crate::capture_store::{FrameSelection, ProtocolFrames};
use crate::checksum_discovery::{DiscoveryFrame, DEFAULT_SAMPLE_LIMIT};

/// Where the Changes view's payloads come from: a capture Rust reads itself, or
/// the frames the frontend holds when nothing has written them to one.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ProfileSource {
    Capture { capture_id: String, selection: Vec<ProtocolFrames> },
    Frames { frames: Vec<DiscoveryFrame> },
}

/// Profile each frame's most recent `DEFAULT_SAMPLE_LIMIT` payloads.
#[tauri::command]
pub async fn profile_bytes_cmd(
    app: AppHandle,
    source: ProfileSource,
) -> Result<Vec<FrameByteProfile>, String> {
    match source {
        ProfileSource::Capture { capture_id, selection } => {
            let filter = ScanFilter::Selection(FrameSelection::from_groups(selection));
            let profiles = crate::analysis::byte_profiles(
                &app,
                &QuerySource::Capture(capture_id),
                &filter,
                DEFAULT_SAMPLE_LIMIT,
                usize::MAX,
            )
            .await?;
            Ok(profiles.frames)
        }
        ProfileSource::Frames { frames } => Ok(profile_frames(frames, DEFAULT_SAMPLE_LIMIT as usize)),
    }
}

/// Group `frames` by identity in first-seen order and profile each group's most
/// recent `limit` payloads.
fn profile_frames(frames: Vec<DiscoveryFrame>, limit: usize) -> Vec<FrameByteProfile> {
    type Key = (Option<String>, u32, bool);
    let mut index: HashMap<Key, usize> = HashMap::new();
    let mut groups: Vec<(Key, Vec<Vec<u8>>)> = Vec::new();
    for f in frames {
        let key = (f.protocol, f.frame_id, f.is_extended);
        let i = *index.entry(key.clone()).or_insert_with(|| {
            groups.push((key, Vec::new()));
            groups.len() - 1
        });
        groups[i].1.push(f.bytes);
    }
    groups
        .into_iter()
        .map(|((protocol, frame_id, is_extended), payloads)| {
            let recent = &payloads[payloads.len().saturating_sub(limit)..];
            FrameByteProfile::new(protocol.as_deref(), frame_id, is_extended, recent)
        })
        .collect()
}

/// Id and source-address candidates over one serial link's framed payloads.
#[tauri::command]
pub fn serial_structure_cmd(payloads: Vec<Vec<u8>>) -> SerialStructure {
    serial_structure(&payloads)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiretap_analysis::{ByteRole, Direction};

    fn frame(protocol: &str, frame_id: u32, bytes: Vec<u8>) -> DiscoveryFrame {
        DiscoveryFrame { protocol: Some(protocol.into()), frame_id, bytes, is_extended: false }
    }

    #[test]
    fn frames_group_by_identity_in_first_seen_order() {
        let frames = vec![
            frame("can", 0x200, vec![1]),
            frame("can", 0x100, vec![2]),
            frame("modbus", 0x200, vec![3]),
            frame("can", 0x200, vec![4]),
        ];

        let profiles = profile_frames(frames, 100);

        let keys: Vec<_> = profiles.iter().map(|p| (p.protocol.as_deref(), p.frame_id)).collect();
        assert_eq!(keys, vec![(Some("can"), 0x200), (Some("can"), 0x100), (Some("modbus"), 0x200)]);
        assert_eq!(profiles[0].profile.sample_count, 2);
    }

    /// The newest run, in order: a counter keeps its step and its direction.
    #[test]
    fn a_group_keeps_its_most_recent_contiguous_payloads() {
        let frames = (0..50u8).map(|i| frame("can", 0x100, vec![0xC0, i])).collect();

        let profile = &profile_frames(frames, 10)[0].profile;

        assert_eq!(profile.sample_count, 10);
        assert_eq!(profile.columns[1].stats.min, 40);
        assert!(matches!(
            profile.columns[1].role,
            ByteRole::Counter { direction: Direction::Up, step: 1, .. }
        ));
    }
}
