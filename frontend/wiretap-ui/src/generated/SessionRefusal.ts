// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Why a session command was refused.
 */
export type SessionRefusal = { "kind": "not_found", message: string, } | { "kind": "failed", message: string, };
