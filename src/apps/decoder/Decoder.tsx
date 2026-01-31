// ui/src/apps/decoder/Decoder.tsx

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { useSettings, getDisplayFrameIdFormat } from "../../hooks/useSettings";
import { useDecoderStore } from "../../stores/decoderStore";
import { useIOSessionManager } from '../../hooks/useIOSessionManager';
import { useFocusStore } from '../../stores/focusStore';
import { listCatalogs, type CatalogMetadata } from "../../api/catalog";
import { clearBuffer } from "../../api/buffer";
import type { StreamEndedPayload, PlaybackPosition } from '../../api/io';
import AppLayout from "../../components/AppLayout";
import DecoderTopBar from "./views/DecoderTopBar";
import DecoderFramesView from "./views/DecoderFramesView";
import FramePickerDialog from "../../dialogs/FramePickerDialog";
import IoReaderPickerDialog from "../../dialogs/IoReaderPickerDialog";
import { getBufferMetadata, type BufferMetadata } from "../../api/buffer";
import SpeedPickerDialog from "../../dialogs/SpeedPickerDialog";
import CatalogPickerDialog from "./dialogs/CatalogPickerDialog";
import FlashNotification from "../../components/FlashNotification";
import BookmarkEditorDialog from "../../dialogs/BookmarkEditorDialog";
import SaveSelectionSetDialog from "../../dialogs/SaveSelectionSetDialog";
import SelectionSetPickerDialog from "../../dialogs/SelectionSetPickerDialog";
import FilterDialog from "./dialogs/FilterDialog";
import { WINDOW_EVENTS, type CatalogSavedPayload, type BufferChangedPayload } from "../../events/registry";
import { useDialogManager } from "../../hooks/useDialogManager";
import { useDecoderHandlers } from "./hooks/useDecoderHandlers";
import type { PlaybackSpeed, PlaybackState } from "../../components/TimeController";
import type { FrameMessage } from "../../types/frame";

