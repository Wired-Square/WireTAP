// crates/wiretap-app/src/dashboard_history.rs
//
// The Dashboard's signal history: per session, the newest samples of every
// catalogue and ad-hoc signal its frame batches decode, and each frame's bit
// toggles, held while a Dashboard window watches the session. Panels, the CSV
// export and the MCP read it through the `dashboard.*` WS queries.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use wiretap_analysis::dashboard::{histogram, BitToggles, HistogramBin};

use crate::io::FrameMessage;
use crate::ws::decoded::DecodedFrameMsg;

/// Guards the allocation; the panel offers 5..200.
const MAX_HISTOGRAM_BINS: f64 = 1_000.0;

static CAPACITY: AtomicUsize = AtomicUsize::new(10_000);

/// Samples kept per series, from `graph_buffer_size`; live series are trimmed now.
pub fn set_capacity(capacity: u32) {
    let capacity = capacity as usize;
    if CAPACITY.swap(capacity, Ordering::Relaxed) == capacity {
        return;
    }
    let histories: Vec<Shared> = HISTORIES.read().map(|m| m.values().cloned().collect()).unwrap_or_default();
    for history in histories {
        if let Ok(mut h) = history.lock() {
            h.set_capacity(capacity);
        }
    }
}

/// Field order is the read order: every wire of one signal sits together.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SeriesKey {
    frame_id: u32,
    name: String,
    protocol: String,
    bus: u8,
}

#[derive(Debug)]
struct Series {
    adhoc: bool,
    /// `(t µs, value)`, oldest first.
    samples: VecDeque<(u64, f64)>,
}

impl Series {
    /// In time order, equal stamps in arrival order.
    fn push(&mut self, t: u64, value: f64, capacity: usize) {
        let at = match self.samples.back() {
            Some(&(last, _)) if last > t => self.samples.partition_point(|&(s, _)| s <= t),
            _ => self.samples.len(),
        };
        self.samples.insert(at, (t, value));
        self.trim(capacity);
    }

    fn trim(&mut self, capacity: usize) {
        let excess = self.samples.len().saturating_sub(capacity);
        self.samples.drain(..excess);
    }
}

#[derive(Debug)]
pub struct History {
    capacity: usize,
    series: BTreeMap<SeriesKey, Series>,
    /// By masked frame id, over every frame seen.
    toggles: HashMap<u32, BitToggles>,
}

impl Default for History {
    fn default() -> Self {
        Self::new(CAPACITY.load(Ordering::Relaxed))
    }
}

impl History {
    fn new(capacity: usize) -> Self {
        Self { capacity, series: BTreeMap::new(), toggles: HashMap::new() }
    }

    fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity;
        self.series.values_mut().for_each(|s| s.trim(capacity));
    }

    /// A sample without a finite value is not kept.
    pub(crate) fn record(&mut self, f: &FrameMessage, frame_id: u32, name: &str, value: f64, adhoc: bool) {
        if !value.is_finite() {
            return;
        }
        let key = SeriesKey { frame_id, name: name.to_string(), protocol: f.protocol.clone(), bus: f.bus };
        self.series
            .entry(key)
            .or_insert_with(|| Series { adhoc, samples: VecDeque::new() })
            .push(f.timestamp_us, value, self.capacity);
    }

    pub(crate) fn record_decoded(&mut self, f: &FrameMessage, decoded: &DecodedFrameMsg) {
        for s in &decoded.signals {
            self.record(f, decoded.masked_frame_id, &s.name, s.scaled, false);
        }
    }

    pub(crate) fn record_toggles(&mut self, frames: &[FrameMessage], mask: Option<u32>) {
        for f in frames {
            let id = mask.map_or(f.frame_id, |m| f.frame_id & m);
            self.toggles.entry(id).or_default().record(&f.bytes);
        }
    }

    /// Before a catalogue's backlog refills them; ad-hoc series stay.
    pub(crate) fn drop_catalogue_series(&mut self) {
        self.series.retain(|_, s| s.adhoc);
    }

    pub(crate) fn reset_toggles(&mut self) {
        self.toggles.clear();
    }

    pub(crate) fn heatmap(&self, frame_id: u32) -> Option<HeatmapCounts> {
        let toggles = self.toggles.get(&frame_id)?;
        Some(HeatmapCounts { frame_id, counts: toggles.counts.clone(), frames: toggles.frames })
    }

    fn clear(&mut self) {
        self.series.clear();
        self.toggles.clear();
    }

    /// Every wire `r` names, merged in time order.
    fn window(&self, r: &SignalRef) -> Vec<(u64, f64)> {
        let from = SeriesKey { frame_id: r.frame_id, name: r.name.clone(), protocol: String::new(), bus: 0 };
        let mut out = Vec::new();
        let mut wires = 0;
        for (_, series) in self
            .series
            .range(from..)
            .take_while(|(k, _)| k.frame_id == r.frame_id && k.name == r.name)
            .filter(|(k, _)| r.protocol.as_ref().is_none_or(|p| *p == k.protocol) && r.bus.is_none_or(|b| b == k.bus))
        {
            out.extend(series.samples.iter().copied());
            wires += 1;
        }
        if wires > 1 {
            out.sort_by_key(|&(t, _)| t);
        }
        out
    }

    fn series(&self, r: &SignalRef, last: Option<usize>) -> SeriesWindow {
        let window = self.window(r);
        let stats = WindowStats::of(&window);
        let tail = &window[window.len() - last.unwrap_or(window.len()).min(window.len())..];
        SeriesWindow {
            t: tail.iter().map(|&(t, _)| seconds(t)).collect(),
            v: tail.iter().map(|&(_, v)| v).collect(),
            stats,
        }
    }

    fn windows(&self, refs: &[SignalRef]) -> Vec<Vec<(u64, f64)>> {
        refs.iter().map(|r| self.window(r)).collect()
    }

    fn aligned(&self, refs: &[SignalRef]) -> AlignedSeries {
        let windows = self.windows(refs);
        let (x, y) = align(&windows);
        AlignedSeries { x: x.into_iter().map(seconds).collect(), y, stats: windows.iter().map(|w| WindowStats::of(w)).collect() }
    }

    fn csv(&self, refs: &[SignalRef], headers: &[String]) -> String {
        let (x, y) = align(&self.windows(refs));
        if x.is_empty() {
            return String::new();
        }
        let mut out = std::iter::once("timestamp")
            .chain(headers.iter().map(String::as_str))
            .map(csv_field)
            .collect::<Vec<_>>()
            .join(",");
        out.push('\n');
        for (row, &t) in x.iter().enumerate() {
            out.push_str(&iso_utc(t));
            for column in &y {
                out.push(',');
                if let Some(v) = column[row] {
                    out.push_str(&v.to_string());
                }
            }
            out.push('\n');
        }
        out
    }

    fn histogram(&self, r: &SignalRef, bins: f64) -> Vec<HistogramBin> {
        let values: Vec<f64> = self.window(r).into_iter().map(|(_, v)| v).collect();
        histogram(&values, bin_count(bins))
    }
}

/// The panel's bin count, rounded; none for a count below one half.
fn bin_count(bins: f64) -> usize {
    if bins.is_finite() {
        bins.round().clamp(0.0, MAX_HISTOGRAM_BINS) as usize
    } else {
        0
    }
}

/// One x per distinct stamp across the windows; each column holds its value at
/// exactly that stamp (the later of two) and none elsewhere.
fn align(windows: &[Vec<(u64, f64)>]) -> (Vec<u64>, Vec<Vec<Option<f64>>>) {
    let mut x: Vec<u64> = windows.iter().flatten().map(|&(t, _)| t).collect();
    x.sort_unstable();
    x.dedup();
    let y = windows
        .iter()
        .map(|window| {
            let mut column = vec![None; x.len()];
            let mut i = 0;
            for &(t, v) in window {
                while x[i] < t {
                    i += 1;
                }
                column[i] = Some(v);
            }
            column
        })
        .collect();
    (x, y)
}

