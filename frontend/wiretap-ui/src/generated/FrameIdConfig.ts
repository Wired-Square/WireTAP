// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Configuration for extracting frame ID from frame bytes
 */
export type FrameIdConfig = { 
/**
 * Start byte index (negative = from end)
 */
start_byte: number, 
/**
 * Number of bytes for frame ID (1 or 2)
 */
num_bytes: number, 
/**
 * Whether to interpret as big-endian
 */
big_endian: boolean, };
