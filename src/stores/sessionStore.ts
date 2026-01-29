// ui/src/stores/sessionStore.ts
//
// Centralized IO session manager for all apps (Discovery, Decoder, Transmit).
// Session lifecycle and listener management is handled by Rust backend.
// This store manages frontend state and event listeners.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createIOSession,
  getIOSessionState,
  getIOSessionCapabilities,
  joinReaderSession,
  startReaderSession,
  stopReaderSession,
  pauseReaderSession,
  resumeReaderSession,
  updateReaderSpeed,
  updateReaderTimeRange,
  destroyReaderSession,
  seekReaderSession,
  transitionToBufferReader,
  sessionTransmitFrame,
  registerSessionListener,
  unregisterSessionListener,
  reinitializeSessionIfSafe,
  createMultiSourceSession,
  getStateType,
  parseStateString,
  type IOCapabilities,
  type IOStateType,
  type StreamEndedPayload,
  type StateChangePayload,
  type CanTransmitFrame,
  type TransmitResult,
  type CreateIOSessionOptions,
  type FramingEncoding,
  type MultiSourceInput,
  type BusMapping,
  type PlaybackPosition,
  type RawBytesPayload,
} from "../api/io";
import type { FrameMessage } from "./discoveryStore";

/**
 * Special profile ID used for buffer replay (imported CSV, etc.)
 * DEPRECATED: Use isBufferProfileId() to detect buffer IDs (e.g., "buffer_1", "buffer_2")
 */
export const BUFFER_PROFILE_ID = "__imported_buffer__";

/**
 * Check if a profile ID represents a buffer session.
 * Buffer IDs follow the pattern "buffer_N" (e.g., "buffer_1", "buffer_2")
 * or the legacy "__imported_buffer__".
 */
export function isBufferProfileId(profileId: string | null): boolean {
  if (!profileId) return false;
  return profileId === BUFFER_PROFILE_ID || /^buffer_\d+$/.test(profileId);
}

/** Frame batch payload from Rust - includes active listeners for filtering */
interface FrameBatchPayload {
  frames: FrameMessage[];
  active_listeners: string[];
}

// ============================================================================
// Adaptive Frame Throttling
// ============================================================================
// Balances latency vs. UI performance with two triggers:
// 1. Batch size threshold - flush immediately when enough frames accumulate
// 2. Time interval - flush after max interval even with few frames
//
// This gives low latency for low-frequency data (flushes quickly when idle)
// while batching high-frequency data to prevent UI overload.

/** Minimum interval between flushes (ms) - prevents overwhelming UI */
const MIN_FLUSH_INTERVAL_MS = 16; // ~60fps max update rate

/** Maximum interval before forcing a flush (ms) - caps latency for sparse data */
const MAX_FLUSH_INTERVAL_MS = 50; // 20Hz minimum update rate

/** Batch size threshold - flush immediately when this many frames accumulate */
const BATCH_SIZE_THRESHOLD = 50;

/** Pending frames per session, keyed by session ID */
const pendingFramesMap = new Map<string, {
  /** Frames accumulated since last flush */
  frames: FrameMessage[];
  /** Which listeners should receive frames (empty = all) */
  activeListeners: string[];
  /** Timestamp of last flush for this session */
  lastFlushTime: number;
}>();

/** Timeout ID for the scheduled flush (null if none scheduled) */
let flushTimeoutId: ReturnType<typeof setTimeout> | null = null;

/** Getter for event listeners - set after store is created */
let getEventListeners: (() => Record<string, SessionEventListeners>) | null = null;

/** Flush all pending frames to their callbacks */
function flushPendingFrames() {
  flushTimeoutId = null;
  const now = performance.now();

  if (!getEventListeners) return;
  const eventListenersMap = getEventListeners();

  for (const [sessionId, pending] of pendingFramesMap.entries()) {
    if (pending.frames.length === 0) continue;

    const eventListeners = eventListenersMap[sessionId];
    if (!eventListeners) continue;

    const frames = pending.frames;
    const listeners = pending.activeListeners;

    // Clear pending before dispatching (in case callbacks add more)
    pending.frames = [];
    pending.activeListeners = [];
    pending.lastFlushTime = now;

    // Dispatch to callbacks
    for (const [listenerId, callbacks] of eventListeners.callbacks.entries()) {
      if (listeners.length === 0 || listeners.includes(listenerId)) {
        if (callbacks.onFrames) {
          callbacks.onFrames(frames);
        }
      }
    }
  }
}

