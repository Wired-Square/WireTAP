// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * `FramingState` (0x25): how far a session's framing of its byte capture has got.
 */
export type FramingStateMsg = { framed_capture_id: string, frame_count: number, filtered_capture_id: string | null, filtered_count: number, 
/**
 * The protocol the framer stamped on the first frame.
 */
protocol: string | null, };
