// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CanTransmitFrame } from "./CanTransmitFrame";

/**
 * A single frame with its original capture timestamp, used for time-accurate replay.
 */
export type ReplayFrame = { 
/**
 * Original capture timestamp (microseconds since UNIX epoch).
 */
timestamp_us: number, 
/**
 * The CAN frame to transmit.
 */
frame: CanTransmitFrame, };
