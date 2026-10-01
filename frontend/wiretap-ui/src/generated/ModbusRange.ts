// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ModbusRegisterType } from "./ModbusRegisterType";

/**
 * One contiguous span of registers to poll.
 */
export type ModbusRange = { register_type: ModbusRegisterType, 
/**
 * Protocol-level start address (0-based).
 */
start: number, 
/**
 * Last address, inclusive.
 */
end: number, 
/**
 * Overrides the spec-level interval for this range.
 */
interval_ms?: number, 
/**
 * Overrides the spec-level slave address for this range.
 */
device_address?: number, };
