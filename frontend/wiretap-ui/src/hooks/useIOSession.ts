// ui/src/hooks/useIOSession.ts
//
// React hook for managing IO sessions with scoped event handling.
// Session state lives in sessionStore, which Rust's pushes and `open_session`
// keep current; this hook opens the session, routes callbacks and wraps actions.
//
// Subscriber management is handled by Rust backend:
// - open_session registers this hook as a subscriber
// - unregisterSessionSubscriber() - removes this hook as a subscriber
// - Rust tracks all subscribers and destroys session when last one leaves

import { useEffect, useRef, useCallback } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { useSessionStore, type Session, type SessionCallbacks } from "../stores/sessionStore";
import { subscriberIdFor } from "../utils/subscriberId";
import { tlog } from "../api/settings";
import {
  setSessionSubscriberActive,
  getOrphanedCaptureIds,
  isSessionNotFound,
  type IOCapabilities,
  type IOStateType,
  type StreamEndedInfo,
  type CanTransmitFrame,
  type TransmitResult,
  type PlaybackPosition,
  type FramingMode,
} from "../api/io";
import type { FrameMessage } from "../types/frame";
import type { StreamEndReason } from "../generated/StreamEndReason";
import type { SessionLifecyclePayload } from "../generated/SessionLifecyclePayload";
import type { AdhocSignalsMsg, DecodedSignalsEntry, SessionTransitionMsg } from "../services/wsProtocol";

