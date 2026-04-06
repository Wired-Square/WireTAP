// ui/src/stores/sessionStore.ts
//
// Centralized IO session manager for all apps (Discovery, Decoder, Transmit).
// Session lifecycle and subscriber management is handled by Rust backend.
// This store manages frontend state and event listeners.

import * as Sentry from "@sentry/react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { WINDOW_EVENTS } from "../events/registry";
import {
  createIOSession,
  getIOSessionState,
  getIOSessionCapabilities,
  startReaderSession,
  stopReaderSession,
  pauseReaderSession,
  resumeReaderSession,
  suspendReaderSession,
  resumeReaderSessionFresh,
  resumeSessionToLive,
  switchSessionToCaptureReplay,
  updateReaderSpeed,
  updateReaderTimeRange,
  destroyReaderSession,
  seekReaderSession,
  seekReaderSessionByFrame,
  transitionToCaptureSource,
  sessionTransmitFrame,
  registerSessionSubscriber,
  unregisterSessionSubscriber,
  reinitializeSessionIfSafe,
  createMultiSourceSession,
  getStateType,
  type IOCapabilities,
  type IOStateType,
  type StreamEndedInfo,
  type SessionSuspendedPayload,
  type SessionSwitchedToCapturePayload,
  type SessionResumingPayload,
  type SourceReplacedPayload,
  type CanTransmitFrame,
  type TransmitResult,
  type CreateIOSessionOptions,
  type FramingEncoding,
  type MultiSourceInput,
  type BusMapping,
  type PlaybackPosition,
  type RawBytesPayload,
} from "../api/io";
import type { FrameMessage } from "../types/frame";
import { tlog } from "../api/settings";
import { trackAlloc } from "../services/memoryDiag";
import {
  useSessionLogStore,
  type SessionLogEventType,
} from "../apps/session-manager/stores/sessionLogStore";
import { wsTransport } from "../services/wsTransport";
import {
  MsgType,
  HEADER_SIZE,
  decodeFrameBatch,
  decodeSessionState,
  decodeStreamEnded,
  decodeSessionError,
  decodePlaybackPosition,
  decodeSessionInfo,
  decodeScopedSessionLifecycle,
} from "../services/wsProtocol";

// ============================================================================
// Visibility: Log changes and send immediate heartbeats on wake.
// When the display sleeps, WKWebView may throttle/suspend timers.
// The Rust watchdog pauses the session after HEARTBEAT_TIMEOUT (30s).
// When the display wakes, we immediately send heartbeats so the Rust
// backend can resume the session before the grace period expires.
// ============================================================================

// HMR guard: remove previous handler before adding.
// Use a property on `window` so the reference survives module re-evaluation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prevHandler = (window as any).__wiretap_visibilityHandler as (() => void) | undefined;
if (prevHandler) {
  document.removeEventListener("visibilitychange", prevHandler);
}
const _visibilityHandler = () => {
  tlog.info(`[visibility] ${document.visibilityState}`);

  if (document.visibilityState === "visible" && getEventListeners) {
    // Page just became visible — immediately send heartbeats for all sessions
    // to revive any sessions that were paused during display sleep / App Nap.
    const eventListenersMap = getEventListeners();
    for (const [sessionId, listeners] of Object.entries(eventListenersMap)) {
      if (listeners.registeredSubscribers.size > 0) {
        tlog.info(`[visibility] sending immediate heartbeats for session '${sessionId}' (${listeners.registeredSubscribers.size} listeners)`);
        for (const lid of listeners.registeredSubscribers) {
          registerSessionSubscriber(sessionId, lid).catch((e) => {
            tlog.info(`[visibility] heartbeat failed for ${sessionId}/${lid}: ${e}`);
          });
        }
      }
    }
  }
};
document.addEventListener("visibilitychange", _visibilityHandler);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__wiretap_visibilityHandler = _visibilityHandler;

// ============================================================================
// Session Logging Helper
// ============================================================================

/** Input for addSessionLog - same as LogEntry but without id/timestamp */
interface SessionLogInput {
  eventType: SessionLogEventType;
  sessionId: string | null;
  profileId: string | null;
  profileName: string | null;
  appName: string | null;
  details: string;
}

/** Safely add a session log entry (no-op if store not mounted) */
function addSessionLog(entry: SessionLogInput) {
  try {
    useSessionLogStore.getState().addEntry(entry);
  } catch {
    // Ignore if store not mounted yet
  }
}

/**
 * Check if a profile ID represents a capture.
 * Checks against the cached set of known capture IDs from the Rust backend.
 * The set is populated on app startup and updated when buffers are created/deleted.
 */
export function isCaptureProfileId(profileId: string | null): boolean {
  if (!profileId) return false;
  return useSessionStore.getState().knownCaptureIds.has(profileId);
}

/** Getter for event listeners - set after store is created */
let getEventListeners: (() => Record<string, SessionEventSubscribers>) | null = null;

/** Getter for showAppError - set after store is created */
let getGlobalShowAppError: (() => ((title: string, message: string, details?: string) => void) | null) | null = null;

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
  /** Whether the session was stopped explicitly by user (vs stream ending naturally) */
  stoppedExplicitly: boolean;
  /** Reason why the stream ended (from stream-ended event) */
  streamEndedReason: "complete" | "stopped" | "disconnected" | "error" | null;
  /** Current playback speed (null until set, 1 = realtime, 0 = unlimited) */
  speed: number | null;
  /** Current playback position (centralised for all apps sharing this session) */
  playbackPosition: PlaybackPosition | null;
  /** Decoder catalog path for this session (frontend-only, shared across apps) */
  catalogPath: string | null;
  /** Capture ID for raw bytes streams (set when capture-changed signal fires) */
  bytesCaptureId: string | null;
}

/** Options for creating a session */
export interface CreateSessionOptions {
  /** Custom session ID (defaults to auto-generated) */
  sessionId?: string;
  /** Join existing session if profile is in use (default: true for single-handle profiles) */
  joinExisting?: boolean;
  /** Only join sessions that produce frames (not raw bytes) */
  requireFrames?: boolean;
  /** Start time for time-range capable readers (ISO-8601) */
  startTime?: string;
  /** End time for time-range capable readers (ISO-8601) */
  endTime?: string;
  /** Initial playback speed */
  speed?: number;
  /** Maximum number of frames to read */
  limit?: number;
  /** File path for file-based readers */
  filePath?: string;
  /** Use the shared capture source */
  useBuffer?: boolean;
  /** Framing encoding for serial readers */
  framingEncoding?: FramingEncoding;
  /** Delimiter bytes for delimiter-based framing */
  delimiter?: number[];
  /** Maximum frame length for delimiter-based framing */
  maxFrameLength?: number;
  /** Also emit raw bytes in addition to frames */
  emitRawBytes?: boolean;
  /** Minimum frame length to accept */
  minFrameLength?: number;
  /** Bus number override for single-bus devices (0-7) */
  busOverride?: number;
  /** Skip auto-starting playback sources (postgres, csv) - for connect-only mode */
  skipAutoStart?: boolean;
  /** Modbus TCP poll groups as JSON string (catalog-derived, for modbus_tcp profiles) */
  modbusPollsJson?: string;
}

/** Payload for session-reconfigured event (now empty — apps just clear state) */
export type SessionReconfiguredPayload = Record<string, never>;

