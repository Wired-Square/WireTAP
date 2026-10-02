// ui/src/stores/sessionStore.ts
//
// Centralized IO session manager for all apps (Discovery, Decoder, Transmit).
// Session lifecycle and subscriber management is handled by Rust backend.
// This store manages frontend state and event listeners.

import * as Sentry from "@sentry/react";
import { create } from "zustand";
import { listen, emit } from "@tauri-apps/api/event";
import { WINDOW_EVENTS } from "../events/registry";
import {
  openSession as openSessionCommand,
  startReaderSession,
  stopReaderSession,
  pauseReaderSession,
  resumeReaderSession,
  resumeReaderSessionFresh,
  resumeSessionToLive,
  updateReaderSpeed,
  updateReaderTimeRange,
  seekReaderSession,
  seekReaderSessionByFrame,
  transitionToCaptureSource,
  sessionTransmitFrame,
  unregisterSessionSubscriber,
  reinitializeSessionIfSafe,
  serialPayload,
  isSessionNotFound,
  getStateType,
  type IOCapabilities,
  type IOStateType,
  type InterfaceFramingConfig,
  type StreamEndedInfo,
  type CanTransmitFrame,
  type TransmitResult,
  type FramingMode,
  type MultiSourceInput,
  type BusMapping,
  type BusOverride,
  type PlaybackPosition,
  type ActiveSessionInfo,
  type ProfileUsageInfo,
  type OpenedSession,
  type SerialSettings,
  type SessionMode,
  type SessionSourceKind,
} from "../api/io";
import { reconcileKnownSessions } from "./sessionRoster";
import type { FrameMessage } from "../types/frame";
import type { StreamEndReason } from "../generated/StreamEndReason";
import { tlog } from "../api/settings";
import { trackAlloc } from "../services/memoryDiag";
import { hexToBytes } from "../utils/byteUtils";
import { wsTransport } from "../services/wsTransport";
import {
  MsgType,
  HEADER_SIZE,
  decodeFrameBatch,
  decodeDecodedSignals,
  decodeDecodedBacklog,
  decodeWsJson,
  type AdhocSignalsMsg,
  type DecodedSignalsEntry,
  decodeSessionState,
  decodeStreamEnded,
  decodeSessionError,
  decodePlaybackPosition,
  decodeSessionInfo,
  decodeFrameCounts,
  decodeByteCounts,
  decodeCaptureChanged,
  decodeSessionTransition,
  type SessionTransition,
  type SessionTransitionMsg,
} from "../services/wsProtocol";

/** Stream-end reasons that mean something other than a plain stop. */
const IO_STATE_FOR_STREAM_END: Partial<Record<StreamEndReason, IOStateType>> = {
  paused: "paused",
  error: "error",
};

/** Whether Rust opened the session on a capture, as `open_session` and the roster report it. */
export function isCaptureSession(state: SessionStore, sessionId?: string | null): boolean {
  return !!sessionId && state.sessions[sessionId]?.sourceKind === "capture";
}

/** Getter for showAppError - set after store is created */
// Type derived from the store so it can't drift from showAppError's signature.
let getGlobalShowAppError: (() => SessionStore["showAppError"] | null) | null = null;

// ============================================================================
// Types
// ============================================================================

/** Session lifecycle state */
export type SessionLifecycleState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/** Individual session entry in the store */
export interface Session {
  /** Unique session ID (e.g., "discovery", "transmit-io_xxx-1234") */
  id: string;
  /** Profile ID this session was created from */
  profileId: string;
  /** Display name for the profile */
  profileName: string;
  /** Current lifecycle state */
  lifecycleState: SessionLifecycleState;
  /** IO state from backend (running/stopped/paused/etc) */
  ioState: IOStateType;
  /** IO capabilities (null until connected) */
  capabilities: IOCapabilities | null;
  /** Error message if lifecycleState is "error" */
  errorMessage: string | null;
  /** Number of listeners connected to this session (from Rust backend) */
  subscriberCount: number;
  /** Total frames seen this session (Rust-authoritative, pushed live). */
  frameCount: number;
  /** Distinct (bus, frame_id) count this session (Rust-authoritative, pushed live). */
  uniqueFrameCount: number;
  /** Total raw bytes captured this session (Rust-authoritative, pushed live). */
  byteCount: number;
  /** Capture info after stream ends */
  capture: {
    available: boolean;
    id: string | null;
    kind: "frames" | "bytes" | null;
    count: number;
    /** Session ID that owns this capture (for detecting ingest/cross-app captures) */
    owningSessionId: string | null;
    /** Start time of captured data in microseconds (null if empty or unknown) */
    startTimeUs: number | null;
    /** End time of captured data in microseconds (null if empty or unknown) */
    endTimeUs: number | null;
    /** Display name of the capture (null until fetched) */
    name: string | null;
    /** Whether the capture survives "clear captures on start" */
    persistent: boolean;
  };
  /** Timestamp when session was created/joined */
  createdAt: number;
  /** Whether session has queued messages (prevents auto-removal from Transmit dropdown) */
  hasQueuedMessages: boolean;
  /** Current playback speed (null until set, 1 = realtime, 0 = unlimited) */
  speed: number | null;
  /** Current playback position (centralised for all apps sharing this session) */
  playbackPosition: PlaybackPosition | null;
  /** Decoder catalog path for this session (frontend-only, shared across apps) */
  catalogPath: string | null;
  /** Capture ID for raw byte streams (Rust-authoritative, arrives with the byte count) */
  bytesCaptureId: string | null;
  /**
   * What kind of source is behind this session ("modbus_scan", "gvret_tcp", …),
   * as registration and the roster report it.
   */
  sourceType?: string;
  /** Profile IDs in this session whose polling is paused (Rust-authoritative). */
  pausedSourceProfileIds: string[];
  /**
   * Profiles the session was opened from (Rust-authoritative) — the source's,
   * even while it replays its capture after a stop. Empty until Rust reports it.
   */
  originProfileIds: string[];
  /** What the session was opened from; undefined until Rust reports it. */
  sourceKind?: SessionSourceKind;
  /** What the session is streaming now; undefined until Rust reports it. */
  mode?: SessionMode;
  /** True when adopted from the backend roster (known-only, not UI-owned). */
  external?: boolean;
}

/** Options for creating a session */
export interface CreateSessionOptions extends SerialSettings {
  /** Custom session ID (defaults to auto-generated) */
  sessionId?: string;
  /** Devices merged into one session, replacing whatever is under its id */
  sources?: MultiSourceInput[];
  /** Start time for time-range capable readers (ISO-8601) */
  startTime?: string;
  /** End time for time-range capable readers (ISO-8601) */
  endTime?: string;
  /** Initial playback speed */
  speed?: number;
  /** Maximum number of frames to read */
  limit?: number;
  /** Bus number override for single-bus devices (0-7) */
  busOverride?: number;
  /** Skip auto-starting playback sources (WireTAP backend, csv) - for connect-only mode */
  skipAutoStart?: boolean;
  /** Modbus TCP poll groups as JSON string (catalog-derived, for modbus_tcp profiles) */
  modbusPollsJson?: string;
}

