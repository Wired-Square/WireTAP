// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ByteColumn } from "./ByteColumn";
import type { ByteNotes } from "./ByteNotes";
import type { MultiBytePattern } from "./MultiBytePattern";
import type { MuxAnalysis } from "./MuxAnalysis";
import type { NoteEndianness } from "./NoteEndianness";

/**
 * One frame as Payload Changes reports it: its byte profile, what the profile
 * says, and whether message order finds it sent in bursts.
 */
export type ChangesFrame = { notes: ByteNotes, burst: boolean, protocol?: string, frameId: number, isExtended: boolean, frameIdHex: string, sampleCount: number, minLen: number, maxLen: number, 
/**
 * The payload, when there is more than one sample and every one is equal.
 */
identical: Array<number> | null, 
/**
 * 0, or the first byte past a mux selector.
 */
analysedFrom: number, 
/**
 * `analysed_from..max_len` over every payload; past `min_len` a column's
 * `sample_count` says how many payloads reached it.
 */
columns: Array<ByteColumn>, 
/**
 * Over `columns`; a mux frame's cases carry their own.
 */
patterns: Array<MultiBytePattern>, 
/**
 * Across `patterns` and every mux case's.
 */
endianness: NoteEndianness | null, mux: MuxAnalysis | null, };
