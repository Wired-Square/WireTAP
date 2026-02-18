// ui/src/hooks/useIOSession.ts
//
// React hook for managing IO sessions with scoped event handling.
// Each hook instance manages its own local state, queried from the backend on mount.
// Tauri events update local state directly (no Zustand caching).
// This enables cross-window sync since events are broadcast to all windows.
//
// SIMPLIFIED MODEL: Session ID = Profile ID
// Multiple apps using the same profile automatically share the session.
//
// Listener management is handled by Rust backend:
// - registerSessionListener() - registers this hook as a listener
// - unregisterSessionListener() - removes this hook as a listener
// - Rust tracks all listeners and destroys session when last one leaves

import { useEffect, useRef, useCallback, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSessionStore } from "../stores/sessionStore";

// Module-level map to track sessions being reinitialized.
// This persists across re-renders and prevents the effect from
// trying to openSession while reinitialize() is in progress.
// The value is a timestamp of when reinitialize completed, used to
// skip effect state updates for a short window after reinitialize.
const reinitializingSessions = new Map<string, number | true>();

// Grace period (ms) after reinitialize completes during which effects
// should skip resetting localState. This prevents race conditions where
// the effects run after setIoProfile() triggers a re-render.
const REINITIALIZE_GRACE_PERIOD_MS = 300;
import {
  setSessionListenerActive,
  getIOSessionState,
  getIOSessionCapabilities,
  getReaderSessionJoinerCount,
  getStateType,
  parseStateString,
  type IOCapabilities,
  type IOStateType,
  type StreamEndedPayload,
  type SessionSuspendedPayload,
  type SessionResumingPayload,
  type StateChangePayload,
  type CanTransmitFrame,
  type TransmitResult,
  type PlaybackPosition,
  type RawBytesPayload,
} from "../api/io";
import type { FrameMessage } from "../stores/discoveryStore";

// ============================================================================
// Local Session State Type
// ============================================================================

/**
 * Local session state managed by useIOSession.
 * This is updated from backend queries on mount and Tauri events during operation.
 * NOT cached in Zustand - each hook instance manages its own state.
 */
interface LocalSessionState {
  /** IO state from backend (running/stopped/paused/etc) */
  ioState: IOStateType;
  /** IO capabilities (null until connected) */
  capabilities: IOCapabilities | null;
  /** Error message if ioState is "error" */
  errorMessage: string | null;
  /** Number of listeners connected to this session */
  listenerCount: number;
  /** Whether session is ready (created and listeners attached) */
  isReady: boolean;
  /** Buffer info */
  buffer: {
    available: boolean;
    id: string | null;
    type: "frames" | "bytes" | null;
    count: number;
    owningSessionId: string | null;
    startTimeUs: number | null;
    endTimeUs: number | null;
  };
  /** Whether the session was stopped explicitly by user */
  stoppedExplicitly: boolean;
  /** Reason why the stream ended */
  streamEndedReason: "complete" | "stopped" | "disconnected" | "error" | null;
  /** Current playback speed */
  speed: number | null;
  /** Current playback position */
  playbackPosition: PlaybackPosition | null;
}

export interface UseIOSessionOptions {
  /**
   * App name for identifying this hook instance in logs and callbacks.
   * Used as the listener ID for callback registration.
   * Example: "discovery", "decoder", "transmit"
   */
  appName: string;
  /**
   * Session ID = Profile ID.
   * Multiple apps using the same profileId automatically share the session.
   * Pass undefined/empty if no profile selected yet.
   */
  sessionId?: string;
  /**
   * Human-readable profile name for display in UI.
   * If not provided, falls back to sessionId.
   */
  profileName?: string;
  /**
   * @deprecated Use sessionId directly - it IS the profile ID now.
   * Kept for backwards compatibility during migration.
   */
  profileId?: string;
  /**
   * Only join sessions that produce frames (not raw bytes).
   * If the existing session produces bytes, don't join it.
   * Used by Decoder which only works with frame data.
   */
  requireFrames?: boolean;
  /** Callback when frames are received */
  onFrames?: (frames: FrameMessage[]) => void;
  /** Callback when raw bytes are received (serial byte streams) */
  onBytes?: (payload: RawBytesPayload) => void;
  /** Callback on error */
  onError?: (error: string) => void;
  /** Callback when playback position updates (timestamp and frame index) */
  onTimeUpdate?: (position: PlaybackPosition) => void;
  /** Callback when stream ends (GVRET disconnect, PostgreSQL complete, etc.) */
  onStreamEnded?: (payload: StreamEndedPayload) => void;
  /** Callback when buffer playback completes naturally (reached end of buffer) */
  onStreamComplete?: () => void;
  /** Callback when playback speed changes (from any listener on this session) */
  onSpeedChange?: (speed: number) => void;
  /** Callback when session is reconfigured (e.g., bookmark jump) - apps should clear their state */
  onReconfigure?: () => void;
  /** Callback when session is suspended (stopped with buffer available) */
  onSuspended?: (payload: SessionSuspendedPayload) => void;
  /** Callback when session is resuming with a new buffer - apps should clear their frame lists */
  onResuming?: (payload: SessionResumingPayload) => void;
  /** Callback when session is destroyed externally (e.g., from Session Manager or last-listener auto-destroy) */
  onDestroyed?: (orphanedBufferIds: string[]) => void;
}