/** Payload for session-reconfigured event (now empty — apps just clear state) */
export type SessionReconfiguredPayload = Record<string, never>;

/** Callbacks for a session - stored per subscriber in the frontend */
export interface SessionCallbacks {
  onFrames?: (frames: FrameMessage[]) => void;
  /** Decoded signals streamed from the Rust decoder (when a catalogue is attached). */
  onDecoded?: (decoded: DecodedSignalsEntry[], backlog: boolean) => void;
  /** The Dashboard's ad-hoc signals, for the window that registered them. */
  onAdhocSignals?: (msg: AdhocSignalsMsg) => void;
  onError?: (error: string) => void;
  onTimeUpdate?: (position: PlaybackPosition) => void;
  onStreamEnded?: (payload: StreamEndedInfo) => void;
  onStreamComplete?: () => void;
  onStateChange?: (state: IOStateType) => void;
  onSpeedChange?: (speed: number) => void;
  /** Called when session is reconfigured (e.g., event jump) - apps should clear state */
  onReconfigure?: (payload: SessionReconfiguredPayload) => void;
  /** Called when session is suspended (stopped with capture available) */
  onSuspended?: (payload: SessionTransitionMsg) => void;
  /** Called when session is stopped and switched to capture replay (all subscribers transition) */
  onSwitchedToCapture?: (payload: SessionTransitionMsg) => void;
  /** Called when session is resuming or returning to live - apps should clear their frame lists */
  onResuming?: (payload: SessionTransitionMsg) => void;
}

/** Session event listeners - one set per session */
interface SessionEventSubscribers {
  /** Session ID this subscriber set belongs to (for WS unsubscribe on cleanup) */
  sessionId: string;
  /** Unlisten functions for WebSocket message handlers */
  wsUnlistenFunctions: (() => void)[];
  /** Callbacks registered by subscribers, keyed by subscriber ID */
  callbacks: Map<string, SessionCallbacks>;
  /** This window's subscribers on the session */
  registeredSubscribers: Set<string>;
  /** Settles once the WS channel is subscribed, so an open's first frames are not missed */
  subscribed: Promise<unknown>;
}

// ============================================================================
// Store Interface
// ============================================================================

export interface SessionStore {
  // ---- Data ----
  /** All sessions keyed by session ID */
  sessions: Record<string, Session>;
  /** Rust's session roster as last listed */
  roster: ActiveSessionInfo[];
  /** Usage of every profile a session holds, by profile ID */
  profileUsage: Record<string, ProfileUsageInfo>;
  /** Currently selected session ID for transmission (Transmit app) */
  activeSessionId: string | null;
  /** Event listeners per session (frontend-only, for routing events to callbacks) */
  _eventListeners: Record<string, SessionEventSubscribers>;

  // ---- Actions: Session Lifecycle ----
  /** Open a session - creates if not exists, joins if exists */
  openSession: (
    profileId: string,
    profileName: string,
    subscriberId: string,
    appName: string,
    options?: CreateSessionOptions
  ) => Promise<Session>;
  /** Open a session for a mounted view, which `releaseSession` undoes */
  holdSession: (sessionId: string, profileName: string, subscriberId: string, appName: string) => Promise<Session>;
  /** Leave a held session, unless the view held it again before the leave ran */
  releaseSession: (sessionId: string, subscriberId: string) => Promise<void>;
  /** Leave a session (unregister subscriber) */
  leaveSession: (sessionId: string, subscriberId: string) => Promise<void>;
  /** Remove session from list entirely */
  removeSession: (sessionId: string) => Promise<void>;
  /** Clean up a session that was destroyed externally (local-only, no backend calls) */
  cleanupDestroyedSession: (sessionId: string) => void;
  /** Clean up after a subscriber is evicted from a session (local-only, no backend calls) */
  cleanupEvictedSubscriber: (sessionId: string, subscriberId: string) => void;
  /** Reinitialize a session with new options (atomic check via Rust) */
  reinitializeSession: (
    sessionId: string,
    subscriberId: string,
    appName: string,
    profileId: string,
    profileName: string,
    options?: CreateSessionOptions
  ) => Promise<Session>;

  // ---- Actions: Session Control ----
  /** Start streaming on a session */
  startSession: (sessionId: string) => Promise<void>;
  /** Stop streaming on a session */
  stopSession: (sessionId: string) => Promise<void>;
  /** Pause streaming on a session */
  pauseSession: (sessionId: string) => Promise<void>;
  /** Resume streaming on a session */
  resumeSession: (sessionId: string) => Promise<void>;
  /** Resume a suspended session with a fresh capture (orphans old capture) */
  resumeSessionFresh: (sessionId: string) => Promise<void>;
  /** Update playback speed */
  setSessionSpeed: (sessionId: string, speed: number) => Promise<void>;
  /** Update time range */
  setSessionTimeRange: (
    sessionId: string,
    start?: string,
    end?: string
  ) => Promise<void>;
  /** Seek to timestamp */
  seekSession: (sessionId: string, timestampUs: number) => Promise<void>;
  /** Seek to frame index (preferred for capture playback) */
  seekSessionByFrame: (sessionId: string, frameIndex: number) => Promise<void>;
  /** Switch to capture replay mode */
  switchToCapture: (sessionId: string, speed?: number, captureId?: string) => Promise<void>;

  // ---- Actions: Capture Metadata ----
  /** Rename a capture and update all sessions that reference it */
  renameSessionCapture: (captureId: string, newName: string) => Promise<void>;
  /** Toggle capture persistence and update all sessions that reference it */
  setSessionCapturePersistent: (captureId: string, persistent: boolean) => Promise<void>;

  // ---- Actions: Transmission ----
  /** Transmit a CAN frame through a session */
  transmitFrame: (
    sessionId: string,
    frame: CanTransmitFrame
  ) => Promise<TransmitResult>;
  /** Set the active session for transmission */
  setActiveSession: (sessionId: string | null) => void;
  /** Mark session as having queued messages */
  setHasQueuedMessages: (sessionId: string, hasQueue: boolean) => void;

  // ---- Actions: Callbacks ----
  /** Register callbacks for a subscriber */
  registerCallbacks: (sessionId: string, subscriberId: string, callbacks: SessionCallbacks) => void;
  /** Clear callbacks for a specific subscriber */
  clearCallbacks: (sessionId: string, subscriberId: string) => void;

  // ---- Selectors ----
  /** Get session by ID */
  getSession: (sessionId: string) => Session | undefined;
  /** Check if profile is in use by any session */
  isProfileInUse: (profileId: string) => boolean;
  /** Get session for a profile (if one exists) */
  getSessionForProfile: (profileId: string) => Session | undefined;

