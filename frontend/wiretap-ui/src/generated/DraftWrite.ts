// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { DraftFrame } from "./DraftFrame";
import type { Endianness } from "./Endianness";

/**
 * How the draft is written into a catalogue.
 */
export type DraftWrite = { 
/**
 * The frames to write, each with its notes worded.
 */
frames: Array<DraftFrame>, notes: Array<Array<string>>, defaultEndianness: Endianness, defaultIntervalMs: number | null, 
/**
 * Key CAN and serial frames by decimal id rather than hex.
 */
decimalIds: boolean, };
