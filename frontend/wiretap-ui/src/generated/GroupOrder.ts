// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * How a group's bytes are ordered. Mid-big and mid-little swap the bytes of
 * each 16-bit word, then read as big and little.
 */
export type GroupOrder = "big" | "little" | "mid-big" | "mid-little";
