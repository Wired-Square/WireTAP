import { describe, it, expect } from "vitest";
import { cleanHex, hexToBytes } from "../utils/numberUtils";

describe("frame calculator utils", () => {
  describe("hex input cleaning", () => {
    it("cleans hex input with spaces and newlines", () => {
      expect(cleanHex("E8 08\nB0-04")).toBe("e808b004");
    });

    it("handles empty input", () => {
      expect(cleanHex("")).toBe("");
    });

    it("removes non-hex characters", () => {
      expect(cleanHex("0xABCDEF")).toBe("abcdef"); // 0x prefix removed
      expect(cleanHex("AB:CD:EF")).toBe("abcdef");
    });

    it("strips a 0x prefix from every byte, not only the first", () => {
      expect(hexToBytes(cleanHex("0x12 0x34"))).toEqual([0x12, 0x34]);
      expect(hexToBytes(cleanHex("0x12,0x34"))).toEqual([0x12, 0x34]);
      expect(hexToBytes(cleanHex("0X12, 0X34"))).toEqual([0x12, 0x34]);
      expect(hexToBytes(cleanHex("12 34"))).toEqual([0x12, 0x34]);
      expect(hexToBytes(cleanHex("0x1234"))).toEqual([0x12, 0x34]);
    });
  });

  describe("hex to bytes conversion", () => {
    it("converts hex to bytes", () => {
      expect(hexToBytes("e808b004")).toEqual([0xe8, 0x08, 0xb0, 0x04]);
    });

    it("handles single byte", () => {
      expect(hexToBytes("ff")).toEqual([0xff]);
    });

    it("strips a 0x prefix from every byte", () => {
      expect(hexToBytes("0x12 0x34")).toEqual([0x12, 0x34]);
    });

    it("handles empty hex", () => {
      expect(hexToBytes("")).toEqual([]);
    });
  });
});
