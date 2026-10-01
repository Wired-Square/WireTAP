// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Announces a repeat transmit that started, carrying everything the frontend
 * needs to render it as a queue row, so a human's repeat and an agent's share
 * one visible queue.
 */
export type RepeatStartedEvent = { queue_id: string, session_id: string, profile_id: string, profile_name: string, interval_ms: number, 
/**
 * Where the repeat came from: `"user"` or `"agent"`.
 */
origin: string, 
/**
 * CAN frame ID (11-bit standard or 29-bit extended)
 */
frame_id: number, 
/**
 * Frame data (up to 8 bytes for classic CAN, up to 64 for CAN FD)
 */
data: Array<number>, 
/**
 * Bus number (0 for single-bus adapters, 0-4 for multi-bus like GVRET)
 */
bus: number, 
/**
 * Extended (29-bit) frame ID
 */
is_extended: boolean, 
/**
 * CAN FD frame
 */
is_fd: boolean, 
/**
 * Bit Rate Switch (CAN FD only)
 */
is_brs: boolean, 
/**
 * Remote Transmission Request
 */
is_rtr: boolean, };
