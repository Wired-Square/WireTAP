// ui/src/hooks/useIOSessionManager.ts
//
// High-level IO session management hook that wraps common patterns used by
// Discovery, Decoder, and Transmit apps. Provides:
// - Profile state management
// - Multi-bus session coordination
// - Derived state (isStreaming, isPaused, isStopped, etc.)
// - Ingest session integration (optional)
// - Common handlers (detach, rejoin, start multi-bus)

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useIOSession, type UseIOSessionOptions, type UseIOSessionResult } from "./useIOSession";
import type { AdhocSignalsMsg, DecodedSignalsEntry } from "../services/wsProtocol";
import type { StreamEndedInfo as IngestStreamEndedInfo } from "../api/io";
import { tlog } from "../api/settings";
import {
  createAndStartMultiSourceSession,
  useSessionStore,
  type CreateMultiSourceOptions,
  type CreateSessionOptions,
  type InterfaceFramingConfig,
  type BusSourceInfo,
} from "../stores/sessionStore";

import type { BusOverride, FramingMode, PlaybackPosition } from "../api/io";
import type { EventOwner } from "../api/captureEvents";
import { eventOwnerForSession } from "../utils/captureEvents";
import type { IOProfile } from "./useSettings";
import type { FrameMessage } from "../types/frame";
import { setSessionSubscriberActive, reconfigureReaderSession, switchSessionToCaptureReplay, leaveSessionToCapture, sessionStopToCapture, resumeSessionToLive, generateSessionId, type StreamEndedInfo, type IOCapabilities } from "../api/io";
import { useProfileBusStore, isRealtimeProfile, isMultiSourceCapable } from "../stores/profileBusStore";
import { useAdHocProfileStore } from "../stores/adHocProfileStore";
import { WINDOW_EVENTS } from "../events/registry";

/** Attach the decoder chosen in the picker to a freshly-created session (cross-app). */
function attachSessionCatalog(sessionId: string, catalogPath?: string | null): void {
  if (catalogPath) useSessionStore.getState().setSessionCatalogPath(sessionId, catalogPath);
}

const sourcesSessionId = (profileIds: string[], emitRawBytes?: boolean) =>
  generateSessionId({ purpose: "sources", profile_ids: profileIds, emit_raw_bytes: emitRawBytes });

/** The window a session was re-configured to (UTC ISO-8601). */
export interface SessionReconfigurationInfo {
  startTime: string;
  endTime?: string;
}

/** Options for handleDialogStartLoad - matches IoSourcePickerDialog */
export interface LoadOptions {
  speed?: number;
  startTime?: string;
  endTime?: string;
  maxFrames?: number;
  frameIdStartByte?: number;
  frameIdBytes?: number;
  frameIdEndianness?: "big" | "little";
  sourceAddressStartByte?: number;
  sourceAddressBytes?: number;
  sourceAddressEndianness?: "big" | "little";
  minFrameLength?: number;
  framingEncoding?: FramingMode;
  delimiter?: number[];
  maxFrameLength?: number;
  emitRawBytes?: boolean;
  /** Modbus RTU framing settings, when framingEncoding is "modbus_rtu" */
  modbusValidateCrc?: boolean;
  modbusDeviceAddress?: number;
  modbusVendorFunctions?: number[];
  modbusAllowBroadcast?: boolean;
  modbusAnyFunction?: boolean;
  busOverride?: number;
  /** What the user changed about each profile's buses, keyed by profile ID */
  busOverrides?: Map<string, BusOverride[]>;
  /** Per-interface framing config (for serial profiles in multi-bus mode) */
  perInterfaceFraming?: Map<string, InterfaceFramingConfig>;
  /** Override session ID (for ingest mode where we need to set refs before async work) */
  sessionIdOverride?: string;
  /** Modbus TCP poll groups as JSON string (catalog-derived, for modbus_tcp profiles) */
  modbusPollsJson?: string;
  /** Catalogue path to attach to the new session (decoder picker) — set on the
   *  session's catalogPath so decode-aware apps bind it via useSessionCatalog. */
  catalogPath?: string | null;
}

/** What a single-profile open takes from the picker's options. */
function reinitializeOptions(opts: LoadOptions): CreateSessionOptions {
  return {
    ...opts,
    limit: opts.maxFrames,
    frameIdBigEndian: opts.frameIdStartByte !== undefined ? opts.frameIdEndianness !== "little" : undefined,
    sourceAddressBigEndian: opts.sourceAddressEndianness === "big",
  };
}

/** Store interface for apps that keep their session id (`ioProfile`) in their store */
export interface IOProfileStore {
  ioProfile: string | null;
  setIoProfile: (sessionId: string | null) => void;
}

/** Configuration for the IO session manager */
export interface UseIOSessionManagerOptions {
  /** App name for session identification (e.g., "decoder", "discovery", "transmit") */
  appName: string;
  /** IO profiles from settings */
  ioProfiles: IOProfile[];
  /** Store with ioProfile state (for apps using Zustand stores) */
  store?: IOProfileStore;
  /** A saved profile or capture to open when the app starts with no source */
  defaultSourceId?: string | null;
  /** Callback before ingest starts (e.g., to clear capture) */
  onBeforeIngestStart?: () => Promise<void>;
  /** Callback when ingest completes */
  onIngestComplete?: (payload: IngestStreamEndedInfo) => Promise<void>;
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
  /** Callback when stream ends */
  onStreamEnded?: (payload: StreamEndedInfo) => void;
  /** Callback when session is suspended (stopped with capture available) */
  onSuspended?: (payload: import("../services/wsProtocol").SessionTransitionMsg) => void;
  /** Callback when capture playback completes */
  onStreamComplete?: () => void;
  /** Callback when playback speed changes (from any subscriber on this session) */
  onSpeedChange?: (speed: number) => void;

