// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Direction } from "./Direction";
import type { Endianness } from "./Endianness";
import type { Loop } from "./Loop";
import type { MultiBytePattern } from "./MultiBytePattern";
import type { MuxSelector } from "./MuxSelector";
import type { StaticByte } from "./StaticByte";
import type { Trend } from "./Trend";

export type ByteNote = { "code": "noSamples" } | { "code": "endianness", endianness: Endianness, patternCount: number, } | { "code": "varyingLength", min: number, max: number, } | { "code": "burst", mux: boolean, } | { "code": "identical", sampleCount: number, payload: Array<number>, } | { "code": "multiplexed", selector: MuxSelector, cases: Array<number>, } | { "code": "caseSummary", value: number, counters: number, statics: number, } | { "code": "statics", bytes: Array<StaticByte>, } | { "code": "counter", position: number, direction: Direction, step: number, rollover: boolean, looping: Loop | null, } | { "code": "sensor", position: number, trend: Trend, strength: number, min: number, max: number, } | { "code": "pattern" } & MultiBytePattern | { "code": "varyingValues", count: number, };