export default function Decoder() {
  const { settings } = useSettings();
  const [catalogNotification, setCatalogNotification] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<CatalogMetadata[]>([]);
  const [activeBookmarkId, setActiveBookmarkId] = useState<string | null>(null);
  const [showTimeRange, setShowTimeRange] = useState(false);

  // Track if this panel is focused (for menu state reporting)
  const isFocused = useFocusStore((s) => s.focusedPanelId === "decoder");

  // Dialog visibility states managed by hook
  const dialogs = useDialogManager([
    'bookmarkPicker',
    'saveSelectionSet',
    'selectionSetPicker',
    'framePicker',
    'ioReaderPicker',
    'speedPicker',
    'catalogPicker',
    'filter',
  ] as const);
  const [bufferMetadata, setBufferMetadata] = useState<BufferMetadata | null>(null);

  // Active tab for per-tab clear functionality
  const [activeTab, setActiveTab] = useState<string>('signals');

  // Track when stream has completed to ignore stale time updates
  // Defined locally and passed to manager so it can reset it during watch operations
  const streamCompletedRef = useRef(false);

  // Ingest speed setting (for dialog display)
  const [ingestSpeed, setIngestSpeed] = useState(0); // 0 = no limit

  // Playback direction state (for buffer replay)
  const [playbackDirection, setPlaybackDirection] = useState<"forward" | "backward">("forward");

  // Zustand store selectors
  const catalogPath = useDecoderStore((state) => state.catalogPath);
  const frames = useDecoderStore((state) => state.frames);
  const selectedFrames = useDecoderStore((state) => state.selectedFrames);
  const ioProfile = useDecoderStore((state) => state.ioProfile);
  const decoded = useDecoderStore((state) => state.decoded);
  const startTime = useDecoderStore((state) => state.startTime);
  const endTime = useDecoderStore((state) => state.endTime);
  const currentTime = useDecoderStore((state) => state.currentTime);
  const currentFrameIndex = useDecoderStore((state) => state.currentFrameIndex);
  const showRawBytes = useDecoderStore((state) => state.showRawBytes);
  const activeSelectionSetId = useDecoderStore((state) => state.activeSelectionSetId);
  const selectionSetDirty = useDecoderStore((state) => state.selectionSetDirty);
  const playbackSpeed = useDecoderStore((state) => state.playbackSpeed);
  const serialConfig = useDecoderStore((state) => state.serialConfig);
  const protocol = useDecoderStore((state) => state.protocol);
  const viewMode = useDecoderStore((state) => state.viewMode);
  const hideUnseen = useDecoderStore((state) => state.hideUnseen);
  const streamStartTimeSeconds = useDecoderStore((state) => state.streamStartTimeSeconds);
  const decodedPerSource = useDecoderStore((state) => state.decodedPerSource);
  const unmatchedFrames = useDecoderStore((state) => state.unmatchedFrames);
  const filteredFrames = useDecoderStore((state) => state.filteredFrames);
  const headerFieldFilters = useDecoderStore((state) => state.headerFieldFilters);
  const seenHeaderFieldValues = useDecoderStore((state) => state.seenHeaderFieldValues);
  const showAsciiGutter = useDecoderStore((state) => state.showAsciiGutter);
  const frameIdFilter = useDecoderStore((state) => state.frameIdFilter);
  const frameIdFilterSet = useDecoderStore((state) => state.frameIdFilterSet);
  const mirrorValidation = useDecoderStore((state) => state.mirrorValidation);

  // Zustand store actions
  const initFromSettings = useDecoderStore((state) => state.initFromSettings);
  const toggleFrameSelection = useDecoderStore((state) => state.toggleFrameSelection);
  const bulkSelectBus = useDecoderStore((state) => state.bulkSelectBus);
  const selectAllFrames = useDecoderStore((state) => state.selectAllFrames);
  const deselectAllFrames = useDecoderStore((state) => state.deselectAllFrames);
  const decodeSignals = useDecoderStore((state) => state.decodeSignals);
  const setIoProfile = useDecoderStore((state) => state.setIoProfile);
  const updateCurrentTime = useDecoderStore((state) => state.updateCurrentTime);
  const setCurrentFrameIndex = useDecoderStore((state) => state.setCurrentFrameIndex);
  const loadCatalog = useDecoderStore((state) => state.loadCatalog);
  const setStartTime = useDecoderStore((state) => state.setStartTime);
  const setEndTime = useDecoderStore((state) => state.setEndTime);
  const toggleShowRawBytes = useDecoderStore((state) => state.toggleShowRawBytes);
  const setActiveSelectionSet = useDecoderStore((state) => state.setActiveSelectionSet);
  const setPlaybackSpeed = useDecoderStore((state) => state.setPlaybackSpeed);
  const setSelectionSetDirty = useDecoderStore((state) => state.setSelectionSetDirty);
  const applySelectionSet = useDecoderStore((state) => state.applySelectionSet);
  const clearFrames = useDecoderStore((state) => state.clearFrames);
  const clearDecoded = useDecoderStore((state) => state.clearDecoded);
  const clearUnmatchedFrames = useDecoderStore((state) => state.clearUnmatchedFrames);
  const clearFilteredFrames = useDecoderStore((state) => state.clearFilteredFrames);
  const toggleViewMode = useDecoderStore((state) => state.toggleViewMode);
  const toggleHideUnseen = useDecoderStore((state) => state.toggleHideUnseen);
  const addUnmatchedFrame = useDecoderStore((state) => state.addUnmatchedFrame);
  const addFilteredFrame = useDecoderStore((state) => state.addFilteredFrame);
  const setMinFrameLength = useDecoderStore((state) => state.setMinFrameLength);
  const toggleHeaderFieldFilter = useDecoderStore((state) => state.toggleHeaderFieldFilter);
  const clearHeaderFieldFilter = useDecoderStore((state) => state.clearHeaderFieldFilter);
  const toggleAsciiGutter = useDecoderStore((state) => state.toggleAsciiGutter);
  const setFrameIdFilter = useDecoderStore((state) => state.setFrameIdFilter);

  const displayIdFormat = getDisplayFrameIdFormat(settings || undefined);
  const displayTimeFormat = settings?.display_time_format ?? "human";
  const decoderDir = settings?.decoder_dir ?? "";

  // Batching: accumulate frames and flush to store at limited rate
  // We store all frames (not just latest per ID) to ensure mux cases aren't lost
  // Note: sessionStore also throttles frame delivery at 10Hz, this provides additional
  // batching for expensive decode/store operations within each callback
  const pendingFramesRef = useRef<Array<{ frameId: number; bytes: number[]; sourceAddress?: number; timestamp: number }>>([]);
  const pendingUnmatchedRef = useRef<Array<{ frameId: number; bytes: number[]; timestamp: number; sourceAddress?: number }>>([]);
  const pendingFilteredRef = useRef<Array<{ frameId: number; bytes: number[]; timestamp: number; sourceAddress?: number; reason: 'too_short' | 'id_filter' }>>([]);
  const pendingTimeRef = useRef<number | null>(null);
  const flushScheduledRef = useRef<boolean>(false);
  const UI_UPDATE_INTERVAL_MS = 100; // 10 updates per second

  // Use refs for store functions to avoid stale closures in setTimeout
  const decodeSignalsRef = useRef(decodeSignals);
  const updateCurrentTimeRef = useRef(updateCurrentTime);
  const selectedFramesRef = useRef(selectedFrames);
  const addUnmatchedFrameRef = useRef(addUnmatchedFrame);
  const addFilteredFrameRef = useRef(addFilteredFrame);
  const frameIdFilterSetRef = useRef(frameIdFilterSet);

  // Keep refs up to date
  useEffect(() => {
    decodeSignalsRef.current = decodeSignals;
  }, [decodeSignals]);
  useEffect(() => {
    updateCurrentTimeRef.current = updateCurrentTime;
  }, [updateCurrentTime]);
  useEffect(() => {
    selectedFramesRef.current = selectedFrames;
  }, [selectedFrames]);
  useEffect(() => {
    addUnmatchedFrameRef.current = addUnmatchedFrame;
  }, [addUnmatchedFrame]);
  useEffect(() => {
    addFilteredFrameRef.current = addFilteredFrame;
  }, [addFilteredFrame]);
  useEffect(() => {
    frameIdFilterSetRef.current = frameIdFilterSet;
  }, [frameIdFilterSet]);

  const flushPendingFrames = useCallback(() => {
    flushScheduledRef.current = false;

    // Update current time if we have one
    if (pendingTimeRef.current !== null) {
      updateCurrentTimeRef.current(pendingTimeRef.current);
      pendingTimeRef.current = null;
    }

    // Decode all pending frames (in order, so mux cases are processed correctly)
    const framesToDecode = pendingFramesRef.current;
    pendingFramesRef.current = [];

    for (const { frameId, bytes, sourceAddress, timestamp } of framesToDecode) {
      decodeSignalsRef.current(frameId, bytes, sourceAddress, timestamp);
    }

    // Add unmatched frames to store
    const unmatchedToAdd = pendingUnmatchedRef.current;
    pendingUnmatchedRef.current = [];

    for (const frame of unmatchedToAdd) {
      addUnmatchedFrameRef.current(frame);
    }

    // Add filtered frames to store
    const filteredToAdd = pendingFilteredRef.current;
    pendingFilteredRef.current = [];

    for (const frame of filteredToAdd) {
      addFilteredFrameRef.current(frame);
    }
  }, []);

  // Callbacks for reader session
  // Note: Watch frame counting is handled by useIOSessionManager
  const handleFrames = useCallback((receivedFrames: FrameMessage[]) => {
    if (!receivedFrames || receivedFrames.length === 0) return;

    // Update current time from the last frame with a timestamp (most recent)
    for (let i = receivedFrames.length - 1; i >= 0; i--) {
      if (receivedFrames[i].timestamp_us !== undefined) {
        pendingTimeRef.current = receivedFrames[i].timestamp_us! / 1_000_000; // Convert to seconds
        break;
      }
    }

    // Accumulate ALL frames to ensure mux cases aren't lost
    // Use ref for selectedFrames to avoid stale closure
    const currentSelectedFrames = selectedFramesRef.current;
    // Get state directly from store to avoid ref timing issues
    const storeState = useDecoderStore.getState();
    const catalogFrames = storeState.frames;
    const minFrameLength = storeState.serialConfig?.min_frame_length ?? 0;
    const idFilterSet = frameIdFilterSetRef.current;

    // Get frame_id_mask for catalog matching (from canConfig or serialConfig based on protocol)
    const currentProtocol = storeState.protocol;
    const frameIdMask = currentProtocol === 'can'
      ? storeState.canConfig?.frame_id_mask
      : storeState.serialConfig?.frame_id_mask;

    // Build a set of source frame IDs that need to be processed for mirror validation
    // (sources of selected mirror frames)
    const mirrorSourceMap = storeState.mirrorSourceMap;
    const sourceIdsForValidation = new Set<number>();
    for (const [mirrorId, sourceId] of mirrorSourceMap) {
      if (currentSelectedFrames.has(mirrorId)) {
        sourceIdsForValidation.add(sourceId);
      }
    }

    // Get frame ID extraction config from serialConfig for frontend re-extraction
    // This allows correct frame ID extraction even if catalog was loaded after streaming started
    const frameIdConfig = storeState.serialConfig;
    const hasFrameIdConfig = frameIdConfig?.frame_id_start_byte !== undefined && frameIdConfig?.frame_id_bytes !== undefined;

    for (const f of receivedFrames) {
      const timestamp = f.timestamp_us !== undefined ? f.timestamp_us / 1_000_000 : Date.now() / 1000;

      // Check if frame is too short (filtered by length)
      if (minFrameLength > 0 && f.bytes.length < minFrameLength) {
        pendingFilteredRef.current.push({ frameId: f.frame_id, bytes: f.bytes, timestamp, sourceAddress: f.source_address, reason: 'too_short' });
        continue;
      }

      // Extract frame ID from raw bytes using catalog config if available
      // This allows correct frame ID even if Rust session was started without config
      let frameId = f.frame_id;
      if (hasFrameIdConfig && f.bytes.length > 0) {
        const startByte = frameIdConfig.frame_id_start_byte!;
        const numBytes = frameIdConfig.frame_id_bytes!;
        const bigEndian = frameIdConfig.frame_id_byte_order === 'big';

        // Extract frame ID from bytes
        if (startByte >= 0 && startByte + numBytes <= f.bytes.length) {
          let extractedId = 0;
          if (bigEndian) {
            for (let i = 0; i < numBytes; i++) {
              extractedId = (extractedId << 8) | f.bytes[startByte + i];
            }
          } else {
            for (let i = numBytes - 1; i >= 0; i--) {
              extractedId = (extractedId << 8) | f.bytes[startByte + i];
            }
          }
          frameId = extractedId;
        }
      }

      // Check if frame ID matches the filter (if filter is set, matching IDs go to Filtered tab)
      if (idFilterSet !== null && idFilterSet.has(frameId)) {
        pendingFilteredRef.current.push({ frameId, bytes: f.bytes, timestamp, sourceAddress: f.source_address, reason: 'id_filter' });
        continue;
      }

      // Apply frame_id_mask before catalog lookup (same as decodeSignals does)
      const maskedFrameId = frameIdMask !== undefined ? (frameId & frameIdMask) : frameId;

      // Check if frame exists in catalog (using masked ID)
      if (catalogFrames.has(maskedFrameId)) {
        // Frame exists in catalog - decode if selected (check both raw and masked IDs)
        // Also process source frames for mirror validation even if not selected
        const isSelected = currentSelectedFrames.has(maskedFrameId) || currentSelectedFrames.has(frameId);
        const isSourceForSelectedMirror = sourceIdsForValidation.has(maskedFrameId);
        if (isSelected || isSourceForSelectedMirror) {
          pendingFramesRef.current.push({ frameId, bytes: f.bytes, sourceAddress: f.source_address, timestamp });
        }
      } else {
        // Frame not in catalog - add to unmatched
        pendingUnmatchedRef.current.push({
          frameId,
          bytes: f.bytes,
          timestamp,
          sourceAddress: f.source_address,
        });
      }
    }

    // Schedule a flush if not already scheduled
    if (!flushScheduledRef.current) {
      flushScheduledRef.current = true;
      setTimeout(flushPendingFrames, UI_UPDATE_INTERVAL_MS);
    }
  }, [flushPendingFrames]);

  const handleError = useCallback((error: string) => {
    console.error("Decoder stream error:", error);
  }, []);

  const handleTimeUpdate = useCallback((position: PlaybackPosition) => {
    // Ignore time updates after stream has completed (prevents overwriting reset position)
    if (streamCompletedRef.current) return;
    updateCurrentTime(position.timestamp_us / 1_000_000); // Convert to seconds
    setCurrentFrameIndex(position.frame_index);
  }, [updateCurrentTime, setCurrentFrameIndex]);

  // Handle speed changes from other windows sharing this session
  const handleSessionSpeedChange = useCallback((speed: number) => {
    setPlaybackSpeed(speed as PlaybackSpeed);
  }, [setPlaybackSpeed]);

  // State to trigger buffer transition after stream ends
  const [pendingBufferTransition, setPendingBufferTransition] = useState(false);

  // Handle stream ended - update buffer metadata and trigger transition if needed
  const handleStreamEnded = useCallback(async (payload: StreamEndedPayload) => {
    // Update buffer metadata
    if (payload.buffer_available) {
      const meta = await getBufferMetadata();
      setBufferMetadata(meta);

      // Notify other windows about the buffer change
      if (meta) {
        await emit(WINDOW_EVENTS.BUFFER_CHANGED, {
          metadata: meta,
          action: "stream-ended",
        });
      }

      // Only auto-transition to buffer replay if stream completed naturally
      // Don't transition if user manually stopped (reason === "stopped")
      if (payload.reason === "complete") {
        setPendingBufferTransition(true);
      }
    }
  }, []);

  // Ref for bufferMetadata to avoid stale closures in callbacks
  const bufferMetadataRef = useRef(bufferMetadata);
  useEffect(() => {
    bufferMetadataRef.current = bufferMetadata;
  }, [bufferMetadata]);

  // Handle buffer playback completion - reset slider to start
  const handleStreamComplete = useCallback(() => {
    // Mark stream as completed to ignore any stale time updates
    streamCompletedRef.current = true;
    // Reset current time to the start of the buffer
    const meta = bufferMetadataRef.current;
    if (meta?.start_time_us != null) {
      updateCurrentTime(meta.start_time_us / 1_000_000);
    }
  }, [updateCurrentTime]);

  // Ingest complete handler - passed to useIOSessionManager
  const handleIngestComplete = useCallback(async (payload: StreamEndedPayload) => {
    if (payload.buffer_available && payload.count > 0) {
      // Get the updated buffer metadata
      const meta = await getBufferMetadata();
      if (meta) {
        setBufferMetadata(meta);

        // Notify other windows about the buffer change
        await emit(WINDOW_EVENTS.BUFFER_CHANGED, {
          metadata: meta,
          action: "ingested",
        });

        // Close the dialog and transition to buffer replay mode
        dialogs.ioReaderPicker.close();
        setPendingBufferTransition(true);
      }
    }
  }, [dialogs.ioReaderPicker]);

  // Use the IO session manager hook - manages session lifecycle, ingest, multi-bus, and derived state
  const manager = useIOSessionManager({
    appName: "decoder",
    ioProfiles: settings?.io_profiles ?? [],
    store: { ioProfile, setIoProfile },
    enableIngest: true,
    onBeforeIngestStart: clearBuffer,
    onIngestComplete: handleIngestComplete,
    requireFrames: true,
    onFrames: handleFrames,
    onError: handleError,
    onTimeUpdate: handleTimeUpdate,
    onStreamEnded: handleStreamEnded,
    onStreamComplete: handleStreamComplete,
    onSpeedChange: handleSessionSpeedChange,
    // Session switching callbacks
    setPlaybackSpeed: setPlaybackSpeed as (speed: number) => void,
    onBeforeWatch: clearFrames,
    onBeforeMultiWatch: clearFrames,
    streamCompletedRef,
  });

  // Destructure everything from the manager
  const {
    // Multi-bus state
    multiBusMode,
    multiBusProfiles: ioProfiles,
    // Session
    session,
    // Profile name (for menu display)
    ioProfileName,
    // Derived state
    isStreaming,
    isPaused,
    isStopped,
    isRealtime,
    isBufferMode,
    capabilities,
    joinerCount,
    // Detach/rejoin
    isDetached,
    handleDetach,
    handleRejoin,
    // Watch state
    watchFrameCount,
    isWatching,
    // Ingest state
    isIngesting,
    ingestProfileId,
    ingestFrameCount,
    ingestError,
    startIngest,
    stopIngest,
    // Session switching methods
    watchSingleSource,
    watchMultiSource,
    stopWatch,
    selectProfile,
    selectMultipleProfiles,
    joinSession,
    skipReader,
    // Note: streamCompletedRef is created locally and passed to manager via options
  } = manager;

  // Session controls from the underlying session
  const {
    sessionId,
    state: readerState,
    isReady,
    bufferAvailable,
    start,
    stop,
    pause,
    resume,
    setSpeed,
    setTimeRange,
    seek,
    switchToBufferReplay,
    reinitialize,
  } = session;

  // Derive decoding state - include "starting" to prevent race conditions
  // Use isStreaming from manager plus check for "starting" state
  const isDecoding = isStreaming || readerState === "starting";
  // Has buffer data available for replay - only relevant when in buffer mode
  const hasBufferData = isBufferMode && (bufferAvailable || (bufferMetadata?.count ?? 0) > 0);

  // Use the orchestrator hook for all handlers
  const handlers = useDecoderHandlers({
    // Session actions (low-level, for buffer reinitialize and playback)
    reinitialize,
    start,
    stop,
    pause,
    resume,
    setSpeed,
    setTimeRange,
    seek,

    // Reader state
    sessionId,
    isPaused,
    isStreaming,
    sessionReady: isReady,
    capabilities,
    currentFrameIndex,
    currentTimestampUs: currentTime !== null ? currentTime * 1_000_000 : null,

    // Store actions (decoder)
    setPlaybackSpeed,
    setStartTime,
    setEndTime,
    updateCurrentTime,
    setCurrentFrameIndex,
    loadCatalog,
    clearDecoded,
    clearUnmatchedFrames,
    clearFilteredFrames,
    setActiveSelectionSet,
    setSelectionSetDirty,
    applySelectionSet,

    // Store state (decoder)
    frames,
    selectedFrames,
    activeSelectionSetId,
    selectionSetDirty,
    startTime,
    endTime,
    playbackSpeed,
    ioProfile,
    // Note: serialConfig is read directly from store in session handlers to avoid stale closures

    // Ingest session
    startIngest,
    stopIngest,
    isIngesting,

    // Watch state (read-only, from manager)
    isWatching,

    // Stream completed ref (from manager, for playback handlers)
    streamCompletedRef,

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
    skipReader,

    // Ingest speed
    ingestSpeed,
    setIngestSpeed,

    // Dialog controls
    closeIoReaderPicker: dialogs.ioReaderPicker.close,
    openSaveSelectionSet: dialogs.saveSelectionSet.open,

    // Active tab
    activeTab,

    // Bookmark state
    setActiveBookmarkId,

    // Buffer state
    setBufferMetadata,

    // Buffer bounds for frame index calculation during scrub
    minTimeUs: bufferMetadata?.start_time_us,
    maxTimeUs: bufferMetadata?.end_time_us,
    totalFrames: bufferMetadata?.count,
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
          if (targetPanelId !== "decoder") return;

          switch (action) {
            case "play":
              if (isPaused) {
                resume();
              } else if (isStopped && isReady) {
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
              handlers.handleClear();
              break;
            case "picker":
              dialogs.ioReaderPicker.open();
              break;
          }
        }
      );

      return () => {
        unlistenControl();
      };
    };

    const cleanup = setupListeners();
    return () => {
      cleanup.then((fn) => fn());
    };
  }, [isPaused, isStopped, isStreaming, isReady, resume, start, pause, stopWatch, handlers, dialogs]);

  // Note: Watch state is cleared automatically by useIOSessionManager when streaming stops

  // Effect to handle auto-transition to buffer replay after stream ends
  useEffect(() => {
    if (pendingBufferTransition && !isDecoding) {
      setPendingBufferTransition(false);
      // Transition to buffer replay mode
      switchToBufferReplay(playbackSpeed).then(async () => {
        // Refresh buffer metadata after transition
        const meta = await getBufferMetadata();
        setBufferMetadata(meta);
        // Use the actual buffer ID for unique session naming
        if (meta) {
          setIoProfile(meta.id);
        }
        // Reset time slider and frame index to start of buffer
        if (meta?.start_time_us != null) {
          updateCurrentTime(meta.start_time_us / 1_000_000);
        }
        setCurrentFrameIndex(0);
      }).catch((e) => console.error("Failed to switch to buffer replay:", e));
    }
  }, [pendingBufferTransition, isDecoding, switchToBufferReplay, playbackSpeed, setIoProfile, updateCurrentTime, setCurrentFrameIndex]);

  // Flush any pending frames when decoding stops to ensure nothing is lost
  useEffect(() => {
    if (!isDecoding && pendingFramesRef.current.length > 0) {
      flushPendingFrames();
    }
  }, [isDecoding, flushPendingFrames]);

  // For realtime sources, update clock every second while decoding
  const [realtimeClock, setRealtimeClock] = useState<number | null>(null);
  useEffect(() => {
    if (!isDecoding || !isRealtime) {
      setRealtimeClock(null);
      return;
    }
    // Update immediately and then every second
    setRealtimeClock(Date.now() / 1000);
    const interval = setInterval(() => {
      setRealtimeClock(Date.now() / 1000);
    }, 1000);
    return () => clearInterval(interval);
  }, [isDecoding, isRealtime]);

  // Display time: use stored currentTime for non-realtime, realtimeClock for realtime
  const displayTime = isRealtime ? realtimeClock : currentTime;

  // Initialize decoder when settings are loaded
  useEffect(() => {
    if (!settings) return;

    const init = async () => {
      await initFromSettings(
        settings.default_catalog ?? undefined,
        settings.decoder_dir,
        settings.default_read_profile
      );

      // Set default speed from the default read profile if it has one
      if (settings.default_read_profile && settings.io_profiles) {
        const profile = settings.io_profiles.find((p) => p.id === settings.default_read_profile);
        if (profile?.connection?.default_speed) {
          const defaultSpeed = parseFloat(profile.connection.default_speed) as PlaybackSpeed;
          setPlaybackSpeed(defaultSpeed);
        }
      }
    };
    init().catch((e) => console.error("Failed to init decoder", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Load buffer metadata on mount (in case data was imported in another app)
  useEffect(() => {
    getBufferMetadata()
      .then((meta) => setBufferMetadata(meta))
      .catch((e) => console.error("Failed to get buffer metadata:", e));
  }, []);

  // Listen for buffer changes from other windows
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen<BufferChangedPayload>(
        WINDOW_EVENTS.BUFFER_CHANGED,
        (event) => {
          setBufferMetadata(event.payload.metadata);
        }
      );
      return unlisten;
    };

    const unlistenPromise = setupListener();
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Load catalog list when decoder dir changes
  useEffect(() => {
    if (!decoderDir) return;

    const loadCatalogList = async () => {
      try {
        const list = await listCatalogs(decoderDir);
        setCatalogs(list);
      } catch (e) {
        console.error("Failed to load catalog list:", e);
      }
    };
    loadCatalogList();
  }, [decoderDir]);

  // Listen for catalog-saved events for inter-window communication
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen<CatalogSavedPayload>(
        WINDOW_EVENTS.CATALOG_SAVED,
        async (event) => {
          const { catalogPath: savedPath } = event.payload;

          // Refresh catalog list
          if (decoderDir) {
            try {
              const list = await listCatalogs(decoderDir);
              setCatalogs(list);
            } catch (e) {
              console.error("Failed to refresh catalog list:", e);
            }
          }

          // Only reload if this decoder is using that catalog
          if (catalogPath && savedPath === catalogPath) {
            setCatalogNotification('Catalog updated');
            try {
              await loadCatalog(savedPath);
            } catch (error) {
              console.error('Failed to reload catalog:', error);
            }
            setTimeout(() => setCatalogNotification(null), 2000);
          }
        }
      );

      return unlisten;
    };

    const unlistenPromise = setupListener();

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [catalogPath, loadCatalog, decoderDir]);

  // Clear frames when catalog's frame ID config changes while streaming.
  // The frontend now extracts frame IDs from raw bytes using the catalog config,
  // so we don't need to restart the session - just clear old frames that had wrong IDs.
  const prevSerialConfigRef = useRef(serialConfig);
  useEffect(() => {
    const prevConfig = prevSerialConfigRef.current;
    prevSerialConfigRef.current = serialConfig;

    // Check if frame ID extraction config has changed
    const frameIdConfigChanged =
      prevConfig?.frame_id_start_byte !== serialConfig?.frame_id_start_byte ||
      prevConfig?.frame_id_bytes !== serialConfig?.frame_id_bytes ||
      prevConfig?.frame_id_byte_order !== serialConfig?.frame_id_byte_order ||
      prevConfig?.frame_id_mask !== serialConfig?.frame_id_mask;

    const hasFrameIdConfig = serialConfig?.frame_id_start_byte !== undefined || serialConfig?.frame_id_bytes !== undefined;

    // When frame ID config changes while streaming, clear old frames (they have wrong IDs)
    // New frames will be processed correctly by handleFrames using the catalog config
    if (isStreaming && frameIdConfigChanged && hasFrameIdConfig) {
      console.log('[Decoder] Serial config changed while streaming, clearing frames for re-extraction');
      clearFrames();
      clearUnmatchedFrames();
    }
  }, [serialConfig, isStreaming, clearFrames, clearUnmatchedFrames]);

  // Window close is handled by Rust (lib.rs on_window_event) to prevent crashes
  // on macOS 26.2+ (Tahoe). The Rust handler stops the session and waits for
  // WebKit to settle before destroying the window.

  const frameList = useMemo(
    () => Array.from(frames.values()).sort((a, b) => a.id - b.id),
    [frames]
  );

  // Convert reader state to TimeController state
  const getPlaybackState = (): PlaybackState => {
    if (readerState === "running") return "playing";
    return "paused";
  };

  return (
    <AppLayout
      topBar={
        <>
          {catalogNotification && (
            <FlashNotification
              message={catalogNotification}
              type="info"
              duration={2000}
              onDismiss={() => setCatalogNotification(null)}
            />
          )}
          <DecoderTopBar
            catalogs={catalogs}
            catalogPath={catalogPath}
            onCatalogChange={handlers.handleCatalogChange}
            defaultCatalogFilename={settings?.default_catalog}
            ioProfiles={settings?.io_profiles || []}
            ioProfile={ioProfile}
            onIoProfileChange={handlers.handleIoProfileChange}
            defaultReadProfileId={settings?.default_read_profile}
            bufferMetadata={bufferMetadata}
            multiBusMode={multiBusMode}
            multiBusProfiles={ioProfiles}
            speed={playbackSpeed}
            supportsSpeed={capabilities?.supports_speed_control ?? false}
            isStreaming={isDecoding || isIngesting}
            onStopStream={isDecoding ? handlers.handleStopWatch : stopIngest}
            isStopped={isStopped}
            onResume={start}
            joinerCount={joinerCount}
            onDetach={handlers.handleDetach}
            isDetached={isDetached}
            onRejoin={handlers.handleRejoin}
            supportsTimeRange={capabilities?.supports_time_range ?? false}
            onOpenBookmarkPicker={() => dialogs.bookmarkPicker.open()}
            frameCount={frameList.length}
            selectedFrameCount={selectedFrames.size}
            onOpenFramePicker={() => dialogs.framePicker.open()}
            onOpenIoReaderPicker={() => dialogs.ioReaderPicker.open()}
            onOpenSpeedPicker={() => dialogs.speedPicker.open()}
            onOpenCatalogPicker={() => dialogs.catalogPicker.open()}
            showRawBytes={showRawBytes}
            onToggleRawBytes={toggleShowRawBytes}
            onClear={handlers.handleClear}
            viewMode={viewMode}
            onToggleViewMode={toggleViewMode}
            minFrameLength={serialConfig?.min_frame_length ?? 0}
            onOpenFilterDialog={() => dialogs.filter.open()}
            hideUnseen={hideUnseen}
            onToggleHideUnseen={toggleHideUnseen}
            showAsciiGutter={showAsciiGutter}
            onToggleAsciiGutter={toggleAsciiGutter}
            frameIdFilter={frameIdFilter}
          />
        </>
      }
    >
        <DecoderFramesView
          frames={frameList}
          selectedIds={selectedFrames}
          decoded={decoded}
          decodedPerSource={decodedPerSource}
          viewMode={viewMode}
          displayFrameIdFormat={displayIdFormat}
          isDecoding={isDecoding}
          showRawBytes={showRawBytes}
          onToggleRawBytes={toggleShowRawBytes}
          timestamp={isDecoding ? displayTime : null}
          protocol={protocol}
          serialConfig={serialConfig}
          unmatchedFrames={unmatchedFrames}
          filteredFrames={filteredFrames}
          isReady={isReady}
          playbackState={getPlaybackState()}
          playbackDirection={playbackDirection}
          capabilities={capabilities}
          onPlay={() => { setPlaybackDirection("forward"); handlers.handlePlay(); }}
          onPlayBackward={() => { setPlaybackDirection("backward"); handlers.handlePlayBackward(); }}
          onPause={handlers.handlePause}
          onStepBackward={handlers.handleStepBackward}
          onStepForward={handlers.handleStepForward}
          playbackSpeed={playbackSpeed}
          onSpeedChange={handlers.handleSpeedChange}
          hasBufferData={hasBufferData}
          activeBookmarkId={activeBookmarkId}
          onOpenBookmarkPicker={() => dialogs.bookmarkPicker.open()}
          showTimeRange={showTimeRange}
          onToggleTimeRange={() => setShowTimeRange(!showTimeRange)}
          startTime={startTime}
          endTime={endTime}
          onStartTimeChange={handlers.handleStartTimeChange}
          onEndTimeChange={handlers.handleEndTimeChange}
          minTimeUs={bufferMetadata?.start_time_us}
          maxTimeUs={bufferMetadata?.end_time_us}
          currentTimeUs={currentTime !== null ? currentTime * 1_000_000 : null}
          currentFrameIndex={currentFrameIndex}
          totalFrames={bufferMetadata?.count}
          onScrub={handlers.handleScrub}
          signalColours={{
            none: settings?.signal_colour_none,
            low: settings?.signal_colour_low,
            medium: settings?.signal_colour_medium,
            high: settings?.signal_colour_high,
          }}
          headerFieldFilters={headerFieldFilters}
          onToggleHeaderFieldFilter={toggleHeaderFieldFilter}
          onClearHeaderFieldFilter={clearHeaderFieldFilter}
          seenHeaderFieldValues={seenHeaderFieldValues}
          hideUnseen={hideUnseen}
          displayTimeFormat={displayTimeFormat}
          streamStartTimeSeconds={streamStartTimeSeconds}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          showAsciiGutter={showAsciiGutter}
          frameIdFilter={frameIdFilter}
          mirrorValidation={mirrorValidation}
        />

      <FramePickerDialog
        isOpen={dialogs.framePicker.isOpen}
        onClose={() => dialogs.framePicker.close()}
        frames={frameList}
        selectedFrames={selectedFrames}
        onToggleFrame={toggleFrameSelection}
        onBulkSelect={bulkSelectBus}
        displayFrameIdFormat={displayIdFormat}
        onSelectAll={selectAllFrames}
        onDeselectAll={deselectAllFrames}
        activeSelectionSetId={activeSelectionSetId}
        selectionSetDirty={selectionSetDirty}
        onSaveSelectionSet={handlers.handleSaveSelectionSet}
        onOpenSelectionSetPicker={() => dialogs.selectionSetPicker.open()}
      />

      <IoReaderPickerDialog
        isOpen={dialogs.ioReaderPicker.isOpen}
        onClose={() => dialogs.ioReaderPicker.close()}
        ioProfiles={settings?.io_profiles || []}
        selectedId={ioProfile}
        selectedIds={multiBusMode ? ioProfiles : []}
        defaultId={settings?.default_read_profile}
        onSelect={handlers.handleIoProfileChange}
        onSelectMultiple={handlers.handleSelectMultiple}
        onImport={(meta) => setBufferMetadata(meta)}
        bufferMetadata={bufferMetadata}
        defaultDir={settings?.dump_dir}
        isIngesting={isIngesting || isWatching}
        ingestProfileId={isIngesting ? ingestProfileId : (isWatching ? ioProfile : null)}
        ingestFrameCount={isIngesting ? ingestFrameCount : watchFrameCount}
        ingestSpeed={ingestSpeed}
        onIngestSpeedChange={(speed) => setIngestSpeed(speed)}
        onStartIngest={handlers.handleDialogStartIngest}
        onStartMultiIngest={handlers.handleDialogStartMultiIngest}
        onStopIngest={handlers.handleDialogStopIngest}
        ingestError={ingestError}
        onJoinSession={handlers.handleJoinSession}
        onSkip={handlers.handleSkip}
        allowMultiSelect={true}
      />

      <SpeedPickerDialog
        isOpen={dialogs.speedPicker.isOpen}
        onClose={() => dialogs.speedPicker.close()}
        speed={playbackSpeed}
        onSpeedChange={handlers.handleSpeedChange}
      />

      <CatalogPickerDialog
        isOpen={dialogs.catalogPicker.isOpen}
        onClose={() => dialogs.catalogPicker.close()}
        catalogs={catalogs}
        selectedPath={catalogPath}
        defaultFilename={settings?.default_catalog}
        onSelect={handlers.handleCatalogChange}
      />

      <BookmarkEditorDialog
        isOpen={dialogs.bookmarkPicker.isOpen}
        onClose={() => dialogs.bookmarkPicker.close()}
        onLoad={handlers.handleLoadBookmark}
        profileId={ioProfile}
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

      <FilterDialog
        isOpen={dialogs.filter.isOpen}
        onClose={() => dialogs.filter.close()}
        minFrameLength={serialConfig?.min_frame_length ?? 0}
        frameIdFilter={frameIdFilter}
        onSave={(minLength, idFilter) => {
          setMinFrameLength(minLength);
          setFrameIdFilter(idFilter);
        }}
      />
    </AppLayout>
  );
}
