// ui/src/dialogs/IoSourcePickerDialog.tsx

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
import { buildDefaultBusMappings, isMultiBusProfile } from "../utils/profileTraits";
import { useSessionStore } from "../stores/sessionStore";
import { pickCsvFilesToOpen } from "../api/dialogs";
import {
  listOrphanedCaptures,
  deleteCapture,
  setActiveCapture,
  type CaptureMetadata,
} from "../api/capture";
import { CsvColumnMapperDialog } from "./csv-column-mapper";
import CsvFileOrderDialog from "./CsvFileOrderDialog";
import { WINDOW_EVENTS, type CaptureChangedPayload } from "../events/registry";
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
  type StreamEndedInfo,
  type GvretDeviceInfo,
  type BusMapping,
  type ActiveSessionInfo,
  type DeviceProbeResult,
  type Protocol,
  type TemporalMode,
  type ProfileUsageInfo,
} from '../api/io';
import { getAllFavorites, type TimeRangeFavorite } from "../utils/favorites";
import type { TimeBounds } from "../components/TimeBoundsInput";

// Import extracted components
import { CaptureList } from "./io-source-picker";
import { SourceList } from "./io-source-picker";
import { LoadOptions } from "./io-source-picker";
import { FramingOptions, FilterOptions } from "./io-source-picker";
import { ActionButtons } from "./io-source-picker";
import { LoadStatus } from "./io-source-picker";
import DeviceBusConfig from "./io-source-picker/DeviceBusConfig";
import SingleBusConfig from "./io-source-picker/SingleBusConfig";
import {
  localToIsoWithOffset,
  CSV_EXTERNAL_ID,
  generateLoadSessionId,
  isRealtimeProfile,
  validateProfileSelection,
} from "./io-source-picker";
import { isCaptureProfileId } from "../hooks/useIOSessionManager";
import type { FramingConfig, InterfaceFramingConfig } from "./io-source-picker";


/** Options passed when starting a load or connect operation */
export interface LoadOptions {
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
  /** Dialog mode: "streaming" shows Connect/Load, "connect" shows just Connect */
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
  onImport?: (metadata: CaptureMetadata) => void;
  /** Called when buffer is confirmed with framing config (for applying framing to bytes buffer) */
  onBufferFramingConfig?: (config: FramingConfig | null) => void;
  /** Current buffer metadata (if any) */
  captureMetadata?: CaptureMetadata | null;
  /** Default directory for file picker */
  defaultDir?: string;
  /** External load state - when provided, dialog uses external state instead of internal */
  isLoading?: boolean;
  /** Profile ID currently being loaded */
  loadProfileId?: string | null;
  /** Current frame count during load */
  loadFrameCount?: number;
  /** Current load speed */
  loadSpeed?: number;
  /** Called when load speed changes */
  onLoadSpeedChange?: (speed: number) => void;
  /** Called to start load/connect */
  onStartLoad?: (profileId: string, closeDialog: boolean, options: LoadOptions) => void;
  /** Called to start load/connect with multiple profiles (multi-bus mode) */
  onStartMultiLoad?: (profileIds: string[], closeDialog: boolean, options: LoadOptions) => void;
  /** Called to stop load */
  onStopLoad?: () => void;
  /** Error message during load */
  loadError?: string | null;
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
  /** Called when user wants to continue without selecting a source */
  onSkip?: () => void;
  /** Listener ID for this app (e.g., "discovery", "decoder") - required for Leave button */
  listenerId?: string;
  /** Called when user clicks Connect in connect mode (creates session without streaming) */
  onConnect?: (profileId: string) => void;
};

