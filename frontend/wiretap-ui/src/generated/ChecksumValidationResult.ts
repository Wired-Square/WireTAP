// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Result of checksum validation.
 */
export type ChecksumValidationResult = { 
/**
 * The checksum value extracted from the frame
 */
extracted: number, 
/**
 * The calculated checksum value
 */
calculated: number, 
/**
 * Whether the frame is evidence (see [`calculated_range`]) and extracted == calculated
 */
valid: boolean, };