  // ---- Global App Error Dialog ----
  /** Global app error dialog state (shown for errors across the app) */
  appErrorDialog: {
    isOpen: boolean;
    title: string;
    message: string;
    details: string | null;
    /** The session whose stream raised it; it closes when that session runs again. */
    sessionId: string | null;
  };
  /** Show the global app error dialog. `fingerprint` sets a stable Sentry grouping
   * key so device-identified messages (which vary by port/OS code) still group as
   * one issue. */
  showAppError: (
    title: string,
    message: string,
    details?: string,
    fingerprint?: string,
    sessionId?: string
  ) => void;
  /** Close the global app error dialog */
  closeAppError: () => void;
  /** Set the decoder catalog path for a session (frontend-only, shared across apps) */
  setSessionCatalogPath: (sessionId: string, catalogPath: string | null) => void;

  // ---- Cross-App Session Join ----
  /** Pending session joins keyed by app name (e.g., "transmit", "dashboard") */
  pendingJoins: Record<string, { sessionId: string }>;
  /** Request that an app auto-joins a session (called by source apps) */
  requestSessionJoin: (appName: string, sessionId: string) => void;
  /** Adopt backend roster sessions as known-only entries (reconcile). */
  registerKnownSessions: (infos: ActiveSessionInfo[]) => void;
  /** Hold Rust's profile usage, keyed by profile ID */
  registerProfileUsage: (usage: ProfileUsageInfo[]) => void;
  /** Clear a pending join for an app (consumed by useIOSessionManager) */
  clearPendingJoin: (appName: string) => void;
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Invoke all callbacks for an event type */
/** A session's capture slot before anything is known about the capture — or with
 *  only its id, as the CaptureChanged message reports it. */
function emptyCapture(id: string | null = null, owningSessionId: string | null = null): Session["capture"] {
  return {
    available: id !== null,
    id,
    kind: id ? "frames" : null,
    count: 0,
    owningSessionId,
    startTimeUs: null,
    endTimeUs: null,
    name: null,
    persistent: false,
  };
}

const TRANSITION_CALLBACK = {
  suspended: "onSuspended",
  switched_to_capture: "onSwitchedToCapture",
  resuming: "onResuming",
  returned_to_live: "onResuming",
  capabilities_changed: null,
} as const satisfies Record<SessionTransition, keyof SessionCallbacks | null>;

/** What a pushed transition does to the session's entry, and which callback it fires. */
export function sessionTransitionEffect(msg: SessionTransitionMsg, session: Session | undefined, sessionId: string) {
  const updates: Partial<Session> = { ioState: msg.state, mode: msg.mode };
  if (msg.capabilities) updates.capabilities = msg.capabilities;
  switch (msg.transition) {
    case "resuming":
    case "returned_to_live":
      // A fresh run has a fresh capture; Rust re-pushes the counts and the byte capture id.
      Object.assign(updates, {
        frameCount: 0,
        uniqueFrameCount: 0,
        byteCount: 0,
        bytesCaptureId: null,
        capture: emptyCapture(null, sessionId),
      });
      break;
    case "suspended":
    case "switched_to_capture":
      if (msg.capture_id) {
        updates.capture = {
          ...(session?.capture ?? emptyCapture(null, sessionId)),
          available: msg.capture_count > 0,
          id: msg.capture_id,
          count: msg.capture_count,
        };
      }
      break;
  }
  return { updates, callback: TRANSITION_CALLBACK[msg.transition] };
}

function invokeCallbacks<A extends unknown[]>(
  eventListeners: SessionEventSubscribers,
  eventType: keyof SessionCallbacks,
  ...args: A
) {
  for (const [, callbacks] of eventListeners.callbacks.entries()) {
    const cb = callbacks[eventType] as ((...a: A) => void) | undefined;
    if (cb) {
      cb(...args);
    }
  }
}

/** An attach's redecode of what was already delivered goes to the subscriber that attached, and no other. */
export function deliverDecodedBacklog(callbacks: Map<string, SessionCallbacks>, payload: DataView) {
  const { subscriber, decoded } = decodeDecodedBacklog(payload);
  callbacks.get(subscriber)?.onDecoded?.(decoded, true);
}

/** Route a session's WebSocket pushes to its callbacks and store entry. */
function setupSessionEventSubscribers(sessionId: string, eventListeners: SessionEventSubscribers) {
  // Handlers registered before the channel is subscribed are queued by the transport.
  // FrameData (0x01)
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.FrameData, (_payload, raw) => {
      const frames = decodeFrameBatch(raw, HEADER_SIZE);
      if (frames.length > 0) {
        trackAlloc("session.onFrames", frames.length * 300);
        invokeCallbacks(eventListeners, "onFrames", frames);
      }
    })
  );

  // DecodedSignals (0x14) — decoded in Rust when a catalogue is attached.
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.DecodedSignals, (payload) => {
      const decoded = decodeDecodedSignals(payload);
      if (decoded.length > 0) invokeCallbacks(eventListeners, "onDecoded", decoded, false);
    })
  );
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.DecodedBacklog, (payload) =>
      deliverDecodedBacklog(eventListeners.callbacks, payload)
    )
  );

  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.AdhocSignals, (_payload, raw) => {
      invokeCallbacks(eventListeners, "onAdhocSignals", decodeWsJson<AdhocSignalsMsg>(raw));
    })
  );

  // SessionState (0x02) — state string + optional error decoded from binary
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.SessionState, (payload) => {
      const { state, errorMsg } = decodeSessionState(payload);
      const stateType = state as IOStateType;
      updateSession(sessionId, {
        ioState: stateType,
        ...(errorMsg ? { errorMessage: errorMsg } : {}),
      });
      if (stateType === "running") closeStreamErrorFor(sessionId);
      invokeCallbacks(eventListeners, "onStateChange", stateType);
    })
  );

  // StreamEnded (0x03) — full stream-ended info decoded from binary
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.StreamEnded, (payload) => {
      const info = decodeStreamEnded(payload);
      // A run that lost every source to an error must not read as a clean
      // stop; this is the only push that reports it, so the mapping is the
      // whole mechanism rather than a defence against an ordering race.
      const ioState = IO_STATE_FOR_STREAM_END[info.reason] ?? "stopped";
      updateSession(sessionId, {
        ioState,
        capture: {
          available: info.capture_available,
          id: info.capture_id,
          kind: info.capture_kind,
          count: info.count,
          owningSessionId: sessionId,
          startTimeUs: info.time_range?.[0] ?? null,
          endTimeUs: info.time_range?.[1] ?? null,
          name: useSessionStore.getState().sessions[sessionId]?.capture?.name ?? null,
          persistent: useSessionStore.getState().sessions[sessionId]?.capture?.persistent ?? false,
        },
      });
      if (info.capture_id && !useSessionStore.getState().sessions[sessionId]?.capture?.name) {
        import("../api/capture").then(({ getCaptureMetadataById }) =>
          getCaptureMetadataById(info.capture_id!).then((meta) => {
            if (meta) {
              updateSession(sessionId, {
                capture: {
                  ...useSessionStore.getState().sessions[sessionId]?.capture!,
                  name: meta.name,
                  persistent: meta.persistent,
                },
              });
            }
          }).catch(() => {/* ignore */})
        );
      }
      invokeCallbacks(eventListeners, "onStreamEnded", info);
      if (info.reason === "paused") {
        invokeCallbacks(eventListeners, "onStreamComplete", undefined as never);
      }
    })
  );

  // SessionError (0x04) — severity and message decoded from binary
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.SessionError, (payload) => {
      const { severity, message: error } = decodeSessionError(
        new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
      );
      if (error) {
        if (severity === "fault") {
          invokeCallbacks(eventListeners, "onError", error);
          if (typeof getGlobalShowAppError === "function") {
            const showAppError = getGlobalShowAppError();
            if (showAppError) {
              // The backend now sends an actionable, device-identified message
              // (e.g. "COM5 stopped responding … reconnect and try again"), so
              // show it directly rather than a generic sentence. A stable
              // fingerprint keeps these grouped as one Sentry issue despite the
              // device name / OS code varying.
              showAppError("Stream Error", error, undefined, "stream-error", sessionId);
            }
          }
          updateSession(sessionId, {
            ioState: "error",
            errorMessage: error,
          });
        }
      }
    })
  );

  // PlaybackPosition (0x05) — position decoded from binary
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.PlaybackPosition, (payload) => {
      const pos = decodePlaybackPosition(payload);
      updateSession(sessionId, { playbackPosition: pos });
      invokeCallbacks(eventListeners, "onTimeUpdate", pos);
    })
  );

  // SessionInfo (0x09) — speed + listener count decoded from binary.
  // Either field may be a sentinel meaning "no update":
  //   speed = -1.0 → listener-count-only update
  //   subscriber_count = 0xFFFF (65535) → speed-only update
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.SessionInfo, (payload) => {
      const info = decodeSessionInfo(payload);
      const updates: Record<string, unknown> = {};
      if (info.subscriber_count < 0xFFFF) {
        updates.subscriberCount = info.subscriber_count;
      }
      if (info.speed >= 0) {
        updates.speed = info.speed;
        invokeCallbacks(eventListeners, "onSpeedChange", info.speed);
      }
      if (Object.keys(updates).length > 0) {
        updateSession(sessionId, updates);
      }
    })
  );

  // FrameCounts (0x16) — live total + unique counts, Rust-authoritative.
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.FrameCounts, (payload) => {
      const { total, unique } = decodeFrameCounts(payload);
      updateSession(sessionId, { frameCount: total, uniqueFrameCount: unique });
    })
  );

  // ByteCounts (0x19) — live raw-byte total plus the byte capture's id, Rust-authoritative.
  // The bytes themselves are never pushed; readers fetch rows from that capture when the
  // count moves (see useCaptureFrameView for the same contract on frames).
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.ByteCounts, (payload) => {
      const { total, captureId } = decodeByteCounts(payload);
      updateSession(sessionId, { byteCount: total, bytesCaptureId: captureId });
    })
  );

  // CaptureChanged (0x07) — the session's frames capture id, empty when it has none.
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.CaptureChanged, (payload) => {
      const captureId =
        decodeCaptureChanged(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)) || null;
      const current = useSessionStore.getState().sessions[sessionId];
      if (!current || current.capture.id === captureId) return;
      updateSession(sessionId, { capture: emptyCapture(captureId, captureId ? sessionId : null) });
    })
  );

  // Reconfigured (0x0A) — signal-only, no payload to decode
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.Reconfigured, () => {
      tlog.debug(`[sessionStore] Session '${sessionId}' reconfigured (WS)`);
      invokeCallbacks(eventListeners, "onReconfigure", {} as SessionReconfiguredPayload);
    })
  );

  // SessionLifecycle (0x08) — the transition Rust made, with the state and capabilities it left
  eventListeners.wsUnlistenFunctions.push(
    wsTransport.onSessionMessage(sessionId, MsgType.SessionLifecycle, (payload) => {
      const msg = decodeSessionTransition(payload);
      const { updates, callback } = sessionTransitionEffect(msg, useSessionStore.getState().sessions[sessionId], sessionId);
      updateSession(sessionId, updates);
      if (callback) invokeCallbacks(eventListeners, callback, msg);
    })
  );
}

