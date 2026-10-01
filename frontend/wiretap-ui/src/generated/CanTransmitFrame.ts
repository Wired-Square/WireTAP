// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * CAN frame for transmission. Also the MCP transmit tools' frame parameters,
 * flattened, so the flags default when a caller leaves them out.
 */
export type CanTransmitFrame = { 
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
