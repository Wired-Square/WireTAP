// ui/src/apps/discovery/Discovery.tsx

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { emit } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useSettings, getSaveFrameIdFormat } from "../../hooks/useSettings";
import { useAllIOProfiles } from "../../hooks/useAllIOProfiles";
import { useFrameIdFormat, withFrameIdFormat } from "../../hooks/useFrameIdFormat";
import { useIOSessionManager, type SessionReconfigurationInfo } from '../../hooks/useIOSessionManager';
import { useIOSourcePickerHandlers } from '../../hooks/useIOSourcePickerHandlers';
import { useMenuSessionControl } from '../../hooks/useMenuSessionControl';
import { useSessionStore } from '../../stores/sessionStore';
import { type FrameMessage, type PlaybackSpeed } from "../../stores/discoveryStore";
import { keyOf, groupKeysByProtocol } from "../../utils/frameKey";
import { selectionSetKeys, type SelectionSet } from "../../utils/selectionSets";
import { useDiscoveryFrameStore, getDiscoveryFrameBuffer } from "../../stores/discoveryFrameStore";
import { useDiscoveryUIStore } from "../../stores/discoveryUIStore";
import { useDiscoverySerialStore } from "../../stores/discoverySerialStore";
import { runningModbusScan, useDiscoveryToolboxStore } from "../../stores/discoveryToolboxStore";
import { useShallow } from "zustand/react/shallow";
import { useDiscoveryHandlers } from "./hooks/useDiscoveryHandlers";
import { useModbusScanSync } from "./hooks/useModbusScanSync";
import type { StreamEndedInfo, PlaybackPosition, FcProbeConfig, ModbusScanConfig, UnitIdScanConfig } from '../../api/io';
import { createModbusScanSession, probeModbusFunctionCodes, startReaderSession, stopReaderSession } from '../../api/io';
import type { ScanJob } from '../../api/io';
import type { ModbusExportConfig } from '../../utils/frameExport';
import {
  MODBUS_SCAN_SESSION_PREFIX,
  isModbusScanSession,
  type ModbusPollerRef,
} from '../../utils/modbusProfiles';
import { useModbusPollControl } from '../../hooks/useModbusPollControl';
import { REALTIME_CLOCK_INTERVAL_MS } from "../../constants";
import AppLayout from "../../components/AppLayout";
import DiscoveryTopBar from "./views/DiscoveryTopBar";
import DiscoveryFramesView from "./views/DiscoveryFramesView";
import SerialDiscoveryView from "./views/SerialDiscoveryView";
import SaveFramesDialog from "../../dialogs/SaveFramesDialog";
import DecoderInfoDialog from "../../dialogs/DecoderInfoDialog";
import AddBookmarkDialog from "../../dialogs/AddBookmarkDialog";
import AnalysisProgressDialog from "./dialogs/AnalysisProgressDialog";
import ConfirmDeleteDialog from "../../dialogs/ConfirmDeleteDialog";
import SpeedPickerDialog from "../../dialogs/SpeedPickerDialog";
import ExportFramesDialog, { type ExportDataMode } from "../../dialogs/ExportFramesDialog";
import BookmarkEditorDialog from "../../dialogs/BookmarkEditorDialog";
import SaveSelectionSetDialog from "../../dialogs/SaveSelectionSetDialog";
import IoSourcePickerDialog from "../../dialogs/IoSourcePickerDialog";
import { useSelectionSets } from "../../hooks/useSelectionSets";
import { useEffectiveCaptureMetadata } from "../../hooks/useEffectiveCaptureMetadata";
import { getCaptureMetadata, getCaptureMetadataById, getCaptureFramesPaginated, getCaptureFramesPaginatedFiltered, getCaptureBytesPaginated, getCaptureFrameInfo, getCaptureFramesPaginatedById, type CaptureMetadata } from "../../api/capture";
import { WINDOW_EVENTS } from "../../events/registry";
import FramePickerDialog from "../../dialogs/FramePickerDialog";
import ToolboxDialog from "../../dialogs/ToolboxDialog";
import { pickFileToSave } from "../../api/dialogs";
import { saveCatalog } from "../../api/catalog";
import { formatFilenameDate } from "../../utils/timeFormat";
import { useDialogManager } from "../../hooks/useDialogManager";
import { getFavoritesForProfile } from "../../utils/favorites";

/** The protocol these frames are, for labelling and export naming. Entries without a
 *  protocol are skipped, and no frames at all answers undefined rather than 'can' —
 *  "nothing has arrived yet" is not evidence of CAN. */
function protocolOf(frameInfoMap: Map<string, { protocol?: string }>): string | undefined {
  for (const info of frameInfoMap.values()) {
    if (info.protocol) return info.protocol;
  }
  return undefined;
}

