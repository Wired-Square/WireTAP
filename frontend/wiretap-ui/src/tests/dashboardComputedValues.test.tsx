import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../api/store", () => ({
  storeGet: vi.fn(async () => null),
  storeSet: vi.fn(async () => undefined),
  storeDelete: vi.fn(async () => undefined),
}));

import { useDashboardStore, signalKey } from "../stores/dashboardStore";
import StatsOverlay from "../apps/dashboard/views/panels/StatsOverlay";
import { computedValueText } from "../apps/dashboard/widgets/useSignalValues";
import { formatAs } from "../apps/dashboard/utils/dashboardFormat";
import type { ValueFormat } from "../generated/ValueFormat";
import type { Catalog } from "../types/catalogModel";

const catalog = {
  meta: { name: "computed", version: 1 },
  protocol: "can",
  frames: [{
    frameId: 0x100,
    protocol: "can",
    signals: [
      { name: "Speed", startBit: 0, bitLength: 8 },
      { name: "Volts", startBit: 8, bitLength: 8, factor: 0.1, precision: 2 },
    ],
  }],
} as unknown as Catalog;

const rustFormats = [
  { sample: { places: 0, padded: false }, mean: { places: 1, padded: false } },
  { sample: { places: 2, padded: true }, mean: { places: 2, padded: true } },
];

describe("Dashboard computed values read as Rust words them", () => {
  invoke.mockImplementation(async (cmd: string) => (cmd === "signal_value_formats" ? rustFormats : undefined));
  const signals = [
    { frameId: 0x100, signalName: "Speed", colour: "#000" },
    { frameId: 0x100, signalName: "Volts", colour: "#000" },
  ];

  it("words the statistics with each signal's formats from Rust", async () => {
    useDashboardStore.getState().applyCatalog(catalog);
    const stats = [
      { min: 89, mean: 89.25, max: 90, count: 4, latest: 90, latestT: 1 },
      { min: 12, mean: 12.345, max: 12.7, count: 4, latest: 12.7, latestT: 1 },
    ];
    await vi.waitFor(() => {
      const markup = renderToStaticMarkup(createElement(StatsOverlay, { signals, stats }));
      expect(markup).toContain("89 / 89.3 / 90");
      expect(markup).toContain("12.00 / 12.35 / 12.70");
    });
    expect(invoke).toHaveBeenCalledWith("signal_value_formats", {
      signals: [catalog.frames[0].signals[0], catalog.frames[0].signals[1]],
    });
  });

  it("words a cursor reading as a sample of its signal", async () => {
    useDashboardStore.getState().applyCatalog(catalog);
    await vi.waitFor(() => expect(computedValueText(signalKey(0x100, "Speed"), 89, "sample")).toBe("89"));
    expect(computedValueText(signalKey(0x100, "Volts"), 1.5, "sample")).toBe("1.50");
  });
});

describe("formatAs matches Rust's format_value", () => {
  const { cases } = JSON.parse(readFileSync(resolve(__dirname, "fixtures/data/dashboardValueFormat.json"), "utf8")) as {
    cases: { value: number; format: ValueFormat; text: string }[];
  };

  it.each(cases)("$value as $format.places places (padded $format.padded) reads $text", ({ value, format, text }) => {
    expect(formatAs(value, format)).toBe(text);
  });
});
