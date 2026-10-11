// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";

/**
 * `[meta.modbus]`, for [`super::EditOp::SetModbusConfig`]. Function codes are kept.
 */
export type ModbusConfigFields = { device_address?: number | null, register_base?: number | null, default_interval?: number | null, default_byte_order?: Endianness | null, default_word_order?: Endianness | null, };
