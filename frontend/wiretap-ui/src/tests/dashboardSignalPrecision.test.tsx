import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../api/store", () => ({
  storeGet: vi.fn(async () => null),
  storeSet: vi.fn(async () => undefined),
  storeDelete: vi.fn(async () => undefined),
}));

import { formatValue } from "../apps/dashboard/utils/dashboardFormat";
import { useDashboardStore, signalKey, type DashboardPanel } from "../stores/dashboardStore";
import ListPanel from "../apps/dashboard/views/panels/list/ListPanel";
import type { Catalog } from "../types/catalogModel";

describe("formatValue with a signal's precision", () => {
  it("pads to exactly that many places", () => {
    expect(formatValue(17, 2)).toBe("17.00");
  });

  it("rounds half away from zero on the shortest decimal", () => {
    expect(formatValue(0.425, 2)).toBe("0.43");
    expect(formatValue(20.91, 0)).toBe("21");
  });

  it("never reads negative zero", () => {
    expect(formatValue(-0.004, 2)).toBe("0.00");
  });

  it("keeps the magnitude rule without a precision", () => {
    expect(formatValue(17)).toBe("17.000");
    expect(formatValue(17, undefined)).toBe("17.000");
    expect(formatValue(12_345.6)).toBe("12346");
  });
});

describe("Dashboard panels honour the catalogue's precision", () => {
  const catalog = {
    meta: { name: "precision", version: 1 },
    protocol: "can",
    frames: [{
      frameId: 0x100,
      protocol: "can",
      signals: [
        { name: "Scaled", startBit: 0, bitLength: 8, factor: 0.1, precision: 2 },
        { name: "Plain", startBit: 8, bitLength: 8, factor: 0.1 },
      ],
    }],
  } as unknown as Catalog;

  const panel = {
    id: "p", type: "list", title: "List", minValue: 0, maxValue: 100,
    signals: [
      { frameId: 0x100, signalName: "Scaled", colour: "#000" },
      { frameId: 0x100, signalName: "Plain", colour: "#000" },
    ],
  } as DashboardPanel;

  function renderList() {
    useDashboardStore.setState({
      latest: new Map([[signalKey(0x100, "Scaled"), 17], [signalKey(0x100, "Plain"), 17]]),
    });
    return renderToStaticMarkup(createElement(ListPanel, { panel }));
  }

  it("formats each signal with its own precision", () => {
    useDashboardStore.getState().applyCatalog(catalog);
    const markup = renderList();
    expect(markup).toContain(">17.00<");
    expect(markup).toContain(">17.000<");
  });

  it("takes a catalogue edit at the next render", () => {
    useDashboardStore.getState().applyCatalog(catalog);
    const edited = structuredClone(catalog);
    edited.frames[0].signals[0].precision = 1;
    useDashboardStore.getState().applyCatalog(edited);
    expect(renderList()).toContain(">17.0<");
  });
});
