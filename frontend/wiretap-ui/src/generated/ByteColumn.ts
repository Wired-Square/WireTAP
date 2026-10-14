// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Direction } from "./Direction";
import type { Loop } from "./Loop";
import type { Trend } from "./Trend";

/**
 * One column and the role it plays.
 */
export type ByteColumn = { 
/**
 * Signed, as [`resolve_byte_index`](crate::frame::resolve_byte_index) reads it:
 * 0 is the first byte, -1 the last.
 */
position: number, distinctValues: number, min: number, max: number, 
/**
 * Set when the column holds one value across every sampled payload.
 */
constantValue: number | null, 
/**
 * Consecutive payload pairs in which this byte differed.
 */
changes: number, 
/**
 * Consecutive payload pairs the column took part in.
 */
transitions: number, 
/**
 * Shannon entropy of the observed values, in bits. 8.0 is the most a byte
 * can carry; a counter over 16 values reaches 4.0.
 */
entropyBits: number, sampleCount: number, } & ({ "role": "static", value: number, } | { "role": "counter", direction: Direction, step: number, rollover: boolean, looping: Loop | null, } | { "role": "sensor", trend: Trend, strength: number, rollover: boolean, } | { "role": "value" } | { "role": "unknown" });
