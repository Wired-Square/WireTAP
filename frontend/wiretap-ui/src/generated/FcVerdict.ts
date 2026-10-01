// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What one function code did when asked.
 */
export type FcVerdict = { "verdict": "values", values: Array<number>, } | { "verdict": "bits", values: Array<boolean>, } | { "verdict": "exception", message: string, } | { "verdict": "silent" };
