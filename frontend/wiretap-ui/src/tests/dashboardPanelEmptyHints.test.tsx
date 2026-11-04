// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: null }) }));
vi.mock("uplot", () => ({ default: class {} }));

import { resources } from "../locales";
import type { DashboardPanel, PanelType } from "../stores/dashboardStore";
import GaugePanel from "../apps/dashboard/views/panels/gauge/GaugePanel";
import RotaryPanel from "../apps/dashboard/views/panels/rotary/RotaryPanel";
import IconStatePanel from "../apps/dashboard/views/panels/icon-state/IconStatePanel";
import ListPanel from "../apps/dashboard/views/panels/list/ListPanel";
import LineChartPanel from "../apps/dashboard/views/panels/line-chart/LineChartPanel";
import HistogramPanel from "../apps/dashboard/views/panels/histogram/HistogramPanel";
import LevelBarPanel from "../apps/dashboard/views/panels/level-bar/LevelBarPanel";

const dashboard = resources["en-AU"].dashboard;

vi.mock("react-i18next", async () => {
  const { resources } = await import("../locales");
  const panel = resources["en-AU"].dashboard.panel as Record<string, string>;
  return { useTranslation: () => ({ t: (key: string) => panel[key.replace(/^panel\./, "")] ?? key }) };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const cases: [PanelType, ComponentType<{ panel: DashboardPanel }>, string][] = [
  ["gauge", GaugePanel, dashboard.panel.emptyAddSignal],
  ["rotary", RotaryPanel, dashboard.panel.emptyAddSignal],
  ["level-bar", LevelBarPanel, dashboard.panel.emptyAddSignal],
  ["list", ListPanel, dashboard.panel.emptyAddSignals],
  ["line-chart", LineChartPanel, dashboard.panel.emptyAddSignals],
  ["histogram", HistogramPanel, dashboard.panel.emptyAddSignals],
  ["icon-state", IconStatePanel, dashboard.panel.emptyIconStates],
];

describe("an empty dashboard panel", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it.each(cases)("%s points at the panel menu, not a + button", async (type, Panel, hint) => {
    const panel = { id: "p", type, title: "", signals: [], minValue: 0, maxValue: 100 } as DashboardPanel;
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(<Panel panel={panel} />));
    expect(host.textContent).toBe(hint);
  });
});
