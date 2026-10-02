// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What happened to a session, as its scoped `SessionLifecycle` message says.
 */
export type SessionTransition = "suspended" | "switched_to_capture" | "resuming" | "returned_to_live" | "capabilities_changed";
