// ui/src/api/io.ts
//
// API wrappers for the session-based IO system.
// Provides a unified interface for reading and writing CAN data.

import { invoke } from "@tauri-apps/api/core";
import type { ProtocolFrames } from "../utils/frameKey";
import type { ModbusPollGroup } from "./catalog";
import type { SerialFrameConfig } from "../utils/frameExport";
import type { ModbusFramingSettings } from "../components/FramingOptionsPanel";

import type { ActiveSessionInfo } from "../generated/ActiveSessionInfo";
import type { AppInstanceInfo } from "../generated/AppInstanceInfo";
import type { BusMapping } from "../generated/BusMapping";
import type { BytesTailResponse } from "../generated/BytesTailResponse";
import type { CanTransmitFrame } from "../generated/CanTransmitFrame";
import type { DeviceInfoPayload } from "../generated/DeviceInfoPayload";
import type { DeviceProbeResult } from "../generated/DeviceProbeResult";
import type { FcProbeConfig } from "../generated/FcProbeConfig";
import type { FcProbeEntry } from "../generated/FcProbeEntry";
import type { FcVerdict } from "../generated/FcVerdict";
import type { GvretDeviceInfo } from "../generated/GvretDeviceInfo";
import type { InterfaceTraits } from "../generated/InterfaceTraits";
import type { IOCapabilities } from "../generated/IOCapabilities";
import type { IOState } from "../generated/IOState";
import type { ModbusRange } from "../generated/ModbusRange";
import type { ModbusRangeSpec } from "../generated/ModbusRangeSpec";
import type { ModbusRegisterType } from "../generated/ModbusRegisterType";
import type { ModbusScanConfig } from "../generated/ModbusScanConfig";
import type { MultiSourceInput } from "../generated/MultiSourceInput";
import type { PlaybackPosition } from "../generated/PlaybackPosition";
import type { ProfileUsageInfo } from "../generated/ProfileUsageInfo";
import type { Protocol } from "../generated/Protocol";
import type { RegisterSubscriberResult } from "../generated/RegisterSubscriberResult";
import type { ReinitializeResult } from "../generated/ReinitializeResult";
import type { ScanCompletePayload } from "../generated/ScanCompletePayload";
import type { ScanJob } from "../generated/ScanJob";
import type { ScanProgressPayload } from "../generated/ScanProgressPayload";
import type { SerialOverrides } from "../generated/SerialOverrides";
import type { SourceInfo } from "../generated/SourceInfo";
import type { StepResult } from "../generated/StepResult";
import type { StreamEndedInfo } from "../generated/StreamEndedInfo";
import type { SubscriberInfo } from "../generated/SubscriberInfo";
import type { TemporalMode } from "../generated/TemporalMode";
import type { TransmitResult } from "../generated/TransmitResult";
import type { UnitIdScanConfig } from "../generated/UnitIdScanConfig";
import type { VirtualBusState } from "../generated/VirtualBusState";

export type {
  ActiveSessionInfo,
  AppInstanceInfo,
  BusMapping,
  BytesTailResponse,
  CanTransmitFrame,
  DeviceInfoPayload,
  DeviceProbeResult,
  FcProbeConfig,
  FcProbeEntry,
  FcVerdict,
  GvretDeviceInfo,
  InterfaceTraits,
  IOCapabilities,
  IOState,
  ModbusRange,
  ModbusRangeSpec,
  ModbusRegisterType,
  ModbusScanConfig,
  MultiSourceInput,
  PlaybackPosition,
  ProfileUsageInfo,
  Protocol,
  RegisterSubscriberResult,
  ReinitializeResult,
  ScanCompletePayload,
  ScanJob,
  ScanProgressPayload,
  SourceInfo,
  StepResult,
  StreamEndedInfo,
  SubscriberInfo,
  TemporalMode,
  TransmitResult,
  UnitIdScanConfig,
  VirtualBusState,
};

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
 * Serial framing chosen for one device in the source picker, for one session.
 *
 * Declared here rather than in the picker because the store has to carry it to
 * `MultiSourceInput`, and it was previously declared twice with different fields
 * — the picker's copy had `emitRawBytes`, `maxFrameLength` and `validateCrc`,
 * the store's had only `encoding` and `delimiterHex`. Everything the store's
 * copy lacked was silently dropped on the way to Rust, so the "Capture raw
 * bytes" and "Validate CRC" ticks did nothing at all.
 */
