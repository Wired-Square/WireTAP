// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * A header field defined by a bitmask over the frame's header bytes (CAN ID
 * bits, or serial header bytes).
 */
export type HeaderField = { mask: number, shift?: number | null, 
/**
 * `hex` or `decimal` display.
 */
format?: string | null, endianness?: Endianness | null, };
