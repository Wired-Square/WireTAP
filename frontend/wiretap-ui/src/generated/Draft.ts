// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ByteSpan } from "./ByteSpan";
import type { Endianness } from "./Endianness";
import type { FrameDraft } from "./FrameDraft";

/**
 * A catalogue in the making, one [`FrameDraft`] per protocol and key.
 */
export type Draft = { defaultEndianness: Endianness, defaultIntervalMs: number | null, 
/**
 * What every serial frame's header and checksum take.
 */
serialReserved: Array<ByteSpan>, frames: Array<FrameDraft>, };
