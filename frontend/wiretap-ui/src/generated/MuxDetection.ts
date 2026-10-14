// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { MuxSelector } from "./MuxSelector";

/**
 * A detected mux selector and how often each case occurs.
 */
export type MuxDetection = { selector: MuxSelector, 
/**
 * Occurrences per case key, in key order.
 */
occurrences: { [key in number]: number }, };