/** Clean up session event listeners */
function cleanupEventListeners(eventListeners: SessionEventSubscribers) {
  // Unlisten from WebSocket message handlers and unsubscribe channel
  for (const unlisten of eventListeners.wsUnlistenFunctions) {
    unlisten();
  }
  eventListeners.wsUnlistenFunctions = [];
  wsTransport.unsubscribe(eventListeners.sessionId);

  eventListeners.callbacks.clear();
  eventListeners.registeredSubscribers.clear();
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useSessionStore = create<SessionStore>((set, get) => ({
  // ---- Initial State ----
  sessions: {},
  roster: [],
  profileUsage: {},
  activeSessionId: null,
  _eventListeners: {},
  pendingJoins: {},
  appErrorDialog: {
    isOpen: false,
    title: "",
    message: "",
    details: null,
    sessionId: null,
  },

  // ---- Session Lifecycle ----
  openSession: (profileId, profileName, subscriberId, appName, options = {}) =>
    inOrder(subscriberId, () => openNow(profileId, profileName, subscriberId, appName, options)).then(
      () => get().sessions[options.sessionId ?? profileId]
    ),

  holdSession: (sessionId, profileName, subscriberId, appName) => {
    const key = holdKey(sessionId, subscriberId);
    holds.set(key, (holds.get(key) ?? 0) + 1);
    return get().openSession(sessionId, profileName, subscriberId, appName);
  },

  releaseSession: (sessionId, subscriberId) => {
    const key = holdKey(sessionId, subscriberId);
    const remaining = (holds.get(key) ?? 1) - 1;
    if (remaining > 0) holds.set(key, remaining);
    else holds.delete(key);
    return inOrder(subscriberId, async () => {
      if (holds.has(key)) return;
      get().clearCallbacks(sessionId, subscriberId);
      await leaveNow(sessionId, subscriberId);
    });
  },

  leaveSession: (sessionId, subscriberId) => inOrder(subscriberId, () => leaveNow(sessionId, subscriberId)),

  removeSession: async (sessionId) => {
    const session = get().sessions[sessionId];
    const eventListeners = get()._eventListeners[sessionId];

    if (!session) return;

    // Unregister all local listeners from Rust backend
    if (eventListeners) {
      for (const subscriberId of eventListeners.registeredSubscribers) {
        try {
          await unregisterSessionSubscriber(sessionId, subscriberId);
        } catch {
          // Ignore - session may already be gone
        }
      }
      cleanupEventListeners(eventListeners);
    }

    // Note: Don't call leaveReaderSession - unregisterSessionSubscriber already handles it.
    // The backend auto-destroys sessions when the last listener unregisters.

    // Remove from store
    set((s) => {
      const { [sessionId]: _, ...remainingSessions } = s.sessions;
      const { [sessionId]: __, ...remainingListeners } = s._eventListeners;
      return {
        sessions: remainingSessions,
        _eventListeners: remainingListeners,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
      };
    });
  },

  cleanupDestroyedSession: (sessionId) => {
    tlog.info(`[sessionStore:cleanupDestroyedSession] Cleaning up session '${sessionId}' (destroyed externally)`);
    const eventListeners = get()._eventListeners[sessionId];
    if (eventListeners) {
      cleanupEventListeners(eventListeners);
    }

    // Remove from store (no backend calls - session is already gone)
    set((s) => {
      const { [sessionId]: _, ...remainingSessions } = s.sessions;
      const { [sessionId]: __, ...remainingListeners } = s._eventListeners;
      return {
        sessions: remainingSessions,
        _eventListeners: remainingListeners,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
      };
    });
  },

  cleanupEvictedSubscriber: (sessionId, subscriberId) => {
    tlog.info(`[sessionStore:cleanupEvictedSubscriber] Cleaning up evicted listener '${subscriberId}' from session '${sessionId}'`);
    const eventListeners = get()._eventListeners[sessionId];

    if (eventListeners) {
      // Remove this listener's callback and registration
      eventListeners.callbacks.delete(subscriberId);
      eventListeners.registeredSubscribers.delete(subscriberId);

      // If no more local callbacks, full cleanup (like cleanupDestroyedSession)
      if (eventListeners.callbacks.size === 0) {
        cleanupEventListeners(eventListeners);

        set((s) => {
          const { [sessionId]: _, ...remainingSessions } = s.sessions;
          const { [sessionId]: __, ...remainingListeners } = s._eventListeners;
          return {
            sessions: remainingSessions,
            _eventListeners: remainingListeners,
            activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
          };
        });
      } else {
        // Other local listeners remain — just update the listener count
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...s.sessions[sessionId],
              subscriberCount: Math.max(0, (s.sessions[sessionId]?.subscriberCount ?? 1) - 1),
            },
          },
        }));
      }
    }
  },

  reinitializeSession: (sessionId, subscriberId, appName, profileId, profileName, options) =>
    inOrder(subscriberId, async () => {
      // Rust tears the session down only when this subscriber is its last
      const result = await reinitializeSessionIfSafe(sessionId, subscriberId);
      const existing = get().sessions[sessionId];
      if (!result.success && existing) {
        // Others are watching it, so only the time range can change
        if (options?.startTime !== undefined || options?.endTime !== undefined) {
          await updateReaderTimeRange(sessionId, options.startTime, options.endTime);
        }
        return existing;
      }
      if (result.success) {
        // A fresh WS subscription resets the frame offset for the new capture
        dropSessionListeners(sessionId);
        updateSession(sessionId, { ioState: "starting" });
      }
      await openNow(profileId, profileName, subscriberId, appName, { ...options, sessionId });
      return get().sessions[sessionId];
    }),

  // ---- Session Control ----
  startSession: async (sessionId) => {
    const session = get().sessions[sessionId];
    if (!session || session.lifecycleState !== "connected") {
      throw new Error(`Session ${sessionId} not connected`);
    }

    // Idempotent: don't restart if already running or starting
    if (session.ioState === "running" || session.ioState === "starting") {
      return;
    }

    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          ioState: "starting",
        },
      },
    }));

    try {
      const confirmedState = await startReaderSession(sessionId);
      set((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...s.sessions[sessionId],
            ioState: getStateType(confirmedState),
            errorMessage: null,
          },
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...s.sessions[sessionId],
            ioState: "error",
            errorMessage: msg,
          },
        },
      }));
      throw e;
    }
  },

  stopSession: async (sessionId) => {
    try {
      const confirmedState = await stopReaderSession(sessionId);
      set((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...s.sessions[sessionId],
            ioState: getStateType(confirmedState),
          },
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("not found")) {
        throw e;
      }
    }
  },

  pauseSession: async (sessionId) => {
    const confirmedState = await pauseReaderSession(sessionId);
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          ioState: getStateType(confirmedState),
        },
      },
    }));
  },

  resumeSession: async (sessionId) => {
    const confirmedState = await resumeReaderSession(sessionId);
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          ioState: getStateType(confirmedState),
        },
      },
    }));
  },

  resumeSessionFresh: async (sessionId) => {
    // Try to resume to live first (for realtime sources that were suspended to capture mode)
    // This will fail if the session doesn't have stored profile IDs (recorded sources)
    try {
      tlog.info(`[sessionStore] resumeSessionFresh: trying resumeSessionToLive for '${sessionId}'`);
      const capabilities = await resumeSessionToLive(sessionId);
      // Success - session is now back in live mode with a fresh capture
      tlog.info(`[sessionStore] resumeSessionFresh: '${sessionId}' resumed to live mode`);
      set((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...s.sessions[sessionId],
            capabilities,
            ioState: "running",
          },
        },
      }));
    } catch (e) {
      // No profile IDs stored (recorded source) - use the existing resume logic
      tlog.info(`[sessionStore] resumeSessionFresh: '${sessionId}' falling back to resumeReaderSessionFresh - ${e}`);
      const confirmedState = await resumeReaderSessionFresh(sessionId);
      set((s) => ({
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...s.sessions[sessionId],
            ioState: getStateType(confirmedState),
          },
        },
      }));
    }
  },

  setSessionSpeed: async (sessionId, speed) => {
    await updateReaderSpeed(sessionId, speed);
  },

  setSessionTimeRange: async (sessionId, start, end) => {
    await updateReaderTimeRange(sessionId, start, end);
  },

  seekSession: async (sessionId, timestampUs) => {
    await seekReaderSession(sessionId, timestampUs);
  },

  seekSessionByFrame: async (sessionId, frameIndex) => {
    await seekReaderSessionByFrame(sessionId, frameIndex);
    // Update local playback position immediately so UI reflects the seek
    // (Backend will emit position events during playback, but we need immediate feedback for seeks while paused)
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            playbackPosition: {
              // Keep existing timestamp or default to 0 (frame index is what matters for position display)
              timestamp_us: session.playbackPosition?.timestamp_us ?? 0,
              frame_index: frameIndex,
            },
          },
        },
      };
    });
  },

  switchToCapture: async (sessionId, speed, captureId) => {
    const capabilities = await transitionToCaptureSource(sessionId, captureId ?? '', speed);
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          capabilities,
          ioState: "stopped",
          buffer: { available: false, id: null, type: null, count: 0, owningSessionId: null, startTimeUs: null, endTimeUs: null, name: null, persistent: false },
        },
      },
    }));
  },

  // ---- Capture Metadata ----
  renameSessionCapture: async (captureId, newName) => {
    const { renameCapture } = await import("../api/capture");
    await renameCapture(captureId, newName);
    // Update ALL sessions that share this capture ID
    const sessions = get().sessions;
    const updated: Record<string, Session> = {};
    for (const [sid, session] of Object.entries(sessions)) {
      if (session.capture.id === captureId) {
        updated[sid] = { ...session, capture: { ...session.capture, name: newName } };
      }
    }
    if (Object.keys(updated).length > 0) {
      set((s) => ({ sessions: { ...s.sessions, ...updated } }));
    }
    // Notify other windows
    emit(WINDOW_EVENTS.CAPTURE_METADATA_UPDATED, { captureId, name: newName });
  },

  setSessionCapturePersistent: async (captureId, persistent) => {
    const { setCapturePersistent } = await import("../api/capture");
    await setCapturePersistent(captureId, persistent);
    // Update ALL sessions that share this capture ID
    const sessions = get().sessions;
    const updated: Record<string, Session> = {};
    for (const [sid, session] of Object.entries(sessions)) {
      if (session.capture.id === captureId) {
        updated[sid] = { ...session, capture: { ...session.capture, persistent } };
      }
    }
    if (Object.keys(updated).length > 0) {
      set((s) => ({ sessions: { ...s.sessions, ...updated } }));
    }
    // Notify other windows
    emit(WINDOW_EVENTS.CAPTURE_METADATA_UPDATED, { captureId, persistent });
  },

  // ---- Transmission ----
  transmitFrame: async (sessionId, frame) => {
    const session = get().sessions[sessionId];
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!session.capabilities?.traits.tx_frames) {
      throw new Error(`Session ${sessionId} does not support transmission`);
    }
    return sessionTransmitFrame(sessionId, frame);
  },

  setActiveSession: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

  setHasQueuedMessages: (sessionId, hasQueue) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: { ...s.sessions, [sessionId]: { ...session, hasQueuedMessages: hasQueue } } };
    });
  },

  // ---- Callbacks ----
  registerCallbacks: (sessionId, subscriberId, callbacks) => {
    const eventListeners = get()._eventListeners[sessionId];
    if (eventListeners) {
      eventListeners.callbacks.set(subscriberId, callbacks);
    }
  },

  clearCallbacks: (sessionId, subscriberId) => {
    const eventListeners = get()._eventListeners[sessionId];
    if (eventListeners) {
      eventListeners.callbacks.delete(subscriberId);
    }
  },

  // ---- Selectors ----
  getSession: (sessionId) => get().sessions[sessionId],

  isProfileInUse: (profileId) =>
    Object.values(get().sessions).some(
      (s) => s && s.profileId === profileId && s.lifecycleState === "connected"
    ),

  getSessionForProfile: (profileId) =>
    Object.values(get().sessions).find(
      (s) => s && s.profileId === profileId && s.lifecycleState === "connected"
    ),

  // ---- Global App Error Dialog ----
  showAppError: (title, message, details, fingerprint, sessionId) => {
    Sentry.captureMessage(message, {
      level: "error",
      extra: { title, details },
      fingerprint: fingerprint ? [fingerprint] : undefined,
    });
    set({
      appErrorDialog: {
        isOpen: true,
        title,
        message,
        details: details ?? null,
        sessionId: sessionId ?? null,
      },
    });
  },

  closeAppError: () =>
    set({
      appErrorDialog: {
        isOpen: false,
        title: "",
        message: "",
        details: null,
        sessionId: null,
      },
    }),

  setSessionCatalogPath: (sessionId, catalogPath) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: { ...s.sessions[sessionId], catalogPath },
      },
    }));
  },

  // ---- Cross-App Session Join ----
  requestSessionJoin: (appName, sessionId) => {
    set((state) => ({
      pendingJoins: { ...state.pendingJoins, [appName]: { sessionId } },
    }));
  },

  registerKnownSessions: (infos) => {
    set((s) => ({ sessions: reconcileKnownSessions(s.sessions, infos), roster: infos }));
  },

  registerProfileUsage: (usage) => {
    set({ profileUsage: Object.fromEntries(usage.map((u) => [u.profile_id, u])) });
  },

  clearPendingJoin: (appName) => {
    set((state) => {
      const { [appName]: _, ...rest } = state.pendingJoins;
      return { pendingJoins: rest };
    });
  },
}));

