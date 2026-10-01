// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * The serial settings a session may override on one source, as the picker sends
 * them. Every field is optional: absent means "whatever the device profile says".
 *
 * **One declaration, threaded whole.** These were previously spelled out in
 * three structs and exploded into loose parameters twice on the way to
 * the reader, and the settings that got dropped were the ones somebody forgot to
 * add to one of those lists — the picker's framing choice, and then its
 * "capture raw bytes" tick. Add a serial setting here and it reaches the reader
 * on its own.
 */
export type SerialOverrides = { 
/**
 * Framing encoding for serial sources (overrides profile settings if provided)
 */
framing_encoding?: string | null, 
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
