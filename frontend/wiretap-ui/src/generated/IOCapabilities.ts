// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { InterfaceTraits } from "./InterfaceTraits";
import type { SessionDataStreams } from "./SessionDataStreams";

/**
 * IO device capabilities - what this device type supports
 */
export type IOCapabilities = { 
/**
 * Supports pause/resume (WireTAP backend: true, GVRET: false)
 */
can_pause: boolean, 
/**
 * Supports time range filtering (WireTAP backend: true, GVRET: false)
 */
supports_time_range: boolean, 
/**
 * Supports speed control (WireTAP backend: true, GVRET: false)
 */
supports_speed_control: boolean, 
/**
 * Supports seeking to a specific timestamp (Buffer: true, others: false)
 */
supports_seek: boolean, 
/**
 * Supports reverse playback (Buffer: true, others: false)
 */
supports_reverse: boolean, 
/**
 * Supports extended (29-bit) CAN IDs
 */
supports_extended_id: boolean, 
/**
 * Supports Remote Transmission Request frames
 */
supports_rtr: boolean, 
/**
 * Available bus numbers (empty = single bus, [0,1,2] = multi-bus like GVRET)
 */
available_buses: Array<number>, 
/**
 * Interface traits (temporal mode, protocols, transmit capability)
 */
traits: InterfaceTraits, 
/**
 * Declares which data streams this session produces (frames, bytes, or both)
 */
data_streams: SessionDataStreams, 
/**
 * Whether the session's transport is a serial link — a byte stream the user
 * can look at and frame for themselves.
 *
 * Deliberately not the same question as `data_streams.rx_bytes`, which says
 * whether raw bytes are actually on the wire *right now*. A framed serial
 * link is a serial link with no raw bytes, and the two answers were one
 * field until it had to mean both: Discovery used `rx_bytes` to decide
 * whether to show the serial view at all, so making that field truthful
 * would have hidden the Raw Bytes and Framed tabs from every framed-serial
 * source. A FrameLink RS-485 interface is *not* one of these — it puts
 * `Protocol::Serial` in the trait union but delivers framed messages, and
 * its kind is `framelink`.
 */
serial_link: boolean, };
