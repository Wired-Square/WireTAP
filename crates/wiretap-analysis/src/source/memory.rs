use std::convert::Infallible;
use std::sync::Mutex;

use super::{
    FrameSelection, FrameSource, InventoryRow, PayloadQuery, PayloadSource, Sampling, Source,
    SourceFrame,
};
use crate::order::TimedFrame;
use crate::scan::FrameKey;

/// Frames held in memory, in arrival order, for a test. `Recent` reads the tail
/// and `Spread` strides the lot.
#[derive(Debug, Default)]
pub struct MemorySource {
    frames: Vec<SourceFrame>,
    asked: Mutex<Vec<(u32, Option<bool>, Sampling)>>,
}

impl MemorySource {
    /// A bus-0 frame stamped with its arrival index.
    pub fn push(&mut self, protocol: &str, frame_id: u32, is_extended: bool, bytes: Vec<u8>) {
        let timestamp_us = self.frames.len() as u64;
        self.push_at(protocol, 0, frame_id, is_extended, timestamp_us, bytes);
    }

    pub fn push_at(
        &mut self,
        protocol: &str,
        bus: u8,
        frame_id: u32,
        is_extended: bool,
        timestamp_us: u64,
        payload: Vec<u8>,
    ) {
        self.frames.push(SourceFrame {
            protocol: protocol.into(),
            frame: TimedFrame {
                bus,
                key: FrameKey::new(frame_id, is_extended),
                timestamp_us,
                payload,
            },
        });
    }

    /// Each payload query so far, as (frame id, `is_extended`, sampling).
    pub fn asked(&self) -> Vec<(u32, Option<bool>, Sampling)> {
        self.asked.lock().unwrap().clone()
    }
}

impl Source for MemorySource {
    type Error = Infallible;
}

impl PayloadSource for MemorySource {
    async fn inventory(
        &self,
        _: Option<i64>,
        _: Option<i64>,
    ) -> Result<Vec<InventoryRow>, Infallible> {
        let mut rows: Vec<InventoryRow> = Vec::new();
        for SourceFrame { protocol, frame } in &self.frames {
            let t = frame.timestamp_us as i64;
            let FrameKey {
                frame_id,
                is_extended,
            } = frame.key;
            match rows.iter_mut().find(|r| {
                r.protocol == *protocol && r.frame_id == frame_id && r.is_extended == is_extended
            }) {
                Some(row) => {
                    row.count += 1;
                    row.last_us = t;
                }
                None => rows.push(InventoryRow::new(
                    protocol,
                    frame_id,
                    is_extended,
                    1,
                    t,
                    t,
                    frame.payload.len() as u16,
                )),
            }
        }
        Ok(rows)
    }

    async fn payloads(&self, q: PayloadQuery<'_>) -> Result<Vec<Vec<u8>>, Infallible> {
        self.asked
            .lock()
            .unwrap()
            .push((q.frame_id, q.is_extended, q.sampling));
        let matching: Vec<Vec<u8>> = self
            .frames
            .iter()
            .filter(|f| {
                f.frame.key.frame_id == q.frame_id
                    && q.protocol.is_none_or(|p| p == f.protocol)
                    && q.is_extended.is_none_or(|e| e == f.frame.key.is_extended)
            })
            .map(|f| f.frame.payload.clone())
            .collect();
        let limit = q.limit as usize;
        Ok(match q.sampling {
            Sampling::Recent => matching[matching.len().saturating_sub(limit)..].to_vec(),
            Sampling::Spread => {
                let step = matching.len().div_ceil(limit.max(1)).max(1);
                matching.into_iter().step_by(step).collect()
            }
        })
    }
}

impl FrameSource for MemorySource {
    async fn frames(
        &self,
        selection: &FrameSelection,
        newest: Option<usize>,
    ) -> Result<Vec<SourceFrame>, Infallible> {
        let selected: Vec<SourceFrame> = self
            .frames
            .iter()
            .filter(|f| {
                selection.is_empty() || selection.contains(&f.protocol, f.frame.key.frame_id)
            })
            .cloned()
            .collect();
        let skip = newest.map_or(0, |n| selected.len().saturating_sub(n));
        Ok(selected[skip..].to_vec())
    }
}
