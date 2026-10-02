// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BusMapping } from "./BusMapping";
import type { FramingMode } from "./FramingMode";

/**
 * Source configuration for multi-source session creation (TypeScript-friendly version)
 */
export type MultiSourceInput = { 
/**
 * Profile ID for this source
 */
profile_id: string, 
/**
 * Display name for this source (optional, defaults to profile name)
 */
display_name?: string, 
/**
 * Bus mappings for this source
 */
bus_mappings: Array<BusMapping>, 
/**
 * Framing encoding for serial sources (overrides profile settings if provided)
 */
framing_encoding?: FramingMode | null, 
/**
 * Delimiter bytes for delimiter-based framing
 */
delimiter?: Array<number> | null, 
/**
 * Maximum frame length for delimiter-based framing
 */
max_frame_length?: number | null, 
/**
 * Minimum frame length - frames shorter than this are discarded
 */
min_frame_length?: number | null, 
/**
 * Whether to emit raw bytes in addition to framed data
 */
emit_raw_bytes?: boolean | null, 
/**
 * Whether to check the CRC-16 on Modbus RTU framing
 */
modbus_validate_crc?: boolean | null, 
/**
 * Modbus RTU slave address to sync on; absent means any valid address
 */
modbus_device_address?: number | null, 
/**
 * Function codes the RTU length rules do not model but this line carries
 */
modbus_vendor_functions?: Array<number> | null, 
/**
 * Whether address 0 may start a Modbus RTU message
 */
modbus_allow_broadcast?: boolean | null, 
/**
 * Whether every Modbus function code frames, declared or not
 */
modbus_any_function?: boolean | null, 
/**
 * Frame ID extraction: start byte position (0-indexed)
 */
frame_id_start_byte?: number | null, 
/**
 * Frame ID extraction: number of bytes (1 or 2)
 */
frame_id_bytes?: number | null, 
/**
 * Frame ID extraction: byte order (true = big endian)
 */
frame_id_big_endian?: boolean | null, 
/**
 * Source address extraction: start byte position (0-indexed)
 */
source_address_start_byte?: number | null, 
/**
 * Source address extraction: number of bytes (1 or 2)
 */
source_address_bytes?: number | null, 
/**
 * Source address extraction: byte order (true = big endian)
 */
source_address_big_endian?: boolean | null, };
