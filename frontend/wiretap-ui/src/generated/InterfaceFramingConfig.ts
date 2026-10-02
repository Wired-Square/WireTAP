// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FramingMode } from "./FramingMode";
import type { ModbusRtuOptions } from "./ModbusRtuOptions";

/**
 * Per-interface framing configuration (overrides default for specific bus)
 */
export type InterfaceFramingConfig = { mode: FramingMode, 
/**
 * For delimiter mode: delimiter bytes as hex string (e.g., "0D0A")
 */
delimiter?: string | null, 
/**
 * For delimiter mode: max frame length before forced split
 */
max_length?: number | null, 
/**
 * For modbus_rtu mode: the RTU settings. Re-framing has to agree with
 * the live framer or the Framed tab changes on stop.
 */
modbus?: ModbusRtuOptions | null, };
