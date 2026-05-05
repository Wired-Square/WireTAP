// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

export const ID_MASK_11 = 0x7FF;
export const ID_MASK_29 = 0x1FFFFFFF;

export const BIT_WIDTH_STD = 11;
export const BIT_WIDTH_EXT = 29;

export function parseHex(input: string, fallback: number, clampMask: number = ID_MASK_29): number {
  const trimmed = input.trim().replace(/^0x/i, "");
  if (trimmed === "") return fallback;
  const n = parseInt(trimmed, 16);
  return (Number.isNaN(n) ? fallback : n) & clampMask;
}

export function isValidHex(input: string): boolean {
  const trimmed = input.trim().replace(/^0x/i, "");
  if (trimmed === "") return false;
  return /^[0-9a-fA-F]+$/.test(trimmed);
}

export function popcount(value: number): number {
  let v = value >>> 0;
  let count = 0;
  while (v !== 0) {
    count += v & 1;
    v >>>= 1;
  }
  return count;
}

export function matchedIdCount(mask: number, bitWidth: number): number {
  const widthMask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
  const dontCareBits = bitWidth - popcount(mask & widthMask);
  return Math.pow(2, dontCareBits);
}

export function matchedRange(id: number, mask: number, bitWidth: number): { lo: number; hi: number } {
  const widthMask = bitWidth >= 32 ? 0xFFFFFFFF : (1 << bitWidth) - 1;
  const lo = (id & mask & widthMask) >>> 0;
  const hi = (lo | (~mask & widthMask)) >>> 0;
  return { lo, hi };
}
