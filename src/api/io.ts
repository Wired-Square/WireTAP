// ui/src/api/io.ts
//
// API wrappers for the session-based IO system.
// Provides a unified interface for reading and writing CAN data.

import { invoke } from "@tauri-apps/api/core";
import type { FrameMessage } from "../types/frame";

// ============================================================================
// Interface Traits
// ============================================================================

/**
 * Temporal mode of an interface/session.
 * - "realtime": Live streaming from hardware (GVRET, slcan, gs_usb, SocketCAN, MQTT)
 * - "recorded": Recorded playback (PostgreSQL, CSV)
 * - "buffer": Buffer replay from captured data
 */
export type TemporalMode = "realtime" | "recorded" | "buffer";

/**
 * Protocol family for frame-based communication.
 * CAN and CAN-FD are compatible (can coexist in a session).
 * Other protocols are incompatible with each other.
 */
export type Protocol = "can" | "canfd" | "modbus" | "serial";

/**
 * Combined interface traits for formal session/interface characterization.
 */
export interface InterfaceTraits {
  /** Temporal mode of the interface */
  temporal_mode: TemporalMode;
  /** Protocols supported by the interface */
  protocols: Protocol[];
  /** Whether the interface can transmit frames (CAN, Modbus, framed serial) */
  tx_frames: boolean;
  /** Whether the interface can transmit raw bytes (serial) */
  tx_bytes: boolean;
  /** Whether this source can be combined with others in a multi-source session */
  multi_source: boolean;
}

/**
 * Declares the data streams a session produces.
 * Used by the frontend to decide which event listeners and views to set up.
 */
export interface SessionDataStreams {
  /** Whether this session emits framed messages (frame-message events) */
  rx_frames: boolean;
  /** Whether this session emits raw byte streams (serial-raw-bytes events) */
  rx_bytes: boolean;
}

/** A single raw byte with timestamp, as emitted by serial/byte-stream sessions */
export interface RawByteEntry {
  byte: number;
  timestamp_us: number;
  bus?: number;
}

/** Payload for raw byte stream events (serial-raw-bytes) */
export interface RawBytesPayload {
  bytes: RawByteEntry[];
  port: string;
}

// ============================================================================
// IO Capabilities
// ============================================================================

/**
 * IO capabilities - what an IO device type supports.
 */
export interface IOCapabilities {
  /** Supports pause/resume (PostgreSQL: true, GVRET: false) */
  can_pause: boolean;
  /** Supports time range filtering (PostgreSQL: true, GVRET: false) */
  supports_time_range: boolean;
  /** Supports speed control (PostgreSQL: true, GVRET: false) */
  supports_speed_control: boolean;
  /** Supports seeking to a specific timestamp (BufferReader: true, others: false) */
  supports_seek: boolean;
  /** Supports reverse playback (BufferReader: true, others: false) */
  supports_reverse?: boolean;
  /** Supports extended (29-bit) CAN IDs */
  supports_extended_id: boolean;
  /** Supports Remote Transmission Request frames */
  supports_rtr: boolean;
  /** Available bus numbers (empty = single bus) */
  available_buses: number[];
  /** Interface traits (temporal mode, protocols, transmit capability) */
  traits: InterfaceTraits;
  /** Declares which data streams this session produces */
  data_streams: SessionDataStreams;
}

/**
 * IO session state.
 */
export type IOState =
  | { type: "Stopped" }
  | { type: "Starting" }
  | { type: "Running" }
  | { type: "Paused" }
  | { type: "Error"; message: string };

/**
 * Simple IO state string for easy comparisons.
 */
export type IOStateType = "stopped" | "starting" | "running" | "paused" | "error";

/**
 * Convert IOState to simple string type.
 */
export function getStateType(state: IOState): IOStateType {
  switch (state.type) {
    case "Stopped":
      return "stopped";
    case "Starting":
      return "starting";
    case "Running":
      return "running";
    case "Paused":
      return "paused";
    case "Error":
      return "error";
  }
}

/**
 * Framing encoding types for serial readers.
 */
export type FramingEncoding = "slip" | "modbus_rtu" | "delimiter" | "raw";

/**
 * Options for creating an IO session.
 */
export interface CreateIOSessionOptions {
  /** Unique session ID (e.g., "discovery", "decoder") */
  sessionId: string;
  /** Profile ID to use (optional, defaults to default_read_profile) */
  profileId?: string;
  /** Start time for time-range capable readers (ISO-8601) */
  startTime?: string;
  /** End time for time-range capable readers (ISO-8601) */
  endTime?: string;
  /** Initial playback speed (default: 1.0) */
  speed?: number;
  /** Maximum number of frames to read (optional) */
  limit?: number;
  /** File path for file-based readers */
  filePath?: string;
  /** Use the shared buffer reader instead of a profile-based reader */
  useBuffer?: boolean;

  // Serial framing configuration
  /** Framing encoding for serial readers: "slip", "modbus_rtu", "delimiter", or "raw" */
  framingEncoding?: FramingEncoding;
  /** Delimiter byte sequence for delimiter-based framing (e.g., [0x0D, 0x0A] for CRLF) */
  delimiter?: number[];
  /** Maximum frame length for delimiter-based framing (default: 256) */
  maxFrameLength?: number;

  // Frame ID extraction configuration
  /** Frame ID extraction: start byte position (supports negative indexing from end) */
  frameIdStartByte?: number;
  /** Frame ID extraction: number of bytes (1 or 2) */
  frameIdBytes?: number;
  /** Frame ID extraction: byte order (true = big endian) */
  frameIdBigEndian?: boolean;

  // Source address extraction configuration
  /** Source address extraction: start byte position (supports negative indexing from end) */
  sourceAddressStartByte?: number;
  /** Source address extraction: number of bytes (1 or 2) */
  sourceAddressBytes?: number;
  /** Source address extraction: byte order (true = big endian) */
  sourceAddressBigEndian?: boolean;

  /** Minimum frame length to accept (frames shorter than this are discarded) */
  minFrameLength?: number;
  /** Also emit raw bytes (serial-raw-bytes) in addition to frames when framing is enabled */
  emitRawBytes?: boolean;
  /** Bus number override for single-bus devices (0-7) */
  busOverride?: number;
  /** Listener instance ID for session logging (e.g., "discovery_1", "decoder_2") */
  subscriberId?: string;
  /** Human-readable app name (e.g., "discovery", "decoder") */
  appName?: string;
  /** Buffer ID for buffer reader sessions (e.g., "xk9m2p") */
  captureId?: string;
  /** Modbus TCP poll groups as JSON string (catalog-derived, for modbus_tcp profiles) */
  modbusPollsJson?: string;
}

