// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * `[meta.serial.checksum]`, with a frame checksum's keys. The camelCase names,
 * a served [`crate::model::FrameChecksum`]'s, are accepted as aliases.
 */
export type SerialChecksumFields = { name?: string | null, algorithm: string, start_byte: number, byte_length?: number, calc_start_byte?: number, calc_end_byte?: number | null, endianness?: Endianness | null, polynomial?: number | null, init?: number | null, xor_out?: number | null, reflect_in?: boolean | null, reflect_out?: boolean | null, offset?: number | null, notes?: string | Array<string> | null, };