fn seconds(t_us: u64) -> f64 {
    t_us as f64 / 1_000_000.0
}

fn iso_utc(t_us: u64) -> String {
    chrono::DateTime::from_timestamp_micros(t_us as i64)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string())
        .unwrap_or_default()
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// A charted signal: every wire it arrives on unless `protocol` or `bus` names one.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "HistorySignal"))]
#[serde(rename_all = "camelCase")]
pub struct SignalRef {
    pub frame_id: u32,
    pub name: String,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub protocol: Option<String>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub bus: Option<u8>,
}

/// Over the samples held, not every sample seen.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WindowStats {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub count: usize,
    pub latest: f64,
    /// Seconds.
    pub latest_t: f64,
}

impl WindowStats {
    fn of(window: &[(u64, f64)]) -> Option<Self> {
        let &(latest_t, latest) = window.last()?;
        let (min, max, sum) = window
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY, 0.0), |(min, max, sum), &(_, v)| (min.min(v), max.max(v), sum + v));
        Some(Self { min, max, mean: sum / window.len() as f64, count: window.len(), latest, latest_t: seconds(latest_t) })
    }
}

/// Oldest first; times in seconds.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SeriesWindow {
    pub t: Vec<f64>,
    pub v: Vec<f64>,
    pub stats: Option<WindowStats>,
}

/// A chart's data: `x` in seconds, a `y` column and stats per signal.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AlignedSeries {
    pub x: Vec<f64>,
    pub y: Vec<Vec<Option<f64>>>,
    pub stats: Vec<Option<WindowStats>>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HeatmapCounts {
    frame_id: u32,
    /// Per bit, `byte * 8 + bit`, over the longest payload seen.
    counts: Vec<u32>,
    frames: u64,
}

type Shared = Arc<Mutex<History>>;

static HISTORIES: Lazy<RwLock<HashMap<String, Shared>>> = Lazy::new(|| RwLock::new(HashMap::new()));

pub fn open(session_id: &str) {
    if let Ok(mut m) = HISTORIES.write() {
        m.entry(session_id.to_string()).or_default();
    }
}

pub fn forget(session_id: &str) {
    if let Ok(mut m) = HISTORIES.write() {
        m.remove(session_id);
    }
}

pub fn get(session_id: &str) -> Option<Shared> {
    HISTORIES.read().ok()?.get(session_id).cloned()
}

/// A session nobody watches reads as empty.
fn read<R>(session_id: &str, f: impl FnOnce(&mut History) -> R) -> Result<R, String> {
    match get(session_id) {
        Some(shared) => Ok(f(&mut *shared.lock().map_err(|e| e.to_string())?)),
        None => Ok(f(&mut History::default())),
    }
}

pub fn series(session_id: &str, r: &SignalRef, last: Option<usize>) -> Result<SeriesWindow, String> {
    read(session_id, |h| h.series(r, last))
}

/// `dashboard.series` { signals, last? }, `dashboard.aligned` { signals },
/// `dashboard.histogram` { signals, bins }, `dashboard.csv` { signals, headers },
/// `dashboard.bitChanges` { frame_id? } and `dashboard.clear`, each with `session_id`.
pub fn dispatch(op_name: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    #[derive(Deserialize)]
    struct Params {
        session_id: String,
        #[serde(default)]
        signals: Vec<SignalRef>,
        last: Option<usize>,
        #[serde(default)]
        bins: f64,
        #[serde(default)]
        headers: Vec<String>,
        frame_id: Option<u32>,
    }
    let p: Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
    read(&p.session_id, |h| {
        let value = match op_name {
            "dashboard.series" => serde_json::to_value(p.signals.iter().map(|r| h.series(r, p.last)).collect::<Vec<_>>()),
            "dashboard.aligned" => serde_json::to_value(h.aligned(&p.signals)),
            "dashboard.histogram" => serde_json::to_value(p.signals.iter().map(|r| h.histogram(r, p.bins)).collect::<Vec<_>>()),
            "dashboard.csv" => serde_json::to_value(h.csv(&p.signals, &p.headers)),
            "dashboard.bitChanges" => {
                let mut ids: Vec<u32> = p.frame_id.map_or_else(|| h.toggles.keys().copied().collect(), |id| vec![id]);
                ids.sort_unstable();
                serde_json::to_value(ids.into_iter().filter_map(|id| h.heatmap(id)).collect::<Vec<_>>())
            }
            "dashboard.clear" => {
                h.clear();
                Ok(serde_json::Value::Null)
            }
            _ => return Err(format!("Unknown command: {op_name}")),
        };
        value.map_err(|e| e.to_string())
    })?
}