/**
 * Create a new IO session.
 * Returns the capabilities of the created IO device.
 */
export async function createIOSession(
  options: CreateIOSessionOptions
): Promise<IOCapabilities> {
  // Use buffer reader if requested
  if (options.useBuffer) {
    return invoke("create_capture_source_session", {
      session_id: options.sessionId,
      capture_id: options.captureId,
      speed: options.speed,
    });
  }

  return invoke("create_reader_session", {
    session_id: options.sessionId,
    profile_id: options.profileId,
    start_time: options.startTime,
    end_time: options.endTime,
    speed: options.speed,
    limit: options.limit,
    file_path: options.filePath,
    // Framing configuration
    framing_encoding: options.framingEncoding,
    delimiter: options.delimiter,
    max_frame_length: options.maxFrameLength,
    // Frame ID extraction
    frame_id_start_byte: options.frameIdStartByte,
    frame_id_bytes: options.frameIdBytes,
    frame_id_big_endian: options.frameIdBigEndian,
    // Source address extraction
    source_address_start_byte: options.sourceAddressStartByte,
    source_address_bytes: options.sourceAddressBytes,
    source_address_big_endian: options.sourceAddressBigEndian,
    // Other options
    min_frame_length: options.minFrameLength,
    emit_raw_bytes: options.emitRawBytes,
    // Bus override for single-bus devices
    bus_override: options.busOverride,
    // Listener ID for session logging
    subscriber_id: options.subscriberId,
    // Human-readable app name
    app_name: options.appName,
    // Modbus TCP poll groups (catalog-derived)
    modbus_polls: options.modbusPollsJson,
  });
}

/**
 * Get the state of an IO session.
 * Returns null if the session doesn't exist.
 */
export async function getIOSessionState(
  sessionId: string
): Promise<IOState | null> {
  return invoke("get_reader_session_state", { session_id: sessionId });
}

/**
 * Get the capabilities of an IO session.
 * Returns null if the session doesn't exist.
 */
export async function getIOSessionCapabilities(
  sessionId: string
): Promise<IOCapabilities | null> {
  return invoke("get_reader_session_capabilities", { session_id: sessionId });
}

/**
 * Result of joining an existing session.
 */
export interface JoinSessionResult {
  capabilities: IOCapabilities;
  state: IOState;
  capture_id: string | null;
  /** Kind of the active capture ("frames" or "bytes"), if any */
  capture_kind: "frames" | "bytes" | null;
  /** Number of apps connected to this session (including this one) */
  joiner_count: number;
}

/**
 * Join an existing reader session (for session sharing between apps).
 * Returns session info if session exists, throws error if not.
 * The caller can then set up event listeners to receive frames and state changes.
 * Any app that joins can control the session (start/stop/pause/resume).
 */
export async function joinReaderSession(sessionId: string): Promise<JoinSessionResult> {
  return invoke("join_reader_session", { session_id: sessionId });
}

/**
 * Leave a reader session without stopping it.
 * Call this when you want to stop listening but not stop the session.
 * The frontend should stop listening to events after calling this.
 * @returns The remaining joiner count after leaving
 */
export async function leaveReaderSession(sessionId: string): Promise<number> {
  return invoke("leave_reader_session", { session_id: sessionId });
}

// Legacy heartbeat functions removed - use registerSessionSubscriber/unregisterSessionSubscriber instead

/**
 * Get the current joiner count for a session.
 * Returns 0 if the session doesn't exist.
 */
export async function getReaderSessionJoinerCount(sessionId: string): Promise<number> {
  return invoke("get_reader_session_joiner_count", { session_id: sessionId });
}

/**
 * Start a reader session.
 * Returns the confirmed state after the operation.
 */
export async function startReaderSession(sessionId: string): Promise<IOState> {
  return invoke("start_reader_session", { session_id: sessionId });
}

/**
 * Stop a reader session.
 * Returns the confirmed state after the operation.
 */
export async function stopReaderSession(sessionId: string): Promise<IOState> {
  return invoke("stop_reader_session", { session_id: sessionId });
}

/**
 * Pause a reader session.
 * Only works for readers that support pause (e.g., PostgreSQL).
 * Returns the confirmed state after the operation.
 */
export async function pauseReaderSession(sessionId: string): Promise<IOState> {
  return invoke("pause_reader_session", { session_id: sessionId });
}

/**
 * Resume a paused reader session.
 * Returns the confirmed state after the operation.
 */
export async function resumeReaderSession(sessionId: string): Promise<IOState> {
  return invoke("resume_reader_session", { session_id: sessionId });
}

/**
 * Pause polling for a specific source within a running multi-source session.
 * The session stays active and other sources continue normally.
 */
export async function pauseSourcePolling(sessionId: string, profileId: string): Promise<void> {
  return invoke("pause_source_polling", { session_id: sessionId, profile_id: profileId });
}

/**
 * Resume polling for a paused source within a running multi-source session.
 */
export async function resumeSourcePolling(sessionId: string, profileId: string): Promise<void> {
  return invoke("resume_source_polling", { session_id: sessionId, profile_id: profileId });
}

/**
 * Suspend a reader session - stops streaming, finalizes buffer, session stays alive.
 * The buffer remains owned by the session and all joined apps can view it.
 * Use `resumeReaderSessionFresh` to start streaming again with a new buffer.
 * Returns the confirmed state after the operation.
 */
export async function suspendReaderSession(sessionId: string): Promise<IOState> {
  return invoke("suspend_reader_session", { session_id: sessionId });
}

/**
 * Resume a suspended session with a fresh buffer.
 * The old buffer is orphaned (becomes available for standalone viewing).
 * A new buffer is created for the session and streaming starts.
 * Returns the confirmed state after the operation.
 */
export async function resumeReaderSessionFresh(sessionId: string): Promise<IOState> {
  return invoke("resume_reader_session_fresh", { session_id: sessionId });
}

/**
 * Copy a buffer for an app that is detaching from a session.
 * Creates an orphaned copy of the buffer that can be used standalone.
 * Returns the new buffer ID.
 */
