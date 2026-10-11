// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";
import type { Mask } from "./Mask";

/**
 * A header field of [`CanConfigFields`] or [`SerialConfigFields`]: a mask, or
 * for serial a `start_byte` (end-relative when negative) and `bytes` (1 when
 * absent). A position a mask over header bytes 0–3 can say is written as that mask.
 */
export type HeaderFieldFields = { mask?: Mask, start_byte?: number | null, bytes?: number | null, 
/**
 * Not written when 0.
 */
shift?: number | null, 
/**
 * Not written when `hex`.
 */
format?: string | null, 
/**
 * Not written when big.
 */
byte_order?: Endianness | null, };