/** Schedule a flush with adaptive timing */
function scheduleFlush(immediate: boolean) {
  if (immediate) {
    // Flush immediately (but still async to batch same-tick arrivals)
    if (flushTimeoutId !== null) {
      clearTimeout(flushTimeoutId);
    }
    flushTimeoutId = setTimeout(flushPendingFrames, 0);
  } else if (flushTimeoutId === null) {
    // Schedule for max interval if not already scheduled
    flushTimeoutId = setTimeout(flushPendingFrames, MAX_FLUSH_INTERVAL_MS);
  }
  // If already scheduled and not immediate, let existing timer run
}

/** Accumulate frames for throttled delivery */
function accumulateFrames(sessionId: string, frames: FrameMessage[], activeListeners: string[]) {
  // Guard against null/undefined frames (can happen during session transitions)
  if (!frames || !Array.isArray(frames)) {
    return;
  }

  const now = performance.now();
  let pending = pendingFramesMap.get(sessionId);
  if (!pending) {
    pending = { frames: [], activeListeners: [], lastFlushTime: 0 };
    pendingFramesMap.set(sessionId, pending);
  }

  // Append frames
  pending.frames.push(...frames);

  // Merge active listeners (use the most recent non-empty list)
  if (activeListeners.length > 0) {
    pending.activeListeners = activeListeners;
  }

  // Determine if we should flush immediately
  const timeSinceLastFlush = now - pending.lastFlushTime;
  const shouldFlushNow =
    pending.frames.length >= BATCH_SIZE_THRESHOLD &&
    timeSinceLastFlush >= MIN_FLUSH_INTERVAL_MS;

  scheduleFlush(shouldFlushNow);
}

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
  /** Whether this listener was the session owner (created the session) */
  isOwner: boolean;
  /** Number of listeners connected to this session (from Rust backend) */
  listenerCount: number;
  /** Buffer info after stream ends */
  buffer: {
    available: boolean;
    id: string | null;
    type: "frames" | "bytes" | null;
    count: number;
  };
  /** Timestamp when session was created/joined */
  createdAt: number;
  /** Whether session has queued messages (prevents auto-removal from Transmit dropdown) */
  hasQueuedMessages: boolean;
  /** Whether the session was stopped explicitly by user (vs stream ending naturally) */
  stoppedExplicitly: boolean;
  /** Current playback speed (null until set, 1 = realtime, 0 = unlimited) */
  speed: number | null;
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
  /** Use the shared buffer reader */
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
}

/** Callbacks for a session - stored per listener in the frontend */
export interface SessionCallbacks {
  onFrames?: (frames: FrameMessage[]) => void;
  onBytes?: (payload: RawBytesPayload) => void;
  onError?: (error: string) => void;
  onTimeUpdate?: (position: PlaybackPosition) => void;
  onStreamEnded?: (payload: StreamEndedPayload) => void;
  onStreamComplete?: () => void;
  onStateChange?: (state: IOStateType) => void;
  onSpeedChange?: (speed: number) => void;
}

/** Session event listeners - one set per session */
interface SessionEventListeners {
  /** Unlisten functions for Tauri events */
  unlistenFunctions: UnlistenFn[];
  /** Callbacks registered by listeners, keyed by listener ID */
  callbacks: Map<string, SessionCallbacks>;
  /** Heartbeat interval ID (for keeping listeners alive in Rust backend) */
  heartbeatIntervalId: ReturnType<typeof setInterval> | null;
  /** Listener IDs that need heartbeats (separate from callbacks for timing) */
  registeredListeners: Set<string>;
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
  _eventListeners: Record<string, SessionEventListeners>;

  // ---- Multi-Bus State ----
  /** Whether multi-bus mode is currently active */
  multiBusMode: boolean;
  /** Profile IDs involved in the current multi-bus session */
  multiBusProfiles: string[];
  /** Source profile ID - preserved when switching to buffer mode */
  sourceProfileId: string | null;

