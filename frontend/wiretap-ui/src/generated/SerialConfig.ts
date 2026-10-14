// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ChecksumConfig } from "./ChecksumConfig";
import type { Endianness } from "./Endianness";
import type { FramingMode } from "./FramingMode";
import type { HeaderField } from "./HeaderField";
import type { HeaderFieldPosition } from "./HeaderFieldPosition";

/**
 * `[meta.serial]` defaults.
 */
export type SerialConfig = { 
/**
 * Absent where the catalogue names none or one this library cannot frame,
 * which [`crate::validate`] reports.
 */
encoding?: FramingMode | null, byteOrder?: Endianness | null, frameIdMask?: number | null, headerLength?: number | null, minFrameLength?: number | null, checksum?: ChecksumConfig | null, fields?: { [key in string]: HeaderField }, 
/**
 * Byte position of the `id` field, when present; end-relative when negative.
 */
frameIdStartByte?: number | null, frameIdBytes?: number | null, frameIdByteOrder?: Endianness | null, 
/**
 * Byte position of the `source_address` field, when present; end-relative when negative.
 */
sourceAddressStartByte?: number | null, sourceAddressBytes?: number | null, sourceAddressByteOrder?: Endianness | null, 
/**
 * One position entry per header field (the resolved form of `fields`).
 */
headerFields?: Array<HeaderFieldPosition>, };