export async function copyBufferForDetach(
  captureId: string,
  newName: string
): Promise<string> {
  return invoke("copy_capture_for_detach", { capture_id: captureId, new_name: newName });
}

/**
 * Enable or disable traffic generation for a virtual device session.
 * When disabled, the session stays connected but no synthetic traffic is generated.
 */
export async function setVirtualTrafficEnabled(
  sessionId: string,
  enabled: boolean
): Promise<void> {
  return invoke("set_virtual_traffic_enabled", { session_id: sessionId, enabled });
}

/** Per-bus signal generator state returned from the backend */
export interface VirtualBusState {
  bus: number;
  enabled: boolean;
  frame_rate_hz: number;
}

/**
 * Enable or disable signal generator for a specific bus on a virtual device session.
 */
export async function setVirtualBusTrafficEnabled(
  sessionId: string,
  bus: number,
  enabled: boolean
): Promise<void> {
  return invoke("set_virtual_bus_traffic_enabled", { session_id: sessionId, bus, enabled });
}

/**
 * Update signal generator cadence (frame rate) for a specific bus.
 */
export async function setVirtualBusCadence(
  sessionId: string,
  bus: number,
  frameRateHz: number
): Promise<void> {
  return invoke("set_virtual_bus_cadence", { session_id: sessionId, bus, frame_rate_hz: frameRateHz });
}

/**
 * Query current per-bus signal generator states for a virtual device session.
 */
export async function getVirtualBusStates(
  sessionId: string
): Promise<VirtualBusState[]> {
  return invoke("get_virtual_bus_states", { session_id: sessionId });
}

/**
 * Add a virtual bus generator to a running session.
 */
export async function addVirtualBus(
  sessionId: string,
  bus: number,
  trafficType: string,
  frameRateHz: number
): Promise<void> {
  return invoke("add_virtual_bus", {
    session_id: sessionId,
    bus,
    traffic_type: trafficType,
    frame_rate_hz: frameRateHz,
  });
}

/**
 * Remove a virtual bus generator from a running session.
 */
export async function removeVirtualBus(
  sessionId: string,
  bus: number
): Promise<void> {
  return invoke("remove_virtual_bus", { session_id: sessionId, bus });
}

/**
 * Update playback speed for a reader session.
 * Only works for readers that support speed control (e.g., PostgreSQL).
 */
export async function updateReaderSpeed(
  sessionId: string,
  speed: number
): Promise<void> {
  return invoke("update_reader_speed", { session_id: sessionId, speed });
}

/**
 * Update time range for a reader session.
 * Only works when the reader is stopped and supports time range.
 */
export async function updateReaderTimeRange(
  sessionId: string,
  start?: string,
  end?: string
): Promise<void> {
  return invoke("update_reader_time_range", {
    session_id: sessionId,
    start,
    end,
  });
}

/**
 * Reconfigure a running session with new time range.
 * This stops the current stream, orphans the old buffer, creates a new buffer,
 * and starts streaming with the new time range - all while keeping the session alive.
 * Other apps joined to this session remain connected.
 */
export async function reconfigureReaderSession(
  sessionId: string,
  start?: string,
  end?: string
): Promise<void> {
  return invoke("reconfigure_reader_session", {
    session_id: sessionId,
    start,
    end,
  });
}

/**
 * Destroy a reader session.
 * Stops the reader if running and cleans up resources.
 */
export async function destroyReaderSession(sessionId: string): Promise<void> {
  return invoke("destroy_reader_session", { session_id: sessionId });
}

/**
 * Information about active profile usage.
 */
export interface ProfileUsage {
  /** ID of the session using this profile */
  session_id: string;
}

/**
 * Get the current usage of a profile (if any).
 * Used to check if a profile is in use by another session before creating a new one.
 * @param profileId - Profile to check
 * @returns Usage info or null if profile is not in use
 */
export async function getProfileUsage(profileId: string): Promise<ProfileUsage | null> {
  return invoke("get_profile_usage", { profileId });
}

/**
 * Seek a reader session to a specific timestamp.
 * Only works for readers that support seeking (e.g., BufferReader).
 * @param sessionId The session ID
 * @param timestampUs The target timestamp in microseconds
 */
export async function seekReaderSession(
  sessionId: string,
  timestampUs: number
): Promise<void> {
  return invoke("seek_reader_session", { session_id: sessionId, timestamp_us: Math.round(timestampUs) });
}

/**
 * Seek a reader session to a specific frame index.
 * Preferred over timestamp-based seeking for buffer playback as it avoids floating-point issues.
 * @param sessionId The session ID
 * @param frameIndex The target frame index (0-based)
 */
export async function seekReaderSessionByFrame(
  sessionId: string,
  frameIndex: number
): Promise<void> {
  return invoke("seek_reader_session_by_frame", {
    session_id: sessionId,
    frame_index: Math.floor(frameIndex),
  });
}

/**
 * Set playback direction for a reader session.
 * Only works for readers that support reverse playback (e.g., BufferReader).
 * @param sessionId The session ID
 * @param reverse true for backwards playback, false for forward
 */
export async function updateReaderDirection(
  sessionId: string,
  reverse: boolean
): Promise<void> {
  return invoke("update_reader_direction", { session_id: sessionId, reverse });
}

/**
 * Result of a step operation in the buffer.
 */
export interface StepResult {
  /** The new frame index after stepping */
  frame_index: number;
  /** The timestamp of the new frame in microseconds */
  timestamp_us: number;
}

/**
 * Playback position - emitted with playback-time events during buffer streaming.
 */
export interface PlaybackPosition {
  /** Current timestamp in microseconds */
  timestamp_us: number;
  /** Current frame index (0-based) */
  frame_index: number;
  /** Total frame count in buffer (optional, for recorded sources) */
  frame_count?: number;
}

/**
 * Step one frame forward or backward in the buffer.
 * Only works for buffer readers when paused.
 * @param sessionId The session ID
 * @param currentFrameIndex The current frame index (0-based), or null to use timestamp
 * @param currentTimestampUs The current timestamp in microseconds (used if frame index is null)
 * @param backward true for backward step, false for forward
 * @param filterFrameIds Optional filter - if provided, skips frames that don't match
 * @returns The new frame index and timestamp after stepping, or null if at the boundary
 */