function DiscoveryInner() {
  const { t, i18n } = useTranslation("discovery");
  const { settings } = useSettings();
  // Saved devices plus any created ad-hoc in the source picker.
  const allIOProfiles = useAllIOProfiles();



  // ── Frame store ──
  const frames = getDiscoveryFrameBuffer();
  const { frameInfoMap, selectedFrames, seenIds, streamStartTimeUs, captureMode } =
    useDiscoveryFrameStore(useShallow((s) => ({
      frameInfoMap: s.frameInfoMap,
      selectedFrames: s.selectedFrames,
      seenIds: s.seenIds,
      streamStartTimeUs: s.streamStartTimeUs,
      captureMode: s.captureMode,
    })));
  // Subscribe to frameVersion so components re-render when the mutable capture data changes
  useDiscoveryFrameStore((s) => s.frameVersion);
  const setStreamStartTimeUs = useDiscoveryFrameStore((s) => s.setStreamStartTimeUs);
  const clearAll = useDiscoveryFrameStore((s) => s.clearAll);
  const enableCaptureMode = useDiscoveryFrameStore((s) => s.enableCaptureMode);
  const disableCaptureMode = useDiscoveryFrameStore((s) => s.disableCaptureMode);
  const setFrameInfoFromCapture = useDiscoveryFrameStore((s) => s.setFrameInfoFromCapture);

  // ── UI store ──
  const { maxBuffer, ioProfile, playbackSpeed, showSaveDialog, saveMetadata,
    startTime, endTime, currentTime, currentFrameIndex,
    activeSelectionSetId, selectionSetDirty } =
    useDiscoveryUIStore(useShallow((s) => ({
      maxBuffer: s.maxBuffer,
      ioProfile: s.ioProfile,
      playbackSpeed: s.playbackSpeed,
      showSaveDialog: s.showSaveDialog,
      saveMetadata: s.saveMetadata,
      startTime: s.startTime,
      endTime: s.endTime,
      currentTime: s.currentTime,
      currentFrameIndex: s.currentFrameIndex,
      activeSelectionSetId: s.activeSelectionSetId,
      selectionSetDirty: s.selectionSetDirty,
    })));
  const framesViewActiveTab = useDiscoveryUIStore((s) => s.framesViewActiveTab);
  const setShowBusColumn = useDiscoveryUIStore((s) => s.setShowBusColumn);
  const setModbusExportConfig = useDiscoveryUIStore((s) => s.setModbusExportConfig);
  const setMaxBuffer = useDiscoveryUIStore((s) => s.setMaxBuffer);
  const setIoProfile = useDiscoveryUIStore((s) => s.setIoProfile);
  const setPlaybackSpeed = useDiscoveryUIStore((s) => s.setPlaybackSpeed);
  const updateCurrentTime = useDiscoveryUIStore((s) => s.updateCurrentTime);
  const setCurrentFrameIndex = useDiscoveryUIStore((s) => s.setCurrentFrameIndex);
  const closeSaveDialog = useDiscoveryUIStore((s) => s.closeSaveDialog);
  const updateSaveMetadata = useDiscoveryUIStore((s) => s.updateSaveMetadata);
  const setStartTime = useDiscoveryUIStore((s) => s.setStartTime);
  const setEndTime = useDiscoveryUIStore((s) => s.setEndTime);
  const setSerialConfig = useDiscoveryUIStore((s) => s.setSerialConfig);
  const setSelectionSetDirty = useDiscoveryUIStore((s) => s.setSelectionSetDirty);

  // ── Serial store ──
  const { isSerialMode, framedData, framingAccepted, backendFrameCount, framedCaptureId } =
    useDiscoverySerialStore(useShallow((s) => ({
      isSerialMode: s.isSerialMode,
      framedData: s.framedData,
      framingAccepted: s.framingAccepted,
      backendFrameCount: s.backendFrameCount,
      framedCaptureId: s.framedCaptureId,
    })));
  const serialActiveTab = useDiscoverySerialStore((s) => s.activeTab);
  const setSerialMode = useDiscoverySerialStore((s) => s.setSerialMode);
  const clearSerialBytes = useDiscoverySerialStore((s) => s.clearSerialBytes);
  const resetFraming = useDiscoverySerialStore((s) => s.resetFraming);
  const undoAcceptFraming = useDiscoverySerialStore((s) => s.undoAcceptFraming);
  const incrementBackendFrameCount = useDiscoverySerialStore((s) => s.incrementBackendFrameCount);
  const setBackendFrameCount = useDiscoverySerialStore((s) => s.setBackendFrameCount);
  const setFramingConfig = useDiscoverySerialStore((s) => s.setFramingConfig);

  // ── Toolbox store ──
  const toolboxIsRunning = useDiscoveryToolboxStore((s) => s.toolbox.isRunning);
  const toolboxActiveView = useDiscoveryToolboxStore((s) => s.toolbox.activeView);
  const showInfoView = useDiscoveryToolboxStore((s) => s.showInfoView);
  const knowledge = useDiscoveryToolboxStore((s) => s.knowledge);
  const closeInfoView = useDiscoveryToolboxStore((s) => s.closeInfoView);
  const clearAnalysisResults = useDiscoveryToolboxStore((s) => s.clearAnalysisResults);

  // Global error dialog
  const showAppError = useSessionStore((s) => s.showAppError);

  // ── Coordinated actions (cross-store wrappers) ──
  const addFrames = useCallback((newFrames: FrameMessage[], skipFramePicker?: boolean) => {
    const { maxBuffer: mb, activeSelectionSetSelectedIds } = useDiscoveryUIStore.getState();
    useDiscoveryFrameStore.getState().addFrames(newFrames, mb, skipFramePicker, activeSelectionSetSelectedIds);
  }, []);

  const toggleFrameSelection = useCallback((id: string) => {
    const { activeSelectionSetId: asid, setSelectionSetDirty: ssd } = useDiscoveryUIStore.getState();
    useDiscoveryFrameStore.getState().toggleFrameSelection(id, asid, ssd);
  }, []);

  const bulkSelectBus = useCallback((bus: number | null, select: boolean) => {
    const { activeSelectionSetId: asid, setSelectionSetDirty: ssd } = useDiscoveryUIStore.getState();
    useDiscoveryFrameStore.getState().bulkSelectBus(bus, select, asid, ssd);
  }, []);

  const selectAllFrames = useCallback(() => {
    const { activeSelectionSetId: asid, setSelectionSetDirty: ssd } = useDiscoveryUIStore.getState();
    useDiscoveryFrameStore.getState().selectAllFrames(asid, ssd);
  }, []);

  const deselectAllFrames = useCallback(() => {
    const { activeSelectionSetId: asid, setSelectionSetDirty: ssd } = useDiscoveryUIStore.getState();
    useDiscoveryFrameStore.getState().deselectAllFrames(asid, ssd);
  }, []);

  const applySelectionSet = useCallback((selectionSet: SelectionSet) => {
    const uiState = useDiscoveryUIStore.getState();
    const protocol = protocolOf(useDiscoveryFrameStore.getState().frameInfoMap) ?? 'can';
    useDiscoveryFrameStore.getState().applySelectionSet(
      selectionSet, protocol, uiState.setActiveSelectionSet, uiState.setSelectionSetDirty
    );
    uiState.setActiveSelectionSetSelectedIds(
      new Set(selectionSetKeys(selectionSet, protocol).selected)
    );
  }, []);

  const setActiveSelectionSet = useCallback((id: string | null) => {
    const uiState = useDiscoveryUIStore.getState();
    uiState.setActiveSelectionSet(id);
    if (id === null) {
      uiState.setActiveSelectionSetSelectedIds(null);
    }
  }, []);

  const openSaveDialog = useCallback(() => {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '');
    let protocol = protocolOf(useDiscoveryFrameStore.getState().frameInfoMap)
      ?? getDiscoveryFrameBuffer()[0]?.protocol
      ?? 'can';
    if (useDiscoverySerialStore.getState().isSerialMode) {
      protocol = 'serial';
    }
    const filename = `${dateStr}-${timeStr}-${protocol}.toml`;
    const uiState = useDiscoveryUIStore.getState();
    uiState.updateSaveMetadata({ ...uiState.saveMetadata, filename });
    uiState.openSaveDialog();
  }, []);

  const saveFrames = useCallback((decoderDir: string, saveFrameIdFormat: 'hex' | 'decimal') => {
    const { selectedFrames: sf, frameInfoMap: fim } = useDiscoveryFrameStore.getState();
    return useDiscoveryUIStore.getState().saveFrames(decoderDir, saveFrameIdFormat, sf, fim);
  }, []);

  const openInfoView = useCallback(() => {
    const fim = useDiscoveryFrameStore.getState().frameInfoMap;
    useDiscoveryToolboxStore.getState().openInfoView(fim);
  }, []);

  const { effective: displayFrameIdFormat } = useFrameIdFormat();
  const displayTimeFormat = settings?.display_time_format ?? "human";
  const saveFrameIdFormat = getSaveFrameIdFormat(settings);
  const decoderDir = settings?.decoder_dir ?? "";
  const dumpDir = settings?.dump_dir ?? "";

  // Dialog visibility states managed by hook
  const dialogs = useDialogManager([
    'bookmark',
    'speedPicker',
    'speedChange',
    'export',
    'bookmarkPicker',
    'saveSelectionSet',
    'ioSessionPicker',
    'framePicker',
    'toolbox',
  ] as const);

  // Selection sets for the dropdown in FramePicker (auto-refreshes cross-panel)
  const { selectionSets } = useSelectionSets();

  // Additional dialog state (data associated with dialogs)
  const [bookmarkFrameId, setBookmarkFrameId] = useState(0);
  const [bookmarkFrameTime, setBookmarkFrameTime] = useState("");
  const [pendingSpeed, setPendingSpeed] = useState<PlaybackSpeed | null>(null);
  const [_activeBookmarkId, setActiveBookmarkId] = useState<string | null>(null);

  // Playback direction state (for capture replay)
  const [playbackDirection, setPlaybackDirection] = useState<"forward" | "backward">("forward");

  // Capture metadata state (for imported CSV files)
  const [captureMetadata, setCaptureMetadata] = useState<CaptureMetadata | null>(null);

  // Time range visibility
  const [showTimeRange] = useState(false);

  // Modbus scan state (from toolbox store)
  const startModbusScanStore = useDiscoveryToolboxStore((s) => s.startModbusScan);
  const finishModbusScan = useDiscoveryToolboxStore((s) => s.finishModbusScan);

  // Ref to track paused state (used by callbacks that can't access manager state directly)
  // When paused, frame emissions are from stepping - position updates, not new data
  const isPausedRef = useRef(false);
  const autoImportRef = useRef(false);
  // Ref to track capture mode (when true, useCaptureFrameView handles display - don't accumulate)
  const inCaptureModeRef = useRef(false);

  // NOTE: Auto-join capture on mount and CAPTURE_CHANGED events removed.
  // Discovery should NOT automatically join capture sessions.

  // Callbacks for reader session
  // Note: Watch frame counting is handled by useIOSessionManager
  const handleFrames = useCallback((receivedFrames: FrameMessage[]) => {
    if (!receivedFrames || receivedFrames.length === 0) return;
    // Only add frames when actively running (not paused). When paused, frame emissions
    // are from stepping (position updates), not new data to accumulate.
    if (isPausedRef.current) return;
    // In capture mode, useCaptureFrameView handles display — don't accumulate frames in memory
    if (inCaptureModeRef.current) return;
    // In serial mode, skip frame picker updates until framing is accepted
    // The frame picker will be populated with correct IDs when acceptFraming is called
    const skipFramePicker = isSerialMode && !framingAccepted;
    addFrames(receivedFrames, skipFramePicker);
    incrementBackendFrameCount(receivedFrames.length);
  }, [addFrames, incrementBackendFrameCount, isSerialMode, framingAccepted]);

  const handleError = useCallback((error: string) => {
    // Stream errors are shown centrally via sessionStore's global IO error dialog
    // (the SessionError handler), so this only logs — showing one here too would
    // double-report to Sentry. Matches the Decoder pattern.
    console.error("Discovery stream error:", error);
  }, []);

  const handleTimeUpdate = useCallback((position: PlaybackPosition) => {
    // Update local store for backward compatibility (components that still read from store)
    updateCurrentTime(position.timestamp_us / 1_000_000);
    setCurrentFrameIndex(position.frame_index);
  }, [updateCurrentTime, setCurrentFrameIndex]);

  // Handle session suspended (from any app sharing this session)
  // This fetches capture metadata and frame info so Discovery can show timeline controls
  const handleSessionSuspended = useCallback(async (payload: import("../../api/io").SessionSuspendedPayload) => {
    if (payload.capture_count > 0 && payload.capture_id) {
      const meta = await getCaptureMetadata(payload.capture_id);
      if (meta) {
        setCaptureMetadata(meta);
        enableCaptureMode(meta.count);

        // Fetch frame info from backend capture (populates frame picker)
        try {
          const frameInfoList = await getCaptureFrameInfo(payload.capture_id);
          console.log(`[Discovery] Session suspended - loaded ${frameInfoList.length} unique frame IDs from capture`);
          setFrameInfoFromCapture(frameInfoList);
        } catch (err) {
          console.warn('[Discovery] Failed to fetch frame info after suspend:', err);
        }
      }
    }
  }, [enableCaptureMode, setFrameInfoFromCapture]);

  const handleSessionSpeedChange = useCallback((speed: number) => {
    setPlaybackSpeed(speed as PlaybackSpeed);
  }, [setPlaybackSpeed]);

  // Ingest complete handler - passed to useIOSessionManager
  const handleIngestComplete = useCallback(async (payload: StreamEndedInfo) => {
    if (payload.capture_available && payload.count > 0 && payload.capture_id) {
      const meta = await getCaptureMetadata(payload.capture_id);
      if (meta) {
        setCaptureMetadata(meta);

        await emit(WINDOW_EVENTS.CAPTURE_CHANGED, {
          metadata: meta,
          action: "ingested",
        });
      }

      dialogs.ioSessionPicker.close();

      if (payload.capture_kind === "bytes" && meta) {
        console.log(`[Discovery] Loading ${payload.count} bytes from capture into serial view`);
        clearSerialBytes();
        resetFraming();
      } else {
        // Always enable capture mode so playback controls appear
        // (Session is now in capture replay mode after ingest)
        console.log(`[Discovery] Ingest complete (${payload.count} frames) - enabling capture mode for playback controls`);
        enableCaptureMode(payload.count);

        // Load frame info for the frame picker
        try {
          const frameInfoList = await getCaptureFrameInfo(payload.capture_id);
          console.log(`[Discovery] Loaded ${frameInfoList.length} unique frame IDs from capture`);
          setFrameInfoFromCapture(frameInfoList);
        } catch (e) {
          console.error("Failed to load frame info from capture:", e);
        }

        // No need to load frames into memory — useCaptureFrameView handles display via pagination
      }

      // NOTE: Don't switch ioProfile to capture ID - session stays at ingest_xxxxx
      // The session is now in capture replay mode, playback controls will work
    }
  }, [
    dialogs.ioSessionPicker,
    enableCaptureMode,
    setFrameInfoFromCapture,
  ]);

  // Callback for when session is reconfigured (e.g., bookmark jump)
  const handleSessionReconfigured = useCallback((info: SessionReconfigurationInfo) => {
    if (info.reason === "bookmark" && info.bookmark) {
      setStartTime(info.bookmark.startTime);
      setEndTime(info.bookmark.endTime);
      setActiveBookmarkId(info.bookmark.id);

      // Zero the time delta from the bookmark's start time
      if (info.startTime) {
        const startTimeUs = new Date(info.startTime).getTime() * 1000;
        setStreamStartTimeUs(startTimeUs);
      }

      // Reset playback position so the scrubber doesn't show a stale position
      updateCurrentTime(null);
      setCurrentFrameIndex(null);
    }
  }, [setStartTime, setEndTime, setActiveBookmarkId, setStreamStartTimeUs, updateCurrentTime, setCurrentFrameIndex]);

  // The single teardown entry point for Discovery. Every path that drops a source —
  // starting a new watch, destroying, leaving, switching profile, "Continue without a
  // source" — goes through here, so none of them can clear half the view.
  const resetDiscoveryView = useCallback(() => {
    // One store write, so there is no render where the rows still exist but the
    // frame picker already reads 0/0.
    clearAll();
    clearAnalysisResults();
    disableCaptureMode();
    setCaptureMetadata(null); // Clear stale metadata so effectiveStartTimeUs doesn't use old values
    clearSerialBytes();
    resetFraming();
    setBackendFrameCount(0);
    // Reset refs checked by handleFrames — prevents stale values from a previous
    // session (e.g., capture mode after stop) from silently dropping frames
    isPausedRef.current = false;
    inCaptureModeRef.current = false;
  }, [clearAll, clearAnalysisResults, disableCaptureMode, clearSerialBytes, resetFraming, setBackendFrameCount]);

  // Handle session destroyed — switch to orphaned capture if available
  const handleSessionDestroyed = useCallback(async (orphanedCaptureIds: string[]) => {
    if (orphanedCaptureIds.length === 0) return;
    const captureId = orphanedCaptureIds[0];
    try {
      const meta = await getCaptureMetadataById(captureId);
      if (meta) {
        setCaptureMetadata(meta);
        enableCaptureMode(meta.count);
        const frameInfoList = await getCaptureFrameInfo(captureId);
        setFrameInfoFromCapture(frameInfoList);
      }
    } catch (err) {
      console.warn('[Discovery] Failed to load capture after session destroyed:', err);
    }
  }, [enableCaptureMode, setFrameInfoFromCapture]);

  // Use the IO session manager hook - manages session lifecycle, ingest, multi-bus, and derived state
  const manager = useIOSessionManager({
    appName: "discovery",
    ioProfiles: allIOProfiles,
    store: { ioProfile, setIoProfile },
    enableIngest: true,
    onIngestComplete: handleIngestComplete,
    onFrames: handleFrames,
    onError: handleError,
    onTimeUpdate: handleTimeUpdate,
    onSuspended: handleSessionSuspended,
    onSpeedChange: handleSessionSpeedChange,
    // Session switching callbacks
    setPlaybackSpeed: (speed: number) => setPlaybackSpeed(speed as PlaybackSpeed),
    onBeforeWatch: resetDiscoveryView,
    onBeforeMultiWatch: resetDiscoveryView,
    onSessionReconfigured: handleSessionReconfigured,
    onSessionDestroyed: handleSessionDestroyed,
  });

  // Destructure everything from the manager
  const {
    // Multi-bus state
    multiBusProfiles: ioProfiles,
    outputBusToSource,
    sourceProfileId,
    setSourceProfileId,
    // Session
    session,
    // Profile name (for menu display)
    ioProfileName,
    // Derived state
    isStreaming,
    isPaused,
    isStopped,
    canReturnToLive,
    isRealtime,
    isCaptureMode,
    sessionReady,
    capabilities,
    joinerCount,
    // Centralised playback position (from session store)
    currentTimeUs: sessionCurrentTimeUs,
    currentFrameIndex: sessionCurrentFrameIndex,
    handleLeave,
    // Watch state (used by ioPickerProps hook)
    watchFrameCount,
    watchUniqueFrameCount,
    watchByteCount,
    bytesCaptureId: sessionBytesCaptureId,
    resetWatchFrameCount,
    // Session switching methods
    stopWatch,
    handleDestroy,
    resumeWithNewCapture,
    selectProfile,
    watchSource,
    joinSession,
    // Bookmark methods
    jumpToBookmark,
  } = manager;

  // Session controls from the underlying session
  const {
    sessionId,
    state: readerState,
    captureId: sessionCaptureId,
    captureKind,
    captureStartTimeUs,
    captureEndTimeUs,
    captureCount,
    start,
    pause,
    resume,
    setSpeed,
    setTimeRange,
    seek,
    seekByFrame,
    reinitialize,
  } = session;

  // The Modbus session on screen, if this is one — the poll switch's subject.
  // The scan tools take no address from here; they name their own device.
  //
  // Resolve the profile the way useModbusPolling does. `ioProfiles`
  // (multiBusProfiles) is empty for a single-source watch and for a session
  // joined without source ids, and `ioProfile` holds the *session* id, not a
  // profile id — reading only the first of those was why a single-source Modbus
  // session silently fell back to some other configured profile's address.
  const modbusTarget = useMemo<ModbusPollerRef | null>(() => {
    // Resolution answers "which session", not "is anyone reading it" — a session
    // whose source ended keeps its Modbus capabilities, so this stays non-null
    // while nothing polls. `live` below is what answers the second half.
    if (!sessionId) return null;
    if (!capabilities?.traits?.protocols?.includes("modbus")) return null;
    const candidates = ioProfiles.length > 0 ? ioProfiles : sourceProfileId ? [sourceProfileId] : [];
    for (const profileId of candidates) {
      const profile = allIOProfiles.find((p) => p.id === profileId);
      if (profile?.kind !== 'modbus_tcp') continue;
      return { sessionId, profileId, name: profile.name || profileId };
    }
    return null;
  }, [ioProfiles, sourceProfileId, sessionId, allIOProfiles, capabilities?.traits?.protocols]);

  // Rust names what it is (`source_type`); the id prefix only covers the beat
  // between minting the scan session and the roster reconcile landing.
  const scanSourceType = useSessionStore((s) => s.sessions[sessionId]?.sourceType);
  const onScanSession = isModbusScanSession(sessionId, scanSourceType);

  // The session whose poller the top-bar switch drives, and whether it is
  // actually polling — one fact, so one piece of state.
  //
  // Not `modbusTarget` directly: starting a sweep joins its scan session, which
  // reports Modbus too, so from then on `modbusTarget` names the sweep rather
  // than the device's poller. Hold the last real poller instead, so the switch
  // keeps meaning the same thing while a sweep's results are on screen.
  //
  // `live` is not a formality: a Modbus source with no poll groups refuses to
  // start, ends its stream at once (`no_polls`) and never opens a connection —
  // so the switch must not offer to pause what was never polling.
  const [poller, setPoller] = useState<{ session: ModbusPollerRef; live: boolean } | null>(null);
  useEffect(() => {
    if (onScanSession) return;
    setPoller(modbusTarget ? { session: modbusTarget, live: isStreaming } : null);
  }, [modbusTarget, onScanSession, isStreaming]);

  const {
    isPolling: pollingRequested,
    pausePolling: pauseModbusPolling,
    resumePolling: resumeModbusPolling,
  } = useModbusPollControl({
    sessionId: poller?.session.sessionId ?? null,
    profileId: poller?.session.profileId ?? null,
  });

  // What withholds the scan tools. A sweep names its own device and takes the
  // view over to show the results, so it wants no source selected — and joining
  // its session would destroy whichever one was. Its own sweeps are exempt:
  // chaining probe → unit scan → register sweep is how an unknown device gets
  // worked out, and each answer aims the next.
  const hasSource = Boolean(sessionId) && !onScanSession;

  // Note: isStreaming, isPaused, isStopped, isRealtime are now provided by useIOSessionManager

  // Fetch capture metadata and frame info when:
  // - Joining a session already in capture mode (another app stopped)
  // - Session is paused with captured data (for stepping through frames)
  useEffect(() => {
    const shouldFetchMetadata = sessionId && sessionCaptureId && !captureMetadata && (
      (isCaptureMode && !isStreaming) ||  // Explicit capture mode
      (isPaused && captureCount > 0)       // Paused with captured frames
    );

    if (shouldFetchMetadata) {
      (async () => {
        try {
          // Fetch capture metadata
          const meta = await getCaptureMetadata(sessionCaptureId);
          if (meta) {
            setCaptureMetadata(meta);
            enableCaptureMode(meta.count);

            // Fetch frame info from backend capture (populates frame picker)
            const frameInfoList = await getCaptureFrameInfo(sessionCaptureId);
            console.log(`[Discovery] Loaded ${frameInfoList.length} unique frame IDs from capture`);
            setFrameInfoFromCapture(frameInfoList);
          }
        } catch (err) {
          console.warn('[Discovery] Failed to fetch capture data:', err);
        }
      })();
    }
  }, [isCaptureMode, isStreaming, isPaused, captureCount, captureMetadata, sessionId, sessionCaptureId, enableCaptureMode, setFrameInfoFromCapture]);

  // Keep paused ref in sync with manager state (for callbacks that can't access manager directly)
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  // Keep capture mode ref in sync (useCaptureFrameView handles display in capture mode)
  useEffect(() => {
    inCaptureModeRef.current = isCaptureMode || captureMode.enabled;
  }, [isCaptureMode, captureMode.enabled]);

  // Centralised IO picker handlers - ensures consistent behavior with other apps
  const ioPickerProps = useIOSourcePickerHandlers({
    manager,
    closeDialog: () => dialogs.ioSessionPicker.close(),
    onJoinSession: (_sessionId, sourceProfileIds) => {
      // Discovery-specific: show bus column for multi-source
      if (sourceProfileIds && sourceProfileIds.length > 1) {
        setShowBusColumn(true);
      }
    },
    onBeforeStart: (profileId, options, mode) => {
      // Store serial config for TOML export
      const hasSerialConfig = options.frameIdStartByte !== undefined
        || options.sourceAddressStartByte !== undefined
        || options.minFrameLength !== undefined;
      if (hasSerialConfig) {
        setSerialConfig({
          frame_id_start_byte: options.frameIdStartByte,
          frame_id_bytes: options.frameIdBytes,
          source_address_start_byte: options.sourceAddressStartByte,
          source_address_bytes: options.sourceAddressBytes,
          source_address_byte_order: options.sourceAddressEndianness,
          min_frame_length: options.minFrameLength,
        });
      } else {
        setSerialConfig(null);
      }

      setSourceProfileId(profileId);

      // Sync framing config (watch mode only)
      if (mode === "connect") {
        if (options.framingEncoding && options.framingEncoding !== "raw") {
          const storeFramingConfig =
            options.framingEncoding === "slip"
              ? { mode: "slip" as const }
              : options.framingEncoding === "modbus_rtu"
              ? { mode: "modbus_rtu" as const, validateCrc: true }
              : {
                  mode: "raw" as const,
                  delimiter: options.delimiter
                    ? options.delimiter.map((b: number) => b.toString(16).toUpperCase().padStart(2, "0")).join("")
                    : "0A",
                  maxLength: options.maxFrameLength ?? 256,
                };
          setFramingConfig(storeFramingConfig);
        } else {
          setFramingConfig(null);
        }
      }
    },
    onBeforeMultiStart: (_profileIds, _options, _mode) => {
      setShowBusColumn(true);
    },
    onMultiBusSet: () => {
      setShowBusColumn(true);
    },
  });

  // For realtime sources, update clock every second while streaming
  const [realtimeClock, setRealtimeClock] = useState<number | null>(null);
  useEffect(() => {
    if (!isStreaming || !isRealtime) {
      setRealtimeClock(null);
      return;
    }
    setRealtimeClock(Date.now() / 1000);
    const interval = setInterval(() => {
      setRealtimeClock(Date.now() / 1000);
    }, REALTIME_CLOCK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isStreaming, isRealtime]);

  // Update currentTime when capture metadata changes
  useEffect(() => {
    if (captureMetadata?.start_time_us != null && !isStreaming) {
      updateCurrentTime(captureMetadata.start_time_us / 1_000_000);
    }
  }, [captureMetadata?.start_time_us, isStreaming, updateCurrentTime]);

  const displayTimeSeconds = isRealtime ? realtimeClock : currentTime;

  // Initialize IO profile and history from settings
  useEffect(() => {
    if (settings?.default_read_profile) {
      setIoProfile(settings.default_read_profile);
    }
    if (settings?.discovery_history_buffer) {
      setMaxBuffer(settings.discovery_history_buffer);
    }
  }, [settings, setIoProfile, setMaxBuffer]);

  // Detect if current profile is serial - use session traits from capabilities
  const prevIsSerialModeRef = useRef(false);
  useEffect(() => {
    let newIsSerialMode = false;

    if (!ioProfile) {
      newIsSerialMode = false;
    } else if (isCaptureMode) {
      // Capture mode: check capture metadata for bytes type
      newIsSerialMode = captureMetadata?.kind === "bytes" || captureKind === "bytes" || framedCaptureId !== null;
    } else {
      // Live session: the Serial view belongs to a serial *link*, framed or not.
      // Not data_streams.rx_bytes — that says whether raw bytes are on the wire,
      // so a SLIP or Modbus RTU port would lose the view it exists for. Not
      // protocols either: a FrameLink RS-485 interface contributes
      // Protocol::Serial but delivers framed messages, and its kind is framelink.
      newIsSerialMode = capabilities?.serial_link ?? false;
    }

    setSerialMode(newIsSerialMode);

    if (prevIsSerialModeRef.current && !newIsSerialMode) {
      clearSerialBytes();
    }
    prevIsSerialModeRef.current = newIsSerialMode;
  }, [ioProfile, capabilities, captureMetadata, captureKind, framedCaptureId, setSerialMode, clearSerialBytes]);

  const frameList = useMemo(
    () =>
      Array.from(frameInfoMap.entries()).map(([fk, info]) => ({
        id: fk,
        len: info.len,
        isExtended: info.isExtended,
        bus: info.bus,
        lenMismatch: info.lenMismatch,
        protocol: info.protocol,
      })),
    [frameInfoMap]
  );

  // Ordered by how direct the evidence is: a frame in hand, then what the capture says it
  // holds (in capture mode the buffer is empty by design), then the session's own
  // declaration — without that last one a Modbus session reads CAN until its first frame.
  //
  // No default: with no source and no frames there is no protocol, and the `|| 'can'` that
  // used to sit here made a Function Code Probe against a Modbus device label itself CAN.
  // What an open tool tab implies is the frames view's business, not this value's — it also
  // names export files, which want the data's protocol and not the tab's.
  const protocolLabel = frames[0]?.protocol
    || protocolOf(frameInfoMap)
    || capabilities?.traits?.protocols?.[0];

  // Every protocol the stream carries — the frames seen plus what the session
  // declares, so a tab exists before its first frame. A mixed stream lists both.
  const protocols = useMemo(() => {
    const set = new Set<string>(capabilities?.traits?.protocols ?? []);
    for (const info of frameInfoMap.values()) {
      if (info.protocol) set.add(info.protocol);
    }
    return [...set];
  }, [capabilities?.traits?.protocols, frameInfoMap]);

  // Non-realtime sources: recorded (WireTAP backend, csv) and capture replay
  const isRecorded = capabilities?.traits.temporal_mode === "recorded"
    || capabilities?.traits.temporal_mode === "capture";

  /** The capture this app is reading: an opened one, else the session's own. */
  const activeCaptureId = captureMetadata?.id ?? sessionCaptureId;
  /** Frames in it. `captureCount` is the capture-mode counter and reads 0 live. */
  const liveFrameCount = isCaptureMode ? captureCount : watchFrameCount;

  // Merged capture metadata using session values for cross-app timeline sync
  const effectiveCaptureMetadata = useEffectiveCaptureMetadata(
    { captureStartTimeUs, captureEndTimeUs, captureCount, captureName: session.captureName, capturePersistent: session.capturePersistent },
    captureMetadata
  );

  // Export dialog computed values
  const exportDataMode: ExportDataMode = useMemo(() => {
    if (isSerialMode) {
      if (serialActiveTab === 'raw') return "bytes";
      if (serialActiveTab === 'framed' && (backendFrameCount > 0 || framedData.length > 0)) return "frames";
      return "bytes";
    }
    return "frames";
  }, [isSerialMode, serialActiveTab, backendFrameCount, framedData.length]);

  const exportItemCount = useMemo(() => {
    if (exportDataMode === "bytes") {
      return watchByteCount;
    }
    if (captureMode.enabled) return captureMode.totalFrames;
    if (isSerialMode && framedCaptureId && backendFrameCount > 0) return backendFrameCount;
    if (isSerialMode && framedData.length > 0) return framedData.length;
    return frames.length;
  }, [exportDataMode, watchByteCount, captureMode, isSerialMode, framedCaptureId, backendFrameCount, framedData.length, frames.length]);

  const exportDefaultFilename = useMemo(() => {
    // Not "can": this fires only when nothing said what the frames are, and naming
    // them after a protocol nobody reported is how the badge got it wrong.
    const protocol = exportDataMode === "bytes" ? "serial" : (protocolLabel ?? "frames");
    return `${formatFilenameDate()}-${protocol}`;
  }, [exportDataMode, protocolLabel]);

  useModbusScanSync();

  /**
   * Start a scan as its own session.
   *
   * Order matters: the session is created *stopped*, joined, and only then
   * started. The backend snapshots a capture's frame count when a subscriber
   * attaches, so anything appended before the join is never pushed over the
   * WebSocket — starting first would silently drop the opening registers and
   * look like an intermittent "some registers missing" bug.
   */
  const runModbusScan = useCallback(async (
    scanType: 'register' | 'unit-id',
    job: ScanJob,
    meta: { registerType: string; unitId: number },
    errorMessage: string,
  ) => {
    const scanSessionId = `${MODBUS_SCAN_SESSION_PREFIX}${Date.now().toString(36)}`;
    // Tell Save how to render the discovered registers as a catalogue.
    setModbusExportConfig({
      device_address: meta.unitId,
      register_base: 0,
      register_type: meta.registerType as ModbusExportConfig["register_type"],
      default_interval: 1000,
    });
    try {
      // No target session: the address comes from the panel, which is the whole
      // point of running these with no source selected. `targetSessionId` and
      // `stopTarget` stay in the API for MCP, which can sweep a device someone
      // else already has open. Contention is still refused by name — another app
      // polling this endpoint is a reason to stop, not to collect a half-empty
      // register map.
      await createModbusScanSession(scanSessionId, job, { appName: "discovery" });
      await joinSession(scanSessionId);
      // After the session exists, not before: the record *is* the tab, so a
      // refused sweep would otherwise leave one behind with nothing in it.
      startModbusScanStore(scanType, scanSessionId);
      await startReaderSession(scanSessionId);
    } catch (e) {
      finishModbusScan();
      showAppError(t("errors.scanTitle"), errorMessage, String(e));
    }
  }, [startModbusScanStore, finishModbusScan, showAppError, setModbusExportConfig, joinSession, t]);

  const handleStartModbusScan = useCallback((config: ModbusScanConfig) => {
    void runModbusScan(
      'register',
      { kind: "registers", config },
      { registerType: config.register_type, unitId: config.unit_id },
      t("errors.modbusRegisterScanMessage"),
    );
  }, [runModbusScan, t]);

  const handleStartModbusUnitIdScan = useCallback((config: UnitIdScanConfig) => {
    void runModbusScan(
      'unit-id',
      { kind: "unit_ids", config },
      { registerType: config.register_type, unitId: config.start_unit_id },
      t("errors.modbusUnitScanMessage"),
    );
  }, [runModbusScan, t]);

  // The probe answers in one call rather than owning a session, so it writes its
  // own result: no capture, no progress channel, nothing to subscribe to. The
  // failure goes in the tab beside the table — a probe that got no answer is a
  // finding about the device, not an error dialog's business.
  const handleStartModbusFcProbe = useCallback(async (config: FcProbeConfig, deviceName: string) => {
    const store = useDiscoveryToolboxStore.getState();
    store.startModbusFcProbe(deviceName);
    try {
      const entries = await probeModbusFunctionCodes(config);
      store.finishModbusFcProbe({ entries });
    } catch (e) {
      store.finishModbusFcProbe({ error: String(e) });
    }
  }, []);

  // Cancelling is stopping the scan's session: that sets its cancel flag, waits
  // for the sweep to unwind, and finalises the capture, so the registers found
  // before the stop are kept rather than discarded.
  const handleCancelModbusScan = useCallback(async () => {
    const scanSessionId = runningModbusScan(useDiscoveryToolboxStore.getState().toolbox)?.sessionId;
    if (!scanSessionId) return;
    try {
      await stopReaderSession(scanSessionId);
    } catch (e) {
      // Only end the scan here if the stop failed — otherwise the sweep's own
      // terminal "cancelled" state, pushed on the session channel, ends it.
      console.warn('[Discovery] Failed to cancel scan:', e);
      finishModbusScan();
    }
  }, [finishModbusScan]);

  // Use the handlers hook
  const handlers = useDiscoveryHandlers({
    // Session state
    sessionId,
    isStreaming,
    isPaused,
    sessionReady,
    ioProfile,
    sourceProfileId,
    playbackSpeed,
    isStopped,
    captureModeEnabled: captureMode.enabled,
    captureModeTotalFrames: captureMode.totalFrames,

    // Frame state
    frames,
    framedData,
    framedCaptureId,
    frameInfoMap,
    selectedFrames,

    // Serial state
    isSerialMode,
    backendByteCount: watchByteCount,
    backendFrameCount,

    // Time state
    startTime,
    endTime,
    currentFrameIndex,
    currentTimestampUs: currentTime !== null ? currentTime * 1_000_000 : null,

    // Selection set state
    activeSelectionSetId,
    selectionSetDirty,

    // Export state
    exportDataMode,
    decoderDir,
    saveFrameIdFormat,
    dumpDir,

    // Local state
    pendingSpeed,
    setPendingSpeed,
    setActiveBookmarkId,
    setBookmarkFrameId,
    setBookmarkFrameTime,
    resetWatchFrameCount,
    setCaptureMetadata,

    // Manager session switching methods
    stopWatch,
    selectProfile,
    watchSource,
    jumpToBookmark,

    // Session actions
    setIoProfile,
    start,
    pause,
    resume,
    reinitialize,
    handleClearCapture: manager.handleClearCapture,
    setSpeed,
    setTimeRange,
    seek,
    seekByFrame,

    // Store actions
    setPlaybackSpeed,
    updateCurrentTime,
    setCurrentFrameIndex,
    setMaxBuffer,
    setStartTime,
    setEndTime,
    clearAll,
    resetView: resetDiscoveryView,
    enableCaptureMode,
    setFrameInfoFromCapture,
    setBackendFrameCount,
    openSaveDialog,
    saveFrames,
    setActiveSelectionSet,
    setSelectionSetDirty,
    applySelectionSet,

    // API functions (for export/other features)
    // Bytes live in their own capture. Falling back to the session's frames capture (as
    // this used to) reads a Frames capture with a byte query, which returns nothing — an
    // export that promised N bytes and wrote none.
    getCaptureBytesPaginated: (offset, limit) => getCaptureBytesPaginated(sessionBytesCaptureId ?? '', offset, limit),
    getCaptureFramesPaginated: (offset, limit) => getCaptureFramesPaginated(activeCaptureId!, offset, limit),
    getCaptureFramesPaginatedById,
    captureMetadata,
    pickFileToSave,
    saveCatalog,

    // Dialog controls
    openBookmarkDialog: dialogs.bookmark.open,
    closeSpeedChangeDialog: dialogs.speedChange.close,
    openSaveSelectionSetDialog: dialogs.saveSelectionSet.open,
    closeExportDialog: dialogs.export.close,
  });

  // Capture-level frame change: when there's no active session (after LEAVE),
  // derive the timestamp from the capture so the timeline updates during stepping.
  const handleFrameChangeWithBuffer = useCallback(async (frameIndex: number) => {
    setCurrentFrameIndex(frameIndex);
    if (sessionId && capabilities?.supports_seek) {
      // Active session: delegate to backend seek (emits position event)
      await seekByFrame(frameIndex);
    } else {
      // Capture-only mode: look up timestamp from capture
      const selection = groupKeysByProtocol(selectedFrames);
      const frameBufferId = activeCaptureId;
      try {
        const response = await getCaptureFramesPaginatedFiltered(frameBufferId!, frameIndex, 1, selection);
        if (response.frames.length > 0) {
          updateCurrentTime(response.frames[0].timestamp_us / 1_000_000);
        }
      } catch {
        // Best effort — timestamp syncs when page loads
      }
    }
  }, [sessionId, capabilities, seekByFrame, selectedFrames, captureMetadata, sessionCaptureId, setCurrentFrameIndex, updateCurrentTime]);

  // ── Menu session control ──
  const bookmarkProfileId = sourceProfileId || ioProfile;
  useMenuSessionControl({
    panelId: "discovery",
    sessionState: {
      profileName: ioProfileName ?? null,
      isStreaming,
      isPaused,
      capabilities,
      joinerCount,
    },
    callbacks: {
      onPlay: () => {
        if (isPaused) resume();
        else if (isStopped && sessionReady) resumeWithNewCapture();
      },
      onPause: () => {
        if (isStreaming && !isPaused) pause();
      },
      onStop: () => {
        if (isStreaming && !isPaused) pause();
      },
      onStopAll: () => {
        if (isStreaming) stopWatch();
      },
      onClear: () => handlers.handleClearDiscoveredFrames(),
      onPicker: () => dialogs.ioSessionPicker.open(),
      onImportFromFile: () => { autoImportRef.current = true; dialogs.ioSessionPicker.open(); },
      onJumpToBookmark: async (bookmarkId) => {
        const profileId = sourceProfileId || ioProfile;
        if (profileId) {
          const bookmarks = await getFavoritesForProfile(profileId);
          const bookmark = bookmarks.find((b) => b.id === bookmarkId);
          if (bookmark) await jumpToBookmark(bookmark);
        }
      },
      onBookmarkSave: () => {
        const timeUs = currentTime !== null ? currentTime * 1_000_000 : 0;
        setBookmarkFrameId(0);
        setBookmarkFrameTime(new Date(timeUs / 1000).toISOString());
        dialogs.bookmark.open();
      },
    },
    bookmarks: { profileId: bookmarkProfileId },
  });


  return (
    <AppLayout
      topBar={
        <DiscoveryTopBar
          ioProfiles={allIOProfiles}
          ioProfile={ioProfile}
          onIoProfileChange={handlers.handleIoProfileChange}
          defaultReadProfileId={settings?.default_read_profile}
          captureMetadata={effectiveCaptureMetadata ?? captureMetadata}
          sessionId={sessionId}
          isStreaming={isStreaming}
          isPaused={isPaused}
          multiBusProfiles={sessionId ? ioProfiles : []}
          ioState={readerState}
          outputBusToSource={outputBusToSource}
          isStopped={isStopped || canReturnToLive}
          onPlay={isStopped || canReturnToLive ? resumeWithNewCapture : handlers.handlePlay}
          onPause={handlers.handlePause}
          onLeave={handleLeave}
          onStop={isStreaming ? stopWatch : undefined}
          onDestroy={handleDestroy}
          supportsTimeRange={capabilities?.supports_time_range ?? false}
          onOpenBookmarkPicker={() => dialogs.bookmarkPicker.open()}
          speed={playbackSpeed}
          supportsSpeed={capabilities?.supports_speed_control ?? false}
          onOpenSpeedPicker={() => dialogs.speedPicker.open()}
          frameCount={frameList.length}
          uniqueFrameCount={isCaptureMode ? frameInfoMap.size : watchUniqueFrameCount}
          totalFrameCount={liveFrameCount}
          selectedFrameCount={selectedFrames.size}
          onOpenFramePicker={() => dialogs.framePicker.open()}
          isSerialMode={isSerialMode}
          serialBytesCount={watchByteCount}
          framingAccepted={framingAccepted}
          serialActiveTab={serialActiveTab}
          onUndoFraming={undoAcceptFraming}
          modbus={poller ? {
            deviceName: poller.session.name,
            isPolling: poller.live && pollingRequested,
            onPause: pauseModbusPolling,
            onResume: resumeModbusPolling,
          } : undefined}
          isCaptureMode={isCaptureMode}
          capturePersistent={session.capturePersistent}
          onToggleCapturePin={() => {
            const bid = activeCaptureId;
            if (bid) useSessionStore.getState().setSessionCapturePersistent(bid, !session.capturePersistent);
          }}
          onRenameCapture={(newName) => {
            const bid = activeCaptureId;
            if (bid) {
              const store = useSessionStore.getState();
              store.renameSessionCapture(bid, newName);
              // Auto-pin on rename — naming implies keeping
              if (!session.capturePersistent) {
                store.setSessionCapturePersistent(bid, true);
              }
            }
          }}
          onOpenIoSessionPicker={() => dialogs.ioSessionPicker.open()}
          onClearCapture={handlers.handleClearDiscoveredFrames}
          hasData={frameList.length > 0 || (isSerialMode && watchByteCount > 0)}
          onSave={openSaveDialog}
          onExport={() => dialogs.export.open()}
          onInfo={openInfoView}
          onOpenToolbox={() => dialogs.toolbox.open()}
        />
      }
    >
      {isSerialMode ? (
          <SerialDiscoveryView
            isStreaming={isStreaming}
            displayTimeFormat={displayTimeFormat}
            isRecorded={isRecorded}
            emitsRawBytes={capabilities?.data_streams.rx_bytes ?? false}
            // A serial reader that frames on the wire writes into the session's
            // own capture and derives nothing, so the Framed tab has to be told
            // where those frames are. A *raw* session's own capture is bytes,
            // which a frame pager must not be handed.
            sessionFramesCaptureId={captureKind === "bytes" ? null : activeCaptureId}
            sessionFramesCount={liveFrameCount}
            bytesCaptureId={sessionBytesCaptureId}
            byteCount={watchByteCount}
          />
        ) : (
          <DiscoveryFramesView
            // Unconditional: Rust creates and owns a frame capture for every session and
            // writes each batch to it before signalling, so the capture is the source of
            // truth from the first frame. Gating this on captureMode was what forced the
            // view to keep two in-memory render paths alongside it.
            captureId={activeCaptureId}
            sessionId={sessionId}
            protocol={protocolLabel}
            protocols={protocols}
            onCancelScan={handleCancelModbusScan}
            displayFrameIdFormat={displayFrameIdFormat}
            displayTimeFormat={displayTimeFormat}
            onBookmark={isRecorded ? handlers.handleBookmark : undefined}
            isStreaming={isStreaming}
            timestamp={displayTimeSeconds}
            streamStartTimeUs={streamStartTimeUs}
            showTimeRange={showTimeRange}
            startTime={startTime}
            endTime={endTime}
            onStartTimeChange={handlers.handleStartTimeChange}
            onEndTimeChange={handlers.handleEndTimeChange}
            maxBuffer={maxBuffer}
            onMaxBufferChange={setMaxBuffer}
            currentTimeUs={currentTime !== null ? currentTime * 1_000_000 : sessionCurrentTimeUs}
            onScrub={handlers.handleScrub}
            captureMetadata={effectiveCaptureMetadata}
            isRecorded={isRecorded}
            // Playback controls
            playbackState={isStreaming && !isPaused ? "playing" : "paused"}
            playbackDirection={playbackDirection}
            capabilities={capabilities}
            playbackSpeed={playbackSpeed}
            currentFrameIndex={currentFrameIndex !== null ? currentFrameIndex : sessionCurrentFrameIndex}
            onFrameSelect={async (frameIndex, timestampUs) => {
              setCurrentFrameIndex(frameIndex);
              updateCurrentTime(timestampUs / 1_000_000);
              if (capabilities?.supports_seek) {
                await seekByFrame(frameIndex);
              }
            }}
            onPlay={() => { setPlaybackDirection("forward"); handlers.handlePlay(); }}
            onPlayBackward={() => { setPlaybackDirection("backward"); handlers.handlePlayBackward(); }}
            onPause={handlers.handlePause}
            onStepBackward={handlers.handleStepBackward}
            onStepForward={handlers.handleStepForward}
            onSpeedChange={handlers.handleSpeedChange}
            onFrameChange={handleFrameChangeWithBuffer}
            // Recorded source streaming controls
            isLiveStreaming={isRecorded && isStreaming && !isPaused && !isCaptureMode}
            isStreamPaused={isRecorded && isPaused && !isCaptureMode}
            onResumeStream={resume}
            useLocalTimezone={settings?.display_timezone === 'local'}
          />
        )}

      <SaveFramesDialog
        open={showSaveDialog}
        meta={saveMetadata}
        decoderDir={decoderDir}
        knowledgeInterval={knowledge.meta.defaultInterval}
        knowledgeEndianness={knowledge.analysisRun ? knowledge.meta.defaultEndianness : null}
        onChange={updateSaveMetadata}
        onCancel={closeSaveDialog}
        onSave={handlers.handleSaveFrames}
      />

      <AddBookmarkDialog
        isOpen={dialogs.bookmark.isOpen}
        frameId={bookmarkFrameId}
        frameTime={bookmarkFrameTime}
        onClose={() => dialogs.bookmark.close()}
        onSave={handlers.handleSaveBookmark}
      />

      <AnalysisProgressDialog
        isOpen={toolboxIsRunning}
        frameCount={selectedFrames.size > 0 ? frames.filter(f => selectedFrames.has(keyOf(f))).length : 0}
        toolName={toolboxActiveView === 'changes' ? 'Payload Changes' : toolboxActiveView === 'message-order' ? 'Frame Order' : 'Analysis'}
      />

      <SpeedPickerDialog
        isOpen={dialogs.speedPicker.isOpen}
        onClose={() => dialogs.speedPicker.close()}
        speed={playbackSpeed}
        onSpeedChange={handlers.handleSpeedChange}
      />

      <ConfirmDeleteDialog
        open={dialogs.speedChange.isOpen}
        onCancel={handlers.cancelSpeedChange}
        onConfirm={handlers.confirmSpeedChange}
        title={t("speedChangeDialog.title")}
        message={t("speedChangeDialog.message", {
          frames: frames.length.toLocaleString(i18n.language),
          ids: frameInfoMap.size.toLocaleString(i18n.language),
        })}
        confirmText={t("speedChangeDialog.confirm")}
        cancelText={t("speedChangeDialog.cancel")}
      />

      <ExportFramesDialog
        open={dialogs.export.isOpen}
        itemCount={exportItemCount}
        dataMode={exportDataMode}
        defaultFilename={exportDefaultFilename}
        onCancel={() => dialogs.export.close()}
        onExport={handlers.handleExport}
      />

      <BookmarkEditorDialog
        isOpen={dialogs.bookmarkPicker.isOpen}
        onClose={() => dialogs.bookmarkPicker.close()}
        onLoad={handlers.handleLoadBookmark}
        profileId={sourceProfileId || ioProfile}
      />

      <IoSourcePickerDialog
        isOpen={dialogs.ioSessionPicker.isOpen}
        onClose={() => dialogs.ioSessionPicker.close()}
        ioProfiles={allIOProfiles}
        selectedId={ioProfile}
        selectedIds={ioProfiles.length > 0 ? ioProfiles : undefined}
        defaultId={settings?.default_read_profile}
        onSelect={handlers.handleIoProfileChange}
        {...ioPickerProps}
        onImport={setCaptureMetadata}
        captureMetadata={captureMetadata}
        defaultDir={settings?.dump_dir}
        loadSpeed={playbackSpeed}
        onLoadSpeedChange={(speed) => handlers.handleSpeedChange(speed)}
        allowMultiSelect={true}
        autoImport={autoImportRef.current}
        onAutoImportConsumed={() => { autoImportRef.current = false; }}
      />

      <FramePickerDialog
        isOpen={dialogs.framePicker.isOpen}
        onClose={() => dialogs.framePicker.close()}
        frames={frameList}
        selectedFrames={selectedFrames}
        onToggleFrame={toggleFrameSelection}
        onBulkSelect={bulkSelectBus}
        onSelectAll={selectAllFrames}
        onDeselectAll={deselectAllFrames}
        activeSelectionSetId={activeSelectionSetId}
        selectionSetDirty={selectionSetDirty}
        onSaveSelectionSet={handlers.handleSaveSelectionSet}
        selectionSets={selectionSets}
        onLoadSelectionSet={handlers.handleLoadSelectionSet}
        onClearSelectionSet={handlers.handleClearSelectionSet}
        onSaveAsNewSelectionSet={() => dialogs.saveSelectionSet.open()}
      />

      <SaveSelectionSetDialog
        isOpen={dialogs.saveSelectionSet.isOpen}
        frameCount={selectedFrames.size}
        onClose={() => dialogs.saveSelectionSet.close()}
        onSave={handlers.handleSaveNewSelectionSet}
      />

      {/* Mounted only while open: Discovery re-renders on every frame flush, and
          the dialog builds its whole tool list each time. Guarded here rather
          than inside, so its hooks stay unconditional. */}
      {dialogs.toolbox.isOpen && (
      <ToolboxDialog
        onClose={() => dialogs.toolbox.close()}
        selectedCount={framesViewActiveTab === 'filtered' ? seenIds.size - selectedFrames.size : selectedFrames.size}
        frameCount={frameList.length}
        isSerialMode={isSerialMode}
        isSerialProtocol={capabilities?.traits?.protocols?.includes("serial") ?? false}
        isFilteredView={framesViewActiveTab === 'filtered'}
        serialFrameCount={backendFrameCount > 0 ? backendFrameCount : (framedData.length + frames.length)}
        serialBytesCount={watchByteCount}
        serialBytesCaptureId={sessionBytesCaptureId}
        hasSource={hasSource}
        onStartModbusScan={handleStartModbusScan}
        onStartModbusUnitIdScan={handleStartModbusUnitIdScan}
        onStartModbusFcProbe={handleStartModbusFcProbe}
      />
      )}

      <DecoderInfoDialog
        isOpen={showInfoView}
        onClose={closeInfoView}
      />
    </AppLayout>
  );
}

export default withFrameIdFormat(DiscoveryInner);
