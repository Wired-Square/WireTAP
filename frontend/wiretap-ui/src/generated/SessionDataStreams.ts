// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Declares the data streams a session produces.
 *
 * This replaces ad-hoc checks like `emits_raw_bytes` with a structured
 * declaration of what a session will emit. Used by the frontend to decide
 * which event listeners and views to set up.
 */
export type SessionDataStreams = { 
/**
 * Whether this session emits framed messages (`frame-message` events)
 */
rx_frames: boolean, 
/**
 * Whether this session emits raw byte streams (`bytes-ready` signal)
 */
rx_bytes: boolean, };
