// ui/src/dialogs/IoReaderPickerDialog.tsx

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { X } from "lucide-react";
import { iconLg } from "../styles/spacing";
import { emit, listen } from "@tauri-apps/api/event";
import Dialog from "../components/Dialog";
import {
  cardElevated,
  h3,
  borderDefault,
  paddingCard,
  hoverLight,
  roundedDefault,
} from "../styles";
import { getReaderProtocols, type IOProfile } from "../hooks/useSettings";
import { useSessionStore } from "../stores/sessionStore";
import { pickCsvToOpen } from "../api/dialogs";
import {
  importCsvToBuffer,
  listOrphanedBuffers,
  deleteBuffer,
  setActiveBuffer,
  clearBuffer,
  type BufferMetadata,
} from "../api/buffer";
import { WINDOW_EVENTS, type BufferChangedPayload } from "../events/registry";
import {
  createIOSession,
  startReaderSession,
  stopReaderSession,
  destroyReaderSession,
  unregisterSessionListener,
  updateReaderSpeed,
  probeDevice,
  createDefaultBusMappings,
  listActiveSessions,
  getProfilesUsage,
  type StreamEndedPayload,
  type GvretDeviceInfo,
  type BusMapping,
  type ActiveSessionInfo,
  type DeviceProbeResult,
  type Protocol,
  type ProfileUsageInfo,
} from '../api/io';
import { getAllFavorites, type TimeRangeFavorite } from "../utils/favorites";
import type { TimeBounds } from "../components/TimeBoundsInput";

// Import extracted components
import { BufferList } from "./io-reader-picker";
import { ReaderList } from "./io-reader-picker";
import { IngestOptions } from "./io-reader-picker";
import { FramingOptions, FilterOptions } from "./io-reader-picker";
import { ActionButtons } from "./io-reader-picker";
import { IngestStatus } from "./io-reader-picker";
import GvretBusConfig from "./io-reader-picker/GvretBusConfig";
import SingleBusConfig from "./io-reader-picker/SingleBusConfig";
import {
  localToIsoWithOffset,
  CSV_EXTERNAL_ID,
  generateIngestSessionId,
  isRealtimeProfile,
  validateProfileSelection,
} from "./io-reader-picker";
import { isBufferProfileId } from "../hooks/useIOSessionManager";
import type { FramingConfig, InterfaceFramingConfig } from "./io-reader-picker";

// Re-export constants for backward compatibility
export { BUFFER_PROFILE_ID, INGEST_SESSION_ID } from "./io-reader-picker";

/** Options passed when starting ingest */
export interface IngestOptions {
  /** Playback speed (0 = no limit, 1 = realtime, etc.) */
  speed: number;
  /** Start time in ISO-8601 format (for recorded sources) */
  startTime?: string;
  /** End time in ISO-8601 format (for recorded sources) */
  endTime?: string;
  /** Maximum number of frames to read (for all sources) */
  maxFrames?: number;
  /** Frame ID extraction: start byte position (0-indexed) - for serial sources */
  frameIdStartByte?: number;
  /** Frame ID extraction: number of bytes (1 or 2) - for serial sources */
  frameIdBytes?: number;
  /** Source address extraction: start byte position (0-indexed) - for serial sources */
  sourceAddressStartByte?: number;
  /** Source address extraction: number of bytes (1 or 2) - for serial sources */
  sourceAddressBytes?: number;
  /** Source address extraction: byte order - for serial sources */
  sourceAddressEndianness?: "big" | "little";
  /** Minimum frame length to accept - for serial sources (default: 4) */
  minFrameLength?: number;
  /** Framing encoding for serial sources */
  framingEncoding?: "slip" | "modbus_rtu" | "delimiter" | "raw";
  /** Delimiter bytes for delimiter-based framing */
  delimiter?: number[];
  /** Maximum frame length for delimiter-based framing */
  maxFrameLength?: number;
  /** Also emit raw bytes in addition to frames */
  emitRawBytes?: boolean;
  /** Bus mappings per profile (for multi-bus mode) - map from profile ID to bus mappings */
  busMappings?: Map<string, BusMapping[]>;
  /** Bus number override for single-bus devices (0-7) */
  busOverride?: number;
  /** Per-interface framing config (for serial profiles in multi-bus mode) - map from profile ID to framing config */
  perInterfaceFraming?: Map<string, InterfaceFramingConfig>;
}

// Stable empty array to avoid re-renders when selectedIds is not provided
const EMPTY_SELECTED_IDS: string[] = [];

type Props = {
  /** Dialog mode: "streaming" shows Watch/Ingest, "connect" shows just Connect */
  mode?: "streaming" | "connect";
  isOpen: boolean;
  onClose: () => void;
  ioProfiles: IOProfile[];
  selectedId: string | null;
  /** Selected profile IDs when in multi-select mode */
  selectedIds?: string[];
  defaultId?: string | null;
  onSelect: (id: string | null) => void;
  /** Called when multiple profiles are selected in multi-bus mode */
  onSelectMultiple?: (ids: string[]) => void;
  /** Called when CSV is imported - passes the buffer metadata */
  onImport?: (metadata: BufferMetadata) => void;
  /** Called when buffer is confirmed with framing config (for applying framing to bytes buffer) */
  onBufferFramingConfig?: (config: FramingConfig | null) => void;
  /** Current buffer metadata (if any) */
  bufferMetadata?: BufferMetadata | null;
  /** Default directory for file picker */
  defaultDir?: string;
  /** External ingest state - when provided, dialog uses external state instead of internal */
  isIngesting?: boolean;
  /** Profile ID currently being ingested */
  ingestProfileId?: string | null;
  /** Current frame count during ingest */
  ingestFrameCount?: number;
  /** Current ingest speed */
  ingestSpeed?: number;
  /** Called when ingest speed changes */
  onIngestSpeedChange?: (speed: number) => void;
  /** Called to start ingest/watch */
  onStartIngest?: (profileId: string, closeDialog: boolean, options: IngestOptions) => void;
  /** Called to start ingest/watch with multiple profiles (multi-bus mode) */
  onStartMultiIngest?: (profileIds: string[], closeDialog: boolean, options: IngestOptions) => void;
  /** Called to stop ingest */
  onStopIngest?: () => void;
  /** Error message during ingest */
  ingestError?: string | null;
  /** Called when user wants to join an existing streaming session.
   * For multi-source sessions, sourceProfileIds will contain the individual source profile IDs.
   */
  onJoinSession?: (sessionId: string, sourceProfileIds?: string[]) => void;
  /** Hide buffers section (for transmit-only mode) */
  hideBuffers?: boolean;
  /** Enable multi-select mode for real-time profiles */
  allowMultiSelect?: boolean;
  /** Map of profile ID to disabled status with reason (for transmit mode) */
  disabledProfiles?: Map<string, { canTransmit: boolean; reason?: string }>;
  /** Called when user wants to continue without selecting a reader */
  onSkip?: () => void;
  /** Listener ID for this app (e.g., "discovery", "decoder") - required for Leave button */
  listenerId?: string;
  /** Called when user clicks Connect in connect mode (creates session without streaming) */
  onConnect?: (profileId: string) => void;
};

