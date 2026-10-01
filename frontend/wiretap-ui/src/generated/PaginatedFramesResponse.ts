// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameMessage } from "./FrameMessage";

/**
 * Response for paginated capture frames
 */
export type PaginatedFramesResponse = { frames: Array<FrameMessage>, total_count: number, offset: number, limit: number, 
/**
 * 1-based original capture position (rowid) for each frame.
 * Parallel to `frames` — `capture_indices[i]` is the position of `frames[i]`.
 */
capture_indices: Array<number>, };
