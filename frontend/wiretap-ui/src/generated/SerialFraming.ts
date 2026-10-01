// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * How serial bytes are framed on the wire.
 */
export type SerialFraming = { "mode": "raw" } | { "mode": "slip" } | { "mode": "delimiter", delimiter: Array<number>, };
