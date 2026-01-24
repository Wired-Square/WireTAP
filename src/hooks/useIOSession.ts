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
import {
  setSessionListenerActive,
  type IOCapabilities,
  type IOStateType,
  type StreamEndedPayload,
  type CanTransmitFrame,
  type TransmitResult,
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
  /** Callback on error */
  onError?: (error: string) => void;
  /** Callback when current time updates (from frame timestamps) */
  onTimeUpdate?: (timeUs: number) => void;
  /** Callback when stream ends (GVRET disconnect, PostgreSQL complete, etc.) */
  onStreamEnded?: (payload: StreamEndedPayload) => void;
  /** Callback when buffer playback completes naturally (reached end of buffer) */
  onStreamComplete?: () => void;
  /** Callback when playback speed changes (from any listener on this session) */
  onSpeedChange?: (speed: number) => void;
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
  /** Number of apps connected to this session (for showing Detach vs Stop) */
  joinerCount: number;
  /** Whether the session was stopped explicitly by user (vs stream ending naturally) */
  stoppedExplicitly: boolean;
  /** Current playback speed (null until set, 1 = realtime, 0 = unlimited) */
  speed: number | null;

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
  /** Update playback speed (only if capabilities.supports_speed_control) */
  setSpeed: (speed: number) => Promise<void>;
  /** Update time range (only when stopped, if capabilities.supports_time_range) */
  setTimeRange: (start?: string, end?: string) => Promise<void>;
  /** Seek to a specific timestamp (only if capabilities.supports_seek) */
  seek: (timestampUs: number) => Promise<void>;
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
    onError,
    onTimeUpdate,
    onStreamEnded,
    onStreamComplete,
    onSpeedChange,
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
  const leaveSession = useSessionStore((s) => s.leaveSession);
  const setSessionSpeed = useSessionStore((s) => s.setSessionSpeed);
  const setSessionTimeRange = useSessionStore((s) => s.setSessionTimeRange);
  const seekSession = useSessionStore((s) => s.seekSession);
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
    onError,
    onTimeUpdate,
    onStreamEnded,
    onStreamComplete,
    onSpeedChange,
  });
  useEffect(() => {
    callbacksRef.current = {
      onFrames,
      onError,
      onTimeUpdate,
      onStreamEnded,
      onStreamComplete,
      onSpeedChange,
    };
  }, [onFrames, onError, onTimeUpdate, onStreamEnded, onStreamComplete, onSpeedChange]);

  // Initialize session on mount
  useEffect(() => {
    // Mark component as mounted
    isMountedRef.current = true;

    // No session ID means no profile selected - nothing to do
    if (!effectiveSessionId) {
      console.log(`[useIOSession:${appName}] no effectiveSessionId, skipping`);
      return;
    }

    if (initializingRef.current) {
      console.log(`[useIOSession:${appName}] already initializing, skipping`);
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
          onError: (error) => callbacksRef.current.onError?.(error),
          onTimeUpdate: (timeUs) => callbacksRef.current.onTimeUpdate?.(timeUs),
          onStreamEnded: (payload) => callbacksRef.current.onStreamEnded?.(payload),
          onStreamComplete: () => callbacksRef.current.onStreamComplete?.(),
          onSpeedChange: (speed) => callbacksRef.current.onSpeedChange?.(speed),
        });
        console.log(`[useIOSession:${appName}] registerCallbacks completed`);

        // Mark setup as complete and track current session
        setupCompleteRef.current = true;
        currentSessionIdRef.current = effectiveSessionId;
        console.log(`[useIOSession:${appName}] setup() complete, setupComplete=true`);
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
    if (!effectiveSessionId) return;
    try {
      await stopSession(effectiveSessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("not found")) {
        callbacksRef.current.onError?.(msg);
      }
    }
  }, [effectiveSessionId, stopSession]);

  const leave = useCallback(async () => {
    if (!effectiveSessionId) return;
    // First, mark listener as inactive in Rust so it stops receiving frames immediately
    // This is done before clearing callbacks to prevent race conditions
    try {
      await setSessionListenerActive(effectiveSessionId, listenerIdRef.current, false);
    } catch {
      // Ignore - session may not exist
    }
    clearCallbacks(effectiveSessionId, listenerIdRef.current);
    await leaveSession(effectiveSessionId, listenerIdRef.current);
  }, [effectiveSessionId, leaveSession, clearCallbacks]);

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
      }
    ) => {
      // For reinitialize, use new profile ID if provided, else current
      const targetProfileId = newProfileId || effectiveSessionId;
      if (!targetProfileId) return;

      // Use the stored profile name for display (falls back to profile ID)
      const targetProfileName = effectiveProfileName;

      console.log(`[useIOSession:${appName}] reinitialize() - targetProfileId=${targetProfileId}, currentSession=${currentSessionIdRef.current}, profileName=${targetProfileName}`);

      try {
        // If switching to a different session, leave the old one first
        const oldSessionId = currentSessionIdRef.current;
        if (oldSessionId && oldSessionId !== targetProfileId) {
          console.log(`[useIOSession:${appName}] reinitialize() - switching sessions, leaving old session '${oldSessionId}'`);
          // Clear callbacks for old session
          clearCallbacks(oldSessionId, listenerIdRef.current);
          // Leave old session (Rust will destroy if we were the last listener)
          await leaveSession(oldSessionId, listenerIdRef.current);
        }

        // Reinitialize uses Rust's atomic check - if other listeners exist, it won't destroy
        // The backend auto-starts the session after creation
        await reinitializeSession(
          targetProfileId,
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
          }
        );

        // Update current session ref
        currentSessionIdRef.current = targetProfileId;

        // Re-register callbacks after reinitialize
        registerCallbacks(targetProfileId, listenerIdRef.current, {
          onFrames: (frames) => callbacksRef.current.onFrames?.(frames),
          onError: (error) => callbacksRef.current.onError?.(error),
          onTimeUpdate: (timeUs) => callbacksRef.current.onTimeUpdate?.(timeUs),
          onStreamEnded: (payload) => callbacksRef.current.onStreamEnded?.(payload),
          onStreamComplete: () => callbacksRef.current.onStreamComplete?.(),
          onSpeedChange: (speed) => callbacksRef.current.onSpeedChange?.(speed),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        callbacksRef.current.onError?.(msg);
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
        onError: (error) => callbacksRef.current.onError?.(error),
        onTimeUpdate: (timeUs) => callbacksRef.current.onTimeUpdate?.(timeUs),
        onStreamEnded: (payload) => callbacksRef.current.onStreamEnded?.(payload),
        onStreamComplete: () => callbacksRef.current.onStreamComplete?.(),
        onSpeedChange: (speed) => callbacksRef.current.onSpeedChange?.(speed),
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
    joinerCount: session?.listenerCount ?? 0,
    stoppedExplicitly: session?.stoppedExplicitly ?? false,
    speed: session?.speed ?? null,
    start,
    stop,
    leave,
    pause,
    resume,
    setSpeed,
    setTimeRange,
    seek,
    reinitialize,
    switchToBufferReplay,
    rejoin,
    transmitFrame,
  };
}
