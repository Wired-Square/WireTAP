// ui/src/apps/discovery/Discovery.tsx

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { useSettings, getDisplayFrameIdFormat, getSaveFrameIdFormat } from "../../hooks/useSettings";
import { useIOSessionManager, type SessionReconfigurationInfo } from '../../hooks/useIOSessionManager';
import { useIOPickerHandlers } from '../../hooks/useIOPickerHandlers';
import { useMenuSessionControl } from '../../hooks/useMenuSessionControl';
import { useSessionStore } from '../../stores/sessionStore';
import { useDiscoveryStore, type FrameMessage, type PlaybackSpeed } from "../../stores/discoveryStore";
import { useDiscoveryUIStore } from "../../stores/discoveryUIStore";
import { useDiscoveryHandlers } from "./hooks/useDiscoveryHandlers";
import type { StreamEndedPayload, PlaybackPosition, ModbusScanConfig, UnitIdScanConfig } from '../../api/io';
import { startModbusScan, startModbusUnitIdScan, cancelModbusScan } from '../../api/io';
import { useDiscoveryToolboxStore } from "../../stores/discoveryToolboxStore";
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
import IoReaderPickerDialog from "../../dialogs/IoReaderPickerDialog";
import { useSelectionSets } from "../../hooks/useSelectionSets";
import { isBufferProfileId } from "../../hooks/useIOSessionManager";
import { useEffectiveBufferMetadata } from "../../hooks/useEffectiveBufferMetadata";
import { clearBuffer as clearBackendBuffer, getBufferMetadata, getBufferFramesPaginated, getBufferFramesPaginatedFiltered, getBufferBytesPaginated, getBufferFrameInfo, getBufferBytesById, getBufferFramesPaginatedById, type BufferMetadata } from "../../api/buffer";
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



  // Zustand store selectors
  const frames = useDiscoveryStore((state) => state.frames);
  const frameInfoMap = useDiscoveryStore((state) => state.frameInfoMap);
  const selectedFrames = useDiscoveryStore((state) => state.selectedFrames);
  const maxBuffer = useDiscoveryStore((state) => state.maxBuffer);
  const ioProfile = useDiscoveryStore((state) => state.ioProfile);
  const playbackSpeed = useDiscoveryStore((state) => state.playbackSpeed);
  const showSaveDialog = useDiscoveryStore((state) => state.showSaveDialog);
  const saveMetadata = useDiscoveryStore((state) => state.saveMetadata);
  const startTime = useDiscoveryStore((state) => state.startTime);
  const endTime = useDiscoveryStore((state) => state.endTime);
  const currentTime = useDiscoveryStore((state) => state.currentTime);
  const currentFrameIndex = useDiscoveryStore((state) => state.currentFrameIndex);
  const toolboxIsRunning = useDiscoveryStore((state) => state.toolbox.isRunning);
  const toolboxActiveView = useDiscoveryStore((state) => state.toolbox.activeView);
  const showInfoView = useDiscoveryStore((state) => state.showInfoView);
  const knowledge = useDiscoveryStore((state) => state.knowledge);
  const activeSelectionSetId = useDiscoveryStore((state) => state.activeSelectionSetId);
  const selectionSetDirty = useDiscoveryStore((state) => state.selectionSetDirty);
  const streamStartTimeUs = useDiscoveryStore((state) => state.streamStartTimeUs);

  const seenIds = useDiscoveryStore((state) => state.seenIds);
  const framesViewActiveTab = useDiscoveryUIStore((state) => state.framesViewActiveTab);
  const setShowBusColumn = useDiscoveryUIStore((state) => state.setShowBusColumn);
  const setModbusExportConfig = useDiscoveryUIStore((state) => state.setModbusExportConfig);

  // Global error dialog
  const showAppError = useSessionStore((state) => state.showAppError);

  // Zustand store actions
  const setStreamStartTimeUs = useDiscoveryStore((state) => state.setStreamStartTimeUs);
  const addFrames = useDiscoveryStore((state) => state.addFrames);
  const clearBuffer = useDiscoveryStore((state) => state.clearBuffer);
  const clearFramePicker = useDiscoveryStore((state) => state.clearFramePicker);
  const toggleFrameSelection = useDiscoveryStore((state) => state.toggleFrameSelection);
  const bulkSelectBus = useDiscoveryStore((state) => state.bulkSelectBus);
  const setMaxBuffer = useDiscoveryStore((state) => state.setMaxBuffer);
  const setIoProfile = useDiscoveryStore((state) => state.setIoProfile);
  const setPlaybackSpeed = useDiscoveryStore((state) => state.setPlaybackSpeed);
  const updateCurrentTime = useDiscoveryStore((state) => state.updateCurrentTime);
  const setCurrentFrameIndex = useDiscoveryStore((state) => state.setCurrentFrameIndex);
  const openSaveDialog = useDiscoveryStore((state) => state.openSaveDialog);
  const closeSaveDialog = useDiscoveryStore((state) => state.closeSaveDialog);
  const updateSaveMetadata = useDiscoveryStore((state) => state.updateSaveMetadata);
  const saveFrames = useDiscoveryStore((state) => state.saveFrames);
  const setStartTime = useDiscoveryStore((state) => state.setStartTime);
  const setEndTime = useDiscoveryStore((state) => state.setEndTime);
  const openInfoView = useDiscoveryStore((state) => state.openInfoView);
  const closeInfoView = useDiscoveryStore((state) => state.closeInfoView);
  const clearAnalysisResults = useDiscoveryStore((state) => state.clearAnalysisResults);
  const selectAllFrames = useDiscoveryStore((state) => state.selectAllFrames);
  const deselectAllFrames = useDiscoveryStore((state) => state.deselectAllFrames);
  const setActiveSelectionSet = useDiscoveryStore((state) => state.setActiveSelectionSet);
  const setSelectionSetDirty = useDiscoveryStore((state) => state.setSelectionSetDirty);
  const enableBufferMode = useDiscoveryStore((state) => state.enableBufferMode);
  const disableBufferMode = useDiscoveryStore((state) => state.disableBufferMode);
  const setFrameInfoFromBuffer = useDiscoveryStore((state) => state.setFrameInfoFromBuffer);
  const applySelectionSet = useDiscoveryStore((state) => state.applySelectionSet);
  const setSerialConfig = useDiscoveryStore((state) => state.setSerialConfig);
  const isSerialMode = useDiscoveryStore((state) => state.isSerialMode);
  const setSerialMode = useDiscoveryStore((state) => state.setSerialMode);
  const addSerialBytes = useDiscoveryStore((state) => state.addSerialBytes);
  const clearSerialBytes = useDiscoveryStore((state) => state.clearSerialBytes);
  const resetFraming = useDiscoveryStore((state) => state.resetFraming);
  const undoAcceptFraming = useDiscoveryStore((state) => state.undoAcceptFraming);
  const framedData = useDiscoveryStore((state) => state.framedData);
  const framingAccepted = useDiscoveryStore((state) => state.framingAccepted);
  const serialBytesBuffer = useDiscoveryStore((state) => state.serialBytesBuffer);
  const backendByteCount = useDiscoveryStore((state) => state.backendByteCount);
  const incrementBackendByteCount = useDiscoveryStore((state) => state.incrementBackendByteCount);
  const setBackendByteCount = useDiscoveryStore((state) => state.setBackendByteCount);
  const framedBufferId = useDiscoveryStore((state) => state.framedBufferId);
  const backendFrameCount = useDiscoveryStore((state) => state.backendFrameCount);
  const incrementBackendFrameCount = useDiscoveryStore((state) => state.incrementBackendFrameCount);
  const setBackendFrameCount = useDiscoveryStore((state) => state.setBackendFrameCount);
  const serialActiveTab = useDiscoveryStore((state) => state.serialActiveTab);
  const bufferMode = useDiscoveryStore((state) => state.bufferMode);
  const setFramingConfig = useDiscoveryStore((state) => state.setFramingConfig);

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
    'ioReaderPicker',
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
  const [bufferMetadata, setBufferMetadata] = useState<BufferMetadata | null>(null);

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
    if (payload.buffer_count > 0) {
      const meta = await getBufferMetadata();
      if (meta) {
        setBufferMetadata(meta);
        enableBufferMode(meta.count);

        // Fetch frame info from backend buffer (populates frame picker)
        try {
          const frameInfoList = await getBufferFrameInfo();
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
  const handleIngestComplete = useCallback(async (payload: StreamEndedPayload) => {
    if (payload.buffer_available && payload.count > 0) {
      const meta = await getBufferMetadata();
      if (meta) {
        setBufferMetadata(meta);

        await emit(WINDOW_EVENTS.BUFFER_CHANGED, {
          metadata: meta,
          action: "ingested",
        });
      }

      dialogs.ioReaderPicker.close();

      if (payload.buffer_type === "bytes" && meta) {
        console.log(`[Discovery] Loading ${payload.count} bytes from buffer into serial view`);
        try {
          const bytes = await getBufferBytesById(meta.id);
          const entries = bytes.map((b) => ({
            byte: b.byte,
            timestampUs: b.timestamp_us,
          }));
          clearSerialBytes();
          resetFraming();
          addSerialBytes(entries);
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
          const frameInfoList = await getBufferFrameInfo();
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
    dialogs.ioReaderPicker,
    clearSerialBytes,
    resetFraming,
    addSerialBytes,
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
    setBufferMetadata(null); // Clear stale metadata so effectiveStartTimeUs doesn't use old values
    clearSerialBytes();
    resetFraming();
    setBackendByteCount(0);
    setBackendFrameCount(0);
  }, [clearBuffer, clearFramePicker, clearAnalysisResults, disableBufferMode, clearSerialBytes, resetFraming, setBackendByteCount, setBackendFrameCount]);

  // Use the IO session manager hook - manages session lifecycle, ingest, multi-bus, and derived state
  const manager = useIOSessionManager({
    appName: "discovery",
    ioProfiles: settings?.io_profiles ?? [],
    store: { ioProfile, setIoProfile },
    enableIngest: true,
    onBeforeIngestStart: clearBackendBuffer,
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
    isBufferMode,
    sessionReady,
    capabilities,
    joinerCount,
    // Centralised playback position (from session store)
    currentTimeUs: sessionCurrentTimeUs,
    currentFrameIndex: sessionCurrentFrameIndex,
    handleLeave,
    // Watch state (used by ioPickerProps hook)
    resetWatchFrameCount,
    // Session switching methods
    stopWatch,
    resumeWithNewBuffer,
    selectProfile,
    watchSingleSource,
    // Bookmark methods
    jumpToBookmark,
  } = manager;

  // Session controls from the underlying session
  const {
    sessionId,
    state: readerState,
    bufferId: sessionBufferId,
    bufferType,
    bufferStartTimeUs,
    bufferEndTimeUs,
    bufferCount,
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
    const shouldFetchMetadata = sessionId && !bufferMetadata && (
      (isBufferMode && !isStreaming) ||  // Explicit buffer mode
      (isPaused && bufferCount > 0)       // Paused with buffered frames
    );

    if (shouldFetchMetadata) {
      (async () => {
        try {
          // Fetch buffer metadata
          const meta = await getBufferMetadata();
          if (meta) {
            setBufferMetadata(meta);
            enableBufferMode(meta.count);

            // Fetch frame info from backend buffer (populates frame picker)
            const frameInfoList = await getBufferFrameInfo();
            console.log(`[Discovery] Loaded ${frameInfoList.length} unique frame IDs from buffer`);
            setFrameInfoFromBuffer(frameInfoList);
          }
        } catch (err) {
          console.warn('[Discovery] Failed to fetch buffer data:', err);
        }
      })();
    }
  }, [isBufferMode, isStreaming, isPaused, bufferCount, bufferMetadata, sessionId, enableBufferMode, setFrameInfoFromBuffer]);

  // Keep paused ref in sync with manager state (for callbacks that can't access manager directly)
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  // Keep buffer mode ref in sync (useBufferFrameView handles display in buffer mode)
  useEffect(() => {
    inBufferModeRef.current = isBufferMode || bufferMode.enabled;
  }, [isBufferMode, bufferMode.enabled]);

  // Centralised IO picker handlers - ensures consistent behavior with other apps
  const ioPickerProps = useIOPickerHandlers({
    manager,
    closeDialog: () => dialogs.ioReaderPicker.close(),
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
      if (mode === "watch") {
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
    if (bufferMetadata?.start_time_us != null && !isStreaming) {
      updateCurrentTime(bufferMetadata.start_time_us / 1_000_000);
    }
  }, [bufferMetadata?.start_time_us, isStreaming, updateCurrentTime]);

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
    } else if (isBufferProfileId(ioProfile)) {
      // Buffer mode: check buffer metadata for bytes type
      newIsSerialMode = bufferMetadata?.buffer_type === "bytes" || bufferType === "bytes" || framedBufferId !== null;
    } else {
      // Live session: check session traits from capabilities
      newIsSerialMode = capabilities?.traits?.protocols?.includes("serial") ?? false;
    }

    setSerialMode(newIsSerialMode);

    if (prevIsSerialModeRef.current && !newIsSerialMode) {
      clearSerialBytes();
    }
    prevIsSerialModeRef.current = newIsSerialMode;
  }, [ioProfile, capabilities, bufferMetadata, bufferType, framedBufferId, setSerialMode, clearSerialBytes]);

  // Raw bytes are now routed through sessionStore via the onBytes callback.
  // No ad-hoc Tauri listener needed here.

  const frameList = useMemo(
    () =>
      Array.from(frameInfoMap.entries()).map(([id, info]) => ({
        id,
        len: info.len,
        isExtended: info.isExtended,
        bus: info.bus,
        lenMismatch: info.lenMismatch,
      })),
    [frameInfoMap]
  );

  const protocolLabel = frames.length > 0 ? frames[0].protocol : "can";

  // Timeline sources (postgres, csv, buffer) have is_realtime=false in capabilities
  const isRecorded = capabilities?.is_realtime === false;

  // Merged buffer metadata using session values for cross-app timeline sync
  const effectiveBufferMetadata = useEffectiveBufferMetadata(
    { bufferStartTimeUs, bufferEndTimeUs, bufferCount },
    bufferMetadata
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
    if (isSerialMode && framedBufferId && backendFrameCount > 0) return backendFrameCount;
    if (isSerialMode && framedData.length > 0) return framedData.length;
    return frames.length;
  }, [exportDataMode, backendByteCount, serialBytesBuffer.length, bufferMode, isSerialMode, framedBufferId, backendFrameCount, framedData.length, frames.length]);

  const exportDefaultFilename = useMemo(() => {
    const protocol = exportDataMode === "bytes" ? "serial" : (protocolLabel || "can");
    return `${formatFilenameDate()}-${protocol}`;
  }, [exportDataMode, protocolLabel]);

  // Modbus scan: listen for scan events and route to toolbox store
  useEffect(() => {
    if (!isScanning) return;

    let unlistenFrames: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;
    let unlistenDeviceInfo: (() => void) | null = null;

    const setup = async () => {
      unlistenFrames = await listen<FrameMessage[]>("modbus-scan-frame", (event) => {
        if (event.payload && event.payload.length > 0) {
          addModbusScanFrames(event.payload);
        }
      });

      unlistenProgress = await listen<{ current: number; total: number; found_count: number }>("modbus-scan-progress", (event) => {
        updateModbusScanProgress(event.payload);
      });

      unlistenDeviceInfo = await listen<{ unit_id: number; vendor?: string; product_code?: string; revision?: string }>("modbus-scan-device-info", (event) => {
        addModbusScanDeviceInfo(event.payload);
      });
    };

    setup();

    return () => {
      unlistenFrames?.();
      unlistenProgress?.();
      unlistenDeviceInfo?.();
    };
  }, [isScanning, addModbusScanFrames, updateModbusScanProgress, addModbusScanDeviceInfo]);

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
      const result = await startModbusScan(config);
      console.log(`[Discovery] Modbus register scan complete: found ${result.found_count} of ${result.total_scanned} in ${result.duration_ms}ms`);
    } catch (e) {
      showAppError("Scan Error", "An error occurred during Modbus register scan.", String(e));
    } finally {
      finishModbusScan();
    }
  }, [startModbusScanStore, finishModbusScan, showAppError, setModbusExportConfig]);

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
      const result = await startModbusUnitIdScan(config);
      console.log(`[Discovery] Modbus unit ID scan complete: found ${result.found_count} of ${result.total_scanned} in ${result.duration_ms}ms`);
    } catch (e) {
      showAppError("Scan Error", "An error occurred during Modbus unit ID scan.", String(e));
    } finally {
      finishModbusScan();
    }
  }, [startModbusScanStore, finishModbusScan, showAppError, setModbusExportConfig]);

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
    framedBufferId,
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
    setBufferMetadata,

    // Manager session switching methods
    stopWatch,
    selectProfile,
    watchSingleSource,
    jumpToBookmark,

    // Session actions
    setIoProfile,
    start,
    pause,
    resume,
    reinitialize,
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
    getBufferBytesPaginated,
    getBufferFramesPaginated,
    getBufferFramesPaginatedById,
    clearBackendBuffer,
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
      const selectedIds = Array.from(selectedFrames);
      try {
        const response = await getBufferFramesPaginatedFiltered(frameIndex, 1, selectedIds);
        if (response.frames.length > 0) {
          updateCurrentTime(response.frames[0].timestamp_us / 1_000_000);
        }
      } catch {
        // Best effort — timestamp syncs when page loads
      }
    }
  }, [sessionId, capabilities, seekByFrame, selectedFrames, setCurrentFrameIndex, updateCurrentTime]);

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
      onPicker: () => dialogs.ioReaderPicker.open(),
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
          bufferMetadata={bufferMetadata}
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
          selectedFrameCount={selectedFrames.size}
          onOpenFramePicker={() => dialogs.framePicker.open()}
          isSerialMode={isSerialMode}
          serialBytesCount={backendByteCount > 0 ? backendByteCount : serialBytesBuffer.length}
          framingAccepted={framingAccepted}
          serialActiveTab={serialActiveTab}
          onUndoFraming={undoAcceptFraming}
          isModbusProfile={isModbusProfile}
          onOpenIoReaderPicker={() => dialogs.ioReaderPicker.open()}
          onSave={openSaveDialog}
          onExport={() => dialogs.export.open()}
          onClear={handlers.handleClearDiscoveredFrames}
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
            emitsRawBytes={capabilities?.emits_raw_bytes ?? true}
          />
        ) : (
          <DiscoveryFramesView
            frames={frames}
            bufferId={bufferMetadata?.id ?? (bufferMode.enabled ? sessionBufferId : null)}
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
            bufferMetadata={effectiveBufferMetadata}
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
            isLiveStreaming={isRecorded && isStreaming && !isPaused && !isBufferMode}
            isStreamPaused={isRecorded && isPaused && !isBufferMode}
            onResumeStream={resume}
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
        frameCount={selectedFrames.size > 0 ? frames.filter(f => selectedFrames.has(f.frame_id)).length : 0}
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

      <IoReaderPickerDialog
        isOpen={dialogs.ioReaderPicker.isOpen}
        onClose={() => dialogs.ioReaderPicker.close()}
        ioProfiles={settings?.io_profiles || []}
        selectedId={ioProfile}
        selectedIds={ioProfiles.length > 0 ? ioProfiles : undefined}
        defaultId={settings?.default_read_profile}
        onSelect={handlers.handleIoProfileChange}
        {...ioPickerProps}
        onImport={setBufferMetadata}
        bufferMetadata={bufferMetadata}
        defaultDir={settings?.dump_dir}
        ingestSpeed={playbackSpeed}
        onIngestSpeedChange={(speed) => handlers.handleSpeedChange(speed)}
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