  // ---- Actions: Session Lifecycle ----
  /** Open a session - creates if not exists, joins if exists */
  openSession: (
    profileId: string,
    profileName: string,
    listenerId: string,
    options?: CreateSessionOptions
  ) => Promise<Session>;
  /** Leave a session (unregister listener) */
  leaveSession: (sessionId: string, listenerId: string) => Promise<void>;
  /** Remove session from list entirely */
  removeSession: (sessionId: string) => Promise<void>;
  /** Reinitialize a session with new options (atomic check via Rust) */
  reinitializeSession: (
    sessionId: string,
    listenerId: string,
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
  /** Switch to buffer replay mode */
  switchToBuffer: (sessionId: string, speed?: number) => Promise<void>;

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
  /** Register callbacks for a listener */
  registerCallbacks: (sessionId: string, listenerId: string, callbacks: SessionCallbacks) => void;
  /** Clear callbacks for a specific listener */
  clearCallbacks: (sessionId: string, listenerId: string) => void;

  // ---- Actions: Multi-Bus State ----
  /** Enable or disable multi-bus mode */
  setMultiBusMode: (enabled: boolean) => void;
  /** Set profiles involved in multi-bus session */
  setMultiBusProfiles: (profiles: string[]) => void;
  /** Set source profile ID (preserved when switching to buffer) */
  setSourceProfileId: (profileId: string | null) => void;
  /** Reset multi-bus state (disable mode, clear profiles) */
  resetMultiBusState: () => void;

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
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Invoke all callbacks for an event type */
function invokeCallbacks<T>(
  eventListeners: SessionEventListeners,
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
async function setupSessionEventListeners(
  sessionId: string,
  eventListeners: SessionEventListeners,
  updateSession: (id: string, updates: Partial<Session>) => void
): Promise<UnlistenFn[]> {
  const unlistenFunctions: UnlistenFn[] = [];

  // Frame messages - throttled to 10Hz for UI performance
  // Frames are accumulated and flushed periodically instead of immediately dispatched
  const unlistenFrames = await listen<FrameBatchPayload>(
    `frame-message:${sessionId}`,
    (event) => {
      const { frames, active_listeners } = event.payload;
      const listeners = active_listeners ?? [];
      accumulateFrames(sessionId, frames, listeners);
    }
  );
  unlistenFunctions.push(unlistenFrames);

  // Raw bytes (serial byte streams)
  const unlistenBytes = await listen<RawBytesPayload>(
    `serial-raw-bytes:${sessionId}`,
    (event) => {
      invokeCallbacks(eventListeners, "onBytes", event.payload);
    }
  );
  unlistenFunctions.push(unlistenBytes);

  // Errors
  const unlistenError = await listen<string>(
    `session-error:${sessionId}`,
    (event) => {
      const error = event.payload;
      // Don't show error dialog for expected/transient errors
      const isExpectedError =
        error === "No IO profile configured" || error.includes("not found");
      if (!isExpectedError) {
        invokeCallbacks(eventListeners, "onError", error);
      }
      updateSession(sessionId, {
        ioState: "error",
        errorMessage: error,
      });
    }
  );
  unlistenFunctions.push(unlistenError);

  // Playback time (Buffer reader, PostgreSQL reader)
  const unlistenPlaybackTime = await listen<PlaybackPosition>(
    `playback-time:${sessionId}`,
    (event) => {
      invokeCallbacks(eventListeners, "onTimeUpdate", event.payload);
    }
  );
  unlistenFunctions.push(unlistenPlaybackTime);

  // Stream complete (buffer reader finished)
  const unlistenStreamComplete = await listen<boolean>(
    `stream-complete:${sessionId}`,
    () => {
      updateSession(sessionId, { ioState: "stopped" });
      invokeCallbacks(eventListeners, "onStreamComplete", undefined as never);
    }
  );
  unlistenFunctions.push(unlistenStreamComplete);

  // Stream ended (GVRET disconnect, PostgreSQL complete)
  const unlistenStreamEnded = await listen<StreamEndedPayload>(
    `stream-ended:${sessionId}`,
    (event) => {
      // Flush any pending frames before processing stream-ended
      // This ensures fast playback (e.g., PostgreSQL no-limit) delivers all frames
      flushPendingFrames();

      const payload = event.payload;
      updateSession(sessionId, {
        ioState: "stopped",
        buffer: {
          available: payload.buffer_available,
          id: payload.buffer_id,
          type: payload.buffer_type,
          count: payload.count,
        },
      });
      invokeCallbacks(eventListeners, "onStreamEnded", payload);
    }
  );
  unlistenFunctions.push(unlistenStreamEnded);

  // State changes
  const unlistenStateChange = await listen<StateChangePayload>(
    `session-state:${sessionId}`,
    (event) => {
      const newState = parseStateString(event.payload.current);
      const errorMessage =
        newState === "error" && event.payload.current.startsWith("error:")
          ? event.payload.current.slice(6)
          : null;
      updateSession(sessionId, {
        ioState: newState,
        errorMessage,
      });
      invokeCallbacks(eventListeners, "onStateChange", newState);
    }
  );
  unlistenFunctions.push(unlistenStateChange);

  // Listener count changes (from Rust backend)
  const unlistenListenerCount = await listen<number>(
    `joiner-count-changed:${sessionId}`,
    (event) => {
      updateSession(sessionId, { listenerCount: event.payload });
    }
  );
  unlistenFunctions.push(unlistenListenerCount);

  // Speed changes (from Rust backend - when any listener changes speed)
  const unlistenSpeedChange = await listen<number>(
    `speed-changed:${sessionId}`,
    (event) => {
      updateSession(sessionId, { speed: event.payload });
      invokeCallbacks(eventListeners, "onSpeedChange", event.payload);
    }
  );
  unlistenFunctions.push(unlistenSpeedChange);

  return unlistenFunctions;
}

/** Clean up session event listeners */
function cleanupEventListeners(eventListeners: SessionEventListeners) {
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
  eventListeners.callbacks.clear();
  eventListeners.registeredListeners.clear();
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useSessionStore = create<SessionStore>((set, get) => ({
  // ---- Initial State ----
  sessions: {},
  activeSessionId: null,
  _eventListeners: {},
  multiBusMode: false,
  multiBusProfiles: [],
  sourceProfileId: null,

  // ---- Session Lifecycle ----
  openSession: async (profileId, profileName, listenerId, options = {}) => {
    console.log(`[sessionStore:openSession] Called with profileId=${profileId}, profileName=${profileName}, listenerId=${listenerId}`);
    console.log(`[sessionStore:openSession] Options: ${JSON.stringify(options)}`);

    // SIMPLIFIED MODEL: Session ID = Profile ID
    const sessionId = profileId;

    // Step 1: Check if we already have this session in our store
    const existingSession = get().sessions[sessionId];
    console.log(`[sessionStore:openSession] existingSession lifecycle=${existingSession?.lifecycleState}`);
    if (existingSession?.lifecycleState === "connected") {
      // Register this listener with Rust backend
      try {
        const result = await registerSessionListener(sessionId, listenerId);

        // Add listener to heartbeat tracking
        const eventListeners = get()._eventListeners[sessionId];
        if (eventListeners) {
          eventListeners.registeredListeners.add(listenerId);
        }

        // Update session with latest info from Rust
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...s.sessions[sessionId],
              listenerCount: result.listener_count,
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
    let isOwner = true;
    let listenerCount = 1;
    let bufferId: string | null = null;
    let bufferType: "frames" | "bytes" | null = null;

    if (backendExists) {
      // Join existing backend session
      console.log(`[sessionStore:openSession] Backend exists, joining session ${sessionId}`);
      const joinResult = await joinReaderSession(sessionId);
      capabilities = joinResult.capabilities;
      ioState = getStateType(joinResult.state);
      isOwner = false;
      listenerCount = joinResult.joiner_count;
      bufferId = joinResult.buffer_id;
      bufferType = joinResult.buffer_type;

      // Register listener with Rust
      try {
        const regResult = await registerSessionListener(sessionId, listenerId);
        isOwner = regResult.is_owner;
        listenerCount = regResult.listener_count;
      } catch {
        // Ignore - we already joined
      }
    } else {
      // Create new backend session
      console.log(`[sessionStore:openSession] Backend does not exist, creating new session`);
      // Auto-detect buffer mode from profile ID (supports both legacy and new buffer ID formats)
      const isBufferMode = isBufferProfileId(profileId) || options.useBuffer;
      console.log(`[sessionStore:openSession] isBufferMode=${isBufferMode}`);

      const createOptions: CreateIOSessionOptions = {
        sessionId,
        profileId: isBufferMode ? undefined : profileId, // Don't pass fake profile ID for buffer mode
        startTime: options.startTime,
        endTime: options.endTime,
        // For buffer mode, default to 1x speed (paced playback) instead of 0 (no pacing)
        speed: options.speed ?? (isBufferMode ? 1.0 : undefined),
        limit: options.limit,
        filePath: options.filePath,
        useBuffer: isBufferMode,
        framingEncoding: options.framingEncoding,
        delimiter: options.delimiter,
        maxFrameLength: options.maxFrameLength,
        emitRawBytes: options.emitRawBytes,
        minFrameLength: options.minFrameLength,
        busOverride: options.busOverride,
      };

      try {
        console.log(`[sessionStore:openSession] Calling createIOSession with options:`, JSON.stringify(createOptions));
        capabilities = await createIOSession(createOptions);
        console.log(`[sessionStore:openSession] createIOSession succeeded`);

        // Backend auto-starts the session, so query the actual state
        const currentState = await getIOSessionState(sessionId);
        if (currentState) {
          ioState = getStateType(currentState);
        }

        // Register as owner listener
        try {
          const regResult = await registerSessionListener(sessionId, listenerId);
          isOwner = regResult.is_owner;
          listenerCount = regResult.listener_count;
        } catch {
          // Ignore
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        // If profile is in use, try to join instead
        if (msg.includes("Profile is in use by session")) {
          const joinResult = await joinReaderSession(sessionId);
          capabilities = joinResult.capabilities;
          ioState = getStateType(joinResult.state);
          isOwner = false;
          listenerCount = joinResult.joiner_count;
          bufferId = joinResult.buffer_id;
          bufferType = joinResult.buffer_type;

          // Register listener
          try {
            const regResult = await registerSessionListener(sessionId, listenerId);
            isOwner = regResult.is_owner;
            listenerCount = regResult.listener_count;
          } catch {
            // Ignore
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
            isOwner: false,
            listenerCount: 0,
            buffer: { available: false, id: null, type: null, count: 0 },
            createdAt: Date.now(),
            hasQueuedMessages: false,
            stoppedExplicitly: false,
            speed: null,
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
        unlistenFunctions: [],
        callbacks: new Map(),
        heartbeatIntervalId: null,
        registeredListeners: new Set(),
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

        eventListeners.unlistenFunctions = await setupSessionEventListeners(
          sessionId,
          eventListeners,
          updateSession
        );

        // Start heartbeat interval to keep listeners alive in Rust backend
        // The Rust watchdog removes listeners without heartbeat after 10 seconds
        // We send heartbeats every 5 seconds to stay well within the timeout
        if (!eventListeners.heartbeatIntervalId) {
          const heartbeatSessionId = sessionId;
          eventListeners.heartbeatIntervalId = setInterval(async () => {
            const listeners = get()._eventListeners[heartbeatSessionId];
            if (!listeners || listeners.registeredListeners.size === 0) return;

            // Send heartbeat for each registered listener
            for (const lid of listeners.registeredListeners) {
              try {
                await registerSessionListener(heartbeatSessionId, lid);
              } catch {
                // Ignore heartbeat errors - session may have been destroyed
              }
            }
          }, 5000);
        }
      }
    }

    // Add this listener to the registered listeners set for heartbeat tracking
    const currentEventListeners = get()._eventListeners[sessionId];
    if (currentEventListeners) {
      currentEventListeners.registeredListeners.add(listenerId);
    }

    // Step 5.5: Start the session if it's still stopped (for playback sources like PostgreSQL, CSV)
    // Playback sources don't auto-start on the backend to avoid emitting frames before listeners are ready.
    // Now that event listeners are set up, we can safely start.
    // EXCEPTION: Buffer mode should NOT auto-start - data is already in the buffer store
    // and can be accessed via pagination without streaming. User can start playback manually.
    const isBufferSession = isBufferProfileId(profileId);
    if (ioState === "stopped" && !isBufferSession) {
      try {
        await startReaderSession(sessionId);
        ioState = "running";
      } catch {
        // Session might have been started by another caller - continue anyway
      }
    }

    // Step 6: Create session entry
    // IMPORTANT: Use a function updater to preserve any listenerCount updates
    // that may have occurred via events while we were setting up.
    // The `listenerCount` variable may be stale by now.
    set((s) => {
      // Check if session already exists with a higher listener count
      // (could have been updated by joiner-count-changed event)
      const existingSession = s.sessions[sessionId];
      const currentListenerCount = existingSession?.listenerCount ?? 0;
      const finalListenerCount = Math.max(listenerCount, currentListenerCount);

      const session: Session = {
        id: sessionId,
        profileId,
        profileName,
        lifecycleState: "connected",
        ioState,
        capabilities,
        errorMessage: null,
        isOwner,
        listenerCount: finalListenerCount,
        buffer: {
          available: false,
          id: bufferId,
          type: bufferType,
          count: 0,
        },
        createdAt: existingSession?.createdAt ?? Date.now(),
        hasQueuedMessages: existingSession?.hasQueuedMessages ?? false,
        stoppedExplicitly: existingSession?.stoppedExplicitly ?? false,
        speed: existingSession?.speed ?? null,
      };

      return {
        sessions: { ...s.sessions, [sessionId]: session },
      };
    });

    console.log(`[sessionStore:openSession] Complete - returning session for ${sessionId}`);
    return get().sessions[sessionId];
  },

  leaveSession: async (sessionId, listenerId) => {
    console.log(`[sessionStore:leaveSession] Called with sessionId=${sessionId}, listenerId=${listenerId}`);
    const eventListeners = get()._eventListeners[sessionId];
    console.log(`[sessionStore:leaveSession] eventListeners exists=${!!eventListeners}`);

    try {
      // Unregister listener from Rust backend
      console.log(`[sessionStore:leaveSession] Calling unregisterSessionListener...`);
      const remaining = await unregisterSessionListener(sessionId, listenerId);
      console.log(`[sessionStore:leaveSession] unregisterSessionListener returned remaining=${remaining}`);

      // Remove callbacks and registered listener for heartbeats
      if (eventListeners) {
        eventListeners.callbacks.delete(listenerId);
        eventListeners.registeredListeners.delete(listenerId);
        console.log(`[sessionStore:leaveSession] callbacks.size=${eventListeners.callbacks.size}`);

        // If no more local callbacks, clean up event listeners
        if (eventListeners.callbacks.size === 0) {
          console.log(`[sessionStore:leaveSession] No more callbacks, cleaning up event listeners`);
          cleanupEventListeners(eventListeners);

          // NOTE: Don't call leaveReaderSession here - unregisterSessionListener already
          // handles the backend cleanup including stopping the session when no listeners remain.
          // Calling leaveReaderSession would double-decrement joiner_count.

          // Remove from local store only
          set((s) => {
            const { [sessionId]: _, ...remainingSessions } = s.sessions;
            const { [sessionId]: __, ...remainingListeners } = s._eventListeners;
            return {
              sessions: remainingSessions,
              _eventListeners: remainingListeners,
              activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
            };
          });
          console.log(`[sessionStore:leaveSession] Session removed from store`);
        } else {
          // Update listener count
          console.log(`[sessionStore:leaveSession] Other callbacks remain, updating listener count`);
          set((s) => ({
            sessions: {
              ...s.sessions,
              [sessionId]: {
                ...s.sessions[sessionId],
                listenerCount: remaining,
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
      for (const listenerId of eventListeners.registeredListeners) {
        try {
          await unregisterSessionListener(sessionId, listenerId);
        } catch {
          // Ignore - session may already be gone
        }
      }
      cleanupEventListeners(eventListeners);
    }

    // Destroy session in backend if owner (session should already be stopped by unregister)
    if (session.isOwner) {
      try {
        await destroyReaderSession(sessionId);
      } catch {
        // Ignore
      }
    }
    // Note: Don't call leaveReaderSession - unregisterSessionListener already handles it

    // Clear any pending frames for this session
    pendingFramesMap.delete(sessionId);

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

  reinitializeSession: async (sessionId, listenerId, profileId, profileName, options) => {
    console.log(`[sessionStore:reinitializeSession] Called with sessionId=${sessionId}, listenerId=${listenerId}, profileId=${profileId}, profileName=${profileName}`);
    console.log(`[sessionStore:reinitializeSession] Options: ${JSON.stringify(options)}`);

    // Use Rust's atomic reinitialize check
    const result = await reinitializeSessionIfSafe(sessionId, listenerId);
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
      console.log(`[sessionStore:reinitializeSession] No existing session, calling openSession`);
      return get().openSession(profileId, profileName, listenerId, options);
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
    console.log(`[sessionStore:reinitializeSession] Success, calling openSession for profileId=${profileId}`);
    const result2 = await get().openSession(profileId, profileName, listenerId, options);
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
    // stopReaderSession returns. Effects checking both bufferAvailable and
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

  switchToBuffer: async (sessionId, speed) => {
    const capabilities = await transitionToBufferReader(sessionId, speed);
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          capabilities,
          ioState: "stopped",
          buffer: { available: false, id: null, type: null, count: 0 },
        },
      },
    }));
  },

  // ---- Transmission ----
  transmitFrame: async (sessionId, frame) => {
    const session = get().sessions[sessionId];
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!session.capabilities?.can_transmit) {
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
  registerCallbacks: (sessionId, listenerId, callbacks) => {
    const eventListeners = get()._eventListeners[sessionId];
    if (eventListeners) {
      eventListeners.callbacks.set(listenerId, callbacks);
    }
  },

  clearCallbacks: (sessionId, listenerId) => {
    const eventListeners = get()._eventListeners[sessionId];
    if (eventListeners) {
      eventListeners.callbacks.delete(listenerId);
    }
  },

  // ---- Multi-Bus State ----
  setMultiBusMode: (enabled) => set({ multiBusMode: enabled }),

  setMultiBusProfiles: (profiles) => set({ multiBusProfiles: profiles }),

  setSourceProfileId: (profileId) => set({ sourceProfileId: profileId }),

  resetMultiBusState: () => set({
    multiBusMode: false,
    multiBusProfiles: [],
    sourceProfileId: null,
  }),

  // ---- Selectors ----
  getSession: (sessionId) => get().sessions[sessionId],

  getAllSessions: () => Object.values(get().sessions).filter((s) => s != null),

  getTransmitCapableSessions: () =>
    Object.values(get().sessions).filter(
      (s) =>
        s && s.lifecycleState === "connected" && s.capabilities?.can_transmit === true
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
          s.capabilities?.can_transmit === true) ||
        (s.lifecycleState === "disconnected" && s.hasQueuedMessages))
    ),
}));

// Initialize the event listeners getter for frame throttling
getEventListeners = () => useSessionStore.getState()._eventListeners;

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
          session.capabilities?.can_transmit === true
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
            session.capabilities?.can_transmit === true) ||
          (session.lifecycleState === "disconnected" && session.hasQueuedMessages)
      )
    )
  );
}

/** Multi-bus state returned by useMultiBusState hook */
export interface MultiBusState {
  /** Whether multi-bus mode is active */
  multiBusMode: boolean;
  /** Profile IDs in the multi-bus session */
  multiBusProfiles: string[];
  /** Source profile ID (preserved when switching to buffer) */
  sourceProfileId: string | null;
  /** Enable/disable multi-bus mode */
  setMultiBusMode: (enabled: boolean) => void;
  /** Set profiles in multi-bus session */
  setMultiBusProfiles: (profiles: string[]) => void;
  /** Set source profile ID */
  setSourceProfileId: (profileId: string | null) => void;
  /** Reset all multi-bus state */
  resetMultiBusState: () => void;
}

/** Get multi-bus state and setters */
export function useMultiBusState(): MultiBusState {
  return useSessionStore(
    useShallow((s) => ({
      multiBusMode: s.multiBusMode,
      multiBusProfiles: s.multiBusProfiles,
      sourceProfileId: s.sourceProfileId,
      setMultiBusMode: s.setMultiBusMode,
      setMultiBusProfiles: s.setMultiBusProfiles,
      setSourceProfileId: s.setSourceProfileId,
      resetMultiBusState: s.resetMultiBusState,
    }))
  );
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
  /** Listener ID for this app (e.g., "discovery", "decoder") */
  listenerId: string;
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
    listenerId,
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
  });

  // Register this listener with the session
  await registerSessionListener(sessionId, listenerId);

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
  /** Listener ID for this app */
  listenerId: string;
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
  const { sessionId, listenerId, sourceProfileIds = [] } = options;

  // Join the existing session
  const joinResult = await joinReaderSession(sessionId);

  // Register this listener with the session
  await registerSessionListener(sessionId, listenerId);

  return {
    sessionId,
    sourceProfileIds,
    capabilities: joinResult.capabilities,
  };
}
