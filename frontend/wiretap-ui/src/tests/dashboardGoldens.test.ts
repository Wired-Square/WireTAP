// P5 D1: the Dashboard's ring buffers, running statistics, aligned chart data,
// heatmap toggles, histogram and CSV export, pinned before history moves to Rust.

import { describe, it, vi, beforeEach } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../api/store", () => ({
  storeGet: vi.fn(async () => null),
  storeSet: vi.fn(async () => undefined),
  storeDelete: vi.fn(async () => undefined),
}));

import {
  useDashboardStore,
  readTimeSeries,
  buildAlignedData,
  type DashboardPanel,
  type SignalRef,
  type SignalTimeSeries,
  type SignalValueEntry,
} from "../stores/dashboardStore";
import { computeHistogram } from "../apps/dashboard/utils/dashboardHistogram";
import { buildPanelCsv, buildFlowPanelCsv } from "../apps/dashboard/utils/dashboardExport";
import { expectGolden, type GoldenCase } from "./catalogGoldens";

const store = () => useDashboardStore.getState();
const series = (key: string) => store().seriesBuffers.get(key) as SignalTimeSeries;

const entries = (frameId: number, signalName: string, samples: [number, number][], replace?: boolean): SignalValueEntry[] =>
  samples.map(([timestamp, value]) => ({ frameId, signalName, timestamp, value, ...(replace ? { replace } : {}) }));

const ramp = (n: number, from = 0): [number, number][] => Array.from({ length: n }, (_, i) => [from + i, from + i]);

/** The buffer's shape and the ends of its chronological read, not all 1,000 slots. */
function summary(s: SignalTimeSeries) {
  const { timestamps, values } = readTimeSeries(s);
  return {
    capacity: s.timestamps.length,
    count: s.count,
    writeIndex: s.writeIndex,
    latest: [s.latestTimestamp, s.latestValue],
    stats: { min: s.min, max: s.max, sum: s.sum, sampleCount: s.sampleCount, mean: s.sum / s.sampleCount },
    windowMin: Math.min(...values),
    windowMax: Math.max(...values),
    head: timestamps.slice(0, 3).map((t, i) => [t, values[i]]),
    tail: timestamps.slice(-3).map((t, i) => [t, values.slice(-3)[i]]),
  };
}

const ref = (frameId: number, signalName: string, extra: Partial<SignalRef> = {}): SignalRef => ({
  frameId,
  signalName,
  colour: "#000",
  ...extra,
});

const panel = (signals: SignalRef[], extra: Partial<DashboardPanel> = {}): DashboardPanel => ({
  id: "p",
  type: "line-chart",
  title: "P",
  signals,
  minValue: 0,
  maxValue: 100,
  ...extra,
});

const asCsvCell = (v: number) => (Number.isNaN(v) ? "NaN" : v);

beforeEach(() => {
  store().setBufferCapacity(1_000);
  store().clearData();
});

