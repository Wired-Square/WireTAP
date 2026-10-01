// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Configuration for the function-code probe.
 */
export type FcProbeConfig = { 
/**
 * Server hostname or IP
 */
host?: string, port?: number, 
/**
 * Slave addresses to try. Defaults to the common suspects.
 */
unit_ids?: Array<number>, 
/**
 * Address read on each function code. 0 is almost always safe.
 */
test_register?: number, timeout_ms?: number, connect_settle_ms?: number, };
