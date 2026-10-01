// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Round-trip times over a run. Mirrors the crate's [`tp::LatencyStats`] so the
 * frontend has a serde shape to read; the maths is the crate's.
 */
export type LatencyStats = { min_us: number, max_us: number, mean_us: number, p50_us: number, p95_us: number, p99_us: number, count: number, };