export async function stepBufferFrame(
  sessionId: string,
  captureId: string,
  currentFrameIndex: number | null,
  currentTimestampUs: number | null,
  backward: boolean,
  filterFrameIds?: number[]
): Promise<StepResult | null> {
  return invoke("step_capture_frame", {
    session_id: sessionId,
    capture_id: captureId,
    current_frame_index: currentFrameIndex,
    current_timestamp_us: currentTimestampUs,
    backward,
    filter_frame_ids: filterFrameIds,
  });
}

/**
 * Payload sent when a session is suspended (stopped with buffer available).
 * Event name: session-suspended:{sessionId}
 */
export interface SessionSuspendedPayload {
  /** ID of the session's buffer */
  buffer_id: string | null;
  /** Number of items in the buffer */
  buffer_count: number;
  /** Buffer type: "frames" or "bytes" */
  buffer_type: "frames" | "bytes" | null;
  /** Time range of captured data [first_us, last_us] or null if empty */
  time_range: [number, number] | null;
}

/**
 * Payload emitted when a realtime session is stopped and switched to buffer replay.
 * All listeners on the session receive this event and should transition to buffer mode.
 * Event name: session-switched-to-buffer:{sessionId}
 */
export interface SessionSwitchedToBufferPayload {
  /** ID of the session's buffer */
  buffer_id: string | null;
  /** Number of items in the buffer */
  buffer_count: number;
  /** Buffer type: "frames" or "bytes" */
  buffer_type: "frames" | "bytes" | null;
  /** Time range of captured data [first_us, last_us] or null if empty */
  time_range: [number, number] | null;
  /** New capabilities after switching to BufferReader */
  capabilities: IOCapabilities;
}

/**
 * Payload sent when a session is resuming with a new buffer.
 * Apps should clear their frame lists when receiving this event.
 * Event name: session-resuming:{sessionId}
 */
export interface SessionResumingPayload {
  /** ID of the new buffer being created */
  new_buffer_id: string;
  /** ID of the old buffer that was orphaned (available for standalone viewing) */
  orphaned_buffer_id: string | null;
}

/**
 * Payload sent when a session's source is replaced in-place.
 * The session ID and all listeners are preserved.
 * Event name: session-source-replaced:{sessionId}
 */
export interface SourceReplacedPayload {
  /** Previous source type (e.g., "realtime", "capture") */
  previous_source_type: string;
  /** New source type */
  new_source_type: string;
  /** New capabilities after the swap */
  capabilities: IOCapabilities;
  /** New IO state after the swap */
  state: string;
  /** Context hint for the frontend ("buffer", "live", "reinitialize") */
  transition: string;
}

/**
 * Payload sent when a session's state changes.
 * Event name: session-state:{sessionId}
 */
export interface StateChangePayload {
  /** Previous state as a string (e.g., "stopped", "running", "error:message") */
  previous: string;
  /** Current state as a string */
  current: string;
  /** Active buffer ID if streaming to a buffer */
  buffer_id: string | null;
}

/**
 * Parse a state string from StateChangePayload into a IOStateType.
 */
export function parseStateString(stateStr: string): IOStateType {
  if (stateStr.startsWith("error:")) {
    return "error";
  }
  if (stateStr === "stopped" || stateStr === "starting" || stateStr === "running" || stateStr === "paused") {
    return stateStr;
  }
  return "stopped"; // fallback
}

/**
 * Transition an existing session to use a buffer for replay.
 * This is used after a streaming source (GVRET, PostgreSQL) ends to replay captured frames.
 * @param sessionId The session ID
 * @param speed Initial playback speed (default: 1.0)
 * @param captureId Optional buffer ID to register as session source
 */
export async function transitionToBufferReader(
  sessionId: string,
  captureId: string,
  speed?: number,
): Promise<IOCapabilities> {
  return invoke("transition_to_capture_source", { session_id: sessionId, capture_id: captureId, speed });
}

/**
 * Switch a session to buffer replay mode without destroying it.
 * This swaps the session's reader to a BufferReader that reads from the session's
 * owned buffer. All listeners stay connected and can replay the captured data.
 * Use this after ingest completes to enable playback controls.
 * @param sessionId The session ID
 * @param speed Initial playback speed (default: 1.0)
 */
export async function switchSessionToBufferReplay(
  sessionId: string,
  speed?: number
): Promise<IOCapabilities> {
  return invoke("switch_session_to_capture_replay", { session_id: sessionId, speed });
}

/**
 * Stop a realtime session and switch all listeners to capture replay.
 * Emits `session-lifecycle` signal so all apps on the session refresh state.
 * Falls back to normal suspend if no capture exists.
 * @param sessionId The session ID
 * @param speed Initial capture playback speed (default: 1.0)
 */
export async function stopAndSwitchToCapture(
  sessionId: string,
  speed?: number
): Promise<IOCapabilities> {
  return invoke("io_stop_and_switch_to_capture", { session_id: sessionId, speed });
}

/**
 * Resume a session from buffer playback back to live streaming.
 * This is the reverse of switchSessionToBufferReplay.
 * It recreates the original reader from the stored profile configuration,
 * orphans the current buffer (preserving data for later viewing), and starts
 * streaming into a fresh buffer.
 *
 * Only supported for realtime devices (gvret, slcan, gs_usb, socketcan).
 * Returns an error for recorded sources (postgres, csv, mqtt).
 *
 * @param sessionId The session ID
 */
export async function resumeSessionToLive(
  sessionId: string
): Promise<IOCapabilities> {
  return invoke("resume_session_to_live", { session_id: sessionId });
}

// ============================================================================
// Transmission Types and Functions
// ============================================================================

/**
 * CAN frame for transmission.
 */
export interface CanTransmitFrame {
  /** CAN frame ID (11-bit standard or 29-bit extended) */
  frame_id: number;
  /** Frame data (up to 8 bytes for classic CAN, up to 64 for CAN FD) */
  data: number[];
  /** Bus number (0 for single-bus adapters, 0-4 for multi-bus like GVRET) */
  bus?: number;
  /** Extended (29-bit) frame ID */
  is_extended?: boolean;
  /** CAN FD frame */
  is_fd?: boolean;
  /** Bit Rate Switch (CAN FD only) */
  is_brs?: boolean;
  /** Remote Transmission Request */
  is_rtr?: boolean;
}

/**
 * Result of a transmit operation.
 */
export interface TransmitResult {
  /** Whether the transmission was successful */
  success: boolean;
  /** Timestamp when the frame was sent (microseconds since UNIX epoch) */
  timestamp_us: number;
  /** Error message if transmission failed */
  error?: string;
}

