// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import HeatmapPanel from "../apps/dashboard/views/panels/heatmap/HeatmapPanel";
import { useDashboardStore, type DashboardPanel } from "../stores/dashboardStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const panel = { id: "h", type: "heatmap", title: "", signals: [], minValue: 0, maxValue: 0, targetFrameId: 0x100 } as DashboardPanel;

describe("the heatmap panel", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  async function byteRows(payloadBytes: number) {
    useDashboardStore.getState().setBitToggles([{ frameId: 0x100, counts: Array(payloadBytes * 8).fill(0), frames: 1 }]);
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(<HeatmapPanel panel={panel} />));
    return [...host.querySelectorAll("text")].map((t) => t.textContent).filter((t) => t?.startsWith("B"));
  }

  it("draws a row for every byte of a CAN FD payload", async () => {
    const rows = await byteRows(64);
    expect(rows).toHaveLength(64);
    expect(rows[63]).toBe("B63");
  });

  it("keeps eight rows for a classic frame", async () => {
    expect(await byteRows(2)).toHaveLength(8);
  });
});
