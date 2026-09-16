// ui/src/apps/dashboard/utils/dashboardHistogram.ts
//
// Histogram computation utility for the Histogram panel.

export interface HistogramBin {
  /** Lower bound (inclusive) */
  min: number;
  /** Upper bound (exclusive, except last bin) */
  max: number;
  /** Centre value for X-axis placement */
  centre: number;
  /** Number of values in this bin */
  count: number;
}

/** Compute a histogram from an array of values with uniform bin widths. */
export function computeHistogram(values: number[], binCount: number): HistogramBin[] {
  if (values.length === 0 || binCount <= 0) return [];

  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (!isFinite(min) || !isFinite(max)) return [];

  // Single value — one bin
  if (min === max) {
    return [{ min, max: min + 1, centre: min, count: values.length }];
  }

  const step = (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    min: min + i * step,
    max: min + (i + 1) * step,
    centre: min + (i + 0.5) * step,
    count: 0,
  }));

  for (const v of values) {
    const idx = Math.min(Math.floor((v - min) / step), binCount - 1);
    bins[idx].count++;
  }

  return bins;
}