/** Callbacks for a session - stored per subscriber in the frontend */
export interface SessionCallbacks {
  onFrames?: (frames: FrameMessage[]) => void;
  onBytes?: (payload: RawBytesPayload) => void;
  onError?: (error: string) => void;
  onTimeUpdate?: (position: PlaybackPosition) => void;
  onStreamEnded?: (payload: StreamEndedInfo) => void;
  onStreamComplete?: () => void;
  onStateChange?: (state: IOStateType) => void;
  onSpeedChange?: (speed: number) => void;
  /** Called when session is reconfigured (e.g., bookmark jump) - apps should clear state */
  onReconfigure?: (payload: SessionReconfiguredPayload) => void;
  /** Called when session is suspended (stopped with capture available) */
  onSuspended?: (payload: SessionSuspendedPayload) => void;
  /** Called when session is stopped and switched to capture replay (all subscribers transition) */
  onSwitchedToCapture?: (payload: SessionSwitchedToCapturePayload) => void;
  /** Called when session is resuming with a new capture - apps should clear their frame lists */
  onResuming?: (payload: SessionResumingPayload) => void;
  /** Called when the session's device is replaced in-place (caps/state change, subscribers preserved) */
  onSourceReplaced?: (payload: SourceReplacedPayload) => void;
}

/** Session event listeners - one set per session */
interface SessionEventSubscribers {
  /** Session ID this subscriber set belongs to (for WS unsubscribe on cleanup) */
  sessionId: string;
  /** Unlisten functions for Tauri events */
  unlistenFunctions: UnlistenFn[];
  /** Unlisten functions for WebSocket message handlers */
  wsUnlistenFunctions: (() => void)[];
  /** Callbacks registered by subscribers, keyed by subscriber ID */
  callbacks: Map<string, SessionCallbacks>;
  /** Heartbeat interval ID (for keeping listeners alive in Rust backend) */
  heartbeatIntervalId: ReturnType<typeof setInterval> | null;
  /** Listener IDs that need heartbeats (separate from callbacks for timing) */
  registeredSubscribers: Set<string>;
}

// ============================================================================
// Store Interface
// ============================================================================

export interface SessionStore {
  // ---- Data ----
  /** All sessions keyed by session ID */
  sessions: Record<string, Session>;
  /** Currently selected session ID for transmission (Transmit app) */
  activeSessionId: string | null;
  /** Event listeners per session (frontend-only, for routing events to callbacks) */
  _eventListeners: Record<string, SessionEventSubscribers>;
  /** Cached set of known capture IDs (populated from Rust backend on startup) */
  knownCaptureIds: Set<string>;

  // ---- Actions: Session Lifecycle ----
  /** Open a session - creates if not exists, joins if exists */
  openSession: (
    profileId: string,
    profileName: string,
    subscriberId: string,
    appName: string,
    options?: CreateSessionOptions
  ) => Promise<Session>;
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
  /** Suspend a session - stops streaming, finalises capture, session stays alive */
  suspendSession: (sessionId: string) => Promise<void>;
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
  /** Get all sessions as array */
  getAllSessions: () => Session[];
  /** Get transmit-capable sessions */
  getTransmitCapableSessions: () => Session[];
  /** Check if profile is in use by any session */
  isProfileInUse: (profileId: string) => boolean;
  /** Get session for a profile (if one exists) */
  getSessionForProfile: (profileId: string) => Session | undefined;
  /** Get sessions for Transmit dropdown (connected + disconnected with queue) */
  getTransmitDropdownSessions: () => Session[];

  // ---- Global App Error Dialog ----
  /** Global app error dialog state (shown for errors across the app) */
  appErrorDialog: {
    isOpen: boolean;
    title: string;
    message: string;
    details: string | null;
  };
  /** Show the global app error dialog */
  showAppError: (title: string, message: string, details?: string) => void;
  /** Close the global app error dialog */
  closeAppError: () => void;
  /** Set the decoder catalog path for a session (frontend-only, shared across apps) */
  setSessionCatalogPath: (sessionId: string, catalogPath: string | null) => void;

  // ---- Cross-App Session Join ----
  /** Pending session joins keyed by app name (e.g., "transmit", "graph") */
  pendingJoins: Record<string, { sessionId: string }>;
  /** Request that an app auto-joins a session (called by source apps) */
  requestSessionJoin: (appName: string, sessionId: string) => void;
  /** Clear a pending join for an app (consumed by useIOSessionManager) */
  clearPendingJoin: (appName: string) => void;