export default function IoReaderPickerDialog({
  mode = "streaming",
  isOpen,
  onClose,
  ioProfiles,
  selectedId,
  selectedIds: selectedIdsProp,
  defaultId,
  onSelect,
  onSelectMultiple,
  onImport,
  onBufferFramingConfig,
  bufferMetadata: _bufferMetadata, // Deprecated - dialog now fetches buffers directly
  defaultDir,
  // External ingest state (optional - if provided, dialog uses external state)
  isIngesting: externalIsIngesting,
  ingestProfileId: externalIngestProfileId,
  ingestFrameCount: externalIngestFrameCount,
  ingestSpeed: externalIngestSpeed,
  onIngestSpeedChange,
  onStartIngest,
  onStartMultiIngest,
  onStopIngest,
  ingestError: externalIngestError,
  onJoinSession,
  hideBuffers = false,
  allowMultiSelect = false,
  disabledProfiles,
  onSkip,
  listenerId,
  onConnect,
}: Props) {
  // Use stable empty array when selectedIds is not provided (avoids re-renders)
  const selectedIds = selectedIdsProp ?? EMPTY_SELECTED_IDS;

  // Get session helpers from session store
  const isProfileInUse = useSessionStore((s) => s.isProfileInUse);
  const getSessionForProfile = useSessionStore((s) => s.getSessionForProfile);
  const startSession = useSessionStore((s) => s.startSession);

  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Multi-buffer state
  const [buffers, setBuffers] = useState<BufferMetadata[]>([]);
  const [selectedBufferId, setSelectedBufferId] = useState<string | null>(null);

  // Internal ingest state (used when external state not provided)
  const [internalIsIngesting, setInternalIsIngesting] = useState(false);
  const [internalIngestProfileId, setInternalIngestProfileId] = useState<string | null>(null);
  const [internalIngestFrameCount, setInternalIngestFrameCount] = useState(0);
  const [internalIngestError, setInternalIngestError] = useState<string | null>(null);
  const internalIngestSessionIdRef = useRef<string | null>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);

  // Currently checked IO reader (for single-select / non-multi-source-capable profiles)
  const [checkedReaderId, setCheckedReaderId] = useState<string | null>(null);

  // Multi-bus selection (for multi-source-capable profiles like CAN interfaces)
  // Multi-bus mode is implicit when checkedReaderIds.length > 1
  const [checkedReaderIds, setCheckedReaderIds] = useState<string[]>([]);

  // Validation error for incompatible profile selection
  const [validationError, setValidationError] = useState<string | null>(null);

  // Time bounds state for recorded sources (combined start/end/maxFrames/timezone)
  const [timeBounds, setTimeBounds] = useState<TimeBounds>({
    startTime: "",
    endTime: "",
    maxFrames: undefined,
    timezoneMode: "local",
  });
  const [bookmarks, setBookmarks] = useState<TimeRangeFavorite[]>([]);
  const [selectedSpeed, setSelectedSpeed] = useState(1); // Default to 1x realtime with pacing

  // Framing configuration for serial sources
  const [framingConfig, setFramingConfig] = useState<FramingConfig | null>(null);
  // Filter configuration for serial sources
  const [minFrameLength, setMinFrameLength] = useState(0);

  // Multi-bus mode - per-profile maps for device probing and configuration
  const [deviceProbeResultMap, setDeviceProbeResultMap] = useState<Map<string, DeviceProbeResult>>(new Map());
  const [deviceProbeLoadingMap, setDeviceProbeLoadingMap] = useState<Map<string, boolean>>(new Map());
  const [gvretBusConfigMap, setGvretBusConfigMap] = useState<Map<string, BusMapping[]>>(new Map());
  const [singleBusOverrideMap, setSingleBusOverrideMap] = useState<Map<string, number>>(new Map());
  // Per-profile framing config (for serial profiles in multi-bus mode)
  const [framingConfigMap, setFramingConfigMap] = useState<Map<string, InterfaceFramingConfig>>(new Map());
  // Track which profiles have been probed to avoid duplicate probes (refs don't trigger re-renders)
  const probedProfilesRef = useRef<Set<string>>(new Set());

  // Active multi-source sessions (for sharing between apps)
  const [activeMultiSourceSessions, setActiveMultiSourceSessions] = useState<ActiveSessionInfo[]>([]);

  // Profile usage info - which sessions are using each profile
  const [profileUsage, setProfileUsage] = useState<Map<string, ProfileUsageInfo>>(new Map());

  // Use external state if provided, otherwise use internal state
  const useExternalState = onStartIngest !== undefined;
  const isIngesting = useExternalState ? (externalIsIngesting ?? false) : internalIsIngesting;
  const ingestProfileId = useExternalState ? (externalIngestProfileId ?? null) : internalIngestProfileId;
  const ingestFrameCount = useExternalState ? (externalIngestFrameCount ?? 0) : internalIngestFrameCount;
  const ingestError = useExternalState ? (externalIngestError ?? null) : internalIngestError;

  // All profiles are read profiles now (mode field removed)
  const readProfiles = ioProfiles;

  // Get the checked profile object (null for CSV external)
  const checkedProfile = useMemo(() => {
    if (!checkedReaderId || checkedReaderId === CSV_EXTERNAL_ID) return null;
    return readProfiles.find((p) => p.id === checkedReaderId) || null;
  }, [checkedReaderId, readProfiles]);

  // Is the checked profile a real-time source?
  const isCheckedRealtime = checkedProfile ? isRealtimeProfile(checkedProfile) : false;

  // Is the checked reader an active multi-source session?
  const checkedMultiSourceSession = useMemo(() => {
    if (!checkedReaderId) return null;
    return activeMultiSourceSessions.find((s) => s.sessionId === checkedReaderId) || null;
  }, [checkedReaderId, activeMultiSourceSessions]);

  // Is the checked selection an active session that can be joined?
  // This is ONLY true when the user explicitly selects an Active Session from the list.
  // For profiles (IO Sources), being "in use" is informational only - users can always
  // start new sessions. The Join button only appears for explicitly selected sessions.
  const isCheckedProfileLive = checkedMultiSourceSession !== null;

  // Get the session for the checked profile (if any) to check its state
  const checkedProfileSession = checkedReaderId ? getSessionForProfile(checkedReaderId) : undefined;
  const isCheckedProfileStopped = checkedProfileSession?.ioState === "stopped";

  // Find if there's a live multi-source session for the selected profiles (multi-bus mode)
  const liveMultiSourceSession = useMemo(() => {
    if (checkedReaderIds.length === 0) return null;
    // Find a session whose source profiles match our selection
    return activeMultiSourceSessions.find((session) => {
      const sessionProfileIds = session.multiSourceConfigs?.map((c) => c.profileId) || [];
      // Check if selected profiles are a subset of or match the session's profiles
      return checkedReaderIds.every((id) => sessionProfileIds.includes(id));
    }) || null;
  }, [checkedReaderIds, activeMultiSourceSessions]);

  const isMultiSourceLive = liveMultiSourceSession !== null;

  // Load bookmarks and buffers when dialog opens
  useEffect(() => {
    if (isOpen) {
      getAllFavorites().then(setBookmarks).catch(console.error);
      // Load all buffers from the registry and initialize selected buffer
      listOrphanedBuffers().then((loadedBuffers) => {
        setBuffers(loadedBuffers);
        // If a specific buffer is selected (e.g., "buffer_1"), use that
        // Otherwise if legacy buffer ID is selected, use the most recent buffer
        if (isBufferProfileId(selectedId) && loadedBuffers.length > 0) {
          // Check if selectedId matches a specific buffer (e.g., "buffer_1")
          const matchingBuffer = loadedBuffers.find(b => b.id === selectedId);
          if (matchingBuffer) {
            setSelectedBufferId(matchingBuffer.id);
          } else {
            // Legacy buffer ID - fall back to most recent buffer
            const sorted = [...loadedBuffers].sort((a, b) => b.created_at - a.created_at);
            setSelectedBufferId(sorted[0].id);
          }
        } else {
          setSelectedBufferId(null);
        }
      }).catch(console.error);
      // Reset options when dialog opens
      setTimeBounds({
        startTime: "",
        endTime: "",
        maxFrames: undefined,
        timezoneMode: "local",
      });
      // Speed 0 means unlimited (ingest mode) - not valid for Watch, so default to 1x
      setSelectedSpeed(externalIngestSpeed && externalIngestSpeed > 0 ? externalIngestSpeed : 1);
      setFramingConfig(null);
      // If currently ingesting, pre-select that profile; otherwise use currently selected profile
      // But don't pre-select buffer profile as checkedReaderId (it's shown separately)
      const initialReaderId = ingestProfileId ?? (isBufferProfileId(selectedId) ? null : selectedId);
      setCheckedReaderId(initialReaderId);
      setImportError(null);

      // Initialize multi-bus selection state
      if (selectedIds.length > 0) {
        setCheckedReaderIds(selectedIds);
        setCheckedReaderId(null);
      } else {
        setCheckedReaderIds([]);
      }
      setValidationError(null);

      // Reset multi-select maps and probed profiles ref
      setDeviceProbeResultMap(new Map());
      setDeviceProbeLoadingMap(new Map());
      setGvretBusConfigMap(new Map());
      setSingleBusOverrideMap(new Map());
      probedProfilesRef.current.clear();
    }
  // Note: externalIngestSpeed intentionally not in deps - we only use it for initialization
  // If it were a dep, changing speed would re-run this effect and reset checkedReaderId
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, ingestProfileId, selectedId, selectedIds]);

  // Refresh buffer list periodically while dialog is open
  // This catches transitions from streaming to stopped even if the stream-ended
  // event wasn't received (e.g., stream stopped by another window)
  useEffect(() => {
    if (!isOpen) return;
    if (buffers.length === 0) return;

    // Poll more frequently while streaming, less frequently when not
    const hasStreamingBuffer = buffers.some(b => b.is_streaming);
    const pollInterval = hasStreamingBuffer ? 500 : 2000;

    const intervalId = setInterval(() => {
      listOrphanedBuffers().then(setBuffers).catch(console.error);
    }, pollInterval);

    return () => clearInterval(intervalId);
  }, [isOpen, buffers]);

  // Fetch active joinable sessions when dialog opens and periodically refresh
  // Includes multi_source sessions AND recorded sessions (like PostgreSQL)
  // Also fetches profile usage info for showing "(in use)" indicators
  useEffect(() => {
    if (!isOpen) return;

    const fetchSessions = async () => {
      try {
        const sessions = await listActiveSessions();
        console.log("[IoReaderPickerDialog] All active sessions:", sessions);
        // Show joinable sessions:
        // - multi_source: multi-bus sessions
        // - buffer: sessions switched to buffer replay (e.g., stopped live sessions)
        // - supports_time_range && !is_realtime: recorded sources like PostgreSQL
        const joinableSessions = sessions.filter((s) =>
          s.deviceType === "multi_source" ||
          s.deviceType === "buffer" ||
          (s.capabilities.supports_time_range && !s.capabilities.is_realtime)
        );
        console.log("[IoReaderPickerDialog] Joinable sessions:", joinableSessions);
        setActiveMultiSourceSessions(joinableSessions);

        // Fetch profile usage info for all profiles
        const profileIds = ioProfiles.map((p) => p.id);
        if (profileIds.length > 0) {
          const usageList = await getProfilesUsage(profileIds);
          const usageMap = new Map<string, ProfileUsageInfo>();
          for (const usage of usageList) {
            usageMap.set(usage.profileId, usage);
          }
          setProfileUsage(usageMap);
        }
      } catch (err) {
        console.error("[IoReaderPickerDialog] Error fetching sessions:", err);
      }
    };

    // Fetch immediately
    fetchSessions();

    // Refresh periodically
    const intervalId = setInterval(fetchSessions, 2000);

    return () => clearInterval(intervalId);
  }, [isOpen, ioProfiles]);

  // Filter bookmarks for the checked profile
  const profileBookmarks = useMemo(() => {
    if (!checkedReaderId || checkedReaderId === CSV_EXTERNAL_ID) return [];
    return bookmarks.filter((b) => b.profileId === checkedReaderId);
  }, [bookmarks, checkedReaderId]);

  // Multi-bus mode is active when at least one profile is selected in multi-select
  const isMultiBusMode = checkedReaderIds.length > 0;

  // Probe all real-time devices in multi-bus mode
  useEffect(() => {
    if (!isOpen || checkedReaderIds.length === 0) {
      return;
    }

    // Find real-time profiles among the selected ones
    const realtimeProfileIds = checkedReaderIds.filter((id) => {
      const profile = readProfiles.find((p) => p.id === id);
      return profile && isRealtimeProfile(profile);
    });

    if (realtimeProfileIds.length === 0) {
      // No real-time profiles selected, clear the maps and ref
      setDeviceProbeResultMap(new Map());
      setDeviceProbeLoadingMap(new Map());
      setGvretBusConfigMap(new Map());
      setSingleBusOverrideMap(new Map());
      probedProfilesRef.current.clear();
      return;
    }

    // Clean up profiles that are no longer selected
    const selectedSet = new Set(realtimeProfileIds);

    // Clean up ref for deselected profiles
    for (const id of probedProfilesRef.current) {
      if (!selectedSet.has(id)) {
        probedProfilesRef.current.delete(id);
      }
    }

    setDeviceProbeResultMap((prev) => {
      let changed = false;
      const newMap = new Map(prev);
      for (const key of newMap.keys()) {
        if (!selectedSet.has(key)) {
          newMap.delete(key);
          changed = true;
        }
      }
      return changed ? newMap : prev;
    });
    setGvretBusConfigMap((prev) => {
      let changed = false;
      const newMap = new Map(prev);
      for (const key of newMap.keys()) {
        if (!selectedSet.has(key)) {
          newMap.delete(key);
          changed = true;
        }
      }
      return changed ? newMap : prev;
    });
    setSingleBusOverrideMap((prev) => {
      let changed = false;
      const newMap = new Map(prev);
      for (const key of newMap.keys()) {
        if (!selectedSet.has(key)) {
          newMap.delete(key);
          changed = true;
        }
      }
      return changed ? newMap : prev;
    });
    setDeviceProbeLoadingMap((prev) => {
      let changed = false;
      const newMap = new Map(prev);
      for (const key of newMap.keys()) {
        if (!selectedSet.has(key)) {
          newMap.delete(key);
          changed = true;
        }
      }
      return changed ? newMap : prev;
    });

    // Probe each profile that we haven't probed yet
    // Use getState() to access store functions without adding them to dependencies
    realtimeProfileIds.forEach((profileId, profileIndex) => {
      // Skip if we've already started probing this profile
      if (probedProfilesRef.current.has(profileId)) {
        return;
      }

      // Check if this profile has an active session
      // Access store functions via getState() to avoid dependency issues
      const isLive = isProfileInUse(profileId);
      const session = getSessionForProfile(profileId);
      const isStopped = session?.ioState === "stopped";
      const profile = readProfiles.find((p) => p.id === profileId);
      const isMultiBus = profile?.kind === "gvret_tcp" || profile?.kind === "gvret_usb";

      // Calculate output bus offset based on position in selection list
      const outputBusOffset = profileIndex;

      if (isLive && !isStopped) {
        // Use default config for live session
        probedProfilesRef.current.add(profileId);
        setDeviceProbeResultMap((prev) => new Map(prev).set(profileId, {
          success: true,
          deviceType: isMultiBus ? "gvret" : "single",
          isMultiBus,
          busCount: isMultiBus ? 5 : 1,
          primaryInfo: "Session active",
          secondaryInfo: null,
          error: null,
        }));
        if (isMultiBus) {
          setGvretBusConfigMap((prev) => new Map(prev).set(profileId, createDefaultBusMappings(5, outputBusOffset)));
        } else {
          setSingleBusOverrideMap((prev) => new Map(prev).set(profileId, outputBusOffset));
        }
        return;
      }

      // Mark as probing
      probedProfilesRef.current.add(profileId);
      setDeviceProbeLoadingMap((prev) => new Map(prev).set(profileId, true));

      probeDevice(profileId)
        .then((result) => {
          setDeviceProbeResultMap((prev) => new Map(prev).set(profileId, result));
          if (result.isMultiBus) {
            setGvretBusConfigMap((prev) => new Map(prev).set(profileId, createDefaultBusMappings(result.busCount, outputBusOffset)));
          } else {
            setSingleBusOverrideMap((prev) => new Map(prev).set(profileId, outputBusOffset));
          }
        })
        .catch((err) => {
          console.error(`[IoReaderPickerDialog] Probe failed for ${profileId}:`, err);
          setDeviceProbeResultMap((prev) => new Map(prev).set(profileId, {
            success: false,
            deviceType: isMultiBus ? "gvret" : "unknown",
            isMultiBus,
            busCount: 0,
            primaryInfo: null,
            secondaryInfo: null,
            error: String(err),
          }));
          // For multi-bus devices, fall back to default 5 buses
          if (isMultiBus) {
            setGvretBusConfigMap((prev) => new Map(prev).set(profileId, createDefaultBusMappings(5, outputBusOffset)));
          }
        })
        .finally(() => {
          setDeviceProbeLoadingMap((prev) => {
            const newMap = new Map(prev);
            newMap.delete(profileId);
            return newMap;
          });
        });
    });
    // Note: isProfileInUse and getSessionForProfile are stable store functions,
    // intentionally excluded from deps to prevent infinite loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, checkedReaderIds, readProfiles]);

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      unlistenRefs.current.forEach((unlisten) => unlisten());
      unlistenRefs.current = [];
    };
  }, []);

  // Handle ingest completion (internal state only)
  const handleInternalIngestComplete = useCallback(
    async (payload: StreamEndedPayload) => {
      console.log("Ingest complete:", payload);
      setInternalIsIngesting(false);
      setInternalIngestProfileId(null);

      // Cleanup listeners
      unlistenRefs.current.forEach((unlisten) => unlisten());
      unlistenRefs.current = [];

      // Destroy the ingest session using the tracked session ID
      const sessionId = internalIngestSessionIdRef.current;
      if (sessionId) {
        try {
          await destroyReaderSession(sessionId);
        } catch (e) {
          console.error("Failed to destroy ingest session:", e);
        }
        internalIngestSessionIdRef.current = null;
      }

      if (payload.buffer_available && payload.count > 0) {
        // Refresh the buffer list
        const allBuffers = await listOrphanedBuffers();
        setBuffers(allBuffers);

        // Get the specific buffer that was created (if we have its ID)
        if (payload.buffer_id) {
          const meta = allBuffers.find((b) => b.id === payload.buffer_id);
          if (meta) {
            onImport?.(meta);

            // Notify other windows that buffer has changed
            const bufferPayload: BufferChangedPayload = {
              metadata: meta,
              timestamp: Date.now(),
            };
            await emit(WINDOW_EVENTS.BUFFER_CHANGED, bufferPayload);
          }
        }
      }
    },
    [onImport]
  );

  // Start ingesting from a profile (internal state mode)
  const handleInternalStartIngest = async (profileId: string, options: IngestOptions) => {
    setInternalIngestError(null);
    setInternalIngestFrameCount(0);

    // Generate unique session ID for this ingest
    const sessionId = generateIngestSessionId();
    internalIngestSessionIdRef.current = sessionId;

    try {
      // Clear existing buffer first
      await clearBuffer();

      // Set up event listeners for this session
      const unlistenStreamEnded = await listen<StreamEndedPayload>(
        `stream-ended:${sessionId}`,
        (event) => handleInternalIngestComplete(event.payload)
      );
      const unlistenError = await listen<string>(`session-error:${sessionId}`, (event) => {
        setInternalIngestError(event.payload);
      });
      const unlistenFrames = await listen<{ frames: unknown[] } | unknown[]>(`frame-message:${sessionId}`, (event) => {
        // Handle both legacy array format and new FrameBatchPayload format
        const frames = Array.isArray(event.payload) ? event.payload : event.payload.frames;
        setInternalIngestFrameCount((prev) => prev + frames.length);
      });

      unlistenRefs.current = [unlistenStreamEnded, unlistenError, unlistenFrames];

      // Create and start the reader session with all options
      await createIOSession({
        sessionId,
        profileId,
        speed: options.speed,
        startTime: options.startTime,
        endTime: options.endTime,
        limit: options.maxFrames,
        // Framing configuration
        framingEncoding: options.framingEncoding,
        delimiter: options.delimiter,
        maxFrameLength: options.maxFrameLength,
        emitRawBytes: options.emitRawBytes,
      });

      // Apply speed setting
      if (options.speed > 0) {
        await updateReaderSpeed(sessionId, options.speed);
      }

      await startReaderSession(sessionId);

      setInternalIsIngesting(true);
      setInternalIngestProfileId(profileId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInternalIngestError(msg);
      internalIngestSessionIdRef.current = null;
      // Cleanup on error
      unlistenRefs.current.forEach((unlisten) => unlisten());
      unlistenRefs.current = [];
    }
  };

  // Build ingest options from current state
  const buildIngestOptions = (speed: number): IngestOptions => {
    const opts: IngestOptions = { speed };

    // Add time range for recorded sources
    // Convert datetime-local values based on timezone mode
    if (!isCheckedRealtime) {
      if (timeBounds.startTime) {
        // If UTC mode, the user entered UTC time - append Z
        // If Local mode, convert to ISO with timezone offset so PostgreSQL interprets correctly
        opts.startTime = timeBounds.timezoneMode === "utc"
          ? `${timeBounds.startTime}:00Z`
          : localToIsoWithOffset(timeBounds.startTime);
      }
      if (timeBounds.endTime) {
        opts.endTime = timeBounds.timezoneMode === "utc"
          ? `${timeBounds.endTime}:00Z`
          : localToIsoWithOffset(timeBounds.endTime);
      }
    }

    // Add max frames limit for all sources
    if (timeBounds.maxFrames && timeBounds.maxFrames > 0) {
      opts.maxFrames = timeBounds.maxFrames;
    }

    // Add framing configuration for serial sources
    if (framingConfig) {
      opts.framingEncoding = framingConfig.encoding;
      opts.delimiter = framingConfig.delimiter;
      opts.maxFrameLength = framingConfig.maxFrameLength;
      opts.emitRawBytes = framingConfig.emitRawBytes;
    }

    // Add filter configuration for serial sources
    if (minFrameLength > 0) {
      opts.minFrameLength = minFrameLength;
    }

    console.log("[buildIngestOptions] Built options:", opts);
    console.log("[buildIngestOptions] framingConfig state:", framingConfig);

    return opts;
  };

  // Handle Ingest button - runs at max speed (speed=0), keeps dialog open
  const handleIngestClick = () => {
    if (!checkedReaderId || !checkedProfile) return;
    const options = buildIngestOptions(0); // 0 = max speed / no limit
    if (useExternalState) {
      onStartIngest?.(checkedReaderId, false, options);
    } else {
      handleInternalStartIngest(checkedReaderId, options);
    }
  };

  // Handle Watch button - uses selected speed, closes dialog
  const handleWatchClick = () => {
    if (!checkedReaderId || !checkedProfile) return;
    const options = buildIngestOptions(selectedSpeed);
    if (useExternalState) {
      onStartIngest?.(checkedReaderId, true, options);
    } else {
      handleInternalStartIngest(checkedReaderId, options);
    }
    onClose();
  };

  // Handle Join button - join an existing live session (no options needed)
  // This also handles joining active multi-source sessions
  const handleJoinClick = () => {
    if (onJoinSession && checkedReaderId) {
      // Check if this is a multi-source session and get source profile IDs
      const multiSourceSession = activeMultiSourceSessions.find((s) => s.sessionId === checkedReaderId);
      const sourceProfileIds = multiSourceSession?.multiSourceConfigs?.map((c) => c.profileId);
      onJoinSession(checkedReaderId, sourceProfileIds);
    }
    onClose();
  };

  // Handle Resume button - start a stopped session and join it
  const handleStartClick = async () => {
    if (checkedProfileSession) {
      try {
        await startSession(checkedProfileSession.id);
        // After starting, join the session
        if (onJoinSession && checkedReaderId) {
          onJoinSession(checkedReaderId);
        }
        onClose();
      } catch (e) {
        console.error("Failed to start session:", e);
      }
    }
  };

  // Handle Restart button - destroy existing session and start a new one with updated config
  const handleRestartClick = async () => {
    if (!checkedReaderId || !checkedProfile) return;

    // Destroy the existing session first
    const existingSession = getSessionForProfile(checkedReaderId);
    if (existingSession) {
      try {
        await destroyReaderSession(existingSession.id);
      } catch (e) {
        console.error("Failed to destroy existing session:", e);
        // Continue anyway - maybe it was already destroyed
      }
    }

    // Now start a new session with the updated config
    const options = buildIngestOptions(selectedSpeed);
    if (useExternalState) {
      onStartIngest?.(checkedReaderId, true, options);
    } else {
      handleInternalStartIngest(checkedReaderId, options);
    }
    onClose();
  };

  // Handle Multi-Bus Restart button - destroy existing multi-source session and create a new one
  const handleMultiRestartClick = async () => {
    if (checkedReaderIds.length === 0) return;

    // Destroy the existing multi-source session first
    if (liveMultiSourceSession) {
      try {
        await destroyReaderSession(liveMultiSourceSession.sessionId);
      } catch (e) {
        console.error("Failed to destroy existing multi-source session:", e);
        // Continue anyway - maybe it was already destroyed
      }
    }

    // Now create a new multi-source session with the updated config
    handleMultiWatchClick();
  };

  // Handle time bounds change from TimeBoundsInput
  const handleTimeBoundsChange = useCallback((bounds: TimeBounds) => {
    setTimeBounds(bounds);
  }, []);

  // Stop ingesting
  const handleStopIngest = async () => {
    if (useExternalState) {
      onStopIngest?.();
    } else {
      const sessionId = internalIngestSessionIdRef.current;
      if (!sessionId) return;
      try {
        await stopReaderSession(sessionId);
        // The stream-ended event will handle the rest
      } catch (e) {
        console.error("Failed to stop ingest:", e);
        // Force cleanup
        setInternalIsIngesting(false);
        setInternalIngestProfileId(null);
        internalIngestSessionIdRef.current = null;
        unlistenRefs.current.forEach((unlisten) => unlisten());
        unlistenRefs.current = [];
      }
    }
  };

  // Handle speed change
  const handleSpeedChange = (speed: number) => {
    setSelectedSpeed(speed);
    if (useExternalState) {
      onIngestSpeedChange?.(speed);
    }
  };

  // Handle toggling a multi-source-capable reader (for multi-bus mode)
  const handleToggleReader = (readerId: string) => {
    const profile = readProfiles.find((p) => p.id === readerId);
    if (!profile) return;

    setCheckedReaderIds((prev) => {
      if (prev.includes(readerId)) {
        // Unchecking - remove from list
        const newList = prev.filter((id) => id !== readerId);
        setValidationError(null);
        return newList;
      } else {
        // Checking - validate compatibility first
        const selectedProfiles = prev
          .map((id) => readProfiles.find((p) => p.id === id))
          .filter((p): p is IOProfile => p !== undefined);

        const validation = validateProfileSelection(selectedProfiles, profile);
        if (!validation.valid) {
          setValidationError(validation.error || "Incompatible selection");
          return prev; // Don't add if validation fails
        }

        setValidationError(null);
        // Clear single-select reader when adding to multi-bus
        setCheckedReaderId(null);
        return [...prev, readerId];
      }
    });
  };

  // Handle selecting an active multi-source session to join
  const handleSelectMultiSourceSession = (sessionId: string) => {
    // Select the multi-source session as the reader
    setCheckedReaderId(sessionId);
    setSelectedBufferId(null);
    // Clear multi-bus selection since we're joining an existing session
    setCheckedReaderIds([]);
    setValidationError(null);
  };

  // Handle Leave button - unregister listener and reset dialog state
  const handleRelease = async () => {
    if (!listenerId) return; // Need listener ID to unregister

    // Unregister from any active sessions (doesn't destroy them, other listeners can still use them)
    // Single-select mode: unregister from session for the checked profile
    if (checkedReaderId && checkedReaderId !== CSV_EXTERNAL_ID) {
      const session = getSessionForProfile(checkedReaderId);
      if (session) {
        try {
          await unregisterSessionListener(session.id, listenerId);
        } catch (e) {
          console.error("Failed to unregister from session:", e);
        }
      }
    }

    // Multi-select mode: unregister from sessions for all checked profiles
    for (const profileId of checkedReaderIds) {
      const session = getSessionForProfile(profileId);
      if (session) {
        try {
          await unregisterSessionListener(session.id, listenerId);
        } catch (e) {
          console.error(`Failed to unregister from session for ${profileId}:`, e);
        }
      }
    }

    // Clear reader selection
    setCheckedReaderId(null);
    setCheckedReaderIds([]);
    setValidationError(null);

    // Clear buffer selection
    setSelectedBufferId(null);

    // Reset ingest options
    setTimeBounds({
      startTime: "",
      endTime: "",
      maxFrames: undefined,
      timezoneMode: "local",
    });
    setSelectedSpeed(1);

    // Reset framing and filter config
    setFramingConfig(null);
    setMinFrameLength(0);
    setFramingConfigMap(new Map());

    // Reset multi-bus device probe maps
    setDeviceProbeResultMap(new Map());
    setDeviceProbeLoadingMap(new Map());
    setGvretBusConfigMap(new Map());
    setSingleBusOverrideMap(new Map());
    probedProfilesRef.current.clear();

    // Clear import error
    setImportError(null);
  };

  // Handle Watch button for multi-bus mode
  const handleMultiWatchClick = () => {
    if (checkedReaderIds.length === 0) return;
    const options = buildIngestOptions(selectedSpeed);

    // Build combined bus mappings from both GVRET and single-bus devices
    const combinedBusMappings = new Map<string, BusMapping[]>();

    // Add GVRET multi-bus device mappings
    for (const [profileId, mappings] of gvretBusConfigMap.entries()) {
      combinedBusMappings.set(profileId, mappings);
    }

    // Convert single-bus device overrides to BusMapping format
    for (const [profileId, outputBus] of singleBusOverrideMap.entries()) {
      // Look up profile to determine protocol from driver type
      const profile = readProfiles.find(p => p.id === profileId);
      const readerProtocols = profile ? getReaderProtocols(profile.kind, profile.connection) : ['can'];
      const protocol = readerProtocols[0] || 'can';

      // Single-bus devices have device bus 0, mapped to the selected output bus
      combinedBusMappings.set(profileId, [{
        deviceBus: 0,
        enabled: true,
        outputBus,
        interfaceId: `${protocol}0`,
        traits: {
          temporal_mode: 'realtime',
          protocols: (protocol === 'can' ? ['can', 'canfd'] : [protocol]) as Protocol[],
          can_transmit: true,
        },
      }]);
    }

    options.busMappings = combinedBusMappings;

    // Pass per-interface framing configs (for serial profiles)
    if (framingConfigMap.size > 0) {
      options.perInterfaceFraming = framingConfigMap;
    }

    console.log("[IoReaderPickerDialog] handleMultiWatchClick - bus mappings:", {
      checkedReaderIds,
      combinedBusMappingsSize: combinedBusMappings.size,
      combinedBusMappingsEntries: Array.from(combinedBusMappings.entries()).map(([k, v]) => ({
        profileId: k,
        mappings: v,
      })),
      perInterfaceFramingSize: framingConfigMap.size,
    });
    if (onStartMultiIngest) {
      onStartMultiIngest(checkedReaderIds, true, options);
    }
    onSelectMultiple?.(checkedReaderIds);
    onClose();
  };

  const handleImport = async () => {
    setImportError(null);
    setIsImporting(true);

    try {
      const filePath = await pickCsvToOpen(defaultDir);
      if (!filePath) {
        // User cancelled
        setIsImporting(false);
        return;
      }

      const metadata = await importCsvToBuffer(filePath);

      // Refresh buffer list
      const allBuffers = await listOrphanedBuffers();
      setBuffers(allBuffers);

      onImport?.(metadata);

      // Notify other windows that buffer has changed
      const payload: BufferChangedPayload = {
        metadata,
        timestamp: Date.now(),
      };
      await emit(WINDOW_EVENTS.BUFFER_CHANGED, payload);

      // Auto-select the buffer using its actual ID
      onSelect(metadata.id);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setImportError(msg);
    } finally {
      setIsImporting(false);
    }
  };

  // Delete a specific buffer by ID
  const handleDeleteBuffer = async (bufferId: string) => {
    try {
      await deleteBuffer(bufferId);

      // Refresh buffer list
      const allBuffers = await listOrphanedBuffers();
      setBuffers(allBuffers);

      // If no buffers left and buffer was selected, clear selection
      if (allBuffers.length === 0 && isBufferProfileId(selectedId)) {
        onSelect(null);
      }

      // Notify other windows that buffer has been deleted
      const payload: BufferChangedPayload = {
        metadata: null, // Signal a buffer was deleted
        timestamp: Date.now(),
      };
      await emit(WINDOW_EVENTS.BUFFER_CHANGED, payload);
    } catch (e) {
      console.error("Failed to delete buffer:", e);
    }
  };

  // Clear all non-streaming buffers
  const handleClearAllBuffers = async () => {
    try {
      // Only delete buffers that are not streaming
      const nonStreamingBuffers = buffers.filter(b => !b.is_streaming);
      for (const buffer of nonStreamingBuffers) {
        await deleteBuffer(buffer.id);
      }

      // Refresh buffer list (keep streaming buffers)
      const streamingBuffers = buffers.filter(b => b.is_streaming);
      setBuffers(streamingBuffers);

      // If buffer was selected and it was deleted, clear selection
      const deletedIds = new Set(nonStreamingBuffers.map(b => b.id));
      if (isBufferProfileId(selectedId)) {
        // Check if the selected buffer was deleted
        const selectedBuffer = buffers.find(b => b.id === selectedId);
        if (selectedBuffer && deletedIds.has(selectedBuffer.id)) {
          onSelect(null);
        }
      }

      // Notify other windows that buffers have been cleared
      const payload: BufferChangedPayload = {
        metadata: null,
        timestamp: Date.now(),
      };
      await emit(WINDOW_EVENTS.BUFFER_CHANGED, payload);
    } catch (e) {
      console.error("Failed to clear buffers:", e);
    }
  };

  // Select a specific orphaned buffer
  const handleSelectBuffer = async (bufferId: string) => {
    try {
      await setActiveBuffer(bufferId);
      setCheckedReaderId(null);
      setSelectedBufferId(bufferId);
      // Pass the actual buffer ID as the profile ID (e.g., "buffer_1")
      // This allows unique session naming per buffer
      onSelect(bufferId);
    } catch (e) {
      console.error("Failed to set active buffer:", e);
    }
  };

  const isBufferSelected = isBufferProfileId(selectedId);

  // Check if a bytes buffer is selected (for framing options)
  const selectedBuffer = selectedBufferId ? buffers.find((b) => b.id === selectedBufferId) : null;
  const isBytesBufferSelected = selectedBuffer?.buffer_type === "bytes" && !checkedReaderId;

  // Handle OK button click for buffer selection - pass framing config if configured
  const handleBufferOkClick = () => {
    if (isBytesBufferSelected && onBufferFramingConfig) {
      onBufferFramingConfig(framingConfig);
    }
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-md">
      <div className={`${cardElevated} shadow-xl overflow-hidden`}>
        {/* Header */}
        <div className={`${paddingCard} border-b ${borderDefault} flex items-center justify-between`}>
          <h2 className={h3}>Data Source</h2>
          <button
            onClick={onClose}
            className={`p-1 ${roundedDefault} ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>

        <IngestStatus
          isIngesting={isIngesting}
          ingestFrameCount={ingestFrameCount}
          ingestError={ingestError}
          onStopIngest={handleStopIngest}
        />

        <div className="max-h-[60vh] overflow-y-auto">
          {!hideBuffers && (
            <BufferList
              buffers={buffers}
              selectedBufferId={selectedBufferId}
              checkedReaderId={checkedReaderId}
              checkedReaderIds={checkedReaderIds}
              onSelectBuffer={handleSelectBuffer}
              onDeleteBuffer={handleDeleteBuffer}
              onClearAllBuffers={handleClearAllBuffers}
            />
          )}

          <ReaderList
            ioProfiles={ioProfiles}
            checkedReaderId={checkedReaderId}
            checkedReaderIds={checkedReaderIds}
            defaultId={defaultId}
            isIngesting={isIngesting}
            onSelectReader={(id) => {
              setCheckedReaderId(id);
              // Clear multi-bus selection when selecting a single profile
              // (ensures mutual exclusivity between single-select and multi-select)
              setCheckedReaderIds([]);
              setValidationError(null);
              if (id !== null) {
                setSelectedBufferId(null);
              }
            }}
            onToggleReader={handleToggleReader}
            isProfileLive={isProfileInUse}
            getSessionForProfile={getSessionForProfile}
            validationError={validationError}
            allowMultiSelect={allowMultiSelect}
            renderProfileExtra={(profileId) => {
              // Render bus config for all real-time profiles
              const profile = readProfiles.find((p) => p.id === profileId);
              if (!profile || !isRealtimeProfile(profile)) return null;

              const probeResult = deviceProbeResultMap.get(profileId) || null;
              const isLoading = deviceProbeLoadingMap.get(profileId) || false;
              const isGvret = profile.kind === "gvret_tcp" || profile.kind === "gvret_usb";
              // Check if config is locked for this profile (in use by 2+ sessions)
              const usageInfo = profileUsage.get(profileId);
              const configLocked = usageInfo?.configLocked ?? false;

              // Collect output buses used by OTHER profiles for duplicate detection
              const usedOutputBuses = new Set<number>();
              for (const [otherId, otherConfig] of gvretBusConfigMap.entries()) {
                if (otherId !== profileId) {
                  for (const mapping of otherConfig) {
                    if (mapping.enabled) {
                      usedOutputBuses.add(mapping.outputBus);
                    }
                  }
                }
              }
              for (const [otherId, otherBus] of singleBusOverrideMap.entries()) {
                if (otherId !== profileId) {
                  usedOutputBuses.add(otherBus);
                }
              }

              // Multi-bus devices (GVRET) - show GvretBusConfig
              if (isGvret || probeResult?.isMultiBus) {
                let busConfig = gvretBusConfigMap.get(profileId);
                if (!busConfig && probeResult) {
                  const profileIndex = checkedReaderIds.indexOf(profileId);
                  const offset = profileIndex >= 0 ? profileIndex : 0;
                  busConfig = createDefaultBusMappings(probeResult.busCount || 5, offset);
                }
                busConfig = busConfig || [];

                // Create GvretDeviceInfo-compatible object from probe result
                const deviceInfo: GvretDeviceInfo | null = probeResult
                  ? { bus_count: probeResult.busCount || 5 }
                  : null;

                return (
                  <GvretBusConfig
                    deviceInfo={deviceInfo}
                    isLoading={isLoading}
                    error={probeResult?.error || null}
                    busConfig={busConfig}
                    onBusConfigChange={(config) => {
                      setGvretBusConfigMap((prev) => new Map(prev).set(profileId, config));
                    }}
                    compact
                    usedOutputBuses={usedOutputBuses}
                    configLocked={configLocked}
                  />
                );
              }

              // Single-bus devices - show SingleBusConfig
              const busOverride = singleBusOverrideMap.get(profileId);
              const profileForKind = ioProfiles.find((p) => p.id === profileId);
              const profileKind = profileForKind?.kind;
              const interfaceFraming = framingConfigMap.get(profileId);
              return (
                <SingleBusConfig
                  probeResult={probeResult}
                  isLoading={isLoading}
                  error={probeResult?.error || null}
                  busOverride={busOverride}
                  onBusOverrideChange={(bus) => {
                    setSingleBusOverrideMap((prev) => {
                      const newMap = new Map(prev);
                      if (bus === undefined) {
                        newMap.delete(profileId);
                      } else {
                        newMap.set(profileId, bus);
                      }
                      return newMap;
                    });
                  }}
                  compact
                  usedBuses={usedOutputBuses}
                  profileKind={profileKind}
                  framingConfig={interfaceFraming}
                  onFramingChange={(config) => {
                    setFramingConfigMap((prev) => new Map(prev).set(profileId, config));
                  }}
                  configLocked={configLocked}
                />
              );
            }}
            activeMultiSourceSessions={activeMultiSourceSessions}
            onSelectMultiSourceSession={handleSelectMultiSourceSession}
            disabledProfiles={disabledProfiles}
            hideExternal={hideBuffers}
            hideRecorded={hideBuffers}
            profileUsage={profileUsage}
          />

          {/* Show ingest options when creating a new session */}
          {/* Hide when: connect mode, joining an existing session, or nothing selected */}
          {mode !== "connect" && (checkedReaderId || isMultiBusMode) && !checkedMultiSourceSession && (
            <>
              <IngestOptions
                checkedReaderId={checkedReaderId}
                checkedProfile={checkedProfile}
                isIngesting={isIngesting}
                timeBounds={timeBounds}
                onTimeBoundsChange={handleTimeBoundsChange}
                selectedSpeed={selectedSpeed}
                onSpeedChange={handleSpeedChange}
                profileBookmarks={profileBookmarks}
              />

              {/* Only show FramingOptions/FilterOptions for bytes buffer - per-interface framing is now in SingleBusConfig */}
              {isBytesBufferSelected && (
                <>
                  <FramingOptions
                    checkedProfile={checkedProfile}
                    ioProfiles={ioProfiles}
                    checkedReaderIds={checkedReaderIds}
                    isIngesting={isIngesting}
                    framingConfig={framingConfig}
                    onFramingConfigChange={setFramingConfig}
                    isBytesBufferSelected={isBytesBufferSelected}
                  />

                  <FilterOptions
                    checkedProfile={checkedProfile}
                    ioProfiles={ioProfiles}
                    checkedReaderIds={checkedReaderIds}
                    isIngesting={isIngesting}
                    minFrameLength={minFrameLength}
                    onMinFrameLengthChange={setMinFrameLength}
                    isBytesBufferSelected={isBytesBufferSelected}
                  />
                </>
              )}
            </>
          )}
        </div>

        <ActionButtons
          mode={mode}
          isIngesting={isIngesting}
          ingestProfileId={ingestProfileId}
          checkedReaderId={checkedReaderId}
          checkedProfile={checkedProfile}
          isBufferSelected={isBufferSelected}
          isCheckedProfileLive={isCheckedProfileLive}
          isCheckedProfileStopped={isCheckedProfileStopped}
          isImporting={isImporting}
          importError={importError}
          onImport={handleImport}
          onIngestClick={handleIngestClick}
          onWatchClick={handleWatchClick}
          onJoinClick={handleJoinClick}
          onStartClick={handleStartClick}
          onClose={handleBufferOkClick}
          onSkip={onSkip}
          multiSelectMode={isMultiBusMode}
          multiSelectCount={checkedReaderIds.length}
          onMultiWatchClick={handleMultiWatchClick}
          onRelease={listenerId && isCheckedProfileLive ? handleRelease : undefined}
          // Only show Restart for profiles, not for selecting existing sessions
          onRestartClick={isCheckedProfileLive && !isCheckedProfileStopped && !checkedMultiSourceSession ? handleRestartClick : undefined}
          isMultiSourceLive={isMultiSourceLive}
          onMultiRestartClick={isMultiSourceLive ? handleMultiRestartClick : undefined}
          onConnectClick={checkedReaderId && onConnect ? () => {
            onConnect(checkedReaderId);
            onClose();
          } : undefined}
        />
      </div>
    </Dialog>
  );
}
