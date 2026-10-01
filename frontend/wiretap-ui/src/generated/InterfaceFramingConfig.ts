// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ModbusRtuOptions } from "./ModbusRtuOptions";

/**
 * Per-interface framing configuration (overrides default for specific bus)
 */
export type InterfaceFramingConfig = { 
/**
 * Framing mode: "raw", "slip", "modbus_rtu"
 */
mode: "raw" | "slip" | "modbus_rtu", 
/**
 * For raw mode: delimiter bytes as hex string (e.g., "0D0A")
 */
delimiter?: string | null, 
/**
 * For raw mode: max frame length before forced split
 */
max_length?: number | null, 
/**
 * For modbus_rtu mode: the RTU settings. Re-framing has to agree with
 * the live framer or the Framed tab changes on stop.
 */
modbus?: ModbusRtuOptions | null, };
