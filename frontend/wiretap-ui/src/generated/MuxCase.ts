// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Mux } from "./Mux";
import type { Signal } from "./Signal";

/**
 * One case of a multiplexer: the signals (and optional nested mux) active when
 * the selector matches this case's key.
 */
export type MuxCase = { signals: Array<Signal>, mux?: Mux | null, 
/**
 * Free-text notes on the case.
 */
notes?: Array<string>, };
