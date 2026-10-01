// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Everything a `ModbusRtuStream` needs, in one place.
 *
 * Threaded whole for the reason [`crate::io::SerialOverrides`] gives: these were
 * four loose values built at five sites, three of which had quietly settled on
 * `device_address: None`. It lives here rather than beside the serial framer
 * because the CAN tunnel wants it too, and because `SetFramingRequest` below
 * must stay buildable on a platform with no serial port.
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
