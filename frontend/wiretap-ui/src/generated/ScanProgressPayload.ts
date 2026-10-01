// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Progress update emitted during scanning
 */
export type ScanProgressPayload = { 
/**
 * Current position in the scan range
 */
current: number, 
/**
 * Total items to scan
 */
total: number, 
/**
 * Number of responding items found so far
 */
found_count: number, 
/**
 * Which pass this is, when `repeat > 1` (1-based)
 */
pass: number, 
/**
 * Total passes
 */
total_passes: number, };
