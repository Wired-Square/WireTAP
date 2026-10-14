// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * A [`PayloadField`] scaled `raw × factor + offset`; its JSON is the desktop's
 * `HypothesisParams`.
 */
export type ScaledField = { factor: number, offset: number, startBit: number, bitLength: number, endianness: Endianness, signed: boolean, };
