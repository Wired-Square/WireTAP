// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CrcAlternative } from "./CrcAlternative";

/**
 * A recovered CRC. `init`/`xor_out` are the canonical pair — always exact, and
 * always one of several that fit; see [`alternatives`](Self::alternatives).
 */
export type CrcParameters = { 
/**
 * 8 or 16.
 */
width: number, polynomial: number, reflectIn: boolean, reflectOut: boolean, 
/**
 * Canonically 0. Retained so a caller can write a complete CRC definition.
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
 * Other `(init, xorOut)` pairs that reproduce the samples identically.
 * Non-empty means `init` is not determined by this data.
 */
alternatives: Array<CrcAlternative>, };
