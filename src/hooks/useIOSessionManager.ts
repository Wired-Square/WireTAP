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
import type { StreamEndedPayload as IngestStreamEndedPayload } from "../api/io";
import {
  createAndStartMultiSourceSession,
  joinMultiSourceSession,
  useMultiBusState,
  useSessionStore,
  isBufferProfileId,
  BUFFER_PROFILE_ID,
  type CreateMultiSourceOptions,
  type PerInterfaceFramingConfig,
  type BusSourceInfo,
} from "../stores/sessionStore";

// Re-export for backward compatibility
export { isBufferProfileId, BUFFER_PROFILE_ID };
import type { BusMapping, PlaybackPosition, RawBytesPayload } from "../api/io";
import type { IOProfile } from "./useSettings";
import type { FrameMessage } from "../types/frame";
import { setSessionListenerActive, reconfigureReaderSession, switchSessionToBufferReplay, type StreamEndedPayload, type IOCapabilities } from "../api/io";
import { markFavoriteUsed, type TimeRangeFavorite } from "../utils/favorites";
import { localToUtc } from "../utils/timeFormat";
import { isRealtimeProfile, generateIngestSessionId } from "../dialogs/io-reader-picker/utils";

/**
 * Generate a unique session ID for recorded/timeline sources.
 * Pattern: t_{shortId}
 * - t_ = timeline (postgres, csv, or other recorded sources)
 */
