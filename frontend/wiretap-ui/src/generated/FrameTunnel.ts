// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { TunnelProtocol } from "./TunnelProtocol";

/**
 * A frame that carries a tunnelled protocol rather than a fixed bit layout
 * (`[frame.can.<key>.tunnel]`).
 *
 * The payloads of consecutive frames with this id concatenate into one byte
 * stream — both directions land on the same id — so decoding needs state
 * across frames, which [`crate::decode`] deliberately does not have. See
 * [`crate::modbus_rtu_stream`] for the decoder.
 */
export type FrameTunnel = { protocol: TunnelProtocol, 
/**
 * The Modbus slave address to sync on. Absent means "any valid address"
 * (`1..=247`), which resyncs more slowly after a dropped frame.
 */
deviceAddress?: number | null, 
/**
 * Unmodelled function codes this line is known to carry, beyond the
 * catalogue's [`ModbusConfig::function_codes`]. Empty means none; unioned
 * with any the caller adds.
 */
vendorFunctions?: Array<number>, 
/**
 * Whether this line's master broadcasts to address 0.
 */
allowBroadcast?: boolean, 
/**
 * Free-text notes on the tunnel declaration.
 */
notes?: Array<string>, };
