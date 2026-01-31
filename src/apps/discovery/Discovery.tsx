// ui/src/apps/discovery/Discovery.tsx

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { useSettings, getDisplayFrameIdFormat, getSaveFrameIdFormat } from "../../hooks/useSettings";
import { useIOSessionManager } from '../../hooks/useIOSessionManager';
import { useFocusStore } from '../../stores/focusStore';
import { useDiscoveryStore, type FrameMessage, type PlaybackSpeed } from "../../stores/discoveryStore";
import { useDiscoveryUIStore } from "../../stores/discoveryUIStore";
import { useDiscoveryHandlers } from "./hooks/useDiscoveryHandlers";
import type { StreamEndedPayload, PlaybackPosition } from '../../api/io';
import AppLayout from "../../components/AppLayout";
import DiscoveryTopBar from "./views/DiscoveryTopBar";
import DiscoveryFramesView from "./views/DiscoveryFramesView";
import SerialDiscoveryView from "./views/SerialDiscoveryView";
import SaveFramesDialog from "../../dialogs/SaveFramesDialog";
import DecoderInfoDialog from "../../dialogs/DecoderInfoDialog";
import ErrorDialog from "../../dialogs/ErrorDialog";
import AddBookmarkDialog from "../../dialogs/AddBookmarkDialog";
import AnalysisProgressDialog from "./dialogs/AnalysisProgressDialog";
import ConfirmDeleteDialog from "../../dialogs/ConfirmDeleteDialog";
import SpeedPickerDialog from "../../dialogs/SpeedPickerDialog";
import ExportFramesDialog, { type ExportDataMode } from "../../dialogs/ExportFramesDialog";
import BookmarkEditorDialog from "../../dialogs/BookmarkEditorDialog";
import SaveSelectionSetDialog from "../../dialogs/SaveSelectionSetDialog";
import SelectionSetPickerDialog from "../../dialogs/SelectionSetPickerDialog";
import IoReaderPickerDialog from "../../dialogs/IoReaderPickerDialog";
import { isBufferProfileId } from "../../hooks/useIOSessionManager";
import { clearBuffer as clearBackendBuffer, getBufferMetadata, getBufferMetadataById, getBufferFramesPaginated, getBufferBytesPaginated, getBufferFrameInfo, getBufferBytesById, getBufferFramesPaginatedById, setActiveBuffer, type BufferMetadata } from "../../api/buffer";
import { WINDOW_EVENTS, type BufferChangedPayload } from "../../events/registry";
import FramePickerDialog from "../../dialogs/FramePickerDialog";
import ToolboxDialog from "../../dialogs/ToolboxDialog";
import { pickFileToSave } from "../../api/dialogs";
import { saveCatalog } from "../../api/catalog";
import { formatFilenameDate } from "../../utils/timeFormat";
import { useDialogManager } from "../../hooks/useDialogManager";

