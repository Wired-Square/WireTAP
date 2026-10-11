// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { NoteEndianness } from "./NoteEndianness";
import type { PatternKind } from "./PatternKind";

export type MultiBytePattern = { start: number, len: number, kind: PatternKind, endianness: NoteEndianness | null, rollover: boolean, correlatedRollover: boolean, slowUpperBytes: boolean, range: [number, number] | null, sampleText: string | null, };