export interface UseIOSessionResult {
  /** Session ID (= profile ID) */
  sessionId: string;
  /** @deprecated Same as sessionId now */
  actualSessionId: string;
  /** IO device capabilities (null until session is created) */
  capabilities: IOCapabilities | null;
  /** Current IO session state */
  state: IOStateType;
  /** Whether the session is ready (created and listeners attached) */
  isReady: boolean;
  /** Error message if state is 'error' */
  errorMessage: string | null;
  /** Whether buffer data is available for replay (set after stream ends) */
  bufferAvailable: boolean;
  /** ID of the buffer that was created (set after stream ends) */
  bufferId: string | null;
  /** Type of buffer: "frames" or "bytes" (set after stream ends) */
  bufferType: "frames" | "bytes" | null;
  /** Number of items in the buffer - frames or bytes depending on type (set after stream ends) */
  bufferCount: number;
  /** Session ID that owns this buffer (for detecting ingest/cross-app buffers) */
  bufferOwningSessionId: string | null;
  /** Start time of buffer data in microseconds (null if empty or unknown) */
  bufferStartTimeUs: number | null;
  /** End time of buffer data in microseconds (null if empty or unknown) */
  bufferEndTimeUs: number | null;
  /** Number of apps connected to this session (for showing Detach vs Stop) */
  joinerCount: number;
  /** Whether the session was stopped explicitly by user (vs stream ending naturally) */
  stoppedExplicitly: boolean;
  /** Reason why the stream ended: "complete" = natural end, "stopped" = explicit stop */
  streamEndedReason: "complete" | "stopped" | "disconnected" | "error" | null;
  /** Current playback speed (null until set, 1 = realtime, 0 = unlimited) */
  speed: number | null;
  /** Current playback position (centralised for all apps sharing this session) */
  playbackPosition: PlaybackPosition | null;
  /** Convenience: playbackPosition?.timestamp_us */
  currentTimeUs: number | null;
  /** Convenience: playbackPosition?.frame_index */
  currentFrameIndex: number | null;

  // Actions
  /** Start the reader */
  start: () => Promise<void>;
  /** Stop the reader */
  stop: () => Promise<void>;
  /** Leave the session without stopping (for shared sessions) */
  leave: () => Promise<void>;
  /** Pause the reader (only if capabilities.can_pause) */
  pause: () => Promise<void>;
  /** Resume the reader from pause */
  resume: () => Promise<void>;
  /** Suspend the session - stops streaming, finalizes buffer, session stays alive */
  suspend: () => Promise<void>;
  /** Resume a suspended session with a fresh buffer (orphans old buffer) */
  resumeFresh: () => Promise<void>;
  /** Update playback speed (only if capabilities.supports_speed_control) */
  setSpeed: (speed: number) => Promise<void>;
  /** Update time range (only when stopped, if capabilities.supports_time_range) */
  setTimeRange: (start?: string, end?: string) => Promise<void>;
  /** Seek to a specific timestamp (only if capabilities.supports_seek) */
  seek: (timestampUs: number) => Promise<void>;
  /** Seek to a specific frame index (preferred for buffer playback - avoids float issues) */
  seekByFrame: (frameIndex: number) => Promise<void>;
  /** Reinitialize the session (e.g., after profile change, file selection, or buffer switch) */
  reinitialize: (
    profileId?: string,
    options?: {
      filePath?: string;
      useBuffer?: boolean;
      startTime?: string;
      endTime?: string;
      speed?: number;
      limit?: number;
      // Serial framing configuration
      framingEncoding?: "slip" | "modbus_rtu" | "delimiter" | "raw";
      delimiter?: number[];
      maxFrameLength?: number;
      // Frame ID extraction
      frameIdStartByte?: number;
      frameIdBytes?: number;
      frameIdBigEndian?: boolean;
      // Source address extraction
      sourceAddressStartByte?: number;
      sourceAddressBytes?: number;
      sourceAddressBigEndian?: boolean;
      // Other options
      minFrameLength?: number;
      emitRawBytes?: boolean;
      // Bus override for single-bus devices (0-7)
      busOverride?: number;
      // Skip auto-starting playback sources (for connect-only mode)
      skipAutoStart?: boolean;
      // Override session ID (for recorded sources that need unique IDs per instance)
      sessionIdOverride?: string;
    }
  ) => Promise<void>;
  /** Switch to buffer replay mode (after stream ends with buffer data) */
  switchToBufferReplay: (speed?: number) => Promise<void>;
  /** Rejoin an existing session after leaving (for shared sessions) */
  rejoin: (profileId?: string, profileName?: string) => Promise<void>;
  /** Transmit a CAN frame (only if capabilities.can_transmit is true) */
  transmitFrame: (frame: CanTransmitFrame) => Promise<TransmitResult>;
}

/**
 * Hook for managing a CAN reader session.
 *
 * Creates a session on mount, listens for scoped events, and cleans up on unmount.
 * All session state is managed in sessionStore - this hook provides callbacks and actions.
 *
 * SIMPLIFIED MODEL: Session ID = Profile ID
 * - Pass the profile ID as sessionId (or profileId for backwards compat)
 * - Multiple apps using the same profile automatically share the session
 * - First app to use a profile creates the session, others join it
 */