#[cfg(test)]
impl History {
    pub(crate) fn values(&self, r: &SignalRef) -> Vec<f64> {
        self.window(r).into_iter().map(|(_, v)| v).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../frontend/wiretap-ui/src/tests/fixtures/data");

    /// D1's fixtures, now written from here; `WRITE_DATA_FIXTURES=1` rewrites them.
    fn golden(file: &str, cases: Vec<Value>) {
        let text = serde_json::to_string_pretty(&tidy(json!({ "cases": cases }))).unwrap() + "\n";
        let path = format!("{FIXTURES}/{file}");
        if std::env::var_os("WRITE_DATA_FIXTURES").is_some() {
            std::fs::write(&path, &text).unwrap();
        }
        assert_eq!(text, std::fs::read_to_string(&path).expect("fixture"), "{file}");
    }

    /// Whole floats as integers, as the TypeScript wrote them.
    fn tidy(value: Value) -> Value {
        match value {
            Value::Number(n) => match n.as_f64() {
                Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9e15 => json!(f as i64),
                _ => Value::Number(n),
            },
            Value::Array(items) => Value::Array(items.into_iter().map(tidy).collect()),
            Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, tidy(v))).collect()),
            other => other,
        }
    }

    fn frame(protocol: &str, bus: u8, t_s: f64) -> FrameMessage {
        serde_json::from_value(json!({
            "protocol": protocol, "timestamp_us": (t_s * 1e6).round() as u64, "frame_id": 0, "bus": bus, "dlc": 0, "bytes": [],
        }))
        .unwrap()
    }

    fn push(h: &mut History, id: u32, name: &str, samples: &[(f64, f64)]) {
        for &(t, v) in samples {
            h.record(&frame("can", 0, t), id, name, v, false);
        }
    }

    fn signal(key: &str) -> SignalRef {
        let (id, name) = key.split_once(':').unwrap();
        SignalRef { frame_id: id.parse().unwrap(), name: name.into(), protocol: None, bus: None }
    }

    fn ramp(n: usize, from: usize) -> Vec<(f64, f64)> {
        (from..from + n).map(|i| (i as f64, i as f64)).collect()
    }

    fn summary(h: &History, key: &str) -> Value {
        let w = h.series(&signal(key), None);
        let pairs = |t: &[f64], v: &[f64]| t.iter().zip(v).map(|(t, v)| json!([t, v])).collect::<Vec<_>>();
        let n = w.t.len();
        json!({
            "capacity": h.capacity,
            "count": n,
            "stats": w.stats,
            "head": pairs(&w.t[..n.min(3)], &w.v[..n.min(3)]),
            "tail": pairs(&w.t[n.saturating_sub(3)..], &w.v[n.saturating_sub(3)..]),
        })
    }

    fn read(h: &History, key: &str) -> Value {
        let w = h.series(&signal(key), None);
        json!({ "timestamps": w.t, "values": w.v })
    }

    #[test]
    fn series_and_statistics_match_the_fixture() {
        let mut cases = Vec::new();
        let mut case = |name: &str, input: Value, act: &dyn Fn(&mut History) -> Value| {
            let mut h = History::new(1_000);
            cases.push(json!({ "name": name, "input": input, "expected": act(&mut h) }));
        };

        case("A short series reads in time order", json!({ "samples": [[1, 5], [2, -3], [3, 7]] }), &|h| {
            push(h, 1, "a", &[(1.0, 5.0), (2.0, -3.0), (3.0, 7.0)]);
            json!({ "summary": summary(h, "1:a"), "read": read(h, "1:a") })
        });
        case("Out-of-order timestamps are stored in time order (H8)", json!({ "samples": [[3, 1], [1, 2], [2, 3]] }), &|h| {
            push(h, 1, "a", &[(3.0, 1.0), (1.0, 2.0), (2.0, 3.0)]);
            read(h, "1:a")
        });
        case("A repeated timestamp keeps both samples in arrival order", json!({ "samples": [[5, 1], [5, 2]] }), &|h| {
            push(h, 1, "a", &[(5.0, 1.0), (5.0, 2.0)]);
            read(h, "1:a")
        });
        case("Exactly full", json!({ "capacity": 1_000, "pushes": 1_000 }), &|h| {
            push(h, 1, "a", &ramp(1_000, 0));
            summary(h, "1:a")
        });
        case(
            "Past capacity: the oldest are evicted and the statistics cover the samples held (H2)",
            json!({ "capacity": 1_000, "pushes": 1_250, "values": "0..1249 ascending" }),
            &|h| {
                push(h, 1, "a", &ramp(1_250, 0));
                summary(h, "1:a")
            },
        );
        case(
            "An evicted extreme leaves the statistics (H2)",
            json!({ "capacity": 1_000, "pushes": "one -100 then 1,000 zeros" }),
            &|h| {
                push(h, 1, "a", &[(0.0, -100.0)]);
                push(h, 1, "a", &ramp(1_000, 1).into_iter().map(|(t, _)| (t, 0.0)).collect::<Vec<_>>());
                summary(h, "1:a")
            },
        );
        case(
            "A capacity change reaches live series: lowered trims the oldest, raised lets them grow (H5)",
            json!({ "capacity": [1_000, 500, 2_000], "pushes": [800, 1_000] }),
            &|h| {
                push(h, 1, "a", &ramp(800, 0));
                h.set_capacity(500);
                let lowered = summary(h, "1:a");
                h.set_capacity(2_000);
                push(h, 1, "a", &ramp(1_000, 800));
                json!({ "lowered": lowered, "raised": summary(h, "1:a") })
            },
        );
        case(
            "A catalogue's backlog replaces its series whatever arrived before; ad-hoc series stay (H6)",
            json!({ "live": [[1, 50], [2, 60]], "adhoc": [[1, 7]], "backlog": [[10, 1], [11, 2]], "then": [[12, 3]] }),
            &|h| {
                push(h, 1, "a", &[(1.0, 50.0), (2.0, 60.0)]);
                h.record(&frame("can", 0, 1.0), 1, "byte[0]", 7.0, true);
                h.drop_catalogue_series();
                push(h, 1, "a", &[(10.0, 1.0), (11.0, 2.0)]);
                push(h, 1, "a", &[(12.0, 3.0)]);
                json!({ "a": summary(h, "1:a"), "byte[0]": read(h, "1:byte[0]") })
            },
        );
        case(
            "One signal on two protocols or buses is held apart and read merged in time order, or one wire when named (H9)",
            json!({ "can bus 0": [[1, 1], [3, 3]], "can bus 1": [[2, 2]], "modbus bus 0": [[4, 4]] }),
            &|h| {
                h.record(&frame("can", 0, 1.0), 1, "a", 1.0, false);
                h.record(&frame("can", 1, 2.0), 1, "a", 2.0, false);
                h.record(&frame("can", 0, 3.0), 1, "a", 3.0, false);
                h.record(&frame("modbus", 0, 4.0), 1, "a", 4.0, false);
                let wire = |protocol: &str, bus| SignalRef { protocol: Some(protocol.into()), bus: Some(bus), ..signal("1:a") };
                json!({
                    "merged": h.values(&signal("1:a")),
                    "can bus 1": h.values(&wire("can", 1)),
                    "modbus": h.values(&SignalRef { protocol: Some("modbus".into()), ..signal("1:a") }),
                    "series": h.series.len(),
                })
            },
        );
        case(
            "Two signals of one frame and the same name on two frames are separate series",
            json!({ "samples": ["1:a", "1:b", "2:a"] }),
            &|h| {
                push(h, 1, "a", &[(1.0, 1.0)]);
                push(h, 1, "b", &[(1.0, 2.0)]);
                push(h, 2, "a", &[(1.0, 3.0)]);
                json!(["1:a", "1:b", "2:a"].map(|k| h.values(&signal(k))))
            },
        );
        case(
            "A non-finite value is not kept, so the statistics stay finite (H3)",
            json!({ "samples": [[1, 1], [2, "NaN"], [3, "Infinity"], [4, 3]] }),
            &|h| {
                push(h, 1, "a", &[(1.0, 1.0), (2.0, f64::NAN), (3.0, f64::INFINITY), (4.0, 3.0)]);
                summary(h, "1:a")
            },
        );
        case("The last N values of a signal, with the statistics of all held", json!({ "samples": "0..9", "last": 3 }), &|h| {
            push(h, 1, "a", &ramp(10, 0));
            json!(h.series(&signal("1:a"), Some(3)))
        });
        case("A signal without samples reads empty", json!({}), &|h| json!(h.series(&signal("9:none"), Some(3))));

        golden("dashboardSeries.json", cases);
    }

    #[test]
    fn aligned_chart_data_matches_the_fixture() {
        let cases: Vec<(&str, Vec<&str>, Vec<(&str, f64, f64)>)> = vec![
            ("No signals", vec![], vec![]),
            ("No signal has data", vec!["1:a"], vec![]),
            (
                "Same rate, same timestamps",
                vec!["1:a", "1:b"],
                vec![("1:a", 1.0, 10.0), ("1:a", 2.0, 20.0), ("1:a", 3.0, 30.0), ("1:b", 1.0, 1.0), ("1:b", 2.0, 2.0), ("1:b", 3.0, 3.0)],
            ),
            (
                "Multi-rate: x is every stamp of both, each series has values only at its own (H1)",
                vec!["1:fast", "2:slow"],
                vec![
                    ("1:fast", 1.0, 1.0),
                    ("1:fast", 1.1, 2.0),
                    ("1:fast", 1.2, 3.0),
                    ("1:fast", 1.3, 4.0),
                    ("1:fast", 1.4, 5.0),
                    ("2:slow", 1.25, 100.0),
                    ("2:slow", 1.45, 200.0),
                ],
            ),
            (
                "Multi-rate: the signal order changes only the column order (H1)",
                vec!["2:slow", "1:fast"],
                vec![
                    ("1:fast", 1.0, 1.0),
                    ("1:fast", 1.1, 2.0),
                    ("1:fast", 1.2, 3.0),
                    ("1:fast", 1.3, 4.0),
                    ("1:fast", 1.4, 5.0),
                    ("2:slow", 1.25, 100.0),
                    ("2:slow", 1.45, 200.0),
                ],
            ),
            (
                "Offset start: the later series begins at its own first stamp (H1)",
                vec!["1:a", "1:b"],
                vec![("1:a", 0.0, 0.0), ("1:a", 10.0, 10.0), ("1:a", 20.0, 20.0), ("1:b", 20.0, 2.0), ("1:b", 30.0, 3.0), ("1:b", 40.0, 4.0)],
            ),
            ("A signal without data is a column of nulls", vec!["9:empty", "1:a"], vec![("1:a", 1.0, 1.0), ("1:a", 2.0, 2.0)]),
            ("The same signal twice reads twice", vec!["1:a", "1:a"], vec![("1:a", 1.0, 1.0), ("1:a", 2.0, 2.0)]),
            ("A repeated stamp in one series shows its later value", vec!["1:a"], vec![("1:a", 5.0, 1.0), ("1:a", 5.0, 2.0)]),
        ];
        let cases = cases
            .into_iter()
            .map(|(name, signals, pushes)| {
                let mut h = History::new(1_000);
                for &(key, t, v) in &pushes {
                    let r = signal(key);
                    h.record(&frame("can", 0, t), r.frame_id, &r.name, v, false);
                }
                let refs: Vec<_> = signals.iter().map(|k| signal(k)).collect();
                json!({
                    "name": name,
                    "input": { "signals": signals, "pushes": pushes.iter().map(|(k, t, v)| json!([k, t, v])).collect::<Vec<_>>() },
                    "expected": h.aligned(&refs),
                })
            })
            .collect();
        golden("dashboardAlignedData.json", cases);
    }

    #[test]
    fn histogram_bins_match_the_fixture() {
        let inputs: Vec<(&str, Vec<f64>, f64)> = vec![
            ("Empty values", vec![], 10.0),
            ("Zero bins", vec![1.0, 2.0, 3.0], 0.0),
            ("Negative bins", vec![1.0, 2.0, 3.0], -1.0),
            ("One distinct value: one bin [v, v+1) whatever the bin count", vec![4.0; 3], 10.0),
            ("Uniform 0..9 in 10 bins", (0..10).map(f64::from).collect(), 10.0),
            ("The max lands in the last bin (closed on the right)", vec![0.0, 10.0], 4.0),
            ("Float steps: 0.1 widths", vec![0.0, 0.3, 0.7, 1.0], 10.0),
            ("Negative range", vec![-5.0, -3.0, -1.0], 2.0),
            ("More bins than values", vec![1.0, 2.0], 5.0),
            ("A fractional bin count rounds (H4)", vec![0.0, 1.0, 2.0, 3.0], 2.5),
            ("A NaN value is skipped (H4)", vec![1.0, f64::NAN, 3.0], 2.0),
            ("Infinity is skipped (H4)", vec![1.0, f64::INFINITY, 3.0], 2.0),
        ];
        let cases = inputs
            .into_iter()
            .map(|(name, values, bins)| {
                json!({
                    "name": name,
                    "input": { "values": values.iter().map(|v| if v.is_infinite() { "Infinity".into() } else { v.to_string() }).collect::<Vec<_>>(), "binCount": bins },
                    "expected": histogram(&values, bin_count(bins)),
                })
            })
            .collect();
        golden("dashboardHistogram.json", cases);
    }

    #[test]
    fn panel_csv_matches_the_fixture() {
        type Push<'a> = (&'a str, f64, f64);
        let cases: Vec<(&str, Vec<&str>, Vec<&str>, Vec<Push>)> = vec![
            ("No signals", vec![], vec![], vec![]),
            ("Signals without data", vec!["1:a"], vec!["a"], vec![]),
            (
                "Union of timestamps, blanks where a series has none; the header as the panel labels it",
                vec!["1:speed", "1:rpm"],
                vec!["Speed (km/h)", "rpm"],
                vec![
                    ("1:speed", 1_700_000_000.0, 10.0),
                    ("1:speed", 1_700_000_000.5, 11.0),
                    ("1:rpm", 1_700_000_000.25, 900.0),
                    ("1:rpm", 1_700_000_000.5, 950.0),
                ],
            ),
            ("A header with a comma or quote is quoted", vec!["1:a,\"b\""], vec!["a,\"b\" (V)"], vec![("1:a,\"b\"", 2.0, 0.1 + 0.2)]),
            ("A repeated timestamp in one series keeps the later value and one row", vec!["1:a"], vec!["a"], vec![("1:a", 5.0, 1.0), ("1:a", 5.0, 2.0)]),
            (
                "Sub-millisecond stamps print to the microsecond (H7)",
                vec!["1:a"],
                vec!["a"],
                vec![("1:a", 1.0001, 1.0), ("1:a", 1.0002, 2.0)],
            ),
            (
                "Byte columns of a flow panel",
                vec!["256:byte_0_8b_le", "256:byte_1_8b_le"],
                vec!["byte_0_8b_le", "byte_1_8b_le"],
                vec![("256:byte_0_8b_le", 1.0, 170.0), ("256:byte_1_8b_le", 2.0, 85.0)],
            ),
        ];
        let cases = cases
            .into_iter()
            .map(|(name, signals, headers, pushes)| {
                let mut h = History::new(1_000);
                for &(key, t, v) in &pushes {
                    let (id, signal_name) = key.split_once(':').unwrap();
                    h.record(&frame("can", 0, t), id.parse().unwrap(), signal_name, v, false);
                }
                let refs: Vec<_> = signals.iter().map(|k| signal(k)).collect();
                let headers: Vec<String> = headers.into_iter().map(String::from).collect();
                json!({
                    "name": name,
                    "input": { "signals": signals, "headers": headers, "pushes": pushes.iter().map(|(k, t, v)| json!([k, t, v])).collect::<Vec<_>>() },
                    "expected": h.csv(&refs, &headers).split('\n').collect::<Vec<_>>(),
                })
            })
            .collect();
        golden("dashboardExport.json", cases);
    }

    #[test]
    fn bit_changes_count_every_frame_until_cleared() {
        let mut h = History::new(1_000);
        let f = |id: u32, bytes: Vec<u8>| -> FrameMessage {
            serde_json::from_value(json!({ "protocol": "can", "timestamp_us": 0, "frame_id": id, "bus": 0, "dlc": bytes.len(), "bytes": bytes })).unwrap()
        };
        h.record_toggles(&[f(0x1100, vec![0]), f(0x2100, vec![3]), f(0x200, vec![1])], Some(0xFFF));
        let counts = |h: &History, id| serde_json::to_value(h.heatmap(id)).unwrap();
        assert_eq!(counts(&h, 0x100), json!({ "frameId": 0x100, "counts": [1, 1, 0, 0, 0, 0, 0, 0], "frames": 2 }));
        assert_eq!(counts(&h, 0x200)["frames"], json!(1));
        h.reset_toggles();
        assert_eq!(counts(&h, 0x100), Value::Null);
    }

    #[test]
    fn the_ws_queries_read_a_watched_session_and_answer_empty_for_others() {
        let session = "history-queries";
        open(session);
        if let Some(shared) = get(session) {
            push(&mut shared.lock().unwrap(), 1, "a", &[(1.0, 2.0), (2.0, 4.0)]);
        }
        let query = |op: &str, params: Value| dispatch(op, params).unwrap();
        let signals = json!([{ "frameId": 1, "name": "a" }]);

        let series = query("dashboard.series", json!({ "session_id": session, "signals": signals, "last": 1 }));
        assert_eq!(series, json!([{ "t": [2.0], "v": [4.0], "stats": { "min": 2.0, "max": 4.0, "mean": 3.0, "count": 2, "latest": 4.0, "latestT": 2.0 } }]));
        let aligned = query("dashboard.aligned", json!({ "session_id": session, "signals": signals }));
        assert_eq!((aligned["x"].clone(), aligned["y"].clone()), (json!([1.0, 2.0]), json!([[2.0, 4.0]])));
        let bins = query("dashboard.histogram", json!({ "session_id": session, "signals": signals, "bins": 2 }));
        assert_eq!(bins[0].as_array().map(Vec::len), Some(2));
        let csv = query("dashboard.csv", json!({ "session_id": session, "signals": signals, "headers": ["a"] }));
        assert_eq!(csv, json!("timestamp,a\n1970-01-01T00:00:01.000000Z,2\n1970-01-01T00:00:02.000000Z,4\n"));

        query("dashboard.clear", json!({ "session_id": session }));
        assert_eq!(query("dashboard.series", json!({ "session_id": session, "signals": signals }))[0]["t"], json!([]));
        forget(session);
        assert_eq!(query("dashboard.bitChanges", json!({ "session_id": session })), json!([]));
        assert!(dispatch("dashboard.nope", json!({ "session_id": session })).is_err());
    }
}
