// D5: what the TypeScript `decodeGroups` returns, pinned before the calculator decoder moves to
// Rust. BigInt fields are decimal strings. Rewritten by `npx vitest run src/tests/calculatorGolden.test.ts -u`.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeGroups } from "../apps/calculator/frameUtils";
import type { Endianness, GroupMode, GroupedValue } from "../apps/calculator/FrameCalculator";

const ENDIANNESSES: Endianness[] = ["big", "little", "mid-big", "mid-little"];
const STANDARD_MODES: GroupMode[] = ["1B", "2B", "4B", "8B"];

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const sequence = (length: number) => Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);

const PAYLOADS: Record<string, number[]> = {
  "empty": [],
  "00": [0x00],
  "ff": [0xff],
  "7f": [0x7f],
  "80": [0x80],
  "ascii A": [0x41],
  "e808": [0xe8, 0x08],
  "7fff": [0x7f, 0xff],
  "800000": [0x80, 0x00, 0x00],
  "80017f": [0x80, 0x01, 0x7f],
  "Hello": ascii("Hello"),
  "123456789abcdef0": [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0],
  "8x ff": Array(8).fill(0xff),
  "8x 00": Array(8).fill(0x00),
  "12 mixed": [0x00, 0x01, 0x1f, 0x20, 0x7e, 0x7f, 0x80, 0x9f, 0xa0, 0xfe, 0xff, 0x0a],
  "16 ascii+control": [...ascii("WireTAP"), 0x00, 0x0d, 0x0a, 0x09, 0x1b, ...ascii("CAN!")],
  "64 sequence": sequence(64),
};

const CUSTOM_SIZES = ["1", "3", "3,8", "4,4", "1,7,12", "12,4", "16", "0,abc", ""];

const UP_TO_FIVE = ["empty", "80", "e808", "80017f", "Hello"];
const UP_TO_EIGHT = [...UP_TO_FIVE, "123456789abcdef0"];
const UP_TO_SIXTEEN = [...UP_TO_EIGHT, "12 mixed", "16 ascii+control"];

const standardPayloads = (mode: GroupMode) =>
  Object.keys(PAYLOADS).filter((p) => p !== "64 sequence" || mode === "4B" || mode === "8B");

const customPayloads = (mode: GroupMode, sizes: string) => {
  if (mode === "custom-bits" && sizes === "1") return UP_TO_FIVE;
  if (mode === "custom-bits" && ["3", "4,4"].includes(sizes)) return UP_TO_EIGHT;
  if ((mode === "custom-bits" && sizes === "12,4") || (mode === "custom-bytes" && sizes === "16"))
    return [...UP_TO_SIXTEEN, "64 sequence"];
  return UP_TO_SIXTEEN;
};

type GoldenCase = {
  name: string;
  bytes: number[];
  mode: GroupMode;
  customInput: string;
  endianness: Endianness;
  groups: Record<string, unknown>[];
};

const serialiseGroup = (group: GroupedValue) =>
  Object.fromEntries(Object.entries(group).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));

function goldenCase(payload: string, mode: GroupMode, customInput: string, endianness: Endianness): GoldenCase {
  const bytes = PAYLOADS[payload];
  const sizes = mode.startsWith("custom") ? ` [${customInput}]` : "";
  return {
    name: `${mode}${sizes} ${endianness} ${payload}`,
    bytes,
    mode,
    customInput,
    endianness,
    groups: decodeGroups(bytes, mode, customInput, endianness).map(serialiseGroup),
  };
}

function goldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (const endianness of ENDIANNESSES) {
    for (const mode of STANDARD_MODES) {
      for (const payload of standardPayloads(mode)) cases.push(goldenCase(payload, mode, "", endianness));
    }
    for (const mode of ["custom-bits", "custom-bytes"] as GroupMode[]) {
      for (const sizes of CUSTOM_SIZES) {
        for (const payload of customPayloads(mode, sizes)) cases.push(goldenCase(payload, mode, sizes, endianness));
      }
    }
  }
  return cases;
}

const line = (value: unknown) => JSON.stringify(value);

function renderGolden(cases: GoldenCase[]): string {
  const rendered = cases.map(({ groups, ...input }) => {
    const head = Object.entries(input).map(([key, value]) => `    ${line(key)}: ${line(value)}`);
    const body = groups.length === 0 ? "[]" : `[\n${groups.map((g) => `      ${line(g)}`).join(",\n")}\n    ]`;
    return `  {\n${head.join(",\n")},\n    "groups": ${body}\n  }`;
  });
  return `[\n${rendered.join(",\n")}\n]\n`;
}

describe("calculator decodeGroups golden", () => {
  it("case names are unique", () => {
    const names = goldenCases().map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("matches fixtures/data/calculatorGolden.json", async () => {
    const cases = goldenCases();
    const text = renderGolden(cases);
    expect(JSON.parse(text)).toHaveLength(cases.length);
    await expect(text).toMatchFileSnapshot(resolve(__dirname, "fixtures/data/calculatorGolden.json"));
  });
});
