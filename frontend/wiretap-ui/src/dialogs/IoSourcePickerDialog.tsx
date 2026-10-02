// ui/src/dialogs/IoSourcePickerDialog.tsx

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { emit, listen } from "@tauri-apps/api/event";
import Dialog, { DialogBody } from "../components/Dialog";
import { useSettings, type IOProfile } from "../hooks/useSettings";
import { buildCatalogPath } from "../utils/catalogUtils";
import {
  useProfileBusStore,
  profileBusMappings,
  isMultiBusProfile,
  isRealtimeProfile,
} from "../stores/profileBusStore";
import { validateSourceSelection } from "../api/deviceKinds";
import { isCaptureSession, useSessionStore } from "../stores/sessionStore";
import { pickCsvFilesToOpen } from "../api/dialogs";
import { generateSessionId } from "../api/io";
import {
  listOrphanedCaptures,
  deleteCapture,
  setActiveCapture,
  detectCandump,
  importCandump,
  type CaptureMetadata,
  type CandumpImportResult,
} from "../api/capture";
import { CsvColumnMapperDialog } from "./csv-column-mapper";
import CsvFileOrderDialog from "./CsvFileOrderDialog";
import CandumpImportReportDialog from "./CandumpImportReportDialog";
import { WINDOW_EVENTS, type CaptureChangedPayload } from "../events/registry";
import {
  destroyReaderSession,
  unregisterSessionSubscriber,
  probeDevice,
  previewSourceBuses,
  listActiveSessions,
  getProfilesUsage,
  type GvretDeviceInfo,
  type BusMapping,
  type BusOverride,
  type ActiveSessionInfo,
  type DeviceProbeResult,
  type ProfileUsageInfo,
  type FramingMode,
  type ModbusRangeSpec,
} from '../api/io';
import { loadCatalog } from "../utils/catalogParser";
import type { TimeBounds } from "../components/TimeBoundsInput";

// Import extracted components
import { CaptureList } from "./io-source-picker";
import { SourceList } from "./io-source-picker";
import { DecoderPicker } from "./io-source-picker";
import type { SourceTab } from "./io-source-picker";
import { LoadOptions } from "./io-source-picker";
import { ActionButtons } from "./io-source-picker";
import { LoadStatus } from "./io-source-picker";
import DeviceBusConfig from "./io-source-picker/DeviceBusConfig";
import SingleBusConfig from "./io-source-picker/SingleBusConfig";
import ModbusPollConfig, {
  DEFAULT_MODBUS_POLL_CONFIG,
  pollSpecFor,
  type ModbusPollConfigState,
} from "./io-source-picker/ModbusPollConfig";
import { MODBUS_PROFILE_KIND, modbusConnectionOf } from "../utils/modbusProfiles";
import { useConnectionDefaults } from "../hooks/useConnectionDefaults";
import {
  localToIsoWithOffset,
  CSV_EXTERNAL_ID,
} from "./io-source-picker";
import type { InterfaceFramingConfig } from "./io-source-picker";
import { DeviceEditor } from "./io-source-picker";
import { useAdHocProfileStore } from "../stores/adHocProfileStore";
import { useDeviceEditorStore } from "../stores/deviceEditorStore";
import { addDevice } from "../settings/devices";
import type { DeviceDraft } from "../api/ephemeralProfiles";
import { withAppError } from "../utils/appError";

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
  /** What the user changed about each source's buses, keyed by profile ID */
  busOverrides?: Map<string, BusOverride[]>;
  /** Per-interface framing config (for serial profiles in multi-bus mode) - map from profile ID to framing config */
  perInterfaceFraming?: Map<string, InterfaceFramingConfig>;
  /** Catalogue path to attach to the new session (decoder picker) */
  catalogPath?: string | null;
  /**
   * Address ranges for a Modbus session to poll, when no catalogue supplies a
   * poll set. Session-level rather than per-source, because `modbusPollsJson`
   * is: the backend injects one poll plan into every modbus_tcp source.
   */
  modbusRanges?: ModbusRangeSpec;
}

// Stable empty array to avoid re-renders when selectedIds is not provided
const EMPTY_SELECTED_IDS: string[] = [];

function savedFraming(profile: IOProfile | undefined): InterfaceFramingConfig | undefined {
  const encoding = profile?.kind === "serial" ? profile.connection.framing_encoding : undefined;
  return encoding ? { encoding: encoding as FramingMode } : undefined;
}

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
  /** Called when CSV is imported - passes the capture metadata */
  onImport?: (metadata: CaptureMetadata) => void;
  /** Current capture metadata (if any) */
  captureMetadata?: CaptureMetadata | null;
  /** Default directory for file picker */
  defaultDir?: string;
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
  /** Hide captures section (for transmit-only mode) */
  hideCaptures?: boolean;
  /** Hide the Sessions tab (joinable live sessions) - for recorded-only pickers like Query */
  hideSessions?: boolean;
  /** Enable multi-select mode for real-time profiles */
  allowMultiSelect?: boolean;
  /** Map of profile ID to disabled status with reason (for transmit mode) */
  disabledProfiles?: Map<string, { canTransmit: boolean; reason?: string }>;
  /** Called when user wants to continue without selecting a source */
  onSkip?: () => void;
  /** Listener ID for this app (e.g., "discovery", "decoder") - required for Leave button */
  subscriberId?: string;
  /** Called when user clicks Connect in connect mode (creates session without streaming) */
  onConnect?: (profileId: string) => void;
  /** When true, immediately trigger file import on open (for menu shortcut). */
  autoImport?: boolean;
  /** Called after autoImport has been consumed so the parent can reset the flag. */
  onAutoImportConsumed?: () => void;
  /** Initial decoder catalogue path (seeds the decoder picker from the host app). */
  defaultCatalogPath?: string | null;
  /** Called when the decoder catalogue selection changes (lets the host app mirror it). */
  onCatalogSelect?: (path: string | null) => void;
};

/** A capture's buses, one-to-one, as recorded. */
function captureBusMappings(buses: number[]): BusMapping[] {
  return buses.map((bus) => ({
    device_bus: bus,
    enabled: true,
    output_bus: bus,
    interface_id: `can${bus}`,
    protocol: "can",
    supported_protocols: [],
    traits: null,
  }));
}

