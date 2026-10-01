// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Frame info extracted from a capture
 */
export type CaptureFrameInfo = { 
/**
 * Frame identity is (protocol, frame_id) — CAN 0x100 and Modbus register 256
 * are different frames that share a numeric id.
 */
protocol: string, frame_id: number, max_dlc: number, bus: number, is_extended: boolean, has_dlc_mismatch: boolean, };
