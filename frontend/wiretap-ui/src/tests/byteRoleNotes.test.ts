// The notes the Changes and Serial Payload tools render from Rust's byte profile
// and reason codes, pinned to the wording the TypeScript classifier wrote. The
// serial cases are the lib's `byte_roles_golden.rs` `ts_note` table.

import { describe, it, expect } from "vitest";
import type { ByteColumn, ByteRole, FrameByteProfile, MultiBytePattern } from "../api/byteRoles";
import { toPayloadAnalysisResult } from "../utils/analysis/payloadAnalysis";
import { candidateReasonNote } from "../utils/analysis/serialFrameAnalysis";

function column(position: number, role: ByteRole, stats: Partial<ByteColumn> = {}): ByteColumn {
  return {
    position,
    distinctValues: 20,
    min: 0,
    max: 255,
    constantValue: role.role === "static" ? role.value : null,
    changes: 0,
    transitions: 19,
    entropyBits: 0,
    sampleCount: 20,
    ...stats,
    ...role,
  } as ByteColumn;
}

function pattern(start: number, len: number, kind: MultiBytePattern["kind"], rest: Partial<MultiBytePattern> = {}): MultiBytePattern {
  return {
    start,
    len,
    kind,
    endianness: null,
    rollover: false,
    correlatedRollover: false,
    slowUpperBytes: false,
    range: null,
    sampleText: null,
    ...rest,
  };
}

function profile(p: Partial<FrameByteProfile>): FrameByteProfile {
  return {
    protocol: "can",
    frameId: 0x100,
    isExtended: false,
    frameIdHex: "0x100",
    sampleCount: 20,
    minLen: 8,
    maxLen: 8,
    identical: null,
    analysedFrom: 0,
    columns: [],
    patterns: [],
    endianness: null,
    mux: null,
    ...p,
  };
}

const value: ByteRole = { role: "value" };

