// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * One signal's bins: values in `[min, max)`, the last bin closed.
 */
export type HistogramBins = Array<{ min: number, max: number, centre: number, count: number }>;
