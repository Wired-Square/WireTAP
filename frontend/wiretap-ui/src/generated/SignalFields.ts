// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Confidence } from "./Confidence";
import type { DisplayHint } from "./DisplayHint";
import type { Endianness } from "./Endianness";

/**
 * One signal, for [`super::EditOp::UpsertSignal`].
 */
export type SignalFields = { name?: string, start_bit?: number, bit_length?: number, 
/**
 * Not written when 1.
 */
factor?: number | null, 
/**
 * Not written when 0.
 */
offset?: number | null, unit?: string | null, 
/**
 * Not written when false.
 */
signed?: boolean | null, byte_order?: Endianness | "" | null, min?: number | null, max?: number | null, format?: string | null, confidence?: Confidence | "" | null, enum?: { [key in string]: string }, notes?: string | Array<string> | null, display?: DisplayHint | null, };
