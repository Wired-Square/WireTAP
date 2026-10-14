// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { MuxSelector } from "./MuxSelector";

/**
 * A mux id's timing.
 */
export type MuxTiming = { 
/**
 * The median gap between frames of one case; `None` when no case repeats.
 */
muxPeriodMs: number | null, 
/**
 * The median gap between frames of the id.
 */
interMessageMs: number, frameId: number, isExtended: boolean, selector: MuxSelector, 
/**
 * Occurrences per case key, in key order.
 */
occurrences: { [key in number]: number }, };
