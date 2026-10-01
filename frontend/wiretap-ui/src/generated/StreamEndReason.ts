// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Why a session's stream ended; the discriminant is its byte on the wire.
 */
export type StreamEndReason = "complete" | "disconnected" | "error" | "stopped" | "paused";