/** The fields of a session's store entry this hook returns, compared shallowly so a count push does not re-render. */
function sessionView(session: Session | undefined) {
  return {
    capabilities: session?.capabilities ?? null,
    ioState: session?.ioState ?? "stopped",
    isReady: session?.lifecycleState === "connected",
    errorMessage: session?.errorMessage ?? null,
    capture: session?.capture,
    subscriberCount: session?.subscriberCount ?? 0,
    stoppedExplicitly: session?.stoppedExplicitly ?? false,
    streamEndedReason: session?.streamEndedReason ?? null,
    speed: session?.speed ?? null,
    playbackPosition: session?.playbackPosition ?? null,
  };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface UseIOSessionOptions {
  /**
   * App name for identifying this hook instance in logs and callbacks.
   * Used as the subscriber ID for callback registration.
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
  /** Callback when decoded signals arrive (Rust decoder; catalogue attached) */
  onDecoded?: (decoded: DecodedSignalsEntry[], backlog: boolean) => void;
  /** Callback when the Dashboard's ad-hoc signals arrive */
  onAdhocSignals?: (msg: AdhocSignalsMsg) => void;
  /** Callback on error */
  onError?: (error: string) => void;
  /** Callback when playback position updates (timestamp and frame index) */
  onTimeUpdate?: (position: PlaybackPosition) => void;
  /** Callback when stream ends (GVRET disconnect, backend complete, etc.) */
  onStreamEnded?: (payload: StreamEndedInfo) => void;
  /** Callback when capture playback completes naturally (reached end of capture) */
  onStreamComplete?: () => void;
  /** Callback when playback speed changes (from any subscriber on this session) */
  onSpeedChange?: (speed: number) => void;
  /** Callback when session is reconfigured (e.g., event jump) - apps should clear their state */
  onReconfigure?: () => void;
  /** Callback when session is suspended (stopped with capture available) */
  onSuspended?: (payload: SessionTransitionMsg) => void;
  /** Callback when session is stopped and switched to capture replay (all listeners transition) */
  onSwitchedToCapture?: (payload: SessionTransitionMsg) => void;
  /** Callback when session is resuming or returning to live - apps should clear their frame lists */
  onResuming?: (payload: SessionTransitionMsg) => void;
  /**
   * Callback when session is destroyed externally (e.g., from Session Manager or
   * last-subscriber auto-destroy). Never fires for a session this hook has moved
   * off — see `markSessionSwitch`.
   */
  onDestroyed?: (orphanedCaptureIds: string[], reset: boolean) => void;
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
  /** Whether capture data is available for replay (set after stream ends) */
  captureAvailable: boolean;
  /** ID of the capture that was created (set after stream ends) */
  captureId: string | null;
  /** Kind of capture: "frames" or "bytes" (set after stream ends) */
  captureKind: "frames" | "bytes" | null;
  /** Number of items in the capture - frames or bytes depending on type (set after stream ends) */
  captureCount: number;
  /** Session ID that owns this capture (for detecting ingest/cross-app captures) */
  captureOwningSessionId: string | null;
  /** Start time of capture data in microseconds (null if empty or unknown) */
  captureStartTimeUs: number | null;
  /** End time of capture data in microseconds (null if empty or unknown) */
  captureEndTimeUs: number | null;
  /** Display name of the capture (null until fetched) */
  captureName: string | null;
  /** Whether the capture survives "clear captures on start" */
  capturePersistent: boolean;
  /** Number of apps connected to this session (for showing Detach vs Stop) */
  joinerCount: number;
  /** Whether the session was stopped explicitly by user (vs stream ending naturally) */
  stoppedExplicitly: boolean;
  /** Reason why the stream ended: "complete" = natural end, "stopped" = explicit stop */
  streamEndedReason: StreamEndReason | null;
  /** Current playback speed (null until set, 1 = realtime, 0 = unlimited) */
  speed: number | null;
  /** Current playback position (centralised for all apps sharing this session) */
  playbackPosition: PlaybackPosition | null;
  /** Convenience: playbackPosition?.timestamp_us */
  currentTimeUs: number | null;
  /** Convenience: playbackPosition?.frame_index */
  currentFrameIndex: number | null;
  /** Unique subscriber instance ID for this hook (e.g., "discovery_1") */
  subscriberId: string;

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
  /** Suspend the session - stops streaming, finalises capture, session stays alive */
  suspend: () => Promise<void>;
  /** Resume a suspended session with a fresh capture (orphans old capture) */
  resumeFresh: () => Promise<void>;
  /** Update playback speed (only if capabilities.supports_speed_control) */
  setSpeed: (speed: number) => Promise<void>;
  /** Update time range (only when stopped, if capabilities.supports_time_range) */
  setTimeRange: (start?: string, end?: string) => Promise<void>;
  /** Seek to a specific timestamp (only if capabilities.supports_seek) */
  seek: (timestampUs: number) => Promise<void>;
  /** Seek to a specific frame index (preferred for capture playback - avoids float issues) */
  seekByFrame: (frameIndex: number) => Promise<void>;
  /** Reinitialize the session (e.g., after profile change, file selection, or capture switch) */
  reinitialize: (
    profileId?: string,
    options?: {
      filePath?: string;
      startTime?: string;
      endTime?: string;
      speed?: number;
      limit?: number;
      // Serial framing configuration
      framingEncoding?: FramingMode;
      delimiter?: number[];
      maxFrameLength?: number;
      // Modbus RTU framing settings, when framingEncoding is "modbus_rtu"
      modbusValidateCrc?: boolean;
      modbusDeviceAddress?: number;
      modbusVendorFunctions?: number[];
      modbusAllowBroadcast?: boolean;
      modbusAnyFunction?: boolean;
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
      // Modbus TCP poll groups as JSON string
      modbusPollsJson?: string;
    }
  ) => Promise<void>;
  /** Switch to capture replay mode (after stream ends with capture data) */
  switchToCaptureReplay: (speed?: number) => Promise<void>;
  /** Rejoin an existing session after leaving (for shared sessions) */
  rejoin: (profileId?: string, profileName?: string) => Promise<void>;
  /**
   * Declare that this app is moving to `nextSessionId`, so the destroy of the
   * session it is leaving does not reach `onDestroyed`. `reinitialize` does this
   * for itself; call it before any *other* backend attach — the registration is
   * what triggers the old session's teardown. Stable identity.
   */
  markSessionSwitch: (nextSessionId: string | null) => void;
  /** Transmit a CAN frame (only if capabilities.traits.tx_frames is true) */
  transmitFrame: (frame: CanTransmitFrame) => Promise<TransmitResult>;
}

/**
 * Hook for managing a CAN reader session.
 *
 * Opens the session on mount, routes its pushes to the callbacks, and leaves it
 * on unmount. All session state is in sessionStore.
 */
export function useIOSession(
  options: UseIOSessionOptions
): UseIOSessionResult {
  const {
    appName,
    sessionId: sessionIdOption,
    profileName: profileNameOption,
    profileId: profileIdOption,
    onFrames,
    onDecoded,
    onAdhocSignals,
    onError,
    onTimeUpdate,
    onStreamEnded,
    onStreamComplete,
    onSpeedChange,
    onReconfigure,
    onSuspended,
    onSwitchedToCapture,
    onResuming,
    onDestroyed,
  } = options;

  // Session ID = Profile ID (use sessionId if provided, fall back to profileId for compat)
  const effectiveSessionId = sessionIdOption || profileIdOption || "";
  // Profile name for display (fall back to session ID if not provided)
  const effectiveProfileName = profileNameOption || effectiveSessionId;

  const view = useSessionStore(
    useShallow((s) => sessionView(effectiveSessionId ? s.sessions[effectiveSessionId] : undefined))
  );

  // Store actions
  const openSession = useSessionStore((s) => s.openSession);
  const holdSession = useSessionStore((s) => s.holdSession);
  const releaseSession = useSessionStore((s) => s.releaseSession);
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
  const switchToCapture = useSessionStore((s) => s.switchToCapture);
  const reinitializeSession = useSessionStore((s) => s.reinitializeSession);
  const registerCallbacks = useSessionStore((s) => s.registerCallbacks);
  const clearCallbacks = useSessionStore((s) => s.clearCallbacks);
  const transmitFrameAction = useSessionStore((s) => s.transmitFrame);

  // Track the currently active session ID (for cleanup to check if session changed)
  const currentSessionIdRef = useRef<string | null>(null);
  /**
   * The session this hook moved off, stamped before the backend call that does
   * the moving. Registering on a new session makes Rust tear the previous one
   * down (`teardown_session_if_empty(prev, true)`) and broadcast `destroyed`;
   * that event lands after the switch has returned, while this hook's listener
   * for the *departing* session is still registered — see the lifecycle
   * listener below, and `docs/session-flow.md` § App cleanup on teardown.
   *
   * Phrased as "which session did I leave" rather than "which am I on" on
   * purpose: a path that never stamps degrades to the old behaviour, where the
   * opposite phrasing would strand the app on a session that is genuinely gone.
   */
  const abandonedSessionRef = useRef<string | null>(null);
  const markSessionSwitch = useCallback((nextId: string | null) => {
    const leaving = currentSessionIdRef.current;
    abandonedSessionRef.current = leaving && leaving !== nextId ? leaving : null;
  }, []);
  // Generate a unique subscriber instance ID per hook mount (e.g., "discovery_1")
  const subscriberIdRef = useRef<string>(subscriberIdFor(appName));
  // Track if we're currently leaving to prevent double-leave
  const isLeavingRef = useRef(false);

  // Store callbacks in refs to keep them current
  const callbacksRef = useRef({
    onFrames,
    onDecoded,
    onAdhocSignals,
    onError,
    onTimeUpdate,
    onStreamEnded,
    onStreamComplete,
    onSpeedChange,
    onReconfigure,
    onSuspended,
    onSwitchedToCapture,
    onResuming,
    onDestroyed,
  });
  useEffect(() => {
    callbacksRef.current = {
      onFrames,
      onDecoded,
      onAdhocSignals,
      onError,
      onTimeUpdate,
      onStreamEnded,
      onStreamComplete,
      onSpeedChange,
      onReconfigure,
      onSuspended,
      onSwitchedToCapture,
      onResuming,
      onDestroyed,
    };
  }, [onFrames, onDecoded, onAdhocSignals, onError, onTimeUpdate, onStreamEnded, onStreamComplete, onSpeedChange, onReconfigure, onSuspended, onSwitchedToCapture, onResuming, onDestroyed]);

  const forwarding = useRef<SessionCallbacks>({
    onFrames: (frames) => callbacksRef.current.onFrames?.(frames),
    onDecoded: (decoded, backlog) => callbacksRef.current.onDecoded?.(decoded, backlog),
    onAdhocSignals: (msg) => callbacksRef.current.onAdhocSignals?.(msg),
    onError: (error) => callbacksRef.current.onError?.(error),
    onTimeUpdate: (position) => callbacksRef.current.onTimeUpdate?.(position),
    onStreamEnded: (payload) => callbacksRef.current.onStreamEnded?.(payload),
    onStreamComplete: () => callbacksRef.current.onStreamComplete?.(),
    onSpeedChange: (speed) => callbacksRef.current.onSpeedChange?.(speed),
    onReconfigure: () => callbacksRef.current.onReconfigure?.(),
    onSuspended: (payload) => callbacksRef.current.onSuspended?.(payload),
    onSwitchedToCapture: (payload) => callbacksRef.current.onSwitchedToCapture?.(payload),
    onResuming: (payload) => callbacksRef.current.onResuming?.(payload),
  }).current;

  // Session destroyed or this subscriber evicted, from the Session Manager or the
  // last subscriber leaving. Global events, filtered to this session.
  useEffect(() => {
    if (!effectiveSessionId) return;

    let cancelled = false;
    const unlistenFns: UnlistenFn[] = [];

    const setupStateTracking = async () => {
      // Orphaned capture IDs are fetched from the post-session cache.
      const unlistenLifecycle = await listen<SessionLifecyclePayload>(
        "session-lifecycle",
        async (event) => {
          if (cancelled) return;
          if (
            event.payload.event_type !== "destroyed" ||
            event.payload.session_id !== effectiveSessionId
          ) {
            return;
          }
          // The session is gone either way, so drop its store entry and WS
          // channel before deciding whether the app should hear about it.
          useSessionStore.getState().cleanupDestroyedSession(effectiveSessionId);

          // A destroy naming a session this hook deliberately left is the
          // backend tearing down what the switch left behind — it arrives here
          // only because this listener belongs to the departing session and is
          // torn down asynchronously. Passing it on resets the session just
          // joined, which is the whole of "the app fell back to No source
          // milliseconds after joining".
          if (event.payload.session_id === abandonedSessionRef.current) {
            tlog.debug(
              `[useIOSession:${appName}] Ignoring destroy of '${effectiveSessionId}' — already moved on`
            );
            return;
          }

          tlog.info(
            `[useIOSession:${appName}] Session '${effectiveSessionId}' destroyed externally`
          );
          currentSessionIdRef.current = null;
          let bufferIds: string[] = [];
          try {
            bufferIds = await getOrphanedCaptureIds(effectiveSessionId);
          } catch {
            // Cache may have expired
          }
          callbacksRef.current.onDestroyed?.(bufferIds, event.payload.reset ?? false);
        }
      );
      unlistenFns.push(unlistenLifecycle);

      // Listener evicted (from Session Manager "Remove" action).
      const unlistenEvicted = await listen<{ session_id: string; subscriber_id: string; capture_ids: string[] }>(
        "subscriber-evicted",
        (event) => {
          if (cancelled) return;
          if (
            event.payload.session_id === effectiveSessionId &&
            event.payload.subscriber_id === subscriberIdRef.current
          ) {
            tlog.info(
              `[useIOSession:${appName}] Evicted from session '${effectiveSessionId}', capture copies: ${event.payload.capture_ids}`
            );
            currentSessionIdRef.current = null;
            // Clean up local state in store (no backend calls - already unregistered)
            useSessionStore.getState().cleanupEvictedSubscriber(effectiveSessionId, subscriberIdRef.current);
            // Notify higher-level hooks with copied capture IDs (same path as destroy).
            // Eviction is never a deliberate user reset.
            callbacksRef.current.onDestroyed?.(event.payload.capture_ids, false);
          }
        }
      );
      unlistenFns.push(unlistenEvicted);
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

  // Hold the session open while mounted on it. A StrictMode remount, or any
  // re-run on the same id, holds it again before the release's leave runs, so
  // the leave is skipped rather than raced (see `releaseSession`).
  useEffect(() => {
    if (!effectiveSessionId) {
      currentSessionIdRef.current = null;
      return;
    }
    let cancelled = false;
    const subscriberId = subscriberIdRef.current;
    holdSession(effectiveSessionId, effectiveProfileName, subscriberId, appName)
      .then(() => {
        if (cancelled) return;
        registerCallbacks(effectiveSessionId, subscriberId, forwarding);
        currentSessionIdRef.current = effectiveSessionId;
      })
      .catch((e) => {
        tlog.info(`[useIOSession:${appName}] open failed: ${messageOf(e)}`);
        if (!cancelled && !isSessionNotFound(e)) callbacksRef.current.onError?.(messageOf(e));
      });
    return () => {
      cancelled = true;
      releaseSession(effectiveSessionId, subscriberId);
    };
  }, [appName, effectiveSessionId, holdSession, releaseSession, registerCallbacks, forwarding]);

  // Action wrappers - all use effectiveSessionId directly
  const start = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await startSession(effectiveSessionId);
    } catch (e) {
      callbacksRef.current.onError?.(messageOf(e));
    }
  }, [effectiveSessionId, startSession]);

  const stop = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await stopSession(effectiveSessionId);
    } catch (e) {
      if (!isSessionNotFound(e)) callbacksRef.current.onError?.(messageOf(e));
    }
  }, [effectiveSessionId, stopSession]);

  const leave = useCallback(async () => {
    if (!effectiveSessionId) {
      return;
    }
    // Prevent multiple concurrent leave calls
    if (isLeavingRef.current) {
      tlog.debug(`[useIOSession:${appName}] leave() - already leaving, skipping`);
      return;
    }
    isLeavingRef.current = true;
    try {
      // Drop callbacks first. This is synchronous and needs no backend round-trip,
      // whereas marking the subscriber inactive does — and for the whole of that await
      // any WS frames already queued would still be delivered to the app, repopulating
      // a buffer the caller is in the middle of tearing down.
      clearCallbacks(effectiveSessionId, subscriberIdRef.current);
      try {
        await setSessionSubscriberActive(effectiveSessionId, subscriberIdRef.current, false);
      } catch {
        // Ignore - session may not exist
      }
      await leaveSession(effectiveSessionId, subscriberIdRef.current);
    } finally {
      isLeavingRef.current = false;
    }
  }, [appName, effectiveSessionId, leaveSession, clearCallbacks]);

  const pause = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await pauseSession(effectiveSessionId);
    } catch (e) {
      callbacksRef.current.onError?.(messageOf(e));
    }
  }, [effectiveSessionId, pauseSession]);

  const resume = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await resumeSession(effectiveSessionId);
    } catch (e) {
      callbacksRef.current.onError?.(messageOf(e));
    }
  }, [effectiveSessionId, resumeSession]);

  const suspend = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await suspendSession(effectiveSessionId);
    } catch (e) {
      callbacksRef.current.onError?.(messageOf(e));
    }
  }, [effectiveSessionId, suspendSession]);

  const resumeFresh = useCallback(async () => {
    if (!effectiveSessionId) return;
    try {
      await resumeSessionFresh(effectiveSessionId);
    } catch (e) {
      callbacksRef.current.onError?.(messageOf(e));
    }
  }, [effectiveSessionId, resumeSessionFresh]);

  const setSpeed = useCallback(
    async (speed: number) => {
      if (!effectiveSessionId) return;
      try {
        await setSessionSpeed(effectiveSessionId, speed);
      } catch (e) {
        callbacksRef.current.onError?.(messageOf(e));
      }
    },
    [effectiveSessionId, setSessionSpeed]
  );

  const setTimeRange = useCallback(
    async (start?: string, end?: string) => {
      if (!effectiveSessionId) return;
      try {
        await setSessionTimeRange(effectiveSessionId, start, end);
      } catch (e) {
        callbacksRef.current.onError?.(messageOf(e));
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
        if (!isSessionNotFound(e)) callbacksRef.current.onError?.(messageOf(e));
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
        // A callback can outlive its session and still hold the stale id.
        if (!isSessionNotFound(e)) callbacksRef.current.onError?.(messageOf(e));
      }
    },
    [effectiveSessionId, seekSessionByFrame]
  );

  const reinitialize = useCallback(
    async (
      newProfileId?: string,
      opts?: {
        filePath?: string;
        startTime?: string;
        endTime?: string;
        speed?: number;
        limit?: number;
        framingEncoding?: FramingMode;
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
        modbusPollsJson?: string;
      }
    ) => {
      // For reinitialize, use new profile ID if provided, else current
      const targetProfileId = newProfileId || effectiveSessionId;
      if (!targetProfileId) return;

      // Session ID can be overridden (for recorded sources that need unique IDs per instance)
      // Profile ID stays targetProfileId for looking up profile configuration
      const targetSessionId = opts?.sessionIdOverride || targetProfileId;

      // Use the new profile ID for display when switching profiles, avoiding stale closure.
      const targetProfileName = newProfileId || effectiveProfileName;

      try {
        const oldSessionId = currentSessionIdRef.current;
        // Every reinitialize caller — watch, load, connect-only, jump-to-event —
        // funnels through here, so stamping the switch once covers all of them.
        markSessionSwitch(targetSessionId);
        if (oldSessionId && oldSessionId !== targetSessionId) {
          clearCallbacks(oldSessionId, subscriberIdRef.current);
          // Rust will destroy the old session if we were the last subscriber
          await leaveSession(oldSessionId, subscriberIdRef.current);
        }

        // Rust's atomic check: with other subscribers on it, the session is not torn down
        await reinitializeSession(
          targetSessionId,
          subscriberIdRef.current,
          appName,
          targetProfileId,
          targetProfileName,
          {
            filePath: opts?.filePath,
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
            modbusPollsJson: opts?.modbusPollsJson,
          }
        );

        currentSessionIdRef.current = targetSessionId;
        registerCallbacks(targetSessionId, subscriberIdRef.current, forwarding);
      } catch (e) {
        callbacksRef.current.onError?.(messageOf(e));
      }
    },
    [appName, effectiveSessionId, effectiveProfileName, reinitializeSession, registerCallbacks, clearCallbacks, leaveSession, markSessionSwitch, forwarding]
  );

  const switchToCaptureReplay = useCallback(
    async (speed?: number) => {
      if (!effectiveSessionId) return;
      try {
        await switchToCapture(effectiveSessionId, speed);
      } catch (e) {
        callbacksRef.current.onError?.(messageOf(e));
      }
    },
    [effectiveSessionId, switchToCapture]
  );

  const rejoin = useCallback(async (profileId?: string, profileName?: string) => {
    // Use provided profileId or fall back to current session ID
    const targetSessionId = profileId || effectiveSessionId;
    const targetProfileName = profileName || effectiveProfileName;
    if (!targetSessionId) return;
    try {
      await openSession(targetSessionId, targetProfileName, subscriberIdRef.current, appName, {});

      // Mark subscriber as active in Rust so it receives frames again
      try {
        await setSessionSubscriberActive(targetSessionId, subscriberIdRef.current, true);
      } catch {
        // Ignore - subscriber may already be active
      }

      registerCallbacks(targetSessionId, subscriberIdRef.current, forwarding);
    } catch (e) {
      callbacksRef.current.onError?.(messageOf(e));
    }
  }, [appName, effectiveSessionId, effectiveProfileName, openSession, registerCallbacks, forwarding]);

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
        return {
          success: false,
          timestamp_us: Date.now() * 1000,
          error: messageOf(e),
        };
      }
    },
    [effectiveSessionId, transmitFrameAction]
  );

  const { capture, playbackPosition } = view;

  return {
    sessionId: effectiveSessionId,
    actualSessionId: effectiveSessionId, // Same as sessionId now (kept for backwards compat)
    capabilities: view.capabilities,
    state: view.ioState,
    isReady: view.isReady,
    errorMessage: view.errorMessage,
    captureAvailable: capture?.available ?? false,
    captureId: capture?.id ?? null,
    captureKind: capture?.kind ?? null,
    captureCount: capture?.count ?? 0,
    captureOwningSessionId: capture?.owningSessionId ?? null,
    captureStartTimeUs: capture?.startTimeUs ?? null,
    captureEndTimeUs: capture?.endTimeUs ?? null,
    captureName: capture?.name ?? null,
    capturePersistent: capture?.persistent ?? false,
    joinerCount: view.subscriberCount,
    stoppedExplicitly: view.stoppedExplicitly,
    streamEndedReason: view.streamEndedReason,
    speed: view.speed,
    playbackPosition,
    currentTimeUs: playbackPosition?.timestamp_us ?? null,
    currentFrameIndex: playbackPosition?.frame_index ?? null,
    subscriberId: subscriberIdRef.current,
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
    switchToCaptureReplay,
    rejoin,
    markSessionSwitch,
    transmitFrame,
  };
}
