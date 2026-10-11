// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { RegisterType } from "./RegisterType";

export type ModbusExportConfig = { device_address: number, register_base: number, register_type: RegisterType, 
/**
 * Milliseconds, written rounded and at least 0.
 */
default_interval: number, };
