// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Result of attempting a safe reinitialize
 */
export type ReinitializeResult = { 
/**
 * Whether the reinitialize was successful
 */
success: boolean, 
/**
 * Reason for failure (if success is false)
 */
reason: string | null, 
/**
 * List of other listeners preventing reinitialize (if any)
 */
other_subscribers: Array<string>, };
