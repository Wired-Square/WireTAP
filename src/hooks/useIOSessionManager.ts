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
import type { StreamEndedInfo as IngestStreamEndedInfo } from "../api/io";
import { tlog } from "../api/settings";
import {
  createAndStartMultiSourceSession,
  joinMultiSourceSession,
  useSessionStore,
  isCaptureProfileId,
  type CreateMultiSourceOptions,
  type PerInterfaceFramingConfig,
  type BusSourceInfo,
} from "../stores/sessionStore";

// Re-export for backward compatibility
export { isCaptureProfileId };
import type { BusMapping, PlaybackPosition, RawBytesPayload } from "../api/io";
import type { IOProfile } from "./useSettings";
import type { FrameMessage } from "../types/frame";
import { setSessionListenerActive, reconfigureReaderSession, switchSessionToBufferReplay, stopAndSwitchToBuffer, resumeSessionToLive, type StreamEndedInfo, type IOCapabilities } from "../api/io";
import { markFavoriteUsed, type TimeRangeFavorite } from "../utils/favorites";
import { localToUtc } from "../utils/timeFormat";
import { isRealtimeProfile, generateLoadSessionId } from "../dialogs/io-source-picker/utils";
import { isMultiSourceCapable, buildDefaultBusMappings } from "../utils/profileTraits";
import { WINDOW_EVENTS } from "../events/registry";

/**
 * Generate a unique session ID for recorded sources.
 * Pattern: t_{shortId}
 * - t_ = recorded (postgres, csv, or other recorded sources)
 * - b_ = buffer replay (viewing stored buffer data)
 */
function generateRecordedSessionId(): string {
  const shortId = Math.random().toString(16).slice(2, 8);
  return `t_${shortId}`;
}

function generateBufferSessionId(): string {
  const shortId = Math.random().toString(16).slice(2, 8);
  return `b_${shortId}`;
}

/** Reason for session reconfiguration */
export type SessionReconfigurationReason = "bookmark" | "time_range_change";

/** Information about a session reconfiguration */
export interface SessionReconfigurationInfo {
  /** Why the session was reconfigured */
  reason: SessionReconfigurationReason;
  /** The bookmark that triggered the reconfiguration (if reason === 'bookmark') */
  bookmark?: TimeRangeFavorite;
  /** New start time (UTC ISO-8601) */
  startTime?: string;
  /** New end time (UTC ISO-8601) */
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
  sourceAddressStartByte?: number;
  sourceAddressBytes?: number;
  sourceAddressEndianness?: "big" | "little";
  minFrameLength?: number;
  framingEncoding?: "slip" | "modbus_rtu" | "delimiter" | "raw";
  delimiter?: number[];
  maxFrameLength?: number;
  emitRawBytes?: boolean;
  busOverride?: number;
  busMappings?: Map<string, BusMapping[]>;
  /** Per-interface framing config (for serial profiles in multi-bus mode) */
  perInterfaceFraming?: Map<string, PerInterfaceFramingConfig>;
  /** Override session ID (for ingest mode where we need to set refs before async work) */
  sessionIdOverride?: string;
  /** Modbus TCP poll groups as JSON string (catalog-derived, for modbus_tcp profiles) */
  modbusPollsJson?: string;
}

/** Store interface for apps that manage ioProfile in their store */
export interface IOProfileStore {
  ioProfile: string | null;
  setIoProfile: (profileId: string | null) => void;
}

/** Configuration for the IO session manager */
export interface UseIOSessionManagerOptions {
  /** App name for session identification (e.g., "decoder", "discovery", "transmit") */
  appName: string;
  /** IO profiles from settings */
  ioProfiles: IOProfile[];
  /** Store with ioProfile state (for apps using Zustand stores) */
  store?: IOProfileStore;
  /** Initial ioProfile value (for apps using local state) */
  initialProfileId?: string | null;
  /** Enable ingest session support */
  enableIngest?: boolean;
  /** Callback before ingest starts (e.g., to clear buffer) */
  onBeforeIngestStart?: () => Promise<void>;
  /** Callback when ingest completes */
  onIngestComplete?: (payload: IngestStreamEndedInfo) => Promise<void>;
  /** Only join sessions that produce frames (not raw bytes) */
  requireFrames?: boolean;
  /** Callback when frames are received */
  onFrames?: (frames: FrameMessage[]) => void;
  /** Callback when raw bytes are received (serial byte streams) */
  onBytes?: (payload: RawBytesPayload) => void;
  /** Callback on error */
  onError?: (error: string) => void;
  /** Callback when playback position updates (timestamp and frame index) */
  onTimeUpdate?: (position: PlaybackPosition) => void;
  /** Callback when stream ends */
  onStreamEnded?: (payload: StreamEndedInfo) => void;
  /** Callback when session is suspended (stopped with buffer available) */
  onSuspended?: (payload: import("../api/io").SessionSuspendedPayload) => void;
  /** Callback when buffer playback completes */
  onStreamComplete?: () => void;
  /** Callback when playback speed changes (from any listener on this session) */
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
  /** Called after session is reconfigured (bookmark jump, time range change) */
  onSessionReconfigured?: (info: SessionReconfigurationInfo) => void;
  /** Called when session is destroyed externally (e.g., from Sessions app).
   *  Receives orphaned buffer IDs so apps can switch to buffer mode. */
  onSessionDestroyed?: (orphanedBufferIds: string[]) => void;
}

/** Result of the IO session manager hook */
export interface UseIOSessionManagerResult {
  // ---- Profile State ----
  /** Current IO profile ID */
  ioProfile: string | null;
  /** Set the current IO profile */
  setIoProfile: (profileId: string | null) => void;
  /** Profile name for display */
  ioProfileName: string | undefined;
  /** Map of profile ID to name */
  profileNamesMap: Map<string, string>;

  // ---- Multi-Bus State ----
  /** Profiles in the multi-bus session */
  multiBusProfiles: string[];
  /** Set multi-bus profiles */
  setMultiBusProfiles: (profiles: string[]) => void;
  /** Source profile ID (preserved when switching to buffer) */
  sourceProfileId: string | null;
  /** Set source profile ID */
  setSourceProfileId: (profileId: string | null) => void;
  /** Maps output bus number to source info (profileName, deviceBus) */
  outputBusToSource: Map<number, BusSourceInfo>;

