// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What a replay of a source would take, before it starts.
 */
export type ReplayEstimate = { frame_count: number, 
/**
 * Last frame's timestamp less the first's.
 */
span_us: number, 
/**
 * One pass on the replay's schedule at the asked speed.
 */
pass_duration_us: number, };
