// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * How one spec fared across the sampled frames.
 */
export type ChecksumSpecResult = { 
/**
 * Index into the `specs` array the caller passed in.
 */
specIndex: number, matchCount: number, 
/**
 * Frames the spec actually fitted — frames too short for it are excluded
 * rather than counted as misses.
 */
totalCount: number, };
