// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * A serial header field with its byte position derived from the mask at parse
 * time (so consumers don't re-derive it). One entry per `[meta.serial.fields]`
 * field.
 */
export type HeaderFieldPosition = { name: string, mask: number, byteOrder: Endianness, 
/**
 * `hex` or `decimal` display.
 */
format: string, startByte: number, bytes: number, };
