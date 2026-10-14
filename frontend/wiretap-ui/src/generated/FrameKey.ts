// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Which frame a payload belongs to.
 *
 * A standard and an extended id sharing a number are different frames, so the
 * pair is the identity — named rather than a positional `(u32, bool)`, because
 * a caller passing the wrong `bool` should not be silent.
 */
export type FrameKey = { frameId: number, isExtended: boolean, };
