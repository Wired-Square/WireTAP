// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What happened to a replay. `PassCompleted` is sent only when looping; a pass
 * that ends the replay ends it as `Finished`.
 */
export type ReplayEvent = { "kind": "started" } | { "kind": "progress" } | { "kind": "pass_completed" } | { "kind": "finished" } | { "kind": "stopped" } | { "kind": "failed", error: string, };