/**
 * Transmit a CAN frame through a session.
 * The session must be running and support transmission (can_transmit capability).
 * @param sessionId The session ID
 * @param frame The CAN frame to transmit
 */
export async function sessionTransmitFrame(
  sessionId: string,
  frame: CanTransmitFrame
): Promise<TransmitResult> {
  return invoke("session_transmit_frame", { session_id: sessionId, frame });
}

// ============================================================================
// Listener Registration API
// ============================================================================

/**
 * Info about a registered listener.
 */
export interface SubscriberInfo {
  /** Unique instance ID for this listener (e.g., "discovery_1", "decoder_2") */
  subscriber_id: string;
  /** Human-readable app name (e.g., "discovery", "decoder") */
  app_name: string;
  /** Seconds since registration */
  registered_seconds_ago: number;
  /** Whether this listener is actively receiving frames */
  is_active: boolean;
}

/**
 * Result of registering a listener.
 */
export interface RegisterSubscriberResult {
  /** Session capabilities */
  capabilities: IOCapabilities;
  /** Current session state */
  state: IOState;
  /** Active capture ID (if any) */
  capture_id: string | null;
  /** Capture kind ("frames" or "bytes") */
  capture_kind: "frames" | "bytes" | null;
  /** Total number of listeners */
  subscriber_count: number;
  /** Error that occurred before this listener registered (one-shot, cleared after return) */
  startup_error: string | null;
}

/**
 * Register a listener for a session.
 * This is the primary way for frontend components to join a session.
 * If the listener is already registered, this updates their heartbeat.
 * @param sessionId The session ID
 * @param subscriberId A unique ID for this listener (e.g., "discovery", "decoder")
 * @returns Session info including whether this listener is the owner
 */
export async function registerSessionSubscriber(
  sessionId: string,
  subscriberId: string,
  appName?: string
): Promise<RegisterSubscriberResult> {
  return invoke("register_session_subscriber", {
    session_id: sessionId,
    subscriber_id: subscriberId,
    app_name: appName,
  });
}

/**
 * Unregister a listener from a session.
 * If this was the last listener, the session will be stopped (but not destroyed).
 * @param sessionId The session ID
 * @param subscriberId The listener ID to unregister
 * @returns The remaining listener count
 */
export async function unregisterSessionSubscriber(
  sessionId: string,
  subscriberId: string
): Promise<number> {
  console.log(`[unregisterSessionSubscriber] session=${sessionId}, listener=${subscriberId}`);
  console.log(`[unregisterSessionSubscriber] stack:`, new Error().stack);
  return invoke("unregister_session_subscriber", {
    session_id: sessionId,
    subscriber_id: subscriberId,
  });
}

/**
 * Evict a listener from a session, giving it a copy of the current buffer.
 * Used by the Session Manager to remove a listener without destroying the session.
 * @param sessionId The session ID
 * @param subscriberId The listener ID to evict
 * @returns List of copied buffer IDs given to the evicted listener
 */
export async function evictSessionSubscriber(
  sessionId: string,
  subscriberId: string
): Promise<string[]> {
  return invoke("evict_session_listener_cmd", {
    session_id: sessionId,
    subscriber_id: subscriberId,
  });
}

/**
 * Add a new IO source to an existing multi-source session.
 * Stops the current device, creates a new IOBroker with all sources (old + new),
 * and restarts. Keeps the same session ID and listeners.
 * @param sessionId The session ID to add the source to
 * @param source The source configuration to add
 * @returns Updated IOCapabilities for the session
 */
export async function addSourceToSession(
  sessionId: string,
  source: MultiSourceInput
): Promise<IOCapabilities> {
  // Convert TypeScript camelCase to Rust snake_case
  const rustSource = {
    profile_id: source.profileId,
    display_name: source.displayName,
    bus_mappings: source.busMappings.map((m) => ({
      device_bus: m.deviceBus,
      enabled: m.enabled,
      output_bus: m.outputBus,
      interface_id: m.interfaceId,
      traits: m.traits,
    })),
    framing_encoding: source.framingEncoding,
    delimiter: source.delimiter,
    max_frame_length: source.maxFrameLength,
    min_frame_length: source.minFrameLength,
    emit_raw_bytes: source.emitRawBytes,
    frame_id_start_byte: source.frameIdStartByte,
    frame_id_bytes: source.frameIdBytes,
    frame_id_big_endian: source.frameIdBigEndian,
    source_address_start_byte: source.sourceAddressStartByte,
    source_address_bytes: source.sourceAddressBytes,
    source_address_big_endian: source.sourceAddressBigEndian,
  };
  return invoke("add_source_to_session_cmd", {
    session_id: sessionId,
    source: rustSource,
  });
}

/**
 * Remove an IO source from an existing multi-source session.
 * Rebuilds with remaining sources (bus mappings preserved) and restarts.
 * Cannot remove the last source — destroy the session instead.
 * @param sessionId The session ID to remove the source from
 * @param profileId The profile ID of the source to remove
 * @returns Updated IOCapabilities for the session
 */
export async function removeSourceFromSession(
  sessionId: string,
  profileId: string
): Promise<IOCapabilities> {
  return invoke("remove_source_from_session_cmd", {
    session_id: sessionId,
    profile_id: profileId,
  });
}

/**
 * Update bus mappings for a source in a multi-source session.
 * Hot-swaps the source by removing and re-adding it with updated mappings.
 * If no mappings remain enabled, the source is removed entirely.
 * @param sessionId The session ID
 * @param profileId The profile ID of the source to update
 * @param busMappings The updated bus mappings
 * @returns Updated IOCapabilities for the session
 */
export async function updateSourceBusMappings(
  sessionId: string,
  profileId: string,
  busMappings: BusMapping[],
): Promise<IOCapabilities> {
  return invoke("update_source_bus_mappings_cmd", {
    session_id: sessionId,
    profile_id: profileId,
    bus_mappings: busMappings.map((m) => ({
      device_bus: m.deviceBus,
      enabled: m.enabled,
      output_bus: m.outputBus,
      interface_id: m.interfaceId,
      traits: m.traits,
    })),
  });
}

/**
 * Get all listeners for a session.
 * Useful for debugging and for the frontend to understand session state.
 * @param sessionId The session ID
 * @returns List of registered listeners
 */
