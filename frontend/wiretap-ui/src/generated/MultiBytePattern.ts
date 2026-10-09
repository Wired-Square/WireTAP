// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";
import type { PatternKind } from "./PatternKind";

export type MultiBytePattern = { start: number, len: number, kind: PatternKind, endianness: Endianness | null, rollover: boolean, correlatedRollover: boolean, slowUpperBytes: boolean, range: [number, number] | null, sampleText: string | null, };
