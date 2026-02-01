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
import { useIngestSession, type StreamEndedPayload as IngestStreamEndedPayload } from "./useIngestSession";
import {
  createAndStartMultiSourceSession,
  joinMultiSourceSession,
  useMultiBusState,
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
import type { FrameMessage } from "../stores/discoveryStore";
import { setSessionListenerActive, reconfigureReaderSession, type StreamEndedPayload, type IOCapabilities } from "../api/io";
import { markFavoriteUsed, type TimeRangeFavorite } from "../utils/favorites";
import { localToUtc } from "../utils/timeFormat";
import { isRealtimeProfile } from "../dialogs/io-reader-picker/utils";

/**
 * Generate a unique session ID for recorded sources.
 * Pattern: {sourceType}_{shortId}
 * Examples: postgres_a7f3c9, csv_b9c2d4
 */
function generateRecordedSessionId(profileKind: string | undefined): string {
  const sourceType = profileKind?.replace(/[_-]/g, "") || "session";
  const shortId = Math.random().toString(16).slice(2, 8);
  return `${sourceType}_${shortId}`;
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
  /** Whether multi-bus mode is active */
  multiBusMode: boolean;
  /** Profiles in the multi-bus session */
  multiBusProfiles: string[];
  /** Set multi-bus mode */
  setMultiBusMode: (enabled: boolean) => void;
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
  /** Whether stopped with a profile selected */
  isStopped: boolean;
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

  // ---- Detach/Rejoin State ----
  /** Whether detached from session */
  isDetached: boolean;
  /** Detach from session without stopping */
  handleDetach: () => Promise<void>;
  /** Rejoin after detaching */
  handleRejoin: () => Promise<void>;

  // ---- Watch State (for top bar display) ----
  /** Frame count during watch mode */
  watchFrameCount: number;
  /** Reset watch frame count */
  resetWatchFrameCount: () => void;
  /** Whether currently watching (streaming with real-time display) */
  isWatching: boolean;
  /** Set watching state */
  setIsWatching: (watching: boolean) => void;

  // ---- Ingest State (if enableIngest is true) ----
  /** Whether ingesting */
  isIngesting: boolean;
  /** Ingest profile ID */
  ingestProfileId: string | null;
  /** Ingest frame count */
  ingestFrameCount: number;
  /** Ingest error */
  ingestError: string | null;
  /** Start ingest */
  startIngest: (options: {
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
 * Pattern: {protocol}_{shortId}
 * Examples: can_a7f3c9, serial_b9c2d4
 *
 * Profile names are passed to the backend separately for logging purposes.
 */
function generateMultiSessionId(
  busMappings: Map<string, BusMapping[]>,
  profileNames: Map<string, string>
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

  // Build session ID: protocol_shortId
  return `${protocol || "session"}_${shortId}`;
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
    enableIngest = false,
    onBeforeIngestStart,
    onIngestComplete,
    requireFrames,
    onFrames: onFramesProp,
    onBytes,
    onError,
    onTimeUpdate,
    onStreamEnded,
    onStreamComplete,
    onSpeedChange,
    setPlaybackSpeed: setPlaybackSpeedProp,
    onBeforeWatch,
    onBeforeMultiWatch,
    streamCompletedRef: streamCompletedRefProp,
    onSessionReconfigured,
  } = options;

  // ---- Profile State ----
  // Use store if provided, otherwise local state
  const [localProfile, setLocalProfile] = useState<string | null>(initialProfileId);
  const ioProfile = store?.ioProfile ?? localProfile;
  const setIoProfile = store?.setIoProfile ?? setLocalProfile;

  // ---- Multi-Bus State ----
  const {
    multiBusMode,
    multiBusProfiles,
    sourceProfileId,
    outputBusToSource,
    setMultiBusMode,
    setMultiBusProfiles,
    setSourceProfileId,
    setOutputBusToSource,
  } = useMultiBusState();

  // ---- Detach/Watch State ----
  const [isDetached, setIsDetached] = useState(false);
  const [watchFrameCount, setWatchFrameCount] = useState(0);
  const [isWatching, setIsWatching] = useState(false);

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
  const effectiveSessionId = multiBusMode ? (multiSessionId ?? undefined) : (ioProfile ?? undefined);

  // Profile name for display
  const ioProfileName = useMemo(() => {
    if (multiBusMode) {
      return `Multi-Bus (${multiBusProfiles.length} sources)`;
    }
    if (!ioProfile) return undefined;
    const profile = ioProfiles.find((p) => p.id === ioProfile);
    return profile?.name;
  }, [ioProfile, multiBusMode, multiBusProfiles.length, ioProfiles]);

  // Profile names map for multi-bus
  const profileNamesMap = useMemo(() => {
    return new Map(ioProfiles.map((p) => [p.id, p.name]));
  }, [ioProfiles]);

  // ---- Watch Frame Counting ----
  const isWatchingRef = useRef(isWatching);
  useEffect(() => {
    isWatchingRef.current = isWatching;
  }, [isWatching]);

  // Wrap onFrames to count watch frames
  const handleFrames = useCallback((frames: FrameMessage[]) => {
    if (isWatchingRef.current) {
      setWatchFrameCount((prev) => prev + frames.length);
    }
    onFramesProp?.(frames);
  }, [onFramesProp]);

  // ---- Ingest Session ----
  const ingestCompleteRef = useRef<((payload: IngestStreamEndedPayload) => Promise<void>) | undefined>(undefined);

  const ingestSession = useIngestSession(
    enableIngest
      ? {
          onComplete: async (payload) => {
            if (ingestCompleteRef.current) {
              await ingestCompleteRef.current(payload);
            }
          },
          onBeforeStart: onBeforeIngestStart,
        }
      : { onComplete: async () => {} } // Disabled (async to match type)
  );

  // Set up ingest complete ref
  ingestCompleteRef.current = onIngestComplete;

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

  const sessionOptions: UseIOSessionOptions = {
    appName,
    sessionId: effectiveSessionId,
    profileName: ioProfileName,
    requireFrames,
    onFrames: handleFrames,
    onBytes,
    onError,
    onTimeUpdate,
    onStreamEnded,
    onStreamComplete,
    onSpeedChange,
    onReconfigure: handleReconfigure,
  };

  const session = useIOSession(sessionOptions);

  // ---- Derived State ----
  const readerState = session.state;
  const isStreaming = !isDetached && (readerState === "running" || readerState === "paused");
  const isPaused = readerState === "paused";
  const isStopped = !isDetached && readerState === "stopped" && ioProfile !== null && !isBufferProfileId(ioProfile);
  const isRealtime = session.capabilities?.is_realtime === true;
  const isBufferMode = isBufferProfileId(ioProfile);
  const sessionReady = session.isReady;
  const capabilities = session.capabilities;
  const joinerCount = session.joinerCount;

  // ---- Handlers ----
  const handleDetach = useCallback(async () => {
    await session.leave();
    setIsDetached(true);
    setIsWatching(false);
  }, [session]);

  const handleRejoin = useCallback(async () => {
    await session.rejoin();
    setIsDetached(false);
    setIsWatching(true);
  }, [session]);

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
    } = opts;

    // Generate unique session ID to avoid collisions between windows
    const sessionId = busMappings
      ? generateMultiSessionId(busMappings, profileNamesMap)
      : `session_${Math.random().toString(16).slice(2, 8)}`;

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

    // Update state
    setMultiBusMode(true);
    setMultiBusProfiles(profileIds);
    setOutputBusToSource(busToSource);
    setMultiSessionId(sessionId);
    setIoProfile(sessionId);
    setIsDetached(false);
  }, [appName, profileNamesMap, setMultiBusMode, setMultiBusProfiles, setOutputBusToSource, setIoProfile]);

  // Join existing multi-source session
  const joinExistingSession = useCallback(async (
    sessionId: string,
    sourceProfileIds?: string[]
  ) => {
    await joinMultiSourceSession({
      sessionId,
      listenerId: appName,
      sourceProfileIds,
    });

    // Update state
    setIoProfile(sessionId);
    setMultiBusProfiles(sourceProfileIds || []);
    setMultiBusMode(false); // Use single-session mode when joining
    setIsDetached(false);
    await session.rejoin(sessionId);
  }, [appName, session, setIoProfile, setMultiBusProfiles, setMultiBusMode]);

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
    const sessionId = isRecorded ? generateRecordedSessionId(profile?.kind) : profileId;

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
    setMultiBusMode(false);
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
  }, [session, appName, ioProfiles, onBeforeWatch, setMultiBusMode, setMultiBusProfiles, setIoProfile, setPlaybackSpeedProp, resetWatchFrameCount]);

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

  // Stop watching: stop session, clear watch state
  const stopWatch = useCallback(async () => {
    await session.stop();
    setIsWatching(false);
  }, [session]);

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
    setMultiBusMode(false);
    setMultiBusProfiles([]);

    // Set profile but don't start watching
    setIoProfile(profileId);
    if (opts?.speed !== undefined) {
      setPlaybackSpeedProp?.(opts.speed);
    }

    // Note: Do NOT set isWatching - session is connected but not streaming to us
  }, [session, appName, setMultiBusMode, setMultiBusProfiles, setIoProfile, setPlaybackSpeedProp]);

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
        sessionId = generateRecordedSessionId(targetProfile?.kind);
      } else {
        // Realtime source - use profile ID
        sessionId = targetProfileId;
      }

      console.log(`[IOSessionManager:jumpToBookmark] Jumping to bookmark "${bookmark.name}" (session: ${sessionId}, profile: ${targetProfileId}, sameProfile: ${isSameProfile}, isRecorded: ${isRecorded})`);

      // Step 1: Run cleanup callback (same as onBeforeWatch)
      onBeforeWatch?.();

      // Step 2: Clear multi-bus state
      setMultiBusMode(false);
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
      setMultiBusMode,
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
    setMultiBusMode(false);
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
  }, [setMultiBusMode, setMultiBusProfiles, setIoProfile, ioProfiles, setPlaybackSpeedProp]);

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
    setMultiBusMode(false);
    setMultiBusProfiles([]);
    // Leave session if currently streaming or paused
    const readerState = session.state;
    if (readerState === "running" || readerState === "paused") {
      await session.leave();
      setIsWatching(false);
    }
    setIoProfile(null);
  }, [setMultiBusMode, setMultiBusProfiles, session, setIoProfile]);

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
    multiBusMode,
    multiBusProfiles,
    setMultiBusMode,
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
    isRealtime,
    isBufferMode,
    sessionReady,
    capabilities,
    joinerCount,

    // Detach/Rejoin
    isDetached,
    handleDetach,
    handleRejoin,

    // Watch State
    watchFrameCount,
    resetWatchFrameCount,
    isWatching,
    setIsWatching,

    // Ingest State
    isIngesting: enableIngest ? ingestSession.isIngesting : false,
    ingestProfileId: enableIngest ? ingestSession.ingestProfileId : null,
    ingestFrameCount: enableIngest ? ingestSession.ingestFrameCount : 0,
    ingestError: enableIngest ? ingestSession.ingestError : null,
    startIngest: enableIngest ? ingestSession.startIngest : async () => {},
    stopIngest: enableIngest ? ingestSession.stopIngest : async () => {},
    clearIngestError: enableIngest ? ingestSession.clearIngestError : () => {},

    // Multi-Bus Handlers
    startMultiBusSession,
    joinExistingSession,

    // Session Switching Methods
    watchSingleSource,
    watchMultiSource,
    stopWatch,
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
