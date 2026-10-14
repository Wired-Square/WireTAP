// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Why a column was ruled out. Kept so a scan can say what it decided rather
 * than silently omitting the byte.
 */
export type Rejection = "constant" | "notAFunctionOfTheOtherBytes" | "tooOftenUnchanged" | "tooFewTransitions" | "tooFewDistinctValues";
