import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../api/store", () => ({
  storeGet: vi.fn(async () => null),
  storeSet: vi.fn(async () => undefined),
  storeDelete: vi.fn(async () => undefined),
}));

import { useDashboardStore } from "../stores/dashboardStore";
import { catalogToResolved } from "../utils/catalogParser";
import type { Catalog } from "../types/catalogModel";

// `display-hints.catalog.json` is what `catalog.parse` serves for `display-hints.toml`;
// the Rust test `catalog_parse_serves_the_dashboard_display_hints_fixture` pins it.
const fixture = (name: string) => readFileSync(resolve(__dirname, "fixtures", name), "utf-8");

function addAsInstruments(entries: Array<{ frameId: number; signalName: string }>) {
  const catalog = JSON.parse(fixture("display-hints.catalog.json")) as Catalog;
  useDashboardStore.setState({ panels: [], layout: [] });
  useDashboardStore.getState().applyParsedCatalog(catalogToResolved(catalog, fixture("display-hints.toml")));
  useDashboardStore.getState().addSignalsAsInstruments(entries);
  return useDashboardStore.getState().panels.map((p) => ({
    signal: `${p.signals[0].frameId}:${p.signals[0].signalName}`,
    type: p.type,
    minValue: p.minValue,
    maxValue: p.maxValue,
    widgetConfig: p.widgetConfig,
  }));
}

const instrument = (frameId: number, signalName: string) => addAsInstruments([{ frameId, signalName }])[0];

beforeEach(() => vi.useFakeTimers());

describe("Add as Instruments", () => {
  it("matches the golden taken from the TOML re-parse it replaced", () => {
    const panels = addAsInstruments(
      ["Steering", "Coolant", "Speed"].map((signalName) => ({ frameId: 0x100, signalName })),
    );
    expect(panels).toEqual(JSON.parse(fixture("display-hints.instruments.json")));
  });

  it("gives a mux-case signal its display hint", () => {
    expect(instrument(0x100, "Boost")).toMatchObject({
      type: "rotary",
      widgetConfig: { rotary: { startAngle: -90, endAngle: 90 } },
    });
  });

  it("gives a mirrored signal its source's display hint", () => {
    expect(instrument(0x200, "Coolant")).toMatchObject({
      type: "level-bar",
      widgetConfig: { levelBar: { orientation: "vertical" } },
    });
  });

  it("gives a Modbus signal keyed by name its display hint", () => {
    expect(instrument(13019, "SoC")).toMatchObject({
      type: "level-bar",
      widgetConfig: { levelBar: { orientation: "horizontal" } },
    });
  });

  it("infers the widget when the hint names one the dashboard lacks", () => {
    expect(instrument(0x100, "Mood").type).toBe("level-bar");
  });
});
