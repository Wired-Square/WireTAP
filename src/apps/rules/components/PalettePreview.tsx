// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// Renders a palette as a CSS linear-gradient strip from its BRGB entries.

import { brgbToCss } from "../utils/brgbColour";

interface PalettePreviewProps {
  entries: number[];
  height?: number;
}

export default function PalettePreview({ entries, height = 16 }: PalettePreviewProps) {
  if (entries.length === 0) return null;

  const stops = entries.map((brgb, i) => {
    const pct = entries.length === 1 ? 0 : (i / (entries.length - 1)) * 100;
    return `${brgbToCss(brgb)} ${pct.toFixed(1)}%`;
  });

  return (
    <div
      className="w-full rounded"
      style={{
        height,
        background: `linear-gradient(to right, ${stops.join(", ")})`,
      }}
    />
  );
}
