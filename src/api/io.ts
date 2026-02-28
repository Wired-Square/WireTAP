// ui/src/api/io.ts
//
// API wrappers for the session-based IO system.
// Provides a unified interface for reading and writing CAN data.

import { invoke } from "@tauri-apps/api/core";

// ============================================================================
// Interface Traits
// ============================================================================

/**
 * Temporal mode of an interface/session.
 * - "realtime": Live streaming from hardware (GVRET, slcan, gs_usb, SocketCAN, MQTT)
 * - "timeline": Recorded playback (PostgreSQL, CSV, Buffer)
 */
export type TemporalMode = "realtime" | "timeline";

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
  /** Whether the interface can transmit frames */
  can_transmit: boolean;
}

/**
 * Declares the data streams a session produces.
 * Used by the frontend to decide which event listeners and views to set up.
 */
export interface SessionDataStreams {
  /** Whether this session emits framed messages (frame-message events) */
  emits_frames: boolean;
  /** Whether this session emits raw byte streams (serial-raw-bytes events) */
  emits_bytes: boolean;
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

/**
 * Get traits from IOCapabilities, deriving from legacy fields if not present.
 */
export function getTraits(caps: IOCapabilities): InterfaceTraits {
  if (caps.traits) {
    return caps.traits;
  }
  // Derive from legacy fields
  const protocols: Protocol[] = caps.can_transmit_serial
    ? ["serial"]
    : caps.supports_canfd
      ? ["can", "canfd"]
      : ["can"];

  return {
    temporal_mode: caps.is_realtime ? "realtime" : "timeline",
    protocols,
    can_transmit: caps.can_transmit || caps.can_transmit_serial,
  };
}

/**
 * Get data streams from IOCapabilities, deriving from legacy fields if not present.
 */
export function getDataStreams(caps: IOCapabilities): SessionDataStreams {
  if (caps.data_streams) {
    return caps.data_streams;
  }
  // Derive from legacy fields
  return {
    emits_frames: !caps.emits_raw_bytes || (caps.traits?.protocols ?? []).some((p) => p !== "serial"),
    emits_bytes: caps.emits_raw_bytes ?? false,
  };
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
  /** Is realtime data (GVRET: true, PostgreSQL: false) */
  is_realtime: boolean;
  /** Supports speed control (PostgreSQL: true, GVRET: false) */
  supports_speed_control: boolean;
  /** Supports seeking to a specific timestamp (BufferReader: true, others: false) */
  supports_seek: boolean;
  /** Supports reverse playback (BufferReader: true, others: false) */
  supports_reverse?: boolean;
  /** Can transmit CAN frames (slcan in normal mode, GVRET: true) */
  can_transmit: boolean;
  /** Can transmit serial bytes (serial port devices) */
  can_transmit_serial: boolean;
  /** Supports CAN FD (64 bytes, BRS) */
  supports_canfd: boolean;
  /** Supports extended (29-bit) CAN IDs */
  supports_extended_id: boolean;
  /** Supports Remote Transmission Request frames */
  supports_rtr: boolean;
  /** Available bus numbers (empty = single bus) */
  available_buses: number[];
  /** Emits raw bytes (serial sessions without framing or with emit_raw_bytes=true) */
  emits_raw_bytes?: boolean;
  /** Formal interface traits (temporal mode, protocols, transmit) */
  traits?: InterfaceTraits;
  /** Declares which data streams this session produces */
  data_streams?: SessionDataStreams;
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
  /** File path for file-based readers (e.g., csv_file) */
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
  listenerId?: string;
  /** Human-readable app name (e.g., "discovery", "decoder") */
  appName?: string;
  /** Buffer ID for buffer reader sessions (e.g., "buf_1") */
  bufferId?: string;
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
    return invoke("create_buffer_reader_session", {
      session_id: options.sessionId,
      buffer_id: options.bufferId,
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
    listener_id: options.listenerId,
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
  buffer_id: string | null;
  /** Type of the active buffer ("frames" or "bytes"), if any */
  buffer_type: "frames" | "bytes" | null;
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

// Legacy heartbeat functions removed - use registerSessionListener/unregisterSessionListener instead

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
  bufferId: string,
  newName: string
): Promise<string> {
  return invoke("copy_buffer_for_detach", { buffer_id: bufferId, new_name: newName });
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
  /** Total frame count in buffer (optional, for timeline sources) */
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
  currentFrameIndex: number | null,
  currentTimestampUs: number | null,
  backward: boolean,
  filterFrameIds?: number[]
): Promise<StepResult | null> {
  return invoke("step_buffer_frame", {
    session_id: sessionId,
    current_frame_index: currentFrameIndex,
    current_timestamp_us: currentTimestampUs,
    backward,
    filter_frame_ids: filterFrameIds,
  });
}

/**
 * Payload sent when a stream ends (GVRET disconnect, PostgreSQL query complete, etc.)
 */
export interface StreamEndedPayload {
  /** Reason for stream ending: "complete", "disconnected", "error", "stopped" */
  reason: string;
  /** Whether the buffer has data available for replay */
  buffer_available: boolean;
  /** ID of the buffer that was created (if any) */
  buffer_id: string | null;
  /** Type of buffer: "frames" or "bytes" */
  buffer_type: "frames" | "bytes" | null;
  /** Number of items in the buffer (frames or bytes depending on type) */
  count: number;
  /** Time range of captured data [first_us, last_us] or null if empty */
  time_range: [number, number] | null;
  /** Session ID that owns this buffer (for detecting ingest/cross-app buffers) */
  owning_session_id: string;
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
 * @param bufferId Optional buffer ID to register as session source
 */
export async function transitionToBufferReader(
  sessionId: string,
  speed?: number,
  bufferId?: string
): Promise<IOCapabilities> {
  return invoke("transition_to_buffer_reader", { session_id: sessionId, buffer_id: bufferId, speed });
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
  return invoke("switch_session_to_buffer_replay", { session_id: sessionId, speed });
}

/**
 * Resume a session from buffer playback back to live streaming.
 * This is the reverse of switchSessionToBufferReplay.
 * It recreates the original reader from the stored profile configuration,
 * orphans the current buffer (preserving data for later viewing), and starts
 * streaming into a fresh buffer.
 *
 * Only supported for realtime devices (gvret, slcan, gs_usb, socketcan).
 * Returns an error for timeline sources (postgres, csv, mqtt).
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
export interface ListenerInfo {
  /** Unique instance ID for this listener (e.g., "discovery_1", "decoder_2") */
  listener_id: string;
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
export interface RegisterListenerResult {
  /** Session capabilities */
  capabilities: IOCapabilities;
  /** Current session state */
  state: IOState;
  /** Active buffer ID (if any) */
  buffer_id: string | null;
  /** Buffer type ("frames" or "bytes") */
  buffer_type: "frames" | "bytes" | null;
  /** Total number of listeners */
  listener_count: number;
  /** Error that occurred before this listener registered (one-shot, cleared after return) */
  startup_error: string | null;
}

/**
 * Register a listener for a session.
 * This is the primary way for frontend components to join a session.
 * If the listener is already registered, this updates their heartbeat.
 * @param sessionId The session ID
 * @param listenerId A unique ID for this listener (e.g., "discovery", "decoder")
 * @returns Session info including whether this listener is the owner
 */
export async function registerSessionListener(
  sessionId: string,
  listenerId: string,
  appName?: string
): Promise<RegisterListenerResult> {
  return invoke("register_session_listener", {
    session_id: sessionId,
    listener_id: listenerId,
    app_name: appName,
  });
}

/**
 * Unregister a listener from a session.
 * If this was the last listener, the session will be stopped (but not destroyed).
 * @param sessionId The session ID
 * @param listenerId The listener ID to unregister
 * @returns The remaining listener count
 */
export async function unregisterSessionListener(
  sessionId: string,
  listenerId: string
): Promise<number> {
  console.log(`[unregisterSessionListener] session=${sessionId}, listener=${listenerId}`);
  console.log(`[unregisterSessionListener] stack:`, new Error().stack);
  return invoke("unregister_session_listener", {
    session_id: sessionId,
    listener_id: listenerId,
  });
}

/**
 * Evict a listener from a session, giving it a copy of the current buffer.
 * Used by the Session Manager to remove a listener without destroying the session.
 * @param sessionId The session ID
 * @param listenerId The listener ID to evict
 * @returns List of copied buffer IDs given to the evicted listener
 */
export async function evictSessionListener(
  sessionId: string,
  listenerId: string
): Promise<string[]> {
  return invoke("evict_session_listener_cmd", {
    session_id: sessionId,
    listener_id: listenerId,
  });
}

/**
 * Add a new IO source to an existing multi-source session.
 * Stops the current device, creates a new MultiSourceReader with all sources (old + new),
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
 * Get all listeners for a session.
 * Useful for debugging and for the frontend to understand session state.
 * @param sessionId The session ID
 * @returns List of registered listeners
 */
export async function getSessionListeners(
  sessionId: string
): Promise<ListenerInfo[]> {
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
  other_listeners: string[];
}

/**
 * Check if it's safe to reinitialize a session and do so if safe.
 * Reinitialize is only safe if the requesting listener is the only listener.
 * This is an atomic check-and-act operation to prevent race conditions.
 *
 * If safe, the session will be destroyed so a new one can be created.
 * @param sessionId The session ID
 * @param listenerId The requesting listener's ID
 * @returns Result indicating success or failure with reason
 */
export async function reinitializeSessionIfSafe(
  sessionId: string,
  listenerId: string
): Promise<ReinitializeResult> {
  return invoke("reinitialize_session_if_safe_cmd", {
    session_id: sessionId,
    listener_id: listenerId,
  });
}

/**
 * Set whether a listener is active (receiving frames).
 * When a listener detaches, set isActive to false to stop receiving frames.
 * When they rejoin, set isActive to true to resume receiving frames.
 * This is handled in Rust to avoid frontend race conditions.
 * @param sessionId The session ID
 * @param listenerId The listener ID
 * @param isActive Whether the listener should receive frames
 */
export async function setSessionListenerActive(
  sessionId: string,
  listenerId: string,
  isActive: boolean
): Promise<void> {
  console.log(`[setSessionListenerActive] session=${sessionId}, listener=${listenerId}, isActive=${isActive}`);
  console.log(`[setSessionListenerActive] stack:`, new Error().stack);
  return invoke("set_session_listener_active", {
    session_id: sessionId,
    listener_id: listenerId,
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
  /** Device type (e.g., "gvret", "slcan", "gs_usb", "socketcan") */
  deviceType: string;
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
    device_type: string;
    is_multi_bus: boolean;
    bus_count: number;
    primary_info: string | null;
    secondary_info: string | null;
    supports_fd: boolean | null;
    error: string | null;
  }>("probe_device", { profile_id: profileId });

  return {
    success: raw.success,
    deviceType: raw.device_type,
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
      can_transmit: true,
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
  listenerId?: string;
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
    listener_id: options.listenerId,
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
  /** Device type (e.g., "gvret_tcp", "multi_source") */
  deviceType: string;
  /** Current state */
  state: IOStateType;
  /** Session capabilities */
  capabilities: IOCapabilities;
  /** Number of listeners */
  listenerCount: number;
  /** Individual listener details */
  listeners: ListenerInfo[];
  /** For multi-source sessions: the source configurations */
  multiSourceConfigs: MultiSourceInput[] | null;
  /** Profile IDs feeding this session */
  sourceProfileIds: string[];
  /** Buffer ID owned by this session (if any) */
  bufferId: string | null;
  /** Frame count in the owned buffer */
  bufferFrameCount: number | null;
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
    device_type: string;
    state: IOState; // Rust sends { type: "Running" } etc, not simple string
    capabilities: IOCapabilities;
    listener_count: number;
    listeners: Array<{
      listener_id: string;
      app_name: string;
      registered_seconds_ago: number;
      is_active: boolean;
    }>;
    multi_source_configs: Array<{
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
    buffer_id: string | null;
    buffer_frame_count: number | null;
    is_streaming: boolean;
  }> = await invoke("list_active_sessions");

  return raw.map((s) => ({
    sessionId: s.session_id,
    deviceType: s.device_type,
    state: getStateType(s.state), // Convert IOState to IOStateType
    capabilities: s.capabilities,
    listenerCount: s.listener_count,
    listeners: s.listeners ?? [],
    multiSourceConfigs: s.multi_source_configs?.map((c) => ({
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
    bufferId: s.buffer_id ?? null,
    bufferFrameCount: s.buffer_frame_count ?? null,
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
export async function startModbusScan(config: ModbusScanConfig): Promise<ScanCompletePayload> {
  return invoke("modbus_scan_registers", { config });
}

/** Scan for active Modbus unit IDs on the network. */
export async function startModbusUnitIdScan(config: UnitIdScanConfig): Promise<ScanCompletePayload> {
  return invoke("modbus_scan_unit_ids", { config });
}

/** Cancel a running Modbus scan operation. */
export async function cancelModbusScan(): Promise<void> {
  return invoke("cancel_modbus_scan");
}
