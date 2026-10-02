// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ReplayEvent } from "./ReplayEvent";

/**
 * Snapshot of a replay's progress, pushed to the frontend over WS.
 */
export type ReplayState = { event: ReplayEvent, replay_id: string, session_id: string, 
/**
 * Frames sent since the replay started, over every pass.
 */
frames_sent: number, total_frames: number, speed: number, loop_replay: boolean, pass: number, 
/**
 * How long one pass takes on the replay's schedule.
 */
pass_duration_us: number, };
