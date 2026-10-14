// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameKey } from "./FrameKey";

/**
 * Ids whose period falls within `interval_ms ± tolerance_ms`.
 */
export type IntervalGroup = { intervalMs: number, toleranceMs: number, 
/**
 * Ascending.
 */
keys: Array<FrameKey>, };
