// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { NoteEndianness } from "./NoteEndianness";
import type { PatternKind } from "./PatternKind";

/**
 * Adjacent columns `start..start + len` read as one value.
 */
export type MultiBytePattern = { start: number, len: number, kind: PatternKind, 
/**
 * `Little` or `Big`; `None` for text.
 */
endianness: NoteEndianness | null, rollover: boolean, 
/**
 * The upper part stepped as the lower part wrapped.
 */
correlatedRollover: boolean, 
/**
 * A `sensor32`'s upper bytes are static or change rarely.
 */
slowUpperBytes: boolean, 
/**
 * The lowest and highest value seen, for sensors.
 */
range: [number, number] | null, 
/**
 * The first payload's bytes, with non-printable ones as `.`, for text.
 */
sampleText: string | null, };
