// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { MultiSourceInput } from "./MultiSourceInput";
import type { SerialOverrides } from "./SerialOverrides";

/**
 * What `open_session` creates when nothing is under the session id yet.
 */
export type OpenSessionOptions = { 
/**
 * The saved profile or capture to create the session from when nothing is under its id.
 */
source_id?: string, 
/**
 * Devices merged into one session, replacing whatever is under the id.
 */
sources?: Array<MultiSourceInput>, start_time?: string, end_time?: string, speed?: number, limit?: number, bus_override?: number, modbus_polls?: string, serial?: SerialOverrides, 
/**
 * Leave a session this open creates stopped.
 */
connect_only?: boolean, };