  // ---- Effective Session ----
  /** Effective session ID (multi-bus ID or single profile ID) */
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
  /** Whether in buffer mode and can return to live streaming */
  canReturnToLive: boolean;
  /** Whether realtime (live device) */
  isRealtime: boolean;
  /** Whether in buffer mode */
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

  // ---- Detach/Rejoin State ----
  /** Whether detached from session */
  isDetached: boolean;
  /** Rejoin after detaching */
  handleRejoin: () => Promise<void>;
  /** Leave session — unregister listener, fully reset app state (no data preserved) */
  handleLeave: () => Promise<void>;
  /** Destroy the session entirely */
  handleDestroy: () => Promise<void>;
  /** Clear the session's buffer (real-time/recorded: clear data; buffer: delete + leave) */
  handleClearBuffer: () => Promise<void>;

  // ---- Watch State (for top bar display) ----
  /** Total frame count during watch mode */
  watchFrameCount: number;
  /** Unique frame IDs seen during watch mode */
  watchUniqueFrameCount: number;
  /** Reset watch frame count */
  resetWatchFrameCount: () => void;
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
  /** Clear ingest error */
  clearIngestError: () => void;
  /** Unified ingest from one or more sources (fast ingest, auto-transitions to buffer reader) */
  loadSource: (profileIds: string[], options: LoadOptions) => Promise<void>;

  // ---- Multi-Bus Session Handlers ----
  /** Start a multi-bus session */
  startMultiBusSession: (
    profileIds: string[],
    options: LoadOptions
  ) => Promise<void>;
  /** Join an existing multi-source session */
  joinExistingSession: (
    sessionId: string,
    sourceProfileIds?: string[]
  ) => Promise<void>;

  // ---- Session Switching Methods ----
  /** Unified watch for one or more sources (routes based on multi_source trait) */
  watchSource: (profileIds: string[], options: LoadOptions) => Promise<void>;
  /** Stop watching (stop session, clear watch state) */
  stopWatch: () => Promise<void>;
  /** Suspend the session - stops streaming, finalizes buffer, session stays alive */
  suspendSession: () => Promise<void>;
  /** Resume a suspended session with a fresh buffer (orphans old buffer) */
  resumeWithNewBuffer: () => Promise<void>;
  /** Connect to a profile without streaming (creates session in stopped state, for Query app) */
  connectOnly: (profileId: string, options?: LoadOptions) => Promise<void>;
  /** Select a profile (clear multi-bus, set profile, set default speed) */
  selectProfile: (profileId: string | null) => void;
  /** Select multiple profiles for multi-bus mode */
  selectMultipleProfiles: (profileIds: string[]) => void;
  /** Join an existing session and close the IO picker dialog */
  joinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;
  /** Skip IO reader selection (clear state, leave if watching) */
  skipReader: () => Promise<void>;
  /** Ref that tracks whether stream has completed (for ignoring stale time updates) */
  streamCompletedRef: React.MutableRefObject<boolean>;

  // ---- Bookmark Methods ----
  /** Jump to a bookmark, stopping current stream if needed and reinitializing with bookmark time range */
  jumpToBookmark: (
    bookmark: TimeRangeFavorite,
    options?: Omit<LoadOptions, "startTime" | "endTime" | "maxFrames">
  ) => Promise<void>;
}

/**
 * Generate a unique multi-source session ID.
 * Pattern: {dataType}_{shortId}
 * - f_ = frames (CAN or framed serial)
 * - b_ = bytes (raw serial)
 * - s_ = session (fallback)
 *
 * Profile names are passed to the backend separately for logging purposes.
 */
