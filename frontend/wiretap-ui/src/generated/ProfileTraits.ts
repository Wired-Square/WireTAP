// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Protocol } from "./Protocol";
import type { TemporalMode } from "./TemporalMode";
import type { TxBlock } from "./TxBlock";

/**
 * What one profile brings to a session, read off its own connection map.
 */
export type ProfileTraits = { 
/**
 * The protocol a single-bus profile's one bus carries.
 */
bus_protocol: Protocol, multi_bus: boolean, tx_blocked: TxBlock | null, 
/**
 * Temporal mode of the interface
 */
temporal_mode: TemporalMode, 
/**
 * Protocols supported by the interface
 */
protocols: Array<Protocol>, 
/**
 * Whether the interface can transmit frames (CAN, Modbus, framed serial)
 */
tx_frames: boolean, 
/**
 * Whether the interface can transmit raw bytes (serial)
 */
tx_bytes: boolean, 
/**
 * Whether this source can be combined with others in a multi-source session
 */
multi_source: boolean, };
