// ui/src/api/transmit.ts
//
// Tauri API wrappers for CAN frame and serial byte transmission.
// Uses IO session-based transmit - the session must be started first.

import { invoke } from "@tauri-apps/api/core";

// ============================================================================
// Types
// ============================================================================

/** CAN frame for transmission */
export interface CanTransmitFrame {
  /** CAN frame ID (11-bit standard or 29-bit extended) */
  frame_id: number;
  /** Frame data (up to 8 bytes for classic CAN, up to 64 for CAN FD) */
  data: number[];
  /** Bus number (0 for single-bus adapters, 0-4 for multi-bus like GVRET) */
  bus: number;
  /** Extended (29-bit) frame ID */
  is_extended: boolean;
  /** CAN FD frame */
  is_fd: boolean;
  /** Bit Rate Switch (CAN FD only) */
  is_brs: boolean;
  /** Remote Transmission Request */
  is_rtr: boolean;
}

/** Result of a transmit operation */
export interface TransmitResult {
  /** Whether the transmission was successful */
  success: boolean;
  /** Timestamp when the frame was sent (microseconds since UNIX epoch) */
  timestamp_us: number;
  /** Error message if transmission failed */
  error?: string;
}

/** Writer capabilities - what a transmit-capable profile supports */
export interface WriterCapabilities {
  /** Can transmit CAN frames */
  can_transmit_can: boolean;
  /** Can transmit serial bytes */
  can_transmit_serial: boolean;
  /** Supports CAN FD (64 bytes, BRS) */
  supports_canfd: boolean;
  /** Supports extended (29-bit) CAN IDs */
  supports_extended_id: boolean;
  /** Supports Remote Transmission Request frames */
  supports_rtr: boolean;
  /** Available bus numbers (empty = single bus, [0,1,2,3,4] = multi-bus like GVRET) */
  available_buses: number[];
}

/** Profile info with transmit capabilities */
export interface TransmitProfile {
  /** Profile ID */
  id: string;
  /** Display name */
  name: string;
  /** Profile kind (slcan, gvret_tcp, socketcan, serial) */
  kind: string;
  /** Writer capabilities */
  capabilities: WriterCapabilities;
}

/** Information about active profile usage */
export interface ProfileUsage {
  /** ID of the session using this profile */
  session_id: string;
}

/** Event payload for CAN transmit history (emitted during repeat transmits) */
export interface TransmitHistoryEvent {
  /** Session ID that transmitted */
  session_id: string;
  /** Queue item or group ID */
  queue_id: string;
  /** The frame that was transmitted */
  frame: CanTransmitFrame;
  /** Whether transmission succeeded */
  success: boolean;
  /** Timestamp in microseconds */
  timestamp_us: number;
  /** Error message if failed */
  error?: string;
}

/** Event payload for serial transmit history (emitted during repeat transmits) */
export interface SerialTransmitHistoryEvent {
  /** Session ID that transmitted */
  session_id: string;
  /** Queue item or group ID */
  queue_id: string;
  /** The bytes that were transmitted */
  bytes: number[];
  /** Whether transmission succeeded */
  success: boolean;
  /** Timestamp in microseconds */
  timestamp_us: number;
  /** Error message if failed */
  error?: string;
}

/** Event payload when a repeat transmission stops due to permanent error */
export interface RepeatStoppedEvent {
  /** Queue item or group ID that stopped */
  queue_id: string;
  /** Reason for stopping */
  reason: string;
}

/** Emitted once when a replay task begins */
export interface ReplayStartedEvent {
  replay_id: string;
  total_frames: number;
  speed: number;
  loop_replay: boolean;
}

/** Emitted ~4× per second during a replay to report progress */
export interface ReplayProgressEvent {
  replay_id: string;
  frames_sent: number;
  total_frames: number;
}

/** Emitted when a looping replay finishes a pass and is about to restart */
export interface ReplayLoopRestartedEvent {
  replay_id: string;
  /** Pass number that just completed (1-based) */
  pass: number;
  /** Cumulative frames sent across all passes so far */
  frames_sent: number;
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

/**
 * Get the current usage of a profile (if any).
 * Used to check if a profile is in use by a reader or writer session
 * before attempting to connect.
 * @param profileId - Profile to check
 * @returns Usage info or null if profile is not in use
 */
export async function getProfileUsage(
  profileId: string
): Promise<ProfileUsage | null> {
  return invoke("get_profile_usage", { profileId });
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
 * Transmit raw serial bytes through an existing IO session.
 * The session must be running a serial profile with transmit support.
 * @param sessionId - IO session to use for transmission
 * @param bytes - Raw bytes to transmit
 * @returns Transmit result with success/error info
 */
export async function ioTransmitSerial(
  sessionId: string,
  bytes: number[]
): Promise<TransmitResult> {
  return invoke("io_transmit_serial", { sessionId, bytes });
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
 * @param bytes - Serial bytes to repeat
 * @param intervalMs - Interval between transmissions in milliseconds
 */
export async function ioStartSerialRepeatTransmit(
  sessionId: string,
  queueId: string,
  bytes: number[],
  intervalMs: number
): Promise<void> {
  return invoke("io_start_serial_repeat_transmit", {
    sessionId,
    queueId,
    bytes,
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

/** A single frame with its original capture timestamp for time-accurate replay. */
export interface ReplayFrame {
  /** Original capture timestamp in microseconds since UNIX epoch. */
  timestamp_us: number;
  /** The CAN frame to transmit. */
  frame: CanTransmitFrame;
}

/**
 * Start a time-accurate replay of captured frames.
 * Frames are transmitted in order with delays derived from original timestamps / speed.
 * History events are emitted as `transmit-history`. A `repeat-stopped` event fires when done.
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