function generateMultiSessionId(
  busMappings: Map<string, BusMapping[]>,
  profileNames: Map<string, string>,
  emitRawBytes?: boolean
): string {
  // Determine protocol from first enabled bus
  let protocol: string | null = null;

  for (const [profileId, mappings] of busMappings.entries()) {
    for (const mapping of mappings) {
      if (mapping.enabled && !protocol) {
        // First choice: explicit protocol from traits
        if (mapping.traits?.protocols?.length) {
          protocol = mapping.traits.protocols[0].toLowerCase();
        }
        // Second choice: infer from interfaceId (e.g., "can0" → "can")
        else if (mapping.interfaceId) {
          const match = mapping.interfaceId.match(/^([a-z]+)/i);
          if (match) {
            protocol = match[1].toLowerCase();
          }
        }
        // Third choice: infer from profile name
        else {
          const profileName = profileNames.get(profileId)?.toLowerCase() || "";
          if (profileName.includes("gs_usb") || profileName.includes("candlelight") ||
              profileName.includes("gvret") || profileName.includes("slcan") ||
              profileName.includes("socketcan")) {
            protocol = "can";
          } else if (profileName.includes("serial")) {
            protocol = "serial";
          }
        }
      }
    }
  }

  // Generate short random suffix (6 hex chars)
  const shortId = Math.random().toString(16).slice(2, 8);

  // Determine prefix based on output data type, not transport protocol
  let prefix: string;
  if (protocol === "serial" && emitRawBytes) {
    prefix = "b";  // bytes (raw serial)
  } else if (protocol === "modbus") {
    prefix = "m";  // modbus
  } else if (protocol === "can" || protocol === "serial") {
    prefix = "f";  // frames (CAN or framed serial)
  } else {
    prefix = "s";  // session (fallback)
  }

  return `${prefix}_${shortId}`;
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
    initialProfileId = null,
    enableIngest: _enableIngest = false, // Deprecated - ingest is now always available
    onBeforeIngestStart,
    onIngestComplete,
    requireFrames,
    onFrames: onFramesProp,
    onBytes,
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
  const [localProfile, setLocalProfile] = useState<string | null>(initialProfileId);
  const ioProfile = store?.ioProfile ?? localProfile;
  const setIoProfile = store?.setIoProfile ?? setLocalProfile;

  // ---- Multi-Bus State (per-instance, not global) ----
  const [multiBusProfiles, setMultiBusProfiles] = useState<string[]>([]);
  const [sourceProfileId, setSourceProfileId] = useState<string | null>(null);
  const [outputBusToSource, setOutputBusToSource] = useState<Map<number, BusSourceInfo>>(
    () => new Map()
  );

  // ---- Detach/Watch State ----
  const [isDetached, setIsDetached] = useState(false);
  const [watchFrameCount, setWatchFrameCount] = useState(0);
  const watchUniqueIdsRef = useRef(new Set<number>());
  const [watchUniqueFrameCount, setWatchUniqueFrameCount] = useState(0);
  const [isWatching, setIsWatching] = useState(false);

  // ---- Ingest State (unified with session) ----
  const [isLoading, setIsLoading] = useState(false);
  const [loadSessionId, setLoadSessionId] = useState<string | null>(null);
  const [loadFrameCount, setLoadFrameCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- Auto-Join from Cross-App Commands ----
  const pendingJoin = useSessionStore((s) => s.pendingJoins[appName]);
  const clearPendingJoin = useSessionStore((s) => s.clearPendingJoin);

  // ---- Multi-Session ID State ----
  // Generated dynamically when starting a multi-source session to avoid collisions
  // between multiple windows of the same app type
  const [multiSessionId, setMultiSessionId] = useState<string | null>(null);

  // ---- Stream Completed Ref ----
  // Use provided ref (from app) or create a local one
  const localStreamCompletedRef = useRef(false);
  const streamCompletedRef = streamCompletedRefProp ?? localStreamCompletedRef;

  // Flag to suppress handleReconfigure when the reconfigure was self-initiated
  // (e.g., our own jumpToBookmark). The backend fires session-reconfigured for ALL
  // listeners, including the one that initiated the reconfigure.
  const selfReconfigureRef = useRef(0);

  // ---- Derived Values ----
  // Effective session ID: multiSessionId takes priority (all realtime sources now use it),
  // ioProfile is fallback (recorded sources, buffer profiles)
  const effectiveSessionId = multiSessionId ?? ioProfile ?? undefined;

  // Profile name for display
  const ioProfileName = useMemo(() => {
    if (multiBusProfiles.length > 1) {
      return `Multi-Bus (${multiBusProfiles.length} sources)`;
    }
    // For single profile (whether directly selected or routed through multi-source),
    // look up the actual profile name. Try multi-bus first, then ioProfile, then
    // sourceProfileId (for connect-only sessions where ioProfile is a session ID)
    const lookupId = multiBusProfiles.length === 1 ? multiBusProfiles[0] : ioProfile;
    if (!lookupId) return undefined;
    const found = ioProfiles.find((p) => p.id === lookupId)?.name;
    if (found) return found;
    // Fall back to sourceProfileId (e.g., ioProfile is a generated session ID like t_xxxx)
    if (sourceProfileId) {
      return ioProfiles.find((p) => p.id === sourceProfileId)?.name;
    }
    return undefined;
  }, [ioProfile, sourceProfileId, multiBusProfiles, ioProfiles]);

  // Profile names map for multi-bus
  const profileNamesMap = useMemo(() => {
    return new Map(ioProfiles.map((p) => [p.id, p.name]));
  }, [ioProfiles]);

  // ---- Watch/Ingest Frame Counting ----
  const isWatchingRef = useRef(isWatching);
  const isLoadingRef = useRef(isLoading);
  const loadSessionIdRef = useRef(loadSessionId);
  useEffect(() => {
    isWatchingRef.current = isWatching;
  }, [isWatching]);
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
    if (selfReconfigureRef.current > 0) {
      // During self-initiated reconfigure: suppress stale in-flight frames from the old stream.
      // The counter is decremented by handleReconfigure when the session-reconfigured event
      // arrives, so new-stream frames flow normally after the matching event.
      return;
    }
    if (isWatchingRef.current) {
      setWatchFrameCount((prev) => prev + frames.length);
      const ids = watchUniqueIdsRef.current;
      let changed = false;
      for (const f of frames) {
        if (!ids.has(f.frame_id)) {
          ids.add(f.frame_id);
          changed = true;
        }
      }
      if (changed) setWatchUniqueFrameCount(ids.size);
    }
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
  // Handler for when session is reconfigured externally (e.g., another app jumped to a bookmark)
  // This resets frame counts and calls cleanup so the UI clears its state.
  // Skipped for self-initiated reconfigures (jumpToBookmark already handled cleanup).
  const handleReconfigure = useCallback(() => {
    if (selfReconfigureRef.current > 0) {
      selfReconfigureRef.current--;
      // Self-initiated reconfigure: the backend emits this event AFTER the old stream has
      // stopped and BEFORE the new one starts. Any stale in-flight frames from the old stream
      // were suppressed by the flag check in handleFrames. Clear the flag so new-stream
      // frames flow normally.
      tlog.debug(`[IOSessionManager:${appName}] Self-initiated reconfigure - skipping external cleanup`);
      return;
    }
    tlog.debug(`[IOSessionManager:${appName}] Session reconfigured externally - clearing state`);
    // Call the same cleanup as before watch
    onBeforeWatch?.();
    // Reset frame count
    setWatchFrameCount(0);
    watchUniqueIdsRef.current = new Set();
    setWatchUniqueFrameCount(0);
    // Reset stream completed flag
    if (streamCompletedRef) {
      streamCompletedRef.current = false;
    }
  }, [appName, onBeforeWatch, streamCompletedRef]);

  // Handler for when session resumes to live (another app clicked Resume)
  // This clears frames so the app doesn't show old buffer frames mixed with new live frames
  const handleResuming = useCallback(() => {
    tlog.debug(`[IOSessionManager:${appName}] Session resuming to live - clearing state`);
    // Call the same cleanup as before watch
    onBeforeWatch?.();
    // Reset frame count
    setWatchFrameCount(0);
    watchUniqueIdsRef.current = new Set();
    setWatchUniqueFrameCount(0);
    // Reset stream completed flag
    if (streamCompletedRef) {
      streamCompletedRef.current = false;
    }
  }, [appName, onBeforeWatch, streamCompletedRef]);

  // Handle stream-ended with auto-transition for ingest mode
  const handleStreamEndedWithIngest = useCallback(async (payload: StreamEndedInfo) => {
    tlog.debug(`[IOSessionManager:${appName}] Stream ended, isLoading=${isLoadingRef.current}, payload: ${JSON.stringify(payload)}`);

    if (isLoadingRef.current && payload.capture_available) {
      // Ingest completed with buffer available - switch to buffer replay mode
      tlog.debug(`[IOSessionManager:${appName}] Ingest complete - switching to buffer replay mode`);

      const sessionId = loadSessionIdRef.current;
      if (sessionId) {
        try {
          // Switch session to buffer replay mode (keeps session alive, swaps reader)
          await switchSessionToBufferReplay(sessionId, 1.0);
          tlog.debug(`[IOSessionManager:${appName}] Session '${sessionId}' now in buffer replay mode`);
        } catch (e) {
          tlog.info(`[IOSessionManager:${appName}] Failed to switch to buffer replay: ${e}`);
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }

      setIsLoading(false);

      // Call app's ingest complete callback
      // App should: enableBufferMode(count), load frame info for display
      if (onIngestCompleteRef.current) {
        await onIngestCompleteRef.current(payload);
      }
    } else if (isLoadingRef.current) {
      // Ingest ended without buffer (error or empty)
      tlog.debug(`[IOSessionManager:${appName}] Ingest ended without buffer`);
      setIsLoading(false);
      if (onIngestCompleteRef.current) {
        await onIngestCompleteRef.current(payload);
      }
    }

    // Always call the app's onStreamEnded callback
    onStreamEnded?.(payload);
  }, [appName, onStreamEnded]);

  // Handle external session destruction (e.g., destroyed from Sessions app)
  // Switches to buffer mode if orphaned buffers are available, otherwise clears state
  const handleSessionDestroyed = useCallback((orphanedBufferIds: string[]) => {
    tlog.info(`[IOSessionManager:${appName}] Session destroyed externally, orphaned buffers: ${JSON.stringify(orphanedBufferIds)}`);

    // Clear app state (frame lists, etc.)
    onBeforeWatch?.();

    // Clear all session-related state
    setMultiBusProfiles([]);
    setMultiSessionId(null);
    setSourceProfileId(null);
    setIsWatching(false);
    setIsLoading(false);
    setIsDetached(false);
    setWatchFrameCount(0);
    watchUniqueIdsRef.current = new Set();
    setWatchUniqueFrameCount(0);
    streamCompletedRef.current = false;

    // Switch to orphaned buffer if available, otherwise clear profile
    if (orphanedBufferIds.length > 0) {
      const captureId = orphanedBufferIds[0];
      setIoProfile(captureId);
      setSourceProfileId(captureId);
    } else {
      setIoProfile(null);
    }

    // Notify app with orphaned buffer IDs so it can set up buffer mode
    onSessionDestroyed?.(orphanedBufferIds);
  }, [appName, onBeforeWatch, setMultiBusProfiles, setIoProfile, streamCompletedRef, onSessionDestroyed]);

  const sessionOptions: UseIOSessionOptions = {
    appName,
    sessionId: effectiveSessionId,
    profileName: ioProfileName,
    requireFrames,
    onFrames: handleFrames,
    onBytes,
    onError,
    onTimeUpdate,
    onStreamEnded: handleStreamEndedWithIngest,
    onSuspended,
    onSwitchedToBuffer: (payload) => {
      // Fires for ALL apps on the session (including the one that clicked Stop).
      // Session stays the same — isCaptureMode is now derived from capabilities
      // (temporal_mode="buffer"). sourceProfileId stays set so canReturnToLive works.
      setIsWatching(false);
      setMultiBusProfiles([]); // Clear device profile IDs so Data Source picker doesn't show old device
      tlog.debug(`[IOSessionManager:${appName}] Session switched to buffer by event, buffer=${payload.buffer_id}`);
    },
    onStreamComplete,
    onSpeedChange,
    onReconfigure: handleReconfigure,
    onResuming: handleResuming,
    onDestroyed: handleSessionDestroyed,
  };

  const session = useIOSession(sessionOptions);

  // ---- Derived State ----
  const readerState = session.state;
  const isStreaming = !isDetached && (readerState === "running" || readerState === "paused");
  const isPaused = readerState === "paused";
  const isRealtime = session.capabilities?.traits.temporal_mode === "realtime";
  // Buffer mode = viewing buffer data. Detected via:
  // 1. Profile ID is a buffer ID (direct buffer selection), OR
  // 2. Session capabilities report temporal_mode="buffer" (device switched to BufferReader)
  const isCaptureMode = isCaptureProfileId(ioProfile) || isCaptureProfileId(sourceProfileId)
    || session.capabilities?.traits.temporal_mode === "buffer";
  // Stopped with a profile selected (ready to restart)
  // For realtime sources: can restart the live stream
  // For recorded sources: can restart from the beginning
  const isStopped = !isDetached && readerState === "stopped" && ioProfile !== null;
  // Can return to live: was originally a realtime source but switched to buffer replay
  // Detected by isCaptureMode + sourceProfileId being a real profile (not a buffer ID itself)
  const canReturnToLive = !isDetached && isCaptureMode && sourceProfileId !== null && !isCaptureProfileId(sourceProfileId);
  const sessionReady = session.isReady;
  const capabilities = session.capabilities;
  const joinerCount = session.joinerCount;

  // ---- Handlers ----
  // Leave session, keeping a reference to the buffer data.
  // When other listeners remain, we copy the buffer so the session's buffer stays intact.
  // When we're the last listener, we skip the copy — leaving the session orphans the
  // buffer automatically, and we can reference it directly.
  // Leave session: unregister listener, fully reset app state, no data preserved
  const handleLeave = useCallback(async () => {
    // App-specific cleanup (clear frames, decoded data, etc.)
    onBeforeWatch?.();
    // Unregister listener from the session
    await session.leave();
    // Full state reset
    setMultiBusProfiles([]);
    setMultiSessionId(null);
    setIoProfile(null);
    setSourceProfileId(null);
    setIsWatching(false);
    setIsDetached(false);
  }, [session, onBeforeWatch, setMultiBusProfiles, setIoProfile]);

  const handleRejoin = useCallback(async () => {
    await session.rejoin();
    setIsDetached(false);
    setIsWatching(true);
  }, [session]);

  // Destroy the session entirely
  const handleDestroy = useCallback(async () => {
    const { destroyReaderSession } = await import("../api/io");
    const sessionId = session.sessionId;
    if (sessionId) {
      await destroyReaderSession(sessionId);
    }
    // Clear local state
    setMultiBusProfiles([]);
    setIsWatching(false);
    setIsDetached(false);
    // Note: the session destruction will emit lifecycle events that update the UI
  }, [session.sessionId, setMultiBusProfiles]);

  // Clear buffer — behaviour depends on source type:
  // Real-time/recorded: clear buffer data in backend (session keeps running)
  // Buffer (non-persistent): delete buffer + leave session
  const handleClearBuffer = useCallback(async () => {
    const { clearCaptureData, deleteCapture } = await import("../api/capture");
    // For buffer sessions, sourceProfileId holds the buf_N ID;
    // for real-time/recorded sessions the buffer ID is on the session object.
    const bid = isCaptureProfileId(sourceProfileId) ? sourceProfileId : session.captureId;

    if (isCaptureProfileId(sourceProfileId)) {
      // Buffer mode: delete buffer + leave session (clean leave, no suspend/copy)
      tlog.info(`[IOSessionManager] Clear buffer: deleting buffer ${bid} and leaving session`);
      if (bid) {
        await deleteCapture(bid);
        useSessionStore.getState().removeKnownCaptureId(bid);
        const { emit } = await import("@tauri-apps/api/event");
        emit(WINDOW_EVENTS.BUFFER_CHANGED, { metadata: null, deletedBufferIds: [bid], timestamp: Date.now() });
      }
      await session.leave();
      setMultiBusProfiles([]);
      setIoProfile(null);
      setIsWatching(false);
      setIsDetached(false);
    } else {
      // Real-time or recorded: clear buffer data, session continues streaming
      tlog.info(`[IOSessionManager] Clear buffer: clearing data for buffer ${bid}`);
      if (bid) await clearCaptureData(bid);
    }
  }, [session, ioProfile, setMultiBusProfiles, setIoProfile]);

  const resetWatchFrameCount = useCallback(() => {
    setWatchFrameCount(0);
    watchUniqueIdsRef.current = new Set();
    setWatchUniqueFrameCount(0);
  }, []);

  // Start multi-bus session
  const startMultiBusSession = useCallback(async (
    profileIds: string[],
    opts: LoadOptions
  ) => {
    const {
      busMappings,
      framingEncoding,
      delimiter,
      maxFrameLength,
      emitRawBytes,
      perInterfaceFraming,
      minFrameLength,
      frameIdStartByte,
      frameIdBytes,
      sourceAddressStartByte,
      sourceAddressBytes,
      sourceAddressEndianness,
      sessionIdOverride,
    } = opts;

    // Ensure every profile has bus mappings (fill defaults for any missing)
    const effectiveBusMappings = new Map(busMappings ?? []);
    for (const profileId of profileIds) {
      if (!effectiveBusMappings.has(profileId)) {
        const profile = ioProfiles.find((p) => p.id === profileId);
        if (profile) {
          effectiveBusMappings.set(profileId, buildDefaultBusMappings(profile));
        }
      }
    }

    // Use provided session ID or generate one to avoid collisions between windows
    const sessionId = sessionIdOverride ?? (effectiveBusMappings.size > 0
      ? generateMultiSessionId(effectiveBusMappings, profileNamesMap, emitRawBytes)
      : `s_${Math.random().toString(16).slice(2, 8)}`);

    const createOptions: CreateMultiSourceOptions = {
      sessionId,
      listenerId: session.listenerId,
      appName,
      profileIds,
      busMappings: effectiveBusMappings,
      profileNames: profileNamesMap,
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
      frameIdBigEndian: frameIdStartByte !== undefined ? true : undefined, // Default to big endian if frame ID is configured
      sourceAddressStartByte,
      sourceAddressBytes,
      sourceAddressBigEndian: sourceAddressEndianness === "big",
      // Modbus poll groups (shared across all Modbus TCP interfaces)
      modbusPollsJson: opts.modbusPollsJson,
    };

    // Create the session and set up heartbeats
    // This ensures heartbeats start immediately, keeping the session alive
    await createAndStartMultiSourceSession(createOptions);

    // Build output bus → source mapping
    const busToSource = new Map<number, { profileName: string; deviceBus: number }>();
    if (busMappings) {
      for (const [profileId, mappings] of busMappings) {
        const profileName = profileNamesMap.get(profileId) ?? profileId;
        for (const mapping of mappings) {
          if (mapping.enabled) {
            busToSource.set(mapping.outputBus, {
              profileName,
              deviceBus: mapping.deviceBus,
            });
          }
        }
      }
    }

    // Update state - React 18 batches these together
    // useIOSession's effect will run with the new sessionId and register callbacks
    // It will see the backend already exists and join it properly
    setMultiBusProfiles(profileIds);
    setOutputBusToSource(busToSource);
    setMultiSessionId(sessionId);
    setIoProfile(sessionId);
    setIsDetached(false);
  }, [appName, profileNamesMap, setMultiBusProfiles, setOutputBusToSource, setIoProfile]);

  // Join existing multi-source session
  const joinExistingSession = useCallback(async (
    sessionId: string,
    sourceProfileIds?: string[]
  ) => {
    // Clear frontend state before joining (fixes frame count showing stale data)
    onBeforeWatch?.();
    resetWatchFrameCount();
    // Reset multiSessionId when switching sessions so effectiveSessionId updates cleanly
    setMultiSessionId(null);

    // Join the session and set up heartbeats
    await joinMultiSourceSession({
      sessionId,
      listenerId: session.listenerId,
      appName,
      sourceProfileIds,
    });

    // Update state
    setIoProfile(sessionId);
    setMultiBusProfiles(sourceProfileIds || []);
    // Set multiSessionId when joining with profiles so effectiveSessionId computation works
    if (sourceProfileIds && sourceProfileIds.length > 0) {
      setMultiSessionId(sessionId);
    }
    setIsDetached(false);
    await session.rejoin(sessionId);
  }, [appName, session, setIoProfile, setMultiBusProfiles, onBeforeWatch, resetWatchFrameCount]);

  // ---- Session Switching Methods ----

  // Unified watch method: handles both single and multi-source sessions.
  // Routes multi-source-capable (realtime) profiles through startMultiBusSession,
  // and non-multi-source (recorded/buffer) profiles through session.reinitialize().
  const watchSource = useCallback(async (
    profileIds: string[],
    opts: LoadOptions,
  ) => {
    const profiles = profileIds
      .map((id) => ioProfiles.find((p) => p.id === id))
      .filter((p): p is IOProfile => p !== undefined);
    const allMultiSource = profiles.length > 0 && profiles.every((p) => isMultiSourceCapable(p));
    const isSingleNonMulti = profileIds.length === 1 && !allMultiSource;

    if (isSingleNonMulti) {
      // Timeline/buffer: reinitialize path
      onBeforeWatch?.();
      const profileId = profileIds[0];
      const isBuffer = isCaptureProfileId(profileId);
      const sessionId = isBuffer ? generateBufferSessionId() : generateRecordedSessionId();

      await session.reinitialize(profileId, {
        startTime: opts.startTime,
        endTime: opts.endTime,
        speed: opts.speed,
        limit: opts.maxFrames,
        framingEncoding: opts.framingEncoding,
        delimiter: opts.delimiter,
        maxFrameLength: opts.maxFrameLength,
        frameIdStartByte: opts.frameIdStartByte,
        frameIdBytes: opts.frameIdBytes,
        frameIdBigEndian: opts.frameIdStartByte !== undefined ? true : undefined,
        sourceAddressStartByte: opts.sourceAddressStartByte,
        sourceAddressBytes: opts.sourceAddressBytes,
        sourceAddressBigEndian: opts.sourceAddressEndianness === "big",
        minFrameLength: opts.minFrameLength,
        emitRawBytes: opts.emitRawBytes,
        busOverride: opts.busOverride,
        sessionIdOverride: sessionId,
        modbusPollsJson: opts.modbusPollsJson,
      });

      setMultiBusProfiles([]);
      setIoProfile(sessionId);
      setSourceProfileId(profileId);
    } else {
      // Multi-source path (1 or more realtime profiles)
      if (profileIds.length === 1) {
        onBeforeWatch?.();
      } else {
        onBeforeMultiWatch?.();
      }

      // Ensure bus mappings exist for single-profile case
      if (profileIds.length === 1 && !opts.busMappings && profiles[0]) {
        const busMappings = new Map([[profileIds[0], buildDefaultBusMappings(profiles[0])]]);
        await startMultiBusSession(profileIds, { ...opts, busMappings });
      } else {
        await startMultiBusSession(profileIds, opts);
      }

      if (profileIds.length === 1) {
        setSourceProfileId(profileIds[0]);
      }
    }

    if (opts.speed !== undefined) {
      setPlaybackSpeedProp?.(opts.speed);
    }
    setIsWatching(true);
    resetWatchFrameCount();
    streamCompletedRef.current = false;
  }, [session, ioProfiles, onBeforeWatch, onBeforeMultiWatch, startMultiBusSession, setMultiBusProfiles, setIoProfile, setPlaybackSpeedProp, resetWatchFrameCount]);


  // Stop watching: for realtime sources, atomically stop and switch ALL listeners
  // to buffer replay. For recorded sources (postgres, csv), suspend and switch to
  // buffer replay so users can step through buffered frames.
  const stopWatch = useCallback(async () => {
    if (!session.sessionId) return;

    // Use capabilities to determine source type (works for all windows, even joiners
    // that don't have sourceProfileId set)
    const isRealtimeSession = session.capabilities?.traits.temporal_mode === "realtime";

    if (isRealtimeSession) {
      try {
        await stopAndSwitchToBuffer(session.sessionId, 1.0);
        tlog.debug(`[IOSessionManager:${appName}] Stopped realtime session and switched to buffer`);
      } catch (e) {
        tlog.info(`[IOSessionManager:${appName}] stopAndSwitchToBuffer failed, falling back to suspend: ${e}`);
        await session.suspend();
      }
      setIsWatching(false);
      return;
    }

    // Recorded sources: existing suspend + switchToBufferReplay
    await session.suspend();
    try {
      await session.switchToBufferReplay(1.0);
      tlog.debug(`[IOSessionManager:${appName}] Switched to buffer replay mode after stop`);
    } catch (e) {
      tlog.info(`[IOSessionManager:${appName}] Failed to switch to buffer replay after stop: ${e}`);
    }
    setIsWatching(false);
  }, [session, appName]);

  // Suspend session: alias for stopWatch (kept for backward compatibility)
  const suspendSession = stopWatch;

  // Resume a suspended session: return to live if possible, otherwise restart buffer
  const resumeWithNewBuffer = useCallback(async () => {
    onBeforeWatch?.();

    if (canReturnToLive && effectiveSessionId) {
      // Session was stopped from live → buffer; reconnect to the live device
      await resumeSessionToLive(effectiveSessionId);
    } else {
      // Buffer or recorded replay — just restart the buffer
      await session.resumeFresh();
    }

    setIsWatching(true);
    resetWatchFrameCount();
    streamCompletedRef.current = false;
  }, [session, onBeforeWatch, resetWatchFrameCount, canReturnToLive, effectiveSessionId]);

  // Unified load method: fast ingest without rendering, auto-transitions to buffer reader.
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

    // Generate unique session ID for this ingest
    const sessionId = generateLoadSessionId();
    tlog.info(`[IOSessionManager:${appName}] Starting ingest with session ID: ${sessionId}`);

    // IMPORTANT: Set refs SYNCHRONOUSLY before session creation
    // With speed=0, the stream can complete DURING creation, before React re-renders.
    isLoadingRef.current = true;
    loadSessionIdRef.current = sessionId;

    const profiles = profileIds
      .map((id) => ioProfiles.find((p) => p.id === id))
      .filter((p): p is IOProfile => p !== undefined);
    const allMultiSource = profiles.length > 0 && profiles.every((p) => isMultiSourceCapable(p));
    const isSingleNonMulti = profileIds.length === 1 && !allMultiSource;

    try {
      if (isSingleNonMulti) {
        // Timeline/buffer: reinitialize path with speed=0
        const profileId = profileIds[0];
        await session.reinitialize(profileId, {
          startTime: opts.startTime,
          endTime: opts.endTime,
          speed: 0, // Max speed - no pacing
          limit: opts.maxFrames,
          framingEncoding: opts.framingEncoding,
          delimiter: opts.delimiter,
          maxFrameLength: opts.maxFrameLength,
          frameIdStartByte: opts.frameIdStartByte,
          frameIdBytes: opts.frameIdBytes,
          frameIdBigEndian: opts.frameIdStartByte !== undefined ? true : undefined,
          sourceAddressStartByte: opts.sourceAddressStartByte,
          sourceAddressBytes: opts.sourceAddressBytes,
          sourceAddressBigEndian: opts.sourceAddressEndianness === "big",
          minFrameLength: opts.minFrameLength,
          emitRawBytes: opts.emitRawBytes,
          busOverride: opts.busOverride,
          sessionIdOverride: sessionId,
        });

        setMultiBusProfiles([]);
        setIoProfile(sessionId);
        setSourceProfileId(profileId);
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
  }, [session, appName, ioProfiles, startMultiBusSession, setMultiBusProfiles, setIoProfile, setSourceProfileId, streamCompletedRef]);


  // Stop ingest: stop session, clear ingest state
  const stopLoad = useCallback(async () => {
    tlog.debug(`[IOSessionManager:${appName}] Stopping ingest`);
    await session.stop();
    // Note: handleStreamEndedWithIngest will handle the state cleanup and transition
  }, [appName, session]);

  // Clear ingest error
  const clearIngestError = useCallback(() => {
    setLoadError(null);
  }, []);

  // Connect only: create session without streaming (for Query app)
  // Creates/joins the session with skipAutoStart to prevent auto-starting playback sources.
  // Also marks our listener as INACTIVE so we don't receive frames even if session is running.
  // This is useful when:
  // - Postgres session is new: session stays stopped, Query won't receive frames
  // - Postgres session is shared (Discovery streaming): Query joins but won't receive frames
  const connectOnly = useCallback(async (
    profileId: string,
    opts?: LoadOptions
  ) => {
    // Generate a unique session ID like other recorded sources
    const sessionId = generateRecordedSessionId();

    await session.reinitialize(profileId, {
      startTime: opts?.startTime,
      endTime: opts?.endTime,
      speed: opts?.speed,
      limit: opts?.maxFrames,
      skipAutoStart: true, // Don't auto-start - Query connects but doesn't stream
      sessionIdOverride: sessionId,
    });

    // Mark our listener as INACTIVE so we don't receive frames
    // This is the key difference from watchSource - we connect but don't stream
    try {
      await setSessionListenerActive(sessionId, appName, false);
    } catch {
      // Ignore - listener may not be fully registered yet
    }

    // Clear multi-bus state when connecting to a single source
    setMultiBusProfiles([]);

    // Set profile to the generated session ID and track the original profile
    setIoProfile(sessionId);
    setSourceProfileId(profileId);
    if (opts?.speed !== undefined) {
      setPlaybackSpeedProp?.(opts.speed);
    }

    // Note: Do NOT set isWatching - session is connected but not streaming to us
  }, [session, appName, setMultiBusProfiles, setIoProfile, setSourceProfileId, setPlaybackSpeedProp]);

  // Jump to a bookmark: stop if streaming, cleanup, reinitialize with bookmark time range
  const jumpToBookmark = useCallback(
    async (
      bookmark: TimeRangeFavorite,
      opts?: Omit<LoadOptions, "startTime" | "endTime" | "maxFrames">
    ) => {
      // Convert bookmark times to UTC
      const startUtc = localToUtc(bookmark.startTime);
      const endUtc = localToUtc(bookmark.endTime);

      if (!startUtc) {
        tlog.debug("[IOSessionManager:jumpToBookmark] No valid start time in bookmark");
        return;
      }

      // Determine target profile (bookmark's profile or current)
      const targetProfileId = bookmark.profileId || sourceProfileId || ioProfile;
      if (!targetProfileId) {
        tlog.debug("[IOSessionManager:jumpToBookmark] No profile available");
        return;
      }

      // For recorded sources:
      // - If jumping to a bookmark for the same profile we're already watching, reuse the session ID
      //   (other apps stay connected, buffer is finalized and new one created)
      // - If switching to a different profile, generate a unique session ID
      const targetProfile = ioProfiles.find((p) => p.id === targetProfileId);
      const isRecorded = targetProfile ? !isRealtimeProfile(targetProfile) : false;
      const isSameProfile = sourceProfileId === targetProfileId;

      let sessionId: string;
      if (isSameProfile && ioProfile) {
        // Same profile - reuse current session ID (keeps other listeners connected)
        sessionId = ioProfile;
      } else if (isRecorded) {
        // Different profile or no existing session - generate unique ID for recorded sources
        sessionId = generateRecordedSessionId();
      } else {
        // Realtime source - use profile ID
        sessionId = targetProfileId;
      }

      tlog.debug(`[IOSessionManager:jumpToBookmark] Jumping to bookmark "${bookmark.name}" (session: ${sessionId}, profile: ${targetProfileId}, sameProfile: ${isSameProfile}, isRecorded: ${isRecorded})`);

      // Step 1: Run cleanup callback (same as onBeforeWatch)
      onBeforeWatch?.();

      // Step 2: Notify app of reconfiguration BEFORE the async backend call.
      // This lets the app set streamStartTimeUs (for correct time deltas) before
      // frames start arriving during the await below.
      onSessionReconfigured?.({
        reason: "bookmark",
        bookmark,
        startTime: startUtc,
        endTime: endUtc ?? undefined,
      });

      // Step 3: Clear multi-bus state
      setMultiBusProfiles([]);

      // Step 4: Reconfigure or reinitialize (backend auto-starts and may send frames)
      if (isSameProfile && ioProfile && isRecorded) {
        // Same profile, recorded source - use reconfigure to keep session alive
        // This stops the stream, orphans old buffer, creates new buffer, and restarts
        // Other apps joined to this session stay connected
        // Suppress the session-reconfigured event handler since we already ran cleanup
        selfReconfigureRef.current++;
        tlog.debug("[IOSessionManager:jumpToBookmark] Using reconfigure (same profile, session stays alive)");
        await reconfigureReaderSession(sessionId, startUtc, endUtc || undefined);
      } else {
        // Different profile or realtime source - full reinitialize
        tlog.debug("[IOSessionManager:jumpToBookmark] Using reinitialize (different profile or realtime)");

        // Stop current stream if watching
        if (isWatching) {
          tlog.debug("[IOSessionManager:jumpToBookmark] Stopping current watch...");
          await session.stop();
          setIsWatching(false);
        }

        // Reinitialize with bookmark time range
        const effectiveSpeed = opts?.speed ?? session.speed ?? 1;
        await session.reinitialize(targetProfileId, {
          startTime: startUtc,
          endTime: endUtc || undefined,
          speed: effectiveSpeed,
          limit: bookmark.maxFrames,
          framingEncoding: opts?.framingEncoding,
          delimiter: opts?.delimiter,
          maxFrameLength: opts?.maxFrameLength,
          frameIdStartByte: opts?.frameIdStartByte,
          frameIdBytes: opts?.frameIdBytes,
          frameIdBigEndian: opts?.frameIdStartByte !== undefined ? true : undefined,
          sourceAddressStartByte: opts?.sourceAddressStartByte,
          sourceAddressBytes: opts?.sourceAddressBytes,
          sourceAddressBigEndian: opts?.sourceAddressEndianness === "big",
          minFrameLength: opts?.minFrameLength,
          emitRawBytes: opts?.emitRawBytes,
          busOverride: opts?.busOverride,
          // Pass session ID override when it differs from profile ID (recorded sources use unique session IDs)
          sessionIdOverride: sessionId !== targetProfileId ? sessionId : undefined,
        });
      }

      // Step 5: Update manager state (use session ID so callbacks are registered correctly)
      setIoProfile(sessionId);
      setSourceProfileId(targetProfileId);
      if (opts?.speed !== undefined) {
        setPlaybackSpeedProp?.(opts.speed);
      }

      // Step 6: Mark as watching and reset state
      setIsWatching(true);
      resetWatchFrameCount();
      streamCompletedRef.current = false;

      // Step 7: Mark bookmark as used
      await markFavoriteUsed(bookmark.id);
    },
    [
      sourceProfileId,
      ioProfile,
      isWatching,
      session,
      onBeforeWatch,
      setMultiBusProfiles,
      setIoProfile,
      setPlaybackSpeedProp,
      resetWatchFrameCount,
      streamCompletedRef,
      onSessionReconfigured,
    ]
  );

  // Select a profile: clear multi-bus, set profile, set default speed
  // App handlers call this for common logic, then add buffer-specific or app-specific logic
  const selectProfile = useCallback((profileId: string | null) => {
    // Clear multi-bus state when selecting a single profile
    setMultiBusProfiles([]);
    setIoProfile(profileId);

    // Set default speed from the selected profile if it has one (non-buffer only)
    if (profileId && !isCaptureProfileId(profileId)) {
      const profile = ioProfiles.find((p) => p.id === profileId);
      if (profile && (profile.kind === "postgres" || profile.kind === "csv_file") && profile.connection?.default_speed) {
        const defaultSpeed = parseFloat(profile.connection.default_speed);
        setPlaybackSpeedProp?.(defaultSpeed);
      }
    }
  }, [setMultiBusProfiles, setIoProfile, ioProfiles, setPlaybackSpeedProp]);

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
    await joinExistingSession(sessionId, sourceProfileIds);
  }, [joinExistingSession]);

  // Skip IO reader selection: clear state, leave if streaming
  const skipReader = useCallback(async () => {
    setMultiBusProfiles([]);
    // Leave session if currently streaming or paused
    const readerState = session.state;
    if (readerState === "running" || readerState === "paused") {
      await session.leave();
      setIsWatching(false);
    }
    setIoProfile(null);
  }, [setMultiBusProfiles, session, setIoProfile]);

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
    } else if (wasStreamingRef.current && isWatching) {
      // Streaming just stopped
      wasStreamingRef.current = false;
      setIsWatching(false);
      resetWatchFrameCount();
    }
  }, [isStreaming, isWatching, resetWatchFrameCount]);

  return {
    // Profile State
    ioProfile,
    setIoProfile,
    ioProfileName,
    profileNamesMap,

    // Multi-Bus State
    multiBusProfiles,
    setMultiBusProfiles,
    sourceProfileId,
    setSourceProfileId,
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
    currentFrameIndex: session.currentFrameIndex,

    // Rejoin/Leave/Destroy
    isDetached,
    handleRejoin,
    handleLeave,
    handleDestroy,
    handleClearBuffer,

    // Watch State
    watchFrameCount,
    watchUniqueFrameCount,
    resetWatchFrameCount,
    isWatching,
    setIsWatching,

    // Ingest State (unified with session)
    isLoading,
    loadProfileId: loadSessionId,
    loadFrameCount,
    loadError,
    stopLoad,
    clearIngestError,
    loadSource,

    // Multi-Bus Handlers
    startMultiBusSession,
    joinExistingSession,

    // Session Switching Methods
    watchSource,
    stopWatch,
    suspendSession,
    resumeWithNewBuffer,
    connectOnly,
    selectProfile,
    selectMultipleProfiles,
    joinSession,
    skipReader,
    streamCompletedRef,

    // Bookmark Methods
    jumpToBookmark,
  };
}
