// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Timestamped byte for raw serial data
 */
export type TimestampedByte = { 
/**
 * The byte value
 */
byte: number, 
/**
 * Timestamp in microseconds since epoch
 */
timestamp_us: number, 
/**
 * Bus/interface number (for multi-source sessions)
 */
bus: number, };
