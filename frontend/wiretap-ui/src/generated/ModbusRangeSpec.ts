// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ModbusRange } from "./ModbusRange";
import type { PollEmitMode } from "./PollEmitMode";

/**
 * A catalogue-free poll plan.
 */
export type ModbusRangeSpec = { ranges: Array<ModbusRange>, device_address?: number, interval_ms?: number, 
/**
 * Registers per request. Clamped to the protocol maximum for the type.
 */
block_size?: number, 
/**
 * Discovery defaults to one frame per register so per-register change
 * analysis works; `Block` is available for the rare case where you want
 * the raw response shape.
 */
emit_mode?: PollEmitMode, max_registers?: number, max_groups?: number, };
