// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * A per-frame checksum definition (`[[frame.<proto>.<key>.checksum]]`).
 * Distinct from [`ChecksumConfig`] (the serial-level default); a frame may
 * declare several.
 */
export type FrameChecksum = { name?: string | null, 
/**
 * A named algorithm, or one of the parameterised ids
 * ([`wiretap_checksum::CRC_CUSTOM`], [`wiretap_checksum::SUM8_NEGATED`]).
 */
algorithm: string, 
/**
 * Byte offset of the checksum. **Negative counts from the end**, which is
 * how detection reports every position — these were `u32`, so no detected
 * checksum survived a reload.
 */
startByte: number, byteLength: number, endianness?: Endianness | null, 
/**
 * First byte of the calculation range.
 */
calcStartByte: number, 
/**
 * Last byte of the calculation range, exclusive.
 */
calcEndByte?: number | null, 
/**
 * Free text carried with the declaration. A recovered CRC records here that
 * its `init`/`xorOut` pair is one of several that fit — the crate is
 * emphatic that presenting one as *the* answer is wrong, and a catalogue
 * that stores only the pair would do exactly that.
 */
notes?: Array<string>, polynomial?: number | null, init?: number | null, xorOut?: number | null, reflectIn?: boolean | null, reflectOut?: boolean | null, 
/**
 * The constant an additive checksum adds after summing.
 */
offset?: number | null, };
