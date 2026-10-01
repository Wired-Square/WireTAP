// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A mirror frame's live comparison with its source.
 */
export type DecodedMirrorVerdict = { 
/**
 * Null until a first comparison has run.
 */
isValid: boolean | null, mismatchedByteIndices: Array<number>, sourceFrameId: number, timeDeltaMs: number, };
