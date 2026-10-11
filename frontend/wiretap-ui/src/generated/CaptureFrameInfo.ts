// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * One frame identity in a capture, `(protocol, frame_id)`, with its rollup.
 */
export type CaptureFrameInfo = { protocol: string, frame_id: number, max_dlc: number, bus: number, is_extended: boolean, has_dlc_mismatch: boolean, };
