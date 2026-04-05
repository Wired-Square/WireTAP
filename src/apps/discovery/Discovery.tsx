// ui/src/apps/discovery/Discovery.tsx

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { useSettings, getDisplayFrameIdFormat, getSaveFrameIdFormat } from "../../hooks/useSettings";
import { useIOSessionManager, type SessionReconfigurationInfo } from '../../hooks/useIOSessionManager';
import { useIOSourcePickerHandlers } from '../../hooks/useIOSourcePickerHandlers';
import { useMenuSessionControl } from '../../hooks/useMenuSessionControl';
import { useSessionStore } from '../../stores/sessionStore';
import { type FrameMessage, type PlaybackSpeed } from "../../stores/discoveryStore";
import { keyOf, parseFrameKey } from "../../utils/frameKey";
import { useDiscoveryFrameStore, getDiscoveryFrameBuffer } from "../../stores/discoveryFrameStore";
import { useDiscoveryUIStore } from "../../stores/discoveryUIStore";
import { useDiscoverySerialStore } from "../../stores/discoverySerialStore";
import { useDiscoveryToolboxStore } from "../../stores/discoveryToolboxStore";
import { useShallow } from "zustand/react/shallow";
import { useDiscoveryHandlers } from "./hooks/useDiscoveryHandlers";
import type { StreamEndedInfo, PlaybackPosition, ModbusScanConfig, UnitIdScanConfig } from '../../api/io';
import { startModbusScan, startModbusUnitIdScan, cancelModbusScan, getModbusScanState } from '../../api/io';
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
import { useEffectiveBufferMetadata } from "../../hooks/useEffectiveCaptureMetadata";
import { getCaptureMetadata, getCaptureMetadataById, getCaptureFramesPaginated, getCaptureFramesPaginatedFiltered, getCaptureBytesPaginated, getCaptureFrameInfo, getCaptureBytesById, getCaptureFramesPaginatedById, type CaptureMetadata } from "../../api/capture";
import { WINDOW_EVENTS } from "../../events/registry";
import FramePickerDialog from "../../dialogs/FramePickerDialog";
import ToolboxDialog from "../../dialogs/ToolboxDialog";
import { pickFileToSave } from "../../api/dialogs";
import { saveCatalog } from "../../api/catalog";
import { formatFilenameDate } from "../../utils/timeFormat";
import { useDialogManager } from "../../hooks/useDialogManager";
import { getFavoritesForProfile } from "../../utils/favorites";

