// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * One group, in the desktop's `GroupedValue` shape. The readings are decimal
 * strings; bit positions count `byte * 8 + bit`, bit 0 least significant.
 */
export type GroupedValue = { 
/**
 * From 1.
 */
index: number, bits: number, hex: string, unsigned: string, signedTwos: string, signedOnes: string, signedMag: string, 
/**
 * The bytes the group's bits touch, non-printable as `.`.
 */
text: string, binary: string, 
/**
 * The bytes the group's bits touch.
 */
displayHex: string, bitOffset: number, startByteIndex: number, usedBitStart: number, usedBitEnd: number, };
