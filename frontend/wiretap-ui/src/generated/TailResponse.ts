// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameMessage } from "./FrameMessage";

/**
 * Response from tail fetch operation
 */
export type TailResponse = { frames: Array<FrameMessage>, 
/**
 * 1-based original capture position (rowid) for each frame, parallel to `frames`.
 */
capture_indices: Array<number>, total_filtered_count: number, capture_end_time_us: number | null, };
