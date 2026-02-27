// ui/src/utils/signalDecode.ts

import type { Endianness, SignalFormat } from "../types/catalog";
import { extractBits } from "./bits";
import { LOCALE_ISO_LIKE } from "../constants";
import Decimal from "decimal.js-light";

export type SignalDefinition = {
  name?: string;
  start_bit?: number;
  bit_length?: number;
  signed?: boolean;
  endianness?: Endianness;
  factor?: number;
  offset?: number;
  unit?: string;
  format?: SignalFormat;
  enum?: Record<number, string>;
};

export type DecodedValue = {
  name: string;
  value: number;
  scaled: number;
  display: string;
  unit?: string;
};

/**
 * Format a number as byte-separated hex (e.g., "1A 2B 3C").
 * Respects endianness for byte ordering in display.
 * Uses BigInt for values > 32 bits to avoid precision loss.
 */
function formatHex(value: number, bitLength: number, endianness: Endianness): string {
  const numBytes = Math.ceil(bitLength / 8);
  const bytes: number[] = [];

  if (bitLength > 32) {
    // Use BigInt for large values to avoid 32-bit truncation
    let v = BigInt(value) & ((1n << BigInt(bitLength)) - 1n); // Mask to bitLength
    for (let i = 0; i < numBytes; i++) {
      bytes.push(Number(v & 0xffn));
      v = v >> 8n;
    }
  } else {
    // Standard 32-bit path
    let v = value >>> 0; // Ensure unsigned
    for (let i = 0; i < numBytes; i++) {
      bytes.push(v & 0xff);
      v = v >>> 8;
    }
  }

  // bytes[] is now in little-endian order (LSB first)
  // For big-endian display, reverse to show MSB first
  if (endianness === "big") {
    bytes.reverse();
  }

  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

/**
 * Extract bytes directly from the source byte array for text signals.
 * This avoids precision loss when packing into a JavaScript number.
 * For little-endian, bytes are read in order from start_bit/8.
 * For big-endian, bytes are read in order from start_bit/8.
 */
function extractTextBytes(
  bytes: number[],
  startBit: number,
  bitLength: number,
  _endianness: Endianness
): number[] {
  const startByte = Math.floor(startBit / 8);
  const numBytes = Math.ceil(bitLength / 8);
  const result: number[] = [];

  for (let i = 0; i < numBytes; i++) {
    const byteIndex = startByte + i;
    if (byteIndex < bytes.length) {
      result.push(bytes[byteIndex]);
    } else {
      result.push(0);
    }
  }

  // For little-endian text, the first byte in memory is the first character
  // For big-endian text, the bytes are already in correct order
  // (Both are stored left-to-right in memory, endianness affects multi-byte integers, not strings)
  return result;
}

/**
 * Convert byte array to text string.
 * Used for utf8 and ascii format signals.
 */
function bytesToText(bytes: number[]): string {
  // Convert bytes to string, filtering out null bytes
  return bytes
    .filter((b) => b !== 0) // Remove null terminators
    .map((b) => String.fromCharCode(b))
    .join("");
}

/**
 * Decode a single signal from bytes using the provided definition.
 * @param bytes - The frame payload bytes
 * @param def - Signal definition with bit position, length, and optional endianness
 * @param fallbackName - Name to use if signal has no name defined
 * @param defaultEndianness - Catalog default endianness (used when signal doesn't specify its own)
 */
export function decodeSignal(
  bytes: number[],
  def: SignalDefinition,
  fallbackName = "Signal",
  defaultEndianness: Endianness = "little"
): DecodedValue {
  const name = def.name || fallbackName;
  const start = def.start_bit ?? 0;
  const len = def.bit_length ?? 0;
  // Use signal's endianness if specified, otherwise fall back to catalog default
  const endianness: Endianness = def.endianness ?? defaultEndianness;
  const raw = extractBits(bytes, start, len, endianness, def.signed);
  const factor = def.factor ?? 1;
  const offset = def.offset ?? 0;
  const scaled = new Decimal(raw).mul(factor).add(offset);
  const unit = def.unit;

  // For hex format, display the raw value in hex (factor/offset are typically not used with hex)
  if (def.format === "hex") {
    const hexValue = formatHex(raw, len, endianness);
    return {
      name,
      value: raw,
      scaled: scaled.toNumber(),
      display: hexValue,
      unit,
    };
  }

  // For enum format, lookup the raw value in the enum map
  if (def.format === "enum" && def.enum) {
    const label = def.enum[raw];
    return {
      name,
      value: raw,
      scaled: raw,
      display: label ?? `Unknown (${raw})`,
      unit: undefined, // Enums don't have units
    };
  }

  // For utf8/ascii format, extract bytes directly and convert to text
  // This avoids precision loss from packing into a JavaScript number
  if (def.format === "utf8" || def.format === "ascii") {
    const textBytes = extractTextBytes(bytes, start, len, endianness);
    const textValue = bytesToText(textBytes);
    return {
      name,
      value: raw,
      scaled: raw,
      display: textValue || "(empty)",
      unit: undefined, // Text signals don't have units
    };
  }

  // For unix_time format, display the raw value as a human-readable timestamp
  if (def.format === "unix_time") {
    const timestamp = scaled.toNumber();
    let display: string;
    try {
      // Handle both seconds and milliseconds timestamps
      // If timestamp > year 3000 in seconds, assume it's milliseconds
      const timestampMs = timestamp > 32503680000 ? timestamp : timestamp * 1000;
      const date = new Date(timestampMs);
      // Check for invalid date
      if (isNaN(date.getTime())) {
        display = `Invalid (${timestamp})`;
      } else {
        // Format as ISO-like local time: YYYY-MM-DD HH:MM:SS
        display = date.toLocaleString(LOCALE_ISO_LIKE).replace("T", " ");
      }
    } catch {
      display = `Invalid (${timestamp})`;
    }
    return {
      name,
      value: raw,
      scaled: timestamp,
      display,
      unit: undefined, // Unix time doesn't need a unit
    };
  }

  return {
    name,
    value: raw,
    scaled: scaled.toNumber(),
    display: scaled.toString(),
    unit,
  };
}

/**
 * Decode an array of signals from a frame payload.
 */
export function decodeSignals(bytes: number[], defs: SignalDefinition[]): DecodedValue[] {
  return defs.map((def, idx) => decodeSignal(bytes, def, `Signal ${idx + 1}`));
}
