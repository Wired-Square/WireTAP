// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Result of a transmit operation
 */
export type TransmitResult = { 
/**
 * Whether the transmission was successful
 */
success: boolean, 
/**
 * Timestamp when the frame was sent (microseconds since UNIX epoch)
 */
timestamp_us: number, 
/**
 * Error message if transmission failed
 */
error: string | null, };
