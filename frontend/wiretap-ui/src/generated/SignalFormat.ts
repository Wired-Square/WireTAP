// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A signal's data format. Any value here marks the signal as non-numeric
 * (string/opaque) — [`crate::decode`] renders it specially rather than as a
 * plain scaled number. Absent = a plain scaled number.
 */
export type SignalFormat = "ascii" | "utf8" | "hex" | "enum" | "unix_time" | "other";