export default function IoSourcePickerDialog({
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
  captureMetadata: _captureMetadata, // Deprecated - dialog now fetches buffers directly
  defaultDir,
  // External load state (optional - if provided, dialog uses external state)
  isLoading: externalIsLoading,
  loadProfileId: externalLoadProfileId,
  loadFrameCount: externalLoadFrameCount,
  loadSpeed: externalLoadSpeed,
  onLoadSpeedChange,
  onStartLoad,
  onStartMultiLoad,
  onStopLoad,
  loadError: externalLoadError,
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

  // CSV column mapper state
  const [csvMapperFilePath, setCsvMapperFilePath] = useState<string | null>(null);
  const [csvMapperFilePaths, setCsvMapperFilePaths] = useState<string[] | null>(null);
  const [csvImportSessionId, setCsvImportSessionId] = useState<string | null>(null);
  const [showCsvMapper, setShowCsvMapper] = useState(false);
  const [showFileOrderDialog, setShowFileOrderDialog] = useState(false);
  const [pendingFilePaths, setPendingFilePaths] = useState<string[] | null>(null);
  const [csvHasHeaderPerFile, setCsvHasHeaderPerFile] = useState<boolean[] | null>(null);

  // Multi-buffer state
  const [buffers, setBuffers] = useState<CaptureMetadata[]>([]);
  const [selectedCaptureId, setSelectedBufferId] = useState<string | null>(null);
  // (Buffer bus config now uses shared deviceBusConfigMap / singleBusOverrideMap via probeDevice)

  // Internal load state (used when external state not provided)
  const [internalIsLoading, setInternalIsLoading] = useState(false);
  const [internalLoadProfileId, setInternalLoadProfileId] = useState<string | null>(null);
  const [internalLoadFrameCount, setInternalLoadFrameCount] = useState(0);
  const [internalLoadError, setInternalLoadError] = useState<string | null>(null);
  const internalLoadSessionIdRef = useRef<string | null>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);

  // Currently checked IO reader (for single-select / non-multi-source-capable profiles)
  const [checkedSourceId, setCheckedReaderId] = useState<string | null>(null);

  // Multi-bus selection (for multi-source-capable profiles like CAN interfaces)
  // Multi-bus mode is implicit when checkedSourceIds.length > 1
  const [checkedSourceIds, setCheckedReaderIds] = useState<string[]>([]);

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
  const [deviceBusConfigMap, setDeviceBusConfigMap] = useState<Map<string, BusMapping[]>>(new Map());
  const [singleBusOverrideMap, setSingleBusOverrideMap] = useState<Map<string, number>>(new Map());
  // Per-profile framing config (for serial profiles in multi-bus mode)
  const [framingConfigMap, setFramingConfigMap] = useState<Map<string, InterfaceFramingConfig>>(new Map());
  // Track which profiles have been probed to avoid duplicate probes (refs don't trigger re-renders)
  const probedProfilesRef = useRef<Set<string>>(new Set());
  // Tracks whether the user has clicked "Change" to expand the collapsed view (prevents re-collapsing)
  const hasUserExpandedRef = useRef(false);
  // Tracks whether the on-open initialisation has already run for the current
  // open cycle. Without this, the init effect below re-runs on every parent
  // re-render (because selectedIds prop can change reference during streaming)
  // and clobbers `hasUserExpandedRef`, causing the collapsed view to re-snap
  // back after clicking "Change".
  const didInitForOpenRef = useRef(false);

  // Active multi-source sessions (for sharing between apps)
  const [activeMultiSourceSessions, setActiveMultiSourceSessions] = useState<ActiveSessionInfo[]>([]);

  // Profile usage info - which sessions are using each profile
  const [profileUsage, setProfileUsage] = useState<Map<string, ProfileUsageInfo>>(new Map());

  // Use external state if provided, otherwise use internal state
  const useExternalState = onStartLoad !== undefined;
  const isLoading = useExternalState ? (externalIsLoading ?? false) : internalIsLoading;
  const loadProfileId = useExternalState ? (externalLoadProfileId ?? null) : internalLoadProfileId;
  const loadFrameCount = useExternalState ? (externalLoadFrameCount ?? 0) : internalLoadFrameCount;
  const loadError = useExternalState ? (externalLoadError ?? null) : internalLoadError;

  // Probe a buffer and populate the shared device maps.
  // All buffers go into deviceBusConfigMap (not singleBusOverrideMap) so the
  // bus mapper always appears — even single-bus buffers show "Bus 0 → Bus 0".
  const probeBuffer = useCallback(async (captureId: string) => {
    setDeviceProbeLoadingMap((prev) => new Map(prev).set(captureId, true));
    try {
      const result = await probeDevice(captureId);
      setDeviceProbeResultMap((prev) => new Map(prev).set(captureId, result));
      // Use actual bus numbers from buffer metadata (may be non-sequential)
      const buffer = buffers.find((b) => b.id === captureId);
      const busList = buffer?.buses?.length ? buffer.buses : [0]; // default to bus 0
      const mappings: BusMapping[] = busList.map((bus) => ({
        deviceBus: bus,
        enabled: true,
        outputBus: bus,
        interfaceId: `can${bus}`,
        traits: {
          temporal_mode: "timeline" as TemporalMode,
          protocols: ["can", "canfd"] as Protocol[],
          tx_frames: false,
          tx_bytes: false,
          multi_source: false,
        },
      }));
      setDeviceBusConfigMap((prev) => new Map(prev).set(captureId, mappings));
    } catch (err) {
      console.error(`[IoSourcePickerDialog] Buffer probe failed for ${captureId}:`, err);
      setDeviceProbeResultMap((prev) => new Map(prev).set(captureId, {
        success: false,
        sourceType: "buffer",
        isMultiBus: false,
        busCount: 0,
        primaryInfo: null,
        secondaryInfo: null,
        supports_fd: null,
        error: String(err),
      }));
    } finally {
      setDeviceProbeLoadingMap((prev) => {
        const newMap = new Map(prev);
        newMap.delete(captureId);
        return newMap;
      });
    }
  }, [buffers]);

  // All profiles are read profiles now (mode field removed)
  const readProfiles = ioProfiles;

  // Get the checked profile object (null for CSV external)
  const checkedProfile = useMemo(() => {
    if (!checkedSourceId || checkedSourceId === CSV_EXTERNAL_ID) return null;
    return readProfiles.find((p) => p.id === checkedSourceId) || null;
  }, [checkedSourceId, readProfiles]);

  // Is the checked profile a real-time source?
  const isCheckedRealtime = checkedProfile ? isRealtimeProfile(checkedProfile) : false;

  // Is the checked reader an active multi-source session?
  const checkedMultiSourceSession = useMemo(() => {
    if (!checkedSourceId) return null;
    return activeMultiSourceSessions.find((s) => s.sessionId === checkedSourceId) || null;
  }, [checkedSourceId, activeMultiSourceSessions]);

  // Is the checked selection an active session that can be joined?
  // This is ONLY true when the user explicitly selects an Active Session from the list.
  // For profiles (IO Sources), being "in use" is informational only - users can always
  // start new sessions. The Join button only appears for explicitly selected sessions.
  const isCheckedProfileLive = checkedMultiSourceSession !== null;

  // Get the session for the checked profile (if any) to check its state
  const checkedProfileSession = checkedSourceId ? getSessionForProfile(checkedSourceId) : undefined;
  const isCheckedProfileStopped = checkedProfileSession?.ioState === "stopped";
  const isCheckedProfileBuffer = checkedProfileSession?.capabilities?.traits?.temporal_mode === "buffer";

  // DEBUG: log source picker state for buffer session diagnosis
  if (checkedSourceId && checkedProfileSession) {
    console.log("[SourcePicker] checkedSourceId:", checkedSourceId,
      "ioState:", checkedProfileSession.ioState,
      "temporal_mode:", checkedProfileSession.capabilities?.traits?.temporal_mode,
      "isLive:", isCheckedProfileLive,
      "isStopped:", isCheckedProfileStopped,
      "isBuffer:", isCheckedProfileBuffer,
      "inActiveMultiSource:", activeMultiSourceSessions.some((s) => s.sessionId === checkedSourceId));
  }

  // Find if there's a live multi-source session for the selected profiles (multi-bus mode)
  const liveMultiSourceSession = useMemo(() => {
    if (checkedSourceIds.length === 0) return null;
    // Find a session whose source profiles match our selection
    return activeMultiSourceSessions.find((session) => {
      const sessionProfileIds = session.brokerConfigs?.map((c) => c.profileId) || [];
      // Check if selected profiles are a subset of or match the session's profiles
      return checkedSourceIds.every((id) => sessionProfileIds.includes(id));
    }) || null;
  }, [checkedSourceIds, activeMultiSourceSessions]);

  const isMultiSourceLive = liveMultiSourceSession !== null;

  // Load bookmarks and buffers when dialog opens.
  // Guarded by didInitForOpenRef so we only run the initialisation once per
  // open cycle — re-running it while open would reset `hasUserExpandedRef`
  // and re-collapse the source list after the user clicks "Change".
  useEffect(() => {
    if (!isOpen) {
      didInitForOpenRef.current = false;
      return;
    }
    if (didInitForOpenRef.current) return;
    didInitForOpenRef.current = true;
    {
      getAllFavorites().then(setBookmarks).catch(console.error);
      // Refresh known buffer IDs so isCaptureProfileId() is up-to-date
      useSessionStore.getState().loadCaptureIds();
      // Load all buffers from the registry and initialize selected buffer
      listOrphanedCaptures().then((loadedBuffers) => {
        setBuffers(loadedBuffers);
        // If a specific buffer is selected (e.g., "xk9m2p"), use that
        // Otherwise if legacy buffer ID is selected, use the most recent buffer
        if (isCaptureProfileId(selectedId) && loadedBuffers.length > 0) {
          // Check if selectedId matches a specific buffer (e.g., "xk9m2p")
          const matchingBuffer = loadedBuffers.find(b => b.id === selectedId);
          if (matchingBuffer) {
            setSelectedBufferId(matchingBuffer.id);
            // Probe buffer to populate shared bus config maps
            probeDevice(matchingBuffer.id)
              .then((result) => {
                setDeviceProbeResultMap((prev) => new Map(prev).set(matchingBuffer.id, result));
                const busList = matchingBuffer.buses.length > 0 ? matchingBuffer.buses : [0];
                const mappings: BusMapping[] = busList.map((bus) => ({
                  deviceBus: bus,
                  enabled: true,
                  outputBus: bus,
                  interfaceId: `can${bus}`,
                  traits: {
                    temporal_mode: "timeline" as TemporalMode,
                    protocols: ["can", "canfd"] as Protocol[],
                    tx_frames: false,
                    tx_bytes: false,
                    multi_source: false,
                  },
                }));
                setDeviceBusConfigMap((prev) => new Map(prev).set(matchingBuffer.id, mappings));
              })
              .catch(console.error);
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
      // Speed 0 means unlimited (load mode) - not valid for Watch, so default to 1x
      setSelectedSpeed(externalLoadSpeed && externalLoadSpeed > 0 ? externalLoadSpeed : 1);
      setFramingConfig(null);
      // If currently loading, pre-select that profile; otherwise use currently selected profile
      // Buffer IDs should NOT go into checkedReaderId — they use selectedCaptureId instead
      const initialReaderId = loadProfileId ?? selectedId;
      if (initialReaderId && isCaptureProfileId(initialReaderId)) {
        setCheckedReaderId(null);
      } else {
        setCheckedReaderId(initialReaderId);
      }
      setImportError(null);

      // Initialize multi-bus selection state
      if (selectedIds.length > 0) {
        setCheckedReaderIds(selectedIds);
        setCheckedReaderId(null);
      } else {
        setCheckedReaderIds([]);
      }
      setValidationError(null);
      hasUserExpandedRef.current = false;

      // Reset multi-select maps and probed profiles ref
      // (buffer probe results will be populated after listOrphanedCaptures completes)
      setDeviceProbeResultMap(new Map());
      setDeviceProbeLoadingMap(new Map());
      setDeviceBusConfigMap(new Map());
      setSingleBusOverrideMap(new Map());
      probedProfilesRef.current.clear();
    }
  // Only `isOpen` is a real dep — loadProfileId/selectedId/selectedIds are
  // captured for initial values on open and must NOT retrigger the effect
  // (see didInitForOpenRef guard above), since parent re-renders during a
  // running capture can change their identities without meaningful value
  // changes, which would re-collapse the picker after the user clicks Change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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
      listOrphanedCaptures().then(setBuffers).catch(console.error);
    }, pollInterval);

    return () => clearInterval(intervalId);
  }, [isOpen, buffers]);

  // Listen for buffer changes from other windows while dialog is open
  useEffect(() => {
    if (!isOpen) return;
    const unlistenFns: (() => void)[] = [];
    const setup = async () => {
      // Refresh buffer list on delete/clear/import from another window
      const u1 = await listen<CaptureChangedPayload>(WINDOW_EVENTS.BUFFER_CHANGED, () => {
        listOrphanedCaptures().then(setBuffers).catch(console.error);
        useSessionStore.getState().loadCaptureIds();
      });
      unlistenFns.push(u1);
      // Refresh buffer list on rename/pin from another window
      const u2 = await listen(WINDOW_EVENTS.BUFFER_METADATA_UPDATED, () => {
        listOrphanedCaptures().then(setBuffers).catch(console.error);
      });
      unlistenFns.push(u2);
    };
    setup();
    return () => unlistenFns.forEach(fn => fn());
  }, [isOpen]);

  // Fetch active joinable sessions when dialog opens and periodically refresh
  // Includes multi_source sessions AND recorded sessions (like PostgreSQL)
  // Also fetches profile usage info for showing "(in use)" indicators
  useEffect(() => {
    if (!isOpen) return;

    const fetchSessions = async () => {
      try {
        const sessions = await listActiveSessions();
        console.log("[IoSourcePickerDialog] All active sessions:", sessions);
        // Show joinable sessions:
        // - traits.multi_source: sources that can be combined (all realtime)
        // - buffer: sessions switched to buffer replay (e.g., stopped live sessions)
        // - supports_time_range && !is_realtime: recorded sources like PostgreSQL
        const joinableSessions = sessions.filter((s) =>
          s.capabilities.traits.multi_source === true ||
          s.sourceType === "buffer" ||
          (s.capabilities.supports_time_range && s.capabilities.traits.temporal_mode === "timeline")
        );
        console.log("[IoSourcePickerDialog] Joinable sessions:", joinableSessions);
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
        console.error("[IoSourcePickerDialog] Error fetching sessions:", err);
      }
    };

    // Fetch immediately
    fetchSessions();

    // Refresh periodically
    const intervalId = setInterval(fetchSessions, 2000);

    return () => clearInterval(intervalId);
  }, [isOpen, ioProfiles]);

  // After activeMultiSourceSessions loads, if current source is a buffer with an
  // active session, set checkedReaderId so the collapsed view shows it
  useEffect(() => {
    if (!isOpen) return;
    if (!selectedId || !isCaptureProfileId(selectedId)) return;
    if (checkedSourceId !== null) return;
    if (hasUserExpandedRef.current) return;

    const bufferSession = activeMultiSourceSessions.find(
      (s) => s.sessionId === selectedId
    );
    if (bufferSession) {
      setCheckedReaderId(selectedId);
    }
  }, [isOpen, selectedId, checkedSourceId, activeMultiSourceSessions]);

  // Filter bookmarks for the checked profile
  const profileBookmarks = useMemo(() => {
    if (!checkedSourceId || checkedSourceId === CSV_EXTERNAL_ID) return [];
    return bookmarks.filter((b) => b.profileId === checkedSourceId);
  }, [bookmarks, checkedSourceId]);

  // Multi-bus mode is active when at least one profile is selected in multi-select
  const isMultiBusMode = checkedSourceIds.length > 0;

  // Probe all real-time devices in multi-bus mode
  useEffect(() => {
    if (!isOpen || checkedSourceIds.length === 0) {
      return;
    }

    // Find real-time profiles among the selected ones
    const realtimeProfileIds = checkedSourceIds.filter((id) => {
      const profile = readProfiles.find((p) => p.id === id);
      return profile && isRealtimeProfile(profile);
    });

    if (realtimeProfileIds.length === 0) {
      // No real-time profiles selected, clear the maps and ref
      setDeviceProbeResultMap(new Map());
      setDeviceProbeLoadingMap(new Map());
      setDeviceBusConfigMap(new Map());
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
    setDeviceBusConfigMap((prev) => {
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
      const isMultiBus = profile ? isMultiBusProfile(profile) : false;

      // Calculate output bus offset based on position in selection list
      const outputBusOffset = profileIndex;

      // Helper: build profile-aware bus mappings with output bus offset
      const buildProfileBusMappings = (busCount: number) => {
        if (profile && isMultiBus) {
          // Use profile-aware mappings (correct deviceBus + per-interface protocols)
          return buildDefaultBusMappings(profile).map((m, i) => ({
            ...m,
            outputBus: outputBusOffset + i,
          }));
        }
        return createDefaultBusMappings(busCount, outputBusOffset);
      };

      if (isLive && !isStopped) {
        // Use default config for live session
        probedProfilesRef.current.add(profileId);
        setDeviceProbeResultMap((prev) => new Map(prev).set(profileId, {
          success: true,
          sourceType: isMultiBus ? "multi" : "single",
          isMultiBus,
          busCount: isMultiBus ? (profile ? buildDefaultBusMappings(profile).length : 5) : 1,
          primaryInfo: "Session active",
          secondaryInfo: null,
          supports_fd: null,
          error: null,
        }));
        if (isMultiBus) {
          setDeviceBusConfigMap((prev) => new Map(prev).set(profileId, buildProfileBusMappings(5)));
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
            setDeviceBusConfigMap((prev) => new Map(prev).set(profileId, buildProfileBusMappings(result.busCount)));
          } else {
            setSingleBusOverrideMap((prev) => new Map(prev).set(profileId, outputBusOffset));
          }
        })
        .catch((err) => {
          console.error(`[IoSourcePickerDialog] Probe failed for ${profileId}:`, err);
          setDeviceProbeResultMap((prev) => new Map(prev).set(profileId, {
            success: false,
            sourceType: isMultiBus ? "multi" : "unknown",
            isMultiBus,
            busCount: 0,
            primaryInfo: null,
            secondaryInfo: null,
            supports_fd: null,
            error: String(err),
          }));
          if (isMultiBus) {
            setDeviceBusConfigMap((prev) => new Map(prev).set(profileId, buildProfileBusMappings(5)));
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
  }, [isOpen, checkedSourceIds, readProfiles]);

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      unlistenRefs.current.forEach((unlisten) => unlisten());
      unlistenRefs.current = [];
    };
  }, []);

  // Handle load completion (internal state only)
  const handleInternalLoadComplete = useCallback(
    async (payload: StreamEndedInfo) => {
      console.log("Load complete:", payload);
      setInternalIsLoading(false);
      setInternalLoadProfileId(null);

      // Cleanup listeners
      unlistenRefs.current.forEach((unlisten) => unlisten());
      unlistenRefs.current = [];

      // Destroy the load session using the tracked session ID
      const sessionId = internalLoadSessionIdRef.current;
      if (sessionId) {
        try {
          await destroyReaderSession(sessionId);
        } catch (e) {
          console.error("Failed to destroy load session:", e);
        }
        internalLoadSessionIdRef.current = null;
      }

      if (payload.capture_available && payload.count > 0) {
        // Refresh the buffer list
        const allBuffers = await listOrphanedCaptures();
        setBuffers(allBuffers);

        // Get the specific buffer that was created (if we have its ID)
        if (payload.capture_id) {
          const meta = allBuffers.find((b) => b.id === payload.capture_id);
          if (meta) {
            onImport?.(meta);

            // Notify other windows that buffer has changed
            const bufferPayload: CaptureChangedPayload = {
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

  // Start loading from a profile (internal state mode)
  const handleInternalStartLoad = async (profileId: string, options: LoadOptions) => {
    setInternalLoadError(null);
    setInternalLoadFrameCount(0);

    // Generate unique session ID for this load
    const sessionId = generateLoadSessionId();
    internalLoadSessionIdRef.current = sessionId;

    try {
      // Set up event listeners for this session
      const unlistenStreamEnded = await listen<void>(
        `stream-ended:${sessionId}`,
        async () => {
          const { getStreamEndedInfo } = await import("../api/io");
          const info = await getStreamEndedInfo(sessionId);
          if (info) {
            handleInternalLoadComplete(info);
          }
        }
      );
      const unlistenError = await listen<void>(`session-error:${sessionId}`, async () => {
        const { getSessionError } = await import("../api/io");
        const error = await getSessionError(sessionId);
        if (error) {
          setInternalLoadError(error);
        }
      });
      const unlistenFrames = await listen<void>(`frames-ready:${sessionId}`, async () => {
        // Fetch current buffer count from backend
        try {
          const session = useSessionStore.getState().sessions[sessionId];
          const captureId = session?.capture?.id;
          if (captureId) {
            const { getCaptureMetadata } = await import("../api/capture");
            const meta = await getCaptureMetadata(captureId);
            if (meta) {
              setInternalLoadFrameCount(meta.count);
            }
          }
        } catch {
          // Buffer may not exist yet
        }
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

      setInternalIsLoading(true);
      setInternalLoadProfileId(profileId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInternalLoadError(msg);
      internalLoadSessionIdRef.current = null;
      // Cleanup on error
      unlistenRefs.current.forEach((unlisten) => unlisten());
      unlistenRefs.current = [];
    }
  };

  // Build load options from current state
  const buildLoadOptions = (speed: number): LoadOptions => {
    const opts: LoadOptions = { speed };

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

    console.log("[buildLoadOptions] Built options:", opts);
    console.log("[buildLoadOptions] framingConfig state:", framingConfig);

    return opts;
  };

  // Handle Load button - runs at max speed (speed=0), keeps dialog open
  const handleLoadClick = () => {
    if (!checkedSourceId || !checkedProfile) return;
    const options = buildLoadOptions(0); // 0 = max speed / no limit
    if (useExternalState) {
      onStartLoad?.(checkedSourceId, false, options);
    } else {
      handleInternalStartLoad(checkedSourceId, options);
    }
  };

  // Handle Watch button - uses selected speed, closes dialog
  const handleConnectClick = () => {
    if (!checkedSourceId || !checkedProfile) return;
    const options = buildLoadOptions(selectedSpeed);
    if (useExternalState) {
      onStartLoad?.(checkedSourceId, true, options);
    } else {
      handleInternalStartLoad(checkedSourceId, options);
    }
    onClose();
  };

  // Handle Connect for buffer source - passes bus mappings through options
  const handleBufferConnectClick = () => {
    // Use selectedCaptureId (from clicking a buffer in the list)
    // or fall back to checkedSourceId (when dialog reopens with buffer pre-selected)
    const captureId = selectedCaptureId ?? checkedSourceId;
    if (!captureId) return;
    const options = buildLoadOptions(selectedSpeed);
    // Attach buffer bus mappings from shared device config map
    const bufferMappings = deviceBusConfigMap.get(captureId);
    if (bufferMappings && bufferMappings.length > 0) {
      const busMappings = new Map<string, BusMapping[]>();
      busMappings.set(captureId, bufferMappings);
      options.busMappings = busMappings;
    }
    if (useExternalState) {
      onStartLoad?.(captureId, true, options);
    } else {
      handleInternalStartLoad(captureId, options);
    }
    onClose();
  };

  // Handle Join button - join an existing live session (no options needed)
  // This also handles joining active multi-source sessions
  const handleJoinClick = () => {
    if (onJoinSession && checkedSourceId) {
      // Check if this is a multi-source session and get source profile IDs
      const multiSourceSession = activeMultiSourceSessions.find((s) => s.sessionId === checkedSourceId);
      const sourceProfileIds = multiSourceSession?.brokerConfigs?.map((c) => c.profileId);
      onJoinSession(checkedSourceId, sourceProfileIds);
    }
    onClose();
  };

  // Handle Resume button - start a stopped session and join it
  const handleStartClick = async () => {
    if (checkedProfileSession) {
      try {
        await startSession(checkedProfileSession.id);
        // After starting, join the session
        if (onJoinSession && checkedSourceId) {
          onJoinSession(checkedSourceId);
        }
        onClose();
      } catch (e) {
        console.error("Failed to start session:", e);
      }
    }
  };

  // Handle Restart button - destroy existing session and start a new one with updated config
  const handleRestartClick = async () => {
    if (!checkedSourceId || !checkedProfile) return;

    // Destroy the existing session first
    const existingSession = getSessionForProfile(checkedSourceId);
    if (existingSession) {
      try {
        await destroyReaderSession(existingSession.id);
      } catch (e) {
        console.error("Failed to destroy existing session:", e);
        // Continue anyway - maybe it was already destroyed
      }
    }

    // Now start a new session with the updated config
    const options = buildLoadOptions(selectedSpeed);
    if (useExternalState) {
      onStartLoad?.(checkedSourceId, true, options);
    } else {
      handleInternalStartLoad(checkedSourceId, options);
    }
    onClose();
  };

  // Handle Multi-Bus Restart button - destroy existing multi-source session and create a new one
  const handleMultiRestartClick = async () => {
    if (checkedSourceIds.length === 0) return;

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

  // Stop loading
  const handleStopLoad = async () => {
    if (useExternalState) {
      onStopLoad?.();
    } else {
      const sessionId = internalLoadSessionIdRef.current;
      if (!sessionId) return;
      try {
        await stopReaderSession(sessionId);
        // The stream-ended event will handle the rest
      } catch (e) {
        console.error("Failed to stop load:", e);
        // Force cleanup
        setInternalIsLoading(false);
        setInternalLoadProfileId(null);
        internalLoadSessionIdRef.current = null;
        unlistenRefs.current.forEach((unlisten) => unlisten());
        unlistenRefs.current = [];
      }
    }
  };

  // Handle speed change
  const handleSpeedChange = (speed: number) => {
    setSelectedSpeed(speed);
    if (useExternalState) {
      onLoadSpeedChange?.(speed);
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
    if (checkedSourceId && checkedSourceId !== CSV_EXTERNAL_ID) {
      const session = getSessionForProfile(checkedSourceId);
      if (session) {
        try {
          await unregisterSessionListener(session.id, listenerId);
        } catch (e) {
          console.error("Failed to unregister from session:", e);
        }
      }
    }

    // Multi-select mode: unregister from sessions for all checked profiles
    for (const profileId of checkedSourceIds) {
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

    // Reset load options
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
    setDeviceBusConfigMap(new Map());
    setSingleBusOverrideMap(new Map());
    probedProfilesRef.current.clear();

    // Clear import error
    setImportError(null);
  };

  // Handle Watch button for multi-bus mode
  const handleMultiWatchClick = () => {
    if (checkedSourceIds.length === 0) return;
    const options = buildLoadOptions(selectedSpeed);

    // Build combined bus mappings from both GVRET and single-bus devices
    const combinedBusMappings = new Map<string, BusMapping[]>();

    // Add multi-bus device mappings (GVRET, FrameLink, virtual, etc.)
    for (const [profileId, mappings] of deviceBusConfigMap.entries()) {
      combinedBusMappings.set(profileId, mappings);
    }

    // Convert single-bus device overrides to BusMapping format
    for (const [profileId, outputBus] of singleBusOverrideMap.entries()) {
      const profile = readProfiles.find(p => p.id === profileId);
      const readerProtocols = profile ? getReaderProtocols(profile.kind, profile.connection) : ['can'];
      const protocol = readerProtocols[0] || 'can';

      combinedBusMappings.set(profileId, [{
        deviceBus: 0,
        enabled: true,
        outputBus,
        interfaceId: `${protocol}0`,
        traits: {
          temporal_mode: 'realtime',
          protocols: (protocol === 'can' ? ['can', 'canfd'] : [protocol]) as Protocol[],
          tx_frames: true,
          tx_bytes: false,
          multi_source: true,
        },
      }]);
    }

    // Fallback: checked profiles not in either map get default bus mappings
    // (e.g., modbus_tcp profiles that aren't GVRET or single-bus override devices)
    for (const profileId of checkedSourceIds) {
      if (!combinedBusMappings.has(profileId)) {
        const profile = readProfiles.find(p => p.id === profileId);
        if (profile) {
          combinedBusMappings.set(profileId, buildDefaultBusMappings(profile));
        }
      }
    }

    options.busMappings = combinedBusMappings;

    // Pass per-interface framing configs (for serial profiles)
    if (framingConfigMap.size > 0) {
      options.perInterfaceFraming = framingConfigMap;
    }

    console.log("[IoSourcePickerDialog] handleMultiConnectClick - bus mappings:", {
      checkedSourceIds,
      combinedBusMappingsSize: combinedBusMappings.size,
      combinedBusMappingsEntries: Array.from(combinedBusMappings.entries()).map(([k, v]) => ({
        profileId: k,
        mappings: v,
      })),
      perInterfaceFramingSize: framingConfigMap.size,
    });
    if (onStartMultiLoad) {
      onStartMultiLoad(checkedSourceIds, true, options);
    }
    onSelectMultiple?.(checkedSourceIds);
    onClose();
  };

  const handleImport = async () => {
    setImportError(null);
    setIsImporting(true);

    try {
      const filePaths = await pickCsvFilesToOpen(defaultDir);
      if (!filePaths || filePaths.length === 0) {
        setIsImporting(false);
        return;
      }

      if (filePaths.length === 1) {
        // Single file — go straight to column mapper
        setCsvMapperFilePath(filePaths[0]);
        setCsvMapperFilePaths(null);
        setCsvImportSessionId(generateLoadSessionId());
        setShowCsvMapper(true);
      } else {
        // Multiple files — show order confirmation first
        setPendingFilePaths(filePaths);
        setShowFileOrderDialog(true);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setImportError(msg);
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileOrderConfirm = (orderedPaths: string[], hasHeaderPerFile: boolean[]) => {
    setShowFileOrderDialog(false);
    setPendingFilePaths(null);

    // Open column mapper with first file for preview, all files for batch import
    setCsvMapperFilePath(orderedPaths[0]);
    setCsvMapperFilePaths(orderedPaths);
    setCsvHasHeaderPerFile(hasHeaderPerFile);
    setCsvImportSessionId(generateLoadSessionId());
    setShowCsvMapper(true);
  };

  const handleFileOrderCancel = () => {
    setShowFileOrderDialog(false);
    setPendingFilePaths(null);
  };

  const handleCsvMapperComplete = async (metadata: CaptureMetadata) => {
    setShowCsvMapper(false);
    setCsvMapperFilePath(null);
    setCsvMapperFilePaths(null);
    setCsvHasHeaderPerFile(null);
    setCsvImportSessionId(null);

    // Refresh buffer list
    const allBuffers = await listOrphanedCaptures();
    setBuffers(allBuffers);

    onImport?.(metadata);

    // Register the new capture id so isCaptureProfileId() recognises it.
    // Without this, the onSelect(metadata.id) → handleIoProfileChange call
    // below takes the non-buffer branch and skips the capture-load pipeline
    // that populates frameInfoMap (tooltip/frame picker/Tools button).
    useSessionStore.getState().addKnownCaptureId(metadata.id);

    // Notify other windows that buffer has changed
    const payload: CaptureChangedPayload = {
      metadata,
      timestamp: Date.now(),
    };
    await emit(WINDOW_EVENTS.BUFFER_CHANGED, payload);

    // Auto-select the buffer and close
    onSelect(metadata.id);
    onClose();
  };

  const handleCsvMapperCancel = () => {
    setShowCsvMapper(false);
    setCsvMapperFilePath(null);
    setCsvMapperFilePaths(null);
    setCsvHasHeaderPerFile(null);
    setCsvImportSessionId(null);
  };

  // Delete a specific buffer by ID
  const handleDeleteBuffer = async (captureId: string) => {
    try {
      await deleteCapture(captureId);

      // Remove from known buffer IDs so isCaptureProfileId() stops matching
      useSessionStore.getState().removeKnownCaptureId(captureId);

      // Refresh buffer list
      const allBuffers = await listOrphanedCaptures();
      setBuffers(allBuffers);

      // If no buffers left and buffer was selected, clear selection
      if (allBuffers.length === 0 && isCaptureProfileId(selectedId)) {
        onSelect(null);
      }

      // Notify other windows that buffer has been deleted
      const payload: CaptureChangedPayload = {
        metadata: null,
        deletedBufferIds: [captureId],
        timestamp: Date.now(),
      };
      await emit(WINDOW_EVENTS.BUFFER_CHANGED, payload);
    } catch (e) {
      console.error("Failed to delete buffer:", e);
    }
  };

  // Clear all non-streaming, non-persistent buffers
  const handleClearAllBuffers = async () => {
    try {
      // Only delete buffers that are not streaming and not pinned
      const clearableBuffers = buffers.filter(b => !b.is_streaming && !b.persistent);
      for (const buffer of clearableBuffers) {
        await deleteCapture(buffer.id);
        useSessionStore.getState().removeKnownCaptureId(buffer.id);
      }

      // Refresh buffer list (keep streaming and persistent buffers)
      const keptBuffers = buffers.filter(b => b.is_streaming || b.persistent);
      setBuffers(keptBuffers);

      // If buffer was selected and it was deleted, clear selection
      const deletedIds = new Set(clearableBuffers.map(b => b.id));
      if (isCaptureProfileId(selectedId)) {
        // Check if the selected buffer was deleted
        const selectedBuffer = buffers.find(b => b.id === selectedId);
        if (selectedBuffer && deletedIds.has(selectedBuffer.id)) {
          onSelect(null);
        }
      }

      // Notify other windows that buffers have been cleared
      const payload: CaptureChangedPayload = {
        metadata: null,
        deletedBufferIds: clearableBuffers.map(b => b.id),
        timestamp: Date.now(),
      };
      await emit(WINDOW_EVENTS.BUFFER_CHANGED, payload);
    } catch (e) {
      console.error("Failed to clear buffers:", e);
    }
  };

  // Select a specific orphaned buffer (local dialog state only — no session created yet)
  const handleSelectBuffer = async (captureId: string) => {
    try {
      await setActiveCapture(captureId);
      setCheckedReaderId(null);
      setSelectedBufferId(captureId);
      // Don't call onSelect here — that triggers session creation in the parent.
      // Buffer sessions are only created when the user clicks Connect.

      // Probe buffer to populate shared bus config maps
      probeBuffer(captureId);
    } catch (e) {
      console.error("Failed to set active buffer:", e);
    }
  };

  const isBufferSelected = isCaptureProfileId(selectedId) || selectedCaptureId !== null;

  // Check if a bytes buffer is selected (for framing options)
  const selectedBuffer = selectedCaptureId ? buffers.find((b) => b.id === selectedCaptureId) : null;
  const isBytesBufferSelected = selectedBuffer?.kind === "bytes" && !checkedSourceId;

  // Handle OK button click for buffer selection - pass framing config if configured
  const handleBufferOkClick = () => {
    if (isBytesBufferSelected && onBufferFramingConfig) {
      onBufferFramingConfig(framingConfig);
    }
    onClose();
  };

  return (
    <>
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

        <LoadStatus
          isLoading={isLoading}
          loadFrameCount={loadFrameCount}
          loadError={loadError}
          onStopLoad={handleStopLoad}
        />

        <div className="max-h-[60vh] overflow-y-auto">
          <SourceList
            ioProfiles={ioProfiles}
            checkedSourceId={checkedSourceId}
            checkedSourceIds={checkedSourceIds}
            defaultId={defaultId}
            isLoading={isLoading}
            bufferNames={new Map(buffers.map((b) => [b.id, b.name]))}
            onSelectSource={(id) => {
              if (id === null) {
                hasUserExpandedRef.current = true;
              }
              setCheckedReaderId(id);
              // Clear multi-bus selection when selecting a single profile
              // (ensures mutual exclusivity between single-select and multi-select)
              setCheckedReaderIds([]);
              setValidationError(null);
              if (id !== null) {
                setSelectedBufferId(null);
              }
            }}
            onToggleSource={handleToggleReader}
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
              const isDeviceMultiBus = isMultiBusProfile(profile);
              // Check if config is locked for this profile (in use by 2+ sessions)
              const usageInfo = profileUsage.get(profileId);
              const configLocked = usageInfo?.configLocked ?? false;

              // Collect output buses used by OTHER profiles for duplicate detection
              const usedOutputBuses = new Set<number>();
              for (const [otherId, otherConfig] of deviceBusConfigMap.entries()) {
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

              // Multi-bus devices - show DeviceBusConfig
              if (isDeviceMultiBus || probeResult?.isMultiBus) {
                let busConfig = deviceBusConfigMap.get(profileId);
                if (!busConfig && probeResult) {
                  const profileIndex = checkedSourceIds.indexOf(profileId);
                  const offset = profileIndex >= 0 ? profileIndex : 0;
                  // Use profile-aware mappings for devices with interfaces[]
                  busConfig = isDeviceMultiBus
                    ? buildDefaultBusMappings(profile).map((m, i) => ({ ...m, outputBus: offset + i }))
                    : createDefaultBusMappings(probeResult.busCount || 5, offset);
                }
                busConfig = busConfig || [];

                // Create GvretDeviceInfo-compatible object from probe result
                const deviceInfo: GvretDeviceInfo | null = probeResult
                  ? { bus_count: probeResult.busCount || 5 }
                  : null;

                return (
                  <DeviceBusConfig
                    deviceInfo={deviceInfo}
                    isLoading={isLoading}
                    error={probeResult?.error || null}
                    busConfig={busConfig}
                    onBusConfigChange={(config) => {
                      setDeviceBusConfigMap((prev) => new Map(prev).set(profileId, config));
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
            renderAfterSessions={!hideBuffers ? (
              <CaptureList
                buffers={buffers}
                selectedCaptureId={selectedCaptureId}
                checkedSourceId={checkedSourceId}
                checkedSourceIds={checkedSourceIds}
                onSelectBuffer={handleSelectBuffer}
                onDeleteBuffer={handleDeleteBuffer}
                onClearAllBuffers={handleClearAllBuffers}
                onBufferRenamed={() => listOrphanedCaptures().then(setBuffers).catch(console.error)}
                onBufferPersistenceChanged={() => listOrphanedCaptures().then(setBuffers).catch(console.error)}
                busConfig={selectedCaptureId ? deviceBusConfigMap.get(selectedCaptureId) : undefined}
                onBusConfigChange={(config) => {
                  if (selectedCaptureId) {
                    setDeviceBusConfigMap((prev) => new Map(prev).set(selectedCaptureId, config));
                  }
                }}
                isProbing={selectedCaptureId ? deviceProbeLoadingMap.get(selectedCaptureId) ?? false : false}
                probeError={selectedCaptureId ? deviceProbeResultMap.get(selectedCaptureId)?.error ?? null : null}
                activeSessionBufferMap={new Map(
                  activeMultiSourceSessions
                    .filter((s) => s.sourceType === "buffer")
                    .flatMap((s) => {
                      const entries: [string, string][] = [[s.sessionId, s.sessionId]];
                      if (s.captureId) entries.push([s.captureId, s.sessionId]);
                      return entries;
                    })
                )}
              />
            ) : undefined}
          />

          {/* Show load options when creating a new session */}
          {/* Hide when: connect mode, joining an existing session, or nothing selected */}
          {mode !== "connect" && (checkedSourceId || isMultiBusMode) && !checkedMultiSourceSession && (
            <>
              <LoadOptions
                checkedSourceId={checkedSourceId}
                checkedProfile={checkedProfile}
                isLoading={isLoading}
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
                    checkedSourceIds={checkedSourceIds}
                    isLoading={isLoading}
                    framingConfig={framingConfig}
                    onFramingConfigChange={setFramingConfig}
                    isBytesBufferSelected={isBytesBufferSelected}
                  />

                  <FilterOptions
                    checkedProfile={checkedProfile}
                    ioProfiles={ioProfiles}
                    checkedSourceIds={checkedSourceIds}
                    isLoading={isLoading}
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
          isLoading={isLoading}
          loadProfileId={loadProfileId}
          checkedSourceId={checkedSourceId}
          checkedProfile={checkedProfile}
          isBufferSelected={isBufferSelected}
          isCheckedProfileLive={isCheckedProfileLive || (isCheckedProfileStopped && isCheckedProfileBuffer)}
          isCheckedProfileStopped={isCheckedProfileStopped && !isCheckedProfileBuffer}
          isImporting={isImporting}
          importError={importError}
          onImport={handleImport}
          onLoadClick={handleLoadClick}
          onConnectClick={handleConnectClick}
          onJoinClick={handleJoinClick}
          onStartClick={handleStartClick}
          onClose={handleBufferOkClick}
          onSkip={onSkip}
          multiSelectMode={isMultiBusMode}
          multiSelectCount={checkedSourceIds.length}
          onMultiConnectClick={handleMultiWatchClick}
          onRelease={listenerId && (isCheckedProfileLive || (isCheckedProfileStopped && isCheckedProfileBuffer)) ? handleRelease : undefined}
          // Only show Restart for profiles, not for selecting existing sessions
          onRestartClick={isCheckedProfileLive && !isCheckedProfileStopped && !checkedMultiSourceSession ? handleRestartClick : undefined}
          isMultiSourceLive={isMultiSourceLive}
          onMultiRestartClick={isMultiSourceLive ? handleMultiRestartClick : undefined}
          onBufferConnectClick={selectedCaptureId ? handleBufferConnectClick : undefined}
          onConnectOnlyClick={checkedSourceId && onConnect ? () => {
            onConnect(checkedSourceId);
            onClose();
          } : undefined}
        />
      </div>
    </Dialog>

    {/* File order dialog (opens when multiple files selected) */}
    {showFileOrderDialog && pendingFilePaths && (
      <CsvFileOrderDialog
        isOpen={showFileOrderDialog}
        filePaths={pendingFilePaths}
        onConfirm={handleFileOrderConfirm}
        onCancel={handleFileOrderCancel}
      />
    )}

    {/* CSV column mapper dialog (opens after file pick or order confirmation) */}
    {showCsvMapper && csvMapperFilePath && csvImportSessionId && (
      <CsvColumnMapperDialog
        isOpen={showCsvMapper}
        filePath={csvMapperFilePath}
        allFilePaths={csvMapperFilePaths ?? undefined}
        hasHeaderPerFile={csvHasHeaderPerFile ?? undefined}
        sessionId={csvImportSessionId}
        onCancel={handleCsvMapperCancel}
        onImportComplete={handleCsvMapperComplete}
      />
    )}
    </>
  );
}
