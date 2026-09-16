// ui/src/utils/numberUtils.ts

// Common numeric conversion helpers used across tools (e.g., frame calculator).
// Use BigInt internally to avoid 32-bit overflow in JS bitwise ops.

// Re-export hexToBytes from the canonical location for backwards compatibility
export { hexToBytes } from './byteUtils';

/**
 * Parse a string as an integer, supporting both decimal and hex (0x prefix) formats.
 * Returns the parsed integer or NaN if invalid.
 */
export function parseIntValue(value: string): number {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("0x")) {
    return parseInt(trimmed.slice(2), 16);
  }
  return parseInt(trimmed, 10);
}

/**
 * Check if a string is a valid integer (decimal or hex format).
 */
export function isValidIntValue(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return false;

  if (trimmed.startsWith("0x")) {
    const hexPart = trimmed.slice(2);
    return hexPart.length > 0 && /^[0-9a-f]+$/.test(hexPart);
  }

  // Decimal: must be digits only, optionally with leading minus
  return /^-?\d+$/.test(trimmed);
}

/**
 * Clean a hex string by removing 0x prefix and non-hex characters.
 */
export function cleanHex(input: string): string {
  return input.replace(/^0x/i, "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/**
 * Convert a number or bigint to a hex string (without 0x prefix).
 * The result is zero-padded to ensure an even number of hex digits (complete bytes).
 */
export function numberToHex(num: number | bigint): string {
  const value = typeof num === "bigint" ? num : BigInt(num);
  const hex = value.toString(16);
  // Pad to even length so hexToBytes can parse complete bytes
  return hex.length % 2 === 1 ? "0" + hex : hex;
}

export function twosComplementSigned(value: bigint, bits: number): bigint {
  if (bits <= 0) return 0n;
  const bBits = BigInt(bits);
  const modulus = 1n << bBits;
  const sign = 1n << (bBits - 1n);
  const signed = (value & sign) !== 0n ? value - modulus : value;
  return signed;
}

export function onesComplementSigned(value: bigint, bits: number): bigint {
  if (bits <= 0) return 0n;
  const bBits = BigInt(bits);
  const sign = 1n << (bBits - 1n);
  const mask = (1n << bBits) - 1n;
  if ((value & sign) !== 0n) {
    const magnitude = (~value) & mask;
    return -magnitude;
  }
  return value;
}

export function signMagnitudeSigned(value: bigint, bits: number): bigint {
  if (bits <= 0) return 0n;
  const bBits = BigInt(bits);
  const sign = 1n << (bBits - 1n);
  const magnitudeMask = sign - 1n;
  if ((value & sign) !== 0n) {
    const magnitude = value & magnitudeMask;
    return -magnitude;
  }
  return value;
}

export function toBinaryString(bits: number[], groupSize = 8): string {
  return bits
    .map((b, i) => (groupSize > 0 && i > 0 && i % groupSize === 0 ? " " : "") + b)
    .join("");
}
