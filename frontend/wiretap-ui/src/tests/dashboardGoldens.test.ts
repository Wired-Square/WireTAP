// P5 D1: the Dashboard's heatmap toggles as the store keeps them. The history,
// its statistics, chart alignment, histogram and CSV are Rust's now
// (`dashboard_history.rs`), which writes their fixtures.

import { describe, it, vi } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../api/store", () => ({
  storeGet: vi.fn(async () => null),
  storeSet: vi.fn(async () => undefined),
  storeDelete: vi.fn(async () => undefined),
}));

import { useDashboardStore } from "../stores/dashboardStore";
import { expectGolden, type GoldenCase } from "./catalogGoldens";

const store = () => useDashboardStore.getState();

describe("dashboard store goldens", () => {
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
