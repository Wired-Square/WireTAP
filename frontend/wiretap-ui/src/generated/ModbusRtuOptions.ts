// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A line's RTU settings as a user picks and stores them, before a catalogue
 * adds its codes.
 */
export type ModbusRtuOptions = { 
/**
 * Device address filter (1-247). `None` syncs on any valid address.
 */
device_address?: number, 
/**
 * Whether a message has to pass its CRC to be framed. `false` is a lenient
 * mode, not "no framing" — see `CrcPolicy::Lenient`.
 */
validate_crc?: boolean, 
/**
 * Function codes the RTU length rules do not model but this line carries.
 * Framed by CRC search instead; empty leaves stock Modbus untouched.
 */
vendor_functions?: Array<number>, 
/**
 * Whether address 0 may start a message, for a master that broadcasts.
 */
allow_broadcast?: boolean, 
/**
 * Frame every function code, declared or not. What a tap on an unknown
 * line wants, at the cost of a fabricated message about once in 260
 * resyncs — see `ModbusRtuStream::frame_any_function`.
 */
any_function?: boolean, };
