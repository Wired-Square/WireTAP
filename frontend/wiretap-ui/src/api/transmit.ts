// ui/src/api/transmit.ts
//
// Tauri API wrappers for CAN frame and serial byte transmission.
// Uses IO session-based transmit - the session must be started first.

import { invoke } from "@tauri-apps/api/core";
import type { CanTransmitFrame } from "../generated/CanTransmitFrame";
import type { RepeatStartedEvent } from "../generated/RepeatStartedEvent";
import type { RepeatStoppedEvent } from "../generated/RepeatStoppedEvent";
import type { ReplayFrame } from "../generated/ReplayFrame";
import type { SerialFraming } from "../generated/SerialFraming";
import type { TransmitProfile } from "../generated/TransmitProfile";
import type { TransmitResult } from "../generated/TransmitResult";
import type { WriterCapabilities } from "../generated/WriterCapabilities";

export type {
  CanTransmitFrame,
  RepeatStartedEvent,
  RepeatStoppedEvent,
  ReplayFrame,
  SerialFraming,
  TransmitProfile,
  TransmitResult,
  WriterCapabilities,
};

// ============================================================================
// Types
// ============================================================================

export type SerialFramingMode = SerialFraming["mode"];

export function serialFraming(mode: SerialFramingMode, delimiter: number[]): SerialFraming {
  return mode === "delimiter" ? { mode, delimiter } : { mode };
}

/**
 * Repeat-transmit lifecycle event pushed over the WebSocket
 * (`MsgType.RepeatEvent`), discriminated by `kind`.
 */
export type RepeatEvent =
  | ({ kind: "started" } & RepeatStartedEvent)
  | ({ kind: "stopped" } & RepeatStoppedEvent);

// ============================================================================
// Profile Query API
// ============================================================================

/**
 * Get all IO profiles that support transmission.
 * Filters out profiles that can't transmit (databases, buffers, silent mode slcan).
 */
export async function getTransmitCapableProfiles(): Promise<TransmitProfile[]> {
  return invoke("get_transmit_capable_profiles");
}

// ============================================================================
// IO Session-Based Transmit API
// ============================================================================
//
// These functions transmit through existing IO sessions, avoiding the need
// for separate writer connections. The IO session must be started first.
// This is the preferred approach as it uses the same connection for both
// reading and transmitting.

// IO session capabilities are defined in api/io.ts (IOCapabilities).
// Use getIOSessionCapabilities from api/io.ts instead.

/**
 * Transmit a CAN frame through an existing IO session.
 * The session must be running and support transmission.
 * @param sessionId - IO session to use for transmission
 * @param frame - CAN frame to transmit
 * @returns Transmit result with success/error info
 */
export async function ioTransmitCanFrame(
  sessionId: string,
  frame: CanTransmitFrame
): Promise<TransmitResult> {
  return invoke("io_transmit_can_frame", { sessionId, frame });
}

/**
 * Transmit serial bytes through an existing IO session.
 * The session must be running a serial profile with transmit support.
 * @param sessionId - IO session to use for transmission
 * @param bytes - Payload to transmit, before framing
 * @param framing - How the backend frames the payload
 * @returns Transmit result with success/error info
 */
export async function ioTransmitSerial(
  sessionId: string,
  bytes: number[],
  framing: SerialFraming
): Promise<TransmitResult> {
  return invoke("io_transmit_serial", { sessionId, bytes, framing });
}

/**
 * Start repeat transmission through an IO session.
 * @param sessionId - IO session to use
 * @param queueId - Unique ID for this repeat task
 * @param frame - CAN frame to repeat
 * @param intervalMs - Interval between transmissions in milliseconds
 */
export async function ioStartRepeatTransmit(
  sessionId: string,
  queueId: string,
  frame: CanTransmitFrame,
  intervalMs: number
): Promise<void> {
  return invoke("io_start_repeat_transmit", {
    sessionId,
    queueId,
    frame,
    intervalMs,
  });
}

/**
 * Stop repeat transmission for a queue item (IO session).
 * @param queueId - ID of the repeat task to stop
 */
export async function ioStopRepeatTransmit(queueId: string): Promise<void> {
  return invoke("io_stop_repeat_transmit", { queueId });
}

/**
 * Stop all repeat transmissions for an IO session.
 * @param sessionId - Session to stop all repeats for
 */
export async function ioStopAllRepeats(sessionId: string): Promise<void> {
  return invoke("io_stop_all_repeats", { sessionId });
}

/**
 * Start repeat transmission for serial bytes through an IO session.
 * @param sessionId - IO session to use
 * @param queueId - Unique ID for this repeat task
 * @param bytes - Payload to repeat, before framing
 * @param framing - How the backend frames the payload
 * @param intervalMs - Interval between transmissions in milliseconds
 */
export async function ioStartSerialRepeatTransmit(
  sessionId: string,
  queueId: string,
  bytes: number[],
  framing: SerialFraming,
  intervalMs: number
): Promise<void> {
  return invoke("io_start_serial_repeat_transmit", {
    sessionId,
    queueId,
    bytes,
    framing,
    intervalMs,
  });
}

// ============================================================================
// IO Session Group Repeat API
// ============================================================================
//
// Group repeat transmits multiple frames in sequence within a single loop.
// All frames are sent A→B→C with no delay between them, then the system
// waits for the interval before repeating the sequence.

/**
 * Start group repeat transmission through an IO session.
 * Frames are sent sequentially (A→B→C) with no delay between them,
 * then the system waits for the interval before repeating.
 * @param sessionId - IO session to use
 * @param groupId - Unique ID for this group (used to stop it later)
 * @param frames - CAN frames to transmit in sequence
 * @param intervalMs - Interval between complete sequences in milliseconds
 */
export async function ioStartRepeatGroup(
  sessionId: string,
  groupId: string,
  frames: CanTransmitFrame[],
  intervalMs: number
): Promise<void> {
  return invoke("io_start_repeat_group", {
    sessionId,
    groupId,
    frames,
    intervalMs,
  });
}

/**
 * Stop repeat transmission for a group.
 * @param groupId - ID of the group to stop
 */
export async function ioStopRepeatGroup(groupId: string): Promise<void> {
  return invoke("io_stop_repeat_group", { groupId });
}

/**
 * Stop all group repeat transmissions.
 */
export async function ioStopAllGroupRepeats(): Promise<void> {
  return invoke("io_stop_all_group_repeats");
}

// ============================================================================
// Replay API
// ============================================================================

/**
 * Start a time-accurate replay of captured frames.
 * Frames are transmitted in order with delays derived from original timestamps / speed.
 * Progress and completion are surfaced via the `ReplayState` WS message.
 * @param sessionId - Target session to transmit on
 * @param replayId - Unique ID for this replay (used to stop it)
 * @param frames - Frames to replay, sorted by timestamp_us ascending
 * @param speed - Playback speed multiplier (1.0 = realtime, 2.0 = twice as fast)
 * @param loopReplay - Whether to loop indefinitely
 */
export async function ioStartReplay(
  sessionId: string,
  replayId: string,
  frames: ReplayFrame[],
  speed: number,
  loopReplay: boolean
): Promise<void> {
  return invoke("io_start_replay", { sessionId, replayId, frames, speed, loopReplay });
}

/**
 * Stop an active replay by ID.
 * @param replayId - ID of the replay to stop
 */
export async function ioStopReplay(replayId: string): Promise<void> {
  return invoke("io_stop_replay", { replayId });
}

/**
 * Stop all active replays.
 */
export async function ioStopAllReplays(): Promise<void> {
  return invoke("io_stop_all_replays");
}
