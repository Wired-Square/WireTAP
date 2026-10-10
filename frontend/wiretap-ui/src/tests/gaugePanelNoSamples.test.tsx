// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: null }) }));

import GaugePanel from "../apps/dashboard/views/panels/gauge/GaugePanel";
import { useDashboardStore, type DashboardPanel } from "../stores/dashboardStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("the gauge panel", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  const readout = async (signalName: string) => {
    const panel = {
      id: "g", type: "gauge", title: "", minValue: -10, maxValue: 10,
      signals: [{ frameId: 0x100, signalName, colour: "" }],
    } as DashboardPanel;
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(<GaugePanel panel={panel} />));
    return {
      value: host.querySelector('text[font-size="28"]')?.textContent,
      valueArcs: host.querySelectorAll("path").length - 1,
    };
  };

  it("a signal with no samples reads as a dash with no value arc, not zero", async () => {
    expect(await readout("Never")).toEqual({ value: "—", valueArcs: 0 });
  });

  it("a real zero reads as zero", async () => {
    useDashboardStore.getState().setLatest(new Map([["256:Zero", 0]]));
    expect(await readout("Zero")).toEqual({ value: "0.000", valueArcs: 1 });
  });
});
