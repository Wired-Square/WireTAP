// Copyright 2026 Wired Square Pty Ltd

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