export interface InterfaceFramingConfig extends ModbusFramingSettings {
  /** Framing mode */
  encoding: FramingEncoding;
  /** Delimiter hex string for delimiter mode (e.g., "0D0A" for CRLF) */
  delimiterHex?: string;
  /** Max frame length for delimiter mode */
  maxFrameLength?: number;
  /** Also emit raw bytes alongside frames */
  emitRawBytes?: boolean;
}

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
  /** Use the shared capture source instead of a profile-based reader */
  useCapture?: boolean;

  // Serial framing configuration
  /** Framing encoding for serial readers: "slip", "modbus_rtu", "delimiter", or "raw" */
  framingEncoding?: FramingEncoding;
  /** Delimiter byte sequence for delimiter-based framing (e.g., [0x0D, 0x0A] for CRLF) */
  delimiter?: number[];
  /** Maximum frame length for delimiter-based framing (default: 256) */
  maxFrameLength?: number;
  /** Modbus RTU framing settings, when framingEncoding is "modbus_rtu" */
  modbusValidateCrc?: boolean;
  modbusDeviceAddress?: number;
  modbusVendorFunctions?: number[];
  modbusAllowBroadcast?: boolean;
  modbusAnyFunction?: boolean;

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
  /** Capture ID for capture source sessions (e.g., "xk9m2p") */
  captureId?: string;
  /** Modbus TCP poll groups as JSON string (catalog-derived, for modbus_tcp profiles) */
  modbusPollsJson?: string;
}

/** The serial settings an options object carries, camelCase on the way to Rust's `SerialOverrides`. */
interface SerialSettings {
  framingEncoding?: string;
  delimiter?: number[];
  maxFrameLength?: number;
  minFrameLength?: number;
  emitRawBytes?: boolean;
  modbusValidateCrc?: boolean;
  modbusDeviceAddress?: number;
  modbusVendorFunctions?: number[];
  modbusAllowBroadcast?: boolean;
  modbusAnyFunction?: boolean;
  frameIdStartByte?: number;
  frameIdBytes?: number;
  frameIdBigEndian?: boolean;
  sourceAddressStartByte?: number;
  sourceAddressBytes?: number;
  sourceAddressBigEndian?: boolean;
}

/**
 * Rust's `SerialOverrides`, from any of the option objects that carry these
 * fields. Written once because the send sites had already drifted — one was
 * omitting `min_frame_length` — and a silently dropped serial setting is the
 * bug this whole area exists to stop.
 */
export function serialPayload(source: SerialSettings): SerialOverrides {
  return {
    framing_encoding: source.framingEncoding,
    delimiter: source.delimiter,
    max_frame_length: source.maxFrameLength,
    min_frame_length: source.minFrameLength,
    emit_raw_bytes: source.emitRawBytes,
    modbus_validate_crc: source.modbusValidateCrc,
    modbus_device_address: source.modbusDeviceAddress,
    modbus_vendor_functions: source.modbusVendorFunctions,
    modbus_allow_broadcast: source.modbusAllowBroadcast,
    modbus_any_function: source.modbusAnyFunction,
    frame_id_start_byte: source.frameIdStartByte,
    frame_id_bytes: source.frameIdBytes,
    frame_id_big_endian: source.frameIdBigEndian,
    source_address_start_byte: source.sourceAddressStartByte,
    source_address_bytes: source.sourceAddressBytes,
    source_address_big_endian: source.sourceAddressBigEndian,
  };
}

/**
 * Create a new IO session.
 * Returns the capabilities of the created IO device.
 */
