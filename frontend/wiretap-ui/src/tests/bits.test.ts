import { describe, it, expect } from "vitest";
import { extractBits } from "../utils/bits";

const ones32 = [0xff, 0xff, 0xff, 0xff];

describe("extractBits", () => {
  it("reads an unsigned 32-bit value with the top bit set as positive", () => {
    expect(extractBits(ones32, 0, 32, "little")).toBe(4294967295);
    expect(extractBits(ones32, 0, 32, "big")).toBe(4294967295);
  });

  it("sign-extends a signed 32-bit value", () => {
    expect(extractBits(ones32, 0, 32, "little", true)).toBe(-1);
    expect(extractBits([0x00, 0x00, 0x00, 0x80], 0, 32, "little", true)).toBe(-2147483648);
    expect(extractBits([0x80, 0x00, 0x00, 0x00], 0, 32, "big", true)).toBe(-2147483648);
  });

  it("reads a 16-bit value as before", () => {
    expect(extractBits([0x34, 0x12], 0, 16, "little")).toBe(0x1234);
    expect(extractBits([0x12, 0x34], 0, 16, "big")).toBe(0x1234);
    expect(extractBits([0xfe, 0xff], 0, 16, "little", true)).toBe(-2);
  });
});