export default function Discovery() {
  const { settings } = useSettings();

  // Track if this panel is focused (for menu state reporting)
  const isFocused = useFocusStore((s) => s.focusedPanelId === "discovery");

  // Zustand store selectors
  const frames = useDiscoveryStore((state) => state.frames);
  const frameInfoMap = useDiscoveryStore((state) => state.frameInfoMap);
  const selectedFrames = useDiscoveryStore((state) => state.selectedFrames);
  const maxBuffer = useDiscoveryStore((state) => state.maxBuffer);
  const ioProfile = useDiscoveryStore((state) => state.ioProfile);
  const playbackSpeed = useDiscoveryStore((state) => state.playbackSpeed);
  const showSaveDialog = useDiscoveryStore((state) => state.showSaveDialog);
  const saveMetadata = useDiscoveryStore((state) => state.saveMetadata);
  const showErrorDialog = useDiscoveryStore((state) => state.showErrorDialog);
  const errorDialogTitle = useDiscoveryStore((state) => state.errorDialogTitle);
  const errorDialogMessage = useDiscoveryStore((state) => state.errorDialogMessage);
  const errorDialogDetails = useDiscoveryStore((state) => state.errorDialogDetails);
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

  const setShowBusColumn = useDiscoveryUIStore((state) => state.setShowBusColumn);

  // Zustand store actions
  const showError = useDiscoveryStore((state) => state.showError);
  const closeErrorDialog = useDiscoveryStore((state) => state.closeErrorDialog);
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
  const triggerBufferReady = useDiscoveryStore((state) => state.triggerBufferReady);
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
    'selectionSetPicker',
    'ioReaderPicker',
    'framePicker',
    'toolbox',
  ] as const);

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

  // Load buffer metadata on mount (in case a CSV was already imported)
  // Note: Uses setIoProfile directly (not selectProfile) because this runs before
  // useIOSessionManager is called, and on mount there's no multi-bus state to clear.
  useEffect(() => {
    const loadBufferOnMount = async () => {
      try {
        const meta = await getBufferMetadata();
        if (meta && meta.count > 0 && meta.buffer_type === 'frames') {
          setBufferMetadata(meta);
          enableBufferMode(meta.count);
          setIoProfile(meta.id);
          const frameInfoList = await getBufferFrameInfo();
          setFrameInfoFromBuffer(frameInfoList);
        }
      } catch (e) {
        // Buffer not available, that's fine
      }
    };
    loadBufferOnMount();
  }, [enableBufferMode, setFrameInfoFromBuffer, setIoProfile]);

  // Listen for buffer changes from other windows
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen<BufferChangedPayload>(
        WINDOW_EVENTS.BUFFER_CHANGED,
        async (event) => {
          const meta = event.payload.metadata;
          setBufferMetadata(meta);

          if (!meta) {
            clearSerialBytes();
            resetFraming();
            return;
          }

          if (meta.count > 0 && meta.buffer_type === 'frames') {
            enableBufferMode(meta.count);
            // Note: Uses setIoProfile directly because this runs before useIOSessionManager,
            // and buffer events from other windows don't involve multi-bus state.
            setIoProfile(meta.id);
            try {
              const frameInfoList = await getBufferFrameInfo();
              setFrameInfoFromBuffer(frameInfoList);
            } catch (e) {
              console.error("Failed to load frame info from buffer:", e);
            }
          }
        }
      );
      return unlisten;
    };

    const unlistenPromise = setupListener();
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enableBufferMode, setFrameInfoFromBuffer, clearSerialBytes, resetFraming, setIoProfile]);

  // Callbacks for reader session
  // Note: Watch frame counting is handled by useIOSessionManager
  const handleFrames = useCallback((receivedFrames: FrameMessage[]) => {
    if (!receivedFrames || receivedFrames.length === 0) return;
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
    showError("Stream Error", "An error occurred while streaming CAN data.", error);
  }, [showError]);

  const handleTimeUpdate = useCallback((position: PlaybackPosition) => {
    updateCurrentTime(position.timestamp_us / 1_000_000);
    setCurrentFrameIndex(position.frame_index);
  }, [updateCurrentTime, setCurrentFrameIndex]);

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
        const totalFrames = payload.count;
        const BUFFER_MODE_THRESHOLD = 100000;

        clearBuffer();

        if (totalFrames > BUFFER_MODE_THRESHOLD) {
          console.log(`[Discovery] Large ingest (${totalFrames} frames) - enabling buffer mode`);
          enableBufferMode(totalFrames);

          try {
            const frameInfoList = await getBufferFrameInfo();
            console.log(`[Discovery] Loaded ${frameInfoList.length} unique frame IDs from buffer`);
            setFrameInfoFromBuffer(frameInfoList);
          } catch (e) {
            console.error("Failed to load frame info from buffer:", e);
          }
        } else {
          console.log(`[Discovery] Loading ${totalFrames} frames from backend buffer`);

          if (totalFrames > maxBuffer) {
            setMaxBuffer(totalFrames);
          }

          try {
            const response = await getBufferFramesPaginated(0, totalFrames);
            if (response.frames.length > 0) {
              addFrames(response.frames as FrameMessage[]);
            }
            console.log(`[Discovery] Loaded ${response.frames.length} frames`);
          } catch (e) {
            console.error("Failed to load frames from buffer:", e);
          }
        }
      }

      // Use the actual buffer ID for unique session naming
      if (meta) {
        setIoProfile(meta.id);
      }
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
    maxBuffer,
    setMaxBuffer,
    addFrames,
    setIoProfile,
  ]);

  // Cleanup callback for before starting a new watch session
  const clearBeforeWatch = useCallback(() => {
    clearBuffer();
    clearFramePicker();
    clearAnalysisResults();
    disableBufferMode();
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
    onSpeedChange: handleSessionSpeedChange,
    // Session switching callbacks
    setPlaybackSpeed: (speed: number) => setPlaybackSpeed(speed as PlaybackSpeed),
    onBeforeWatch: clearBeforeWatch,
    onBeforeMultiWatch: clearBeforeWatch,
  });

  // Destructure everything from the manager
  const {
    // Multi-bus state
    multiBusMode,
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
    isRealtime,
    sessionReady,
    capabilities,
    joinerCount,
    // Detach/rejoin
    isDetached,
    handleDetach,
    handleRejoin,
    // Watch state
    watchFrameCount,
    resetWatchFrameCount,
    // Ingest state
    isIngesting,
    ingestProfileId,
    ingestFrameCount,
    ingestError,
    stopIngest,
    // Session switching methods
    watchSingleSource,
    watchMultiSource,
    stopWatch,
    selectProfile,
    selectMultipleProfiles,
    joinSession,
    skipReader,
  } = manager;

  // Session controls from the underlying session
  const {
    sessionId,
    bufferAvailable,
    bufferId,
    bufferType,
    bufferCount,
    stoppedExplicitly,
    start,
    stop,
    pause,
    resume,
    setSpeed,
    setTimeRange,
    seek,
    reinitialize,
  } = session;

  // Track previous buffer state to detect when buffer becomes available
  const prevBufferAvailableRef = useRef(false);

  // Handle stream ended for Watch mode
  useEffect(() => {
    if (bufferAvailable && bufferCount > 0 && bufferId && !prevBufferAvailableRef.current && stoppedExplicitly) {
      console.log(`[Discovery] Buffer transition starting - bufferAvailable=${bufferAvailable}, bufferCount=${bufferCount}, bufferId=${bufferId}, bufferType=${bufferType}, stoppedExplicitly=${stoppedExplicitly}`);
      (async () => {
        const preferredBufferId = (bufferType === "bytes" && framedBufferId) ? framedBufferId : bufferId;
        console.log(`[Discovery] Using preferredBufferId=${preferredBufferId}, framedBufferId=${framedBufferId}`);

        const meta = await getBufferMetadataById(preferredBufferId);
        if (meta) {
          console.log(`[Discovery] Got buffer metadata: type=${meta.buffer_type}, count=${meta.count}`);
          setBufferMetadata(meta);
          await emit(WINDOW_EVENTS.BUFFER_CHANGED, {
            metadata: meta,
            action: "streamed",
          });

          if (meta.buffer_type === "bytes") {
            console.log(`[Discovery] Bytes mode - loading bytes and switching to buffer session`);
            await setActiveBuffer(meta.id);
            try {
              const bytes = await getBufferBytesById(meta.id);
              const entries = bytes.map((b) => ({
                byte: b.byte,
                timestampUs: b.timestamp_us,
              }));
              clearSerialBytes(true);
              resetFraming();
              addSerialBytes(entries);
              setBackendByteCount(meta.count);
              triggerBufferReady();
            } catch (e) {
              console.error("Failed to load bytes from buffer:", e);
            }
            // Use the actual buffer ID for unique session naming
            console.log(`[Discovery] Bytes mode - calling setIoProfile(${meta.id})`);
            setIoProfile(meta.id);
            console.log(`[Discovery] Bytes mode - calling reinitialize(${meta.id})`);
            await reinitialize(meta.id, { useBuffer: true });
            console.log(`[Discovery] Bytes mode - reinitialize complete`);
            // Stop the session immediately - bytes are already loaded into the store, no streaming needed
            console.log(`[Discovery] Bytes mode - stopping session (data already loaded)`);
            await stop();
            console.log(`[Discovery] Bytes mode - session stopped`);
          } else {
            // Frames mode - enable buffer mode and load frame info
            console.log(`[Discovery] Frames mode - switching to buffer session`);
            await setActiveBuffer(meta.id);
            enableBufferMode(meta.count);
            setMaxBuffer(meta.count);
            try {
              const frameInfoList = await getBufferFrameInfo();
              console.log(`[Discovery] Frames mode - got ${frameInfoList.length} frame info entries`);
              setFrameInfoFromBuffer(frameInfoList);
            } catch (e) {
              console.error("[Discovery] Failed to load frame info:", e);
            }
            console.log(`[Discovery] Frames mode - calling setIoProfile(${meta.id})`);
            setIoProfile(meta.id);
            console.log(`[Discovery] Frames mode - calling reinitialize(${meta.id})`);
            await reinitialize(meta.id, { useBuffer: true });
            console.log(`[Discovery] Frames mode - reinitialize complete`);
          }
        }
      })();
    }
    prevBufferAvailableRef.current = bufferAvailable;
  }, [bufferAvailable, bufferId, bufferCount, bufferType, framedBufferId, stoppedExplicitly, setIoProfile, reinitialize, stop, clearSerialBytes, resetFraming, addSerialBytes, triggerBufferReady, setBackendByteCount, enableBufferMode, setMaxBuffer, setFrameInfoFromBuffer]);

  // Note: isStreaming, isPaused, isStopped, isRealtime are now provided by useIOSessionManager

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
    }, 1000);
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

  const isRecorded = useMemo(() => {
    if (!ioProfile || !settings?.io_profiles) return false;
    if (isBufferProfileId(ioProfile)) return true;
    const profile = settings.io_profiles.find((p) => p.id === ioProfile);
    return profile?.kind === 'postgres' || profile?.kind === 'csv_file';
  }, [ioProfile, settings?.io_profiles]);

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

  // Use the handlers hook
  const handlers = useDiscoveryHandlers({
    // Session state
    sessionId,
    multiBusMode,
    isStreaming,
    isPaused,
    sessionReady,
    ioProfile,
    sourceProfileId,
    playbackSpeed,
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

    // Detach/rejoin handlers (from manager)
    handleDetach,
    handleRejoin,

    // Manager session switching methods
    watchSingleSource,
    watchMultiSource,
    stopWatch,
    selectProfile,
    selectMultipleProfiles,
    joinSession,

    // Session actions
    setIoProfile,
    setSourceProfileId,
    setShowBusColumn,
    start,
    pause,
    resume,
    reinitialize,
    setSpeed,
    setTimeRange,

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
    setSerialConfig,
    setFramingConfig,
    showError,
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
    closeIoReaderPicker: dialogs.ioReaderPicker.close,
  });

  // Report session state to menu when this panel is focused
  useEffect(() => {
    if (isFocused) {
      invoke("update_menu_session_state", {
        profileName: ioProfileName ?? null,
        isStreaming,
        isPaused,
      });
    }
  }, [isFocused, ioProfileName, isStreaming, isPaused]);

  // Listen for session control menu commands
  useEffect(() => {
    const currentWindow = getCurrentWebviewWindow();

    const setupListeners = async () => {
      // Session control events from menu (only respond when targeted)
      const unlistenControl = await currentWindow.listen<{ action: string; targetPanelId: string | null }>(
        "session-control",
        (event) => {
          const { action, targetPanelId } = event.payload;
          if (targetPanelId !== "discovery") return;

          switch (action) {
            case "play":
              if (isPaused) {
                resume();
              } else if (isStopped && sessionReady) {
                start();
              }
              break;
            case "pause":
              if (isStreaming && !isPaused) {
                pause();
              }
              break;
            case "stop":
              if (isStreaming) {
                stopWatch();
              }
              break;
            case "clear":
              handlers.handleClearDiscoveredFrames();
              break;
            case "picker":
              dialogs.ioReaderPicker.open();
              break;
          }
        }
      );

      // Save bookmark from menu - open dialog with current time (Discovery only)
      const unlistenBookmark = await currentWindow.listen<{ targetPanelId: string | null } | undefined>(
        "menu-bookmark-save",
        () => {
          // Bookmark save is Discovery-specific, always respond
          const timeUs = currentTime !== null ? currentTime * 1_000_000 : 0;
          setBookmarkFrameId(0); // No specific frame
          setBookmarkFrameTime(new Date(timeUs / 1000).toISOString());
          dialogs.bookmark.open();
        }
      );

      return () => {
        unlistenControl();
        unlistenBookmark();
      };
    };

    const cleanup = setupListeners();
    return () => {
      cleanup.then((fn) => fn());
    };
  }, [isPaused, isStopped, isStreaming, sessionReady, resume, start, pause, stopWatch, handlers, currentTime, dialogs]);

  // Handle skip for IoReaderPickerDialog
  const handleSkip = useCallback(async () => {
    await skipReader();
    dialogs.ioReaderPicker.close();
  }, [skipReader, dialogs.ioReaderPicker]);

  return (
    <AppLayout
      topBar={
        <DiscoveryTopBar
          ioProfiles={settings?.io_profiles || []}
          ioProfile={ioProfile}
          onIoProfileChange={handlers.handleIoProfileChange}
          defaultReadProfileId={settings?.default_read_profile}
          bufferMetadata={bufferMetadata}
          isStreaming={isStreaming}
          multiBusMode={multiBusMode}
          multiBusProfiles={ioProfiles}
          onStopWatch={handlers.handleStop}
          isStopped={isStopped}
          onResume={start}
          joinerCount={joinerCount}
          onDetach={handlers.handleDetach}
          isDetached={isDetached}
          onRejoin={handlers.handleRejoin}
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
            protocol={protocolLabel}
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
            currentTimeUs={currentTime !== null ? currentTime * 1_000_000 : null}
            onScrub={handlers.handleScrub}
            bufferMetadata={bufferMetadata}
            isRecorded={isRecorded}
            // Playback controls
            playbackState={isStreaming && !isPaused ? "playing" : "paused"}
            playbackDirection={playbackDirection}
            capabilities={capabilities}
            playbackSpeed={playbackSpeed}
            currentFrameIndex={currentFrameIndex}
            onFrameSelect={async (frameIndex, timestampUs) => {
              setCurrentFrameIndex(frameIndex);
              updateCurrentTime(timestampUs / 1_000_000);
              if (capabilities?.supports_seek) {
                await seek(timestampUs);
              }
            }}
            onPlay={() => { setPlaybackDirection("forward"); handlers.handlePlayForward(); }}
            onPlayBackward={() => { setPlaybackDirection("backward"); handlers.handlePlayBackward(); }}
            onPause={handlers.handlePause}
            onStepBackward={handlers.handleStepBackward}
            onStepForward={handlers.handleStepForward}
            onSpeedChange={handlers.handleSpeedChange}
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

      <ErrorDialog
        isOpen={showErrorDialog}
        title={errorDialogTitle}
        message={errorDialogMessage}
        details={errorDialogDetails || undefined}
        onClose={closeErrorDialog}
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

      <SaveSelectionSetDialog
        isOpen={dialogs.saveSelectionSet.isOpen}
        frameCount={selectedFrames.size}
        onClose={() => dialogs.saveSelectionSet.close()}
        onSave={handlers.handleSaveNewSelectionSet}
      />

      <SelectionSetPickerDialog
        isOpen={dialogs.selectionSetPicker.isOpen}
        onClose={() => dialogs.selectionSetPicker.close()}
        onLoad={handlers.handleLoadSelectionSet}
        onClear={handlers.handleClearSelectionSet}
      />

      <IoReaderPickerDialog
        isOpen={dialogs.ioReaderPicker.isOpen}
        onClose={() => dialogs.ioReaderPicker.close()}
        ioProfiles={settings?.io_profiles || []}
        selectedId={ioProfile}
        selectedIds={multiBusMode ? ioProfiles : undefined}
        defaultId={settings?.default_read_profile}
        onSelect={handlers.handleIoProfileChange}
        onSelectMultiple={handlers.handleSelectMultiple}
        onImport={setBufferMetadata}
        bufferMetadata={bufferMetadata}
        defaultDir={settings?.dump_dir}
        isIngesting={isIngesting || isStreaming}
        ingestProfileId={isIngesting ? ingestProfileId : (isStreaming ? ioProfile : null)}
        ingestFrameCount={isIngesting ? ingestFrameCount : watchFrameCount}
        ingestSpeed={playbackSpeed}
        onIngestSpeedChange={(speed) => handlers.handleSpeedChange(speed)}
        onStartIngest={handlers.handleDialogStartIngest}
        onStartMultiIngest={handlers.handleDialogStartMultiIngest}
        onStopIngest={isIngesting ? stopIngest : handlers.handleStop}
        ingestError={ingestError}
        onJoinSession={handlers.handleJoinSession}
        allowMultiSelect={true}
        onSkip={handleSkip}
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
        onOpenSelectionSetPicker={() => dialogs.selectionSetPicker.open()}
      />

      <ToolboxDialog
        isOpen={dialogs.toolbox.isOpen}
        onClose={() => dialogs.toolbox.close()}
        selectedCount={selectedFrames.size}
        frameCount={frameList.length}
        isSerialMode={isSerialMode}
        serialFrameCount={backendFrameCount > 0 ? backendFrameCount : (framedData.length + frames.length)}
        serialBytesCount={backendByteCount > 0 ? backendByteCount : serialBytesBuffer.length}
      />

      <DecoderInfoDialog
        isOpen={showInfoView}
        onClose={closeInfoView}
      />
    </AppLayout>
  );
}