export function useIOSession(
  options: UseIOSessionOptions
): UseIOSessionResult {
  const {
    appName,
    sessionId: sessionIdOption,
    profileName: profileNameOption,
    profileId: profileIdOption,
    requireFrames,
    onFrames,
    onBytes,
    onError,
    onTimeUpdate,
    onStreamEnded,
    onStreamComplete,
    onSpeedChange,
    onReconfigure,
    onSuspended,
    onResuming,
    onDestroyed,
  } = options;

  // Session ID = Profile ID (use sessionId if provided, fall back to profileId for compat)
  const effectiveSessionId = sessionIdOption || profileIdOption || "";
  // Profile name for display (fall back to session ID if not provided)
  const effectiveProfileName = profileNameOption || effectiveSessionId;

  // ---- Local Session State (queried from backend, updated via events) ----
  // This replaces the Zustand useSession() hook to enable cross-window sync.
  // Each hook instance manages its own state, updated by Tauri events.
  const [localState, setLocalState] = useState<LocalSessionState | null>(null);

  // Store actions
  const openSession = useSessionStore((s) => s.openSession);
  const startSession = useSessionStore((s) => s.startSession);
  const stopSession = useSessionStore((s) => s.stopSession);
  const pauseSession = useSessionStore((s) => s.pauseSession);
  const resumeSession = useSessionStore((s) => s.resumeSession);
  const suspendSession = useSessionStore((s) => s.suspendSession);
  const resumeSessionFresh = useSessionStore((s) => s.resumeSessionFresh);
  const leaveSession = useSessionStore((s) => s.leaveSession);
  const setSessionSpeed = useSessionStore((s) => s.setSessionSpeed);
  const setSessionTimeRange = useSessionStore((s) => s.setSessionTimeRange);
  const seekSession = useSessionStore((s) => s.seekSession);
  const seekSessionByFrame = useSessionStore((s) => s.seekSessionByFrame);
  const switchToBuffer = useSessionStore((s) => s.switchToBuffer);
  const reinitializeSession = useSessionStore((s) => s.reinitializeSession);
  const registerCallbacks = useSessionStore((s) => s.registerCallbacks);
  const clearCallbacks = useSessionStore((s) => s.clearCallbacks);
  const transmitFrameAction = useSessionStore((s) => s.transmitFrame);

  const initializingRef = useRef(false);
  // Track whether setup completed successfully (for cleanup)
  const setupCompleteRef = useRef(false);
  // Track whether component is mounted (to prevent cleanup after remount)
  const isMountedRef = useRef(true);
  // Track the currently active session ID (for cleanup to check if session changed)
  const currentSessionIdRef = useRef<string | null>(null);
  // Listener ID is the app name for clarity in debugging
  const listenerIdRef = useRef<string>(appName);
  // Track if we're currently leaving to prevent double-leave
  const isLeavingRef = useRef(false);
  // Track when session was created/joined to prevent immediate leave (click-through protection)
  const sessionCreatedAtRef = useRef<number>(0);
  // Track the expected state from reinitialize - used to return correct state before React commits the update
  // This is needed because Zustand updates (setIoProfile) trigger re-renders before React state (setLocalState) is committed
  const expectedStateRef = useRef<{ sessionId: string; state: LocalSessionState } | null>(null);
  // Track orphaned buffer IDs from buffer-orphaned events (set before session-lifecycle "destroyed")
  const orphanedBufferIdsRef = useRef<string[]>([]);

  // Store callbacks in refs to keep them current
  const callbacksRef = useRef({
    onFrames,
    onBytes,
    onError,
    onTimeUpdate,
    onStreamEnded,
    onStreamComplete,
    onSpeedChange,
    onReconfigure,
    onSuspended,
    onResuming,
    onDestroyed,
  });
  useEffect(() => {
    callbacksRef.current = {
      onFrames,
      onBytes,
      onError,
      onTimeUpdate,
      onStreamEnded,
      onStreamComplete,
      onSpeedChange,
      onReconfigure,
      onSuspended,
      onResuming,
      onDestroyed,
    };
  }, [onFrames, onBytes, onError, onTimeUpdate, onStreamEnded, onStreamComplete, onSpeedChange, onReconfigure, onSuspended, onResuming, onDestroyed]);

  // ---- Query Backend + Set Up Event Listeners ----
  // This effect queries the backend for current state on mount/sessionId change,
  // then sets up event listeners that update local state directly.
  // This enables cross-window sync since each window receives the same Tauri events.
  useEffect(() => {
    if (!effectiveSessionId) {
      setLocalState(null);
      orphanedBufferIdsRef.current = [];
      return;
    }

    // Reset orphaned buffer IDs when session changes
    orphanedBufferIdsRef.current = [];

    let cancelled = false;
    const unlistenFns: UnlistenFn[] = [];

    const setupStateTracking = async () => {
      // Query backend for current state
      try {
        const [state, caps, joinerCount] = await Promise.all([
          getIOSessionState(effectiveSessionId),
          getIOSessionCapabilities(effectiveSessionId),
          getReaderSessionJoinerCount(effectiveSessionId),
        ]);

        if (cancelled) return;

        if (state && caps) {
          setLocalState({
            ioState: getStateType(state),
            capabilities: caps,
            errorMessage: state.type === "Error" ? state.message : null,
            listenerCount: joinerCount,
            isReady: true,
            buffer: {
              available: false,
              id: null,
              type: null,
              count: 0,
              owningSessionId: null,
              startTimeUs: null,
              endTimeUs: null,
            },
            stoppedExplicitly: false,
            streamEndedReason: null,
            speed: null,
            playbackPosition: null,
          });
        } else {
          // Session doesn't exist yet - will be created by openSession below
          // BUT: don't clear state if reinitialize just set it (grace period)
          const reinitValue = reinitializingSessions.get(effectiveSessionId);
          const inGracePeriod = typeof reinitValue === "number" && Date.now() - reinitValue < REINITIALIZE_GRACE_PERIOD_MS;
          if (!inGracePeriod) {
            setLocalState(null);
          }
        }
      } catch (e) {
        console.log(`[useIOSession:${appName}] Failed to query backend state:`, e);
        // Session may not exist yet - that's fine, openSession will create it
      }

      // Set up event listeners that update local state
      // These are in addition to sessionStore listeners (which handle callback routing)

      // State changes
      const unlistenState = await listen<StateChangePayload>(
        `session-state:${effectiveSessionId}`,
        (event) => {
          const newState = parseStateString(event.payload.current);
          const errorMessage =
            newState === "error" && event.payload.current.startsWith("error:")
              ? event.payload.current.slice(6)
              : null;
          // Clear expectedStateRef so this state update takes effect
          // (expectedStateRef is only used during the brief reinitialize window)
          expectedStateRef.current = null;
          setLocalState((prev) =>
            prev
              ? { ...prev, ioState: newState, errorMessage, isReady: true }
              : null
          );
        }
      );
      unlistenFns.push(unlistenState);

      // Joiner count changes
      const unlistenJoiner = await listen<{ count: number }>(
        `joiner-count-changed:${effectiveSessionId}`,
        (event) => {
          setLocalState((prev) =>
            prev ? { ...prev, listenerCount: event.payload.count } : null
          );
        }
      );
      unlistenFns.push(unlistenJoiner);

      // Speed changes
      const unlistenSpeed = await listen<number>(
        `speed-changed:${effectiveSessionId}`,
        (event) => {
          setLocalState((prev) =>
            prev ? { ...prev, speed: event.payload } : null
          );
        }
      );
      unlistenFns.push(unlistenSpeed);

      // Playback position
      const unlistenPosition = await listen<PlaybackPosition>(
        `playback-time:${effectiveSessionId}`,
        (event) => {
          setLocalState((prev) =>
            prev ? { ...prev, playbackPosition: event.payload } : null
          );
        }
      );
      unlistenFns.push(unlistenPosition);

      // Stream complete
      const unlistenComplete = await listen<boolean>(
        `stream-complete:${effectiveSessionId}`,
        () => {
          // Clear expectedStateRef so this state update takes effect
          expectedStateRef.current = null;
          setLocalState((prev) =>
            prev ? { ...prev, ioState: "stopped" } : null
          );
        }
      );
      unlistenFns.push(unlistenComplete);

      // Stream ended
      const unlistenEnded = await listen<StreamEndedPayload>(
        `stream-ended:${effectiveSessionId}`,
        (event) => {
          const payload = event.payload;
          // Clear expectedStateRef so this state update takes effect
          expectedStateRef.current = null;
          setLocalState((prev) =>
            prev
              ? {
                  ...prev,
                  ioState: "stopped",
                  streamEndedReason: payload.reason as LocalSessionState["streamEndedReason"],
                  buffer: {
                    available: payload.buffer_available,
                    id: payload.buffer_id,
                    type: payload.buffer_type,
                    count: payload.count,
                    owningSessionId: payload.owning_session_id,
                    startTimeUs: payload.time_range?.[0] ?? null,
                    endTimeUs: payload.time_range?.[1] ?? null,
                  },
                }
              : null
          );
        }
      );
      unlistenFns.push(unlistenEnded);

      // Session suspended
      const unlistenSuspended = await listen<SessionSuspendedPayload>(
        `session-suspended:${effectiveSessionId}`,
        (event) => {
          const payload = event.payload;
          // Clear expectedStateRef so this state update takes effect
          expectedStateRef.current = null;
          setLocalState((prev) =>
            prev
              ? {
                  ...prev,
                  ioState: "stopped",
                  buffer: {
                    available: payload.buffer_count > 0,
                    id: payload.buffer_id,
                    type: payload.buffer_type,
                    count: payload.buffer_count,
                    owningSessionId: effectiveSessionId,
                    startTimeUs: payload.time_range?.[0] ?? null,
                    endTimeUs: payload.time_range?.[1] ?? null,
                  },
                }
              : null
          );
        }
      );
      unlistenFns.push(unlistenSuspended);

      // Session resuming
      const unlistenResuming = await listen<SessionResumingPayload>(
        `session-resuming:${effectiveSessionId}`,
        (event) => {
          // Clear expectedStateRef so this state update takes effect
          expectedStateRef.current = null;
          setLocalState((prev) =>
            prev
              ? {
                  ...prev,
                  ioState: "running", // Session is starting again
                  stoppedExplicitly: false,
                  streamEndedReason: null,
                  buffer: {
                    available: false,
                    id: event.payload.new_buffer_id,
                    type: null,
                    count: 0,
                    owningSessionId: effectiveSessionId,
                    startTimeUs: null,
                    endTimeUs: null,
                  },
                }
              : null
          );
        }
      );
      unlistenFns.push(unlistenResuming);

      // Session error
      const unlistenError = await listen<string>(
        `session-error:${effectiveSessionId}`,
        (event) => {
          setLocalState((prev) =>
            prev
              ? { ...prev, ioState: "error", errorMessage: event.payload }
              : null
          );
        }
      );
      unlistenFns.push(unlistenError);

      // Buffer orphaned - fires when session's buffers are orphaned (before session-lifecycle "destroyed").
      // Captures buffer IDs so the onDestroyed callback can transition to buffer mode.
      const unlistenBufferOrphaned = await listen<{ buffer_id: string; buffer_name: string; buffer_type: string; count: number }>(
        `buffer-orphaned:${effectiveSessionId}`,
        (event) => {
          if (cancelled) return;
          const id = event.payload.buffer_id;
          if (id && !orphanedBufferIdsRef.current.includes(id)) {
            orphanedBufferIdsRef.current = [...orphanedBufferIdsRef.current, id];
          }
        }
      );
      unlistenFns.push(unlistenBufferOrphaned);

      // Session destroyed externally (from Session Manager, last-listener auto-destroy, etc.)
      // This is a global event - we filter by our session ID.
      const unlistenLifecycle = await listen<{ session_id: string; event_type: string }>(
        "session-lifecycle",
        (event) => {
          if (cancelled) return;
          if (
            event.payload.event_type === "destroyed" &&
            event.payload.session_id === effectiveSessionId
          ) {
            console.log(
              `[useIOSession:${appName}] Session '${effectiveSessionId}' destroyed externally`
            );
            // Prevent the cleanup timeout (from the mount effect) from trying to leave
            setupCompleteRef.current = false;
            currentSessionIdRef.current = null;
            // Clean up session store entry (local-only, session is already gone in Rust)
            useSessionStore.getState().cleanupDestroyedSession(effectiveSessionId);
            // Clear local state
            setLocalState(null);
            // Notify higher-level hooks with orphaned buffer IDs
            const bufferIds = orphanedBufferIdsRef.current;
            orphanedBufferIdsRef.current = [];
            callbacksRef.current.onDestroyed?.(bufferIds);
          }
        }
      );
      unlistenFns.push(unlistenLifecycle);
    };

    setupStateTracking();

    return () => {
      cancelled = true;
      for (const unlisten of unlistenFns) {
        try {
          unlisten();
        } catch {
          // Ignore - event may have already been unlistened
        }
      }
    };
  }, [effectiveSessionId, appName]);

  // Initialize session on mount
  useEffect(() => {
    // Mark component as mounted
    isMountedRef.current = true;

    // No session ID means no profile selected - nothing to do
    // BUT we need to update currentSessionIdRef so that cleanup for the OLD session
    // will properly run (it checks if currentSession === cleanupSession to detect StrictMode)
    if (!effectiveSessionId) {
      console.log(`[useIOSession:${appName}] no effectiveSessionId, updating currentSessionIdRef to null and skipping`);
      currentSessionIdRef.current = null;
      return;
    }

    if (initializingRef.current) {
      console.log(`[useIOSession:${appName}] already initializing, skipping`);
      return;
    }

    const reinitValue = reinitializingSessions.get(effectiveSessionId);
    if (reinitValue === true) {
      // Reinitialize in progress - skip
      console.log(`[useIOSession:${appName}] reinitializing in progress for session '${effectiveSessionId}', skipping effect setup`);
      return;
    }
    if (typeof reinitValue === "number" && Date.now() - reinitValue < REINITIALIZE_GRACE_PERIOD_MS) {
      // Within grace period after reinitialize - skip since reinitialize already set up state
      console.log(`[useIOSession:${appName}] within reinitialize grace period for session '${effectiveSessionId}', skipping effect setup`);
      return;
    }

    console.log(`[useIOSession:${appName}] ========== MOUNT/EFFECT ==========`);
    console.log(`[useIOSession:${appName}]   effectiveSessionId: ${effectiveSessionId}`);

    // Reset setup complete flag at start of each effect run
    setupCompleteRef.current = false;

    const setup = async () => {
      initializingRef.current = true;
      console.log(`[useIOSession:${appName}] setup() starting...`);

      try {
        // Open session (creates if not exists, joins if exists)
        // This also registers this listener with the Rust backend
        console.log(`[useIOSession:${appName}] calling openSession...`);
        await openSession(effectiveSessionId, effectiveProfileName, listenerIdRef.current, {
          requireFrames,
        });
        console.log(`[useIOSession:${appName}] openSession completed`);

        // Check if component was unmounted during async work
        if (!isMountedRef.current) {
          console.log(`[useIOSession:${appName}] component unmounted during openSession, cleaning up`);
          // Unregister from Rust since we registered during openSession
          leaveSession(effectiveSessionId, listenerIdRef.current).catch(() => {});
          initializingRef.current = false;
          return;
        }

        // Register callbacks with the frontend store for event routing
        console.log(`[useIOSession:${appName}] calling registerCallbacks...`);
        registerCallbacks(effectiveSessionId, listenerIdRef.current, {
          onFrames: (frames) => callbacksRef.current.onFrames?.(frames),
          onBytes: (payload) => callbacksRef.current.onBytes?.(payload),
          onError: (error) => callbacksRef.current.onError?.(error),
          onTimeUpdate: (position) => callbacksRef.current.onTimeUpdate?.(position),
          onStreamEnded: (payload) => callbacksRef.current.onStreamEnded?.(payload),
          onStreamComplete: () => callbacksRef.current.onStreamComplete?.(),
          onSpeedChange: (speed) => callbacksRef.current.onSpeedChange?.(speed),
          onReconfigure: () => callbacksRef.current.onReconfigure?.(),
          onSuspended: (payload) => callbacksRef.current.onSuspended?.(payload),
          onResuming: (payload) => callbacksRef.current.onResuming?.(payload),
        });
        console.log(`[useIOSession:${appName}] registerCallbacks completed`);

        // Initialize local state after session is created/joined
        // This ensures we have state even if the state tracking effect ran first
        try {
          const [state, caps, joinerCount] = await Promise.all([
            getIOSessionState(effectiveSessionId),
            getIOSessionCapabilities(effectiveSessionId),
            getReaderSessionJoinerCount(effectiveSessionId),
          ]);
          if (state && caps && isMountedRef.current) {
            setLocalState({
              ioState: getStateType(state),
              capabilities: caps,
              errorMessage: state.type === "Error" ? state.message : null,
              listenerCount: joinerCount,
              isReady: true,
              buffer: {
                available: false,
                id: null,
                type: null,
                count: 0,
                owningSessionId: null,
                startTimeUs: null,
                endTimeUs: null,
              },
              stoppedExplicitly: false,
              streamEndedReason: null,
              speed: null,
              playbackPosition: null,
            });
            console.log(`[useIOSession:${appName}] local state initialized: ioState=${getStateType(state)}`);
          }
        } catch (e) {
          console.warn(`[useIOSession:${appName}] Failed to initialize local state:`, e);
        }

        // Mark setup as complete and track current session
        setupCompleteRef.current = true;
        sessionCreatedAtRef.current = Date.now();
        console.log(`[useIOSession:${appName}] setup() - updating currentSessionIdRef from '${currentSessionIdRef.current}' to '${effectiveSessionId}'`);
        currentSessionIdRef.current = effectiveSessionId;
        console.log(`[useIOSession:${appName}] setup() complete, setupComplete=true, currentSessionIdRef='${currentSessionIdRef.current}'`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[useIOSession:${appName}] setup() failed:`, msg);
        // Don't show error for expected errors
        if (
          msg !== "No IO profile configured" &&
          !msg.includes("not found")
        ) {
          callbacksRef.current.onError?.(msg);
        }
      } finally {
        initializingRef.current = false;
      }
    };

    setup();

    return () => {
      console.log(`[useIOSession:${appName}] ========== CLEANUP ==========`);
      console.log(`[useIOSession:${appName}]   effectiveSessionId: ${effectiveSessionId}`);
      console.log(`[useIOSession:${appName}]   currentSessionIdRef: ${currentSessionIdRef.current}`);
      console.log(`[useIOSession:${appName}]   setupCompleteRef.current: ${setupCompleteRef.current}`);
      console.log(`[useIOSession:${appName}]   isMountedRef.current: ${isMountedRef.current}`);
      console.log(`[useIOSession:${appName}]   cleanup triggered at:`, new Error().stack);

      // Mark component as unmounted immediately
      isMountedRef.current = false;

      // Only clean up if setup actually completed
      if (setupCompleteRef.current) {
        // Mark as not complete to prevent double cleanup
        setupCompleteRef.current = false;

        // Capture values for delayed cleanup
        const listenerId = listenerIdRef.current;
        const sessionId = effectiveSessionId;

        // Delay cleanup to handle StrictMode remount
        // StrictMode unmounts and immediately remounts with the SAME session ID.
        // When switching sessions normally, we get cleanup for old ID then setup for new ID.
        // We need to distinguish these cases to avoid skipping cleanup when switching sessions.
        setTimeout(() => {
          // Only skip cleanup if:
          // 1. Component is still mounted AND
          // 2. The CURRENT active session is the SAME as the one we're trying to clean up
          //    (this means StrictMode remounted with the same session - don't clean up)
          //
          // If the current session is DIFFERENT (session switching), we must clean up the old one
          // even though the component is mounted (with the new session)
          //
          // Use currentSessionIdRef to check what session the component is CURRENTLY using,
          // not what session was used when this cleanup was created.
          console.log(`[useIOSession:${appName}] cleanup timeout - isMounted=${isMountedRef.current}, currentSession=${currentSessionIdRef.current}, cleanupSession=${sessionId}`);
          if (isMountedRef.current && currentSessionIdRef.current === sessionId) {
            console.log(`[useIOSession:${appName}] skipping cleanup - component remounted with same session`);
            return;
          }

          console.log(`[useIOSession:${appName}] proceeding with cleanup for session '${sessionId}'...`);

          // Clear frontend callbacks
          clearCallbacks(sessionId, listenerId);

          // Unregister from Rust backend - Rust will destroy session if last listener
          console.log(`[useIOSession:${appName}] calling leaveSession('${sessionId}', '${listenerId}')...`);
          leaveSession(sessionId, listenerId).catch(() => {});
        }, 100);
      } else {
        console.log(`[useIOSession:${appName}] setup not complete, skipping cleanup`);
      }
    };
  }, [
    appName,
    effectiveSessionId,
    requireFrames,
    openSession,
    registerCallbacks,
    clearCallbacks,
    leaveSession,
  ]);

  // Action wrappers - all use effectiveSessionId directly
  const start = useCallback(async () => {
    console.log(`[useIOSession:${appName}] start() called, effectiveSessionId=${effectiveSessionId}`);
    if (!effectiveSessionId) {
      console.log(`[useIOSession:${appName}] start() - no effectiveSessionId, returning`);
      return;
    }
    try {
      console.log(`[useIOSession:${appName}] start() - calling startSession...`);
      await startSession(effectiveSessionId);
      console.log(`[useIOSession:${appName}] start() - startSession completed`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[useIOSession:${appName}] start() - ERROR: ${msg}`);
      callbacksRef.current.onError?.(msg);
    }
  }, [appName, effectiveSessionId, startSession]);

  const stop = useCallback(async () => {
    console.log(`[useIOSession:${appName}] stop() called, effectiveSessionId=${effectiveSessionId}, currentSessionIdRef=${currentSessionIdRef.current}`);
    if (!effectiveSessionId) {
      console.log(`[useIOSession:${appName}] stop() - no effectiveSessionId, returning`);
      return;
    }
    try {
      console.log(`[useIOSession:${appName}] stop() - calling stopSession...`);
      await stopSession(effectiveSessionId);
      console.log(`[useIOSession:${appName}] stop() - stopSession complete`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[useIOSession:${appName}] stop() - ERROR: ${msg}`);
      if (!msg.includes("not found")) {
        callbacksRef.current.onError?.(msg);
      }
    }
  }, [appName, effectiveSessionId, stopSession]);

  const leave = useCallback(async () => {
    console.log(`[useIOSession:${appName}] leave() called, effectiveSessionId=${effectiveSessionId}, currentSessionIdRef=${currentSessionIdRef.current}`);
    console.log(`[useIOSession:${appName}] leave() triggered from:`, new Error().stack);
    if (!effectiveSessionId) {
      console.log(`[useIOSession:${appName}] leave() - no effectiveSessionId, returning`);
      return;
    }
    // Prevent multiple concurrent leave calls
    if (isLeavingRef.current) {
      console.log(`[useIOSession:${appName}] leave() - already leaving, skipping`);
      return;
    }
    // Prevent immediate leave after session creation (click-through protection)
    // This prevents accidental leave when dialog closes and click propagates
    const timeSinceCreation = Date.now() - sessionCreatedAtRef.current;
    if (timeSinceCreation < 500) {
      console.log(`[useIOSession:${appName}] leave() - session just created (${timeSinceCreation}ms ago), skipping to prevent click-through`);
      return;
    }
    isLeavingRef.current = true;
    try {
      // First, mark listener as inactive in Rust so it stops receiving frames immediately
      // This is done before clearing callbacks to prevent race conditions
      try {
        console.log(`[useIOSession:${appName}] leave() - marking listener inactive...`);
        await setSessionListenerActive(effectiveSessionId, listenerIdRef.current, false);
      } catch {
        // Ignore - session may not exist
      }
      console.log(`[useIOSession:${appName}] leave() - clearing callbacks...`);
      clearCallbacks(effectiveSessionId, listenerIdRef.current);
      console.log(`[useIOSession:${appName}] leave() - calling leaveSession...`);
      await leaveSession(effectiveSessionId, listenerIdRef.current);
      console.log(`[useIOSession:${appName}] leave() - complete`);
    } finally {
      isLeavingRef.current = false;
    }
  }, [appName, effectiveSessionId, leaveSession, clearCallbacks]);

  const pause = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await pauseSession(effectiveSessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      callbacksRef.current.onError?.(msg);
    }
  }, [effectiveSessionId, pauseSession]);

  const resume = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await resumeSession(effectiveSessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      callbacksRef.current.onError?.(msg);
    }
  }, [effectiveSessionId, resumeSession]);

  const suspend = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await suspendSession(effectiveSessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      callbacksRef.current.onError?.(msg);
    }
  }, [effectiveSessionId, suspendSession]);

  const resumeFresh = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await resumeSessionFresh(effectiveSessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      callbacksRef.current.onError?.(msg);
    }
  }, [effectiveSessionId, resumeSessionFresh]);

  const setSpeed = useCallback(
    async (speed: number) => {
      if (!effectiveSessionId) return;
      try {
        await setSessionSpeed(effectiveSessionId, speed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        callbacksRef.current.onError?.(msg);
      }
    },
    [effectiveSessionId, setSessionSpeed]
  );

  const setTimeRange = useCallback(
    async (start?: string, end?: string) => {
      console.log("[useIOSession:setTimeRange] Called with start:", start, "end:", end, "sessionId:", effectiveSessionId);
      if (!effectiveSessionId) {
        console.warn("[useIOSession:setTimeRange] No effectiveSessionId, skipping");
        return;
      }
      try {
        await setSessionTimeRange(effectiveSessionId, start, end);
        console.log("[useIOSession:setTimeRange] setSessionTimeRange completed");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[useIOSession:setTimeRange] Error:", msg);
        callbacksRef.current.onError?.(msg);
      }
    },
    [effectiveSessionId, setSessionTimeRange]
  );

  const seek = useCallback(
    async (timestampUs: number) => {
      if (!effectiveSessionId) return;
      try {
        await seekSession(effectiveSessionId, timestampUs);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        callbacksRef.current.onError?.(msg);
      }
    },
    [effectiveSessionId, seekSession]
  );

  const seekByFrame = useCallback(
    async (frameIndex: number) => {
      if (!effectiveSessionId) return;
      try {
        await seekSessionByFrame(effectiveSessionId, frameIndex);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        callbacksRef.current.onError?.(msg);
      }
    },
    [effectiveSessionId, seekSessionByFrame]
  );

  const reinitialize = useCallback(
    async (
      newProfileId?: string,
      opts?: {
        filePath?: string;
        useBuffer?: boolean;
        startTime?: string;
        endTime?: string;
        speed?: number;
        limit?: number;
        framingEncoding?: "slip" | "modbus_rtu" | "delimiter" | "raw";
        delimiter?: number[];
        maxFrameLength?: number;
        frameIdStartByte?: number;
        frameIdBytes?: number;
        frameIdBigEndian?: boolean;
        sourceAddressStartByte?: number;
        sourceAddressBytes?: number;
        sourceAddressBigEndian?: boolean;
        minFrameLength?: number;
        emitRawBytes?: boolean;
        busOverride?: number;
        skipAutoStart?: boolean;
        sessionIdOverride?: string;
      }
    ) => {
      // For reinitialize, use new profile ID if provided, else current
      const targetProfileId = newProfileId || effectiveSessionId;
      if (!targetProfileId) return;

      // Session ID can be overridden (for recorded sources that need unique IDs per instance)
      // Profile ID stays targetProfileId for looking up profile configuration
      const targetSessionId = opts?.sessionIdOverride || targetProfileId;

      // Mark as reinitializing in module-level map to prevent effect from running concurrently
      // This persists across re-renders, unlike a ref
      reinitializingSessions.set(targetSessionId, true);

      // Use the new profile ID for display when switching profiles, avoiding stale closure.
      // When newProfileId is provided (profile switching), it's the correct name.
      // When not provided (same-session reinit), effectiveProfileName is correct.
      const targetProfileName = newProfileId || effectiveProfileName;

      console.log(`[useIOSession:${appName}] reinitialize() - targetSessionId=${targetSessionId}, targetProfileId=${targetProfileId}, currentSession=${currentSessionIdRef.current}, profileName=${targetProfileName}`);

      try {
        // If switching to a different session, leave the old one first
        const oldSessionId = currentSessionIdRef.current;
        if (oldSessionId && oldSessionId !== targetSessionId) {
          console.log(`[useIOSession:${appName}] reinitialize() - switching sessions, leaving old session '${oldSessionId}'`);
          // Clear callbacks for old session
          clearCallbacks(oldSessionId, listenerIdRef.current);
          // Leave old session (Rust will destroy if we were the last listener)
          await leaveSession(oldSessionId, listenerIdRef.current);
        }

        // Reinitialize uses Rust's atomic check - if other listeners exist, it won't destroy
        // The backend doesn't auto-start playback sources (postgres, csv) - that happens in openSession
        // unless skipAutoStart is set
        await reinitializeSession(
          targetSessionId,
          listenerIdRef.current,
          targetProfileId,
          targetProfileName,
          {
            filePath: opts?.filePath,
            useBuffer: opts?.useBuffer,
            startTime: opts?.startTime,
            endTime: opts?.endTime,
            speed: opts?.speed,
            limit: opts?.limit,
            framingEncoding: opts?.framingEncoding,
            delimiter: opts?.delimiter,
            maxFrameLength: opts?.maxFrameLength,
            minFrameLength: opts?.minFrameLength,
            emitRawBytes: opts?.emitRawBytes,
            busOverride: opts?.busOverride,
            skipAutoStart: opts?.skipAutoStart,
          }
        );

        // Update current session ref with the actual session ID (may differ from profile ID)
        console.log(`[useIOSession:${appName}] reinitialize() - updating currentSessionIdRef from '${currentSessionIdRef.current}' to '${targetSessionId}'`);
        currentSessionIdRef.current = targetSessionId;
        console.log(`[useIOSession:${appName}] reinitialize() - currentSessionIdRef is now '${currentSessionIdRef.current}'`);

        // Re-register callbacks after reinitialize
        registerCallbacks(targetSessionId, listenerIdRef.current, {
          onFrames: (frames) => callbacksRef.current.onFrames?.(frames),
          onBytes: (payload) => callbacksRef.current.onBytes?.(payload),
          onError: (error) => callbacksRef.current.onError?.(error),
          onTimeUpdate: (position) => callbacksRef.current.onTimeUpdate?.(position),
          onStreamEnded: (payload) => callbacksRef.current.onStreamEnded?.(payload),
          onStreamComplete: () => callbacksRef.current.onStreamComplete?.(),
          onSpeedChange: (speed) => callbacksRef.current.onSpeedChange?.(speed),
          onReconfigure: () => callbacksRef.current.onReconfigure?.(),
          onSuspended: (payload) => callbacksRef.current.onSuspended?.(payload),
          onResuming: (payload) => callbacksRef.current.onResuming?.(payload),
        });

        // Update local state after reinitialize
        try {
          const [state, caps, joinerCount] = await Promise.all([
            getIOSessionState(targetSessionId),
            getIOSessionCapabilities(targetSessionId),
            getReaderSessionJoinerCount(targetSessionId),
          ]);
          if (state && caps) {
            const newState: LocalSessionState = {
              ioState: getStateType(state),
              capabilities: caps,
              errorMessage: state.type === "Error" ? state.message : null,
              listenerCount: joinerCount,
              isReady: true,
              buffer: {
                available: false,
                id: null,
                type: null,
                count: 0,
                owningSessionId: null,
                startTimeUs: null,
                endTimeUs: null,
              },
              stoppedExplicitly: false,
              streamEndedReason: null,
              speed: opts?.speed ?? null,
              playbackPosition: null,
            };
            // Store in ref BEFORE calling setLocalState - this ensures the ref is available
            // immediately, even before React commits the state update
            expectedStateRef.current = { sessionId: targetSessionId, state: newState };
            setLocalState(newState);
            console.log(`[useIOSession:${appName}] reinitialize() - local state updated: ioState=${getStateType(state)}`);
          }
        } catch (e) {
          console.warn(`[useIOSession:${appName}] reinitialize() - failed to update local state:`, e);
        }

        // Mark setup as complete for the new session
        console.log(`[useIOSession:${appName}] reinitialize() - setting setupCompleteRef=true for session ${targetSessionId}`);
        setupCompleteRef.current = true;
        sessionCreatedAtRef.current = Date.now();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        callbacksRef.current.onError?.(msg);
      } finally {
        // Set timestamp to mark end of reinitialize - effects will skip during grace period
        const completedAt = Date.now();
        reinitializingSessions.set(targetSessionId, completedAt);
        // Schedule cleanup after grace period
        setTimeout(() => {
          // Only delete if timestamp hasn't changed (no new reinitialize started)
          if (reinitializingSessions.get(targetSessionId) === completedAt) {
            reinitializingSessions.delete(targetSessionId);
          }
        }, REINITIALIZE_GRACE_PERIOD_MS + 50);
      }
    },
    [appName, effectiveSessionId, effectiveProfileName, reinitializeSession, registerCallbacks, clearCallbacks, leaveSession]
  );

  const switchToBufferReplay = useCallback(
    async (speed?: number) => {
      if (!effectiveSessionId) return;
      try {
        await switchToBuffer(effectiveSessionId, speed);

        // Refetch capabilities since the reader changed (BufferReader has different capabilities)
        const caps = await getIOSessionCapabilities(effectiveSessionId);
        if (caps) {
          setLocalState((prev) => prev ? { ...prev, capabilities: caps } : prev);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        callbacksRef.current.onError?.(msg);
      }
    },
    [effectiveSessionId, switchToBuffer]
  );

  const rejoin = useCallback(async (profileId?: string, profileName?: string) => {
    // Use provided profileId or fall back to current session ID
    const targetSessionId = profileId || effectiveSessionId;
    const targetProfileName = profileName || effectiveProfileName;
    if (!targetSessionId) return;
    try {
      await openSession(targetSessionId, targetProfileName, listenerIdRef.current, {});

      // Mark listener as active in Rust so it receives frames again
      try {
        await setSessionListenerActive(targetSessionId, listenerIdRef.current, true);
      } catch {
        // Ignore - listener may already be active
      }

      // Re-register callbacks
      registerCallbacks(targetSessionId, listenerIdRef.current, {
        onFrames: (frames) => callbacksRef.current.onFrames?.(frames),
        onBytes: (payload) => callbacksRef.current.onBytes?.(payload),
        onError: (error) => callbacksRef.current.onError?.(error),
        onTimeUpdate: (position) => callbacksRef.current.onTimeUpdate?.(position),
        onStreamEnded: (payload) => callbacksRef.current.onStreamEnded?.(payload),
        onStreamComplete: () => callbacksRef.current.onStreamComplete?.(),
        onSpeedChange: (speed) => callbacksRef.current.onSpeedChange?.(speed),
        onReconfigure: () => callbacksRef.current.onReconfigure?.(),
        onSuspended: (payload) => callbacksRef.current.onSuspended?.(payload),
        onResuming: (payload) => callbacksRef.current.onResuming?.(payload),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      callbacksRef.current.onError?.(msg);
    }
  }, [effectiveSessionId, effectiveProfileName, openSession, registerCallbacks]);

  const transmitFrame = useCallback(
    async (frame: CanTransmitFrame): Promise<TransmitResult> => {
      if (!effectiveSessionId) {
        return {
          success: false,
          timestamp_us: Date.now() * 1000,
          error: "No session",
        };
      }
      try {
        return await transmitFrameAction(effectiveSessionId, frame);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          timestamp_us: Date.now() * 1000,
          error: msg,
        };
      }
    },
    [effectiveSessionId, transmitFrameAction]
  );

  // Derive values from local state (queried from backend, updated via events)
  // Use expectedStateRef if it matches the current session - this handles the race condition
  // where setIoProfile() triggers a re-render before setLocalState() is committed
  const effectiveState = (
    expectedStateRef.current?.sessionId === effectiveSessionId
      ? expectedStateRef.current.state
      : localState
  );

  return {
    sessionId: effectiveSessionId,
    actualSessionId: effectiveSessionId, // Same as sessionId now (kept for backwards compat)
    capabilities: effectiveState?.capabilities ?? null,
    state: effectiveState?.ioState ?? "stopped",
    isReady: effectiveState?.isReady ?? false,
    errorMessage: effectiveState?.errorMessage ?? null,
    bufferAvailable: effectiveState?.buffer?.available ?? false,
    bufferId: effectiveState?.buffer?.id ?? null,
    bufferType: effectiveState?.buffer?.type ?? null,
    bufferCount: effectiveState?.buffer?.count ?? 0,
    bufferOwningSessionId: effectiveState?.buffer?.owningSessionId ?? null,
    bufferStartTimeUs: effectiveState?.buffer?.startTimeUs ?? null,
    bufferEndTimeUs: effectiveState?.buffer?.endTimeUs ?? null,
    joinerCount: effectiveState?.listenerCount ?? 0,
    stoppedExplicitly: effectiveState?.stoppedExplicitly ?? false,
    streamEndedReason: effectiveState?.streamEndedReason ?? null,
    speed: effectiveState?.speed ?? null,
    playbackPosition: effectiveState?.playbackPosition ?? null,
    currentTimeUs: effectiveState?.playbackPosition?.timestamp_us ?? null,
    currentFrameIndex: effectiveState?.playbackPosition?.frame_index ?? null,
    start,
    stop,
    leave,
    pause,
    resume,
    suspend,
    resumeFresh,
    setSpeed,
    setTimeRange,
    seek,
    seekByFrame,
    reinitialize,
    switchToBufferReplay,
    rejoin,
    transmitFrame,
  };
}
