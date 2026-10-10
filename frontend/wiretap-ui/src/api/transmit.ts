// ui/src/api/transmit.ts
//
// Tauri API wrappers for CAN frame and serial byte transmission.
// Uses IO session-based transmit - the session must be started first.

import { invoke } from "@tauri-apps/api/core";
import type { CanTransmitFrame } from "../generated/CanTransmitFrame";
import type { FrameMessage } from "../generated/FrameMessage";
import type { NewQueueRow } from "../generated/NewQueueRow";
import type { QueuePayload } from "../generated/QueuePayload";
import type { QueueRow } from "../generated/QueueRow";
import type { QueueRowEdit } from "../generated/QueueRowEdit";
import type { ReplayEstimate } from "../generated/ReplayEstimate";
import type { ReplayEvent } from "../generated/ReplayEvent";
import type { ReplaySource } from "../generated/ReplaySource";
import type { ReplayState } from "../generated/ReplayState";
import type { TransmitQueue } from "../generated/TransmitQueue";
import type { SerialFraming } from "../generated/SerialFraming";
import type { TransmitProfile } from "../generated/TransmitProfile";
import type { TransmitResult } from "../generated/TransmitResult";
import type { WriterCapabilities } from "../generated/WriterCapabilities";

export type {
  CanTransmitFrame,
  NewQueueRow,
  QueuePayload,
  QueueRow,
  QueueRowEdit,
  ReplayEstimate,
  ReplayEvent,
  ReplaySource,
  ReplayState,
  SerialFraming,
  TransmitQueue,
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

export type ReceivedFrame = Pick<FrameMessage, "frame_id" | "bytes" | "is_extended" | "dlc"> &
  Partial<Pick<FrameMessage, "bus" | "is_fd" | "is_brs" | "is_rtr">>;

/** A received frame to send as received; an RTR asks for its `dlc` in bytes, as the Transmit editor carries it. */
export function toTransmitFrame(f: ReceivedFrame): CanTransmitFrame {
  return {
    frame_id: f.frame_id,
    data: f.is_rtr ? Array(f.dlc).fill(0) : [...f.bytes],
    bus: f.bus ?? 0,
    is_extended: f.is_extended,
    is_fd: f.is_fd ?? false,
    is_brs: f.is_brs ?? false,
    is_rtr: f.is_rtr ?? false,
  };
}

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

// ============================================================================
// Transmit queue — process state in Rust, pushed whole as `MsgType.TransmitQueue`
// ============================================================================

export async function getTransmitQueue(): Promise<TransmitQueue> {
  return invoke("transmit_queue_get");
}

export async function addToTransmitQueue(rows: NewQueueRow[]): Promise<string[]> {
  return invoke("transmit_queue_add", { rows });
}

export async function editQueueRow(id: string, edit: QueueRowEdit): Promise<void> {
  return invoke("transmit_queue_edit", { id, edit });
}

export async function removeQueueRow(id: string): Promise<void> {
  return invoke("transmit_queue_remove", { id });
}

export async function clearTransmitQueue(): Promise<void> {
  return invoke("transmit_queue_clear");
}

export async function startQueueRow(id: string): Promise<void> {
  return invoke("transmit_queue_start", { id });
}

export async function stopQueueRow(id: string): Promise<void> {
  return invoke("transmit_queue_stop", { id });
}

/** Sends the group's enabled CAN rows in queue order, every interval of its first row. */
export async function startQueueGroup(group: string): Promise<void> {
  return invoke("transmit_group_start", { group });
}

export async function stopQueueGroup(group: string): Promise<void> {
  return invoke("transmit_group_stop", { group });
}

export async function stopAllQueueRepeats(): Promise<void> {
  return invoke("transmit_queue_stop_all");
}

// ============================================================================
// Replay API
// ============================================================================

/**
 * Start a time-accurate replay of a capture range through a session.
 * Progress and completion are surfaced via the `ReplayState` WS message.
 * @returns how many frames it plays
 */
export async function ioStartReplay(
  sessionId: string,
  replayId: string,
  source: ReplaySource,
  speed: number,
  loopReplay: boolean
): Promise<number> {
  return invoke("io_start_replay", { sessionId, replayId, source, speed, loopReplay });
}

/** Play a replay again from its start, with what it was started with. */
export async function ioRestartReplay(replayId: string): Promise<number> {
  return invoke("io_restart_replay", { replayId });
}

/** How long a replay of `source` would take at `speed`, by the schedule it keeps. */
export async function replayEstimate(source: ReplaySource, speed: number): Promise<ReplayEstimate> {
  return invoke("replay_estimate", { source, speed });
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
