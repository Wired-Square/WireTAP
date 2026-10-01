// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ModbusRegisterType } from "./ModbusRegisterType";

/**
 * Configuration for unit ID scanning
 */
export type UnitIdScanConfig = { 
/**
 * Server hostname or IP
 */
host?: string, 
/**
 * Server port (default 502)
 */
port?: number, 
/**
 * First unit ID to scan (default 1)
 */
start_unit_id: number, 
/**
 * Last unit ID to scan (default 247)
 */
end_unit_id: number, 
/**
 * Register to probe for existence (default 0)
 */
test_register: number, 
/**
 * Register type to probe (default Holding)
 */
register_type: ModbusRegisterType, 
/**
 * Delay between scan requests in milliseconds
 */
inter_request_delay_ms: number, timeout_ms?: number, connect_settle_ms?: number, };
