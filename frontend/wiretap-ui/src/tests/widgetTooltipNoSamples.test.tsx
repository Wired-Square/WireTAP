// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: null }) }));

import LevelBarPanel from "../apps/dashboard/views/panels/level-bar/LevelBarPanel";
import RotaryPanel from "../apps/dashboard/views/panels/rotary/RotaryPanel";
import IconStatePanel from "../apps/dashboard/views/panels/icon-state/IconStatePanel";
import type { DashboardPanel } from "../stores/dashboardStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const panels: [string, ComponentType<{ panel: DashboardPanel }>][] = [
  ["level-bar", LevelBarPanel],
  ["rotary", RotaryPanel],
  ["icon-state", IconStatePanel],
];

describe("a widget's tooltip", () => {
  let host: HTMLDivElement;
  let root: Root;
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each(panels)("on the %s panel reads a signal with no samples as a dash, not NaN", async (_, Panel) => {
    const panel = {
      id: "w", type: "gauge", title: "", minValue: 0, maxValue: 10,
      signals: [{ frameId: 0x100, signalName: "Never", colour: "" }],
      widgetConfig: { iconState: { states: [{ value: 1, icon: "circle", colour: "" }] } },
    } as DashboardPanel;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Panel panel={panel} />));
    await act(async () => {
      host.firstElementChild!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 5, clientY: 5 }));
    });
    const tooltip = document.body.lastElementChild!.textContent ?? "";
    expect(tooltip).toContain("Never");
    expect(tooltip).not.toContain("NaN");
    expect(tooltip).toContain("—");
  });
});