function generateRecordedSessionId(): string {
  const shortId = Math.random().toString(16).slice(2, 8);
  return `t_${shortId}`;
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

/** Options for handleDialogStartIngest - matches IoReaderPickerDialog */
export interface IngestOptions {
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
  onIngestComplete?: (payload: IngestStreamEndedPayload) => Promise<void>;
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
  onStreamEnded?: (payload: StreamEndedPayload) => void;
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
  /** Called when session is destroyed externally (e.g., from Sessions app). Apps can clear frame data, etc. */
  onSessionDestroyed?: () => void;
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
  isBufferMode: boolean;
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
  /** Detach from session without stopping */
  handleDetach: () => Promise<void>;
  /** Rejoin after detaching */
  handleRejoin: () => Promise<void>;
  /** Leave session (alias for handleDetach, but always visible in UI) */
  handleLeave: () => Promise<void>;
  /** Destroy the session entirely */
  handleDestroy: () => Promise<void>;

  // ---- Watch State (for top bar display) ----
  /** Frame count during watch mode */
  watchFrameCount: number;
  /** Reset watch frame count */
  resetWatchFrameCount: () => void;
  /** Whether currently watching (streaming with real-time display) */
  isWatching: boolean;
  /** Set watching state */
  setIsWatching: (watching: boolean) => void;

  // ---- Ingest State (unified with session) ----
  /** Whether ingesting (fast ingest without rendering) */
  isIngesting: boolean;
  /** Ingest session ID */
  ingestProfileId: string | null;
  /** Ingest frame count */
  ingestFrameCount: number;
  /** Ingest error */
  ingestError: string | null;
  /** Start ingest (legacy signature for backwards compatibility) */
  startIngest: (params: {
    profileId: string;
    speed?: number;
    startTime?: string;
    endTime?: string;
    maxFrames?: number;
    frameIdStartByte?: number;
    frameIdBytes?: number;
    sourceAddressStartByte?: number;
    sourceAddressBytes?: number;
    sourceAddressBigEndian?: boolean;
    minFrameLength?: number;
  }) => Promise<void>;
  /** Stop ingest */
  stopIngest: () => Promise<void>;
  /** Clear ingest error */
  clearIngestError: () => void;
  /** Ingest from a single source (fast ingest, auto-transitions to buffer reader) */
  ingestSingleSource: (profileId: string, options: IngestOptions) => Promise<void>;
  /** Ingest from multiple sources (fast multi-bus ingest, auto-transitions to buffer reader) */
  ingestMultiSource: (profileIds: string[], options: IngestOptions) => Promise<void>;

  // ---- Multi-Bus Session Handlers ----
  /** Start a multi-bus session */
  startMultiBusSession: (
    profileIds: string[],
    options: IngestOptions
  ) => Promise<void>;
  /** Join an existing multi-source session */
  joinExistingSession: (
    sessionId: string,
    sourceProfileIds?: string[]
  ) => Promise<void>;

  // ---- Session Switching Methods ----
  /** Watch a single source (reinitialize, set profile, clear multi-bus, set speed, start watching) */
  watchSingleSource: (profileId: string, options: IngestOptions, reinitializeOptions?: Record<string, unknown>) => Promise<void>;
  /** Watch multiple sources (start multi-bus session, set speed, start watching) */
  watchMultiSource: (profileIds: string[], options: IngestOptions) => Promise<void>;
  /** Stop watching (stop session, clear watch state) */
  stopWatch: () => Promise<void>;
  /** Suspend the session - stops streaming, finalizes buffer, session stays alive */
  suspendSession: () => Promise<void>;
  /** Resume a suspended session with a fresh buffer (orphans old buffer) */
  resumeWithNewBuffer: () => Promise<void>;
  /** Detach from session with a copy of the buffer */
  detachWithBufferCopy: () => Promise<void>;
  /** Connect to a profile without streaming (creates session in stopped state, for Query app) */
  connectOnly: (profileId: string, options?: IngestOptions) => Promise<void>;
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
    options?: Omit<IngestOptions, "startTime" | "endTime" | "maxFrames">
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

  // ---- Multi-Bus State ----
  const {
    multiBusProfiles,
    sourceProfileId,
    outputBusToSource,
    setMultiBusProfiles,
    setSourceProfileId,
    setOutputBusToSource,
  } = useMultiBusState();

  // ---- Detach/Watch State ----
  const [isDetached, setIsDetached] = useState(false);
  const [watchFrameCount, setWatchFrameCount] = useState(0);
  const [isWatching, setIsWatching] = useState(false);

  // ---- Ingest State (unified with session) ----
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestSessionId, setIngestSessionId] = useState<string | null>(null);
  const [ingestFrameCount, setIngestFrameCount] = useState(0);
  const [ingestError, setIngestError] = useState<string | null>(null);

  // ---- Multi-Session ID State ----
  // Generated dynamically when starting a multi-source session to avoid collisions
  // between multiple windows of the same app type
  const [multiSessionId, setMultiSessionId] = useState<string | null>(null);

  // ---- Stream Completed Ref ----
  // Use provided ref (from app) or create a local one
  const localStreamCompletedRef = useRef(false);
  const streamCompletedRef = streamCompletedRefProp ?? localStreamCompletedRef;

  // ---- Derived Values ----
  // Effective session ID: multi-bus ID or single profile ID
  const effectiveSessionId = multiBusProfiles.length > 0 ? (multiSessionId ?? undefined) : (ioProfile ?? undefined);

  // Profile name for display
  const ioProfileName = useMemo(() => {
    if (multiBusProfiles.length > 0) {
      return `Multi-Bus (${multiBusProfiles.length} sources)`;
    }
    if (!ioProfile) return undefined;
    const profile = ioProfiles.find((p) => p.id === ioProfile);
    return profile?.name;
  }, [ioProfile, multiBusProfiles.length, ioProfiles]);

  // Profile names map for multi-bus
  const profileNamesMap = useMemo(() => {
    return new Map(ioProfiles.map((p) => [p.id, p.name]));
  }, [ioProfiles]);

  // ---- Watch/Ingest Frame Counting ----
  const isWatchingRef = useRef(isWatching);
  const isIngestingRef = useRef(isIngesting);
  const ingestSessionIdRef = useRef(ingestSessionId);
  useEffect(() => {
    isWatchingRef.current = isWatching;
  }, [isWatching]);
  useEffect(() => {
    isIngestingRef.current = isIngesting;
  }, [isIngesting]);
  useEffect(() => {
    ingestSessionIdRef.current = ingestSessionId;
  }, [ingestSessionId]);

  // Wrap onFrames to count frames and optionally suppress delivery during ingest
  const handleFrames = useCallback((frames: FrameMessage[]) => {
    if (isIngestingRef.current) {
      // During ingest: count frames but DON'T deliver to app (no rendering)
      setIngestFrameCount((prev) => prev + frames.length);
      return; // Don't call onFramesProp
    }
    if (isWatchingRef.current) {
      setWatchFrameCount((prev) => prev + frames.length);
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
  // This resets frame counts and calls cleanup so the UI clears its state
  const handleReconfigure = useCallback(() => {
    console.log(`[IOSessionManager:${appName}] Session reconfigured externally - clearing state`);
    // Call the same cleanup as before watch
    onBeforeWatch?.();
    // Reset frame count
    setWatchFrameCount(0);
    // Reset stream completed flag
    if (streamCompletedRef) {
      streamCompletedRef.current = false;
    }
  }, [appName, onBeforeWatch, streamCompletedRef]);

  // Handler for when session resumes to live (another app clicked Resume)
  // This clears frames so the app doesn't show old buffer frames mixed with new live frames
  const handleResuming = useCallback(() => {
    console.log(`[IOSessionManager:${appName}] Session resuming to live - clearing state`);
    // Call the same cleanup as before watch
    onBeforeWatch?.();
    // Reset frame count
    setWatchFrameCount(0);
    // Reset stream completed flag
    if (streamCompletedRef) {
      streamCompletedRef.current = false;
    }
  }, [appName, onBeforeWatch, streamCompletedRef]);

  // Handle stream-ended with auto-transition for ingest mode
  const handleStreamEndedWithIngest = useCallback(async (payload: StreamEndedPayload) => {
    console.log(`[IOSessionManager:${appName}] Stream ended, isIngesting=${isIngestingRef.current}, payload:`, payload);

    if (isIngestingRef.current && payload.buffer_available) {
      // Ingest completed with buffer available - switch to buffer replay mode
      console.log(`[IOSessionManager:${appName}] Ingest complete - switching to buffer replay mode`);

      const sessionId = ingestSessionIdRef.current;
      if (sessionId) {
        try {
          // Switch session to buffer replay mode (keeps session alive, swaps reader)
          await switchSessionToBufferReplay(sessionId, 1.0);
          console.log(`[IOSessionManager:${appName}] Session '${sessionId}' now in buffer replay mode`);
        } catch (e) {
          console.error(`[IOSessionManager:${appName}] Failed to switch to buffer replay:`, e);
          setIngestError(e instanceof Error ? e.message : String(e));
        }
      }

      setIsIngesting(false);

      // Call app's ingest complete callback
      // App should: enableBufferMode(count), load frame info for display
      if (onIngestCompleteRef.current) {
        await onIngestCompleteRef.current(payload);
      }
    } else if (isIngestingRef.current) {
      // Ingest ended without buffer (error or empty)
      console.log(`[IOSessionManager:${appName}] Ingest ended without buffer`);
      setIsIngesting(false);
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
    console.log(`[IOSessionManager:${appName}] Session destroyed externally, orphaned buffers:`, orphanedBufferIds);

    // Clear app state (frame lists, etc.)
    onBeforeWatch?.();

    // Clear all session-related state
    setMultiBusProfiles([]);
    setIsWatching(false);
    setIsIngesting(false);
    setIsDetached(false);
    setWatchFrameCount(0);
    streamCompletedRef.current = false;

    // Switch to orphaned buffer if available, otherwise clear profile
    if (orphanedBufferIds.length > 0) {
      setIoProfile(orphanedBufferIds[0]);
    } else {
      setIoProfile(null);
    }

    // Notify app
    onSessionDestroyed?.();
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
  const isRealtime = session.capabilities?.is_realtime === true;
  // Buffer mode = explicitly viewing a buffer profile (buf_N)
  // Note: Timeline sources (postgres, csv) have is_realtime=false but are NOT buffer mode -
  // they're actively streaming from database/file. Only BufferReader (buf_N) is buffer mode.
  const isBufferMode = isBufferProfileId(ioProfile);
  // Stopped with a profile selected (ready to restart)
  // For realtime sources: can restart the live stream
  // For timeline sources: can restart from the beginning
  const isStopped = !isDetached && readerState === "stopped" && ioProfile !== null && !isBufferProfileId(ioProfile);
  // Can return to live: was originally a realtime source but switched to buffer replay
  // Detected by checking if sourceProfileId is set (preserved during buffer switch)
  const canReturnToLive = !isDetached && isBufferMode && sourceProfileId !== null;
  const sessionReady = session.isReady;
  const capabilities = session.capabilities;
  const joinerCount = session.joinerCount;

  // ---- Handlers ----
  // Detach from session with a copy of the buffer
  // After detaching, the app views the copied buffer (standalone, not detached state)
  const handleDetach = useCallback(async () => {
    let bufferId = session.bufferId;

    // No buffer yet - try to create one by suspending first
    if (!bufferId && session.sessionId) {
      if (joinerCount <= 1) {
        // Sole listener: suspend to create a buffer, then copy and leave
        await session.suspend();
        // Read buffer ID from store (suspendSession sets it synchronously)
        const storeSession = useSessionStore.getState().sessions[session.sessionId];
        bufferId = storeSession?.buffer?.id ?? null;
      } else {
        // Multiple listeners: just leave, clear state
        await session.leave();
        setMultiBusProfiles([]);
        setIoProfile(null);
        setIsWatching(false);
        setIsDetached(false);
        return;
      }
    }

    if (bufferId) {
      const { copyBufferForDetach } = await import("../api/io");
      const copyName = `${ioProfileName || "detached"}-${Date.now()}`;
      const copiedBufferId = await copyBufferForDetach(bufferId, copyName);

      // Leave the session (others keep streaming)
      await session.leave();

      // Clear multi-bus state and switch to the copied buffer
      setMultiBusProfiles([]);
      setIoProfile(copiedBufferId);
      setIsWatching(false);
      setIsDetached(false);
    } else {
      // No buffer even after suspend - just leave and clear state
      await session.leave();
      setMultiBusProfiles([]);
      setIoProfile(null);
      setIsWatching(false);
      setIsDetached(false);
    }
  }, [session, ioProfileName, joinerCount, setMultiBusProfiles, setIoProfile]);

  const handleRejoin = useCallback(async () => {
    await session.rejoin();
    setIsDetached(false);
    setIsWatching(true);
  }, [session]);

  // Leave is the same as detach - just exposed separately for UI
  const handleLeave = handleDetach;

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

  const resetWatchFrameCount = useCallback(() => {
    setWatchFrameCount(0);
  }, []);

  // Start multi-bus session
  const startMultiBusSession = useCallback(async (
    profileIds: string[],
    opts: IngestOptions
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

    // Use provided session ID or generate one to avoid collisions between windows
    const sessionId = sessionIdOverride ?? (busMappings
      ? generateMultiSessionId(busMappings, profileNamesMap, emitRawBytes)
      : `s_${Math.random().toString(16).slice(2, 8)}`);

    const createOptions: CreateMultiSourceOptions = {
      sessionId,
      listenerId: appName,
      profileIds,
      busMappings,
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

    // Join the session and set up heartbeats
    await joinMultiSourceSession({
      sessionId,
      listenerId: appName,
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

  // Watch a single source: reinitialize, clear multi-bus, set profile, set speed, start watching
  const watchSingleSource = useCallback(async (
    profileId: string,
    opts: IngestOptions,
    reinitializeOptions?: Record<string, unknown>
  ) => {
    onBeforeWatch?.();

    // For recorded sources (postgres, csv), generate a unique session ID so multiple
    // apps can watch the same profile independently with separate buffers.
    // Real-time sources continue to use profile ID as session ID (shared session).
    const profile = ioProfiles.find((p) => p.id === profileId);
    const isRecorded = profile ? !isRealtimeProfile(profile) : false;
    const sessionId = isRecorded ? generateRecordedSessionId() : profileId;

    // Reinitialize with the provided options merged with any extra reinitialize options
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
      // For recorded sources, use unique session ID so multiple apps can have independent streams
      sessionIdOverride: isRecorded ? sessionId : undefined,
      ...reinitializeOptions,
    });

    // Ensure listener is ACTIVE so we receive frames
    // (connectOnly sets listener inactive, so we need to reactivate it)
    try {
      await setSessionListenerActive(sessionId, appName, true);
    } catch {
      // Ignore - may fail if session doesn't exist yet
    }

    // Clear multi-bus state when switching to a single source
    setMultiBusProfiles([]);

    // Set profile (use session ID so callbacks are registered correctly)
    // Also track the source profile ID for bookmark lookups
    setIoProfile(sessionId);
    setSourceProfileId(profileId);
    if (opts.speed !== undefined) {
      setPlaybackSpeedProp?.(opts.speed);
    }

    // Start watching
    setIsWatching(true);
    resetWatchFrameCount();
    streamCompletedRef.current = false;
  }, [session, appName, ioProfiles, onBeforeWatch, setMultiBusProfiles, setIoProfile, setPlaybackSpeedProp, resetWatchFrameCount]);

  // Watch multiple sources: start multi-bus session, set speed, start watching
  const watchMultiSource = useCallback(async (
    profileIds: string[],
    opts: IngestOptions
  ) => {
    onBeforeMultiWatch?.();

    // Use existing startMultiBusSession which handles all session creation
    await startMultiBusSession(profileIds, opts);

    // Set speed
    if (opts.speed !== undefined) {
      setPlaybackSpeedProp?.(opts.speed);
    }

    // Start watching
    setIsWatching(true);
    resetWatchFrameCount();
    streamCompletedRef.current = false;
  }, [startMultiBusSession, onBeforeMultiWatch, setPlaybackSpeedProp, resetWatchFrameCount]);

  // Stop watching: suspend session, switch to buffer replay for timeline sources
  // For realtime sources, this suspends and keeps the buffer available for later.
  // For timeline sources (postgres, csv), this switches to buffer replay mode
  // so users can step through the buffered frames.
  const stopWatch = useCallback(async () => {
    await session.suspend();

    // For timeline sources, switch to buffer replay mode
    // This enables playback controls (step/skip/seek)
    if (sourceProfileId) {
      const profile = ioProfiles.find((p) => p.id === sourceProfileId);
      if (profile && !isRealtimeProfile(profile)) {
        // Timeline source (postgres, csv) - switch to buffer replay
        // Use session.switchToBufferReplay which also updates local capabilities
        try {
          await session.switchToBufferReplay(1.0);
          console.log(`[IOSessionManager:${appName}] Switched to buffer replay mode after stop`);
        } catch (e) {
          console.error(`[IOSessionManager:${appName}] Failed to switch to buffer replay:`, e);
        }
      }
    }

    setIsWatching(false);
  }, [session, sourceProfileId, ioProfiles, appName]);

  // Suspend session: alias for stopWatch (kept for backward compatibility)
  const suspendSession = stopWatch;

  // Resume a suspended session with a fresh buffer (orphans old buffer)
  const resumeWithNewBuffer = useCallback(async () => {
    // Clear app state before resuming
    onBeforeWatch?.();

    await session.resumeFresh();
    setIsWatching(true);
    resetWatchFrameCount();
    streamCompletedRef.current = false;
  }, [session, onBeforeWatch, resetWatchFrameCount]);

  // Detach from session with a copy of the buffer
  const detachWithBufferCopy = useCallback(async () => {
    const bufferId = session.bufferId;
    if (!bufferId) {
      console.warn("[IOSessionManager] Cannot detach - no buffer available");
      return;
    }

    // Import the copy function
    const { copyBufferForDetach } = await import("../api/io");

    // Create a copy of the buffer for this app
    const copyName = `${ioProfileName}-detached-${Date.now()}`;
    const copiedBufferId = await copyBufferForDetach(bufferId, copyName);

    // Leave the session (others keep streaming)
    await session.leave();

    // Clear multi-bus state - we're now viewing a standalone buffer
    setMultiBusProfiles([]);

    // Set isDetached=false - we're viewing a buffer, not in detached state
    // This ensures the IO picker shows the buffer, not "Rejoin"
    setIsDetached(false);
    setIsWatching(false);

    // Switch to the copied buffer
    await session.reinitialize(copiedBufferId, { useBuffer: true });
  }, [session, ioProfileName, setMultiBusProfiles]);

  // Ingest a single source: fast ingest without rendering, auto-transitions to buffer reader
  // Apps join the session but frames are counted only (not rendered) until ingest completes.
  // After stream ends, session transitions to buffer reader for playback.
  const ingestSingleSource = useCallback(async (
    profileId: string,
    opts: IngestOptions
  ) => {
    // Pre-ingest cleanup
    if (onBeforeIngestStartRef.current) {
      await onBeforeIngestStartRef.current();
    }

    // Clear any previous ingest state
    setIngestError(null);
    setIngestFrameCount(0);

    // Generate unique session ID for this ingest
    const sessionId = generateIngestSessionId();
    console.log(`[IOSessionManager:${appName}] Starting ingest with session ID: ${sessionId}`);

    // IMPORTANT: Set refs SYNCHRONOUSLY before reinitialize
    // With speed=0, the stream can complete DURING reinitialize, before React re-renders.
    // The stream-ended handler checks these refs, so they must be set first.
    isIngestingRef.current = true;
    ingestSessionIdRef.current = sessionId;

    try {
      // Reinitialize with speed=0 (max speed) for fast ingestion
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

      // Clear multi-bus state when ingesting from a single source
      setMultiBusProfiles([]);

      // Update state - set profile to session ID so callbacks work
      setIoProfile(sessionId);
      setSourceProfileId(profileId);
      setIngestSessionId(sessionId);

      // Set ingesting mode - handleFrames will count but not deliver frames
      setIsIngesting(true);
      setIsWatching(false);
      streamCompletedRef.current = false;

      console.log(`[IOSessionManager:${appName}] Ingest started for session: ${sessionId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[IOSessionManager:${appName}] Failed to start ingest:`, msg);
      // Reset refs on error
      isIngestingRef.current = false;
      ingestSessionIdRef.current = null;
      setIngestError(msg);
      setIsIngesting(false);
    }
  }, [session, appName, setMultiBusProfiles, setIoProfile, setSourceProfileId, streamCompletedRef]);

  // Ingest multiple sources: fast multi-bus ingest without rendering
  const ingestMultiSource = useCallback(async (
    profileIds: string[],
    opts: IngestOptions
  ) => {
    // Pre-ingest cleanup
    if (onBeforeIngestStartRef.current) {
      await onBeforeIngestStartRef.current();
    }

    // Clear any previous ingest state
    setIngestError(null);
    setIngestFrameCount(0);

    // Generate session ID for multi-source ingest
    const sessionId = generateIngestSessionId();

    // IMPORTANT: Set refs SYNCHRONOUSLY before starting session
    // With speed=0, the stream can complete DURING session creation.
    isIngestingRef.current = true;
    ingestSessionIdRef.current = sessionId;

    try {
      // Start multi-bus session with our session ID
      // Override speed to 0 for max speed ingestion
      await startMultiBusSession(profileIds, {
        ...opts,
        speed: 0, // Max speed - no pacing
        sessionIdOverride: sessionId,
      });

      // Store the session ID
      setIngestSessionId(sessionId);

      // Set ingesting mode - handleFrames will count but not deliver frames
      setIsIngesting(true);
      setIsWatching(false);
      streamCompletedRef.current = false;

      console.log(`[IOSessionManager:${appName}] Multi-source ingest started with session: ${sessionId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[IOSessionManager:${appName}] Failed to start multi-source ingest:`, msg);
      // Reset refs on error
      isIngestingRef.current = false;
      ingestSessionIdRef.current = null;
      setIngestError(msg);
      setIsIngesting(false);
    }
  }, [appName, startMultiBusSession, streamCompletedRef]);

  // Stop ingest: stop session, clear ingest state
  const stopIngest = useCallback(async () => {
    console.log(`[IOSessionManager:${appName}] Stopping ingest`);
    await session.stop();
    // Note: handleStreamEndedWithIngest will handle the state cleanup and transition
  }, [appName, session]);

  // Clear ingest error
  const clearIngestError = useCallback(() => {
    setIngestError(null);
  }, []);

  // Connect only: create session without streaming (for Query app)
  // Creates/joins the session with skipAutoStart to prevent auto-starting playback sources.
  // Also marks our listener as INACTIVE so we don't receive frames even if session is running.
  // This is useful when:
  // - Postgres session is new: session stays stopped, Query won't receive frames
  // - Postgres session is shared (Discovery streaming): Query joins but won't receive frames
  const connectOnly = useCallback(async (
    profileId: string,
    opts?: IngestOptions
  ) => {
    await session.reinitialize(profileId, {
      startTime: opts?.startTime,
      endTime: opts?.endTime,
      speed: opts?.speed,
      limit: opts?.maxFrames,
      skipAutoStart: true, // Don't auto-start - Query connects but doesn't stream
    });

    // Mark our listener as INACTIVE so we don't receive frames
    // This is the key difference from watchSingleSource - we connect but don't stream
    try {
      await setSessionListenerActive(profileId, appName, false);
    } catch {
      // Ignore - listener may not be fully registered yet
    }

    // Clear multi-bus state when connecting to a single source
    setMultiBusProfiles([]);

    // Set profile but don't start watching
    setIoProfile(profileId);
    if (opts?.speed !== undefined) {
      setPlaybackSpeedProp?.(opts.speed);
    }

    // Note: Do NOT set isWatching - session is connected but not streaming to us
  }, [session, appName, setMultiBusProfiles, setIoProfile, setPlaybackSpeedProp]);

  // Jump to a bookmark: stop if streaming, cleanup, reinitialize with bookmark time range
  const jumpToBookmark = useCallback(
    async (
      bookmark: TimeRangeFavorite,
      opts?: Omit<IngestOptions, "startTime" | "endTime" | "maxFrames">
    ) => {
      // Convert bookmark times to UTC
      const startUtc = localToUtc(bookmark.startTime);
      const endUtc = localToUtc(bookmark.endTime);

      if (!startUtc) {
        console.warn("[IOSessionManager:jumpToBookmark] No valid start time in bookmark");
        return;
      }

      // Determine target profile (bookmark's profile or current)
      const targetProfileId = bookmark.profileId || sourceProfileId || ioProfile;
      if (!targetProfileId) {
        console.warn("[IOSessionManager:jumpToBookmark] No profile available");
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

      console.log(`[IOSessionManager:jumpToBookmark] Jumping to bookmark "${bookmark.name}" (session: ${sessionId}, profile: ${targetProfileId}, sameProfile: ${isSameProfile}, isRecorded: ${isRecorded})`);

      // Step 1: Run cleanup callback (same as onBeforeWatch)
      onBeforeWatch?.();

      // Step 2: Clear multi-bus state
      setMultiBusProfiles([]);

      // Step 3: Either reconfigure existing session or reinitialize
      if (isSameProfile && ioProfile && isRecorded) {
        // Same profile, recorded source - use reconfigure to keep session alive
        // This stops the stream, orphans old buffer, creates new buffer, and restarts
        // Other apps joined to this session stay connected
        console.log("[IOSessionManager:jumpToBookmark] Using reconfigure (same profile, session stays alive)");
        await reconfigureReaderSession(sessionId, startUtc, endUtc || undefined);
      } else {
        // Different profile or realtime source - full reinitialize
        console.log("[IOSessionManager:jumpToBookmark] Using reinitialize (different profile or realtime)");

        // Stop current stream if watching
        if (isWatching) {
          console.log("[IOSessionManager:jumpToBookmark] Stopping current watch...");
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

      // Step 4: Update manager state (use session ID so callbacks are registered correctly)
      setIoProfile(sessionId);
      setSourceProfileId(targetProfileId);
      if (opts?.speed !== undefined) {
        setPlaybackSpeedProp?.(opts.speed);
      }

      // Step 5: Mark as watching and reset state
      setIsWatching(true);
      resetWatchFrameCount();
      streamCompletedRef.current = false;

      // Step 7: Notify app of reconfiguration
      onSessionReconfigured?.({
        reason: "bookmark",
        bookmark,
        startTime: startUtc,
        endTime: endUtc ?? undefined,
      });

      // Step 8: Mark bookmark as used
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
    if (profileId && !isBufferProfileId(profileId)) {
      const profile = ioProfiles.find((p) => p.id === profileId);
      if (profile?.connection?.default_speed) {
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

  // ---- Clear Watch State on Stream End ----
  useEffect(() => {
    if (!isStreaming && isWatching) {
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
    isBufferMode,
    sessionReady,
    capabilities,
    joinerCount,
    playbackPosition: session.playbackPosition,
    currentTimeUs: session.currentTimeUs,
    currentFrameIndex: session.currentFrameIndex,

    // Detach/Rejoin/Leave/Destroy
    isDetached,
    handleDetach,
    handleRejoin,
    handleLeave,
    handleDestroy,

    // Watch State
    watchFrameCount,
    resetWatchFrameCount,
    isWatching,
    setIsWatching,

    // Ingest State (unified with session)
    isIngesting,
    ingestProfileId: ingestSessionId,
    ingestFrameCount,
    ingestError,
    // Legacy startIngest wrapper for backwards compatibility
    startIngest: async (params) => {
      const { profileId, ...opts } = params;
      await ingestSingleSource(profileId, {
        maxFrames: opts.maxFrames,
        startTime: opts.startTime,
        endTime: opts.endTime,
        frameIdStartByte: opts.frameIdStartByte,
        frameIdBytes: opts.frameIdBytes,
        sourceAddressStartByte: opts.sourceAddressStartByte,
        sourceAddressBytes: opts.sourceAddressBytes,
        sourceAddressEndianness: opts.sourceAddressBigEndian ? "big" : "little",
        minFrameLength: opts.minFrameLength,
      });
    },
    stopIngest,
    clearIngestError,
    // New ingest methods
    ingestSingleSource,
    ingestMultiSource,

    // Multi-Bus Handlers
    startMultiBusSession,
    joinExistingSession,

    // Session Switching Methods
    watchSingleSource,
    watchMultiSource,
    stopWatch,
    suspendSession,
    resumeWithNewBuffer,
    detachWithBufferCopy,
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