// Initialize the showAppError getter for error handling
getGlobalShowAppError = () => useSessionStore.getState().showAppError;

/** A source that came back (a replugged serial adapter) clears the error it raised. */
export function closeStreamErrorFor(sessionId: string) {
  const { appErrorDialog, closeAppError } = useSessionStore.getState();
  if (appErrorDialog.isOpen && appErrorDialog.sessionId === sessionId) closeAppError();
}

// Listen for capture events from other windows.
// App-lifetime listeners; HMR guard prevents double-registration during dev.
let _unlistenCaptureMeta: (() => void) | null = null;
let _unlistenCaptureChanged: (() => void) | null = null;

(() => {
  // Clean up previous registrations (HMR guard).
  // Cast is needed because TS narrows these `let` vars to `null` here —
  // they're only reassigned inside the deferred `.then` callbacks below.
  (_unlistenCaptureMeta as (() => void) | null)?.();
  (_unlistenCaptureChanged as (() => void) | null)?.();

  // Rename / pin changes
  listen<{ captureId: string; name?: string; persistent?: boolean }>(
    WINDOW_EVENTS.CAPTURE_METADATA_UPDATED,
    (event) => {
      const { captureId, name, persistent } = event.payload;
      const sessions = useSessionStore.getState().sessions;
      const updated: Record<string, Session> = {};
      for (const [sid, session] of Object.entries(sessions)) {
        if (session.capture.id === captureId) {
          updated[sid] = {
            ...session,
            capture: {
              ...session.capture,
              ...(name !== undefined && { name }),
              ...(persistent !== undefined && { persistent }),
            },
          };
        }
      }
      if (Object.keys(updated).length > 0) {
        useSessionStore.setState((s) => ({ sessions: { ...s.sessions, ...updated } }));
      }
    }
  ).then(fn => { _unlistenCaptureMeta = fn; });

  // Capture deleted — clear it from any session referencing it
  listen<{ deletedCaptureIds?: string[] }>(
    WINDOW_EVENTS.CAPTURE_CHANGED,
    (event) => {
      const ids = event.payload.deletedCaptureIds;
      if (!ids || ids.length === 0) return;
      const deletedSet = new Set(ids);
      const sessions = useSessionStore.getState().sessions;
      const updated: Record<string, Session> = {};
      for (const [sid, session] of Object.entries(sessions)) {
        if (session.capture.id && deletedSet.has(session.capture.id)) {
          updated[sid] = {
            ...session,
            capture: emptyCapture(),
          };
        }
      }
      if (Object.keys(updated).length > 0) {
        useSessionStore.setState((s) => ({ sessions: { ...s.sessions, ...updated } }));
      }
    }
  ).then(fn => { _unlistenCaptureChanged = fn; });
})();

