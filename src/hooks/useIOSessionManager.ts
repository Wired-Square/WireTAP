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
  type CreateMultiSourceOptions,
  type PerInterfaceFramingConfig,
} from "../stores/sessionStore";
import type { BusMapping, PlaybackPosition, RawBytesPayload } from "../api/io";
import type { IOProfile } from "./useSettings";
import type { FrameMessage } from "../stores/discoveryStore";
import type { StreamEndedPayload, IOCapabilities } from "../api/io";

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
}

/**
 * Buffer profile ID constant (legacy).
 * DEPRECATED: Use isBufferProfileId() to detect buffer IDs.
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
    setMultiBusMode,
    setMultiBusProfiles,
    setSourceProfileId,
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

    // Update state
    setMultiBusMode(true);
    setMultiBusProfiles(profileIds);
    setMultiSessionId(sessionId);
    setIoProfile(sessionId);
    setIsDetached(false);
  }, [appName, profileNamesMap, setMultiBusMode, setMultiBusProfiles, setIoProfile]);

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
      ...reinitializeOptions,
    });

    // Clear multi-bus state when switching to a single source
    setMultiBusMode(false);
    setMultiBusProfiles([]);

    // Set profile and speed
    setIoProfile(profileId);
    if (opts.speed !== undefined) {
      setPlaybackSpeedProp?.(opts.speed);
    }

    // Start watching
    setIsWatching(true);
    resetWatchFrameCount();
    streamCompletedRef.current = false;
  }, [session, onBeforeWatch, setMultiBusMode, setMultiBusProfiles, setIoProfile, setPlaybackSpeedProp, resetWatchFrameCount]);

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
    }
  }, [isStreaming, isWatching]);

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
    selectProfile,
    selectMultipleProfiles,
    joinSession,
    skipReader,
    streamCompletedRef,
  };
}
