// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CanTransmitFrame } from "./CanTransmitFrame";

/**
 * One session's run of frames within a repeat group.
 */
export type RepeatGroupMember = { session_id: string, frames: Array<CanTransmitFrame>, };
