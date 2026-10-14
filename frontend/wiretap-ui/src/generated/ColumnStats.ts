// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What one byte column does across the sample.
 */
export type ColumnStats = { 
/**
 * Signed, as [`resolve_byte_index`](crate::frame::resolve_byte_index) reads it:
 * 0 is the first byte, -1 the last.
 */
position: number, distinctValues: number, min: number, max: number, 
/**
 * Set when the column holds one value across every sampled payload.
 */
constantValue: number | null, 
/**
 * Consecutive payload pairs in which this byte differed.
 */
changes: number, 
/**
 * Consecutive payload pairs the column took part in.
 */
transitions: number, 
/**
 * Shannon entropy of the observed values, in bits. 8.0 is the most a byte
 * can carry; a counter over 16 values reaches 4.0.
 */
entropyBits: number, sampleCount: number, };