// ============================================================================
// Convenience Hooks
// ============================================================================

/** Get a specific session by ID */
export function useSession(sessionId: string): Session | undefined {
  return useSessionStore((s) => s.sessions[sessionId]);
}

/** Get the active session for transmission */
export function useActiveSession(): Session | undefined {
  return useSessionStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined
  );
}

/** Hook for global app error dialog state and actions */
export function useAppErrorDialog() {
  const isOpen = useSessionStore((s) => s.appErrorDialog.isOpen);
  const title = useSessionStore((s) => s.appErrorDialog.title);
  const message = useSessionStore((s) => s.appErrorDialog.message);
  const details = useSessionStore((s) => s.appErrorDialog.details);
  const closeAppError = useSessionStore((s) => s.closeAppError);

  return { isOpen, title, message, details, closeAppError };
}

/** Source info for a bus in multi-bus mode */
// One definition, in busFormat — this store and SessionControls were carrying
// separate copies of the same shape.
export type { BusSourceInfo } from "../utils/busFormat";


// ============================================================================
// Multi-Source Session Helpers
// ============================================================================

/**
 * Serial framing chosen per device in the picker.
 *
 * Re-exported from `api/io` so there is one declaration. It used to be a second,
 * narrower copy here carrying only `encoding` and `delimiterHex` — every other
 * setting the picker offered was dropped on its way to Rust, which is why the
 * "Capture raw bytes" and "Validate CRC" ticks did nothing.
 */
