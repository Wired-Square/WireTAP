// P7 L3: what modbusValues.ts returns, pinned before the register readings move to Rust.
// A non-finite or negative-zero f32 is spelt as a string, since JSON has no such number.

import { describe, it } from "vitest";
import { interpretPair, interpretRegister, type WordOrder } from "../utils/modbusValues";
import { expectGolden, type GoldenCase } from "./catalogGoldens";

const spelt = (n: number) => (Object.is(n, -0) ? "-0" : Number.isFinite(n) ? n : String(n));

const REGISTERS: number[][] = [
  [],
  [0x01],
  [0xff],
  [0x00, 0x00],
  [0x00, 0x41],
  [0x4d, 0x42],
  [0x09, 0x38],
  [0x7f, 0xff],
  [0x80, 0x00],
  [0xff, 0xff],
  [0x20, 0x7e],
  [0x7f, 0x80],
  [0x12, 0x34, 0x56],
];

const PAIRS: Record<string, [number[], number[]]> = {
  "zero": [[0x00, 0x00], [0x00, 0x00]],
  "negative zero": [[0x80, 0x00], [0x00, 0x00]],
  "one": [[0x3f, 0x80], [0x00, 0x00]],
  "minus two": [[0xc0, 0x00], [0x00, 0x00]],
  "pi": [[0x40, 0x49], [0x0f, 0xdb]],
  "236.5": [[0x43, 0x6c], [0x80, 0x00]],
  "+inf": [[0x7f, 0x80], [0x00, 0x00]],
  "-inf": [[0xff, 0x80], [0x00, 0x00]],
  "quiet nan": [[0x7f, 0xc0], [0x00, 0x00]],
  "signalling nan": [[0x7f, 0x80], [0x00, 0x01]],
  "negative nan": [[0xff, 0xc0], [0x00, 0x01]],
  "smallest denormal": [[0x00, 0x00], [0x00, 0x01]],
  "largest denormal": [[0x00, 0x7f], [0xff, 0xff]],
  "smallest normal": [[0x00, 0x80], [0x00, 0x00]],
  "max finite": [[0x7f, 0x7f], [0xff, 0xff]],
  "u32 max": [[0xff, 0xff], [0xff, 0xff]],
  "i32 min": [[0x80, 0x00], [0x00, 0x00]],
  "i32 max": [[0x7f, 0xff], [0xff, 0xff]],
  "65536": [[0x00, 0x01], [0x00, 0x00]],
  "sungrow low word first": [[0x09, 0x38], [0x00, 0x01]],
  "short registers": [[0x01], [0xff]],
  "empty second": [[0x12, 0x34], []],
  "long registers": [[0x12, 0x34, 0x56], [0x78, 0x9a, 0xbc]],
};

function cases(): GoldenCase[] {
  const out: GoldenCase[] = REGISTERS.map((bytes) => ({
    name: `interpretRegister [${bytes.join(",")}]`,
    input: bytes,
    expected: interpretRegister(bytes),
  }));
  for (const [name, [first, second]] of Object.entries(PAIRS)) {
    for (const order of ["big", "little"] as WordOrder[]) {
      const { u32, s32, f32 } = interpretPair(first, second, order);
      out.push({ name: `interpretPair ${name} ${order}`, input: { first, second, order }, expected: { u32, s32, f32: spelt(f32) } });
    }
  }
  const { u32, s32, f32 } = interpretPair([0x3f, 0x80], [0x00, 0x00]);
  out.push({ name: "interpretPair default order is big", input: { first: [0x3f, 0x80], second: [0x00, 0x00] }, expected: { u32, s32, f32: spelt(f32) } });
  return out;
}

describe("modbusValues golden", () => {
  it("matches fixtures/data/modbusValuesGolden.json", async () => {
    await expectGolden("modbusValuesGolden.json", cases(), "data");
  });
});
