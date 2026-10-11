// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * `[meta.serial.checksum]`.
 */
export type ChecksumConfig = { algorithm: string, 
/**
 * End-relative when negative — see [`FrameChecksum::start_byte`].
 */
startByte: number, byteLength: number, calcStartByte: number, calcEndByte?: number | null, bigEndian: boolean, };
