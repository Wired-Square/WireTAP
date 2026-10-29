// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CrcAlternative } from "./CrcAlternative";

/**
 * A recovered CRC: `init` and `xor_out` are exact but one pair of several that
 * fit; see [`alternatives`](Self::alternatives).
 */
export type CrcParameters = { 
/**
 * 8 or 16.
 */
width: number, polynomial: number, reflectIn: boolean, reflectOut: boolean, 
/**
 * Canonically 0.
 */
init: number, 
/**
 * The residue `observed ⊕ CRC(m, 0, 0)`, constant across the samples.
 */
xorOut: number, 
/**
 * True when `polynomial` is a recognised standard.
 */
wellKnown: boolean, 
/**
 * Other `(init, xorOut)` pairs that fit; non-empty means `init` is not
 * determined by this data.
 */
alternatives: Array<CrcAlternative>, };
