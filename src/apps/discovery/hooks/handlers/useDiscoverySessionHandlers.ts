// ui/src/apps/discovery/hooks/handlers/useDiscoverySessionHandlers.ts
//
// Session-related handlers for Discovery: start, stop, resume, detach, rejoin, multi-bus, IO profile change.
// Delegates session orchestration to useIOSessionManager methods; only adds Discovery-specific logic
// (serial config, framing config, buffer cleanup, playback controls).

import { useCallback } from "react";
import type { IngestOptions } from "../../../../dialogs/IoReaderPickerDialog";
import type { IngestOptions as ManagerIngestOptions } from "../../../../hooks/useIOSessionManager";
import { getBufferFrameInfo, setActiveBuffer, type BufferMetadata } from "../../../../api/buffer";
import { stepBufferFrame, updateReaderDirection } from "../../../../api/io";
import { isBufferProfileId } from "../../../../hooks/useIOSessionManager";
import { useBufferSession } from "../../../../hooks/useBufferSession";

export interface UseDiscoverySessionHandlersParams {
  // Session manager state (for playback controls)
  sessionId: string;
  isStreaming: boolean;
  isPaused: boolean;
  sessionReady: boolean;

  // Current position (for step operations)
  currentFrameIndex?: number | null;
  currentTimestampUs?: number | null;

  // Selected frame IDs for filtering step operations
  selectedFrameIds?: Set<number>;

  // Session actions (for playback controls)
  setSourceProfileId: (profileId: string | null) => void;
  setShowBusColumn: (show: boolean) => void;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;

  // Manager session switching methods
  watchSingleSource: (profileId: string, options: ManagerIngestOptions, reinitializeOptions?: Record<string, unknown>) => Promise<void>;
  watchMultiSource: (profileIds: string[], options: ManagerIngestOptions) => Promise<void>;
  ingestSingleSource: (profileId: string, options: ManagerIngestOptions) => Promise<void>;
  ingestMultiSource: (profileIds: string[], options: ManagerIngestOptions) => Promise<void>;
  stopWatch: () => Promise<void>;
  selectProfile: (profileId: string | null) => void;
  selectMultipleProfiles: (profileIds: string[]) => void;
  joinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;

  // Store actions
  updateCurrentTime?: (timeSeconds: number) => void;
  setCurrentFrameIndex?: (index: number) => void;
  setMaxBuffer?: (count: number) => void;
  clearBuffer: () => void;
  clearFramePicker: () => void;
  clearAnalysisResults: () => void;
  enableBufferMode: (count: number) => void;
  disableBufferMode: () => void;
  setFrameInfoFromBuffer: (frameInfo: any[]) => void;
  clearSerialBytes: (preserveCount?: boolean) => void;
  resetFraming: () => void;
  setBackendByteCount: (count: number) => void;
  addSerialBytes: (entries: { byte: number; timestampUs: number }[]) => void;
  setSerialConfig: (config: any) => void;
  setFramingConfig: (config: any) => void;
  resetWatchFrameCount: () => void;
  showError: (title: string, message: string, details?: string) => void;

  // Buffer state
  setBufferMetadata: (meta: BufferMetadata | null) => void;

  // Dialog controls
  closeIoReaderPicker: () => void;
}

