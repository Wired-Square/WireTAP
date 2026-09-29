// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ByteStats, PayloadAnalysisResult } from "../utils/analysis/payloadAnalysis";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count === undefined ? key : `${key}(${opts.count})`),
    i18n: { language: "en-AU" },
  }),
}));

const { default: ChangesResultView } = await import("../apps/discovery/views/tools/ChangesResultView");
const { useDiscoveryToolboxStore } = await import("../stores/discoveryToolboxStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const byte = (byteIndex: number, role: ByteStats["role"], sampleCount = 100): ByteStats => ({
  byteIndex,
  min: 0,
  max: 200,
  distinctCount: 50,
  sampleCount,
  role,
  ...(role === "static" ? { staticValue: 0 } : {}),
  ...(role === "sensor" ? { sensorTrend: "increasing" as const } : {}),
});

const frame: PayloadAnalysisResult = {
  frameId: 0x123,
  isExtended: false,
  sampleCount: 100,
  byteStats: [byte(0, "static"), byte(1, "sensor"), byte(2, "static"), byte(3, "sensor", 40), byte(4, "sensor")],
  multiBytePatterns: [{ startByte: 1, length: 3, pattern: "text", sampleText: "abc" }],
  notes: [],
  analyzedFromByte: 0,
  analyzedToByteExclusive: 5,
  isBurstFrame: false,
  isMuxFrame: false,
};

describe("Payload Changes text pattern", () => {
  let root: Root;

  beforeEach(async () => {
    useDiscoveryToolboxStore.getState().setChangesResults({
      tool: "changes",
      frameCount: 100,
      uniqueFrameIds: 1,
      analysisResults: [frame],
      mirrorGroups: [],
    });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<ChangesResultView />));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("a text chip does not hide the byte roles under it from the summary", () => {
    expect(document.body.textContent).toContain("changes.sensor(3)");
  });

  it("a text chip still shows the byte chips under it", () => {
    const chipTitles = [...document.querySelectorAll("[title]")].map((el) => el.getAttribute("title"));
    expect(chipTitles.filter((title) => title?.startsWith("changes.byteTooltipSensor"))).toHaveLength(3);
    expect(chipTitles.some((title) => title?.includes("changes.partialSamples(40)"))).toBe(true);
  });
});