export type { InterfaceFramingConfig } from "../api/io";

/**
 * Options for creating a multi-source session.
 */
export interface CreateMultiSourceOptions {
  /** Unique session ID for the merged session (e.g., "discovery-multi") */
  sessionId: string;
  /** Listener instance ID for this app (e.g., "discovery_1", "decoder_2") */
  subscriberId: string;
  /** Human-readable app name (e.g., "discovery", "decoder") */
  appName: string;
  /** Profile IDs to combine */
  profileIds: string[];
  /** What the user changed about each profile's buses, keyed by profile ID */
  busOverrides?: Map<string, BusOverride[]>;
  /** Map of profile ID to display name */
  profileNames?: Map<string, string>;
  framingEncoding?: FramingMode;
  /** Delimiter bytes for delimiter-based framing */
  delimiter?: number[];
  /** Maximum frame length for delimiter-based framing */
  maxFrameLength?: number;
  /** Minimum frame length - frames shorter than this are discarded */
  minFrameLength?: number;
  /** Whether to emit raw bytes in addition to framed data */
  emitRawBytes?: boolean;
  /** Per-interface framing config (overrides session-level framing for specific profiles) */
  perInterfaceFraming?: Map<string, InterfaceFramingConfig>;
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
  /** Shared Modbus poll groups JSON (from catalog, injected into all modbus_tcp sources) */
  modbusPollsJson?: string;
}

/**
 * Patch one session record in place, ignoring a session that is not in the store.
 *
 * Hoisted because three call sites had grown their own byte-identical copy — the
 * "absent record is a no-op" half is the part worth having in one place.
 */
function updateSession(id: string, updates: Partial<Session>): void {
  useSessionStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [id]: s.sessions[id] ? { ...s.sessions[id], ...updates } : s.sessions[id],
    },
  }));
}

/** One subscriber's opens and leaves, run in the order they were asked for. */
const subscriberOps = new Map<string, Promise<unknown>>();

function inOrder<T>(subscriberId: string, op: () => Promise<T>): Promise<T> {
  const run = (subscriberOps.get(subscriberId) ?? Promise.resolve()).catch(() => {}).then(op);
  subscriberOps.set(subscriberId, run);
  const forget = () => {
    if (subscriberOps.get(subscriberId) === run) subscriberOps.delete(subscriberId);
  };
  run.then(forget, forget);
  return run;
}

/** How many mounted views of a subscriber hold each session open. */
const holds = new Map<string, number>();
const holdKey = (sessionId: string, subscriberId: string) => `${subscriberId}\u0000${sessionId}`;

function ensureSessionListeners(sessionId: string): SessionEventSubscribers {
  const existing = useSessionStore.getState()._eventListeners[sessionId];
  if (existing) return existing;
  const listeners: SessionEventSubscribers = {
    sessionId,
    wsUnlistenFunctions: [],
    callbacks: new Map(),
    registeredSubscribers: new Set(),
    subscribed: wsTransport.isConnected ? wsTransport.subscribe(sessionId).catch(() => {}) : Promise.resolve(),
  };
  setupSessionEventSubscribers(sessionId, listeners);
  useSessionStore.setState((s) => ({ _eventListeners: { ...s._eventListeners, [sessionId]: listeners } }));
  return listeners;
}

function dropSessionListeners(sessionId: string) {
  const listeners = useSessionStore.getState()._eventListeners[sessionId];
  if (!listeners) return;
  cleanupEventListeners(listeners);
  useSessionStore.setState((s) => {
    const { [sessionId]: _, ...rest } = s._eventListeners;
    return { _eventListeners: rest };
  });
}

/**
 * Open the session in one `open_session` call and record what Rust reports. The
 * channel is subscribed first, so a source the open starts loses no frames.
 */
async function openNow(
  profileId: string,
  profileName: string,
  subscriberId: string,
  appName: string,
  options: CreateSessionOptions
): Promise<OpenedSession> {
  const sessionId = options.sessionId ?? profileId;
  const listeners = ensureSessionListeners(sessionId);
  await listeners.subscribed;

  let opened: OpenedSession;
  try {
    opened = await openSessionCommand(sessionId, subscriberId, appName, {
      source_id: profileId,
      sources: options.sources,
      start_time: options.startTime,
      end_time: options.endTime,
      speed: options.speed,
      limit: options.limit,
      bus_override: options.busOverride,
      modbus_polls: options.modbusPollsJson,
      serial: serialPayload(options),
      connect_only: options.skipAutoStart,
    });
  } catch (e) {
    if (listeners.registeredSubscribers.size === 0) dropSessionListeners(sessionId);
    if (!isSessionNotFound(e)) {
      updateSessionOrCreate(sessionId, {
        id: sessionId,
        profileId,
        profileName,
        lifecycleState: "error",
        ioState: "error",
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  }

  listeners.registeredSubscribers.add(subscriberId);
  const startProblem = opened.start_error ?? opened.startup_error;
  if (startProblem) {
    useSessionStore.getState().showAppError("Stream Error", "An error occurred while starting the session.", startProblem);
  }

  const captureId = opened.capture_id;
  const existing = useSessionStore.getState().sessions[sessionId];
  const fresh = opened.created || !existing;
  updateSessionOrCreate(sessionId, {
    id: sessionId,
    profileId,
    profileName,
    lifecycleState: "connected",
    ioState: getStateType(opened.state),
    capabilities: opened.capabilities,
    errorMessage: opened.start_error,
    // A push may have counted subscribers past the snapshot already.
    subscriberCount: Math.max(opened.subscriber_count, existing?.subscriberCount ?? 0),
    ...(fresh ? { frameCount: 0, uniqueFrameCount: 0, byteCount: 0 } : {}),
    capture: {
      ...emptyCapture(),
      ...(existing && { startTimeUs: existing.capture.startTimeUs, endTimeUs: existing.capture.endTimeUs, name: existing.capture.name, persistent: existing.capture.persistent }),
      id: captureId,
      kind: opened.capture_kind,
      available: false,
    },
    sourceType: opened.source_type,
    sourceKind: opened.source_kind,
    mode: opened.mode,
    originProfileIds: opened.origin_profile_ids,
  });

  // Without the metadata a capture session's count and time range stay zero.
  if (captureId) {
    import("../api/capture").then(({ getCaptureMetadataById }) =>
      getCaptureMetadataById(captureId).then((meta) => {
        const current = useSessionStore.getState().sessions[sessionId];
        if (!meta || current?.capture.id !== captureId) return;
        updateSession(sessionId, {
          capture: {
            ...current.capture,
            available: true,
            kind: meta.kind,
            count: meta.count,
            startTimeUs: meta.start_time_us,
            endTimeUs: meta.end_time_us,
            name: meta.name,
            persistent: meta.persistent,
          },
        });
      }).catch(() => {/* ignore */})
    );
  }

  return opened;
}

/** Patch a session's record, creating it with defaults for what `updates` leaves out. */
function updateSessionOrCreate(id: string, updates: Partial<Session> & Pick<Session, "id" | "profileId" | "profileName">) {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [id]: { ...(s.sessions[id] ?? newSession(updates)), ...updates } },
  }));
}

