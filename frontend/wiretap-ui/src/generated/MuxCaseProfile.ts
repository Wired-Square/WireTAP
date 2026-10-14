// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ByteColumn } from "./ByteColumn";
import type { MultiBytePattern } from "./MultiBytePattern";

/**
 * One mux case's payloads, profiled past the selector.
 */
export type MuxCaseProfile = { value: number, sampleCount: number, columns: Array<ByteColumn>, patterns: Array<MultiBytePattern>, };
