// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * The defaults decode applies where the catalogue sets none.
 */
export type EffectiveDefaults = { canByteOrder: Endianness, serialByteOrder: Endianness, modbusByteOrder: Endianness, modbusWordOrder: Endianness, 
/**
 * 0 unless `[meta.modbus] register_base = 1`.
 */
modbusRegisterBase: number, };
