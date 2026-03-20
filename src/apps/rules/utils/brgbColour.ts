// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// BRGB colour encoding: [brightness(8)][red(8)][green(8)][blue(8)]
// Used by FrameLink indicator signals for LED colour representation.

/**
 * Convert a BRGB u32 to a CSS rgba() string.
 * Brightness is mapped to alpha (0=off, 255=full brightness).
 */
export function brgbToCss(brgb: number): string {
  const brightness = (brgb >>> 24) & 0xff;
  const r = (brgb >>> 16) & 0xff;
  const g = (brgb >>> 8) & 0xff;
  const b = brgb & 0xff;
  const alpha = (brightness / 255).toFixed(2);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Convert RGB + brightness to a BRGB u32.
 */
export function cssToBrgb(
  r: number,
  g: number,
  b: number,
  brightness: number,
): number {
  return (
    ((brightness & 0xff) << 24) |
    ((r & 0xff) << 16) |
    ((g & 0xff) << 8) |
    (b & 0xff)
  );
}

/**
 * Extract BRGB components from a u32.
 */
export function brgbComponents(brgb: number): {
  brightness: number;
  r: number;
  g: number;
  b: number;
} {
  return {
    brightness: (brgb >>> 24) & 0xff,
    r: (brgb >>> 16) & 0xff,
    g: (brgb >>> 8) & 0xff,
    b: brgb & 0xff,
  };
}
