// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameKey } from "./FrameKey";

/**
 * The order frames follow from a start id until one repeats.
 */
export type CyclePattern = { start: FrameKey, 
/**
 * The most common sequence, the first reached on a tie.
 */
sequence: Array<FrameKey>, 
/**
 * Walks from the start id that reached a second id.
 */
occurrences: number, 
/**
 * The share of `occurrences` that follow `sequence`.
 */
confidence: number, 
/**
 * The median gap between starts of `sequence`; `None` when it starts once.
 */
cycleMs: number | null, };