export async function getSessionSubscribers(
  sessionId: string
): Promise<SubscriberInfo[]> {
  return invoke("get_session_listener_list", { session_id: sessionId });
}

/**
 * Result of attempting a safe reinitialize.
 */
export interface ReinitializeResult {
  /** Whether the reinitialize was successful */
  success: boolean;
  /** Reason for failure (if success is false) */
  reason?: string;
  /** List of other listeners preventing reinitialize (if any) */
  other_subscribers: string[];
}

/**
 * Check if it's safe to reinitialize a session and do so if safe.
 * Reinitialize is only safe if the requesting listener is the only listener.
 * This is an atomic check-and-act operation to prevent race conditions.
 *
 * If safe, the session will be destroyed so a new one can be created.
 * @param sessionId The session ID
 * @param subscriberId The requesting listener's ID
 * @returns Result indicating success or failure with reason
 */
export async function reinitializeSessionIfSafe(
  sessionId: string,
  subscriberId: string
): Promise<ReinitializeResult> {
  return invoke("reinitialize_session_if_safe_cmd", {
    session_id: sessionId,
    subscriber_id: subscriberId,
  });
}

/**
 * Set whether a listener is active (receiving frames).
 * When a listener detaches, set isActive to false to stop receiving frames.
 * When they rejoin, set isActive to true to resume receiving frames.
 * This is handled in Rust to avoid frontend race conditions.
 * @param sessionId The session ID
 * @param subscriberId The listener ID
 * @param isActive Whether the listener should receive frames
 */
export async function setSessionSubscriberActive(
  sessionId: string,
  subscriberId: string,
  isActive: boolean
): Promise<void> {
  return invoke("set_session_listener_active", {
    session_id: sessionId,
    subscriber_id: subscriberId,
    is_active: isActive,
  });
}

// ============================================================================
// GVRET Device Probing
// ============================================================================

/**
 * Information about a GVRET device, obtained by probing.
 */
export interface GvretDeviceInfo {
  /** Number of CAN buses available on this device (1-5) */
  bus_count: number;
}

/**
 * Configuration for mapping device buses to output buses.
 * Used to remap or disable specific buses when capturing.
 */
export interface BusMapping {
  /** Bus number as reported by the device (0-4) */
  deviceBus: number;
  /** Whether to capture frames from this bus */
  enabled: boolean;
  /** Bus number to use in emitted frames (0-255) */
  outputBus: number;
  /** Human-readable interface identifier (e.g., "can0", "serial1") */
  interfaceId?: string;
  /** Traits for this specific interface */
  traits?: InterfaceTraits;
}

/**
 * Probe a GVRET device to discover its capabilities.
 * This connects to the device, queries it, and returns device information.
 * The connection is closed after probing.
 * @param profileId The ID of the GVRET profile to probe
 * @returns Device information including bus count
 */
export async function probeGvretDevice(profileId: string): Promise<GvretDeviceInfo> {
  return invoke("probe_gvret_device", { profile_id: profileId });
}

/**
 * Result of probing any real-time device.
 * Provides a unified structure for all device types.
 */
export interface DeviceProbeResult {
  /** Whether the probe was successful (device is online and responding) */
  success: boolean;
  /** Source type (e.g., "gvret", "slcan", "gs_usb", "socketcan") */
  sourceType: string;
  /** Whether this is a multi-bus device (GVRET can have multiple CAN buses) */
  isMultiBus: boolean;
  /** Number of buses available (1 for single-bus devices, 1-5 for GVRET) */
  busCount: number;
  /** Primary info line (firmware version, device name, etc.) */
  primaryInfo: string | null;
  /** Secondary info line (hardware version, channel count, etc.) */
  secondaryInfo: string | null;
  /** Whether device supports CAN FD (gs_usb devices only, null for others) */
  supports_fd: boolean | null;
  /** Error message if probe failed */
  error: string | null;
}

/**
 * Probe any real-time device to check if it's online and healthy.
 *
 * This loads the profile from settings, connects to the device, queries it,
 * and returns device information. The connection is closed after probing.
 *
 * Supported device types:
 * - gvret_tcp, gvret_usb: Multi-bus GVRET devices
 * - slcan: Single-bus slcan/CANable devices
 * - gs_usb: Single-bus gs_usb/candleLight devices (Windows/macOS)
 * - socketcan: Single-bus SocketCAN interfaces (Linux)
 * - serial: Raw serial ports
 *
 * @param profileId The ID of the IO profile to probe
 * @returns Unified device probe result
 */
export async function probeDevice(profileId: string): Promise<DeviceProbeResult> {
  const raw = await invoke<{
    success: boolean;
    source_type: string;
    is_multi_bus: boolean;
    bus_count: number;
    primary_info: string | null;
    secondary_info: string | null;
    supports_fd: boolean | null;
    error: string | null;
  }>("probe_device", { profile_id: profileId });

  return {
    success: raw.success,
    sourceType: raw.source_type,
    isMultiBus: raw.is_multi_bus,
    busCount: raw.bus_count,
    primaryInfo: raw.primary_info,
    secondaryInfo: raw.secondary_info,
    supports_fd: raw.supports_fd,
    error: raw.error,
  };
}

/**
 * Create default bus mappings for a GVRET device.
 * All buses are enabled and map to sequential output numbers starting from offset.
 * @param busCount Number of buses on the device
 * @param outputBusOffset Starting output bus number (default 0)
 * @param protocol Protocol type for all interfaces (default "can")
 * @returns Array of default bus mappings
 */
export function createDefaultBusMappings(
  busCount: number,
  outputBusOffset: number = 0,
  protocol: Protocol = "can"
): BusMapping[] {
  return Array.from({ length: busCount }, (_, i) => ({
    deviceBus: i,
    enabled: true,
    outputBus: outputBusOffset + i,
    interfaceId: `${protocol}${i}`,
    traits: {
      temporal_mode: "realtime" as TemporalMode,
      protocols: protocol === "can" ? ["can", "canfd"] : [protocol],
      tx_frames: true,
      tx_bytes: false,
      multi_source: true,
    },
  }));
}

// ============================================================================
// Multi-Source Session API
// ============================================================================

/**
 * Configuration for a single source in a multi-source session.
 * Used when combining frames from multiple devices.
 */
