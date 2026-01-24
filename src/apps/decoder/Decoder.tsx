// ui/src/apps/decoder/Decoder.tsx

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { useSettings, getDisplayFrameIdFormat } from "../../hooks/useSettings";
import { useDecoderStore } from "../../stores/decoderStore";
import { useIOSession } from '../../hooks/useIOSession';
import { listCatalogs, type CatalogMetadata } from "../../api/catalog";
import { useIngestSession, type StreamEndedPayload } from '../../hooks/useIngestSession';
import { useMultiBusState } from '../../stores/sessionStore';
import { clearBuffer } from "../../api/buffer";
import DecoderTopBar from "./views/DecoderTopBar";
import DecoderFramesView from "./views/DecoderFramesView";
import FramePickerDialog from "../../dialogs/FramePickerDialog";
import IoReaderPickerDialog, { BUFFER_PROFILE_ID } from "../../dialogs/IoReaderPickerDialog";
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

  // Watch mode state - uses decoder session for real-time display while buffering
  const [isWatching, setIsWatching] = useState(false);
  const [watchFrameCount, setWatchFrameCount] = useState(0);

  // Track if we've detached from a session (but profile still selected)
  const [isDetached, setIsDetached] = useState(false);

  // Active tab for per-tab clear functionality
  const [activeTab, setActiveTab] = useState<string>('signals');

  // Track when stream has completed to ignore stale time updates
  const streamCompletedRef = useRef(false);

  // Ingest speed setting (for dialog display)
  const [ingestSpeed, setIngestSpeed] = useState(0); // 0 = no limit

  // Ref to hold the ingest complete handler (set after useIOSession provides reinitialize)
  const ingestCompleteRef = useRef<((payload: import("../../hooks/useIngestSession").StreamEndedPayload) => Promise<void>) | undefined>(undefined);

  // Ingest session hook - handles event listeners, session lifecycle, error handling
  // Uses ref-based callback to avoid dependency on reinitialize (defined later)
  const {
    isIngesting,
    ingestProfileId,
    ingestFrameCount,
    ingestError,
    startIngest,
    stopIngest,
  } = useIngestSession({
    onComplete: async (payload) => {
      if (ingestCompleteRef.current) {
        await ingestCompleteRef.current(payload);
      }
    },
    onBeforeStart: clearBuffer,
  });

  // Zustand store selectors
  const catalogPath = useDecoderStore((state) => state.catalogPath);
  const frames = useDecoderStore((state) => state.frames);
  const selectedFrames = useDecoderStore((state) => state.selectedFrames);
  const ioProfile = useDecoderStore((state) => state.ioProfile);
  const decoded = useDecoderStore((state) => state.decoded);
  const startTime = useDecoderStore((state) => state.startTime);
  const endTime = useDecoderStore((state) => state.endTime);
  const currentTime = useDecoderStore((state) => state.currentTime);
  const showRawBytes = useDecoderStore((state) => state.showRawBytes);
  const activeSelectionSetId = useDecoderStore((state) => state.activeSelectionSetId);
  const selectionSetDirty = useDecoderStore((state) => state.selectionSetDirty);
  const playbackSpeed = useDecoderStore((state) => state.playbackSpeed);
  const serialConfig = useDecoderStore((state) => state.serialConfig);
  const canConfig = useDecoderStore((state) => state.canConfig);
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

  // Multi-bus mode state from session store (centralized)
  const {
    multiBusMode,
    multiBusProfiles: ioProfiles,
    setMultiBusMode,
    setMultiBusProfiles: setIoProfiles,
  } = useMultiBusState();

  // Zustand store actions
  const initFromSettings = useDecoderStore((state) => state.initFromSettings);
  const toggleFrameSelection = useDecoderStore((state) => state.toggleFrameSelection);
  const bulkSelectBus = useDecoderStore((state) => state.bulkSelectBus);
  const selectAllFrames = useDecoderStore((state) => state.selectAllFrames);
  const deselectAllFrames = useDecoderStore((state) => state.deselectAllFrames);
  const decodeSignals = useDecoderStore((state) => state.decodeSignals);
  const setIoProfile = useDecoderStore((state) => state.setIoProfile);
  const updateCurrentTime = useDecoderStore((state) => state.updateCurrentTime);
  const loadCatalog = useDecoderStore((state) => state.loadCatalog);
  const setStartTime = useDecoderStore((state) => state.setStartTime);
  const setEndTime = useDecoderStore((state) => state.setEndTime);
  const toggleShowRawBytes = useDecoderStore((state) => state.toggleShowRawBytes);
  const setActiveSelectionSet = useDecoderStore((state) => state.setActiveSelectionSet);
  const setPlaybackSpeed = useDecoderStore((state) => state.setPlaybackSpeed);
  const setSelectionSetDirty = useDecoderStore((state) => state.setSelectionSetDirty);
  const applySelectionSet = useDecoderStore((state) => state.applySelectionSet);
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
  const pendingFramesRef = useRef<Array<{ frameId: number; bytes: number[]; sourceAddress?: number }>>([]);
  const pendingUnmatchedRef = useRef<Array<{ frameId: number; bytes: number[]; timestamp: number; sourceAddress?: number }>>([]);
  const pendingFilteredRef = useRef<Array<{ frameId: number; bytes: number[]; timestamp: number; sourceAddress?: number; reason: 'too_short' | 'id_filter' }>>([]);
  const pendingTimeRef = useRef<number | null>(null);
  const flushScheduledRef = useRef<boolean>(false);
  const UI_UPDATE_INTERVAL_MS = 100; // 10 updates per second

  // Use refs for store functions to avoid stale closures in setTimeout
  const decodeSignalsRef = useRef(decodeSignals);
  const updateCurrentTimeRef = useRef(updateCurrentTime);
  const selectedFramesRef = useRef(selectedFrames);
  const framesRef = useRef(frames);
  const addUnmatchedFrameRef = useRef(addUnmatchedFrame);
  const addFilteredFrameRef = useRef(addFilteredFrame);
  const serialConfigRef = useRef(serialConfig);
  const canConfigRef = useRef(canConfig);
  const protocolRef = useRef(protocol);
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
    framesRef.current = frames;
  }, [frames]);
  useEffect(() => {
    addUnmatchedFrameRef.current = addUnmatchedFrame;
  }, [addUnmatchedFrame]);
  useEffect(() => {
    addFilteredFrameRef.current = addFilteredFrame;
  }, [addFilteredFrame]);
  useEffect(() => {
    serialConfigRef.current = serialConfig;
  }, [serialConfig]);
  useEffect(() => {
    canConfigRef.current = canConfig;
  }, [canConfig]);
  useEffect(() => {
    protocolRef.current = protocol;
  }, [protocol]);
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

    for (const { frameId, bytes, sourceAddress } of framesToDecode) {
      decodeSignalsRef.current(frameId, bytes, sourceAddress);
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

  // Ref for watch state to avoid stale closures
  const isWatchingRef = useRef(isWatching);
  useEffect(() => {
    isWatchingRef.current = isWatching;
  }, [isWatching]);

  // Callbacks for reader session
  const handleFrames = useCallback((receivedFrames: FrameMessage[]) => {
    if (!receivedFrames || receivedFrames.length === 0) return;

    // Update watch frame count if in watch mode
    if (isWatchingRef.current) {
      setWatchFrameCount((prev) => prev + receivedFrames.length);
    }

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
    const catalogFrames = framesRef.current;
    const minFrameLength = serialConfigRef.current?.min_frame_length ?? 0;
    const idFilterSet = frameIdFilterSetRef.current;

    // Get frame_id_mask for catalog matching (from canConfig or serialConfig based on protocol)
    const currentProtocol = protocolRef.current;
    const frameIdMask = currentProtocol === 'can'
      ? canConfigRef.current?.frame_id_mask
      : serialConfigRef.current?.frame_id_mask;

    for (const f of receivedFrames) {
      const timestamp = f.timestamp_us !== undefined ? f.timestamp_us / 1_000_000 : Date.now() / 1000;

      // Check if frame is too short (filtered by length)
      if (minFrameLength > 0 && f.bytes.length < minFrameLength) {
        pendingFilteredRef.current.push({ frameId: f.frame_id, bytes: f.bytes, timestamp, sourceAddress: f.source_address, reason: 'too_short' });
        continue;
      }

      // Check if frame ID matches the filter (if filter is set, matching IDs go to Filtered tab)
      if (idFilterSet !== null && idFilterSet.has(f.frame_id)) {
        pendingFilteredRef.current.push({ frameId: f.frame_id, bytes: f.bytes, timestamp, sourceAddress: f.source_address, reason: 'id_filter' });
        continue;
      }

      // Apply frame_id_mask before catalog lookup (same as decodeSignals does)
      const maskedFrameId = frameIdMask !== undefined ? (f.frame_id & frameIdMask) : f.frame_id;

      // Check if frame exists in catalog (using masked ID)
      if (catalogFrames.has(maskedFrameId)) {
        // Frame exists in catalog - decode if selected (check both raw and masked IDs)
        if (currentSelectedFrames.has(maskedFrameId) || currentSelectedFrames.has(f.frame_id)) {
          pendingFramesRef.current.push({ frameId: f.frame_id, bytes: f.bytes, sourceAddress: f.source_address });
        }
      } else {
        // Frame not in catalog - add to unmatched
        pendingUnmatchedRef.current.push({
          frameId: f.frame_id,
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

  const handleTimeUpdate = useCallback((timeUs: number) => {
    // Ignore time updates after stream has completed (prevents overwriting reset position)
    if (streamCompletedRef.current) return;
    updateCurrentTime(timeUs / 1_000_000); // Convert to seconds
  }, [updateCurrentTime]);

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

  // Use the single-profile reader session hook (when not in multi-bus mode)
  const singleSession = useIOSession({
    appName: "decoder",
    sessionId: !multiBusMode ? (ioProfile || undefined) : undefined, // Only active when not in multi-bus mode
    profileName: ioProfileName, // Pass friendly name for session dropdown display
    requireFrames: true, // Only join sessions that produce frames (not raw bytes)
    onFrames: handleFrames,
    onError: handleError,
    onTimeUpdate: handleTimeUpdate,
    onStreamEnded: handleStreamEnded,
    onStreamComplete: handleStreamComplete,
    onSpeedChange: handleSessionSpeedChange,
  });

  // Extract session state and controls
  // Both single-source and multi-source sessions are now accessed via useIOSession
  // (multi-source sessions use a merged session ID like "decoder-multi")
  const {
    capabilities,
    state: readerState,
    isReady,
    bufferAvailable,
    joinerCount,
    start,
    stop,
    leave,
    pause,
    resume,
    setSpeed,
    setTimeRange,
    seek,
    switchToBufferReplay,
    rejoin,
    reinitialize,
  } = singleSession;

  // Set up the ingest complete handler now that reinitialize is available
  ingestCompleteRef.current = async (payload: StreamEndedPayload) => {
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
  };

  // Derive decoding state from reader state
  // Include "starting" to prevent race conditions where isWatching gets cleared
  // When detached, we're no longer "decoding" from the UI perspective (IO picker should be available)
  const isDecoding = !isDetached && (readerState === "running" || readerState === "paused" || readerState === "starting");
  const isPaused = readerState === "paused";
  // Session is "stopped" when it has a non-buffer profile selected but isn't streaming
  const isStopped = !isDetached && readerState === "stopped" && ioProfile !== null && ioProfile !== BUFFER_PROFILE_ID;
  // Only consider realtime if capabilities explicitly say so (default false when unknown)
  const isRealtime = capabilities?.is_realtime === true;
  // Check if we're in buffer mode
  const isBufferMode = ioProfile === BUFFER_PROFILE_ID;
  // Has buffer data available for replay - only relevant when in buffer mode
  const hasBufferData = isBufferMode && (bufferAvailable || (bufferMetadata?.count ?? 0) > 0);

  // Use the orchestrator hook for all handlers
  const handlers = useDecoderHandlers({
    // Session manager actions
    reinitialize,
    start,
    stop,
    pause,
    resume,
    leave,
    rejoin,
    setSpeed,
    setTimeRange,
    seek,

    // Reader state
    isPaused,
    capabilities,

    // Store actions (decoder)
    setIoProfile,
    setPlaybackSpeed,
    setStartTime,
    setEndTime,
    updateCurrentTime,
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
    serialConfig,

    // Multi-bus state
    setMultiBusMode,
    setMultiBusProfiles: setIoProfiles,
    profileNamesMap,

    // Ingest session
    startIngest,
    stopIngest,
    isIngesting,

    // Watch state
    isWatching,
    setIsWatching,
    setWatchFrameCount,
    streamCompletedRef,

    // Detached state
    setIsDetached,

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

    // Settings for default speeds
    ioProfiles: settings?.io_profiles,
  });

  // Clear watch state when stream ends
  useEffect(() => {
    if (!isDecoding && isWatching) {
      setIsWatching(false);
    }
  }, [isDecoding, isWatching]);

  // Effect to handle auto-transition to buffer replay after stream ends
  useEffect(() => {
    if (pendingBufferTransition && !isDecoding) {
      setPendingBufferTransition(false);
      // Transition to buffer replay mode
      switchToBufferReplay(playbackSpeed).then(async () => {
        // Update ioProfile to buffer so UI knows we're in buffer mode
        setIoProfile(BUFFER_PROFILE_ID);
        // Refresh buffer metadata after transition
        const meta = await getBufferMetadata();
        setBufferMetadata(meta);
        // Reset time slider to start of buffer
        if (meta?.start_time_us != null) {
          updateCurrentTime(meta.start_time_us / 1_000_000);
        }
      }).catch((e) => console.error("Failed to switch to buffer replay:", e));
    }
  }, [pendingBufferTransition, isDecoding, switchToBufferReplay, playbackSpeed, setIoProfile, updateCurrentTime]);

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

  // Note: We removed the useEffect that reinitializes on serialConfig/ioProfile changes.
  // Reinitialize is now only called from explicit user actions (IO picker dialog, handleIoProfileChange).
  // This prevents race conditions where multiple reinitialize calls happen concurrently.

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
    if (readerState === "paused") return "paused";
    return "stopped";
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-slate-900 overflow-hidden">
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

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden m-2">
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
          capabilities={capabilities}
          onPlay={handlers.handlePlay}
          onPause={handlers.handlePause}
          onStop={handlers.handleStop}
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
        />
      </div>

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
    </div>
  );
}
