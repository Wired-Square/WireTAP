// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ChecksumAlgorithm } from "./ChecksumAlgorithm";

/**
 * One point in the checksum candidate space: where the checksum sits, how it is
 * read, and which bytes it is calculated over.
 */
export type ChecksumSpec = { algorithm: ChecksumAlgorithm, 
/**
 * Byte offset of the checksum; negative counts from the end.
 */
position: number, byteLength: number, bigEndian: boolean, calcStartByte: number, calcEndByte: number, };