  // ---- Session Switching Callbacks ----
  /** Set playback speed (speed is a session property; manager calls this during watch/profile operations) */
  setPlaybackSpeed?: (speed: number) => void;
  /** Called before starting a single-source watch (e.g., clear frames/buffers) */
  onBeforeWatch?: () => void;
  /** Called before starting a multi-source watch (e.g., clear frames/buffers) */
  onBeforeMultiWatch?: () => void;
  /** Ref to track stream completion (if provided, manager resets it during watch operations) */
  streamCompletedRef?: React.MutableRefObject<boolean>;
  /** Called after session is reconfigured (event jump, time range change) */
  onSessionReconfigured?: (info: SessionReconfigurationInfo) => void;
  /** Called when session is destroyed externally (e.g., from Sessions app).
   *  Receives orphaned capture IDs so apps can switch to capture mode. */
  onSessionDestroyed?: (orphanedCaptureIds: string[]) => void;
}

/** Result of the IO session manager hook */
export interface UseIOSessionManagerResult {
  // ---- Profile State ----
  /** The session this app is on; a session id, never a profile id */
  ioProfile: string | null;
  setIoProfile: (sessionId: string | null) => void;
  /** Profile name for display */
  ioProfileName: string | undefined;
  /** Map of profile ID to name */

  // ---- Multi-Bus State ----
  /** Profiles in the multi-bus session */
  multiBusProfiles: string[];
  /** Set multi-bus profiles */
  setMultiBusProfiles: (profiles: string[]) => void;
  /** Source profile ID (preserved when switching to capture) */
  sourceProfileId: string | null;
  /** Maps output bus number to source info (profileName, deviceBus) */
  outputBusToSource: Map<number, BusSourceInfo>;

  // ---- Effective Session ----
  effectiveSessionId: string | undefined;
  /** The underlying session hook result */
  session: UseIOSessionResult;

  // ---- Derived State ----
  /** Whether currently streaming (running or paused) */
  isStreaming: boolean;
  /** Whether paused */
  isPaused: boolean;
  /** Whether stopped with a profile selected (realtime mode only) */
  isStopped: boolean;
  /** Whether in capture mode and can return to live streaming */
  canReturnToLive: boolean;
  /** Whether realtime (live device) */
  isRealtime: boolean;
  /** Whether in capture mode */
  isCaptureMode: boolean;
  /** Whether session is ready */
  sessionReady: boolean;
  /** IO capabilities */
  capabilities: IOCapabilities | null;
  /** Number of joiners */
  joinerCount: number;
  /** Current playback position (centralised for all apps sharing this session) */
  playbackPosition: PlaybackPosition | null;
  /** Convenience: playbackPosition?.timestamp_us */
  currentTimeUs: number | null;
  /** Convenience: playbackPosition?.frame_index */
  currentFrameIndex: number | null;
  /** Where "now" is when there is no reported position: wall clock on a live source, else the capture's start. */
  playheadNowUs: () => number | null;

  // ---- Events ----
  /** Who holds this session's events — the archive behind a WireTAP profile, else its capture; null before either exists */
  eventOwner: EventOwner | null;

  /** Leave session — unregister subscriber, fully reset app state (no data preserved) */
  handleLeave: () => Promise<void>;
  /** Destroy the session entirely */
  handleDestroy: () => Promise<void>;
  /** Clear the session's capture (real-time/recorded: clear data; capture: delete + leave) */
  handleClearCapture: () => Promise<void>;

  // ---- Watch State (for top bar display) ----
  /** Total frame count during watch mode */
  watchFrameCount: number;
  /** Unique frame IDs seen during watch mode */
  watchUniqueFrameCount: number;
  /** Total raw bytes captured this session (Rust-authoritative) */
  watchByteCount: number;
  /** Capture holding this session's raw bytes, if it has one (Rust-authoritative) */
  bytesCaptureId: string | null;
  /** Whether currently watching (streaming with real-time display) */
  isWatching: boolean;
  /** Set watching state */
  setIsWatching: (watching: boolean) => void;

  // ---- Ingest State (unified with session) ----
  /** Whether ingesting (fast ingest without rendering) */
  isLoading: boolean;
  /** Ingest session ID */
  loadProfileId: string | null;
  /** Ingest frame count */
  loadFrameCount: number;
  /** Ingest error */
  loadError: string | null;
  /** Stop ingest */
  stopLoad: () => Promise<void>;
  /** Unified ingest from one or more sources (fast ingest, auto-transitions to capture reader) */
  loadSource: (profileIds: string[], options: LoadOptions) => Promise<void>;

  // ---- Session Switching Methods ----
  /** Unified watch for one or more sources (routes based on multi_source trait) */
  watchSource: (profileIds: string[], options: LoadOptions) => Promise<void>;
  /** Stop watching (stop session, clear watch state) */
  stopWatch: () => Promise<void>;
  /** Resume a suspended session with a fresh capture (orphans old capture) */
  resumeWithNewCapture: () => Promise<void>;
  /** Connect to a profile without streaming (creates session in stopped state, for Query app) */
  connectOnly: (profileId: string, options?: LoadOptions) => Promise<void>;
  /** Open a saved profile or capture, joining the session already on it; null leaves for no source */
  selectProfile: (sourceId: string | null) => Promise<void>;
  /** Select multiple profiles for multi-bus mode */
  selectMultipleProfiles: (profileIds: string[]) => void;
  /** Join an existing session and close the IO picker dialog */
  joinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;
  /** Skip IO reader selection (clear state, leave if watching) */
  skipReader: () => Promise<void>;
  /** Ref that tracks whether stream has completed (for ignoring stale time updates) */
  streamCompletedRef: React.MutableRefObject<boolean>;