describe("dashboard store goldens", () => {
  it("ring buffers, running statistics and reads", async () => {
    const cases: GoldenCase[] = [];
    const run = (name: string, input: unknown, act: () => unknown) => {
      store().setBufferCapacity(1_000);
      store().clearData();
      cases.push({ name, input, expected: act() });
    };

    run("A short series reads in push order", { samples: [[1, 5], [2, -3], [3, 7]] }, () => {
      store().pushSignalValues(entries(1, "a", [[1, 5], [2, -3], [3, 7]]));
      return { ...summary(series("1:a")), read: readTimeSeries(series("1:a")) };
    });

    run("Out-of-order timestamps are stored as pushed, not sorted", { samples: [[3, 1], [1, 2], [2, 3]] }, () => {
      store().pushSignalValues(entries(1, "a", [[3, 1], [1, 2], [2, 3]]));
      return readTimeSeries(series("1:a"));
    });

    run("Exactly full: write index wraps to 0", { capacity: 1_000, pushes: 1_000 }, () => {
      store().pushSignalValues(entries(1, "a", ramp(1_000)));
      return summary(series("1:a"));
    });

    run(
      "Past capacity: the oldest are evicted; min/max/sum still cover every sample ever pushed",
      { capacity: 1_000, pushes: 1_250, values: "0..1249 ascending" },
      () => {
        store().pushSignalValues(entries(1, "a", ramp(1_250)));
        return summary(series("1:a"));
      },
    );

    run(
      "An evicted extreme stays the running min",
      { capacity: 1_000, pushes: "one -100 then 1,000 zeros" },
      () => {
        store().pushSignalValues(entries(1, "a", [[0, -100], ...ramp(1_000, 1).map(([t]) => [t, 0] as [number, number])]));
        return summary(series("1:a"));
      },
    );

    run("setBufferCapacity clamps to 1,000..100,000", { requested: [10, 250_000] }, () => {
      store().setBufferCapacity(10);
      store().pushSignalValues(entries(1, "low", [[0, 0]]));
      store().setBufferCapacity(250_000);
      store().pushSignalValues(entries(1, "high", [[0, 0]]));
      return { low: series("1:low").timestamps.length, high: series("1:high").timestamps.length };
    });

    run(
      "A capacity change reaches only series created afterwards",
      { before: 1_000, after: 2_000 },
      () => {
        const length = (key: string) => series(key).timestamps.length;
        store().pushSignalValues(entries(1, "old", [[0, 0]]));
        store().setBufferCapacity(2_000);
        store().pushSignalValues(entries(1, "old", [[1, 1]]));
        store().pushSignalValues(entries(1, "new", [[1, 1]]));
        const oldAfterChange = length("1:old");
        const created = length("1:new");
        store().clearData();
        store().pushSignalValues(entries(1, "old", [[2, 2]]));
        return { oldAfterChange, new: created, oldAfterClearData: length("1:old") };
      },
    );

    run(
      "A backlog (replace) starts the series afresh, once per batch, and resets the statistics",
      { first: [[1, 50], [2, 60]], backlog: [[10, 1], [11, 2]], then: [[12, 3]] },
      () => {
        store().pushSignalValues(entries(1, "a", [[1, 50], [2, 60]]));
        store().pushSignalValues(entries(1, "a", [[10, 1], [11, 2]], true));
        store().pushSignalValues(entries(1, "a", [[12, 3]]));
        return summary(series("1:a"));
      },
    );

    run(
      "Two signals of one frame and the same name on two frames are separate keys",
      { samples: ["1:a", "1:b", "2:a"] },
      () => {
        store().pushSignalValues([...entries(1, "a", [[1, 1]]), ...entries(1, "b", [[1, 2]]), ...entries(2, "a", [[1, 3]])]);
        return [...store().seriesBuffers.keys()];
      },
    );

    run("A NaN value: min/max skip it, sum and mean become NaN", { samples: [[1, 1], [2, NaN], [3, 3]] }, () => {
      store().pushSignalValues(entries(1, "a", [[1, 1], [2, NaN], [3, 3]]));
      const s = series("1:a");
      return { min: s.min, max: s.max, sum: String(s.sum), sampleCount: s.sampleCount, latestValue: String(s.latestValue) };
    });

    run("dataVersion bumps once per push call, and clearData resets it to 0", { pushes: 3 }, () => {
      const versions = [store().dataVersion];
      store().pushSignalValues(entries(1, "a", [[1, 1]]));
      versions.push(store().dataVersion);
      store().pushSignalValues(entries(1, "a", [[2, 2], [3, 3]]));
      versions.push(store().dataVersion);
      store().pushSignalValues([]);
      versions.push(store().dataVersion);
      store().clearData();
      versions.push(store().dataVersion);
      return versions;
    });

    await expectGolden("dashboardSeries.json", cases, "data");
  });

  it("buildAlignedData", async () => {
    const cases: GoldenCase[] = [];
    const run = (name: string, signals: SignalRef[], pushes: SignalValueEntry[]) => {
      store().clearData();
      store().pushSignalValues(pushes);
      cases.push({
        name,
        input: { signals: signals.map((s) => `${s.frameId}:${s.signalName}`), pushes: pushes.map((e) => [`${e.frameId}:${e.signalName}`, e.timestamp, e.value]) },
        expected: buildAlignedData(signals, store().seriesBuffers),
      });
    };

    run("No signals", [], []);
    run("No signal has data", [ref(1, "a")], []);
    run("Same rate, same timestamps", [ref(1, "a"), ref(1, "b")], [
      ...entries(1, "a", [[1, 10], [2, 20], [3, 30]]),
      ...entries(1, "b", [[1, 1], [2, 2], [3, 3]]),
    ]);
    run(
      "Multi-rate: the second series' raw values sit on the base's x, unaligned and shorter (not interpolated)",
      [ref(1, "fast"), ref(2, "slow")],
      [...entries(1, "fast", [[1.0, 1], [1.1, 2], [1.2, 3], [1.3, 4], [1.4, 5]]), ...entries(2, "slow", [[1.25, 100], [1.45, 200]])],
    );
    run(
      "Multi-rate: a longer non-base series overruns the base's x",
      [ref(2, "slow"), ref(1, "fast")],
      [...entries(1, "fast", [[1.0, 1], [1.1, 2], [1.2, 3], [1.3, 4], [1.4, 5]]), ...entries(2, "slow", [[1.25, 100], [1.45, 200]])],
    );
    run(
      "Offset start: the later series' first value is drawn at the base's first timestamp",
      [ref(1, "a"), ref(1, "b")],
      [...entries(1, "a", [[0, 0], [10, 10], [20, 20]]), ...entries(1, "b", [[20, 2], [30, 3], [40, 4]])],
    );
    run(
      "The first signal without data: the base is the next one, the empty one is nulls of the base's length",
      [ref(9, "empty"), ref(1, "a")],
      entries(1, "a", [[1, 1], [2, 2]]),
    );
    run("The same signal twice reads twice", [ref(1, "a"), ref(1, "a")], entries(1, "a", [[1, 1], [2, 2]]));

    await expectGolden("dashboardAlignedData.json", cases, "data");
  });

  it("bit toggles from Rust", async () => {
    const cases: GoldenCase[] = [];
    store().clearData();
    store().setBitToggles([{ frameId: 0x100, counts: [1, 0, 2], frames: 3 }]);
    store().setBitToggles([{ frameId: 0x100, counts: [5], frames: 9 }, { frameId: 0x200, counts: [0], frames: 1 }]);
    cases.push({
      name: "Each batch replaces a frame's counts wholesale; other frames are kept",
      input: [[{ frameId: 0x100, counts: [1, 0, 2], frames: 3 }], [{ frameId: 0x100, counts: [5], frames: 9 }, { frameId: 0x200, counts: [0], frames: 1 }]],
      expected: store().bitChangeCounts,
    });
    const before = store().bitChangeCounts;
    store().setBitToggles([]);
    cases.push({ name: "An empty batch changes nothing (same map)", input: [], expected: store().bitChangeCounts === before });
    store().clearData();
    cases.push({ name: "clearData empties the counts", input: null, expected: store().bitChangeCounts });
    await expectGolden("dashboardBitToggles.json", cases, "data");
  });
});