export interface MultiSourceInput {
  /** Profile ID for this source */
  profileId: string;
  /** Display name for this source (optional, defaults to profile name) */
  displayName?: string;
  /** Bus mappings for this source (device bus -> output bus) */
  busMappings: BusMapping[];
  /** Framing encoding for serial sources (overrides profile settings) */
  framingEncoding?: string;
  /** Delimiter bytes for delimiter-based framing */
  delimiter?: number[];
  /** Maximum frame length for delimiter-based framing */
  maxFrameLength?: number;
  /** Minimum frame length - frames shorter than this are discarded */
  minFrameLength?: number;
  /** Whether to emit raw bytes in addition to framed data */
  emitRawBytes?: boolean;
  /** Frame ID extraction: start byte position (0-indexed) */
  frameIdStartByte?: number;
  /** Frame ID extraction: number of bytes (1 or 2) */
  frameIdBytes?: number;
  /** Frame ID extraction: byte order (true = big endian) */
  frameIdBigEndian?: boolean;
  /** Source address extraction: start byte position (0-indexed) */
  sourceAddressStartByte?: number;
  /** Source address extraction: number of bytes (1 or 2) */
  sourceAddressBytes?: number;
  /** Source address extraction: byte order (true = big endian) */
  sourceAddressBigEndian?: boolean;
  /** Modbus interface role (client or server) */
  modbusRole?: "client" | "server";
}

/**
 * Options for creating a multi-source IO session.
 */
export interface CreateMultiSourceSessionOptions {
  /** Unique session ID for the combined session */
  sessionId: string;
  /** Array of source configurations */
  sources: MultiSourceInput[];
  /** Listener instance ID for session logging (e.g., "discovery_1", "decoder_2") */
  subscriberId?: string;
  /** Human-readable app name (e.g., "discovery", "decoder") */
  appName?: string;
  /** Shared Modbus poll groups JSON (injected into all modbus_tcp sources) */
  modbusPollsJson?: string;
}

/**
 * Create a multi-source reader session that combines frames from multiple devices.
 *
 * This is used for multi-bus capture where frames from diverse sources (e.g., multiple
 * GVRET devices) are merged into a single stream. Each source can have its own bus
 * mappings to:
 * - Filter out disabled buses
 * - Remap device bus numbers to different output bus numbers
 *
 * The merged frames are sorted by timestamp and emitted as a single stream.
 *
 * @param options Session creation options including sources and their bus mappings
 * @returns The combined capabilities of all sources
 */
export async function createMultiSourceSession(
  options: CreateMultiSourceSessionOptions
): Promise<IOCapabilities> {
  // Convert TypeScript camelCase to Rust snake_case for the sources
  const rustSources = options.sources.map((source) => ({
    profile_id: source.profileId,
    display_name: source.displayName,
    bus_mappings: source.busMappings.map((m) => ({
      device_bus: m.deviceBus,
      enabled: m.enabled,
      output_bus: m.outputBus,
      interface_id: m.interfaceId,
      traits: m.traits,
    })),
    // Serial framing options (overrides profile settings)
    framing_encoding: source.framingEncoding,
    delimiter: source.delimiter,
    max_frame_length: source.maxFrameLength,
    emit_raw_bytes: source.emitRawBytes,
    // Frame ID extraction options (from catalog config)
    frame_id_start_byte: source.frameIdStartByte,
    frame_id_bytes: source.frameIdBytes,
    frame_id_big_endian: source.frameIdBigEndian,
    source_address_start_byte: source.sourceAddressStartByte,
    source_address_bytes: source.sourceAddressBytes,
    source_address_big_endian: source.sourceAddressBigEndian,
    modbus_role: source.modbusRole,
  }));

  return invoke("create_multi_source_session", {
    session_id: options.sessionId,
    sources: rustSources,
    subscriber_id: options.subscriberId,
    app_name: options.appName,
    modbus_polls: options.modbusPollsJson,
  });
}

/**
 * Info about an active session (from backend)
 */
export interface ActiveSessionInfo {
  /** Session ID */
  sessionId: string;
  /** Source type (e.g., "gvret_tcp", "realtime") */
  sourceType: string;
  /** Current state */
  state: IOStateType;
  /** Session capabilities */
  capabilities: IOCapabilities;
  /** Number of listeners */
  subscriberCount: number;
  /** Individual listener details */
  subscribers: SubscriberInfo[];
  /** For broker sessions: the source configurations */
  brokerConfigs: MultiSourceInput[] | null;
  /** Profile IDs feeding this session */
  sourceProfileIds: string[];
  /** Buffer ID owned by this session (if any) */
  captureId: string | null;
  /** Frame count in the owned buffer */
  captureFrameCount: number | null;
  /** Whether the session is actively streaming data */
  isStreaming: boolean;
}

/**
 * List all active sessions.
 * Useful for discovering shareable sessions like multi-source.
 */
export async function listActiveSessions(): Promise<ActiveSessionInfo[]> {
  const raw: Array<{
    session_id: string;
    source_type: string;
    state: IOState; // Rust sends { type: "Running" } etc, not simple string
    capabilities: IOCapabilities;
    subscriber_count: number;
    subscribers: Array<{
      subscriber_id: string;
      app_name: string;
      registered_seconds_ago: number;
      is_active: boolean;
    }>;
    broker_configs: Array<{
      profile_id: string;
      display_name: string;
      bus_mappings: Array<{
        device_bus: number;
        enabled: boolean;
        output_bus: number;
        interface_id?: string;
        traits?: InterfaceTraits;
      }>;
    }> | null;
    source_profile_ids: string[];
    capture_id: string | null;
    capture_frame_count: number | null;
    is_streaming: boolean;
  }> = await invoke("list_active_sessions");

  return raw.map((s) => ({
    sessionId: s.session_id,
    sourceType: s.source_type,
    state: getStateType(s.state), // Convert IOState to IOStateType
    capabilities: s.capabilities,
    subscriberCount: s.subscriber_count,
    subscribers: s.subscribers ?? [],
    brokerConfigs: s.broker_configs?.map((c) => ({
      profileId: c.profile_id,
      displayName: c.display_name,
      busMappings: c.bus_mappings.map((m) => ({
        deviceBus: m.device_bus,
        enabled: m.enabled,
        outputBus: m.output_bus,
        interfaceId: m.interface_id,
        traits: m.traits,
      })),
    })) ?? null,
    sourceProfileIds: s.source_profile_ids ?? [],
    captureId: s.capture_id ?? null,
    captureFrameCount: s.capture_frame_count ?? null,
    isStreaming: s.is_streaming ?? false,
  }));
}

