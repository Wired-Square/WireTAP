// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameProtocol } from "./FrameProtocol";
import type { TemporalMode } from "./TemporalMode";
import type { TxBlock } from "./TxBlock";

/**
 * A kind's traits as a profile with nothing configured has them.
 */
export type KindTraits = { kind: string, available: boolean, 
/**
 * The protocol a single-bus profile's one bus carries.
 */
bus_protocol: FrameProtocol, multi_bus: boolean, tx_blocked: TxBlock | null, 
/**
 * Temporal mode of the interface
 */
temporal_mode: TemporalMode, 
/**
 * Protocols supported by the interface
 */
protocols: Array<FrameProtocol>, 
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
