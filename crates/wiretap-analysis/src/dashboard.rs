//! What a Dashboard panel counts: a histogram of a signal's values, and how often
//! each payload bit toggles.

use serde::Serialize;

/// Values in `[min, max)`; the last bin also holds `max`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct HistogramBin {
    pub min: f64,
    pub max: f64,
    pub centre: f64,
    pub count: u64,
}

/// `bin_count` equal bins over the finite values' range, or one bin `[v, v+1)` when
/// they are all `v`; none without finite values or bins.
pub fn histogram(values: &[f64], bin_count: usize) -> Vec<HistogramBin> {
    let finite: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if finite.is_empty() || bin_count == 0 {
        return Vec::new();
    }
    let min = finite.iter().copied().fold(f64::INFINITY, f64::min);
    let max = finite.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if min == max {
        return vec![HistogramBin {
            min,
            max: min + 1.0,
            centre: min,
            count: finite.len() as u64,
        }];
    }
    let step = (max - min) / bin_count as f64;
    let mut bins: Vec<HistogramBin> = (0..bin_count)
        .map(|i| HistogramBin {
            min: min + i as f64 * step,
            max: min + (i + 1) as f64 * step,
            centre: min + (i as f64 + 0.5) * step,
            count: 0,
        })
        .collect();
    for v in finite {
        bins[(((v - min) / step).floor() as usize).min(bin_count - 1)].count += 1;
    }
    bins
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BitToggles {
    /// Per bit, `byte * 8 + bit`, over the longest payload seen.
    pub counts: Vec<u32>,
    pub frames: u64,
    #[serde(skip)]
    last: Vec<u8>,
}

impl BitToggles {
    /// The first payload sets the baseline; bytes it lacked compare against 0.
    pub fn record(&mut self, bytes: &[u8]) {
        if self.last.len() < bytes.len() {
            self.last.resize(bytes.len(), 0);
            self.counts.resize(bytes.len() * 8, 0);
        }
        for (i, (&now, was)) in bytes.iter().zip(self.last.iter_mut()).enumerate() {
            let changed = if self.frames == 0 { 0 } else { now ^ *was };
            for bit in (0..8).filter(|bit| changed >> bit & 1 == 1) {
                self.counts[i * 8 + bit] += 1;
            }
            *was = now;
        }
        self.frames += 1;
    }
}
