// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ChangesFrame } from "./ChangesFrame";
import type { ProtocolMirrors } from "./ProtocolMirrors";

export type PayloadChanges = { 
/**
 * The frames read for mirrors and bursts.
 */
frameCount: number, frames: Array<ChangesFrame>, 
/**
 * Selected frames past `max_frames`, not profiled.
 */
skippedFrames: number, mirrors: Array<ProtocolMirrors>, };
