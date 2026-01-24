// ui/src/apps/discovery/Discovery.tsx

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { useSettings, getDisplayFrameIdFormat, getSaveFrameIdFormat } from "../../hooks/useSettings";
import { useIOSession } from '../../hooks/useIOSession';
import { useDiscoveryStore, type FrameMessage, type PlaybackSpeed, type SerialRawBytesPayload } from "../../stores/discoveryStore";
import { useDiscoveryUIStore } from "../../stores/discoveryUIStore";
import { useDiscoveryHandlers } from "./hooks/useDiscoveryHandlers";
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
import IoReaderPickerDialog, { BUFFER_PROFILE_ID } from "../../dialogs/IoReaderPickerDialog";
import { useIngestSession, type StreamEndedPayload } from "../../hooks/useIngestSession";
import {
  createAndStartMultiSourceSession,
  joinMultiSourceSession,
  useMultiBusState,
} from '../../stores/sessionStore';
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
  const toolboxIsRunning = useDiscoveryStore((state) => state.toolbox.isRunning);
  const toolboxActiveView = useDiscoveryStore((state) => state.toolbox.activeView);
  const showInfoView = useDiscoveryStore((state) => state.showInfoView);
  const knowledge = useDiscoveryStore((state) => state.knowledge);
  const activeSelectionSetId = useDiscoveryStore((state) => state.activeSelectionSetId);
  const selectionSetDirty = useDiscoveryStore((state) => state.selectionSetDirty);
  const streamStartTimeUs = useDiscoveryStore((state) => state.streamStartTimeUs);

  // Multi-bus mode state from session store (centralized)
  const {
    multiBusMode,
    multiBusProfiles: ioProfiles,
    sourceProfileId,
    setMultiBusMode,
    setMultiBusProfiles: setIoProfiles,
    setSourceProfileId,
  } = useMultiBusState();
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
  const serialViewConfig = useDiscoveryStore((state) => state.serialViewConfig);
  const toggleShowAscii = useDiscoveryStore((state) => state.toggleShowAscii);
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

  // Buffer metadata state (for imported CSV files)
  const [bufferMetadata, setBufferMetadata] = useState<BufferMetadata | null>(null);

  // Time range visibility
  const [showTimeRange] = useState(false);

  // Track if we've detached from a session (but profile still selected)
  const [isDetached, setIsDetached] = useState(false);

  // Watch frame count (for top bar display during streaming)
  const [watchFrameCount, setWatchFrameCount] = useState(0);

  // Ref to hold the ingest complete handler (set after useIOSession provides reinitialize)
  const ingestCompleteRef = useRef<((payload: StreamEndedPayload) => Promise<void>) | undefined>(undefined);

  // Ingest session hook - handles event listeners, session lifecycle, error handling
  const {
    isIngesting,
    ingestProfileId,
    ingestFrameCount,
    ingestError,
    startIngest: _startIngest,
    stopIngest,
  } = useIngestSession({
    onComplete: async (payload) => {
      if (ingestCompleteRef.current) {
        await ingestCompleteRef.current(payload);
      }
    },
    onBeforeStart: clearBackendBuffer,
  });

  // Load buffer metadata on mount (in case a CSV was already imported)
  useEffect(() => {
    const loadBufferOnMount = async () => {
      try {
        const meta = await getBufferMetadata();
        if (meta && meta.count > 0 && meta.buffer_type === 'frames') {
          setBufferMetadata(meta);
          enableBufferMode(meta.count);
          const frameInfoList = await getBufferFrameInfo();
          setFrameInfoFromBuffer(frameInfoList);
        }
      } catch (e) {
        // Buffer not available, that's fine
      }
    };
    loadBufferOnMount();
  }, [enableBufferMode, setFrameInfoFromBuffer]);

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
  }, [enableBufferMode, setFrameInfoFromBuffer, clearSerialBytes, resetFraming]);

  // Callbacks for reader session
  const handleFrames = useCallback((receivedFrames: FrameMessage[]) => {
    if (!receivedFrames || receivedFrames.length === 0) return;
    addFrames(receivedFrames);
    setWatchFrameCount((prev) => prev + receivedFrames.length);
    incrementBackendFrameCount(receivedFrames.length);
  }, [addFrames, incrementBackendFrameCount]);

  const handleError = useCallback((error: string) => {
    showError("Stream Error", "An error occurred while streaming CAN data.", error);
  }, [showError]);

  const handleTimeUpdate = useCallback((timeUs: number) => {
    updateCurrentTime(timeUs / 1_000_000);
  }, [updateCurrentTime]);

  const handleSessionSpeedChange = useCallback((speed: number) => {
    setPlaybackSpeed(speed as PlaybackSpeed);
  }, [setPlaybackSpeed]);

  // Get the profile name for display in session dropdown
  const ioProfileName = useMemo(() => {
    if (!ioProfile || !settings?.io_profiles) return undefined;
    const profile = settings.io_profiles.find((p) => p.id === ioProfile);
    return profile?.name;
  }, [ioProfile, settings?.io_profiles]);

  // Get profile names map for multi-bus mode
  const profileNamesMap = useMemo(() => {
    if (!settings?.io_profiles) return new Map<string, string>();
    return new Map(settings.io_profiles.map((p) => [p.id, p.name]));
  }, [settings?.io_profiles]);

  // Session ID for multi-bus mode (Rust-side merging)
  const MULTI_SESSION_ID = "discovery-multi";

  // Determine the effective session ID
  const effectiveSessionId = multiBusMode ? MULTI_SESSION_ID : (ioProfile || undefined);

  // Use a single session hook that works for both modes
  const session = useIOSession({
    appName: "discovery",
    sessionId: effectiveSessionId,
    profileName: multiBusMode ? `Multi-Bus (${ioProfiles.length} sources)` : ioProfileName,
    onFrames: handleFrames,
    onError: handleError,
    onTimeUpdate: handleTimeUpdate,
    onSpeedChange: handleSessionSpeedChange,
  });

  const {
    capabilities,
    state: readerState,
    isReady: sessionReady,
    bufferAvailable,
    bufferId,
    bufferType,
    bufferCount,
    joinerCount,
    stoppedExplicitly,
    start,
    stop,
    leave,
    pause,
    resume,
    setSpeed,
    setTimeRange,
    rejoin,
    reinitialize,
  } = session;

  // Set up the ingest complete handler now that reinitialize is available
  ingestCompleteRef.current = async (payload: StreamEndedPayload) => {
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

      setIoProfile(BUFFER_PROFILE_ID);
      await reinitialize(undefined, { useBuffer: true });
    }
  };

  // Track previous buffer state to detect when buffer becomes available
  const prevBufferAvailableRef = useRef(false);

  // Handle stream ended for Watch mode
  useEffect(() => {
    if (bufferAvailable && bufferCount > 0 && bufferId && !prevBufferAvailableRef.current && stoppedExplicitly) {
      (async () => {
        const preferredBufferId = (bufferType === "bytes" && framedBufferId) ? framedBufferId : bufferId;

        const meta = await getBufferMetadataById(preferredBufferId);
        if (meta) {
          setBufferMetadata(meta);
          await emit(WINDOW_EVENTS.BUFFER_CHANGED, {
            metadata: meta,
            action: "streamed",
          });

          if (meta.buffer_type === "bytes") {
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
            setIoProfile(BUFFER_PROFILE_ID);
          } else {
            setIoProfile(BUFFER_PROFILE_ID);
            await reinitialize(undefined, { useBuffer: true });
          }
        }
      })();
    }
    prevBufferAvailableRef.current = bufferAvailable;
  }, [bufferAvailable, bufferId, bufferCount, bufferType, framedBufferId, stoppedExplicitly, setIoProfile, reinitialize, clearSerialBytes, resetFraming, addSerialBytes, triggerBufferReady, setBackendByteCount]);

  // Derive streaming state from reader state
  const isStreaming = !isDetached && (readerState === "running" || readerState === "paused");
  const isPaused = readerState === "paused";
  const isStopped = !isDetached && readerState === "stopped" && ioProfile !== null && ioProfile !== BUFFER_PROFILE_ID;
  const isRealtime = capabilities?.is_realtime === true;

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

  // Detect if current profile is serial
  const prevIsSerialModeRef = useRef(false);
  useEffect(() => {
    let newIsSerialMode = false;

    if (!ioProfile) {
      newIsSerialMode = false;
    } else if (ioProfile === BUFFER_PROFILE_ID) {
      newIsSerialMode = bufferMetadata?.buffer_type === "bytes" || bufferType === "bytes" || framedBufferId !== null;
    } else if (settings?.io_profiles) {
      const profile = settings.io_profiles.find((p) => p.id === ioProfile);
      newIsSerialMode = profile?.kind === "serial";
    }

    setSerialMode(newIsSerialMode);

    if (prevIsSerialModeRef.current && !newIsSerialMode) {
      clearSerialBytes();
    }
    prevIsSerialModeRef.current = newIsSerialMode;
  }, [ioProfile, settings?.io_profiles, bufferMetadata, bufferType, framedBufferId, setSerialMode, clearSerialBytes]);

  // Listen for serial-raw-bytes events when in serial mode
  useEffect(() => {
    if (!isSerialMode) return;

    const setupListener = async () => {
      const unlisten = await listen<SerialRawBytesPayload>(
        `serial-raw-bytes:discovery`,
        (event) => {
          const entries = event.payload.bytes.map((b) => ({
            byte: b.byte,
            timestampUs: b.timestamp_us,
          }));
          incrementBackendByteCount(entries.length);
          addSerialBytes(entries);
        }
      );
      return unlisten;
    };

    const unlistenPromise = setupListener();
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [isSerialMode, addSerialBytes, incrementBackendByteCount]);

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
    if (ioProfile === BUFFER_PROFILE_ID) return true;
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
    setWatchFrameCount,
    setBufferMetadata,
    setIsDetached,

    // Session actions
    setMultiBusMode,
    setMultiBusProfiles: setIoProfiles,
    setIoProfile,
    setSourceProfileId,
    setShowBusColumn,
    start,
    stop,
    pause,
    resume,
    leave,
    rejoin,
    reinitialize,
    setSpeed,
    setTimeRange,

    // Store actions
    setPlaybackSpeed,
    updateCurrentTime,
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

    // API functions
    getBufferMetadata,
    getBufferFrameInfo,
    getBufferBytesById,
    getBufferBytesPaginated,
    getBufferFramesPaginated,
    getBufferFramesPaginatedById,
    setActiveBuffer,
    clearBackendBuffer,
    pickFileToSave,
    saveCatalog,

    // Helpers
    profileNamesMap,
    createAndStartMultiSourceSession,
    joinMultiSourceSession,

    // Dialog controls
    openBookmarkDialog: dialogs.bookmark.open,
    closeSpeedChangeDialog: dialogs.speedChange.close,
    openSaveSelectionSetDialog: dialogs.saveSelectionSet.open,
    closeExportDialog: dialogs.export.close,
    closeIoReaderPicker: dialogs.ioReaderPicker.close,

    // Constants
    BUFFER_PROFILE_ID,
  });

  // Handle skip for IoReaderPickerDialog
  const handleSkip = useCallback(async () => {
    if (multiBusMode || ioProfiles.length > 0) {
      setMultiBusMode(false);
      setIoProfiles([]);
    }
    if (isStreaming || isPaused) {
      await leave();
    }
    setIoProfile(null);
    dialogs.ioReaderPicker.close();
  }, [multiBusMode, ioProfiles.length, isStreaming, isPaused, setMultiBusMode, setIoProfiles, leave, setIoProfile, dialogs.ioReaderPicker]);

  return (
    <div className="h-full flex flex-col bg-slate-50 dark:bg-slate-900 overflow-hidden">
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
        showAscii={serialViewConfig.showAscii}
        onToggleAscii={toggleShowAscii}
        onOpenIoReaderPicker={() => dialogs.ioReaderPicker.open()}
        onSave={openSaveDialog}
        onExport={() => dialogs.export.open()}
        onClear={handlers.handleClearDiscoveredFrames}
        onInfo={openInfoView}
        onOpenToolbox={() => dialogs.toolbox.open()}
      />

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden m-2">
        {isSerialMode ? (
          <SerialDiscoveryView
            isStreaming={isStreaming}
            displayTimeFormat={displayTimeFormat}
            isRecorded={isRecorded}
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
          />
        )}
      </div>

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
    </div>
  );
}
