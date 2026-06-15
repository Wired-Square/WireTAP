// ui/src/apps/graph/widgets/svgArc.ts
//
// Shared SVG arc maths used by the gauge, rotary, and custom-SVG cluster widgets.

/** Point on a circle. Angles are degrees clockwise from 12 o'clock. */
export function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** SVG path `d` for an arc from startAngle to endAngle (degrees, clockwise from 12). */
export function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const sweep = endAngle - startAngle;
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

/** Map a value into [0,1] across [min,max], clamped. Returns 0 for a zero range. */
export function fraction(value: number, min: number, max: number): number {
  const range = max - min;
  if (range <= 0) return 0;
  return Math.max(0, Math.min(1, (value - min) / range));
}

/** Highest-matching threshold-zone colour for a [0,1] fraction, else the fallback. */
export function thresholdColour(
  pct: number,
  fallback: string,
  thresholds?: Array<{ at: number; colour: string }>,
): string {
  let chosen = fallback;
  if (thresholds) {
    for (const z of [...thresholds].sort((a, b) => a.at - b.at)) {
      if (pct >= z.at) chosen = z.colour;
    }
  }
  return chosen;
}
