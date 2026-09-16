import { describe, it, expect } from "vitest";
import { cleanHex, hexToBytes, reorderBytes, decodeGroups } from "../apps/calculator/frameUtils";
import type { Endianness, GroupedValue } from "../apps/calculator/FrameCalculator";

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
  });

  describe("hex to bytes conversion", () => {
    it("converts hex to bytes", () => {
      expect(hexToBytes("e808b004")).toEqual([0xe8, 0x08, 0xb0, 0x04]);
    });

    it("handles single byte", () => {
      expect(hexToBytes("ff")).toEqual([0xff]);
    });

    it("handles empty hex", () => {
      expect(hexToBytes("")).toEqual([]);
    });
  });

  describe("byte reordering", () => {
    it("reorders bytes per endianness", () => {
      const bytes = [0xe8, 0x08, 0xb0, 0x04];
      const expectOrder = (end: Endianness, expected: number[]) => {
        expect(reorderBytes(bytes, end)).toEqual(expected);
      };

      expectOrder("big", [0xe8, 0x08, 0xb0, 0x04]);
      expectOrder("little", [0x04, 0xb0, 0x08, 0xe8]);
      expectOrder("mid-little", [0xb0, 0x04, 0xe8, 0x08]);
      expectOrder("mid-big", [0x08, 0xe8, 0x04, 0xb0]);
    });
  });

  describe("single byte conversions", () => {
    it("decodes 0x00 correctly", () => {
      const g = decodeGroups(hexToBytes("00"), "1B", "1", "big")[0];
      expect(g.hex).toBe("0x00");
      expect(g.unsigned).toBe(0n);
      expect(g.signedTwos).toBe(0n);
      expect(g.signedOnes).toBe(0n);
      expect(g.signedMag).toBe(0n);
      expect(g.text).toBe(".");
    });

    it("decodes 0x7F (max positive 8-bit)", () => {
      const g = decodeGroups(hexToBytes("7f"), "1B", "1", "big")[0];
      expect(g.hex).toBe("0x7f");
      expect(g.unsigned).toBe(127n);
      expect(g.signedTwos).toBe(127n);
      expect(g.signedOnes).toBe(127n);
      expect(g.signedMag).toBe(127n);
      expect(g.text).toBe(".");
    });

    it("decodes 0x80 (min negative 8-bit two's complement)", () => {
      const g = decodeGroups(hexToBytes("80"), "1B", "1", "big")[0];
      expect(g.hex).toBe("0x80");
      expect(g.unsigned).toBe(128n);
      expect(g.signedTwos).toBe(-128n);
      expect(g.signedOnes).toBe(-127n);
      expect(g.signedMag).toBe(0n); // Sign-magnitude: 0x80 = sign bit set, magnitude 0
    });

    it("decodes 0xFF correctly", () => {
      const g = decodeGroups(hexToBytes("ff"), "1B", "1", "big")[0];
      expect(g.hex).toBe("0xff");
      expect(g.unsigned).toBe(255n);
      expect(g.signedTwos).toBe(-1n);
      expect(g.signedOnes).toBe(0n); // One's complement: all bits set = -0
      expect(g.signedMag).toBe(-127n);
      expect(g.text).toBe(".");
    });

    it("decodes 0xE8 (232 unsigned, -24 two's)", () => {
      const g = decodeGroups(hexToBytes("e8"), "1B", "1", "big")[0];
      expect(g.hex).toBe("0xe8");
      expect(g.unsigned).toBe(232n);
      expect(g.signedTwos).toBe(-24n);
      expect(g.signedOnes).toBe(-23n);
      expect(g.signedMag).toBe(-104n);
    });

    it("decodes ASCII characters", () => {
      const g = decodeGroups(hexToBytes("41"), "1B", "1", "big")[0]; // 'A'
      expect(g.text).toBe("A");
    });
  });

  describe("2-byte conversions", () => {
    it("decodes 0x0000", () => {
      const g = decodeGroups(hexToBytes("0000"), "2B", "1", "big")[0];
      expect(g.hex).toBe("0x0000");
      expect(g.unsigned).toBe(0n);
      expect(g.signedTwos).toBe(0n);
      expect(g.signedOnes).toBe(0n);
      expect(g.signedMag).toBe(0n);
    });

    it("decodes 0x7FFF (max positive 16-bit)", () => {
      const g = decodeGroups(hexToBytes("7fff"), "2B", "1", "big")[0];
      expect(g.hex).toBe("0x7fff");
      expect(g.unsigned).toBe(32767n);
      expect(g.signedTwos).toBe(32767n);
      expect(g.signedOnes).toBe(32767n);
      expect(g.signedMag).toBe(32767n);
    });

    it("decodes 0x8000 (min negative 16-bit two's complement)", () => {
      const g = decodeGroups(hexToBytes("8000"), "2B", "1", "big")[0];
      expect(g.hex).toBe("0x8000");
      expect(g.unsigned).toBe(32768n);
      expect(g.signedTwos).toBe(-32768n);
      expect(g.signedOnes).toBe(-32767n);
      expect(g.signedMag).toBe(0n); // Sign-magnitude: sign bit set, magnitude 0
    });

    it("decodes 0xFFFF", () => {
      const g = decodeGroups(hexToBytes("ffff"), "2B", "1", "big")[0];
      expect(g.hex).toBe("0xffff");
      expect(g.unsigned).toBe(65535n);
      expect(g.signedTwos).toBe(-1n);
      expect(g.signedOnes).toBe(0n); // One's complement: all bits set = -0
      expect(g.signedMag).toBe(-32767n);
    });

    it("decodes 0x1234 with different endianness", () => {
      const expectValue = (end: Endianness, unsignedExpected: bigint) => {
        const g = decodeGroups(hexToBytes("1234"), "2B", "1", end)[0];
        expect(g.unsigned).toBe(unsignedExpected);
      };

      expectValue("big", 0x1234n);
      expectValue("little", 0x3412n);
      expectValue("mid-little", 0x1234n); // Mid-little reverses 2-byte chunks, 1 chunk = same as big
      expectValue("mid-big", 0x3412n); // Mid-big swaps bytes within 2-byte chunks
    });
  });

  describe("4-byte conversions", () => {
    it("decodes 0x00000000", () => {
      const g = decodeGroups(hexToBytes("00000000"), "4B", "1", "big")[0];
      expect(g.hex).toBe("0x00000000");
      expect(g.unsigned).toBe(0n);
      expect(g.signedTwos).toBe(0n);
    });

    it("decodes 0x7FFFFFFF (max positive 32-bit)", () => {
      const g = decodeGroups(hexToBytes("7fffffff"), "4B", "1", "big")[0];
      expect(g.hex).toBe("0x7fffffff");
      expect(g.unsigned).toBe(2147483647n);
      expect(g.signedTwos).toBe(2147483647n);
    });

    it("decodes 0x80000000 (min negative 32-bit two's complement)", () => {
      const g = decodeGroups(hexToBytes("80000000"), "4B", "1", "big")[0];
      expect(g.hex).toBe("0x80000000");
      expect(g.unsigned).toBe(2147483648n);
      expect(g.signedTwos).toBe(-2147483648n);
    });

    it("decodes 0xFFFFFFFF", () => {
      const g = decodeGroups(hexToBytes("ffffffff"), "4B", "1", "big")[0];
      expect(g.hex).toBe("0xffffffff");
      expect(g.unsigned).toBe(4294967295n);
      expect(g.signedTwos).toBe(-1n);
    });

    it("decodes grouped 4B chunks with endianness", () => {
      const bytes = hexToBytes("e808b00400002c01");
      const groupsBig = decodeGroups(bytes, "4B", "1", "big");
      expect(groupsBig.length).toBe(2);
      expect(groupsBig[0].hex).toBe("0xe808b004");
      expect(groupsBig[1].hex).toBe("0x00002c01");

      const groupsLittle = decodeGroups(bytes, "4B", "1", "little");
      expect(groupsLittle[0].hex).toBe("0x04b008e8");
      expect(groupsLittle[1].hex).toBe("0x012c0000");

      const groupsMidLittle = decodeGroups(bytes, "4B", "1", "mid-little");
      expect(groupsMidLittle[0].hex).toBe("0xb004e808");
      expect(groupsMidLittle[1].hex).toBe("0x2c010000");

      const groupsMidBig = decodeGroups(bytes, "4B", "1", "mid-big");
      expect(groupsMidBig[0].hex).toBe("0x08e804b0");
      expect(groupsMidBig[1].hex).toBe("0x0000012c");
    });

    it("decodes numeric values correctly for mid-little endian 4B group", () => {
      const bytes = hexToBytes("e808b00400002c01");
      const groupsMidLittle = decodeGroups(bytes, "4B", "1", "mid-little");
      const g0 = groupsMidLittle[0];
      expect(g0.hex).toBe("0xb004e808");
      expect(g0.unsigned).toBe(2953111560n);
      expect(g0.signedTwos).toBe(-1341855736n);
      expect(g0.signedOnes).toBe(-1341855735n);
      expect(g0.signedMag).toBe(-805627912n);
    });
  });

  describe("8-byte conversions", () => {
    it("decodes 0x0000000000000000", () => {
      const g = decodeGroups(hexToBytes("0000000000000000"), "8B", "1", "big")[0];
      expect(g.hex).toBe("0x0000000000000000");
      expect(g.unsigned).toBe(0n);
    });

    it("decodes 8 byte value with endianness", () => {
      const bytes = hexToBytes("0102030405060708");
      const gBig = decodeGroups(bytes, "8B", "1", "big")[0];
      const gLittle = decodeGroups(bytes, "8B", "1", "little")[0];

      // Hex preserves all 64 bits (generated from bytes directly)
      expect(gBig.hex).toBe("0x0102030405060708");
      expect(gLittle.hex).toBe("0x0807060504030201");

      // Numeric values now preserve full 64-bit precision using BigInt
      expect(gBig.unsigned).toBe(72623859790382856n); // Full 64 bits: 0x0102030405060708
      expect(gLittle.unsigned).toBe(578437695752307201n); // Full 64 bits reversed: 0x0807060504030201
    });
  });

  describe("sub-byte (custom bits) conversions", () => {
    it("decodes 4-bit values from single byte", () => {
      // F3 = 0b11110011
      // First 4 bits: 1111 = 15 (0xF)
      // Second 4 bits: 0011 = 3 (0x3)
      const groups = decodeGroups(hexToBytes("f3"), "custom-bits", "4,4", "big");
      expect(groups.length).toBe(2);

      // Group 1: First 4 bits (1111)
      expect(groups[0].bits).toBe(4);
      expect(groups[0].hex).toBe("0xf");
      expect(groups[0].unsigned).toBe(15n);
      expect(groups[0].signedTwos).toBe(-1n);
      expect(groups[0].binary).toBe("1111");

      // Group 2: Second 4 bits (0011)
      expect(groups[1].bits).toBe(4);
      expect(groups[1].hex).toBe("0x3");
      expect(groups[1].unsigned).toBe(3n);
      expect(groups[1].signedTwos).toBe(3n);
      expect(groups[1].binary).toBe("0011");
    });

    it("decodes 3-bit values", () => {
      const groups = decodeGroups(hexToBytes("ff"), "custom-bits", "3,3,2", "big");
      expect(groups.length).toBe(3);
      expect(groups[0].bits).toBe(3);
      expect(groups[0].unsigned).toBe(7n); // 0b111
      expect(groups[1].bits).toBe(3);
      expect(groups[1].unsigned).toBe(7n); // 0b111
      expect(groups[2].bits).toBe(2);
      expect(groups[2].unsigned).toBe(3n); // 0b11
    });

    it("decodes single bit values", () => {
      // 0xAA = 0b10101010
      const groups = decodeGroups(hexToBytes("aa"), "custom-bits", "1,1,1,1,1,1,1,1", "big");
      expect(groups.length).toBe(8);
      // Test that we get 8 groups of 1 bit each
      expect(groups[0].bits).toBe(1);
      expect(groups[0].unsigned).toBe(1n);
    });

    it("handles custom-bits mode", () => {
      // hexToBytes("abc") only processes complete pairs: "ab" = 1 byte = 8 bits
      // So custom-bits with size 12 can't create a full group from 8 bits
      const groups = decodeGroups(hexToBytes("ab12"), "custom-bits", "12", "big");
      expect(groups.length).toBeGreaterThan(0);
      expect(groups[0].bits).toBe(12);
    });
  });

  describe("text conversion", () => {
    it("respects endianness for text conversion", () => {
      const bytes = [0x53, 0x55, 0x4E, 0x47, 0x52, 0x4F, 0x57]; // SUNGROW
      const toText = (end: Endianness) =>
        decodeGroups(bytes, "1B", "1", end)
          .map((g: GroupedValue) => g.text)
          .join("");

      expect(toText("big")).toBe("SUNGROW");
      expect(toText("little")).toBe("WORGNUS");
      expect(toText("mid-little")).toBe("WRONGSU");
      expect(toText("mid-big")).toBe("USGNORW");
    });

    it("converts printable ASCII correctly", () => {
      const g = decodeGroups(hexToBytes("48656c6c6f"), "1B", "1", "big");
      const text = g.map(v => v.text).join("");
      expect(text).toBe("Hello");
    });

    it("replaces non-printable characters with dots", () => {
      const g = decodeGroups(hexToBytes("00010203"), "1B", "1", "big");
      const text = g.map(v => v.text).join("");
      expect(text).toBe("....");
    });
  });

  describe("custom byte grouping", () => {
    it("decodes custom byte sizes", () => {
      const groups = decodeGroups(hexToBytes("0102030405"), "custom-bytes", "1,2,2", "big");
      expect(groups.length).toBe(3);
      expect(groups[0].hex).toBe("0x01");
      expect(groups[1].hex).toBe("0x0203");
      expect(groups[2].hex).toBe("0x0405");
    });
  });

  describe("binary string output", () => {
    it("generates correct binary string for 0xAA", () => {
      const g = decodeGroups(hexToBytes("aa"), "1B", "1", "big")[0];
      expect(g.binary).toBe("10101010");
    });

    it("generates correct binary string for multi-byte", () => {
      const g = decodeGroups(hexToBytes("f0a5"), "2B", "1", "big")[0];
      expect(g.binary).toBe("11110000 10100101");
    });
  });

  describe("edge cases", () => {
    it("handles empty input", () => {
      const groups = decodeGroups([], "1B", "1", "big");
      expect(groups.length).toBe(0);
    });

    it("handles odd number of hex digits", () => {
      // hexToBytes processes all characters, padding the last single char
      const bytes = hexToBytes("abc");
      expect(bytes).toEqual([0xab, 0x0c]); // "ab" -> 0xab, "c" -> 0x0c
    });
  });
});
