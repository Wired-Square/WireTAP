// What the Query form sends: one spec per type, its bounds read at the form's
// edge. Rust reads `querySpec.json` back (`query::tests`), runs each spec and
// writes the SQL and requests it previews and runs; the bounds table's `rust`
// column is `payload_source::tests`.

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("TZ", "Australia/Melbourne");

import { buildQuerySpec, type QueryParams, type QueryType } from "../apps/query/stores/queryStore";
import type { TimeBounds } from "../components/TimeBoundsInput";
import { datetimeLocalToMicros } from "../utils/timeFormat";
import { expectGolden, fixtureJson, type GoldenCase } from "./catalogGoldens";

const QUERY_TYPES: QueryType[] = [
  "byte_changes",
  "frame_changes",
  "mirror_validation",
  "mux_statistics",
  "first_last",
  "frequency",
  "distribution",
  "gap_analysis",
  "pattern_search",
  "frame_inventory",
];

const params: QueryParams = {
  frameId: 0x100,
  isExtended: null,
  byteIndex: 2,
  mirrorFrameId: 0x101,
  sourceFrameId: 0x100,
  toleranceMs: 50,
  muxSelectorByte: 0,
  include16Bit: true,
  payloadLength: 8,
  gapThresholdMs: 100,
  bucketSizeMs: 1000,
  pattern: [0xaa, 0xbb],
  patternMask: [0xff, 0x00],
};

const bounds = (startTime: string, endTime: string, timezoneMode: TimeBounds["timezoneMode"] = "local"): TimeBounds => ({
  startTime,
  endTime,
  timezoneMode,
});

const refusal = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("query spec", () => {
  it("builds one spec per type", async () => {
    const cases: GoldenCase[] = [];
    for (const queryType of QUERY_TYPES) {
      for (const [label, timeBounds, isExtended] of [
        ["unbounded", null, null],
        ["bounded", bounds("2026-03-01T10:00", "2026-03-01T10:05"), true],
      ] as const) {
        const input = { queryType, timeBounds, isExtended, limit: 5000 };
        const expected = buildQuerySpec(queryType, { ...params, isExtended }, timeBounds, 5000);
        cases.push({ name: `${queryType} ${label}`, input, expected });
      }
    }
    cases.push({
      name: "byte_changes bounded in UTC",
      input: { timeBounds: bounds("2026-03-01T10:00", "", "utc") },
      expected: buildQuerySpec("byte_changes", params, bounds("2026-03-01T10:00", "", "utc"), 5000),
    });
    await expectGolden("querySpec.json", cases, "data");
  });

  it("refuses an empty pattern and a skipped local time before sending", () => {
    expect(refusal(() => buildQuerySpec("pattern_search", { ...params, pattern: [], patternMask: [] }, null, 5000))).toMatch(
      /pattern/i,
    );
    expect(refusal(() => buildQuerySpec("byte_changes", params, bounds("2026-10-04T02:30", ""), 5000))).toMatch(
      /does not exist/,
    );
  });

  it("reads the bounds table", () => {
    const { rows } = fixtureJson<{ rows: { input: string; mode: "local" | "utc"; us: number | null | "refused" }[] }>(
      "data/queryBounds.json",
    );
    for (const { input, mode, us } of rows) {
      const read = refusal(() => datetimeLocalToMicros(input, mode)) === null ? datetimeLocalToMicros(input, mode) : "refused";
      expect(read, `${input} (${mode})`).toEqual(us);
    }
  });
});
