// ui/src/utils/bits.ts

import type { Endianness } from "../types/catalog";

/**
 * Extract a bitfield from a byte array.
 * Supports little/big endianness interpretation and optional signed result.
 * Uses BigInt internally for signals > 32 bits to avoid JavaScript's 32-bit bitwise limitations.
 */
export function extractBits(
  bytes: number[],
  startBit: number,
  bitLength: number,
  endianness: Endianness,
  signed?: boolean
): number {
  if (bitLength <= 0) return 0;

  // For signals > 32 bits, use BigInt to avoid precision loss
  if (bitLength > 32) {
    return extractBitsBigInt(bytes, startBit, bitLength, endianness, signed);
  }

  // Standard 32-bit path using regular numbers
  const bits: number[] = [];
  if (endianness === "little") {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      for (let bit = 0; bit < 8; bit++) {
        bits.push((b >> bit) & 1);
      }
    }
  } else {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      for (let bit = 7; bit >= 0; bit--) {
        bits.push((b >> bit) & 1);
      }
    }
  }
  const slice = bits.slice(startBit, startBit + bitLength);
  let value = 0;
  if (endianness === "little") {
    for (let i = slice.length - 1; i >= 0; i--) {
      value = (value << 1) | slice[i];
    }
  } else {
    for (let i = 0; i < slice.length; i++) {
      value = (value << 1) | slice[i];
    }
  }
  if (signed && bitLength > 0) {
    const signBit = 1 << (bitLength - 1);
    if (value & signBit) {
      value = value - (1 << bitLength);
    }
  }
  return value;
}

/**
 * BigInt version of extractBits for signals > 32 bits.
 * Handles up to 64-bit (and beyond) without precision loss.
 */
function extractBitsBigInt(
  bytes: number[],
  startBit: number,
  bitLength: number,
  endianness: Endianness,
  signed?: boolean
): number {
  const bits: number[] = [];
  if (endianness === "little") {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      for (let bit = 0; bit < 8; bit++) {
        bits.push((b >> bit) & 1);
      }
    }
  } else {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      for (let bit = 7; bit >= 0; bit--) {
        bits.push((b >> bit) & 1);
      }
    }
  }

  const slice = bits.slice(startBit, startBit + bitLength);
  let value = 0n;
  if (endianness === "little") {
    for (let i = slice.length - 1; i >= 0; i--) {
      value = (value << 1n) | BigInt(slice[i]);
    }
  } else {
    for (let i = 0; i < slice.length; i++) {
      value = (value << 1n) | BigInt(slice[i]);
    }
  }

  if (signed && bitLength > 0) {
    const signBit = 1n << BigInt(bitLength - 1);
    if (value & signBit) {
      value = value - (1n << BigInt(bitLength));
    }
  }

  // Convert back to number - for display purposes this is fine
  // since we format as hex string anyway for large values
  return Number(value);
}
