// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ModbusRegisterType } from "./ModbusRegisterType";

/**
 * Configuration for register range scanning.
 *
 * Everything past `inter_request_delay_ms` has a serde default, so a caller
 * that only knows the original fields still deserialises.
 */
export type ModbusScanConfig = { 
/**
 * Server hostname or IP
 */
host?: string, 
/**
 * Server port (default 502)
 */
port?: number, 
/**
 * Modbus unit/slave ID (1-247)
 */
unit_id: number, 
/**
 * Register type to scan
 */
register_type: ModbusRegisterType, 
/**
 * First register address to scan (protocol-level, 0-based)
 */
start_register: number, 
/**
 * Last register address to scan (inclusive)
 */
end_register: number, 
/**
 * Number of registers to read per bulk request (max 125 for holding/input, 2000 for coils)
 */
chunk_size: number, 
/**
 * Delay between scan requests in milliseconds
 */
inter_request_delay_ms: number, 
/**
 * Per-request timeout. The only thing bounding a device that answers a
 * function code with silence rather than an exception.
 */
timeout_ms?: number, 
/**
 * Pause after connecting before the first request on that socket.
 */
connect_settle_ms?: number, 
/**
 * Open a fresh connection per request, for stacks that serve one
 * conversation per socket.
 */
reconnect_per_request?: boolean, 
/**
 * Give up on this register type after this many silent requests in a row.
 */
max_consecutive_timeouts?: number, 
/**
 * Refuse a sweep wider than this.
 */
max_registers?: number, 
/**
 * Hard ceiling on requests issued. This, not `max_registers`, is what
 * actually bounds how long a scan can take.
 */
max_requests?: number, 
/**
 * Number of passes. Two or more samples the same registers repeatedly, so
 * the Changes tool can separate live telemetry from static configuration.
 */
repeat?: number, 
/**
 * Gap between passes when `repeat > 1`.
 */
repeat_delay_ms?: number, };
