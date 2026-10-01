// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Current state of an IO session
 */
export type IOState = { "type": "Stopped" } | { "type": "Starting" } | { "type": "Running" } | { "type": "Paused" } | { "type": "Error", "message": string };
