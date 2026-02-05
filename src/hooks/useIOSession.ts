// ui/src/hooks/useIOSession.ts
//
// React hook for managing IO sessions with scoped event handling.
// Thin wrapper around sessionStore - all session state lives in the store.
//
// SIMPLIFIED MODEL: Session ID = Profile ID
// Multiple apps using the same profile automatically share the session.
//
// Listener management is handled by Rust backend:
// - registerSessionListener() - registers this hook as a listener
// - unregisterSessionListener() - removes this hook as a listener
// - Rust tracks all listeners and destroys session when last one leaves

import { useEffect, useRef, useCallback } from "react";
import {
  useSessionStore,
  useSession,
} from "../stores/sessionStore";

// Module-level map to track sessions being reinitialized.
// This persists across re-renders and prevents the effect from
// trying to openSession while reinitialize() is in progress.
const reinitializingSessions = new Map<string, boolean>();
import {
  setSessionListenerActive,
  type IOCapabilities,
  type IOStateType,
  type StreamEndedPayload,
  type SessionSuspendedPayload,
  type SessionResumingPayload,
  type CanTransmitFrame,
  type TransmitResult,
  type PlaybackPosition,
  type RawBytesPayload,
} from "../api/io";
import type { FrameMessage } from "../stores/discoveryStore";

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
  } = options;

  // Session ID = Profile ID (use sessionId if provided, fall back to profileId for compat)
  const effectiveSessionId = sessionIdOption || profileIdOption || "";
  // Profile name for display (fall back to session ID if not provided)
  const effectiveProfileName = profileNameOption || effectiveSessionId;

  // Get session from store using the profile ID directly
  const session = useSession(effectiveSessionId);

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
    };
  }, [onFrames, onBytes, onError, onTimeUpdate, onStreamEnded, onStreamComplete, onSpeedChange, onReconfigure, onSuspended, onResuming]);

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

    if (reinitializingSessions.get(effectiveSessionId)) {
      console.log(`[useIOSession:${appName}] reinitializing in progress for session '${effectiveSessionId}', skipping effect setup`);
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

        // Mark setup as complete and track current session
        setupCompleteRef.current = true;
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
    if (!effectiveSessionId) {
      console.log(`[useIOSession:${appName}] leave() - no effectiveSessionId, returning`);
      return;
    }
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

        // Mark setup as complete for the new session
        setupCompleteRef.current = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        callbacksRef.current.onError?.(msg);
      } finally {
        reinitializingSessions.delete(targetSessionId);
      }
    },
    [appName, effectiveSessionId, effectiveProfileName, reinitializeSession, registerCallbacks, clearCallbacks, leaveSession]
  );

  const switchToBufferReplay = useCallback(
    async (speed?: number) => {
      if (!effectiveSessionId) return;
      try {
        await switchToBuffer(effectiveSessionId, speed);
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

  // Derive values from session state
  return {
    sessionId: effectiveSessionId,
    actualSessionId: effectiveSessionId, // Same as sessionId now (kept for backwards compat)
    capabilities: session?.capabilities ?? null,
    state: session?.ioState ?? "stopped",
    isReady: session?.lifecycleState === "connected",
    errorMessage: session?.errorMessage ?? null,
    bufferAvailable: session?.buffer?.available ?? false,
    bufferId: session?.buffer?.id ?? null,
    bufferType: session?.buffer?.type ?? null,
    bufferCount: session?.buffer?.count ?? 0,
    bufferOwningSessionId: session?.buffer?.owningSessionId ?? null,
    joinerCount: session?.listenerCount ?? 0,
    stoppedExplicitly: session?.stoppedExplicitly ?? false,
    streamEndedReason: session?.streamEndedReason ?? null,
    speed: session?.speed ?? null,
    playbackPosition: session?.playbackPosition ?? null,
    currentTimeUs: session?.playbackPosition?.timestamp_us ?? null,
    currentFrameIndex: session?.playbackPosition?.frame_index ?? null,
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