describe("frame notes", () => {
  it("name each role, pattern and flag as the TypeScript did", () => {
    const result = toPayloadAnalysisResult(
      profile({
        minLen: 6,
        columns: [
          column(0, { role: "static", value: 0x1f }),
          column(1, { role: "counter", direction: "up", step: 1, rollover: true, looping: null }),
          column(2, { role: "counter", direction: "up", step: 1, rollover: true, looping: { min: 0, max: 9, modulo: 10 } }),
          column(3, { role: "sensor", trend: "decreasing", strength: 0.75, rollover: false }, { min: 10, max: 90 }),
          column(4, value),
          column(5, value),
          column(6, value, { sampleCount: 12 }),
          column(7, value, { sampleCount: 12 }),
        ],
        patterns: [
          pattern(4, 2, "counter16", { endianness: "little" }),
          pattern(6, 2, "text", { sampleText: "OK" }),
        ],
        endianness: "little",
      }),
      true,
    );

    expect(result.notes).toEqual([
      "Little-endian (inferred from 1 multi-byte pattern(s))",
      "Varying length: 6–8 bytes",
      "Burst frame: analyzing stable payload portion only",
      "Static bytes: byte[0]=0x1F",
      "Counter at byte[1]: incrementing, step=1 (rollover detected)",
      "Looping counter at byte[2]: incrementing, step=1, range 0–9 (mod 10)",
      "Sensor at byte[3]: ↓ range 10–90 (75% trend)",
      "16-bit counter at byte[4:5], little endian",
      'Text at byte[6:7] "OK"',
    ]);
    expect(result.lengthRange).toEqual({ min: 6, max: 8 });
    expect(result.analyzedToByteExclusive).toBe(8);
    expect(result.byteStats[6].sampleCount).toBe(12);
  });

  it("name the sensors that span columns, with their range", () => {
    const result = toPayloadAnalysisResult(
      profile({
        columns: [0, 1, 2, 3, 4, 5].map((i) => column(i, value)),
        patterns: [
          pattern(0, 2, "sensor16", { endianness: "big", rollover: true, correlatedRollover: true, range: [100, 700] }),
          pattern(2, 4, "sensor32", { endianness: "little", rollover: true, correlatedRollover: true, slowUpperBytes: true, range: [5, 70000] }),
        ],
        endianness: "mixed",
      }),
      false,
    );

    expect(result.notes).toEqual([
      "Mixed endianness (inferred from 2 multi-byte pattern(s))",
      "16-bit sensor at byte[0:1], big endian, range 100–700 (rollover correlation detected)",
      "32-bit sensor at byte[2:5], little endian, range 5–70000 (slow-changing upper bytes) (rollover correlation detected)",
    ]);
  });

  it("count varying values only when nothing else explains them", () => {
    const result = toPayloadAnalysisResult(profile({ columns: [column(0, value), column(1, value)] }), false);
    expect(result.notes).toEqual(["2 byte(s) with varying values detected"]);
  });

  it("show an identical payload in hex", () => {
    const result = toPayloadAnalysisResult(
      profile({
        sampleCount: 3,
        minLen: 2,
        maxLen: 2,
        identical: [0x01, 0xab],
        columns: [column(0, { role: "static", value: 0x01 }), column(1, { role: "static", value: 0xab })],
      }),
      false,
    );
    expect(result.notes).toEqual([
      "Identical payload across all 3 samples: 01 AB",
      "Static bytes: byte[0]=0x01, byte[1]=0xAB",
    ]);
  });

  it("describe a mux frame by its selector and cases, and each case in short", () => {
    const counter: ByteRole = { role: "counter", direction: "up", step: 1, rollover: false, looping: null };
    const result = toPayloadAnalysisResult(
      profile({
        analysedFrom: 1,
        columns: [column(1, counter), column(2, value)],
        mux: {
          detection: { selector: "oneByte", occurrences: { "0": 10, "1": 10 } },
          cases: [
            {
              value: 0,
              sampleCount: 10,
              columns: [column(1, counter), column(2, { role: "static", value: 0x11 })],
              patterns: [],
            },
            {
              value: 1,
              sampleCount: 10,
              columns: [column(1, value), column(2, value)],
              patterns: [pattern(1, 2, "sensor16", { endianness: "big", correlatedRollover: true, range: [3, 900] })],
            },
          ],
        },
        endianness: "big",
      }),
      false,
    );

    expect(result.isMuxFrame).toBe(true);
    expect(result.muxInfo).toEqual({ selectorByte: 0, selectorValues: [0, 1], isTwoByte: false });
    expect(result.notes).toEqual([
      "Big-endian (inferred from 1 multi-byte pattern(s))",
      "Multiplexed frame: byte[0], cases: 0, 1",
      "Case 0: 1 counter, 1 static",
    ]);
    expect(result.muxCaseAnalyses?.map((c) => c.notes)).toEqual([
      ["Static: byte[2]=0x11", "Counter byte[1]: inc, step=1"],
      ["16b sensor byte[1:2] big 3–900 +correlated"],
    ]);
  });

  it("key a two-byte mux by both bytes", () => {
    const result = toPayloadAnalysisResult(
      profile({
        analysedFrom: 2,
        mux: {
          detection: { selector: "twoByte", occurrences: { "1": 5, "258": 5 } },
          cases: [
            { value: 1, sampleCount: 5, columns: [], patterns: [] },
            { value: 258, sampleCount: 5, columns: [], patterns: [] },
          ],
        },
      }),
      true,
    );
    expect(result.muxInfo).toEqual({ selectorByte: -1, selectorValues: [1, 258], isTwoByte: true });
    expect(result.notes).toEqual([
      "Burst frame with mux: analyzing stable payload portion only",
      "Multiplexed frame: byte[0:1], 2 cases",
    ]);
  });
});

describe("serial candidate notes", () => {
  it.each([
    [{ code: "protocolMarkers" } as const, 1, "Contains common protocol markers (0xFB-0xFE)"],
    [{ code: "commandIds" } as const, 1, "Contains small sequential values (likely command IDs)"],
    [{ code: "typeSubtype", firstByteValues: 3 } as const, 2, "First byte has only 3 values (type + subtype pattern)"],
    [{ code: "deviceCount", count: 4 } as const, 1, "4 unique addresses (typical device count)"],
    [{ code: "deviceCount", count: 4 } as const, 2, "4 unique 16-bit addresses (strong pattern)"],
    [{ code: "addressCount", count: 12 } as const, 1, "12 unique addresses"],
    [{ code: "addressCount", count: 12 } as const, 2, "12 unique 16-bit addresses"],
    [{ code: "twelveBitRange" } as const, 2, "12-bit address range"],
    [{ code: "evenDistribution" } as const, 1, "Even distribution across addresses"],
    [{ code: "evenDistribution" } as const, 2, "Even distribution"],
    [{ code: "smallAddresses" } as const, 1, "Small address values (0x00-0x20)"],
    [{ code: "noZeroAddress" } as const, 1, "No zero address (typical for device IDs)"],
    [{ code: "noZeroAddress" } as const, 2, "No zero address"],
  ])("%o at %i byte(s)", (reason, len, note) => {
    expect(candidateReasonNote(reason, len)).toBe(note);
  });
});