export async function createIOSession(
  options: CreateIOSessionOptions
): Promise<IOCapabilities> {
  // Use capture source if requested
  if (options.useCapture) {
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
    // Bus override for single-bus devices
    bus_override: options.busOverride,
    // Listener ID for session logging
    subscriber_id: options.subscriberId,
    // Human-readable app name
    app_name: options.appName,
    // Modbus TCP poll groups (catalog-derived)
    modbus_polls: options.modbusPollsJson,
    // Serial settings chosen for this session, overriding the device profile.
    // One object rather than loose keys: as loose keys they were dropped
    // silently for months when the Rust side stopped declaring them.
    serial: serialPayload(options),
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
 * Change serial framing on a running session in place (no device reconnect).
 * The backend swaps the source's framer and re-broadcasts capabilities (rx_frames
 * flips when a Raw byte stream starts being framed). Returns the new capabilities.
 */
export async function setFraming(
  sessionId: string,
  serial: SerialFrameConfig,
): Promise<IOCapabilities> {
  return invoke("io_set_framing", {
    session_id: sessionId,
    encoding: serial.encoding ?? "raw",
    frame_id_start_byte: serial.frame_id_start_byte,
    frame_id_bytes: serial.frame_id_bytes,
    frame_id_big_endian: serial.frame_id_byte_order !== "little",
    source_address_start_byte: serial.source_address_start_byte,
    source_address_bytes: serial.source_address_bytes,
    source_address_big_endian: serial.source_address_byte_order !== "little",
    min_frame_length: serial.min_frame_length,
  });
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
 * Only works for readers that support pause (e.g., a WireTAP backend).
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
 * Suspend a reader session - stops streaming, finalises capture, session stays alive.
 * The capture remains owned by the session and all joined apps can view it.
 * Use `resumeReaderSessionFresh` to start streaming again with a new capture.
 * Returns the confirmed state after the operation.
 */
export async function suspendReaderSession(sessionId: string): Promise<IOState> {
  return invoke("suspend_reader_session", { session_id: sessionId });
}

/**
 * Resume a suspended session with a fresh capture.
 * The old capture is orphaned (becomes available for standalone viewing).
 * A new capture is created for the session and streaming starts.
 * Returns the confirmed state after the operation.
 */
export async function resumeReaderSessionFresh(sessionId: string): Promise<IOState> {
  return invoke("resume_reader_session_fresh", { session_id: sessionId });
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
 * Only works for readers that support speed control (e.g., a WireTAP backend).
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
 * This stops the current stream, orphans the old capture, creates a new capture,
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
export async function destroyReaderSession(sessionId: string, reset = false): Promise<void> {
  return invoke("destroy_reader_session", { session_id: sessionId, reset });
}

/**
 * Seek a reader session to a specific timestamp.
 * Only works for readers that support seeking (e.g., CaptureSource).
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
 * Preferred over timestamp-based seeking for capture playback as it avoids floating-point issues.
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
 * Only works for readers that support reverse playback (e.g., CaptureSource).
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
 * Step one frame forward or backward in the capture.
 * Only works for capture sources when paused.
 * @param sessionId The session ID
 * @param currentFrameIndex The current frame index (0-based), or null to use timestamp
 * @param currentTimestampUs The current timestamp in microseconds (used if frame index is null)
 * @param backward true for backward step, false for forward
 * @param filterSelection Optional filter - if provided, skips frames it does not name
 * @returns The new frame index and timestamp after stepping, or null if at the boundary
 */
export async function stepCaptureFrame(
  sessionId: string,
  captureId: string,
  currentFrameIndex: number | null,
  currentTimestampUs: number | null,
  backward: boolean,
  filterSelection?: ProtocolFrames[]
): Promise<StepResult | null> {
  return invoke("step_capture_frame", {
    session_id: sessionId,
    capture_id: captureId,
    current_frame_index: currentFrameIndex,
    current_timestamp_us: currentTimestampUs,
    backward,
    filter_selection: filterSelection,
  });
}

/**
 * Payload sent when a session is suspended (stopped with capture available).
 */
export interface SessionSuspendedPayload {
  /** ID of the session's capture */
  capture_id: string | null;
  /** Number of items in the capture */
  capture_count: number;
  /** Capture kind: "frames" or "bytes" */
  capture_kind: "frames" | "bytes" | null;
  /** Time range of captured data [first_us, last_us] or null if empty */
  time_range: [number, number] | null;
}

/**
 * Payload emitted when a realtime session is stopped and switched to capture replay.
 * All subscribers on the session receive this event and should transition to capture mode.
 */
export interface SessionSwitchedToCapturePayload {
  /** ID of the session's capture */
  capture_id: string | null;
  /** Number of items in the capture */
  capture_count: number;
  /** Capture kind: "frames" or "bytes" */
  capture_kind: "frames" | "bytes" | null;
  /** Time range of captured data [first_us, last_us] or null if empty */
  time_range: [number, number] | null;
  /** New capabilities after switching to CaptureSource */
  capabilities: IOCapabilities;
}

/**
 * Payload sent when a session is resuming with a new capture.
 * Apps should clear their frame lists when receiving this event.
 */
export interface SessionResumingPayload {
  /** ID of the new capture being created */
  new_capture_id: string;
  /** ID of the old capture that was orphaned (available for standalone viewing) */
  orphaned_capture_id: string | null;
}

/**
 * Payload sent when a session's source is replaced in-place.
 * The session ID and all subscribers are preserved.
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
  /** Context hint for the frontend ("capture", "live", "reinitialize") */
  transition: string;
}

/**
 * Transition an existing session to use a capture for replay.
 * This is used after a streaming source (GVRET, the WireTAP backend) ends to replay captured frames.
 * @param sessionId The session ID
 * @param captureId The capture ID to register as session source
 * @param speed Initial playback speed (default: 1.0)
 */
export async function transitionToCaptureSource(
  sessionId: string,
  captureId: string,
  speed?: number,
): Promise<IOCapabilities> {
  return invoke("transition_to_capture_source", { session_id: sessionId, capture_id: captureId, speed });
}

/**
 * Switch a session to capture replay mode without destroying it.
 * This swaps the session's source to a CaptureSource that reads from the session's
 * owned capture. All subscribers stay connected and can replay the captured data.
 * Use this after ingest completes to enable playback controls.
 * @param sessionId The session ID
 * @param speed Initial playback speed (default: 1.0)
 */
export async function switchSessionToCaptureReplay(
  sessionId: string,
  speed?: number
): Promise<IOCapabilities> {
  return invoke("switch_session_to_capture_replay", { session_id: sessionId, speed });
}

/**
 * Stop a realtime session and switch all subscribers to capture replay.
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
 * Stop a session and switch it to capture replay. Rust picks the path from the
 * source's temporal mode (realtime → stop-and-switch w/ suspend fallback;
 * recorded → suspend + switch), so callers don't branch.
 */
export async function sessionStopToCapture(sessionId: string): Promise<void> {
  return invoke("session_stop_to_capture", { session_id: sessionId });
}

/**
 * Resume a session from capture playback back to live streaming.
 * This is the reverse of switchSessionToCaptureReplay.
 * It recreates the original reader from the stored profile configuration,
 * orphans the current capture (preserving data for later viewing), and starts
 * streaming into a fresh capture.
 *
 * Only supported for realtime devices (gvret, slcan, gs_usb, socketcan).
 * Returns an error for recorded sources (WireTAP backend, csv, mqtt).
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
 * Register a subscriber for a session.
 * This is the primary way for frontend components to join a session.
 * If the subscriber is already registered, this updates their heartbeat.
 * @param sessionId The session ID
 * @param subscriberId A unique ID for this subscriber (e.g., "discovery", "decoder")
 * @returns Session info including whether this subscriber is the owner
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
 * Unregister a subscriber from a session.
 * If this was the last subscriber, the session will be stopped (but not destroyed).
 * @param sessionId The session ID
 * @param subscriberId The subscriber ID to unregister
 * @returns The remaining subscriber count
 */
export async function unregisterSessionSubscriber(
  sessionId: string,
  subscriberId: string
): Promise<number> {
  return invoke("unregister_session_subscriber", {
    session_id: sessionId,
    subscriber_id: subscriberId,
  });
}

/**
 * Evict a subscriber from a session, giving it a copy of the current capture.
 * Used by the Session Manager to remove a subscriber without destroying the session.
 * @param sessionId The session ID
 * @param subscriberId The subscriber ID to evict
 * @returns List of copied capture IDs given to the evicted subscriber
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
 * Leave a session (user-initiated): the calling app detaches and reviews a frozen
 * snapshot of the capture, while the session keeps streaming for any remaining apps.
 * The backend copies the capture, unregisters this subscriber, and emits
 * `subscriber-evicted` so this app switches to the snapshot.
 * @param sessionId The session ID
 * @param subscriberId This app's subscriber ID
 * @returns Copied snapshot capture IDs (empty when nothing was captured)
 */
export async function leaveSessionToCapture(
  sessionId: string,
  subscriberId: string
): Promise<string[]> {
  return invoke("session_leave_to_capture", {
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
  return invoke("add_source_to_session_cmd", { session_id: sessionId, source });
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
    bus_mappings: busMappings,
  });
}

/**
 * Check if it's safe to reinitialize a session and do so if safe.
 * Reinitialize is only safe if the requesting subscriber is the only subscriber.
 * This is an atomic check-and-act operation to prevent race conditions.
 *
 * If safe, the session will be destroyed so a new one can be created.
 * @param sessionId The session ID
 * @param subscriberId The requesting subscriber's ID
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
 * Set whether a subscriber is active (receiving frames).
 * When a subscriber detaches, set isActive to false to stop receiving frames.
 * When they rejoin, set isActive to true to resume receiving frames.
 * This is handled in Rust to avoid frontend race conditions.
 * @param sessionId The session ID
 * @param subscriberId The subscriber ID
 * @param isActive Whether the subscriber should receive frames
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
  return invoke("probe_device", { profile_id: profileId });
}

/**
 * Bus mappings for a device the profile hasn't described yet — probed, but
 * never configured in Settings, so `getProfileBusMappings` omits it.
 *
 * Carries no traits: Rust derives those from `protocol` when the session is
 * created. `supportedProtocols` comes from the per-kind table Rust serves via
 * `getSupportedProtocols`, so the dropdown offers the same options here as it
 * does for a configured device.
 */
export function probedBusMappings(
  busCount: number,
  outputBusOffset: number = 0,
  supportedProtocols: Protocol[] = []
): BusMapping[] {
  return Array.from({ length: busCount }, (_, i) => ({
    device_bus: i,
    enabled: true,
    output_bus: outputBusOffset + i,
    interface_id: `can${i}`,
    protocol: supportedProtocols[0] ?? "can",
    supported_protocols: supportedProtocols,
    traits: null,
  }));
}

// ============================================================================
// Multi-Source Session API
// ============================================================================

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
  return invoke("create_multi_source_session", {
    session_id: options.sessionId,
    sources: options.sources,
    subscriber_id: options.subscriberId,
    app_name: options.appName,
    modbus_polls: options.modbusPollsJson,
  });
}

/**
 * List all active sessions.
 * Useful for discovering shareable sessions like multi-source.
 */
export async function listActiveSessions(): Promise<ActiveSessionInfo[]> {
  return invoke("list_active_sessions");
}

/**
 * The bus mappings every IO profile declares, keyed by profile ID, with output
 * buses numbered densely from 0.
 *
 * Rust owns the enumeration — which buses a profile has, and their protocols
 * and traits — because it reads the same `connection.interfaces` the readers
 * do. Callers apply their own output-bus offset on top; they must not re-derive
 * the bus list. See `sessions::profile_bus_mappings`.
 */
export async function getProfileBusMappings(): Promise<Map<string, BusMapping[]>> {
  const raw: Record<string, BusMapping[]> = await invoke("get_profile_bus_mappings");
  return new Map(Object.entries(raw));
}

/**
 * What each profile kind's buses may be set to, keyed by kind.
 *
 * The option list for the source picker's per-bus protocol dropdown. Fewer than
 * two entries means there is nothing to choose and no dropdown is drawn.
 */
export async function getSupportedProtocols(): Promise<Map<string, Protocol[]>> {
  const raw: Record<string, Protocol[]> = await invoke("get_supported_protocols");
  return new Map(Object.entries(raw));
}

/** Shift a profile's declared mappings onto a session's output bus range. */
export function offsetBusMappings(mappings: BusMapping[], outputBusOffset: number): BusMapping[] {
  return outputBusOffset === 0
    ? mappings
    : mappings.map((m, i) => ({ ...m, output_bus: outputBusOffset + i }));
}

// ============================================================================
// Open-app registry (cross-window roster of session-aware app instances)
// ============================================================================

/** Register an open app instance (call on panel mount). */
export async function registerOpenApp(
  instanceId: string,
  displayId: string,
  appName: string,
  windowLabel: string,
): Promise<void> {
  await invoke("register_open_app", {
    instance_id: instanceId,
    display_id: displayId,
    app_name: appName,
    window_label: windowLabel,
  });
}

/** Unregister an open app instance (call on panel unmount). */
export async function unregisterOpenApp(instanceId: string): Promise<void> {
  await invoke("unregister_open_app", { instance_id: instanceId });
}

/** List every open app instance across all windows. */
export async function listOpenApps(): Promise<AppInstanceInfo[]> {
  return invoke("list_open_apps");
}

/**
 * Generate an opaque realtime session id. The cosmetic prefix is inferred by Rust
 * from the given profiles' output type (nothing parses the id).
 */
export async function generateSessionId(
  profileIds: string[],
  emitRawBytes = false,
): Promise<string> {
  return invoke("generate_session_id", {
    profile_ids: profileIds,
    emit_raw_bytes: emitRawBytes,
  });
}

// ============================================================================
// Profile-to-Session Mapping API
// ============================================================================

/** Which sessions are using each of these profiles, and whether that locks reconfiguration. */
export async function getProfilesUsage(profileIds: string[]): Promise<ProfileUsageInfo[]> {
  return invoke("get_profiles_usage", { profile_ids: profileIds });
}

// ============================================================================
// WebView Recovery
// ============================================================================

/** Check if a WebView recovery just occurred (one-shot: cleared after reading). */
export async function checkRecoveryOccurred(): Promise<boolean> {
  return invoke("check_recovery_occurred");
}

// ============================================================================
// Scan sessions
// ============================================================================

/**
 * Create a session that runs a Modbus discovery sweep. Needs neither an existing
 * session nor a catalogue — results land in the session's frame capture, so the
 * analysis tools, TOML export and capture paging all work on them.
 *
 * **The session is created stopped.** The backend snapshots a capture's current
 * frame count when a subscriber attaches, so anything appended before the
 * frontend subscribes is never pushed over the WebSocket. Subscribe first, then
 * call `startReaderSession`.
 */
export async function createModbusScanSession(
  sessionId: string,
  job: ScanJob,
  options?: {
    profileId?: string;
    subscriberId?: string;
    appName?: string;
    /** Sweep anyway when something else is polling the device. */
    allowContention?: boolean;
  }
): Promise<IOCapabilities> {
  return invoke("create_modbus_scan_session", {
    session_id: sessionId,
    job,
    profile_id: options?.profileId ?? null,
    subscriber_id: options?.subscriberId ?? null,
    app_name: options?.appName ?? null,
    allow_contention: options?.allowContention ?? null,
  });
}

// ============================================================================
// Function code probe
// ============================================================================

/**
 * Ask a device which read function codes it answers, before sweeping anything.
 *
 * The distinction that matters is exception vs silence: an exception proves the
 * device implements that function code and the address was simply wrong, whereas
 * silence usually means it isn't implemented and sweeping it would burn the
 * whole timeout budget for nothing.
 */
export async function probeModbusFunctionCodes(config: FcProbeConfig): Promise<FcProbeEntry[]> {
  return invoke("modbus_probe_function_codes", { config });
}

// ============================================================================
// Catalogue-free poll plans
// ============================================================================

/**
 * Build Modbus poll groups from an address range instead of a catalogue. The
 * result is stringified into `watchSource`'s `modbusPollsJson`, exactly as
 * catalogue-derived polls are — a range spec is just another way to author them.
 */
export async function buildModbusPollsFromRanges(
  spec: ModbusRangeSpec
): Promise<ModbusPollGroup[]> {
  return invoke("modbus_polls_from_ranges", { spec });
}

// ============================================================================
// Signal-then-fetch query API
// ============================================================================

/** Fetch current playback position for a recorded/capture session. */
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

/** Fetch orphaned capture IDs from post-session cache. */
export async function getOrphanedCaptureIds(
  sessionId: string
): Promise<string[]> {
  return invoke("get_orphaned_capture_ids", { session_id: sessionId });
}

export interface ReplayState {
  status: string;
  replay_id: string;
  session_id: string;
  frames_sent: number;
  total_frames: number;
  speed: number;
  loop_replay: boolean;
  pass: number;
}

/** Fetch the most recent bytes from a capture (tail view). */
export async function getCaptureBytesTail(
  captureId: string,
  tailSize: number
): Promise<BytesTailResponse> {
  return invoke("get_capture_bytes_tail", {
    capture_id: captureId,
    tail_size: tailSize,
  });
}
