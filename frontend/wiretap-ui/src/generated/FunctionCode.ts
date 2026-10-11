// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { LengthRule } from "./LengthRule";

/**
 * A vendor function code a catalogue declares.
 */
export type FunctionCode = { name?: string | null, 
/**
 * Its messages' layouts, tried in order. Empty leaves it to the CRC search.
 */
lengths?: Array<LengthRule>, notes?: Array<string>, };
