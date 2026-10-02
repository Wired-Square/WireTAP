// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameIdConfig } from "./FrameIdConfig";
import type { FramingMode } from "./FramingMode";
import type { InterfaceFramingConfig } from "./InterfaceFramingConfig";
import type { ModbusRtuOptions } from "./ModbusRtuOptions";

/**
 * Configuration for backend framing
 */
export type BackendFramingConfig = { 
/**
 * Minimum frame length to accept (frames shorter are discarded)
 */
min_length?: number | null, 
/**
 * Frame ID extraction config
 */
frame_id_config?: FrameIdConfig | null, 
/**
 * Source address extraction config
 */
source_address_config?: FrameIdConfig | null, 
/**
 * Per-interface framing overrides (bus number -> config)
 */
per_interface?: { [key in number]: InterfaceFramingConfig } | null, mode: FramingMode, 
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
