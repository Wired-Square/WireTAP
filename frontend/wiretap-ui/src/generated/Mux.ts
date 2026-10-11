// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { MuxCase } from "./MuxCase";

/**
 * A multiplexer: a selector bit-field plus the per-case signal sets. Case keys
 * are kept as strings to preserve the catalogue's range/list syntax
 * (`"0"`, `"0-3"`, `"1,2,5"`); [`crate::decode`] matches them.
 */
export type Mux = { name?: string | null, startBit: number, bitLength: number, 
/**
 * The default case key applied when the selector matches no explicit case.
 */
default?: string | null, 
/**
 * Free-text notes on the multiplexer.
 */
notes?: Array<string>, cases: { [key in string]: MuxCase }, 
/**
 * The keys of `cases` in [`crate::compare_mux_case_keys`] order, which JSON's object loses.
 */
caseOrder: Array<string>, };