describe("computeHistogram", () => {
  it("bins", async () => {
    const inputs: [string, number[], number][] = [
      ["Empty values", [], 10],
      ["Zero bins", [1, 2, 3], 0],
      ["Negative bins", [1, 2, 3], -1],
      ["One distinct value: one bin [v, v+1) whatever the bin count", [4, 4, 4], 10],
      ["Uniform 0..9 in 10 bins", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 10],
      ["The max lands in the last bin (closed on the right)", [0, 10], 4],
      ["Float steps: 0.1 widths", [0, 0.3, 0.7, 1], 10],
      ["Negative range", [-5, -3, -1], 2],
      ["More bins than values", [1, 2], 5],
      ["A fractional bin count throws", [0, 1, 2, 3], 2.5],
      ["A NaN value throws (its bin index is NaN)", [1, NaN, 3], 2],
      ["Infinity gives no bins", [1, Infinity], 2],
    ];
    const cases: GoldenCase[] = inputs.map(([name, values, binCount]) => {
      let expected: unknown;
      try {
        expected = computeHistogram(values, binCount);
      } catch (e) {
        expected = { threw: String(e) };
      }
      return { name, input: { values: values.map(String), binCount }, expected };
    });
    await expectGolden("dashboardHistogram.json", cases, "data");
  });
});

describe("dashboard CSV export", () => {
  it("panel and flow CSV", async () => {
    const cases: GoldenCase[] = [];
    const run = (name: string, p: DashboardPanel, pushes: SignalValueEntry[], flow = false) => {
      store().clearData();
      store().pushSignalValues(pushes);
      const buffers = store().seriesBuffers;
      cases.push({
        name,
        input: {
          panel: { signals: p.signals.map(({ frameId, signalName, unit, displayName }) => ({ frameId, signalName, unit, displayName })), targetFrameId: p.targetFrameId, byteCount: p.byteCount },
          pushes: pushes.map((e) => [`${e.frameId}:${e.signalName}`, e.timestamp, asCsvCell(e.value)]),
        },
        expected: (flow ? buildFlowPanelCsv(p, buffers) : buildPanelCsv(p, buffers)).split("\n"),
      });
    };

    run("No signals", panel([]), []);
    run("Signals without data", panel([ref(1, "a")]), []);
    run(
      "Union of timestamps, blanks where a series has none; unit and display name in the header",
      panel([ref(1, "speed", { unit: "km/h", displayName: "Speed" }), ref(1, "rpm")]),
      [...entries(1, "speed", [[1_700_000_000, 10], [1_700_000_000.5, 11]]), ...entries(1, "rpm", [[1_700_000_000.25, 900], [1_700_000_000.5, 950]])],
    );
    run(
      "A header with a comma or quote is quoted; a NaN value prints NaN",
      panel([ref(1, 'a,"b"', { unit: "V" })]),
      entries(1, 'a,"b"', [[1, NaN], [2, 0.1 + 0.2]]),
    );
    run(
      "A repeated timestamp in one series keeps the later value and one row",
      panel([ref(1, "a")]),
      entries(1, "a", [[5, 1], [5, 2]]),
    );
    run(
      "Sub-millisecond stamps print the same ISO time (ms precision) on two rows",
      panel([ref(1, "a")]),
      entries(1, "a", [[1.0001, 1], [1.0002, 2]]),
    );
    run("Flow with no target frame", panel([], { type: "flow" }), [], true);
    run(
      "Flow defaults to 8 byte columns named byte_N_8b_le",
      panel([], { type: "flow", targetFrameId: 0x100 }),
      [...entries(0x100, "byte_0_8b_le", [[1, 0xaa]]), ...entries(0x100, "byte_7_8b_le", [[2, 0x55]])],
      true,
    );
    run(
      "Flow byteCount narrows the columns; a byte past it is not exported",
      panel([], { type: "flow", targetFrameId: 0x100, byteCount: 2 }),
      [...entries(0x100, "byte_1_8b_le", [[1, 1]]), ...entries(0x100, "byte_3_8b_le", [[2, 3]])],
      true,
    );

    await expectGolden("dashboardExport.json", cases, "data");
  });
});
