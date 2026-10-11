// P7 L4: what canMask.ts's mask maths returns, pinned before it moves to Rust.

import { describe, it } from "vitest";
import { BIT_WIDTH_EXT, BIT_WIDTH_STD, matchedIdCount, matchedRange, popcount } from "../apps/rules/utils/canMask";
import { expectGolden, type GoldenCase } from "./catalogGoldens";

const MASKS: Record<number, number[]> = {
  [BIT_WIDTH_STD]: [0x000, 0x001, 0x400, 0x7f0, 0x70f, 0x7fe, 0x7ff, 0x800, 0xfff, 0x1fffffff, 0xffffffff],
  [BIT_WIDTH_EXT]: [0x0, 0x1, 0x7ff, 0x1fffff00, 0x1ffffffe, 0x1fffffff, 0x10000000, 0x20000000, 0xffffffff, 0x80000000],
};

const IDS: Record<number, number[]> = {
  [BIT_WIDTH_STD]: [0x000, 0x123, 0x7ff, 0x800, 0x1fffffff],
  [BIT_WIDTH_EXT]: [0x0, 0x18ff0001, 0x1fffffff, 0x20000000, 0xffffffff],
};

function cases(): GoldenCase[] {
  const out: GoldenCase[] = [];
  for (const bitWidth of [BIT_WIDTH_STD, BIT_WIDTH_EXT]) {
    for (const mask of MASKS[bitWidth]) {
      out.push({ name: `matchedIdCount ${bitWidth} 0x${mask.toString(16)}`, input: { mask, bitWidth }, expected: matchedIdCount(mask, bitWidth) });
      for (const id of IDS[bitWidth]) {
        out.push({
          name: `matchedRange ${bitWidth} id 0x${id.toString(16)} mask 0x${mask.toString(16)}`,
          input: { id, mask, bitWidth },
          expected: matchedRange(id, mask, bitWidth),
        });
      }
    }
  }
  for (const value of [0, 1, 0x7ff, 0x1fffffff, 0x80000000, 0xffffffff, -1]) {
    out.push({ name: `popcount ${value}`, input: value, expected: popcount(value) });
  }
  return out;
}

describe("canMask golden", () => {
  it("matches fixtures/data/canMaskGolden.json", async () => {
    await expectGolden("canMaskGolden.json", cases(), "data");
  });
});