export default function Discovery() {
  const { settings } = useSettings();



  // ── Frame store ──
  const frames = getDiscoveryFrameBuffer();
  const { frameInfoMap, selectedFrames, seenIds, streamStartTimeUs, bufferMode } =
    useDiscoveryFrameStore(useShallow((s) => ({
      frameInfoMap: s.frameInfoMap,
      selectedFrames: s.selectedFrames,
      seenIds: s.seenIds,
      streamStartTimeUs: s.streamStartTimeUs,
      bufferMode: s.bufferMode,
    })));
  // Subscribe to frameVersion so components re-render when the mutable buffer changes
  useDiscoveryFrameStore((s) => s.frameVersion);
  const setStreamStartTimeUs = useDiscoveryFrameStore((s) => s.setStreamStartTimeUs);
  const clearBuffer = useDiscoveryFrameStore((s) => s.clearBuffer);
  const clearFramePicker = useDiscoveryFrameStore((s) => s.clearFramePicker);
  const enableBufferMode = useDiscoveryFrameStore((s) => s.enableBufferMode);
  const disableBufferMode = useDiscoveryFrameStore((s) => s.disableBufferMode);
  const setFrameInfoFromBuffer = useDiscoveryFrameStore((s) => s.setFrameInfoFromBuffer);

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
  const { isSerialMode, framedData, framingAccepted, serialBytesBuffer,
    backendByteCount, backendFrameCount, framedCaptureId } =
    useDiscoverySerialStore(useShallow((s) => ({
      isSerialMode: s.isSerialMode,
      framedData: s.framedData,
      framingAccepted: s.framingAccepted,
      serialBytesBuffer: s.serialBytesBuffer,
      backendByteCount: s.backendByteCount,
      backendFrameCount: s.backendFrameCount,
      framedCaptureId: s.framedCaptureId,
    })));
  const serialActiveTab = useDiscoverySerialStore((s) => s.activeTab);
  const setSerialMode = useDiscoverySerialStore((s) => s.setSerialMode);
  const addSerialBytes = useDiscoverySerialStore((s) => s.addSerialBytes);
  const clearSerialBytes = useDiscoverySerialStore((s) => s.clearSerialBytes);
  const resetFraming = useDiscoverySerialStore((s) => s.resetFraming);
  const undoAcceptFraming = useDiscoverySerialStore((s) => s.undoAcceptFraming);
  const incrementBackendByteCount = useDiscoverySerialStore((s) => s.incrementBackendByteCount);
  const setBytesBufferId = useDiscoverySerialStore((s) => s.setBytesBufferId);
  const setBackendByteCount = useDiscoverySerialStore((s) => s.setBackendByteCount);
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

  const applySelectionSet = useCallback((selectionSet: import('../../utils/selectionSets').SelectionSet) => {
    const uiState = useDiscoveryUIStore.getState();
    // Detect protocol from current frameInfoMap, default to 'can'
    let protocol = 'can';
    for (const info of useDiscoveryFrameStore.getState().frameInfoMap.values()) {
      if (info.protocol) { protocol = info.protocol; break; }
    }
    useDiscoveryFrameStore.getState().applySelectionSet(
      selectionSet, protocol, uiState.setActiveSelectionSet, uiState.setSelectionSetDirty
    );
    // Convert numeric selection set IDs to composite keys
    const numericIds = selectionSet.selectedIds ?? selectionSet.frameIds;
    uiState.setActiveSelectionSetSelectedIds(
      new Set(numericIds.map(id => `${protocol}:${id}`))
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
    let protocol = 'can';
    const fInfoMap = useDiscoveryFrameStore.getState().frameInfoMap;
    for (const info of fInfoMap.values()) {
      if (info.protocol) { protocol = info.protocol; break; }
    }
    const frameBuffer = getDiscoveryFrameBuffer();
    if (protocol === 'can' && frameBuffer.length > 0) {
      protocol = frameBuffer[0].protocol || 'can';
    }
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

  const displayFrameIdFormat = getDisplayFrameIdFormat(settings);
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

  // Playback direction state (for buffer replay)
  const [playbackDirection, setPlaybackDirection] = useState<"forward" | "backward">("forward");

  // Buffer metadata state (for imported CSV files)
  const [captureMetadata, setCaptureMetadata] = useState<CaptureMetadata | null>(null);

  // Time range visibility
  const [showTimeRange] = useState(false);

  // Modbus scan state (from toolbox store)
  const startModbusScanStore = useDiscoveryToolboxStore((s) => s.startModbusScan);
  const addModbusScanFrames = useDiscoveryToolboxStore((s) => s.addModbusScanFrames);
  const addModbusScanDeviceInfo = useDiscoveryToolboxStore((s) => s.addModbusScanDeviceInfo);
  const updateModbusScanProgress = useDiscoveryToolboxStore((s) => s.updateModbusScanProgress);
  const finishModbusScan = useDiscoveryToolboxStore((s) => s.finishModbusScan);
  const isScanning = useDiscoveryToolboxStore((s) =>
    (s.toolbox.modbusRegisterScanResults?.isScanning ?? false) ||
    (s.toolbox.modbusUnitIdScanResults?.isScanning ?? false)
  );

  // Ref to track paused state (used by callbacks that can't access manager state directly)
  // When paused, frame emissions are from stepping - position updates, not new data
  const isPausedRef = useRef(false);
  // Ref to track buffer mode (when true, useBufferFrameView handles display - don't accumulate)
  const inBufferModeRef = useRef(false);

  // NOTE: Auto-join buffer on mount and BUFFER_CHANGED events removed.
  // Discovery should NOT automatically join buffer sessions.

  // Callbacks for reader session
  // Note: Watch frame counting is handled by useIOSessionManager
  const handleFrames = useCallback((receivedFrames: FrameMessage[]) => {
    if (!receivedFrames || receivedFrames.length === 0) return;
    // Only add frames when actively running (not paused). When paused, frame emissions
    // are from stepping (position updates), not new data to accumulate.
    if (isPausedRef.current) return;
    // In buffer mode, useBufferFrameView handles display — don't accumulate frames in memory
    if (inBufferModeRef.current) return;
    // In serial mode, skip frame picker updates until framing is accepted
    // The frame picker will be populated with correct IDs when acceptFraming is called
    const skipFramePicker = isSerialMode && !framingAccepted;
    addFrames(receivedFrames, skipFramePicker);
    incrementBackendFrameCount(receivedFrames.length);
  }, [addFrames, incrementBackendFrameCount, isSerialMode, framingAccepted]);

  const handleBytes = useCallback((payload: import("../../api/io").RawBytesPayload) => {
    const entries = payload.bytes.map((b) => ({
      byte: b.byte,
      timestampUs: b.timestamp_us,
      bus: b.bus,
    }));
    incrementBackendByteCount(entries.length);
    addSerialBytes(entries);
  }, [addSerialBytes, incrementBackendByteCount]);

  const handleError = useCallback((error: string) => {
    showAppError("Stream Error", "An error occurred while streaming CAN data.", error);
  }, [showAppError]);

  const handleTimeUpdate = useCallback((position: PlaybackPosition) => {
    // Update local store for backward compatibility (components that still read from store)
    updateCurrentTime(position.timestamp_us / 1_000_000);
    setCurrentFrameIndex(position.frame_index);
  }, [updateCurrentTime, setCurrentFrameIndex]);

  // Handle session suspended (from any app sharing this session)
  // This fetches buffer metadata and frame info so Discovery can show timeline controls
  const handleSessionSuspended = useCallback(async (payload: import("../../api/io").SessionSuspendedPayload) => {
    if (payload.buffer_count > 0 && payload.buffer_id) {
      const meta = await getCaptureMetadata(payload.buffer_id);
      if (meta) {
        setCaptureMetadata(meta);
        enableBufferMode(meta.count);

        // Fetch frame info from backend buffer (populates frame picker)
        try {
          const frameInfoList = await getCaptureFrameInfo(payload.buffer_id);
          console.log(`[Discovery] Session suspended - loaded ${frameInfoList.length} unique frame IDs from buffer`);
          setFrameInfoFromBuffer(frameInfoList);
        } catch (err) {
          console.warn('[Discovery] Failed to fetch frame info after suspend:', err);
        }
      }
    }
  }, [enableBufferMode, setFrameInfoFromBuffer]);

  const handleSessionSpeedChange = useCallback((speed: number) => {
    setPlaybackSpeed(speed as PlaybackSpeed);
  }, [setPlaybackSpeed]);

  // Ingest complete handler - passed to useIOSessionManager
  const handleIngestComplete = useCallback(async (payload: StreamEndedInfo) => {
    if (payload.capture_available && payload.count > 0 && payload.capture_id) {
      const meta = await getCaptureMetadata(payload.capture_id);
      if (meta) {
        setCaptureMetadata(meta);

        await emit(WINDOW_EVENTS.BUFFER_CHANGED, {
          metadata: meta,
          action: "ingested",
        });
      }

      dialogs.ioSessionPicker.close();

      if (payload.capture_kind === "bytes" && meta) {
        console.log(`[Discovery] Loading ${payload.count} bytes from buffer into serial view`);
        try {
          const bytes = await getCaptureBytesById(meta.id);
          const entries = bytes.map((b) => ({
            byte: b.byte,
            timestampUs: b.timestamp_us,
          }));
          clearSerialBytes();
          resetFraming();
          addSerialBytes(entries);
          setBytesBufferId(meta.id);
          setBackendByteCount(meta.count);
          console.log(`[Discovery] Loaded ${bytes.length} bytes`);
        } catch (e) {
          console.error("Failed to load bytes from buffer:", e);
        }
      } else {
        clearBuffer();

        // Always enable buffer mode so playback controls appear
        // (Session is now in buffer replay mode after ingest)
        console.log(`[Discovery] Ingest complete (${payload.count} frames) - enabling buffer mode for playback controls`);
        enableBufferMode(payload.count);

        // Load frame info for the frame picker
        try {
          const frameInfoList = await getCaptureFrameInfo(payload.capture_id);
          console.log(`[Discovery] Loaded ${frameInfoList.length} unique frame IDs from buffer`);
          setFrameInfoFromBuffer(frameInfoList);
        } catch (e) {
          console.error("Failed to load frame info from buffer:", e);
        }

        // No need to load frames into memory — useBufferFrameView handles display via pagination
      }

      // NOTE: Don't switch ioProfile to buffer ID - session stays at ingest_xxxxx
      // The session is now in buffer replay mode, playback controls will work
    }
  }, [
    dialogs.ioSessionPicker,
    clearSerialBytes,
    resetFraming,
    addSerialBytes,
    setBytesBufferId,
    setBackendByteCount,
    clearBuffer,
    enableBufferMode,
    setFrameInfoFromBuffer,
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

  // Cleanup callback for before starting a new watch session
  const clearBeforeWatch = useCallback(() => {
    clearBuffer();
    clearFramePicker();
    clearAnalysisResults();
    disableBufferMode();
    setCaptureMetadata(null); // Clear stale metadata so effectiveStartTimeUs doesn't use old values
    clearSerialBytes();
    resetFraming();
    setBackendByteCount(0);
    setBackendFrameCount(0);
    // Reset refs checked by handleFrames — prevents stale values from a previous
    // session (e.g., buffer mode after stop) from silently dropping frames
    isPausedRef.current = false;
    inBufferModeRef.current = false;
  }, [clearBuffer, clearFramePicker, clearAnalysisResults, disableBufferMode, clearSerialBytes, resetFraming, setBackendByteCount, setBackendFrameCount]);

  // Handle session destroyed — switch to orphaned buffer if available
  const handleSessionDestroyed = useCallback(async (orphanedBufferIds: string[]) => {
    if (orphanedBufferIds.length === 0) return;
    const captureId = orphanedBufferIds[0];
    try {
      const meta = await getCaptureMetadataById(captureId);
      if (meta) {
        setCaptureMetadata(meta);
        enableBufferMode(meta.count);
        const frameInfoList = await getCaptureFrameInfo(captureId);
        setFrameInfoFromBuffer(frameInfoList);
      }
    } catch (err) {
      console.warn('[Discovery] Failed to load buffer after session destroyed:', err);
    }
  }, [enableBufferMode, setFrameInfoFromBuffer]);

  // Use the IO session manager hook - manages session lifecycle, ingest, multi-bus, and derived state
  const manager = useIOSessionManager({
    appName: "discovery",
    ioProfiles: settings?.io_profiles ?? [],
    store: { ioProfile, setIoProfile },
    enableIngest: true,
    onIngestComplete: handleIngestComplete,
    onFrames: handleFrames,
    onBytes: handleBytes,
    onError: handleError,
    onTimeUpdate: handleTimeUpdate,
    onSuspended: handleSessionSuspended,
    onSpeedChange: handleSessionSpeedChange,
    // Session switching callbacks
    setPlaybackSpeed: (speed: number) => setPlaybackSpeed(speed as PlaybackSpeed),
    onBeforeWatch: clearBeforeWatch,
    onBeforeMultiWatch: clearBeforeWatch,
    onSessionReconfigured: handleSessionReconfigured,
    onSessionDestroyed: handleSessionDestroyed,
  });

  // Destructure everything from the manager
  const {
    // Multi-bus state
    multiBusProfiles: ioProfiles,
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
    resetWatchFrameCount,
    // Session switching methods
    stopWatch,
    resumeWithNewBuffer,
    selectProfile,
    watchSource,
    // Bookmark methods
    jumpToBookmark,
  } = manager;

  // Session controls from the underlying session
  const {
    sessionId,
    state: readerState,
    captureId: sessionBufferId,
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

  // Detect if active profile is modbus_tcp and extract connection details.
  // Note: ioProfile holds the session ID (e.g. "m_abc123"), not the profile ID.
  // Use ioProfiles (multiBusProfiles) which contains the actual profile IDs.
  const modbusProfile = useMemo(() => {
    if (!settings?.io_profiles || ioProfiles.length === 0) return null;
    // Find first modbus_tcp profile among the active source profiles
    for (const profileId of ioProfiles) {
      const profile = settings.io_profiles.find((p: import("../../types/common").IOProfile) => p.id === profileId);
      if (profile?.kind === 'modbus_tcp') {
        return {
          host: String(profile.connection?.host ?? '127.0.0.1'),
          port: Number(profile.connection?.port) || 502,
          unit_id: Number(profile.connection?.unit_id) || 1,
        };
      }
    }
    return null;
  }, [ioProfiles, settings?.io_profiles]);

  const isModbusProfile = modbusProfile !== null;

  // Note: isStreaming, isPaused, isStopped, isRealtime are now provided by useIOSessionManager

  // Fetch buffer metadata and frame info when:
  // - Joining a session already in buffer mode (another app stopped)
  // - Session is paused with buffered data (for stepping through frames)
  useEffect(() => {
    const shouldFetchMetadata = sessionId && sessionBufferId && !captureMetadata && (
      (isCaptureMode && !isStreaming) ||  // Explicit buffer mode
      (isPaused && captureCount > 0)       // Paused with buffered frames
    );

    if (shouldFetchMetadata) {
      (async () => {
        try {
          // Fetch buffer metadata
          const meta = await getCaptureMetadata(sessionBufferId);
          if (meta) {
            setCaptureMetadata(meta);
            enableBufferMode(meta.count);

            // Fetch frame info from backend buffer (populates frame picker)
            const frameInfoList = await getCaptureFrameInfo(sessionBufferId);
            console.log(`[Discovery] Loaded ${frameInfoList.length} unique frame IDs from buffer`);
            setFrameInfoFromBuffer(frameInfoList);
          }
        } catch (err) {
          console.warn('[Discovery] Failed to fetch buffer data:', err);
        }
      })();
    }
  }, [isCaptureMode, isStreaming, isPaused, captureCount, captureMetadata, sessionId, sessionBufferId, enableBufferMode, setFrameInfoFromBuffer]);

  // Keep paused ref in sync with manager state (for callbacks that can't access manager directly)
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  // Keep buffer mode ref in sync (useBufferFrameView handles display in buffer mode)
  useEffect(() => {
    inBufferModeRef.current = isCaptureMode || bufferMode.enabled;
  }, [isCaptureMode, bufferMode.enabled]);

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

  // Update currentTime when buffer metadata changes
  useEffect(() => {
    if (captureMetadata?.start_time_us != null && !isStreaming) {
      updateCurrentTime(captureMetadata.start_time_us / 1_000_000);
    }
  }, [captureMetadata?.start_time_us, isStreaming, updateCurrentTime]);

  const displayTimeSeconds = isRealtime ? realtimeClock : currentTime;

  // Initialize IO profile and history buffer from settings
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
      // Buffer mode: check buffer metadata for bytes type
      newIsSerialMode = captureMetadata?.kind === "bytes" || captureKind === "bytes" || framedCaptureId !== null;
    } else {
      // Live session: check session traits from capabilities
      newIsSerialMode = capabilities?.traits?.protocols?.includes("serial") ?? false;
    }

    setSerialMode(newIsSerialMode);

    if (prevIsSerialModeRef.current && !newIsSerialMode) {
      clearSerialBytes();
    }
    prevIsSerialModeRef.current = newIsSerialMode;
  }, [ioProfile, capabilities, captureMetadata, captureKind, framedCaptureId, setSerialMode, clearSerialBytes]);

  // Raw bytes are now routed through sessionStore via the onBytes callback.
  // No ad-hoc Tauri listener needed here.

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

  const protocolLabel = frames.length > 0 ? frames[0].protocol : "can";

  // Non-realtime sources: timeline (postgres, csv) and buffer replay
  const isRecorded = capabilities?.traits.temporal_mode === "timeline"
    || capabilities?.traits.temporal_mode === "buffer";

  // Merged buffer metadata using session values for cross-app timeline sync
  const effectiveBufferMetadata = useEffectiveBufferMetadata(
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
      return backendByteCount > 0 ? backendByteCount : serialBytesBuffer.length;
    }
    if (bufferMode.enabled) return bufferMode.totalFrames;
    if (isSerialMode && framedCaptureId && backendFrameCount > 0) return backendFrameCount;
    if (isSerialMode && framedData.length > 0) return framedData.length;
    return frames.length;
  }, [exportDataMode, backendByteCount, serialBytesBuffer.length, bufferMode, isSerialMode, framedCaptureId, backendFrameCount, framedData.length, frames.length]);

  const exportDefaultFilename = useMemo(() => {
    const protocol = exportDataMode === "bytes" ? "serial" : (protocolLabel || "can");
    return `${formatFilenameDate()}-${protocol}`;
  }, [exportDataMode, protocolLabel]);

  // Modbus scan: listen for session-scoped signal and fetch accumulated state
  useEffect(() => {
    if (!isScanning || !sessionId) return;

    let unlisten: (() => void) | null = null;
    // Track delivered frame count to avoid re-adding frames from the full snapshot
    let deliveredFrameCount = 0;

    const setup = async () => {
      unlisten = await listen(`modbus-scan:${sessionId}`, async () => {
        const state = await getModbusScanState(sessionId);
        if (state) {
          const newFrames = state.frames.slice(deliveredFrameCount);
          if (newFrames.length > 0) {
            addModbusScanFrames(newFrames);
            deliveredFrameCount = state.frames.length;
          }
          if (state.progress) {
            updateModbusScanProgress(state.progress);
          }
          for (const info of state.device_info) {
            addModbusScanDeviceInfo({
              unit_id: info.unit_id,
              vendor: info.vendor ?? undefined,
              product_code: info.product_code ?? undefined,
              revision: info.revision ?? undefined,
            });
          }
        }
      });
    };

    setup();

    return () => {
      unlisten?.();
    };
  }, [isScanning, sessionId, addModbusScanFrames, updateModbusScanProgress, addModbusScanDeviceInfo]);

  // Modbus scan handlers
  const handleStartModbusScan = useCallback(async (config: ModbusScanConfig) => {
    startModbusScanStore('register');
    // Set modbus export config so Save knows how to generate TOML
    setModbusExportConfig({
      device_address: config.unit_id,
      register_base: 0,
      register_type: config.register_type,
      default_interval: 1000,
    });
    try {
      const result = await startModbusScan(config, sessionId ?? undefined);
      console.log(`[Discovery] Modbus register scan complete: found ${result.found_count} of ${result.total_scanned} in ${result.duration_ms}ms`);
    } catch (e) {
      showAppError("Scan Error", "An error occurred during Modbus register scan.", String(e));
    } finally {
      finishModbusScan();
    }
  }, [startModbusScanStore, finishModbusScan, showAppError, setModbusExportConfig, sessionId]);

  const handleStartModbusUnitIdScan = useCallback(async (config: UnitIdScanConfig) => {
    startModbusScanStore('unit-id');
    // Set modbus export config for unit ID scan results
    setModbusExportConfig({
      device_address: config.start_unit_id,
      register_base: 0,
      register_type: config.register_type,
      default_interval: 1000,
    });
    try {
      const result = await startModbusUnitIdScan(config, sessionId ?? undefined);
      console.log(`[Discovery] Modbus unit ID scan complete: found ${result.found_count} of ${result.total_scanned} in ${result.duration_ms}ms`);
    } catch (e) {
      showAppError("Scan Error", "An error occurred during Modbus unit ID scan.", String(e));
    } finally {
      finishModbusScan();
    }
  }, [startModbusScanStore, finishModbusScan, showAppError, setModbusExportConfig, sessionId]);

  const handleCancelModbusScan = useCallback(async () => {
    try {
      await cancelModbusScan();
    } catch (e) {
      console.warn('[Discovery] Failed to cancel scan:', e);
    }
  }, []);

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
    bufferModeEnabled: bufferMode.enabled,
    bufferModeTotalFrames: bufferMode.totalFrames,

    // Frame state
    frames,
    framedData,
    framedCaptureId,
    frameInfoMap,
    selectedFrames,

    // Serial state
    isSerialMode,
    backendByteCount,
    backendFrameCount,
    serialBytesBufferLength: serialBytesBuffer.length,

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
    handleClearBuffer: manager.handleClearBuffer,
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
    clearBuffer,
    clearFramePicker,
    clearAnalysisResults,
    enableBufferMode,
    disableBufferMode,
    setFrameInfoFromBuffer,
    clearSerialBytes,
    resetFraming,
    setBackendByteCount,
    setBackendFrameCount,
    addSerialBytes,
    openSaveDialog,
    saveFrames,
    setActiveSelectionSet,
    setSelectionSetDirty,
    applySelectionSet,

    // API functions (for export/other features)
    getCaptureBytesPaginated: (offset, limit) => getCaptureBytesPaginated((captureMetadata?.id ?? sessionBufferId)!, offset, limit),
    getCaptureFramesPaginated: (offset, limit) => getCaptureFramesPaginated((captureMetadata?.id ?? sessionBufferId)!, offset, limit),
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

  // Buffer-level frame change: when there's no active session (after LEAVE),
  // derive the timestamp from the buffer so the timeline updates during stepping.
  const handleFrameChangeWithBuffer = useCallback(async (frameIndex: number) => {
    setCurrentFrameIndex(frameIndex);
    if (sessionId && capabilities?.supports_seek) {
      // Active session: delegate to backend seek (emits position event)
      await seekByFrame(frameIndex);
    } else {
      // Buffer-only mode: look up timestamp from buffer
      // Buffer API uses numeric IDs — extract from composite keys
      const selectedNumericIds = Array.from(selectedFrames).map(fk => parseFrameKey(fk).frameId);
      const frameBufferId = captureMetadata?.id ?? sessionBufferId;
      try {
        const response = await getCaptureFramesPaginatedFiltered(frameBufferId!, frameIndex, 1, selectedNumericIds);
        if (response.frames.length > 0) {
          updateCurrentTime(response.frames[0].timestamp_us / 1_000_000);
        }
      } catch {
        // Best effort — timestamp syncs when page loads
      }
    }
  }, [sessionId, capabilities, seekByFrame, selectedFrames, captureMetadata, sessionBufferId, setCurrentFrameIndex, updateCurrentTime]);

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
        else if (isStopped && sessionReady) resumeWithNewBuffer();
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
          ioProfiles={settings?.io_profiles || []}
          ioProfile={ioProfile}
          onIoProfileChange={handlers.handleIoProfileChange}
          defaultReadProfileId={settings?.default_read_profile}
          captureMetadata={effectiveBufferMetadata ?? captureMetadata}
          sessionId={sessionId}
          isStreaming={isStreaming}
          multiBusProfiles={sessionId ? ioProfiles : []}
          ioState={readerState}
          isRealtime={isRealtime}
          onStopWatch={handlers.handleStop}
          isStopped={isStopped || canReturnToLive}
          onResume={resumeWithNewBuffer}
          onLeave={handleLeave}
          supportsTimeRange={capabilities?.supports_time_range ?? false}
          onOpenBookmarkPicker={() => dialogs.bookmarkPicker.open()}
          speed={playbackSpeed}
          supportsSpeed={capabilities?.supports_speed_control ?? false}
          onOpenSpeedPicker={() => dialogs.speedPicker.open()}
          frameCount={frameList.length}
          uniqueFrameCount={isCaptureMode ? frameInfoMap.size : watchUniqueFrameCount}
          totalFrameCount={isCaptureMode ? captureCount : watchFrameCount}
          selectedFrameCount={selectedFrames.size}
          onOpenFramePicker={() => dialogs.framePicker.open()}
          isSerialMode={isSerialMode}
          serialBytesCount={backendByteCount > 0 ? backendByteCount : serialBytesBuffer.length}
          framingAccepted={framingAccepted}
          serialActiveTab={serialActiveTab}
          onUndoFraming={undoAcceptFraming}
          isModbusProfile={isModbusProfile}
          isCaptureMode={isCaptureMode}
          capturePersistent={session.capturePersistent}
          onToggleBufferPin={() => {
            const bid = captureMetadata?.id ?? sessionBufferId;
            if (bid) useSessionStore.getState().setSessionCapturePersistent(bid, !session.capturePersistent);
          }}
          onRenameBuffer={(newName) => {
            const bid = captureMetadata?.id ?? sessionBufferId;
            if (bid) useSessionStore.getState().renameSessionCapture(bid, newName);
          }}
          onOpenIoSessionPicker={() => dialogs.ioSessionPicker.open()}
          onClearBuffer={handlers.handleClearDiscoveredFrames}
          hasData={frameList.length > 0 || (isSerialMode && (backendByteCount > 0 || serialBytesBuffer.length > 0))}
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
            emitsRawBytes={capabilities?.data_streams.rx_bytes ?? true}
          />
        ) : (
          <DiscoveryFramesView
            frames={frames}
            captureId={captureMetadata?.id ?? (bufferMode.enabled ? sessionBufferId : null)}
            protocol={protocolLabel}
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
            captureMetadata={effectiveBufferMetadata}
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
            // Timeline source streaming controls
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
        title="Change Speed Mode?"
        message={`Switching from "No Limit" mode will clear all ${frames.length.toLocaleString()} discovered frames and ${frameInfoMap.size.toLocaleString()} unique frame IDs.`}
        confirmText="Clear & Switch"
        cancelText="Keep Frames"
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
        ioProfiles={settings?.io_profiles || []}
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
      />

      <FramePickerDialog
        isOpen={dialogs.framePicker.isOpen}
        onClose={() => dialogs.framePicker.close()}
        frames={frameList}
        selectedFrames={selectedFrames}
        onToggleFrame={toggleFrameSelection}
        onBulkSelect={bulkSelectBus}
        displayFrameIdFormat={displayFrameIdFormat}
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

      <ToolboxDialog
        isOpen={dialogs.toolbox.isOpen}
        onClose={() => dialogs.toolbox.close()}
        selectedCount={framesViewActiveTab === 'filtered' ? seenIds.size - selectedFrames.size : selectedFrames.size}
        frameCount={frameList.length}
        isSerialMode={isSerialMode}
        isFilteredView={framesViewActiveTab === 'filtered'}
        serialFrameCount={backendFrameCount > 0 ? backendFrameCount : (framedData.length + frames.length)}
        serialBytesCount={backendByteCount > 0 ? backendByteCount : serialBytesBuffer.length}
        isModbusProfile={isModbusProfile}
        modbusConnection={modbusProfile}
        onStartModbusScan={handleStartModbusScan}
        onStartModbusUnitIdScan={handleStartModbusUnitIdScan}
      />

      <DecoderInfoDialog
        isOpen={showInfoView}
        onClose={closeInfoView}
      />
    </AppLayout>
  );
}
