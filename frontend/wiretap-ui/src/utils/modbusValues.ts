// ui/src/utils/modbusValues.ts
//
// Reading a raw Modbus register map is guesswork until you can see the same
// bytes several ways at once — 0x0938 is 2360 as an unsigned int, and that only
// looks like 236.0 V once you spot the neighbouring 500 that's obviously 50.0 Hz.
// These are the interpretations a discovery scan shows side by side.

import { bytesToAscii, bytesToHex } from './byteUtils';

/**
 * Which of a 32-bit value's two registers holds the high word. Modbus doesn't
 * specify this, so devices disagree — Sungrow-style low-word-first is common
 * enough that a discovery view needs the toggle.
 */
export type WordOrder = 'big' | 'little';

export interface RegisterView {
  /** Uppercase hex, no separator, e.g. "0938". */
  hex: string;
  /** Unsigned 16-bit. */
  u16: number;
  /** Signed 16-bit (two's complement). */
  s16: number;
  /** The register's two bytes as characters, non-printable shown as '.'. */
  ascii: string;
}

export interface RegisterPairView {
  u32: number;
  s32: number;
  f32: number;
}

/** Big-endian u16 from a register's two bytes. Missing bytes read as zero. */
function toU16(bytes: number[]): number {
  return (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) >>> 0;
}

/** Every reading of one register's bytes that a discovery table shows at once. */
export function interpretRegister(bytes: number[]): RegisterView {
  const u16 = toU16(bytes);
  return {
    hex: bytesToHex(bytes.slice(0, 2)),
    u16,
    s16: u16 >= 0x8000 ? u16 - 0x10000 : u16,
    ascii: bytesToAscii(bytes.slice(0, 2)),
  };
}

/**
 * Read two adjacent registers as one 32-bit value. `order` says which register
 * holds the high word: 'big' means `first` does (the usual reading), 'little'
 * means `second` does.
 */
export function interpretPair(
  first: number[],
  second: number[],
  order: WordOrder = 'big',
): RegisterPairView {
  const a = toU16(first);
  const b = toU16(second);
  const [high, low] = order === 'big' ? [a, b] : [b, a];

  const u32 = ((high * 0x10000) + low) >>> 0;

  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, u32, false);

  return {
    u32,
    s32: view.getInt32(0, false),
    f32: view.getFloat32(0, false),
  };
}
