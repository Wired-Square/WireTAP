//! The counts a report's summary gives over Payload Changes and Frame Order
//! results. A frame is its protocol and [`FrameKey`]: the same id under two
//! protocols is two frames.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::mirror::MirrorGroup;
use crate::order::OrderAnalysis;
use crate::roles::ByteProfile;
use crate::scan::FrameKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ChangesCounts {
    pub frames: usize,
    pub identical: usize,
    pub varying_length: usize,
    pub mux: usize,
    pub burst: usize,
    pub mirror_groups: usize,
}

/// Payload Changes' counts over each frame's profile under its protocol, the
/// frames the caller found sent in bursts, and each protocol's mirror groups.
pub fn changes_counts<'a>(
    profiles: impl IntoIterator<Item = (&'a str, FrameKey, &'a ByteProfile)>,
    bursts: &HashSet<(&str, FrameKey)>,
    mirrors: impl IntoIterator<Item = &'a [MirrorGroup]>,
) -> ChangesCounts {
    let mut counts = ChangesCounts {
        mirror_groups: mirrors.into_iter().map(<[_]>::len).sum(),
        ..Default::default()
    };
    for (protocol, key, profile) in profiles {
        counts.frames += 1;
        counts.identical += usize::from(profile.identical.is_some());
        counts.varying_length += usize::from(profile.min_len != profile.max_len);
        counts.mux += usize::from(profile.mux.is_some());
        counts.burst += usize::from(bursts.contains(&(protocol, key)));
    }
    counts
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OrderTotals {
    pub frames: usize,
    pub unique_keys: usize,
    /// The longest protocol's.
    pub time_span_ms: f64,
    pub patterns: usize,
    pub multi_bus_frames: usize,
    /// In the order given.
    pub protocols: Vec<ProtocolOrderCounts>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ProtocolOrderCounts {
    pub protocol: String,
    pub frames: usize,
    pub unique_keys: usize,
    pub time_span_ms: f64,
    pub multi_bus_frames: usize,
    pub buses: Vec<BusCounts>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BusCounts {
    pub bus: u8,
    pub frames: usize,
    pub patterns: usize,
}

/// Frame Order's totals over one [`OrderAnalysis`] per protocol.
pub fn order_totals<'a>(
    orders: impl IntoIterator<Item = (&'a str, &'a OrderAnalysis)>,
) -> OrderTotals {
    let protocols: Vec<ProtocolOrderCounts> = orders
        .into_iter()
        .map(|(protocol, order)| ProtocolOrderCounts {
            protocol: protocol.into(),
            frames: order.total_frames,
            unique_keys: order.unique_keys,
            time_span_ms: order.time_span_ms,
            multi_bus_frames: order.multi_bus.len(),
            buses: order
                .buses
                .iter()
                .map(|b| BusCounts {
                    bus: b.bus,
                    frames: b.frame_count,
                    patterns: b.patterns.len(),
                })
                .collect(),
        })
        .collect();
    let sum = |count: fn(&ProtocolOrderCounts) -> usize| protocols.iter().map(count).sum();
    OrderTotals {
        frames: sum(|p| p.frames),
        unique_keys: sum(|p| p.unique_keys),
        time_span_ms: protocols.iter().map(|p| p.time_span_ms).fold(0.0, f64::max),
        patterns: sum(|p| p.buses.iter().map(|b| b.patterns).sum()),
        multi_bus_frames: sum(|p| p.multi_bus_frames),
        protocols,
    }
}
