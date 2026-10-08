// crates/wiretap-app/src/capture_inventory.rs
//
// A capture's per-identity rollup, kept as frames are appended so a live
// session's frame picker is pushed from Rust instead of derived in the webview.
// Its rules are `capture_db::get_frame_info`'s, so the live picker and the one
// read back from a stopped capture agree.

use std::collections::HashMap;

use crate::capture_store::CaptureFrameInfo;
use crate::io::FrameMessage;

#[derive(Clone, Copy, PartialEq)]
struct Rollup {
    min_len: u16,
    max_len: u16,
    bus: u8,
    is_extended: bool,
}

impl Rollup {
    fn of(frame: &FrameMessage) -> Self {
        let len = stored_length(frame);
        Self {
            min_len: len,
            max_len: len,
            bus: frame.bus,
            is_extended: frame.is_extended,
        }
    }

    fn merge(self, other: Self) -> Self {
        Self {
            min_len: self.min_len.min(other.min_len),
            max_len: self.max_len.max(other.max_len),
            bus: self.bus.min(other.bus),
            is_extended: self.is_extended || other.is_extended,
        }
    }

    fn info(&self, protocol: &str, frame_id: u32) -> CaptureFrameInfo {
        CaptureFrameInfo {
            protocol: protocol.to_string(),
            frame_id,
            max_dlc: self.max_len,
            bus: self.bus,
            is_extended: self.is_extended,
            has_dlc_mismatch: self.min_len != self.max_len,
        }
    }
}

/// The length `capture_db` stores a frame under: see its `STORED_LENGTH`.
fn stored_length(frame: &FrameMessage) -> u16 {
    frame.dlc.max(frame.bytes.len() as u16)
}

#[derive(Clone, Copy)]
struct Entry {
    rollup: Rollup,
    unsent: bool,
}

#[derive(Clone, Default)]
pub struct FrameInventory {
    protocols: HashMap<String, HashMap<u32, Entry>>,
}

impl FrameInventory {
    /// Clones the protocol only the first time each one is seen, so the streaming
    /// path stays allocation-free.
    pub fn record(&mut self, frame: &FrameMessage) {
        let ids = match self.protocols.get_mut(&frame.protocol) {
            Some(ids) => ids,
            None => self.protocols.entry(frame.protocol.clone()).or_default(),
        };
        let seen = Rollup::of(frame);
        match ids.get_mut(&frame.frame_id) {
            None => {
                ids.insert(
                    frame.frame_id,
                    Entry {
                        rollup: seen,
                        unsent: true,
                    },
                );
            }
            Some(entry) => {
                let next = entry.rollup.merge(seen);
                if next != entry.rollup {
                    *entry = Entry {
                        rollup: next,
                        unsent: true,
                    };
                }
            }
        }
    }

    pub fn len(&self) -> usize {
        self.protocols.values().map(HashMap::len).sum()
    }

    pub fn clear(&mut self) {
        self.protocols.clear();
    }

    pub fn ids(&self) -> impl Iterator<Item = (&str, impl Iterator<Item = &u32>)> {
        self.protocols
            .iter()
            .map(|(protocol, ids)| (protocol.as_str(), ids.keys()))
    }

    /// The rows that changed since the last call; `everything` takes every row.
    pub fn take_unsent(&mut self, everything: bool) -> Vec<CaptureFrameInfo> {
        let mut rows = Vec::new();
        for (protocol, ids) in &mut self.protocols {
            for (frame_id, entry) in ids.iter_mut().filter(|(_, e)| everything || e.unsent) {
                entry.unsent = false;
                rows.push(entry.rollup.info(protocol, *frame_id));
            }
        }
        rows.sort_unstable_by(|a, b| (&a.protocol, a.frame_id).cmp(&(&b.protocol, b.frame_id)));
        rows
    }
}

/// `FrameInventory` (0x22): `reset` replaces what the reader holds with `rows`,
/// otherwise `rows` replace their own identities only.
#[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FrameInventoryMsg {
    pub reset: bool,
    pub rows: Vec<CaptureFrameInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Golden {
        frames: Vec<FrameMessage>,
        rollup: Vec<CaptureFrameInfo>,
        latest: Vec<LatestFrame>,
    }

    #[derive(serde::Deserialize)]
    struct LatestFrame {
        protocol: String,
        frame_id: u32,
        bytes: Vec<u8>,
        bus: u8,
        is_extended: bool,
        dlc: u16,
    }

    fn golden() -> Golden {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../frontend/wiretap-ui/src/tests/fixtures/frame-rollup/rollup.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("golden fixture"))
            .expect("golden JSON")
    }

    fn sorted(mut rows: Vec<CaptureFrameInfo>) -> Vec<CaptureFrameInfo> {
        rows.sort_unstable_by(|a, b| (&a.protocol, a.frame_id).cmp(&(&b.protocol, b.frame_id)));
        rows
    }

    fn inventory_of(frames: &[FrameMessage]) -> FrameInventory {
        let mut inventory = FrameInventory::default();
        frames.iter().for_each(|f| inventory.record(f));
        inventory
    }

    #[test]
    fn the_live_rollup_matches_the_webview_rollup_it_replaces() {
        let golden = golden();
        assert_eq!(
            inventory_of(&golden.frames).take_unsent(true),
            sorted(golden.rollup)
        );
    }

    #[test]
    fn the_stored_rollup_and_latest_frames_match_the_webview_ones_they_replace() {
        let golden = golden();
        crate::capture_db::use_in_memory_database();
        let id = crate::capture_store::create_session_capture(
            "frame-rollup-golden",
            crate::capture_store::CaptureKind::Frames,
            "golden".into(),
        );
        crate::capture_store::append_frames_to_capture(&id, golden.frames.clone());

        assert_eq!(
            sorted(crate::capture_store::get_capture_frame_info(&id)),
            sorted(golden.rollup)
        );
        let latest =
            crate::capture_store::get_capture_latest_frames(&id).expect("a frames capture");
        assert_eq!(latest.len(), golden.latest.len());
        for want in &golden.latest {
            let got = latest
                .iter()
                .find(|f| f.protocol == want.protocol && f.frame_id == want.frame_id)
                .expect("a latest frame per identity");
            assert_eq!(
                (&got.bytes, got.bus, got.is_extended, got.dlc),
                (&want.bytes, want.bus, want.is_extended, want.dlc)
            );
        }
    }

    #[test]
    fn only_rows_that_changed_are_sent_again() {
        let golden = golden();
        let mut inventory = inventory_of(&golden.frames);
        inventory.take_unsent(false);
        golden.frames.iter().for_each(|f| inventory.record(f));
        assert!(
            inventory.take_unsent(false).is_empty(),
            "replaying the same frames changes nothing"
        );

        let mut longer = golden.frames[0].clone();
        longer.dlc = 12;
        longer.bytes = vec![0; 12];
        inventory.record(&longer);
        let changed = inventory.take_unsent(false);
        assert_eq!(changed.len(), 1);
        assert_eq!(
            (
                changed[0].frame_id,
                changed[0].max_dlc,
                changed[0].has_dlc_mismatch
            ),
            (longer.frame_id, 12, true)
        );
        assert_eq!(inventory.take_unsent(true).len(), inventory.len());
    }
}
