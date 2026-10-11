// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ByteSpan } from "./ByteSpan";
import type { Endianness } from "./Endianness";
import type { FrameDraft } from "./FrameDraft";

export type Draft = { defaultEndianness: Endianness, defaultIntervalMs: number | null, serialReserved: Array<ByteSpan>, frames: Array<FrameDraft>, };
