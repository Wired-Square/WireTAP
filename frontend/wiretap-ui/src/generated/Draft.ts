// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ByteOrder } from "./ByteOrder";
import type { ByteSpan } from "./ByteSpan";
import type { FrameDraft } from "./FrameDraft";

export type Draft = { defaultEndianness: ByteOrder, defaultIntervalMs: number | null, serialReserved: Array<ByteSpan>, frames: Array<FrameDraft>, };
