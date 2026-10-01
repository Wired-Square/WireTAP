// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Step one frame forward or backward from the given timestamp.
 * Returns the new timestamp after stepping, or None if at the boundary.
 * Also emits the frame and a snapshot via events.
 * Result of a step operation, containing both the new frame index and timestamp
 */
export type StepResult = { frame_index: number, timestamp_us: number, };
