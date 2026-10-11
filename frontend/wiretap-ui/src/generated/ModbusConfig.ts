// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";
import type { FunctionCode } from "./FunctionCode";

/**
 * `[meta.modbus]` defaults.
 */
export type ModbusConfig = { deviceAddress?: number | null, 
/**
 * 0 = IEC (0-based); 1 = traditional 1-based with a type prefix.
 */
registerBase?: number | null, defaultInterval?: number | null, defaultByteOrder?: Endianness | null, defaultWordOrder?: Endianness | null, 
/**
 * `[meta.modbus.function_code.<code>]`: the vendor codes this catalogue's
 * devices use, which every serial line and tunnel it describes inherits.
 */
functionCodes?: { [key in string]: FunctionCode }, };
