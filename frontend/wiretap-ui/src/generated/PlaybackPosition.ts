// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Playback position - stored and signalled via playback-position events during capture streaming
 */
export type PlaybackPosition = { 
/**
 * Current timestamp in microseconds
 */
timestamp_us: number, 
/**
 * Current frame index (0-based)
 */
frame_index: number, 
/**
 * Total frame count in capture (optional, for recorded sources)
 */
frame_count?: number, };
