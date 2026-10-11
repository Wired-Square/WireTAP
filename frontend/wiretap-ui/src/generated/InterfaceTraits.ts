// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameProtocol } from "./FrameProtocol";
import type { TemporalMode } from "./TemporalMode";

/**
 * Combined interface traits for formal session/interface characterization
 */
export type InterfaceTraits = { 
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