  // ---- Time range ----
  /** Re-window a recorded session (an event jump), stopping the current stream if needed. Times are UTC ISO-8601. */
  jumpToTimeRange: (startUtc: string, endUtc?: string) => Promise<void>;
}

/**
 * High-level IO session management hook.
 * Wraps common patterns used by Discovery, Decoder, and Transmit apps.
 */
export function useIOSessionManager(
  options: UseIOSessionManagerOptions
): UseIOSessionManagerResult {
  const {
    appName,
    ioProfiles,
    store,
    defaultSourceId,
    onBeforeIngestStart,
    onIngestComplete,
    onFrames: onFramesProp,
    onDecoded,
    onAdhocSignals,
    onError,
    onTimeUpdate,
    onStreamEnded,
    onSuspended,
    onStreamComplete,
    onSpeedChange,
    setPlaybackSpeed: setPlaybackSpeedProp,
    onBeforeWatch,
    onBeforeMultiWatch,
    streamCompletedRef: streamCompletedRefProp,
    onSessionReconfigured,
    onSessionDestroyed,
  } = options;

  // ---- Profile State ----
  // Use store if provided, otherwise local state
  const [localProfile, setLocalProfile] = useState<string | null>(null);
  const ioProfile = store?.ioProfile ?? localProfile;
  const setIoProfile = store?.setIoProfile ?? setLocalProfile;

  // ---- Multi-Bus State (per-instance, not global) ----
  const [multiBusProfiles, setMultiBusProfiles] = useState<string[]>([]);
  const [outputBusToSource, setOutputBusToSource] = useState<Map<number, BusSourceInfo>>(
    () => new Map()
  );

  const [isWatching, setIsWatching] = useState(false);

  // ---- Ingest State (unified with session) ----
  const [isLoading, setIsLoading] = useState(false);
  const [loadSessionId, setLoadSessionId] = useState<string | null>(null);
  const [loadFrameCount, setLoadFrameCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- Auto-Join from Cross-App Commands ----
  const pendingJoin = useSessionStore((s) => s.pendingJoins[appName]);
  const clearPendingJoin = useSessionStore((s) => s.clearPendingJoin);

  // ---- Stream Completed Ref ----
  // Use provided ref (from app) or create a local one
  const localStreamCompletedRef = useRef(false);
  const streamCompletedRef = streamCompletedRefProp ?? localStreamCompletedRef;

  // ---- Derived Values ----
  // ioProfile holds the session id for every source kind, so a path that switches
  // source by setting it alone cannot leave the app on the session it left.
  const effectiveSessionId = ioProfile ?? undefined;

  // Frame counts are Rust-authoritative — pushed live (FrameCounts 0x16) onto the
  // session in the store. Read them here so the UI renders them directly; no TS
  // counting (which previously drifted/froze via the isWatching latch).
  const watchFrameCount = useSessionStore((s) =>
    effectiveSessionId ? s.sessions[effectiveSessionId]?.frameCount ?? 0 : 0);
  const watchUniqueFrameCount = useSessionStore((s) =>
    effectiveSessionId ? s.sessions[effectiveSessionId]?.uniqueFrameCount ?? 0 : 0);

  // Raw bytes are read from the capture, not streamed — so the count and the capture id
  // arrive together (ByteCounts 0x19) and are all a byte view needs to follow the stream.
  // Scalar selectors, so a 2 Hz count push doesn't re-render on session-object identity.
  const watchByteCount = useSessionStore((s) =>
    effectiveSessionId ? s.sessions[effectiveSessionId]?.byteCount ?? 0 : 0);
  const bytesCaptureId = useSessionStore((s) =>
    effectiveSessionId ? s.sessions[effectiveSessionId]?.bytesCaptureId ?? null : null);
  // Rust-authoritative, so it is known for a session this app only joined, and
  // survives a stopped source replaying its capture.
  const sourceProfileId = useSessionStore((s) =>
    effectiveSessionId ? s.sessions[effectiveSessionId]?.originProfileIds[0] ?? null : null);
  const mode = useSessionStore((s) => (effectiveSessionId ? s.sessions[effectiveSessionId]?.mode : undefined));

  // Resolve a profile id, falling back to the ad-hoc registry.
  //
  // Read imperatively rather than through the merged `ioProfiles` prop: a device
  // created in the picker is registered and connected in the same handler, so
  // the parent's re-render has not landed yet and the closure would still hold
  // the pre-registration list.
  const findProfile = useCallback(
    (id: string): IOProfile | undefined =>
      ioProfiles.find((p) => p.id === id) ??
      useAdHocProfileStore.getState().profiles.find((p) => p.id === id),
    [ioProfiles],
  );

  // Profile name for display
  const ioProfileName = useMemo(() => {
    if (multiBusProfiles.length > 1) {
      return `Multi-Bus (${multiBusProfiles.length} sources)`;
    }
    const lookupId = multiBusProfiles.length === 1 ? multiBusProfiles[0] : sourceProfileId;
    return lookupId ? ioProfiles.find((p) => p.id === lookupId)?.name : undefined;
  }, [sourceProfileId, multiBusProfiles, ioProfiles]);

  // ---- Ingest frame suppression ----
  const isLoadingRef = useRef(isLoading);
  const loadSessionIdRef = useRef(loadSessionId);
  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);
  useEffect(() => {
    loadSessionIdRef.current = loadSessionId;
  }, [loadSessionId]);

  // Wrap onFrames to count frames and optionally suppress delivery during ingest
  const handleFrames = useCallback((frames: FrameMessage[]) => {
    if (isLoadingRef.current) {
      // During ingest: count frames but DON'T deliver to app (no rendering)
      setLoadFrameCount((prev) => prev + frames.length);
      return; // Don't call onFramesProp
    }
    // Frame counts come from the backend (FrameCounts push) — no TS counting here.
    onFramesProp?.(frames);
  }, [onFramesProp]);

  // ---- Ingest Callbacks ----
  const onIngestCompleteRef = useRef(onIngestComplete);
  const onBeforeIngestStartRef = useRef(onBeforeIngestStart);
  useEffect(() => {
    onIngestCompleteRef.current = onIngestComplete;
    onBeforeIngestStartRef.current = onBeforeIngestStart;
  }, [onIngestComplete, onBeforeIngestStart]);

  // ---- IO Session ----
  // A reconfigure (any app's, this one's included) or a resume to live: Rust sends it
  // after the old stream's last frame and before the new one's first, so clearing here
  // drops exactly the old stream's frames.
  const clearForFreshStream = useCallback(() => {
    tlog.debug(`[IOSessionManager:${appName}] Fresh stream on the session - clearing state`);
    onBeforeWatch?.();
    streamCompletedRef.current = false;
  }, [appName, onBeforeWatch, streamCompletedRef]);

  // Handle stream-ended with auto-transition for ingest mode
  const handleStreamEndedWithIngest = useCallback(async (payload: StreamEndedInfo) => {
    tlog.debug(`[IOSessionManager:${appName}] Stream ended, isLoading=${isLoadingRef.current}, payload: ${JSON.stringify(payload)}`);

    if (isLoadingRef.current && payload.capture_available) {
      // Ingest completed with capture available - switch to capture replay mode
      tlog.debug(`[IOSessionManager:${appName}] Ingest complete - switching to capture replay mode`);

      const sessionId = loadSessionIdRef.current;
      if (sessionId) {
        try {
          // Switch session to capture replay mode (keeps session alive, swaps reader)
          await switchSessionToCaptureReplay(sessionId, 1.0);
          tlog.debug(`[IOSessionManager:${appName}] Session '${sessionId}' now in capture replay mode`);
        } catch (e) {
          tlog.info(`[IOSessionManager:${appName}] Failed to switch to capture replay: ${e}`);
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }

      setIsLoading(false);

      // Call app's ingest complete callback
      // App should: enableCaptureMode(count), load frame info for display
      if (onIngestCompleteRef.current) {
        await onIngestCompleteRef.current(payload);
      }
    } else if (isLoadingRef.current) {
      // Ingest ended without capture (error or empty)
      tlog.debug(`[IOSessionManager:${appName}] Ingest ended without capture`);
      setIsLoading(false);
      if (onIngestCompleteRef.current) {
        await onIngestCompleteRef.current(payload);
      }
    }

    // Always call the app's onStreamEnded callback
    onStreamEnded?.(payload);
  }, [appName, onStreamEnded]);

  // Handle external session destruction (e.g., destroyed from Sessions app).
  // Switches to capture mode if orphaned captures are available, otherwise clears
  // state. Never fires for a teardown this app's own call caused — Rust names the
  // caller on `destroyed` and `useIOSession` drops it — so adopting the capture cannot
  // feed back into another teardown.
  const handleSessionDestroyed = useCallback((orphanedCaptureIds: string[], userInitiated: boolean) => {
    // A user-initiated "Destroy session" wants a clean slate, not the orphaned
    // capture the external-destroy path falls back to. The intent is carried by
    // the backend `destroyed` event (`reset`), so it's correct for every panel.
    tlog.info(`[IOSessionManager:${appName}] Session destroyed${userInitiated ? " (user)" : " externally"}, orphaned captures: ${JSON.stringify(orphanedCaptureIds)}`);

    // Clear app state (frame lists, etc.)
    onBeforeWatch?.();

    // Clear all session-related state
    setMultiBusProfiles([]);
    setIsWatching(false);
    setIsLoading(false);
    streamCompletedRef.current = false;

    if (userInitiated) {
      // Deliberate destroy → clean slate, skip the capture fallback.
      setIoProfile(null);
    } else {
      // External destroy → switch to the orphaned capture if there is one.
      setIoProfile(orphanedCaptureIds[0] ?? null);
      onSessionDestroyed?.(orphanedCaptureIds);
    }
  }, [appName, onBeforeWatch, setMultiBusProfiles, setIoProfile, streamCompletedRef, onSessionDestroyed]);

  const sessionOptions: UseIOSessionOptions = {
    appName,
    sessionId: effectiveSessionId,
    profileName: ioProfileName,
    onFrames: handleFrames,
    onDecoded,
    onAdhocSignals,
    onError,
    onTimeUpdate,
    onStreamEnded: handleStreamEndedWithIngest,
    onSuspended,
    onSwitchedToCapture: (payload) => {
      // Fires for ALL apps on the session (including the one that clicked Stop).
      // Session stays the same — isCaptureMode is now derived from capabilities
      // (temporal_mode="capture"). sourceProfileId stays set so canReturnToLive works.
      setIsWatching(false);
      setMultiBusProfiles([]); // Clear device profile IDs so Data Source picker doesn't show old device
      tlog.debug(`[IOSessionManager:${appName}] Session switched to capture by event, capture=${payload.capture_id}`);
    },
    onStreamComplete,
    onSpeedChange,
    onReconfigure: clearForFreshStream,
    onResuming: clearForFreshStream,
    onDestroyed: handleSessionDestroyed,
  };

  const session = useIOSession(sessionOptions);

  // ---- Derived State ----
  const readerState = session.state;
  const isStreaming = readerState === "running" || readerState === "paused";
  const isPaused = readerState === "paused";
  const isRealtime = mode === "live";
  const isCaptureMode = mode === "capture" || mode === "replaying";
  const isStopped = readerState === "stopped" && ioProfile !== null;
  const canReturnToLive = mode === "replaying";
  const sessionReady = session.isReady;
  const capabilities = session.capabilities;
  const joinerCount = session.joinerCount;
  const { currentTimeUs, captureId, captureStartTimeUs } = session;
  const playheadNowUs = useCallback(
    () => currentTimeUs ?? (isStreaming && isRealtime ? Date.now() * 1000 : captureStartTimeUs),
    [currentTimeUs, isStreaming, isRealtime, captureStartTimeUs]
  );
  const eventOwner = useMemo(
    () => eventOwnerForSession({ sourceProfileId, profiles: ioProfiles, captureId }),
    [sourceProfileId, ioProfiles, captureId]
  );

  // ---- Handlers ----
  // Leave session: behaviour depends on current mode.
  // - Capture mode → full disconnect (No Source)
  // - Realtime/Recorded → stop source and switch to capture replay in-place
  const handleLeave = useCallback(async () => {
    // Full disconnect to No Source. Reset state BEFORE the async leave so React batches
    // both in one render — stops useIOSession re-creating the session while its
    // effectiveSessionId is still set.
    const disconnect = async () => {
      onBeforeWatch?.();
      setMultiBusProfiles([]);
      setIoProfile(null);
      setIsWatching(false);
      await session.leave();
    };

    if (isCaptureMode) {
      // Already viewing a capture → "second leave" → No Source.
      await disconnect();
      return;
    }

    // Realtime or Recorded → per-app leave: Rust copies a capture snapshot, unregisters
    // THIS subscriber (the session keeps streaming for any other apps), and emits
    // `subscriber-evicted` → useIOSession routes it to handleSessionDestroyed, which
    // switches this app to the snapshot. Rust handles 0-frame / sole-subscriber.
    const sessionId = session.sessionId;
    if (!sessionId) return;
    try {
      await leaveSessionToCapture(sessionId, session.subscriberId);
      tlog.debug(`[IOSessionManager:${appName}] Leave: detached to capture snapshot`);
    } catch (e) {
      tlog.info(`[IOSessionManager:${appName}] Leave failed, disconnecting: ${e}`);
      await disconnect();
    }
  }, [session, onBeforeWatch, setMultiBusProfiles, setIoProfile, isCaptureMode, appName]);

  // Destroy the session entirely — reset=true so the global `destroyed` broadcast tells
  // EVERY connected app to return to "No source" (not fall back to the orphaned capture).
  const handleDestroy = useCallback(async () => {
    const { destroyReaderSession } = await import("../api/io");
    const sessionId = session.sessionId;
    // Clear app state up front rather than waiting for the destroyed lifecycle event.
    // That event only reaches us while the listener for this session id is mounted, so
    // anything that changes the effective session id mid-teardown used to strand the
    // view showing frames from a session that no longer exists.
    onBeforeWatch?.();
    if (sessionId) {
      await destroyReaderSession(sessionId, true);
    }
    // Clear local state
    setMultiBusProfiles([]);
    setIsWatching(false);
  }, [session.sessionId, setMultiBusProfiles, onBeforeWatch]);

  // Clear capture — behaviour depends on source type:
  // Real-time/recorded: clear capture data in backend (session keeps running)
  // Buffer (non-persistent): delete capture + leave session
  const handleClearCapture = useCallback(async () => {
    const { clearCaptureData, deleteCapture } = await import("../api/capture");
    const bid = session.captureId;

    if (mode === "capture") {
      // Capture mode: delete capture + leave session (clean leave, no suspend/copy)
      tlog.info(`[IOSessionManager] Clear capture: deleting capture ${bid} and leaving session`);
      if (bid) {
        await deleteCapture(bid);
        const { emit } = await import("@tauri-apps/api/event");
        emit(WINDOW_EVENTS.CAPTURE_CHANGED, { metadata: null, deletedCaptureIds: [bid], timestamp: Date.now() });
      }
      await session.leave();
      setMultiBusProfiles([]);
      setIoProfile(null);
      setIsWatching(false);
    } else {
      // Real-time or recorded: clear capture data, session continues streaming
      tlog.info(`[IOSessionManager] Clear capture: clearing data for capture ${bid}`);
      if (bid) await clearCaptureData(bid);
    }
  }, [session, mode, setMultiBusProfiles, setIoProfile]);

  // Start multi-bus session
  const startMultiBusSession = useCallback(async (
    profileIds: string[],
    opts: LoadOptions
  ) => {
    const {
      busOverrides,
      framingEncoding,
      delimiter,
      maxFrameLength,
      emitRawBytes,
      perInterfaceFraming,
      minFrameLength,
      frameIdStartByte,
      frameIdBytes,
      frameIdEndianness,
      sourceAddressStartByte,
      sourceAddressBytes,
      sourceAddressEndianness,
      sessionIdOverride,
    } = opts;

    const sessionId = sessionIdOverride ?? await sourcesSessionId(profileIds, emitRawBytes);

    const createOptions: CreateMultiSourceOptions = {
      sessionId,
      subscriberId: session.subscriberId,
      appName,
      profileIds,
      busOverrides,
      // Resolved at call time for the same reason busToSource is below: a
      // device registered moments ago is not in the prop array's closure yet.
      profileNames: new Map(profileIds.map((id) => [id, findProfile(id)?.name ?? id])),
      // Pass framing config for serial sources
      framingEncoding,
      delimiter,
      maxFrameLength,
      emitRawBytes,
      minFrameLength,
      // Per-interface framing overrides
      perInterfaceFraming,
      // Frame ID extraction config (from catalog)
      frameIdStartByte,
      frameIdBytes,
      frameIdBigEndian: frameIdStartByte !== undefined ? frameIdEndianness !== "little" : undefined,
      sourceAddressStartByte,
      sourceAddressBytes,
      sourceAddressBigEndian: sourceAddressEndianness === "big",
      // Modbus poll groups (shared across all Modbus TCP interfaces)
      modbusPollsJson: opts.modbusPollsJson,
    };

    const { busMappings } = await createAndStartMultiSourceSession(createOptions);

    // Build output bus → source mapping. Names come from `findProfile`, not the
    // prop array: a device registered moments ago in the picker is not in that
    // closure yet, and the bus would be labelled with its raw id.
    const busToSource = new Map<number, BusSourceInfo>();
    for (const [profileId, mappings] of busMappings) {
      const profileName = findProfile(profileId)?.name ?? profileId;
      for (const mapping of mappings) {
        if (mapping.enabled) {
          busToSource.set(mapping.output_bus, {
            profileName,
            deviceBus: mapping.device_bus,
            profileId,
          });
        }
      }
    }

    // Update state - React 18 batches these together
    // useIOSession's effect will run with the new sessionId and register callbacks
    // It will see the backend already exists and join it properly
    setMultiBusProfiles(profileIds);
    setOutputBusToSource(busToSource);
    setIoProfile(sessionId);

    attachSessionCatalog(sessionId, opts.catalogPath);
  }, [appName, findProfile, setMultiBusProfiles, setOutputBusToSource, setIoProfile]);


  // ---- Session Switching Methods ----

  // Unified watch method: handles both single and multi-source sessions.
  // Routes multi-source-capable (realtime) profiles through startMultiBusSession,
  // and non-multi-source (recorded/capture) profiles through session.reinitialize().
  const watchSource = useCallback(async (
    profileIds: string[],
    opts: LoadOptions,
  ) => {
    await useProfileBusStore.getState().ensureLoaded();
    const profiles = profileIds
      .map((id) => findProfile(id))
      .filter((p): p is IOProfile => p !== undefined);
    const allMultiSource = profiles.length > 0 && profiles.every((p) => isMultiSourceCapable(p));
    const isSingleNonMulti = profileIds.length === 1 && !allMultiSource;

    if (isSingleNonMulti) {
      // Recorded/capture: reinitialize path
      onBeforeWatch?.();
      const profileId = profileIds[0];
      const sessionId = await sourcesSessionId([profileId]);

      await session.reinitialize(sessionId, profileId, reinitializeOptions(opts));

      setMultiBusProfiles([]);
      setIoProfile(sessionId);

      attachSessionCatalog(sessionId, opts.catalogPath);
    } else {
      // Multi-source path (1 or more realtime profiles)
      if (profileIds.length === 1) {
        onBeforeWatch?.();
      } else {
        onBeforeMultiWatch?.();
      }

      await startMultiBusSession(profileIds, opts);
    }

    if (opts.speed !== undefined) {
      setPlaybackSpeedProp?.(opts.speed);
    }
    setIsWatching(true);
    streamCompletedRef.current = false;
  }, [session, ioProfiles, onBeforeWatch, onBeforeMultiWatch, startMultiBusSession, setMultiBusProfiles, setIoProfile, setPlaybackSpeedProp]);


  // Stop watching → switch to capture replay. Rust picks the path from the
  // source's temporal mode (realtime: stop-and-switch all listeners; recorded:
  // suspend + switch, preserving position).
  const stopWatch = useCallback(async () => {
    if (!session.sessionId) return;
    await sessionStopToCapture(session.sessionId);
    setIsWatching(false);
  }, [session.sessionId]);

  // Resume a suspended session: return to live if possible, otherwise restart capture
  const resumeWithNewCapture = useCallback(async () => {
    onBeforeWatch?.();

    if (canReturnToLive && effectiveSessionId) {
      // Session was stopped from live → capture; reconnect to the live device
      await resumeSessionToLive(effectiveSessionId);
    } else {
      // Buffer or recorded replay — just restart the capture
      await session.resumeFresh();
    }

    setIsWatching(true);
    streamCompletedRef.current = false;
  }, [session, onBeforeWatch, canReturnToLive, effectiveSessionId]);

  // Unified load method: fast ingest without rendering, auto-transitions to capture reader.
  // Handles both single and multi-source sessions.
  const loadSource = useCallback(async (
    profileIds: string[],
    opts: LoadOptions
  ) => {
    // Pre-ingest cleanup
    if (onBeforeIngestStartRef.current) {
      await onBeforeIngestStartRef.current();
    }

    // Clear any previous ingest state
    setLoadError(null);
    setLoadFrameCount(0);

    const sessionId = await generateSessionId({ purpose: "ingest" });
    tlog.info(`[IOSessionManager:${appName}] Starting ingest with session ID: ${sessionId}`);

    // IMPORTANT: Set refs SYNCHRONOUSLY before session creation
    // With speed=0, the stream can complete DURING creation, before React re-renders.
    isLoadingRef.current = true;
    loadSessionIdRef.current = sessionId;

    await useProfileBusStore.getState().ensureLoaded();
    const profiles = profileIds
      .map((id) => findProfile(id))
      .filter((p): p is IOProfile => p !== undefined);
    const allMultiSource = profiles.length > 0 && profiles.every((p) => isMultiSourceCapable(p));
    const isSingleNonMulti = profileIds.length === 1 && !allMultiSource;

    try {
      if (isSingleNonMulti) {
        // Recorded/capture: reinitialize path with speed=0 (no pacing)
        await session.reinitialize(sessionId, profileIds[0], reinitializeOptions({ ...opts, speed: 0 }));

        setMultiBusProfiles([]);
        setIoProfile(sessionId);

        attachSessionCatalog(sessionId, opts.catalogPath);
      } else {
        // Multi-source path with speed=0
        await startMultiBusSession(profileIds, {
          ...opts,
          speed: 0, // Max speed - no pacing
          sessionIdOverride: sessionId,
        });
      }

      setLoadSessionId(sessionId);
      setIsLoading(true);
      setIsWatching(false);
      streamCompletedRef.current = false;

      tlog.info(`[IOSessionManager:${appName}] Ingest started for session: ${sessionId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tlog.info(`[IOSessionManager:${appName}] Failed to start ingest: ${msg}`);
      isLoadingRef.current = false;
      loadSessionIdRef.current = null;
      setLoadError(msg);
      setIsLoading(false);
    }
  }, [session, appName, ioProfiles, startMultiBusSession, setMultiBusProfiles, setIoProfile, streamCompletedRef]);


  // Stop ingest: stop session, clear ingest state
  const stopLoad = useCallback(async () => {
    tlog.debug(`[IOSessionManager:${appName}] Stopping ingest`);
    await session.stop();
    // Note: handleStreamEndedWithIngest will handle the state cleanup and transition
  }, [appName, session]);

  // Connect only: create session without streaming (for Query app)
  // Creates/joins the session with skipAutoStart to prevent auto-starting playback sources.
  // Also marks our subscriber as INACTIVE so we don't receive frames even if session is running.
  // This is useful when:
  // - Backend session is new: session stays stopped, Query won't receive frames
  // - Backend session is shared (Discovery streaming): Query joins but won't receive frames
  const connectOnly = useCallback(async (
    profileId: string,
    opts?: LoadOptions
  ) => {
    const sessionId = await sourcesSessionId([profileId]);

    await session.reinitialize(sessionId, profileId, {
      startTime: opts?.startTime,
      endTime: opts?.endTime,
      speed: opts?.speed,
      limit: opts?.maxFrames,
      skipAutoStart: true, // Don't auto-start - Query connects but doesn't stream
    });

    // Mark our subscriber as INACTIVE so we don't receive frames
    // This is the key difference from watchSource - we connect but don't stream
    try {
      await setSessionSubscriberActive(sessionId, appName, false);
    } catch {
      // Ignore - subscriber may not be fully registered yet
    }

    // Clear multi-bus state when connecting to a single source
    setMultiBusProfiles([]);

    // Set profile to the generated session ID
    setIoProfile(sessionId);
    if (opts?.speed !== undefined) {
      setPlaybackSpeedProp?.(opts.speed);
    }

    // Note: Do NOT set isWatching - session is connected but not streaming to us
  }, [session, appName, setMultiBusProfiles, setIoProfile, setPlaybackSpeedProp]);

  // Re-window the source: reconfigure a recorded one in place, reopen anything else with the new range
  const jumpToTimeRange = useCallback(
    async (startUtc: string, endUtc?: string) => {
      const sessionId = ioProfile;
      if (!sourceProfileId || !sessionId) {
        tlog.debug("[IOSessionManager:jumpToTimeRange] No source profile");
        return;
      }
      const sourceProfile = findProfile(sourceProfileId);
      const isRecorded = sourceProfile ? !isRealtimeProfile(sourceProfile) : false;
      tlog.debug(`[IOSessionManager:jumpToTimeRange] ${startUtc} → ${endUtc ?? "open"} (session: ${sessionId}, profile: ${sourceProfileId}, isRecorded: ${isRecorded})`);

      onBeforeWatch?.();
      // Before the backend call, so the app sets its stream start before frames arrive.
      onSessionReconfigured?.({ startTime: startUtc, endTime: endUtc });
      setMultiBusProfiles([]);

      if (isRecorded) {
        // Other apps on the session stay connected; the old capture is orphaned and a new one starts.
        await reconfigureReaderSession(sessionId, startUtc, endUtc);
      } else {
        if (isWatching) {
          await session.stop();
          setIsWatching(false);
        }
        await session.reinitialize(sessionId, sourceProfileId, {
          startTime: startUtc,
          endTime: endUtc,
          speed: session.speed ?? 1,
        });
      }

      setIsWatching(true);
      streamCompletedRef.current = false;
    },
    [
      sourceProfileId,
      ioProfile,
      isWatching,
      session,
      findProfile,
      onBeforeWatch,
      setMultiBusProfiles,
      streamCompletedRef,
      onSessionReconfigured,
    ]
  );

  // The one place an app turns a saved profile or capture into a session: Rust opens it
  // under the session already on it, or a new one, in the same call.
  const selectProfile = useCallback(async (sourceId: string | null) => {
    setMultiBusProfiles([]);
    if (!sourceId) {
      setIoProfile(null);
      return;
    }
    const profile = findProfile(sourceId);
    if (profile?.kind === "wiretap" && profile.connection?.default_speed) {
      setPlaybackSpeedProp?.(parseFloat(profile.connection.default_speed));
    }
    const sessionId = await session.rejoin(null, sourceId);
    if (sessionId) setIoProfile(sessionId);
  }, [session, findProfile, setMultiBusProfiles, setIoProfile, setPlaybackSpeedProp]);

  // The default source is an initial selection only: settings reload on every save
  // in any window, and reapplying it would retarget a running session.
  const defaultAppliedRef = useRef(false);
  useEffect(() => {
    if (!defaultSourceId || defaultAppliedRef.current) return;
    defaultAppliedRef.current = true;
    if (!ioProfile) selectProfile(defaultSourceId).catch((e) => tlog.info(`[IOSessionManager:${appName}] default source: ${e}`));
  }, [defaultSourceId, ioProfile, selectProfile, appName]);

  // Select multiple profiles for multi-bus mode
  const selectMultipleProfiles = useCallback((profileIds: string[]) => {
    setMultiBusProfiles(profileIds);
    setIoProfile(null);
  }, [setMultiBusProfiles, setIoProfile]);

  // Join an existing session from the IO picker dialog
  const joinSession = useCallback(async (
    sessionId: string,
    sourceProfileIds?: string[]
  ) => {
    // Clear frontend state before joining (fixes frame count showing stale data)
    onBeforeWatch?.();
    setIoProfile(sessionId);
    setMultiBusProfiles(sourceProfileIds || []);
    await session.rejoin(sessionId);
  }, [session, setIoProfile, setMultiBusProfiles, onBeforeWatch]);

  // Skip IO reader selection: clear state, leave if streaming
  const skipReader = useCallback(async () => {
    // Unconditional — this returns the app to "No source", so any data still on screen
    // belongs to a source the user just dismissed. leave() is not reached at all when
    // the session was never running.
    onBeforeWatch?.();
    setMultiBusProfiles([]);
    // Leave session if currently streaming or paused
    const readerState = session.state;
    if (readerState === "running" || readerState === "paused") {
      await session.leave();
      setIsWatching(false);
    }
    setIoProfile(null);
  }, [setMultiBusProfiles, session, setIoProfile, onBeforeWatch]);

  // ---- Auto-Join from Cross-App Commands ----
  // When a source app (Decoder, Discovery) requests this app to join its session,
  // the pending join is consumed here. Skips if already on the requested session.
  useEffect(() => {
    if (!pendingJoin) return;
    clearPendingJoin(appName);
    // Skip if already on the requested session — no need to re-join
    if (effectiveSessionId === pendingJoin.sessionId) return;
    if (!useSessionStore.getState().sessions[pendingJoin.sessionId]) return;
    joinSession(pendingJoin.sessionId).catch(console.error);
  }, [pendingJoin, effectiveSessionId, clearPendingJoin, appName, joinSession]);

  // ---- Clear Watch State on Stream End ----
  // Only reset when streaming transitions from true → false (not on initial mount
  // or when isWatching is set before the session connects and isStreaming becomes true).
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true;
    } else if (wasStreamingRef.current) {
      // Streaming just stopped → clear the watching flag. Always reset the latch
      // first so a stop that sets isWatching=false directly (leave/stopWatch)
      // doesn't leave it stuck true and tear down the next watch.
      wasStreamingRef.current = false;
      if (isWatching) setIsWatching(false);
    }
  }, [isStreaming, isWatching]);

  return {
    // Profile State
    ioProfile,
    setIoProfile,
    ioProfileName,

    // Multi-Bus State
    multiBusProfiles,
    setMultiBusProfiles,
    sourceProfileId,
    outputBusToSource,

    // Effective Session
    effectiveSessionId,
    session,

    // Derived State
    isStreaming,
    isPaused,
    isStopped,
    canReturnToLive,
    isRealtime,
    isCaptureMode,
    sessionReady,
    capabilities,
    joinerCount,
    playbackPosition: session.playbackPosition,
    currentTimeUs: session.currentTimeUs,
    playheadNowUs,
    eventOwner,
    currentFrameIndex: session.currentFrameIndex,

    // Leave/Destroy
    handleLeave,
    handleDestroy,
    handleClearCapture,

    // Watch State
    watchFrameCount,
    watchUniqueFrameCount,
    watchByteCount,
    bytesCaptureId,
    isWatching,
    setIsWatching,

    // Ingest State (unified with session)
    isLoading,
    loadProfileId: loadSessionId,
    loadFrameCount,
    loadError,
    stopLoad,
    loadSource,

    // Session Switching Methods
    watchSource,
    stopWatch,
    resumeWithNewCapture,
    connectOnly,
    selectProfile,
    selectMultipleProfiles,
    joinSession,
    skipReader,
    streamCompletedRef,

    jumpToTimeRange,
  };
}
