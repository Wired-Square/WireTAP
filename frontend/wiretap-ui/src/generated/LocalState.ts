// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * How the local file compares with the bytes last exchanged with the remote.
 * Computed from disk alone — no network.
 */
export type LocalState = "untracked" | "committed" | "modified" | "missing";
