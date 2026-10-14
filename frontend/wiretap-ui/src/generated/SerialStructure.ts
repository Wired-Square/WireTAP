// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FieldCandidate } from "./FieldCandidate";

/**
 * The id and source-address candidates in one link's serial frames.
 */
export type SerialStructure = { sampleCount: number, minLen: number, maxLen: number, 
/**
 * Best first.
 */
ids: Array<FieldCandidate>, 
/**
 * After the best id, or from byte 1 without one; best first.
 */
sources: Array<FieldCandidate>, };
