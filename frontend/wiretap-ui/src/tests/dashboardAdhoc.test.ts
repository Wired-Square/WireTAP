import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { adhocWatch } from "../apps/dashboard/utils/adhocWatch";
import { candidateLabel, reasonText } from "../apps/dashboard/utils/hypothesisText";
import type { DashboardPanel, HypothesisParams } from "../stores/dashboardStore";

const panel = (p: Partial<DashboardPanel>): DashboardPanel =>
  ({ id: "p", type: "line-chart", title: "", signals: [], minValue: 0, maxValue: 100, ...p }) as DashboardPanel;

const params = (p: Partial<HypothesisParams>): HypothesisParams => ({
  startBit: 0, bitLength: 8, endianness: "little", signed: false, factor: 1, offset: 0, ...p,
});

describe("adhocWatch", () => {
  it("sends every charted name, a hypothesis with its saved params, flow bytes and heatmap frames", () => {
    const hyp = params({ startBit: 12, bitLength: 12, endianness: "big", signed: true, factor: 0.1, offset: -40 });
    const registry = new Map([["hyp_100_b12_12bes", hyp]]);
    const panels = [
      panel({ signals: [
        { frameId: 0x100, signalName: "hyp_100_b12_12bes" },
        { frameId: 0x100, signalName: "byte_0_16b_le" },
      ] as DashboardPanel["signals"] }),
      panel({ type: "flow", targetFrameId: 0x200, byteCount: 2 }),
      panel({ type: "bitfield", targetFrameId: 0x300 }),
      panel({ type: "heatmap", targetFrameId: 0x400 }),
      panel({ type: "heatmap" }),
    ];

    const { signals, heatmaps } = adhocWatch(panels, registry);

    expect(heatmaps).toEqual([0x400]);
    expect(signals.slice(0, 4)).toEqual([
      { frameId: 0x100, name: "hyp_100_b12_12bes", params: hyp },
      { frameId: 0x100, name: "byte_0_16b_le", params: undefined },
      { frameId: 0x200, name: "byte_0_8b_le" },
      { frameId: 0x200, name: "byte_1_8b_le" },
    ]);
    expect(signals.filter((s) => s.frameId === 0x300)).toHaveLength(8);
  });
});

describe("hypothesis text", () => {
  // Golden: the labels the deleted `buildLabel` in hypothesisRanking.ts produced.
  it("labels a candidate as the TypeScript ranking did", () => {
    expect(candidateLabel(params({ startBit: 16, bitLength: 16, endianness: "little", signed: true }))).toBe("byte 2, 16-bit LE signed");
    expect(candidateLabel(params({ startBit: 3, bitLength: 8, endianness: "big" }))).toBe("bit 3, 8-bit");
    expect(candidateLabel(params({ startBit: 0, bitLength: 12, endianness: "big" }))).toBe("byte 0, 12-bit BE");
  });

  const t = ((key: string, opts?: { role?: string }) => (opts?.role ? `${key}:${opts.role}` : key)) as unknown as TFunction;

  it("renders each reason code, and none as low interest", () => {
    expect(reasonText(t, [
      { code: "role", role: "sensor" },
      { code: "pattern", kind: "sensor16", exact: true },
      { code: "pattern", kind: "text", exact: false },
      { code: "endiannessAgrees" },
      { code: "highVariance" },
    ])).toBe(
      "hypothesis.reasons.role:hypothesis.reasons.roles.sensor, hypothesis.reasons.pattern.exact.sensor16, "
        + "hypothesis.reasons.pattern.overlap.text, hypothesis.reasons.endiannessAgrees, hypothesis.reasons.highVariance",
    );
    expect(reasonText(t, [])).toBe("hypothesis.reasons.none");
  });
});
