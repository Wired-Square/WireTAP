// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: null }) }));

import ListPanel from "../apps/dashboard/views/panels/list/ListPanel";
import LevelBarPanel from "../apps/dashboard/views/panels/level-bar/LevelBarPanel";
import GaugePanel from "../apps/dashboard/views/panels/gauge/GaugePanel";
import RotaryPanel from "../apps/dashboard/views/panels/rotary/RotaryPanel";
import CustomSvgPanel from "../apps/dashboard/views/panels/custom-svg/CustomSvgPanel";
import { useDashboardStore, type DashboardPanel } from "../stores/dashboardStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const KEY = "256:Coolant";
const panelOf = (type: string, unit?: string, widgetConfig?: unknown) =>
  ({
    id: "p", type, title: "", minValue: 0, maxValue: 100,
    signals: [{ frameId: 0x100, signalName: "Coolant", unit, colour: "#000" }],
    widgetConfig,
  }) as DashboardPanel;

let root: Root;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(element: ReactElement) {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(element));
  return host.textContent ?? "";
}

function decoded(value: number, display: string) {
  useDashboardStore.getState().clearData();
  useDashboardStore.getState().setLatest(new Map([[KEY, value]]), new Map([[KEY, display]]));
}

describe("Dashboard readouts show the text Rust decoded", () => {
  it("a List row shows it once beside its unit", async () => {
    decoded(89, "89");
    const text = await render(<ListPanel panel={panelOf("list", "°C")} />);
    expect(text).toContain("Coolant89°C");
  });

  it("a level bar shows it with its unit", async () => {
    decoded(89, "89");
    expect(await render(<LevelBarPanel panel={panelOf("level-bar", "°C")} />)).toContain("89 °C");
  });

  it("a gauge shows an enum signal by its label", async () => {
    decoded(3, "Drive");
    expect(await render(<GaugePanel panel={panelOf("gauge")} />)).toContain("Drive");
  });

  it("a rotary readout shows it", async () => {
    decoded(12.5, "12.5");
    expect(await render(<RotaryPanel panel={panelOf("rotary", "deg")} />)).toContain("12.5 deg");
  });

  it("a custom scene's text node shows it", async () => {
    decoded(89, "89");
    const scene = [{ kind: "text", x: 0, y: 0, bind: { signalKey: KEY }, unit: "°C" }];
    expect(await render(<CustomSvgPanel panel={panelOf("custom-svg", undefined, { customSvg: { scene } })} />)).toBe("89 °C");
  });

  it("the hover tooltip shows it", async () => {
    decoded(3, "Drive");
    await render(<ListPanel panel={panelOf("list")} />);
    await act(async () => host.firstElementChild!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    const tooltip = document.body.lastElementChild!;
    expect(tooltip).not.toBe(host);
    expect(tooltip.textContent).toBe("CoolantDrive");
  });

  it("falls back to the precision rule with no decoded text", async () => {
    useDashboardStore.getState().clearData();
    useDashboardStore.getState().setLatest(new Map([[KEY, 89]]));
    expect(await render(<LevelBarPanel panel={panelOf("level-bar", "°C")} />)).toContain("89.000 °C");
  });
});