/** The fields an edit changed against Rust's allocation, kept over earlier edits. */
function editedOverrides(allocated: BusMapping[], edited: BusMapping[], earlier: BusOverride[] = []): BusOverride[] {
  return edited.flatMap((next) => {
    const was = allocated.find((m) => m.device_bus === next.device_bus);
    const override: BusOverride = { ...earlier.find((o) => o.device_bus === next.device_bus), device_bus: next.device_bus };
    if (next.enabled !== was?.enabled) override.enabled = next.enabled;
    if (next.output_bus !== was?.output_bus) override.output_bus = next.output_bus;
    if (next.protocol !== was?.protocol) override.protocol = next.protocol;
    return Object.keys(override).length > 1 ? [override] : [];
  });
}

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
  captureMetadata: _captureMetadata, // Deprecated - dialog now fetches captures directly
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
  hideCaptures = false,
  hideSessions = false,
  allowMultiSelect = false,
  disabledProfiles,
  onSkip,
  subscriberId,
  onConnect,
  autoImport,
  onAutoImportConsumed,
  defaultCatalogPath = null,
  onCatalogSelect,
}: Props) {
  const { t } = useTranslation("dialogs");
  const { settings } = useSettings();
  // Use stable empty array when selectedIds is not provided (avoids re-renders)
  const selectedIds = selectedIdsProp ?? EMPTY_SELECTED_IDS;

  // Get session helpers from session store
  const isProfileInUse = useSessionStore((s) => s.isProfileInUse);
  const getSessionForProfile = useSessionStore((s) => s.getSessionForProfile);
  const startSession = useSessionStore((s) => s.startSession);
  const selectedIsCapture = useSessionStore((s) => isCaptureSession(s, selectedId));

  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // CSV column mapper state
  const [csvMapperFilePath, setCsvMapperFilePath] = useState<string | null>(null);
  const [csvMapperFilePaths, setCsvMapperFilePaths] = useState<string[] | null>(null);
  const [csvImportSessionId, setCsvImportSessionId] = useState<string | null>(null);
  const [showCsvMapper, setShowCsvMapper] = useState(false);
  const [candumpReport, setCandumpReport] = useState<CandumpImportResult | null>(null);
  const [showFileOrderDialog, setShowFileOrderDialog] = useState(false);
  const [pendingFilePaths, setPendingFilePaths] = useState<string[] | null>(null);
  const [csvHasHeaderPerFile, setCsvHasHeaderPerFile] = useState<boolean[] | null>(null);

  // Track auto-import mode (menu shortcut) so cancel closes the dialog
  const autoImportActiveRef = useRef(false);

  // Multi-capture state
  const [captures, setCaptures] = useState<CaptureMetadata[]>([]);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);

  // Source tab (Captures | Devices) — smart default set on open
  const [activeTab, setActiveTab] = useState<SourceTab>("devices");

  // Decoder picker: the catalogue to attach to the new session
  const [selectedCatalogPath, setSelectedCatalogPath] = useState<string | null>(defaultCatalogPath);
  // Once the user picks or clears a decoder, stop auto-filling from a source's
  // preferred catalogue (so a deliberate clear isn't undone). Reset on open.
  const decoderUserTouchedRef = useRef(false);

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
  const [selectedSpeed, setSelectedSpeed] = useState(1); // Default to 1x realtime with pacing

  // Multi-bus mode - per-profile maps for device probing and configuration
  const [deviceProbeResultMap, setDeviceProbeResultMap] = useState<Map<string, DeviceProbeResult>>(new Map());
  const [deviceProbeLoadingMap, setDeviceProbeLoadingMap] = useState<Map<string, boolean>>(new Map());
  const [captureBusConfigMap, setCaptureBusConfigMap] = useState<Map<string, BusMapping[]>>(new Map());
  // What the user changed about a source's buses, and Rust's allocation with those changes applied.
  const [busOverrides, setBusOverrides] = useState<Map<string, BusOverride[]>>(new Map());
  const [busAllocation, setBusAllocation] = useState<Map<string, BusMapping[]>>(new Map());
  // Per-profile framing config (for serial profiles in multi-bus mode)
  const [framingConfigMap, setFramingConfigMap] = useState<Map<string, InterfaceFramingConfig>>(new Map());
  // What a Modbus session should read. Session-level, like `modbusPollsJson`.
  const [modbusPoll, setModbusPoll] = useState<ModbusPollConfigState>(DEFAULT_MODBUS_POLL_CONFIG);
  // Serial framing declared by the selected decoder's catalogue (drives the
  // framing dropdown for serial sources). Null when the decoder has no framing.
  const [catalogSerialEncoding, setCatalogSerialEncoding] = useState<FramingMode | null>(null);
  // Serial profiles whose framing the user changed by hand — excluded from the
  // catalogue-driven framing sync so a manual choice isn't overwritten.
  const framingUserTouchedRef = useRef<Set<string>>(new Set());
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

  // Tab smart-default tracking: whether the user has manually picked a tab, and
  // whether the open had an explicit source selection (suppresses the auto
  // "Sessions" default). Reset on each open in the init effect.
  const tabUserPickedRef = useRef(false);
  const hasExplicitSelectionRef = useRef(false);

  // Active multi-source sessions (for sharing between apps)
  const [activeMultiSourceSessions, setActiveMultiSourceSessions] = useState<ActiveSessionInfo[]>([]);

  // Profile usage info - which sessions are using each profile
  const [profileUsage, setProfileUsage] = useState<Map<string, ProfileUsageInfo>>(new Map());

  const isLoading = externalIsLoading ?? false;
  const loadProfileId = externalLoadProfileId ?? null;
  const loadFrameCount = externalLoadFrameCount ?? 0;
  const loadError = externalLoadError ?? null;

  // Probe a capture. Even a single-bus capture gets a bus mapper ("Bus 0 → Bus 0").
  const probeCapture = useCallback(async (captureId: string) => {
    setDeviceProbeLoadingMap((prev) => new Map(prev).set(captureId, true));
    try {
      const result = await probeDevice(captureId);
      setDeviceProbeResultMap((prev) => new Map(prev).set(captureId, result));
      // Use actual bus numbers from capture metadata (may be non-sequential)
      const capture = captures.find((b) => b.id === captureId);
      const busList = capture?.buses?.length ? capture.buses : [0]; // default to bus 0
      setCaptureBusConfigMap((prev) => new Map(prev).set(captureId, captureBusMappings(busList)));
    } catch (err) {
      console.error(`[IoSourcePickerDialog] Buffer probe failed for ${captureId}:`, err);
      setDeviceProbeResultMap((prev) => new Map(prev).set(captureId, {
        success: false,
        source_type: "capture",
        is_multi_bus: false,
        bus_count: 0,
        primary_info: null,
        secondary_info: null,
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
  }, [captures]);

  // All profiles are read profiles now (mode field removed)
  const readProfiles = ioProfiles;

  // ── Ad-hoc device editor ───────────────────────────────────────────────────
  // Open for a brand-new device, or on an existing one's connection parameters.
  // Creating a device is a picker concern (it needs the kind, the name, and
  // the connect that follows). Editing one is not — that is the shared dialog.
  const [creatingDevice, setCreatingDevice] = useState(false);
  const openDeviceSettings = useDeviceEditorStore((s) => s.open);
  const discardAdHocProfile = useAdHocProfileStore((s) => s.discard);

  // The sources about to start, whichever way they were picked. Single-select
  // keeps `checkedSourceId` and clears the array, so reading only the array
  // silently loses the commonest selection — which it did, for the poll range.
  const selectedSourceIds = useMemo(
    () => (checkedSourceIds.length > 0 ? checkedSourceIds : checkedSourceId ? [checkedSourceId] : []),
    [checkedSourceIds, checkedSourceId]
  );
  /** The Modbus source in that selection, if any — what the poll range applies to. */
  const modbusDefaults = useConnectionDefaults(MODBUS_PROFILE_KIND);
  const modbusProfile = useMemo(
    () => selectedSourceIds
      .map((id) => readProfiles.find((p) => p.id === id))
      .find((p) => p?.kind === MODBUS_PROFILE_KIND),
    [selectedSourceIds, readProfiles]
  );

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
    return activeMultiSourceSessions.find((s) => s.session_id === checkedSourceId) || null;
  }, [checkedSourceId, activeMultiSourceSessions]);

  // Is the checked selection an active session that can be joined?
  // This is ONLY true when the user explicitly selects an Active Session from the list.
  // For profiles (IO Sources), being "in use" is informational only - users can always
  // start new sessions. The Join button only appears for explicitly selected sessions.
  const isCheckedProfileLive = checkedMultiSourceSession !== null;

  // Get the session for the checked profile (if any) to check its state
  const checkedProfileSession = checkedSourceId ? getSessionForProfile(checkedSourceId) : undefined;
  const isCheckedProfileStopped = checkedProfileSession?.ioState === "stopped";
  const isCheckedProfileCapture = checkedProfileSession?.capabilities?.traits?.temporal_mode === "capture";

  // Find if there's a live multi-source session for the selected profiles (multi-bus mode)
  const liveMultiSourceSession = useMemo(() => {
    if (checkedSourceIds.length === 0) return null;
    // Find a session whose source profiles match our selection
    return activeMultiSourceSessions.find((session) => {
      const sessionProfileIds = session.broker_configs?.map((c) => c.profile_id) || [];
      // Check if selected profiles are a subset of or match the session's profiles
      return checkedSourceIds.every((id) => sessionProfileIds.includes(id));
    }) || null;
  }, [checkedSourceIds, activeMultiSourceSessions]);

  const isMultiSourceLive = liveMultiSourceSession !== null;

  // Load captures when dialog opens.
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
      // Load all captures from the registry and initialize selected capture
      listOrphanedCaptures().then((loadedCaptures) => {
        setCaptures(loadedCaptures);
        // If a specific capture is selected (e.g., "xk9m2p"), use that
        // Otherwise if legacy capture ID is selected, use the most recent capture
        if (selectedIsCapture && loadedCaptures.length > 0) {
          // Check if selectedId matches a specific capture (e.g., "xk9m2p")
          const matchingCapture = loadedCaptures.find(b => b.id === selectedId);
          if (matchingCapture) {
            setSelectedCaptureId(matchingCapture.id);
            // Probe capture to populate shared bus config maps
            probeDevice(matchingCapture.id)
              .then((result) => {
                setDeviceProbeResultMap((prev) => new Map(prev).set(matchingCapture.id, result));
                const busList = matchingCapture.buses.length > 0 ? matchingCapture.buses : [0];
                setCaptureBusConfigMap((prev) => new Map(prev).set(matchingCapture.id, captureBusMappings(busList)));
              })
              .catch(console.error);
          } else {
            // Legacy capture ID - fall back to most recent capture
            const sorted = [...loadedCaptures].sort((a, b) => b.created_at - a.created_at);
            setSelectedCaptureId(sorted[0].id);
          }
        } else {
          setSelectedCaptureId(null);
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
      // If currently loading, pre-select that profile; otherwise use currently selected profile
      // Buffer IDs should NOT go into checkedReaderId — they use selectedCaptureId instead
      const initialReaderId = loadProfileId ?? selectedId;
      const initialIsCapture = !loadProfileId && selectedIsCapture;
      if (initialIsCapture) {
        setCheckedReaderId(null);
      } else {
        setCheckedReaderId(initialReaderId);
      }
      setImportError(null);

      // Seed the decoder picker from the host app's current catalogue.
      setSelectedCatalogPath(defaultCatalogPath);
      decoderUserTouchedRef.current = false;
      framingUserTouchedRef.current = new Set();

      // Smart default tab. Provisional choice from the current selection:
      // Captures for a capture/recorded (DB) source, else Devices. The
      // Sessions default is applied separately once active sessions load.
      tabUserPickedRef.current = false;
      hasExplicitSelectionRef.current = !!initialReaderId;
      const selProfile = initialReaderId
        ? ioProfiles.find((p) => p.id === initialReaderId)
        : undefined;
      const isRecordedSel = selProfile ? !isRealtimeProfile(selProfile) : false;
      setActiveTab(initialIsCapture || isRecordedSel ? "captures" : "devices");

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
      // (capture probe results will be populated after listOrphanedCaptures completes)
      setDeviceProbeResultMap(new Map());
      setDeviceProbeLoadingMap(new Map());
      setCaptureBusConfigMap(new Map());
      setBusOverrides(new Map());
      setModbusPoll(DEFAULT_MODBUS_POLL_CONFIG);
      probedProfilesRef.current.clear();
    }
  // Only `isOpen` is a real dep — loadProfileId/selectedId/selectedIds are
  // captured for initial values on open and must NOT retrigger the effect
  // (see didInitForOpenRef guard above), since parent re-renders during a
  // running capture can change their identities without meaningful value
  // changes, which would re-collapse the picker after the user clicks Change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Record a manual tab pick so the Sessions auto-default stops fighting the user.
  const handleTabChange = useCallback((tab: SourceTab) => {
    tabUserPickedRef.current = true;
    setActiveTab(tab);
  }, []);

  // Default to the Sessions tab once active sessions load — when the user hasn't
  // picked a tab and either nothing was explicitly selected or the selection is
  // one of those sessions.
  useEffect(() => {
    if (!isOpen || tabUserPickedRef.current || hideSessions) return;
    if (activeMultiSourceSessions.length === 0) return;
    const selectedIsSession = activeMultiSourceSessions.some((s) => s.session_id === selectedId);
    if (selectedIsSession || !hasExplicitSelectionRef.current) {
      setActiveTab("sessions");
    }
  }, [isOpen, activeMultiSourceSessions, selectedId, hideSessions]);

  // Apply the decoder picker selection (and mirror it into the host app).
  const handleCatalogSelect = useCallback((path: string | null) => {
    decoderUserTouchedRef.current = true;
    setSelectedCatalogPath(path);
    onCatalogSelect?.(path);
  }, [onCatalogSelect]);

  // Auto-fill the decoder footer from the selected source's preferred catalogue
  // when no decoder has been set yet. Only fires for a single unique preferred
  // catalogue across the selection (conflicts are left to the host app's flow).
  useEffect(() => {
    if (decoderUserTouchedRef.current) return; // user set/cleared it — don't override
    const decoderDir = settings?.decoder_dir;
    if (!decoderDir) return;
    const preferred = [...new Set(
      selectedSourceIds.map((id) => readProfiles.find((p) => p.id === id)?.preferred_catalog).filter(Boolean)
    )] as string[];
    if (preferred.length === 1) {
      // The source's own preference beats the seed, which is only the host app's
      // currently loaded decoder — i.e. the last source's. Filling just the empty
      // slot showed a Modbus decoder for a CAN source and never offered SBRXXX.
      // A manual pick or clear still wins, via the `decoderUserTouched` guard.
      setSelectedCatalogPath(buildCatalogPath(preferred[0], decoderDir));
    }
  }, [selectedSourceIds, readProfiles, settings?.decoder_dir]);

  // Read the selected decoder's serial framing so it can drive the framing
  // dropdown for serial sources (a decoder that specifies e.g. SLIP framing).
  useEffect(() => {
    if (!selectedCatalogPath) {
      setCatalogSerialEncoding(null);
      return;
    }
    let cancelled = false;
    loadCatalog(selectedCatalogPath)
      .then((parsed) => {
        if (cancelled) return;
        // Passed through whole: a catalogue framing no framer implements (COBS,
        // length-prefixed) is refused by the backend rather than dropped here.
        setCatalogSerialEncoding((parsed.serialConfig?.encoding as FramingMode | undefined) ?? null);
      })
      .catch(() => { if (!cancelled) setCatalogSerialEncoding(null); });
    return () => { cancelled = true; };
  }, [selectedCatalogPath]);

  // Apply the decoder's serial framing to the selected serial source(s) so the
  // on-screen framing selection reflects the decoder. Skips profiles the user
  // framed by hand.
  useEffect(() => {
    if (!catalogSerialEncoding) return;
    const serialIds = selectedSourceIds.filter(
      (id) => !framingUserTouchedRef.current.has(id)
        && readProfiles.find((p) => p.id === id)?.kind === "serial"
    );
    if (serialIds.length === 0) return;
    setFramingConfigMap((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of serialIds) {
        const cur = prev.get(id);
        if (cur?.encoding !== catalogSerialEncoding) {
          next.set(id, { ...cur, encoding: catalogSerialEncoding });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [catalogSerialEncoding, selectedSourceIds, readProfiles]);

  // Auto-import mode: immediately open file picker when triggered from menu
  useEffect(() => {
    if (!isOpen || !autoImport) return;
    autoImportActiveRef.current = true;
    onAutoImportConsumed?.();
    // Trigger the import flow (opens OS file picker)
    handleImport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, autoImport]);

  // Refresh capture list periodically while dialog is open
  // This catches transitions from streaming to stopped even if the stream-ended
  // event wasn't received (e.g., stream stopped by another window)
  useEffect(() => {
    if (!isOpen) return;
    if (captures.length === 0) return;

    // Poll more frequently while streaming, less frequently when not
    const hasStreamingCapture = captures.some(b => b.is_streaming);
    const pollInterval = hasStreamingCapture ? 500 : 2000;

    const intervalId = setInterval(() => {
      listOrphanedCaptures().then(setCaptures).catch(console.error);
    }, pollInterval);

    return () => clearInterval(intervalId);
  }, [isOpen, captures]);

  // Listen for capture changes from other windows while dialog is open
  useEffect(() => {
    if (!isOpen) return;
    const unlistenFns: (() => void)[] = [];
    const setup = async () => {
      // Refresh capture list on delete/clear/import from another window
      const u1 = await listen<CaptureChangedPayload>(WINDOW_EVENTS.CAPTURE_CHANGED, () => {
        listOrphanedCaptures().then(setCaptures).catch(console.error);
      });
      unlistenFns.push(u1);
      // Refresh capture list on rename/pin from another window
      const u2 = await listen(WINDOW_EVENTS.CAPTURE_METADATA_UPDATED, () => {
        listOrphanedCaptures().then(setCaptures).catch(console.error);
      });
      unlistenFns.push(u2);
    };
    setup();
    return () => unlistenFns.forEach(fn => fn());
  }, [isOpen]);

  // Fetch active joinable sessions when dialog opens and periodically refresh
  // Includes multi_source sessions AND recorded sessions (like the WireTAP backend)
  // Also fetches profile usage info for showing "(in use)" indicators
  useEffect(() => {
    if (!isOpen) return;

    const fetchSessions = async () => {
      try {
        const sessions = await listActiveSessions();
        console.log("[IoSourcePickerDialog] All active sessions:", sessions);
        // Show joinable sessions:
        // - traits.multi_source: sources that can be combined (all realtime)
        // - capture: sessions switched to capture replay (e.g., stopped live sessions)
        // - supports_time_range && !is_realtime: recorded sources like the WireTAP backend
        const joinableSessions = sessions.filter((s) =>
          s.capabilities.traits.multi_source === true ||
          s.source_type === "capture" ||
          (s.capabilities.supports_time_range && s.capabilities.traits.temporal_mode === "recorded")
        );
        console.log("[IoSourcePickerDialog] Joinable sessions:", joinableSessions);
        setActiveMultiSourceSessions(joinableSessions);

        // Fetch profile usage info for all profiles
        const profileIds = ioProfiles.map((p) => p.id);
        if (profileIds.length > 0) {
          const usageList = await getProfilesUsage(profileIds);
          const usageMap = new Map<string, ProfileUsageInfo>();
          for (const usage of usageList) {
            usageMap.set(usage.profile_id, usage);
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

  // After activeMultiSourceSessions loads, if current source is a capture with an
  // active session, set checkedReaderId so the collapsed view shows it
  useEffect(() => {
    if (!isOpen) return;
    if (!selectedId || !selectedIsCapture) return;
    if (checkedSourceId !== null) return;
    if (hasUserExpandedRef.current) return;

    const captureSession = activeMultiSourceSessions.find(
      (s) => s.session_id === selectedId
    );
    if (captureSession) {
      setCheckedReaderId(selectedId);
    }
  }, [isOpen, selectedId, selectedIsCapture, checkedSourceId, activeMultiSourceSessions]);

  // Multi-bus mode is active when at least one profile is selected in multi-select
  const isMultiBusMode = checkedSourceIds.length > 0;

  // The probe effect waits for Rust's profile table before it runs.
  const profileBusesLoaded = useProfileBusStore((s) => s.loaded);
  useEffect(() => {
    if (isOpen) void useProfileBusStore.getState().ensureLoaded();
  }, [isOpen]);

  // Probe all real-time devices in multi-bus mode
  useEffect(() => {
    if (!isOpen || checkedSourceIds.length === 0) {
      return;
    }
    // Wait for Rust's bus counts — probing now would seed every multi-bus
    // device with the single-bus placeholder and never revisit it. The map is
    // legitimately empty when no profile declares its buses, so gate on the
    // load having happened rather than on it having entries.
    if (!profileBusesLoaded) {
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
    realtimeProfileIds.forEach((profileId) => {
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

      if (isLive && !isStopped) {
        // Use default config for live session
        probedProfilesRef.current.add(profileId);
        setDeviceProbeResultMap((prev) => new Map(prev).set(profileId, {
          success: true,
          source_type: isMultiBus ? "multi" : "single",
          is_multi_bus: isMultiBus,
          bus_count: profileBusMappings(profileId).length || 1,
          primary_info: "Session active",
          secondary_info: null,
          supports_fd: null,
          error: null,
        }));
        return;
      }

      // Mark as probing
      probedProfilesRef.current.add(profileId);
      setDeviceProbeLoadingMap((prev) => new Map(prev).set(profileId, true));

      probeDevice(profileId)
        .then((result) => {
          setDeviceProbeResultMap((prev) => new Map(prev).set(profileId, result));
        })
        .catch((err) => {
          console.error(`[IoSourcePickerDialog] Probe failed for ${profileId}:`, err);
          setDeviceProbeResultMap((prev) => new Map(prev).set(profileId, {
            success: false,
            source_type: isMultiBus ? "multi" : "unknown",
            is_multi_bus: isMultiBus,
            bus_count: 0,
            primary_info: null,
            secondary_info: null,
            supports_fd: null,
            error: String(err),
          }));
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
  }, [isOpen, checkedSourceIds, readProfiles, profileBusesLoaded]);

  // Rust allocates the selection's output buses. Asked again when a probe lands,
  // since a probe is how Rust counts the buses of a profile that declares none.
  const realtimeSourceIds = useMemo(
    () => checkedSourceIds.filter((id) => {
      const profile = readProfiles.find((p) => p.id === id);
      return profile && isRealtimeProfile(profile);
    }),
    [checkedSourceIds, readProfiles, profileBusesLoaded]
  );
  // A source that leaves the selection forgets its edits, so re-ticking it starts from Rust's allocation.
  useEffect(() => {
    setBusOverrides((prev) => {
      const kept = new Map([...prev].filter(([id]) => checkedSourceIds.includes(id)));
      return kept.size === prev.size ? prev : kept;
    });
  }, [checkedSourceIds]);
  useEffect(() => {
    if (!isOpen || !profileBusesLoaded || realtimeSourceIds.length === 0) {
      setBusAllocation(new Map());
      return;
    }
    let current = true;
    previewSourceBuses(realtimeSourceIds.map((id) => ({ profile_id: id, overrides: busOverrides.get(id) })))
      .then((allocation) => current && setBusAllocation(allocation))
      .catch((e) => console.error("[IoSourcePickerDialog] Bus preview failed:", e));
    return () => {
      current = false;
    };
  }, [isOpen, profileBusesLoaded, realtimeSourceIds, busOverrides, deviceProbeResultMap]);

  // Build load options from current state
  const buildLoadOptions = (speed: number): LoadOptions => {
    const opts: LoadOptions = { speed };

    // Add time range for recorded sources
    // Convert datetime-local values based on timezone mode
    if (!isCheckedRealtime) {
      if (timeBounds.startTime) {
        // If UTC mode, the user entered UTC time - append Z
        // If Local mode, convert to ISO with timezone offset so the backend interprets it correctly
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

    // Attach the decoder chosen in the picker
    if (selectedCatalogPath) {
      opts.catalogPath = selectedCatalogPath;
    }

    // The unit comes from the profile: the poll loop sets the slave per request,
    // so a spec without it reads unit 1 whatever the profile says.
    if (modbusProfile) {
      const spec = pollSpecFor(modbusPoll, modbusConnectionOf(modbusProfile, modbusDefaults).unit_id);
      if (spec) opts.modbusRanges = spec;
    }

    console.log("[buildLoadOptions] Built options:", opts);

    return opts;
  };

  // Handle Load button - runs at max speed (speed=0), keeps dialog open
  const handleLoadClick = () => {
    if (!checkedSourceId || !checkedProfile) return;
    const options = buildLoadOptions(0); // 0 = max speed / no limit
    onStartLoad?.(checkedSourceId, false, options);
  };

  // Handle Watch button - uses selected speed, closes dialog
  const handleConnectClick = () => {
    if (!checkedSourceId || !checkedProfile) return;
    const options = buildLoadOptions(selectedSpeed);
    onStartLoad?.(checkedSourceId, true, options);
    onClose();
  };

  // Handle Connect for capture source - passes bus mappings through options
  const handleCaptureConnectClick = () => {
    // Use selectedCaptureId (from clicking a capture in the list)
    // or fall back to checkedSourceId (when dialog reopens with capture pre-selected)
    const captureId = selectedCaptureId ?? checkedSourceId;
    if (!captureId) return;
    onStartLoad?.(captureId, true, buildLoadOptions(selectedSpeed));
    onClose();
  };

  // Handle Join button - join an existing live session (no options needed)
  // This also handles joining active multi-source sessions
  const handleJoinClick = () => {
    if (onJoinSession && checkedSourceId) {
      // Check if this is a multi-source session and get source profile IDs
      const multiSourceSession = activeMultiSourceSessions.find((s) => s.session_id === checkedSourceId);
      const sourceProfileIds = multiSourceSession?.broker_configs?.map((c) => c.profile_id);
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

  // Handle Restart button - destroy existing session and start a new one with
  // updated config. Same shape as a device edit, so it shares the path.
  const handleRestartClick = async () => {
    if (!checkedSourceId || !checkedProfile) return;
    await startDeviceSession(checkedSourceId, checkedSourceId);
  };

  // Handle Multi-Bus Restart button - destroy existing multi-source session and create a new one
  const handleMultiRestartClick = async () => {
    if (checkedSourceIds.length === 0) return;

    // Destroy the existing multi-source session first
    if (liveMultiSourceSession) {
      try {
        await destroyReaderSession(liveMultiSourceSession.session_id);
      } catch (e) {
        console.error("Failed to destroy existing multi-source session:", e);
        // Continue anyway - maybe it was already destroyed
      }
    }

    // Now create a new multi-source session with the updated config
    handleMultiWatchClick();
  };

  // ── Device editor commits ──────────────────────────────────────────────────

  /**
   * Start a session on `profileId`, first dropping the session held by
   * `replaceSessionFor` (if any). Nothing in the backend can change a bitrate or
   * a baud rate on a running source, so a changed device means
   * destroy-and-recreate.
   *
   * The two ids differ for a "use once" edit: the
   * new session runs on an ad-hoc clone, but the session to tear down is the
   * saved device's — and it must go, or two sessions fight over one adapter.
   */
  const startDeviceSession = async (profileId: string, replaceSessionFor: string | null) => {
    const existing = replaceSessionFor ? getSessionForProfile(replaceSessionFor) : undefined;
    if (existing) {
      try {
        await destroyReaderSession(existing.id);
      } catch (e) {
        // Already gone is fine; anything else the new session will surface.
        console.error("Failed to destroy existing session:", e);
      }
    }
    setCheckedReaderId(profileId);
    setCheckedReaderIds([]);
    const options = buildLoadOptions(selectedSpeed);
    onStartLoad?.(profileId, true, options);
    setCreatingDevice(false);
    onClose();
  };

  const handleCreateDevice = async (draft: DeviceDraft, persist: boolean) => {
    const device = await addDevice(draft, persist);
    await startDeviceSession(device.id, null);
  };

  const handleEditDevice = (profileId: string) => {
    // The shared device-settings dialog, the same one the session menu opens:
    // one surface, one meaning, and a reconnect that keeps the session id
    // instead of destroying and re-creating the session as this dialog would.
    openDeviceSettings(profileId, getSessionForProfile(profileId)?.id ?? null);
  };

  const handleDiscardDevice = async (profileId: string) => {
    // The backend refuses while a session still holds the device — the row hides
    // the action then, but a session started elsewhere can race it.
    const ok = await withAppError(
      t("ioSourcePicker.deviceEditor.discardFailedTitle"),
      t("ioSourcePicker.deviceEditor.discardFailed"),
      () => discardAdHocProfile(profileId),
    );
    if (!ok) return;
    setCheckedReaderId((prev) => (prev === profileId ? null : prev));
    setCheckedReaderIds((prev) => prev.filter((id) => id !== profileId));
  };

  // Handle time bounds change from TimeBoundsInput
  const handleTimeBoundsChange = useCallback((bounds: TimeBounds) => {
    setTimeBounds(bounds);
  }, []);

  const handleStopLoad = () => onStopLoad?.();

  // Handle speed change
  const handleSpeedChange = (speed: number) => {
    setSelectedSpeed(speed);
    onLoadSpeedChange?.(speed);
  };

  // Handle toggling a multi-source-capable reader (for multi-bus mode)
  const handleToggleReader = async (readerId: string) => {
    const profile = readProfiles.find((p) => p.id === readerId);
    if (!profile) return;

    if (checkedSourceIds.includes(readerId)) {
      setCheckedReaderIds((prev) => prev.filter((id) => id !== readerId));
      setValidationError(null);
      return;
    }

    const selection = [...checkedSourceIds, readerId]
      .map((id) => readProfiles.find((p) => p.id === id))
      .filter((p): p is IOProfile => p !== undefined);
    const error = await validateSourceSelection(selection).catch(String);
    if (error) {
      setValidationError(error);
      return;
    }

    setValidationError(null);
    // Clear single-select reader when adding to multi-bus
    setCheckedReaderId(null);
    setSelectedCaptureId(null);
    setCheckedReaderIds((prev) => (prev.includes(readerId) ? prev : [...prev, readerId]));
  };

  // Handle selecting an active multi-source session to join
  const handleSelectMultiSourceSession = (sessionId: string) => {
    // Select the multi-source session as the reader
    setCheckedReaderId(sessionId);
    setSelectedCaptureId(null);
    // Clear multi-bus selection since we're joining an existing session
    setCheckedReaderIds([]);
    setValidationError(null);
  };

  // Handle Leave button - unregister listener and reset dialog state
  const handleRelease = async () => {
    if (!subscriberId) return; // Need listener ID to unregister

    // Unregister from any active sessions (doesn't destroy them, other listeners
    // can still use them). `selectedSourceIds` covers both selection modes, so
    // this is one loop rather than a single-select branch beside a multi one.
    for (const profileId of selectedSourceIds) {
      if (profileId === CSV_EXTERNAL_ID) continue;
      const session = getSessionForProfile(profileId);
      if (!session) continue;
      try {
        await unregisterSessionSubscriber(session.id, subscriberId);
      } catch (e) {
        console.error(`Failed to unregister from session for ${profileId}:`, e);
      }
    }

    // Clear reader selection
    setCheckedReaderId(null);
    setCheckedReaderIds([]);
    setValidationError(null);

    // Clear capture selection
    setSelectedCaptureId(null);

    // Reset load options
    setTimeBounds({
      startTime: "",
      endTime: "",
      maxFrames: undefined,
      timezoneMode: "local",
    });
    setSelectedSpeed(1);

    setFramingConfigMap(new Map());

    // Reset multi-bus device probe maps
    setDeviceProbeResultMap(new Map());
    setDeviceProbeLoadingMap(new Map());
    setCaptureBusConfigMap(new Map());
    setBusOverrides(new Map());
    // Off is the deliberate default — a range left ticked for the previous
    // device would start polling this one the moment you press Connect.
    setModbusPoll(DEFAULT_MODBUS_POLL_CONFIG);
    probedProfilesRef.current.clear();

    // Clear import error
    setImportError(null);
  };

  // Handle Watch button for multi-bus mode
  const handleMultiWatchClick = () => {
    if (checkedSourceIds.length === 0) return;
    const options = buildLoadOptions(selectedSpeed);

    if (busOverrides.size > 0) {
      options.busOverrides = busOverrides;
    }

    // Pass per-interface framing configs (for serial profiles)
    if (framingConfigMap.size > 0) {
      options.perInterfaceFraming = framingConfigMap;
    }

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
        // In auto-import mode (menu shortcut), close the dialog on cancel
        if (autoImportActiveRef.current) {
          autoImportActiveRef.current = false;
          onClose();
        }
        return;
      }

      if (await detectCandump(filePaths)) {
        const result = await importCandump(await generateSessionId({ purpose: "ingest" }), filePaths);
        if (result.skipped_count > 0) setCandumpReport(result);
        else await handleCsvMapperComplete(result.metadata);
      } else if (filePaths.length === 1) {
        // Single file — go straight to column mapper
        setCsvMapperFilePath(filePaths[0]);
        setCsvMapperFilePaths(null);
        setCsvImportSessionId(await generateSessionId({ purpose: "ingest" }));
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

  const handleFileOrderConfirm = async (orderedPaths: string[], hasHeaderPerFile: boolean[]) => {
    setShowFileOrderDialog(false);
    setPendingFilePaths(null);

    // Open column mapper with first file for preview, all files for batch import
    setCsvMapperFilePath(orderedPaths[0]);
    setCsvMapperFilePaths(orderedPaths);
    setCsvHasHeaderPerFile(hasHeaderPerFile);
    setCsvImportSessionId(await generateSessionId({ purpose: "ingest" }));
    setShowCsvMapper(true);
  };

  const handleFileOrderCancel = () => {
    setShowFileOrderDialog(false);
    setPendingFilePaths(null);
    if (autoImportActiveRef.current) {
      autoImportActiveRef.current = false;
      onClose();
    }
  };

  const handleCsvMapperComplete = async (metadata: CaptureMetadata) => {
    setShowCsvMapper(false);
    setCsvMapperFilePath(null);
    setCsvMapperFilePaths(null);
    setCsvHasHeaderPerFile(null);
    setCsvImportSessionId(null);

    // Refresh capture list
    const allCaptures = await listOrphanedCaptures();
    setCaptures(allCaptures);

    onImport?.(metadata);

    // Notify other windows that capture has changed
    const payload: CaptureChangedPayload = {
      metadata,
      timestamp: Date.now(),
    };
    await emit(WINDOW_EVENTS.CAPTURE_CHANGED, payload);

    // Auto-select the capture and close
    autoImportActiveRef.current = false;
    onSelect(metadata.id);
    onClose();
  };

  const handleCsvMapperCancel = () => {
    setShowCsvMapper(false);
    setCsvMapperFilePath(null);
    setCsvMapperFilePaths(null);
    setCsvHasHeaderPerFile(null);
    setCsvImportSessionId(null);
    if (autoImportActiveRef.current) {
      autoImportActiveRef.current = false;
      onClose();
    }
  };

  // Delete a specific capture by ID
  const handleDeleteCapture = async (captureId: string) => {
    try {
      await deleteCapture(captureId);

      // Refresh capture list
      const allCaptures = await listOrphanedCaptures();
      setCaptures(allCaptures);

      // If no captures left and capture was selected, clear selection
      if (allCaptures.length === 0 && selectedIsCapture) {
        onSelect(null);
      }

      // Notify other windows that capture has been deleted
      const payload: CaptureChangedPayload = {
        metadata: null,
        deletedCaptureIds: [captureId],
        timestamp: Date.now(),
      };
      await emit(WINDOW_EVENTS.CAPTURE_CHANGED, payload);
    } catch (e) {
      console.error("Failed to delete capture:", e);
    }
  };

  // Clear all non-streaming, non-persistent captures
  const handleClearAllCaptures = async () => {
    try {
      // Only delete captures that are not streaming and not pinned
      const clearableCaptures = captures.filter(b => !b.is_streaming && !b.persistent);
      for (const capture of clearableCaptures) {
        await deleteCapture(capture.id);
      }

      // Refresh capture list (keep streaming and persistent captures)
      const keptCaptures = captures.filter(b => b.is_streaming || b.persistent);
      setCaptures(keptCaptures);

      // If capture was selected and it was deleted, clear selection
      const deletedIds = new Set(clearableCaptures.map(b => b.id));
      if (selectedIsCapture) {
        // Check if the selected capture was deleted
        const selectedCapture = captures.find(b => b.id === selectedId);
        if (selectedCapture && deletedIds.has(selectedCapture.id)) {
          onSelect(null);
        }
      }

      // Notify other windows that captures have been cleared
      const payload: CaptureChangedPayload = {
        metadata: null,
        deletedCaptureIds: clearableCaptures.map(b => b.id),
        timestamp: Date.now(),
      };
      await emit(WINDOW_EVENTS.CAPTURE_CHANGED, payload);
    } catch (e) {
      console.error("Failed to clear captures:", e);
    }
  };

  // Select a specific orphaned capture (local dialog state only — no session created yet)
  const handleSelectCapture = async (captureId: string) => {
    try {
      await setActiveCapture(captureId);
      setCheckedReaderId(null);
      setCheckedReaderIds([]);
      setValidationError(null);
      setSelectedCaptureId(captureId);
      // Don't call onSelect here — that triggers session creation in the parent.
      // Capture sessions are only created when the user clicks Connect.

      // Probe capture to populate shared bus config maps
      probeCapture(captureId);
    } catch (e) {
      console.error("Failed to set active capture:", e);
    }
  };

  const isCaptureSelected = selectedIsCapture || selectedCaptureId !== null;

  // The source list and its options. Hoisted out of the render tree so the
  // device editor swaps in as one line rather than burying 250 lines of JSX in
  // a ternary arm.
  const pickerBody = (
    <>
      <div className="max-h-[60vh] overflow-y-auto">
        <SourceList
          ioProfiles={ioProfiles}
          onNewDevice={() => setCreatingDevice(true)}
          onEditDevice={handleEditDevice}
          onDiscardDevice={handleDiscardDevice}
          checkedSourceId={checkedSourceId}
          checkedSourceIds={checkedSourceIds}
          defaultId={defaultId}
          isLoading={isLoading}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          captureCount={captures.length}
          captureNames={new Map(captures.map((b) => [b.id, b.name]))}
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
              setSelectedCaptureId(null);
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
            const configLocked = usageInfo?.config_locked ?? false;

            const busConfig = busAllocation.get(profileId) ?? [];
            const usedOutputBuses = new Set(
              [...busAllocation]
                .filter(([otherId]) => otherId !== profileId)
                .flatMap(([, mappings]) => mappings.filter((m) => m.enabled).map((m) => m.output_bus))
            );

            // Multi-bus devices - show DeviceBusConfig
            if (isDeviceMultiBus || probeResult?.is_multi_bus) {

              // Counted off the rows themselves, or the "(n/m enabled)" header
              // disagrees with what is rendered under it.
              const deviceInfo: GvretDeviceInfo | null = probeResult
                ? { bus_count: busConfig.length }
                : null;

              return (
                <DeviceBusConfig
                  deviceInfo={deviceInfo}
                  isLoading={isLoading}
                  error={probeResult?.error || null}
                  busConfig={busConfig}
                  onBusConfigChange={(config) => {
                    setBusOverrides((prev) => new Map(prev).set(profileId, editedOverrides(busConfig, config, prev.get(profileId))));
                  }}
                  compact
                  usedOutputBuses={usedOutputBuses}
                  configLocked={configLocked}
                  // A session-only override: the picker seeds from the profile's
                  // saved protocol but never writes back to it. Settings is the
                  // one place a device's protocol is persisted.
                  showProtocol
                />
              );
            }

            // Single-bus devices - show SingleBusConfig
            const singleBus = busConfig[0];
            const profileForKind = ioProfiles.find((p) => p.id === profileId);
            const profileKind = profileForKind?.kind;
            // Kept out of the map: the session already frames by the profile, so no override is sent.
            const interfaceFraming = framingConfigMap.get(profileId) ?? savedFraming(profileForKind);
            return (
              <SingleBusConfig
                probeResult={probeResult}
                isLoading={isLoading}
                error={probeResult?.error || null}
                outputBus={singleBus?.output_bus}
                onOutputBusChange={(bus) => {
                  if (!singleBus) return;
                  setBusOverrides((prev) => new Map(prev).set(
                    profileId,
                    editedOverrides(busConfig, [{ ...singleBus, output_bus: bus }], prev.get(profileId)),
                  ));
                }}
                compact
                usedBuses={usedOutputBuses}
                profileKind={profileKind}
                framingConfig={interfaceFraming}
                onFramingChange={(config) => {
                  framingUserTouchedRef.current.add(profileId);
                  setFramingConfigMap((prev) => new Map(prev).set(profileId, config));
                }}
                configLocked={configLocked}
              />
            );
          }}
          activeMultiSourceSessions={activeMultiSourceSessions}
          onSelectMultiSourceSession={handleSelectMultiSourceSession}
          disabledProfiles={disabledProfiles}
          hideExternal={hideCaptures}
          hideRecorded={hideCaptures}
          hideSessions={hideSessions}
          profileUsage={profileUsage}
          renderAfterSessions={!hideCaptures ? (
            <CaptureList
              captures={captures}
              selectedCaptureId={selectedCaptureId}
              checkedSourceId={checkedSourceId}
              checkedSourceIds={checkedSourceIds}
              onSelectCapture={handleSelectCapture}
              onDeleteCapture={handleDeleteCapture}
              onClearAllCaptures={handleClearAllCaptures}
              onCaptureRenamed={() => listOrphanedCaptures().then(setCaptures).catch(console.error)}
              onCapturePersistenceChanged={() => listOrphanedCaptures().then(setCaptures).catch(console.error)}
              busConfig={selectedCaptureId ? captureBusConfigMap.get(selectedCaptureId) : undefined}
              onBusConfigChange={(config) => {
                if (selectedCaptureId) {
                  setCaptureBusConfigMap((prev) => new Map(prev).set(selectedCaptureId, config));
                }
              }}
              isProbing={selectedCaptureId ? deviceProbeLoadingMap.get(selectedCaptureId) ?? false : false}
              probeError={selectedCaptureId ? deviceProbeResultMap.get(selectedCaptureId)?.error ?? null : null}
              activeSessionCaptureMap={new Map(
                activeMultiSourceSessions
                  .filter((s) => s.source_type === "capture")
                  .flatMap((s) => {
                    const entries: [string, string][] = [[s.session_id, s.session_id]];
                    if (s.capture_id) entries.push([s.capture_id, s.session_id]);
                    return entries;
                  })
              )}
            />
          ) : undefined}
        />

        {/* A Modbus source reads nothing without a poll plan, and only a
            catalogue could supply one — so offer a range. Session-level,
            because the backend injects one plan into every Modbus source. */}
        {modbusProfile && !checkedMultiSourceSession && (
          <ModbusPollConfig
            config={modbusPoll}
            onChange={setModbusPoll}
            disabled={profileUsage.get(modbusProfile.id)?.config_locked ?? false}
          />
        )}

        {/* Show load options when creating a new session */}
        {/* Hide when: connect mode, joining an existing session, or nothing selected */}
        {mode !== "connect" && (checkedSourceId || isMultiBusMode) && !checkedMultiSourceSession && (
          <LoadOptions
            checkedSourceId={checkedSourceId}
            checkedProfile={checkedProfile}
            isLoading={isLoading}
            timeBounds={timeBounds}
            onTimeBoundsChange={handleTimeBoundsChange}
            selectedSpeed={selectedSpeed}
            onSpeedChange={handleSpeedChange}
          />
        )}
      </div>

      <DecoderPicker catalogPath={selectedCatalogPath} onSelect={handleCatalogSelect} />
    </>
  );

  const pickerFooter = (
    <ActionButtons
      mode={mode}
      isLoading={isLoading}
      loadProfileId={loadProfileId}
      checkedSourceId={checkedSourceId}
      checkedProfile={checkedProfile}
      isCaptureSelected={isCaptureSelected}
      isCheckedProfileLive={isCheckedProfileLive || (isCheckedProfileStopped && isCheckedProfileCapture)}
      isCheckedProfileStopped={isCheckedProfileStopped && !isCheckedProfileCapture}
      isImporting={isImporting}
      importError={importError}
      onImport={handleImport}
      onLoadClick={handleLoadClick}
      onConnectClick={handleConnectClick}
      onJoinClick={handleJoinClick}
      onStartClick={handleStartClick}
      onClose={onClose}
      onSkip={onSkip}
      multiSelectMode={isMultiBusMode}
      multiSelectCount={checkedSourceIds.length}
      onMultiConnectClick={handleMultiWatchClick}
      onRelease={subscriberId && (isCheckedProfileLive || (isCheckedProfileStopped && isCheckedProfileCapture)) ? handleRelease : undefined}
      // Only show Restart for profiles, not for selecting existing sessions
      onRestartClick={isCheckedProfileLive && !isCheckedProfileStopped && !checkedMultiSourceSession ? handleRestartClick : undefined}
      isMultiSourceLive={isMultiSourceLive}
      onMultiRestartClick={isMultiSourceLive ? handleMultiRestartClick : undefined}
      onCaptureConnectClick={selectedCaptureId ? handleCaptureConnectClick : undefined}
      onConnectOnlyClick={checkedSourceId && onConnect ? () => {
        onConnect(checkedSourceId);
        onClose();
      } : undefined}
    />
  );

  return (
    <>
    <Dialog isOpen={isOpen} onClose={onClose} title={t("ioSourcePicker.title")}>
      <DialogBody padding="none">
        <LoadStatus
          isLoading={isLoading}
          loadFrameCount={loadFrameCount}
          loadError={loadError}
          onStopLoad={handleStopLoad}
        />

        {creatingDevice ? (
          <div className="max-h-[70vh] overflow-y-auto">
            <DeviceEditor
              onCancel={() => setCreatingDevice(false)}
              onCreate={handleCreateDevice}
            />
          </div>
        ) : (
          pickerBody
        )}
      </DialogBody>
      {!creatingDevice && pickerFooter}
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

    {candumpReport && (
      <CandumpImportReportDialog
        result={candumpReport}
        onDone={() => {
          setCandumpReport(null);
          void handleCsvMapperComplete(candumpReport.metadata);
        }}
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
