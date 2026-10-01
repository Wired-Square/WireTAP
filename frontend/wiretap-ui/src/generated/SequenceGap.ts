// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A gap detected in the sequence column during CSV import.
 */
export type SequenceGap = { 
/**
 * Line number in the CSV file where the gap starts (1-based, after header)
 */
line: number, 
/**
 * Sequence value before the gap
 */
from_seq: number, 
/**
 * Sequence value after the gap
 */
to_seq: number, 
/**
 * Estimated number of dropped frames
 */
dropped: number, 
/**
 * Filename (set by the caller for multi-file imports)
 */
filename?: string, };