export function useDiscoverySessionHandlers({
  sessionId,
  isStreaming,
  isPaused,
  sessionReady,
  currentFrameIndex,
  currentTimestampUs,
  selectedFrameIds,
  setSourceProfileId,
  setShowBusColumn,
  start,
  pause,
  resume,
  watchSingleSource,
  watchMultiSource,
  ingestSingleSource,
  ingestMultiSource,
  stopWatch,
  selectProfile,
  selectMultipleProfiles,
  joinSession,
  updateCurrentTime,
  setCurrentFrameIndex,
  setMaxBuffer,
  clearBuffer,
  clearFramePicker,
  clearAnalysisResults,
  enableBufferMode,
  disableBufferMode,
  setFrameInfoFromBuffer,
  clearSerialBytes,
  resetFraming,
  setBackendByteCount,
  addSerialBytes: _addSerialBytes,
  setSerialConfig,
  setFramingConfig,
  resetWatchFrameCount,
  showError,
  setBufferMetadata,
  closeIoReaderPicker,
}: UseDiscoverySessionHandlersParams) {
  void _addSerialBytes; // Reserved for future bytes mode support

  // Centralized buffer session handler with Discovery-specific callbacks
  const { switchToBuffer } = useBufferSession({
    setBufferMetadata,
    updateCurrentTime: updateCurrentTime ?? (() => {}),
    setCurrentFrameIndex: setCurrentFrameIndex ?? (() => {}),
    // Clear previous state before switching
    onBeforeSwitch: () => {
      clearBuffer();
      clearFramePicker();
      clearAnalysisResults();
      disableBufferMode();
      clearSerialBytes();
      resetFraming();
      setBackendByteCount(0);
    },
    // Load frame info after metadata is loaded
    onAfterSwitch: async (meta) => {
      if (!meta || meta.count === 0) return;

      const isFramesMode = meta.buffer_type === "frames";
      const isBytesMode = meta.buffer_type === "bytes";

      if (isBytesMode) {
        // Bytes mode is handled elsewhere for Discovery
        return;
      }

      if (isFramesMode) {
        // Set active buffer so getBufferFrameInfo reads from the correct buffer
        await setActiveBuffer(meta.id);
        enableBufferMode(meta.count);
        setMaxBuffer?.(meta.count);
        try {
          const frameInfoList = await getBufferFrameInfo();
          setFrameInfoFromBuffer(frameInfoList);
        } catch (e) {
          console.error("[DiscoverySessionHandlers] Failed to load frame info:", e);
        }
      }
    },
  });

  // Handle IO profile change - manager handles common logic, app handles buffer/non-buffer cleanup
  const handleIoProfileChange = useCallback(async (profileId: string | null) => {
    console.log(`[DiscoverySessionHandlers] handleIoProfileChange called - profileId=${profileId}`);

    // Manager handles: clear multi-bus, set profile, default speed
    selectProfile(profileId);

    // Check if switching to a buffer session (buffer_1, buffer_2, etc. or legacy __imported_buffer__)
    if (isBufferProfileId(profileId)) {
      await switchToBuffer(profileId!);
    } else {
      // Clear state when switching to non-buffer profile
      clearAnalysisResults();
      clearBuffer();
      clearFramePicker();
      disableBufferMode();
      clearSerialBytes();
      resetFraming();
      setBackendByteCount(0);
    }
  }, [
    selectProfile,
    switchToBuffer,
    clearAnalysisResults,
    clearBuffer,
    clearFramePicker,
    disableBufferMode,
    clearSerialBytes,
    resetFraming,
    setBackendByteCount,
  ]);

  // Handle Watch/Ingest from IoReaderPickerDialog
  const handleDialogStartIngest = useCallback(async (
    profileId: string,
    closeDialog: boolean,
    options: IngestOptions
  ) => {
    console.log(`[DiscoverySessionHandlers] handleDialogStartIngest called - profileId=${profileId}, closeDialog=${closeDialog}`);
    const {
      frameIdStartByte,
      frameIdBytes,
      sourceAddressStartByte,
      sourceAddressBytes,
      sourceAddressEndianness,
      minFrameLength,
      framingEncoding,
      delimiter,
      maxFrameLength,
    } = options;

    // Store serial config for TOML export
    const hasSerialConfig = frameIdStartByte !== undefined || sourceAddressStartByte !== undefined || minFrameLength !== undefined;
    if (hasSerialConfig) {
      setSerialConfig({
        frame_id_start_byte: frameIdStartByte,
        frame_id_bytes: frameIdBytes,
        source_address_start_byte: sourceAddressStartByte,
        source_address_bytes: sourceAddressBytes,
        source_address_byte_order: sourceAddressEndianness,
        min_frame_length: minFrameLength,
      });
    } else {
      setSerialConfig(null);
    }

    if (closeDialog) {
      // Watch mode
      try {
        console.log(`[DiscoverySessionHandlers] Watch mode - calling watchSingleSource(${profileId})`);

        // Discovery-specific: set source profile ID and sync framing config
        setSourceProfileId(profileId);

        // Sync framing config with discovery store
        if (framingEncoding && framingEncoding !== "raw") {
          const storeFramingConfig =
            framingEncoding === "slip"
              ? { mode: "slip" as const }
              : framingEncoding === "modbus_rtu"
              ? { mode: "modbus_rtu" as const, validateCrc: true }
              : {
                  mode: "raw" as const,
                  delimiter: delimiter ? delimiter.map((b: number) => b.toString(16).toUpperCase().padStart(2, "0")).join("") : "0A",
                  maxLength: maxFrameLength ?? 256,
                };
          setFramingConfig(storeFramingConfig);
        } else {
          setFramingConfig(null);
        }

        // Manager handles: onBeforeWatch cleanup, reinitialize, multi-bus clear, profile set, speed, watch state
        await watchSingleSource(profileId, options, {
          sourceAddressBigEndian: sourceAddressEndianness === "big",
        });

        closeIoReaderPicker();
        console.log(`[DiscoverySessionHandlers] Watch mode - complete`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showError("Watch Error", "Failed to start watch session", msg);
      }
    } else {
      // Ingest mode - fast ingest without rendering, auto-transitions to buffer reader
      try {
        console.log(`[DiscoverySessionHandlers] Ingest mode - calling ingestSingleSource(${profileId})`);

        // Discovery-specific: set source profile ID
        setSourceProfileId(profileId);

        // Manager handles: pre-ingest cleanup, session creation with speed=0, frame counting, auto-transition
        await ingestSingleSource(profileId, options);

        console.log(`[DiscoverySessionHandlers] Ingest mode - started`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showError("Ingest Error", "Failed to start ingest", msg);
      }
    }
  }, [
    setSerialConfig,
    setSourceProfileId,
    setFramingConfig,
    watchSingleSource,
    ingestSingleSource,
    closeIoReaderPicker,
    showError,
  ]);

  // Handle Watch/Ingest for multiple profiles (multi-bus mode)
  const handleDialogStartMultiIngest = useCallback(async (
    profileIds: string[],
    closeDialog: boolean,
    options: IngestOptions
  ) => {
    if (closeDialog) {
      // Watch mode
      // Note: cleanup is handled by manager's onBeforeMultiWatch callback
      try {
        // Manager handles: onBeforeMultiWatch cleanup, startMultiBusSession, speed, watch state
        await watchMultiSource(profileIds, options);

        setShowBusColumn(true);
        closeIoReaderPicker();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showError("Multi-Bus Error", "Failed to start multi-bus session", msg);
      }
    } else {
      // Ingest mode - fast ingest without rendering
      try {
        console.log(`[DiscoverySessionHandlers] Multi-source ingest mode - calling ingestMultiSource`);

        // Manager handles: pre-ingest cleanup, session creation with speed=0, frame counting, auto-transition
        await ingestMultiSource(profileIds, options);

        setShowBusColumn(true);
        console.log(`[DiscoverySessionHandlers] Multi-source ingest mode - started`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showError("Multi-Bus Ingest Error", "Failed to start multi-bus ingest", msg);
      }
    }
  }, [
    watchMultiSource,
    ingestMultiSource,
    setShowBusColumn,
    closeIoReaderPicker,
    showError,
  ]);

  // Handle selecting multiple profiles in multi-bus mode
  const handleSelectMultiple = useCallback((profileIds: string[]) => {
    selectMultipleProfiles(profileIds);
  }, [selectMultipleProfiles]);

  // Handle play/resume button click
  const handlePlay = useCallback(async () => {
    console.log(`[DiscoverySessionHandlers] handlePlay - isPaused=${isPaused}, isStreaming=${isStreaming}, sessionReady=${sessionReady}`);
    if (isPaused) {
      console.log(`[DiscoverySessionHandlers] handlePlay - resuming...`);
      await resume();
      console.log(`[DiscoverySessionHandlers] handlePlay - resume complete`);
    } else if (isStreaming) {
      console.log("[DiscoverySessionHandlers] Ignoring play request - already streaming");
    } else if (!sessionReady) {
      console.log("[DiscoverySessionHandlers] Ignoring play request - session not ready");
    } else {
      console.log(`[DiscoverySessionHandlers] handlePlay - starting...`);
      resetWatchFrameCount();
      await start();
      console.log(`[DiscoverySessionHandlers] handlePlay - start complete`);
    }
  }, [isPaused, isStreaming, sessionReady, resume, start, resetWatchFrameCount]);

  // Handle play backwards button click
  const handlePlayBackward = useCallback(async () => {
    console.log(`[DiscoverySessionHandlers] handlePlayBackward - isPaused=${isPaused}, isStreaming=${isStreaming}, sessionReady=${sessionReady}`);

    // Set direction to reverse before starting/resuming
    try {
      await updateReaderDirection(sessionId, true);
      console.log(`[DiscoverySessionHandlers] handlePlayBackward - direction set to reverse`);
    } catch (e) {
      console.error(`[DiscoverySessionHandlers] handlePlayBackward - failed to set direction:`, e);
      return;
    }

    if (isPaused) {
      console.log(`[DiscoverySessionHandlers] handlePlayBackward - resuming...`);
      await resume();
      console.log(`[DiscoverySessionHandlers] handlePlayBackward - resume complete`);
    } else if (isStreaming) {
      console.log("[DiscoverySessionHandlers] Already streaming in reverse direction");
    } else if (!sessionReady) {
      console.log("[DiscoverySessionHandlers] Ignoring play backward request - session not ready");
    } else {
      console.log(`[DiscoverySessionHandlers] handlePlayBackward - starting...`);
      resetWatchFrameCount();
      await start();
      console.log(`[DiscoverySessionHandlers] handlePlayBackward - start complete`);
    }
  }, [sessionId, isPaused, isStreaming, sessionReady, resume, start, resetWatchFrameCount]);

  // Handle play forward button click (reset direction to forward)
  const handlePlayForward = useCallback(async () => {
    console.log(`[DiscoverySessionHandlers] handlePlayForward - setting direction to forward`);

    // Set direction to forward
    try {
      await updateReaderDirection(sessionId, false);
      console.log(`[DiscoverySessionHandlers] handlePlayForward - direction set to forward`);
    } catch (e) {
      console.error(`[DiscoverySessionHandlers] handlePlayForward - failed to set direction:`, e);
      // Continue anyway - forward is the default
    }

    // Then call the regular handlePlay logic
    if (isPaused) {
      await resume();
    } else if (!isStreaming && sessionReady) {
      resetWatchFrameCount();
      await start();
    }
  }, [sessionId, isPaused, isStreaming, sessionReady, resume, start, resetWatchFrameCount]);

  // Handle stop button click
  const handleStop = useCallback(async () => {
    console.log(`[DiscoverySessionHandlers] handleStop - calling stopWatch...`);
    await stopWatch();
    console.log(`[DiscoverySessionHandlers] handleStop - stop complete`);
  }, [stopWatch]);

  // Handle pause button click
  const handlePause = useCallback(async () => {
    await pause();
  }, [pause]);

  // Handle step backward (one frame earlier, respecting filter)
  const handleStepBackward = useCallback(async () => {
    // Need to be not actively playing and have some position info (frame index or timestamp)
    // Allow stepping when paused OR when not streaming (e.g., buffer loaded but not started)
    const isPlaying = isStreaming && !isPaused;
    if (isPlaying || (currentFrameIndex == null && currentTimestampUs == null)) return;
    try {
      // Convert Set to array for the API call, only if we have a selection
      const filter = selectedFrameIds && selectedFrameIds.size > 0
        ? Array.from(selectedFrameIds)
        : undefined;
      const result = await stepBufferFrame(sessionId, currentFrameIndex ?? null, currentTimestampUs ?? null, true, filter);
      // Update the store immediately with the new frame index and timestamp
      if (result != null) {
        setCurrentFrameIndex?.(result.frame_index);
        updateCurrentTime?.(result.timestamp_us / 1_000_000);
      }
    } catch (e) {
      console.error("[DiscoverySessionHandlers] Failed to step backward:", e);
    }
  }, [sessionId, isStreaming, isPaused, currentFrameIndex, currentTimestampUs, selectedFrameIds, setCurrentFrameIndex, updateCurrentTime]);

  // Handle step forward (one frame later, respecting filter)
  const handleStepForward = useCallback(async () => {
    // Need to be not actively playing and have some position info (frame index or timestamp)
    // Allow stepping when paused OR when not streaming (e.g., buffer loaded but not started)
    const isPlaying = isStreaming && !isPaused;
    if (isPlaying || (currentFrameIndex == null && currentTimestampUs == null)) return;
    try {
      // Convert Set to array for the API call, only if we have a selection
      const filter = selectedFrameIds && selectedFrameIds.size > 0
        ? Array.from(selectedFrameIds)
        : undefined;
      const result = await stepBufferFrame(sessionId, currentFrameIndex ?? null, currentTimestampUs ?? null, false, filter);
      // Update the store immediately with the new frame index and timestamp
      if (result != null) {
        setCurrentFrameIndex?.(result.frame_index);
        updateCurrentTime?.(result.timestamp_us / 1_000_000);
      }
    } catch (e) {
      console.error("[DiscoverySessionHandlers] Failed to step forward:", e);
    }
  }, [sessionId, isStreaming, isPaused, currentFrameIndex, currentTimestampUs, selectedFrameIds, setCurrentFrameIndex, updateCurrentTime]);

  // Handle joining an existing session from the IO picker dialog
  const handleJoinSession = useCallback(async (
    profileId: string,
    sourceProfileIds?: string[]
  ) => {
    await joinSession(profileId, sourceProfileIds);

    if (sourceProfileIds && sourceProfileIds.length > 1) {
      setShowBusColumn(true);
    }

    closeIoReaderPicker();
  }, [joinSession, setShowBusColumn, closeIoReaderPicker]);

  return {
    handleIoProfileChange,
    handleDialogStartIngest,
    handleDialogStartMultiIngest,
    handleSelectMultiple,
    handlePlay,
    handlePlayBackward,
    handlePlayForward,
    handleStop,
    handlePause,
    handleStepBackward,
    handleStepForward,
    handleJoinSession,
  };
}

export type DiscoverySessionHandlers = ReturnType<typeof useDiscoverySessionHandlers>;
