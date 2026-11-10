// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type uPlot from "uplot";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: null }) }));

const built = vi.hoisted(() => [] as uPlot.Options[]);
vi.mock("uplot", () => ({
  default: class {
    constructor(opts: uPlot.Options) {
      built.push(opts);
    }
    destroy() {}
    setData() {}
    static paths = { bars: () => () => null };
  },
}));

import LineChartPanel from "../apps/dashboard/views/panels/line-chart/LineChartPanel";
import HistogramPanel from "../apps/dashboard/views/panels/histogram/HistogramPanel";
import type { DashboardPanel } from "../stores/dashboardStore";

const lastXAxis = () => built[built.length - 1]?.axes?.[0];

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

describe("a dashboard line chart", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("takes the new theme's axis and grid colours when the theme changes", async () => {
    const html = document.documentElement;
    html.style.setProperty("--text-primary", "#eeeeee");
    html.style.setProperty("--border-default", "#333333");
    const panel = {
      id: "c", type: "line-chart", title: "", minValue: 0, maxValue: 100,
      signals: [{ frameId: 0x100, signalName: "Speed", colour: "#ff0000" }],
    } as DashboardPanel;
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(<LineChartPanel panel={panel} />));
    expect(lastXAxis()?.stroke).toBe("#eeeeee");

    await act(async () => {
      html.classList.remove("dark");
      html.style.setProperty("--text-primary", "#111111");
      html.style.setProperty("--border-default", "#cccccc");
    });

    const axis = lastXAxis();
    expect(axis?.stroke).toBe("#111111");
    expect(axis?.grid?.stroke).toBe("#cccccc");
  });
});

describe("a dashboard histogram", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("takes the new theme's axis and grid colours when the theme changes", async () => {
    const html = document.documentElement;
    html.style.setProperty("--text-primary", "#eeeeee");
    html.style.setProperty("--border-default", "#333333");
    const panel = {
      id: "h", type: "histogram", title: "", minValue: 0, maxValue: 100,
      signals: [{ frameId: 0x100, signalName: "Speed", colour: "#ff0000" }],
    } as DashboardPanel;
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<HistogramPanel panel={panel} />));
    expect(lastXAxis()?.stroke).toBe("#eeeeee");

    await act(async () => {
      html.style.setProperty("--text-primary", "#111111");
      html.style.setProperty("--border-default", "#cccccc");
    });

    const axis = lastXAxis();
    expect(axis?.stroke).toBe("#111111");
    expect(axis?.grid?.stroke).toBe("#cccccc");
  });
});