function newSession({ id, profileId, profileName }: Pick<Session, "id" | "profileId" | "profileName">): Session {
  return {
    id,
    profileId,
    profileName,
    lifecycleState: "connecting",
    ioState: "stopped",
    capabilities: null,
    errorMessage: null,
    subscriberCount: 0,
    frameCount: 0,
    uniqueFrameCount: 0,
    byteCount: 0,
    capture: emptyCapture(),
    createdAt: Date.now(),
    hasQueuedMessages: false,
    speed: null,
    playbackPosition: null,
    catalogPath: null,
    bytesCaptureId: null,
    pausedSourceProfileIds: [],
    originProfileIds: [],
  };
}

async function leaveNow(sessionId: string, subscriberId: string): Promise<void> {
  const { getState, setState } = useSessionStore;
  const eventListeners = getState()._eventListeners[sessionId];
  try {
    const remaining = await unregisterSessionSubscriber(sessionId, subscriberId);
    if (!eventListeners) return;
    eventListeners.callbacks.delete(subscriberId);
    eventListeners.registeredSubscribers.delete(subscriberId);
    if (eventListeners.callbacks.size > 0) {
      updateSession(sessionId, { subscriberCount: remaining });
      return;
    }
    // unregisterSessionSubscriber already stopped and destroyed the session in Rust if it was the last.
    cleanupEventListeners(eventListeners);
    setState((s) => {
      const { [sessionId]: _, ...remainingSessions } = s.sessions;
      const { [sessionId]: __, ...remainingListeners } = s._eventListeners;
      // A session with queued messages stays, disconnected, for the Transmit dropdown.
      const kept = s.sessions[sessionId]?.hasQueuedMessages
        ? { ...remainingSessions, [sessionId]: { ...s.sessions[sessionId], lifecycleState: "disconnected" as const, subscriberCount: 0 } }
        : remainingSessions;
      return {
        sessions: kept,
        _eventListeners: remainingListeners,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
      };
    });
  } catch {
    // Ignore - session may already be gone
  }
}

/**
 * Create a new multi-source session that merges frames from multiple devices.
 * This creates a Rust-side merged session that other apps can join.
 *
 * @param options Configuration for the multi-source session
 * @returns The session result, with the buses Rust gave each source
 */
export async function createAndStartMultiSourceSession(
  options: CreateMultiSourceOptions
): Promise<{ busMappings: Map<string, BusMapping[]> }> {
  const {
    sessionId,
    subscriberId,
    appName,
    profileIds,
    busOverrides,
    profileNames,
    framingEncoding,
    delimiter,
    maxFrameLength,
    minFrameLength,
    emitRawBytes,
    perInterfaceFraming,
    frameIdStartByte,
    frameIdBytes,
    frameIdBigEndian,
    sourceAddressStartByte,
    sourceAddressBytes,
    sourceAddressBigEndian,
  } = options;

  // Build source configs with bus mappings and framing config
  const sources: MultiSourceInput[] = profileIds.map((profileId) => {
    // Check for per-interface framing override
    const interfaceFraming = perInterfaceFraming?.get(profileId);

    // Use per-interface framing if specified, otherwise fall back to session-level.
    // Every field the picker offers per device has to be listed here — anything
    // omitted falls through to a session-level value the per-device controls
    // never write, which is how "Capture raw bytes" and "Validate CRC" came to
    // do nothing at all.
    const sourceFramingEncoding = interfaceFraming?.encoding ?? framingEncoding;
    const sourceDelimiter = interfaceFraming?.delimiterHex
      ? hexToBytes(interfaceFraming.delimiterHex)
      : delimiter;

    // For "raw" framing mode, raw bytes are the only output, so the tick is moot
    const sourceEmitRawBytes =
      sourceFramingEncoding === "raw"
        ? true
        : (interfaceFraming?.emitRawBytes ?? emitRawBytes);

    return {
      profile_id: profileId,
      display_name: profileNames?.get(profileId),
      overrides: busOverrides?.get(profileId),
      // Apply framing config (per-interface or session-level)
      // Serial sources will use these overrides, CAN sources will ignore them
      ...serialPayload({
        framingEncoding: sourceFramingEncoding,
        delimiter: sourceDelimiter,
        maxFrameLength: interfaceFraming?.maxFrameLength ?? maxFrameLength,
        minFrameLength,
        emitRawBytes: sourceEmitRawBytes,
        modbusValidateCrc: interfaceFraming?.validateCrc,
        modbusDeviceAddress: interfaceFraming?.deviceAddress,
        modbusVendorFunctions: interfaceFraming?.vendorFunctions,
        modbusAllowBroadcast: interfaceFraming?.allowBroadcast,
        modbusAnyFunction: interfaceFraming?.anyFunction,
        // Frame ID extraction config (from catalog)
        frameIdStartByte,
        frameIdBytes,
        frameIdBigEndian,
        sourceAddressStartByte,
        sourceAddressBytes,
        sourceAddressBigEndian,
      }),
    };
  });

  const opened = await inOrder(subscriberId, () =>
    openNow(sessionId, sessionId, subscriberId, appName, { sessionId, sources, modbusPollsJson: options.modbusPollsJson })
  );
  return { busMappings: new Map(Object.entries(opened.bus_mappings ?? {})) };
}
