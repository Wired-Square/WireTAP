// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * A serial header field with its byte position derived at parse time (so
 * consumers don't re-derive it). One entry per `[meta.serial.fields]` field.
 */
export type HeaderFieldPosition = { name: string, 
/**
 * Absent where no mask over header bytes 0–3 says the field.
 */
mask?: number | null, byteOrder: Endianness, 
/**
 * `hex` or `decimal` display.
 */
format: string, 
/**
 * End-relative when negative.
 */
startByte: number, bytes: number, };