// ============================================================================
// Profile-to-Session Mapping API
// ============================================================================

/**
 * Info about which sessions are using a profile.
 */
export interface ProfileUsageInfo {
  /** Profile ID */
  profileId: string;
  /** Session IDs using this profile */
  sessionIds: string[];
  /** Number of sessions using this profile */
  sessionCount: number;
  /** Whether reconfiguration is locked (2+ sessions) */
  configLocked: boolean;
}

/**
 * Get all session IDs that are using a specific profile.
 * Used to show "(in use: sessionId)" indicator in the IO picker.
 */
export async function getProfileSessions(profileId: string): Promise<string[]> {
  return invoke("get_profile_sessions", { profile_id: profileId });
}

/**
 * Get the count of sessions using a specific profile.
 * Used to determine if reconfiguration should be locked (locked if >= 2).
 */
export async function getProfileSessionCount(profileId: string): Promise<number> {
  return invoke("get_profile_session_count", { profile_id: profileId });
}

/**
 * Get usage info for multiple profiles at once.
 * More efficient than calling getProfileSessions for each profile.
 */
export async function getProfilesUsage(
  profileIds: string[]
): Promise<ProfileUsageInfo[]> {
  const raw: Array<{
    profile_id: string;
    session_ids: string[];
    session_count: number;
    config_locked: boolean;
  }> = await invoke("get_profiles_usage", { profile_ids: profileIds });

  return raw.map((p) => ({
    profileId: p.profile_id,
    sessionIds: p.session_ids,
    sessionCount: p.session_count,
    configLocked: p.config_locked,
  }));
}

// ============================================================================
// WebView Recovery
// ============================================================================

/** Check if a WebView recovery just occurred (one-shot: cleared after reading). */
export async function checkRecoveryOccurred(): Promise<boolean> {
  return invoke("check_recovery_occurred");
}

// ============================================================================
// Modbus Scanning
// ============================================================================

/** Register type for Modbus scanning. */
export type ModbusRegisterType = 'holding' | 'input' | 'coil' | 'discrete';

/** Configuration for register range scanning. */
export interface ModbusScanConfig {
  host: string;
  port: number;
  unit_id: number;
  register_type: ModbusRegisterType;
  start_register: number;
  end_register: number;
  chunk_size: number;
  inter_request_delay_ms: number;
}

/** Configuration for unit ID scanning. */
export interface UnitIdScanConfig {
  host: string;
  port: number;
  start_unit_id: number;
  end_unit_id: number;
  test_register: number;
  register_type: ModbusRegisterType;
  inter_request_delay_ms: number;
}

/** Progress update emitted during scanning. */
export interface ScanProgressPayload {
  current: number;
  total: number;
  found_count: number;
}

/** Completion summary returned when scan finishes. */
export interface ScanCompletePayload {
  found_count: number;
  total_scanned: number;
  duration_ms: number;
}

/** Scan a range of Modbus registers to discover which ones exist. */
export async function startModbusScan(
  config: ModbusScanConfig,
  sessionId?: string
): Promise<ScanCompletePayload> {
  return invoke("modbus_scan_registers", { config, session_id: sessionId ?? null });
}

/** Scan for active Modbus unit IDs on the network. */
export async function startModbusUnitIdScan(
  config: UnitIdScanConfig,
  sessionId?: string
): Promise<ScanCompletePayload> {
  return invoke("modbus_scan_unit_ids", { config, session_id: sessionId ?? null });
}

/** Cancel a running Modbus scan operation. */
export async function cancelModbusScan(): Promise<void> {
  return invoke("cancel_modbus_scan");
}

// ============================================================================
// Signal-then-fetch query API
// ============================================================================

/** Fetch current playback position for a recorded/buffer session. */
export async function getPlaybackPosition(
  sessionId: string
): Promise<PlaybackPosition | null> {
  return invoke("get_playback_position_cmd", { session_id: sessionId });
}


/** Fetch stream-ended info (survives session destruction via TTL cache). */
export async function getStreamEndedInfo(
  sessionId: string
): Promise<StreamEndedInfo | null> {
  return invoke("get_stream_ended_info", { session_id: sessionId });
}

export interface StreamEndedInfo {
  reason: string;
  capture_available: boolean;
  capture_id: string | null;
  capture_kind: string | null;
  count: number;
  time_range: [number, number] | null;
}

/** Fetch the last session error (from post-session cache or startup errors). */
export async function getSessionError(
  sessionId: string
): Promise<string | null> {
  return invoke("get_session_error", { session_id: sessionId });
}

/** Fetch connected sources for a session. */
export async function getSessionSources(
  sessionId: string
): Promise<SourceInfo[]> {
  return invoke("get_session_sources", { session_id: sessionId });
}

export interface SourceInfo {
  source_type: string;
  address: string;
  bus: number | null;
}

/** Fetch orphaned buffer IDs from post-session cache. */
export async function getOrphanedBufferIds(
  sessionId: string
): Promise<string[]> {
  return invoke("get_orphaned_capture_ids", { session_id: sessionId });
}

/** Fetch current replay state. */
export async function getReplayState(
  replayId: string
): Promise<ReplayState | null> {
  return invoke("get_replay_state", { replay_id: replayId });
}

export interface ReplayState {
  status: string;
  replay_id: string;
  frames_sent: number;
  total_frames: number;
  speed: number;
  loop_replay: boolean;
  pass: number;
}

/** Fetch current modbus scan state. */
export async function getModbusScanState(
  sessionId: string
): Promise<ModbusScanState | null> {
  return invoke("get_modbus_scan_state_cmd", { session_id: sessionId });
}

export interface DeviceInfoEntry {
  unit_id: number;
  vendor: string | null;
  product_code: string | null;
  revision: string | null;
}

export interface ModbusScanState {
  status: string;
  frames: FrameMessage[];
  progress: ScanProgressPayload | null;
  device_info: DeviceInfoEntry[];
}

/** Fetch the most recent bytes from a buffer (tail view). */
export async function getCaptureBytesTail(
  captureId: string,
  tailSize: number
): Promise<BytesTailResponse> {
  return invoke("get_capture_bytes_tail", {
    capture_id: captureId,
    tail_size: tailSize,
  });
}

export interface BytesTailResponse {
  bytes: RawByteEntry[];
  total_count: number;
}