  // ---- Buffer ID Registry ----
  /** Load all buffer IDs from the backend into the cached set */
  loadCaptureIds: () => Promise<void>;
  /** Add a buffer ID to the cached set (call when a buffer is created) */
  addKnownCaptureId: (id: string) => void;
  /** Remove a buffer ID from the cached set (call when a buffer is deleted) */
  removeKnownCaptureId: (id: string) => void;
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Invoke all callbacks for an event type */
function invokeCallbacks<T>(
  eventListeners: SessionEventSubscribers,
  eventType: keyof SessionCallbacks,
  payload: T
) {
  for (const [, callbacks] of eventListeners.callbacks.entries()) {
    const cb = callbacks[eventType] as ((arg: T) => void) | undefined;
    if (cb) {
      cb(payload);
    }
  }
}

/** Set up Tauri event listeners for a session */
async function setupSessionEventSubscribers(
  sessionId: string,
  eventListeners: SessionEventSubscribers,
  updateSession: (id: string, updates: Partial<Session>) => void
): Promise<UnlistenFn[]> {
  // ==========================================================================
  // WebSocket binary message handlers (sole push path — Tauri events removed)
  // ==========================================================================

  // Subscribe to WS channel
  if (wsTransport.isConnected) {
    wsTransport.subscribe(sessionId).catch(() => {});
  }

  if (wsTransport.isConnected) {
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

    // SessionState (0x02) — state string + optional error decoded from binary
    eventListeners.wsUnlistenFunctions.push(
      wsTransport.onSessionMessage(sessionId, MsgType.SessionState, (payload) => {
        const { state, errorMsg } = decodeSessionState(payload);
        const stateType = state as IOStateType;
        updateSession(sessionId, {
          ioState: stateType,
          ...(errorMsg ? { errorMessage: errorMsg } : {}),
        });
        invokeCallbacks(eventListeners, "onStateChange", stateType);
      })
    );

    // StreamEnded (0x03) — full stream-ended info decoded from binary
    eventListeners.wsUnlistenFunctions.push(
      wsTransport.onSessionMessage(sessionId, MsgType.StreamEnded, (payload) => {
        const info = decodeStreamEnded(payload);
        const ioState = info.reason === "paused" ? "paused" : "stopped";
        updateSession(sessionId, {
          ioState: ioState as IOStateType,
          streamEndedReason: info.reason as Session["streamEndedReason"],
          capture: {
            available: info.capture_available,
            id: info.capture_id,
            kind: info.capture_kind as "frames" | "bytes" | null,
            count: info.count,
            owningSessionId: sessionId,
            startTimeUs: info.time_range?.[0] ?? null,
            endTimeUs: info.time_range?.[1] ?? null,
            name: useSessionStore.getState().sessions[sessionId]?.capture?.name ?? null,
            persistent: useSessionStore.getState().sessions[sessionId]?.capture?.persistent ?? false,
          },
        });
        if (info.capture_id) {
          useSessionStore.getState().addKnownCaptureId(info.capture_id);
        }
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

    // SessionError (0x04) — error string decoded from binary
    eventListeners.wsUnlistenFunctions.push(
      wsTransport.onSessionMessage(sessionId, MsgType.SessionError, (payload) => {
        const error = decodeSessionError(
          new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
        );
        if (error) {
          const isExpectedError =
            error === "No IO profile configured" ||
            error.includes("not found") ||
            error.includes("Modbus read error");
          if (!isExpectedError) {
            invokeCallbacks(eventListeners, "onError", error);
            if (typeof getGlobalShowAppError === "function") {
              const showAppError = getGlobalShowAppError();
              if (showAppError) {
                showAppError("Stream Error", "An error occurred while streaming.", error);
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

    // Reconfigured (0x0A) — signal-only, no payload to decode
    eventListeners.wsUnlistenFunctions.push(
      wsTransport.onSessionMessage(sessionId, MsgType.Reconfigured, () => {
        tlog.debug(`[sessionStore] Session '${sessionId}' reconfigured (WS)`);
        invokeCallbacks(eventListeners, "onReconfigure", {} as SessionReconfiguredPayload);
      })
    );

    // SessionLifecycle (0x08) — state + capabilities decoded from binary payload
    eventListeners.wsUnlistenFunctions.push(
      wsTransport.onSessionMessage(sessionId, MsgType.SessionLifecycle, (payload) => {
        const { stateType, capabilities } = decodeScopedSessionLifecycle(payload);
        const prevSession = useSessionStore.getState().sessions[sessionId];
        const prevState = prevSession?.ioState;

        const updates: Partial<Session> = { ioState: stateType as Session["ioState"] };
        if (capabilities) {
          updates.capabilities = capabilities as IOCapabilities;
        }

        const isNowRunning = stateType === "running" || stateType === "starting";
        const wasStoppedOrPaused = prevState === "stopped" || prevState === "paused";
        const isNowStopped = stateType === "stopped";

        if (isNowRunning && wasStoppedOrPaused) {
          updates.stoppedExplicitly = false;
          updates.streamEndedReason = null;
          updates.capture = {
            available: false,
            id: null,
            kind: null,
            count: 0,
            owningSessionId: sessionId,
            startTimeUs: null,
            endTimeUs: null,
            name: null,
            persistent: false,
          };
          updateSession(sessionId, updates);
          invokeCallbacks(eventListeners, "onResuming", { new_capture_id: "", orphaned_capture_id: null });
        } else if (isNowStopped && (capabilities as IOCapabilities | null)?.traits.temporal_mode === "capture") {
          updateSession(sessionId, updates);
          invokeCallbacks(eventListeners, "onSwitchedToCapture", {
            capture_id: prevSession?.capture?.id ?? null,
            capture_count: prevSession?.capture?.count ?? 0,
            capture_kind: prevSession?.capture?.kind ?? null,
            time_range: null,
            capabilities: capabilities as IOCapabilities,
          });
          // Refresh capture fields from backend — after a live→capture transition
          // (e.g. stopAndSwitchToCapture), StreamEnded may not have landed yet or
          // may have been clobbered by an intermediate `running` lifecycle blip
          // that resets capture to zeros at line 619. Fetch fresh metadata so
          // session.capture.count reflects reality for the tooltip/Tools button.
          const captureId = prevSession?.capture?.id ?? null;
          if (captureId) {
            import("../api/capture").then(({ getCaptureMetadataById }) =>
              getCaptureMetadataById(captureId).then((meta) => {
                if (meta) {
                  const currentSession = useSessionStore.getState().sessions[sessionId];
                  if (currentSession) {
                    updateSession(sessionId, {
                      capture: {
                        ...currentSession.capture,
                        available: true,
                        id: meta.id,
                        kind: meta.kind,
                        count: meta.count,
                        startTimeUs: meta.start_time_us,
                        endTimeUs: meta.end_time_us,
                        name: meta.name,
                        persistent: meta.persistent,
                      },
                    });
                  }
                }
              }).catch(() => {/* ignore */})
            );
          }
        } else if (isNowStopped) {
          updateSession(sessionId, updates);
          invokeCallbacks(eventListeners, "onSuspended", {
            capture_id: prevSession?.capture?.id ?? null,
            capture_count: prevSession?.capture?.count ?? 0,
            capture_kind: prevSession?.capture?.kind ?? null,
            time_range: null,
          });
        } else {
          updateSession(sessionId, updates);
          if (capabilities) {
            invokeCallbacks(eventListeners, "onSourceReplaced", {
              previous_source_type: "",
              new_source_type: "",
              capabilities: capabilities as IOCapabilities,
              state: stateType,
              transition: "",
            });
          }
        }
      })
    );
  }

  return [];
}

/** Clean up session event listeners */
function cleanupEventListeners(eventListeners: SessionEventSubscribers) {
  // Clear heartbeat interval
  if (eventListeners.heartbeatIntervalId) {
    clearInterval(eventListeners.heartbeatIntervalId);
    eventListeners.heartbeatIntervalId = null;
  }

  // Unlisten from Tauri events
  for (const unlisten of eventListeners.unlistenFunctions) {
    unlisten();
  }
  eventListeners.unlistenFunctions = [];

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
  activeSessionId: null,
  _eventListeners: {},
  knownCaptureIds: new Set<string>(),
  pendingJoins: {},
  appErrorDialog: {
    isOpen: false,
    title: "",
    message: "",
    details: null,
  },

  // ---- Session Lifecycle ----
  openSession: async (profileId, profileName, subscriberId, appName, options = {}) => {
    tlog.debug(`[sessionStore:openSession] Called with profileId=${profileId}, profileName=${profileName}, subscriberId=${subscriberId}`);
    console.log(`[sessionStore:openSession] Options: ${JSON.stringify(options)}`);

    // Session ID can be explicitly provided (for recorded sources that need unique IDs)
    // or defaults to profile ID (for realtime sources that share sessions)
    const sessionId = options.sessionId ?? profileId;

    // Step 1: Check if we already have this session in our store
    const existingSession = get().sessions[sessionId];
    console.log(`[sessionStore:openSession] existingSession lifecycle=${existingSession?.lifecycleState}`);
    if (existingSession?.lifecycleState === "connected") {
      // Register this listener with Rust backend
      try {
        const result = await registerSessionSubscriber(sessionId, subscriberId, appName);

        // Handle startup error (error that occurred before listener registered)
        if (result.startup_error) {
          get().showAppError("Stream Error", "An error occurred while starting the session.", result.startup_error);
        }

        // Add listener to heartbeat tracking
        const eventListeners = get()._eventListeners[sessionId];
        if (eventListeners) {
          eventListeners.registeredSubscribers.add(subscriberId);
        }

        // Update session with latest info from Rust
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...s.sessions[sessionId],
              subscriberCount: result.subscriber_count,
            },
          },
        }));

        return get().sessions[sessionId];
      } catch {
        // Session doesn't exist in backend, will create below
      }
    }

    // Step 2: Check if session exists in backend
    const existingCaps = await getIOSessionCapabilities(sessionId);
    const existingState = await getIOSessionState(sessionId);
    const backendExists = existingCaps && existingState?.type !== "Error";
    console.log(`[sessionStore:openSession] backendExists=${backendExists}, existingState.type=${existingState?.type}`);

    // Step 3: Destroy error session if exists
    if (existingCaps && existingState?.type === "Error") {
      try {
        await destroyReaderSession(sessionId);
      } catch {
        // Ignore
      }
    }

    // Step 4: Create or join the backend session
    let capabilities: IOCapabilities;
    let ioState: IOStateType = "stopped";
    let subscriberCount = 1;
    let captureId: string | null = null;
    let captureKind: "frames" | "bytes" | null = null;

    if (backendExists) {
      // Join existing backend session using registerSessionSubscriber only
      // Don't call joinReaderSession - it increments joiner_count separately from the listener map,
      // which causes count to overshoot when React StrictMode double-mounts components
      console.log(`[sessionStore:openSession] Backend exists, joining session ${sessionId}`);
      const regResult = await registerSessionSubscriber(sessionId, subscriberId, appName);
      capabilities = regResult.capabilities;
      ioState = getStateType(regResult.state);
      subscriberCount = regResult.subscriber_count;
      captureId = regResult.capture_id;
      captureKind = regResult.capture_kind;

      // Handle startup error (error that occurred before listener registered)
      if (regResult.startup_error) {
        get().showAppError("Stream Error", "An error occurred while starting the session.", regResult.startup_error);
      }

      // Log session-joined event
      addSessionLog({
        eventType: "session-joined",
        sessionId,
        profileId,
        profileName,
        appName,
        details: `Joined existing session (${subscriberCount} listeners, state: ${ioState})`,
      });
    } else {
      // Create new backend session
      console.log(`[sessionStore:openSession] Backend does not exist, creating new session`);
      // Auto-detect buffer mode from profile ID (supports both legacy and new buffer ID formats)
      const isCaptureMode = isCaptureProfileId(profileId) || options.useBuffer;
      console.log(`[sessionStore:openSession] isCaptureMode=${isCaptureMode}`);

      const createOptions: CreateIOSessionOptions = {
        sessionId,
        profileId: isCaptureMode ? undefined : profileId, // Don't pass fake profile ID for buffer mode
        captureId: isCaptureMode ? profileId : undefined, // Pass buffer ID so Rust registers it as source
        startTime: options.startTime,
        endTime: options.endTime,
        // For buffer mode, default to 1x speed (paced playback) instead of 0 (no pacing)
        speed: options.speed ?? (isCaptureMode ? 1.0 : undefined),
        limit: options.limit,
        filePath: options.filePath,
        useBuffer: isCaptureMode,
        framingEncoding: options.framingEncoding,
        delimiter: options.delimiter,
        maxFrameLength: options.maxFrameLength,
        emitRawBytes: options.emitRawBytes,
        minFrameLength: options.minFrameLength,
        busOverride: options.busOverride,
        subscriberId, // For session logging
        appName, // Human-readable app name
        modbusPollsJson: options.modbusPollsJson,
      };

      try {
        console.log(`[sessionStore:openSession] Calling createIOSession with options:`, JSON.stringify(createOptions));
        capabilities = await createIOSession(createOptions);
        console.log(`[sessionStore:openSession] createIOSession succeeded`);

        // For buffer mode, the session IS the buffer — set buffer ID so actions can find it
        if (isCaptureMode) {
          captureId = profileId;
          captureKind = "frames"; // Buffer sessions default to frames
        }

        // Backend auto-starts the session, so query the actual state
        const currentState = await getIOSessionState(sessionId);
        if (currentState) {
          ioState = getStateType(currentState);
        }

        // Register as owner listener
        try {
          const regResult = await registerSessionSubscriber(sessionId, subscriberId, appName);
          subscriberCount = regResult.subscriber_count;
          // Pick up buffer info from the registration result (more accurate than our guess)
          if (regResult.capture_id) captureId = regResult.capture_id;
          if (regResult.capture_kind) captureKind = regResult.capture_kind;
          // Handle startup error (error that occurred before listener registered)
          if (regResult.startup_error) {
            get().showAppError("Stream Error", "An error occurred while starting the session.", regResult.startup_error);
          }
        } catch {
          // Ignore
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        // If profile is in use, try to join instead using registerSessionSubscriber only
        if (msg.includes("Profile is in use by session")) {
          const regResult = await registerSessionSubscriber(sessionId, subscriberId, appName);
          capabilities = regResult.capabilities;
          ioState = getStateType(regResult.state);
          subscriberCount = regResult.subscriber_count;
          captureId = regResult.capture_id;
          captureKind = regResult.capture_kind;

          // Handle startup error (error that occurred before listener registered)
          if (regResult.startup_error) {
            get().showAppError("Stream Error", "An error occurred while starting the session.", regResult.startup_error);
          }
        } else {
          // Create error session entry
          const errorSession: Session = {
            id: sessionId,
            profileId,
            profileName,
            lifecycleState: "error",
            ioState: "error",
            capabilities: null,
            errorMessage: msg,
            subscriberCount: 0,
            capture: { available: false, id: null, kind: null, count: 0, owningSessionId: null, startTimeUs: null, endTimeUs: null, name: null, persistent: false },
            createdAt: Date.now(),
            hasQueuedMessages: false,
            stoppedExplicitly: false,
            streamEndedReason: null,
            speed: null,
            playbackPosition: null,
            catalogPath: null,
            bytesCaptureId: null,
          };
          set((s) => ({
            sessions: { ...s.sessions, [sessionId]: errorSession },
          }));
          throw e;
        }
      }
    }

    // Step 5: Set up event listeners if needed
    // Use a synchronous check-and-set pattern to avoid race conditions
    // where two callers both see no event listeners and both try to create them
    let eventListeners = get()._eventListeners[sessionId];
    if (!eventListeners) {
      // Create the structure first and immediately set it in the store
      // This prevents race conditions where another caller also tries to create
      eventListeners = {
        sessionId,
        unlistenFunctions: [],
        wsUnlistenFunctions: [],
        callbacks: new Map(),
        heartbeatIntervalId: null,
        registeredSubscribers: new Set(),
      };

      // Set immediately BEFORE async setup to claim the slot
      set((s) => {
        // Double-check another caller didn't beat us
        if (s._eventListeners[sessionId]) {
          // Someone else created it, use theirs
          eventListeners = s._eventListeners[sessionId];
          return s; // No change needed
        }
        return {
          ...s,
          _eventListeners: { ...s._eventListeners, [sessionId]: eventListeners! },
        };
      });

      // Re-fetch in case another caller won the race
      eventListeners = get()._eventListeners[sessionId]!;

      // Only set up Tauri listeners if we don't have any yet
      if (eventListeners.unlistenFunctions.length === 0) {
        const updateSession = (id: string, updates: Partial<Session>) => {
          set((s) => ({
            sessions: {
              ...s.sessions,
              [id]: s.sessions[id] ? { ...s.sessions[id], ...updates } : s.sessions[id],
            },
          }));
        };

        eventListeners.unlistenFunctions = await setupSessionEventSubscribers(
          sessionId,
          eventListeners,
          updateSession
        );

        // Heartbeat keepalive for the Rust IO session watchdog.
        // When WS is connected, the WS server bridges its 10s heartbeat to
        // touch IO listener timestamps — no invoke polling needed.
        // Fall back to invoke-based heartbeats only when WS is unavailable.
        if (!eventListeners.heartbeatIntervalId && !wsTransport.isConnected) {
          const heartbeatSessionId = sessionId;
          eventListeners.heartbeatIntervalId = setInterval(async () => {
            const listeners = get()._eventListeners[heartbeatSessionId];
            if (!listeners || listeners.registeredSubscribers.size === 0) return;

            tlog.info(
              `[heartbeat:${heartbeatSessionId}] sending for ${listeners.registeredSubscribers.size} listener(s)`
            );

            for (const lid of listeners.registeredSubscribers) {
              try {
                await registerSessionSubscriber(heartbeatSessionId, lid);
              } catch (e) {
                tlog.info(
                  `[heartbeat:${heartbeatSessionId}] failed for ${lid}: ${e}`
                );
              }
            }
          }, 5000);
        }
      }
    }

    // Add this listener to the registered listeners set for heartbeat tracking
    const currentEventListeners = get()._eventListeners[sessionId];
    if (currentEventListeners) {
      currentEventListeners.registeredSubscribers.add(subscriberId);
    }

    // Step 5.5: Start the session if it's still stopped (for playback sources like PostgreSQL, CSV)
    // Playback sources don't auto-start on the backend to avoid emitting frames before listeners are ready.
    // Now that event listeners are set up, we can safely start.
    // EXCEPTION 1: Buffer mode should NOT auto-start - data is already in the buffer store
    // and can be accessed via pagination without streaming. User can start playback manually.
    // EXCEPTION 2: skipAutoStart option - for connect-only mode (Query app) where we want
    // to create the session but not start streaming until user explicitly requests it.
    const isCaptureSession = isCaptureProfileId(profileId);
    const shouldAutoStart = ioState === "stopped" && !isCaptureSession && !options.skipAutoStart;
    if (shouldAutoStart) {
      try {
        await startReaderSession(sessionId);
        ioState = "running";
      } catch {
        // Session might have been started by another caller - continue anyway
      }
    }

    // Step 6: Create session entry
    // IMPORTANT: Use a function updater to preserve any subscriberCount updates
    // that may have occurred via events while we were setting up.
    // The `subscriberCount` variable may be stale by now.
    set((s) => {
      // Check if session already exists with a higher listener count
      // (could have been updated by session-info event)
      const existingSession = s.sessions[sessionId];
      const currentListenerCount = existingSession?.subscriberCount ?? 0;
      const finalListenerCount = Math.max(subscriberCount, currentListenerCount);

      const session: Session = {
        id: sessionId,
        profileId,
        profileName,
        lifecycleState: "connected",
        ioState,
        capabilities,
        errorMessage: null,
        subscriberCount: finalListenerCount,
        capture: {
          available: false,
          id: captureId,
          kind: captureKind,
          count: 0,
          owningSessionId: null,
          startTimeUs: existingSession?.capture?.startTimeUs ?? null,
          endTimeUs: existingSession?.capture?.endTimeUs ?? null,
          name: existingSession?.capture?.name ?? null,
          persistent: existingSession?.capture?.persistent ?? false,
        },
        createdAt: existingSession?.createdAt ?? Date.now(),
        hasQueuedMessages: existingSession?.hasQueuedMessages ?? false,
        stoppedExplicitly: existingSession?.stoppedExplicitly ?? false,
        streamEndedReason: existingSession?.streamEndedReason ?? null,
        speed: existingSession?.speed ?? null,
        playbackPosition: existingSession?.playbackPosition ?? null,
        catalogPath: existingSession?.catalogPath ?? null,
        bytesCaptureId: existingSession?.bytesCaptureId ?? null,
      };

      return {
        sessions: { ...s.sessions, [sessionId]: session },
      };
    });

    // For buffer-mode sessions, fetch capture metadata to populate the
    // session's capture fields. Without this, count/available/kind/times
    // stay at their initial zero values forever — which makes the session
    // tooltip show "Frames: 0, Unique: 0" and breaks any downstream code
    // that reads session.capture.count (e.g. the Discovery top-bar tooltip).
    if (captureId) {
      import("../api/capture").then(({ getCaptureMetadataById }) =>
        getCaptureMetadataById(captureId!).then((meta) => {
          if (meta) {
            const currentSession = get().sessions[sessionId];
            if (currentSession && currentSession.capture.id === captureId) {
              set((s) => ({
                sessions: {
                  ...s.sessions,
                  [sessionId]: {
                    ...s.sessions[sessionId],
                    capture: {
                      ...s.sessions[sessionId].capture,
                      available: true,
                      kind: meta.kind,
                      count: meta.count,
                      startTimeUs: meta.start_time_us,
                      endTimeUs: meta.end_time_us,
                      name: meta.name,
                      persistent: meta.persistent,
                    },
                  },
                },
              }));
            }
          }
        }).catch(() => {/* ignore */})
      );
    }

    tlog.debug(`[sessionStore:openSession] Complete - returning session for ${sessionId}`);
    return get().sessions[sessionId];
  },

  leaveSession: async (sessionId, subscriberId) => {
    console.log(`[sessionStore:leaveSession] Called with sessionId=${sessionId}, subscriberId=${subscriberId}`);
    const eventListeners = get()._eventListeners[sessionId];
    console.log(`[sessionStore:leaveSession] eventListeners exists=${!!eventListeners}`);

    try {
      // Unregister listener from Rust backend
      console.log(`[sessionStore:leaveSession] Calling unregisterSessionSubscriber...`);
      const remaining = await unregisterSessionSubscriber(sessionId, subscriberId);
      console.log(`[sessionStore:leaveSession] unregisterSessionSubscriber returned remaining=${remaining}`);

      // Log session-left event
      const session = get().sessions[sessionId];
      addSessionLog({
        eventType: "session-left",
        sessionId,
        profileId: session?.profileId ?? null,
        profileName: session?.profileName ?? null,
        appName: subscriberId,
        details: `Left session (${remaining} listeners remaining)`,
      });

      // Remove callbacks and registered listener for heartbeats
      if (eventListeners) {
        eventListeners.callbacks.delete(subscriberId);
        eventListeners.registeredSubscribers.delete(subscriberId);
        console.log(`[sessionStore:leaveSession] callbacks.size=${eventListeners.callbacks.size}`);

        // If no more local callbacks, clean up event listeners
        if (eventListeners.callbacks.size === 0) {
          console.log(`[sessionStore:leaveSession] No more callbacks, cleaning up event listeners`);
          cleanupEventListeners(eventListeners);

          // NOTE: Don't call leaveReaderSession here - unregisterSessionSubscriber already
          // handles the backend cleanup including stopping the session when no listeners remain.
          // Calling leaveReaderSession would double-decrement joiner_count.

          const session = get().sessions[sessionId];

          // If session has queued messages, preserve it as disconnected instead of removing
          if (session?.hasQueuedMessages) {
            set((s) => {
              const { [sessionId]: __, ...remainingListeners } = s._eventListeners;
              return {
                sessions: {
                  ...s.sessions,
                  [sessionId]: {
                    ...s.sessions[sessionId],
                    lifecycleState: "disconnected",
                    subscriberCount: 0,
                  },
                },
                _eventListeners: remainingListeners,
                activeSessionId:
                  s.activeSessionId === sessionId ? null : s.activeSessionId,
              };
            });
            console.log(
              `[sessionStore:leaveSession] Session preserved (has queued messages)`
            );
          } else {
            // Remove from local store only
            set((s) => {
              const { [sessionId]: _, ...remainingSessions } = s.sessions;
              const { [sessionId]: __, ...remainingListeners } = s._eventListeners;
              return {
                sessions: remainingSessions,
                _eventListeners: remainingListeners,
                activeSessionId:
                  s.activeSessionId === sessionId ? null : s.activeSessionId,
              };
            });
            console.log(`[sessionStore:leaveSession] Session removed from store`);
          }
        } else {
          // Update listener count
          console.log(`[sessionStore:leaveSession] Other callbacks remain, updating listener count`);
          set((s) => ({
            sessions: {
              ...s.sessions,
              [sessionId]: {
                ...s.sessions[sessionId],
                subscriberCount: remaining,
              },
            },
          }));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[sessionStore:leaveSession] Error: ${msg}`);
      // Ignore - session may already be gone
    }
  },

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

  reinitializeSession: async (sessionId, subscriberId, appName, profileId, profileName, options) => {
    console.log(`[sessionStore:reinitializeSession] Called with sessionId=${sessionId}, subscriberId=${subscriberId}, profileId=${profileId}, profileName=${profileName}`);
    console.log(`[sessionStore:reinitializeSession] Options: ${JSON.stringify(options)}`);

    // Use Rust's atomic reinitialize check
    const result = await reinitializeSessionIfSafe(sessionId, subscriberId);
    console.log(`[sessionStore:reinitializeSession] reinitializeSessionIfSafe result: ${JSON.stringify(result)}`);

    if (!result.success) {
      // Can't fully reinitialize (other listeners exist), but we can update the time range
      const existing = get().sessions[sessionId];
      console.log(`[sessionStore:reinitializeSession] Can't reinitialize, existing session=${!!existing}`);
      if (existing) {
        // Apply time range update even when we can't reinitialize
        if (options?.startTime !== undefined || options?.endTime !== undefined) {
          console.log(`[sessionStore:reinitializeSession] Can't reinitialize (other listeners), updating time range instead`);
          await updateReaderTimeRange(sessionId, options.startTime, options.endTime);
        }
        return existing;
      }
      // If no session exists, create one
      // Pass sessionId via options so openSession uses it instead of defaulting to profileId
      console.log(`[sessionStore:reinitializeSession] No existing session, calling openSession`);
      return get().openSession(profileId, profileName, subscriberId, appName, { ...options, sessionId });
    }

    // Clean up local event listeners but keep session in store
    // This prevents React re-renders from causing the useIOSession effect
    // to try to openSession during the gap between remove and create
    const eventListeners = get()._eventListeners[sessionId];
    if (eventListeners) {
      cleanupEventListeners(eventListeners);
    }

    // Mark session as reinitializing with lifecycleState="disconnected" to prevent
    // the useIOSession effect from trying to openSession during the gap.
    // openSession checks lifecycleState !== "connected" before short-circuiting.
    set((s) => {
      const { [sessionId]: _, ..._remainingListeners } = s._eventListeners;
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...s.sessions[sessionId],
            lifecycleState: "disconnected" as const,
            ioState: "starting" as const,
          },
        },
        // Clear event listeners for this session
        _eventListeners: _remainingListeners,
      };
    });

    // Create new session - this will update the existing entry in the store
    // Pass sessionId via options so openSession uses it instead of defaulting to profileId
    console.log(`[sessionStore:reinitializeSession] Success, calling openSession for profileId=${profileId}, sessionId=${sessionId}`);
    const result2 = await get().openSession(profileId, profileName, subscriberId, appName, { ...options, sessionId });
    console.log(`[sessionStore:reinitializeSession] openSession complete, result.id=${result2?.id}`);
    return result2;
  },

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
          stoppedExplicitly: false, // Reset flag when starting
          streamEndedReason: null, // Reset reason when starting
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
    // Set stoppedExplicitly BEFORE the async call to avoid race condition:
    // The stream-ended event (which updates buffer state) may fire before
    // stopReaderSession returns. Effects checking both captureAvailable and
    // stoppedExplicitly need both to be true at the same time.
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          stoppedExplicitly: true, // User explicitly stopped
        },
      },
    }));

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

  suspendSession: async (sessionId) => {
    // Check if the session is a realtime source - if so, switch to capture replay mode
    // so playback controls work. For recorded sources, just stop the source.
    const session = get().sessions[sessionId];
    const isRealtime = session?.capabilities?.traits.temporal_mode === "realtime";
    const profileName = session?.profileName ?? sessionId;

    if (isRealtime) {
      // Realtime source: switch to CaptureSource for capture playback
      tlog.info(`[sessionStore] suspendSession: realtime session '${sessionId}' - switching to capture replay`);
      try {
        const capabilities = await switchSessionToCaptureReplay(sessionId, 1.0);
        // Capture state will be updated by the session-lifecycle event handler.
        // Use existing session capture state for the log message if already available.
        const existingBuffer = get().sessions[sessionId]?.capture;
        addSessionLog({
          eventType: "state-change",
          sessionId,
          profileId: session?.profileId ?? null,
          profileName,
          appName: null,
          details: `Switched to capture replay mode (temporal_mode: ${capabilities.traits.temporal_mode}, buffer: ${existingBuffer?.id ?? 'none'})`,
        });
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...s.sessions[sessionId],
              capabilities,
              ioState: "stopped",
              // Buffer state is populated by the session-lifecycle event handler
            },
          },
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        tlog.info(`[sessionStore] suspendSession: failed to switch to buffer replay: ${msg}`);
        addSessionLog({
          eventType: "session-error",
          sessionId,
          profileId: session?.profileId ?? null,
          profileName,
          appName: null,
          details: `Failed to switch to buffer replay: ${msg}`,
        });
        // Fall back to just stopping the reader
        try {
          const confirmedState = await suspendReaderSession(sessionId);
          set((s) => ({
            sessions: {
              ...s.sessions,
              [sessionId]: {
                ...s.sessions[sessionId],
                ioState: getStateType(confirmedState),
              },
            },
          }));
        } catch (fallbackError) {
          tlog.info(`[sessionStore] suspendSession: fallback also failed: ${fallbackError}`);
        }
      }
    } else {
      // Recorded source: just stop the source
      tlog.info(`[sessionStore] suspendSession: recorded session '${sessionId}' - stopping source`);
      const confirmedState = await suspendReaderSession(sessionId);
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

  resumeSessionFresh: async (sessionId) => {
    // Clear stopped flags before resuming
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          stoppedExplicitly: false,
          streamEndedReason: null,
        },
      },
    }));

    // Try to resume to live first (for realtime sources that were suspended to buffer mode)
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
    console.log("[sessionStore:setSessionTimeRange] sessionId:", sessionId, "start:", start, "end:", end);
    await updateReaderTimeRange(sessionId, start, end);
    console.log("[sessionStore:setSessionTimeRange] completed");
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
    // Update ALL sessions that share this buffer ID
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
    emit(WINDOW_EVENTS.BUFFER_METADATA_UPDATED, { captureId, name: newName });
  },

  setSessionCapturePersistent: async (captureId, persistent) => {
    const { setCapturePersistent } = await import("../api/capture");
    await setCapturePersistent(captureId, persistent);
    // Update ALL sessions that share this buffer ID
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
    emit(WINDOW_EVENTS.BUFFER_METADATA_UPDATED, { captureId, persistent });
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
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          hasQueuedMessages: hasQueue,
        },
      },
    }));
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

  getAllSessions: () => Object.values(get().sessions).filter((s) => s != null),

  getTransmitCapableSessions: () =>
    Object.values(get().sessions).filter(
      (s) =>
        s && s.lifecycleState === "connected" && s.capabilities?.traits.tx_frames === true
    ),

  isProfileInUse: (profileId) =>
    Object.values(get().sessions).some(
      (s) => s && s.profileId === profileId && s.lifecycleState === "connected"
    ),

  getSessionForProfile: (profileId) =>
    Object.values(get().sessions).find(
      (s) => s && s.profileId === profileId && s.lifecycleState === "connected"
    ),

  getTransmitDropdownSessions: () =>
    Object.values(get().sessions).filter(
      (s) =>
        s &&
        ((s.lifecycleState === "connected" &&
          s.capabilities?.traits.tx_frames === true) ||
        (s.lifecycleState === "disconnected" && s.hasQueuedMessages))
    ),

  // ---- Global App Error Dialog ----
  showAppError: (title, message, details) => {
    Sentry.captureMessage(message, {
      level: "error",
      extra: { title, details },
    });
    set({
      appErrorDialog: {
        isOpen: true,
        title,
        message,
        details: details ?? null,
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

  clearPendingJoin: (appName) => {
    set((state) => {
      const { [appName]: _, ...rest } = state.pendingJoins;
      return { pendingJoins: rest };
    });
  },

  // ---- Buffer ID Registry ----
  loadCaptureIds: async () => {
    const { listCaptureIds } = await import("../api/capture");
    const ids = await listCaptureIds();
    set({ knownCaptureIds: new Set(ids) });
  },
  addKnownCaptureId: (id) => {
    set((state) => {
      const next = new Set(state.knownCaptureIds);
      next.add(id);
      return { knownCaptureIds: next };
    });
  },
  removeKnownCaptureId: (id) => {
    set((state) => {
      const next = new Set(state.knownCaptureIds);
      next.delete(id);
      return { knownCaptureIds: next };
    });
  },
}));

// Initialize the event listeners getter for frame throttling
getEventListeners = () => useSessionStore.getState()._eventListeners;

// Initialize the showAppError getter for error handling
getGlobalShowAppError = () => useSessionStore.getState().showAppError;

// Listen for buffer events from other windows.
// App-lifetime listeners; HMR guard prevents double-registration during dev.
let _unlistenBufferMeta: (() => void) | null = null;
let _unlistenBufferChanged: (() => void) | null = null;

(() => {
  // Clean up previous registrations (HMR guard).
  // Cast is needed because TS narrows these `let` vars to `null` here —
  // they're only reassigned inside the deferred `.then` callbacks below.
  (_unlistenBufferMeta as (() => void) | null)?.();
  (_unlistenBufferChanged as (() => void) | null)?.();

  // Rename / pin changes
  listen<{ captureId: string; name?: string; persistent?: boolean }>(
    WINDOW_EVENTS.BUFFER_METADATA_UPDATED,
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
  ).then(fn => { _unlistenBufferMeta = fn; });

  // Capture created/deleted — keep knownCaptureIds and session state in sync
  listen<{ deletedBufferIds?: string[]; metadata?: { id: string } | null }>(
    WINDOW_EVENTS.BUFFER_CHANGED,
    (event) => {
      // New/updated capture — register its id so isCaptureProfileId() recognises it
      const metadata = event.payload.metadata;
      if (metadata && metadata.id) {
        useSessionStore.getState().addKnownCaptureId(metadata.id);
      }

      const ids = event.payload.deletedBufferIds;
      if (!ids || ids.length === 0) return;
      const deletedSet = new Set(ids);
      const state = useSessionStore.getState();

      // Remove from known capture IDs
      for (const id of ids) {
        state.removeKnownCaptureId(id);
      }

      // Clear buffer info on any session referencing a deleted buffer
      const sessions = state.sessions;
      const updated: Record<string, Session> = {};
      for (const [sid, session] of Object.entries(sessions)) {
        if (session.capture.id && deletedSet.has(session.capture.id)) {
          updated[sid] = {
            ...session,
            capture: { available: false, id: null, kind: null, count: 0, owningSessionId: null, startTimeUs: null, endTimeUs: null, name: null, persistent: false },
          };
        }
      }
      if (Object.keys(updated).length > 0) {
        useSessionStore.setState((s) => ({ sessions: { ...s.sessions, ...updated } }));
      }
    }
  ).then(fn => { _unlistenBufferChanged = fn; });
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

/** Get all sessions as an array */
export function useAllSessions(): Session[] {
  return useSessionStore(
    useShallow((s) => Object.values(s.sessions))
  );
}

/** Get transmit-capable sessions */
export function useTransmitCapableSessions(): Session[] {
  return useSessionStore(
    useShallow((s) =>
      Object.values(s.sessions).filter(
        (session) =>
          session.lifecycleState === "connected" &&
          session.capabilities?.traits.tx_frames === true
      )
    )
  );
}

/** Get sessions for Transmit dropdown */
export function useTransmitDropdownSessions(): Session[] {
  return useSessionStore(
    useShallow((s) =>
      Object.values(s.sessions).filter(
        (session) =>
          (session.lifecycleState === "connected" &&
            session.capabilities?.traits.tx_frames === true) ||
          (session.lifecycleState === "disconnected" && session.hasQueuedMessages)
      )
    )
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
export interface BusSourceInfo {
  profileName: string;
  deviceBus: number;
}


// ============================================================================
// Multi-Source Session Helpers
// ============================================================================

/**
 * Per-interface framing configuration (simplified for UI).
 * Used when each serial interface in a multi-source session needs different framing.
 */
export interface PerInterfaceFramingConfig {
  /** Framing encoding: "raw", "slip", "modbus_rtu", "delimiter" */
  encoding: FramingEncoding;
  /** Delimiter hex string for delimiter mode (e.g., "0D0A") */
  delimiterHex?: string;
}

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
  /** Bus mappings per profile (keyed by profile ID) */
  busMappings?: Map<string, BusMapping[]>;
  /** Map of profile ID to display name */
  profileNames?: Map<string, string>;
  /** Framing encoding for serial sources (e.g., "slip", "delimiter", "modbus_rtu", "raw") */
  framingEncoding?: string;
  /** Delimiter bytes for delimiter-based framing */
  delimiter?: number[];
  /** Maximum frame length for delimiter-based framing */
  maxFrameLength?: number;
  /** Minimum frame length - frames shorter than this are discarded */
  minFrameLength?: number;
  /** Whether to emit raw bytes in addition to framed data */
  emitRawBytes?: boolean;
  /** Per-interface framing config (overrides session-level framing for specific profiles) */
  perInterfaceFraming?: Map<string, PerInterfaceFramingConfig>;
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
 * Result of creating or joining a multi-source session.
 */
export interface MultiSourceSessionResult {
  /** The session ID */
  sessionId: string;
  /** Source profile IDs */
  sourceProfileIds: string[];
  /** The session capabilities */
  capabilities: IOCapabilities;
}

/**
 * Create a new multi-source session that merges frames from multiple devices.
 * This creates a Rust-side merged session that other apps can join.
 *
 * @param options Configuration for the multi-source session
 * @returns The session result with capabilities
 */
/**
 * Parse a hex string to byte array (e.g., "0D0A" -> [0x0D, 0x0A]).
 */
function parseHexDelimiter(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

export async function createAndStartMultiSourceSession(
  options: CreateMultiSourceOptions
): Promise<MultiSourceSessionResult> {
  const {
    sessionId,
    subscriberId,
    appName,
    profileIds,
    busMappings,
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

    // Use per-interface framing if specified, otherwise fall back to session-level
    const sourceFramingEncoding = interfaceFraming?.encoding ?? framingEncoding;
    const sourceDelimiter = interfaceFraming?.delimiterHex
      ? parseHexDelimiter(interfaceFraming.delimiterHex)
      : delimiter;

    // For "raw" framing mode, set emitRawBytes to true
    const sourceEmitRawBytes = sourceFramingEncoding === "raw" ? true : emitRawBytes;

    return {
      profileId,
      displayName: profileNames?.get(profileId),
      busMappings: busMappings?.get(profileId) || [],
      // Apply framing config (per-interface or session-level)
      // Serial sources will use these overrides, CAN sources will ignore them
      framingEncoding: sourceFramingEncoding,
      delimiter: sourceDelimiter,
      maxFrameLength,
      minFrameLength,
      emitRawBytes: sourceEmitRawBytes,
      // Frame ID extraction config (from catalog)
      frameIdStartByte,
      frameIdBytes,
      frameIdBigEndian,
      sourceAddressStartByte,
      sourceAddressBytes,
      sourceAddressBigEndian,
    };
  });

  // Create the multi-source session in Rust
  const capabilities = await createMultiSourceSession({
    sessionId,
    sources,
    subscriberId,
    appName,
    modbusPollsJson: options.modbusPollsJson,
  });

  // Register this listener with the session
  const regResult = await registerSessionSubscriber(sessionId, subscriberId, appName);
  // Handle startup error (error that occurred before listener registered)
  if (regResult.startup_error) {
    useSessionStore.getState().showAppError("Stream Error", "An error occurred while starting the session.", regResult.startup_error);
  }

  // Set up event listeners and heartbeat interval
  // This is needed because useIOSession's effect may skip setup when the session ID changes
  // during multi-bus session creation (to avoid stale closure issues)
  const store = useSessionStore.getState();
  let eventListeners = store._eventListeners[sessionId];
  if (!eventListeners) {
    eventListeners = {
      sessionId,
      unlistenFunctions: [],
      wsUnlistenFunctions: [],
      callbacks: new Map(),
      heartbeatIntervalId: null,
      registeredSubscribers: new Set(),
    };

    useSessionStore.setState((s) => {
      if (s._eventListeners[sessionId]) {
        eventListeners = s._eventListeners[sessionId];
        return s;
      }
      return {
        ...s,
        _eventListeners: { ...s._eventListeners, [sessionId]: eventListeners! },
      };
    });

    eventListeners = useSessionStore.getState()._eventListeners[sessionId]!;

    if (eventListeners.unlistenFunctions.length === 0) {
      const updateSession = (id: string, updates: Partial<Session>) => {
        useSessionStore.setState((s) => ({
          sessions: {
            ...s.sessions,
            [id]: s.sessions[id] ? { ...s.sessions[id], ...updates } : s.sessions[id],
          },
        }));
      };

      eventListeners.unlistenFunctions = await setupSessionEventSubscribers(
        sessionId,
        eventListeners,
        updateSession
      );

      // Heartbeat keepalive — WS server bridges its heartbeat to IO listeners.
      // Fall back to invoke-based heartbeats only when WS is unavailable.
      if (!eventListeners.heartbeatIntervalId && !wsTransport.isConnected) {
        const heartbeatSessionId = sessionId;
        eventListeners.heartbeatIntervalId = setInterval(async () => {
          const listeners = useSessionStore.getState()._eventListeners[heartbeatSessionId];
          if (!listeners || listeners.registeredSubscribers.size === 0) return;

          for (const lid of listeners.registeredSubscribers) {
            try {
              await registerSessionSubscriber(heartbeatSessionId, lid);
            } catch {
              // Ignore heartbeat errors - session may have been destroyed
            }
          }
        }, 5000);
      }
    }
  }

  // Add this listener to the registered listeners set for heartbeat tracking
  eventListeners.registeredSubscribers.add(subscriberId);

  return {
    sessionId,
    sourceProfileIds: profileIds,
    capabilities,
  };
}

/**
 * Options for joining an existing multi-source session.
 */
export interface JoinMultiSourceOptions {
  /** Session ID to join */
  sessionId: string;
  /** Listener instance ID for this app */
  subscriberId: string;
  /** Human-readable app name (e.g., "discovery", "decoder") */
  appName: string;
  /** Source profile IDs (for display purposes) */
  sourceProfileIds?: string[];
}

/**
 * Join an existing multi-source session (created by another app).
 * This connects to an already-running merged session.
 *
 * @param options Configuration for joining the session
 * @returns The session result with capabilities
 */
export async function joinMultiSourceSession(
  options: JoinMultiSourceOptions
): Promise<MultiSourceSessionResult> {
  const { sessionId, subscriberId, appName, sourceProfileIds = [] } = options;

  // Join the existing session using registerSessionSubscriber only
  // Don't call joinReaderSession - it increments joiner_count separately from the listener map
  const regResult = await registerSessionSubscriber(sessionId, subscriberId, appName);
  // Handle startup error (error that occurred before listener registered)
  if (regResult.startup_error) {
    useSessionStore.getState().showAppError("Stream Error", "An error occurred while starting the session.", regResult.startup_error);
  }

  // Set up event listeners and heartbeat interval if not already set up
  const store = useSessionStore.getState();
  let eventListeners = store._eventListeners[sessionId];
  if (!eventListeners) {
    eventListeners = {
      sessionId,
      unlistenFunctions: [],
      wsUnlistenFunctions: [],
      callbacks: new Map(),
      heartbeatIntervalId: null,
      registeredSubscribers: new Set(),
    };

    useSessionStore.setState((s) => {
      if (s._eventListeners[sessionId]) {
        eventListeners = s._eventListeners[sessionId];
        return s;
      }
      return {
        ...s,
        _eventListeners: { ...s._eventListeners, [sessionId]: eventListeners! },
      };
    });

    eventListeners = useSessionStore.getState()._eventListeners[sessionId]!;

    if (eventListeners.unlistenFunctions.length === 0) {
      const updateSession = (id: string, updates: Partial<Session>) => {
        useSessionStore.setState((s) => ({
          sessions: {
            ...s.sessions,
            [id]: s.sessions[id] ? { ...s.sessions[id], ...updates } : s.sessions[id],
          },
        }));
      };

      eventListeners.unlistenFunctions = await setupSessionEventSubscribers(
        sessionId,
        eventListeners,
        updateSession
      );

      // Heartbeat keepalive — WS server bridges its heartbeat to IO listeners.
      // Fall back to invoke-based heartbeats only when WS is unavailable.
      if (!eventListeners.heartbeatIntervalId && !wsTransport.isConnected) {
        const heartbeatSessionId = sessionId;
        eventListeners.heartbeatIntervalId = setInterval(async () => {
          const listeners = useSessionStore.getState()._eventListeners[heartbeatSessionId];
          if (!listeners || listeners.registeredSubscribers.size === 0) return;

          for (const lid of listeners.registeredSubscribers) {
            try {
              await registerSessionSubscriber(heartbeatSessionId, lid);
            } catch {
              // Ignore heartbeat errors - session may have been destroyed
            }
          }
        }, 5000);
      }
    }
  }

  // Add this listener to the registered listeners set for heartbeat tracking
  eventListeners.registeredSubscribers.add(subscriberId);

  return {
    sessionId,
    sourceProfileIds,
    capabilities: regResult.capabilities,
  };
}
