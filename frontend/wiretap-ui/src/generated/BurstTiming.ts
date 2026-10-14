// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BurstFlag } from "./BurstFlag";

/**
 * An id sent in bursts, or at more than one length.
 */
export type BurstTiming = { 
/**
 * 1 without a burst pattern.
 */
framesPerBurst: number, 
/**
 * Between burst starts, or the median gap without a burst pattern.
 */
burstPeriodMs: number, 
/**
 * The median gap within a burst, or the median gap without a burst pattern.
 */
interMessageMs: number, 
/**
 * Ascending.
 */
lengths: Array<number>, flags: Array<BurstFlag>, frameId: number, isExtended: boolean, };
