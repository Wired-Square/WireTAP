// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ByteNote } from "./ByteNote";
import type { MuxCaseNotes } from "./MuxCaseNotes";

/**
 * A frame's notes and its mux cases'.
 */
export type ByteNotes = { frame: Array<ByteNote>, 
/**
 * Every case, in key order.
 */
cases: Array<MuxCaseNotes>, };
