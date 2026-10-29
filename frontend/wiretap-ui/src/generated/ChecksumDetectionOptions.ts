// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

export type ChecksumDetectionOptions = { 
/**
 * Checksum offsets to try, end-relative.
 */
positions?: Array<number>, 
/**
 * Restrict to checksums of these byte lengths. Empty means both.
 */
lengths?: Array<number>, 
/**
 * Byte offsets just past a declared header field; they widen the range
 * candidates and earn a small bonus, never narrowing the search.
 */
headerBoundaries?: Array<number>, 
/**
 * Percentage below which a candidate is discarded.
 */
minMatchRate?: number, 
/**
 * Confidence below which a candidate is discarded.
 */
minConfidence?: number, };
