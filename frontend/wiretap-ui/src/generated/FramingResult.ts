// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Result from backend framing operation
 */
export type FramingResult = { 
/**
 * Number of frames extracted
 */
frame_count: number, 
/**
 * ID of the new frame capture
 */
capture_id: string, 
/**
 * Number of frames excluded by min_length filter
 */
filtered_count: number, 
/**
 * ID of the filtered frames capture (frames that were too short)
 */
filtered_capture_id: string | null, };
