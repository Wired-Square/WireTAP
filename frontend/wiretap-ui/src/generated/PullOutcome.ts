// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What a pull did.
 */
export type PullOutcome = { "kind": "upToDate" } | { "kind": "applied", filename: string, } | { "kind": "needsReview" } | { "kind": "goneUpstream" };
