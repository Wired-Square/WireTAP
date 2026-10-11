// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * A header field defined by a bitmask over the frame's header bytes (CAN ID
 * bits, or serial header bytes), or, for serial, by `start_byte` and `bytes`.
 */
export type HeaderField = { mask?: number | null, shift?: number | null, 
/**
 * `hex` or `decimal` display.
 */
format?: string | null, endianness?: Endianness | null, 
/**
 * End-relative when negative, as [`ChecksumConfig::start_byte`].
 */
startByte?: number | null, bytes?: number | null, };
