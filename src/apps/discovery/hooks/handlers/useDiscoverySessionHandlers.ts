// ui/src/apps/discovery/hooks/handlers/useDiscoverySessionHandlers.ts
//
// Session-related handlers for Discovery: start, stop, resume, detach, rejoin, multi-bus, IO profile change.

import { useCallback } from "react";
import type { PlaybackSpeed } from "../../../../stores/discoveryStore";
import type { IngestOptions } from "../../../../dialogs/IoReaderPickerDialog";
import type { BufferMetadata } from "../../../../api/buffer";

export interface UseDiscoverySessionHandlersParams {
  // Session manager state
  multiBusMode: boolean;
  isStreaming: boolean;
  isPaused: boolean;
  sessionReady: boolean;
  ioProfile: string | null;
  sourceProfileId: string | null;
  bufferModeEnabled: boolean;

  // Session manager actions
  setMultiBusMode: (mode: boolean) => void;
  setMultiBusProfiles: (profiles: string[]) => void;
  setIoProfile: (profileId: string | null) => void;
  setSourceProfileId: (profileId: string | null) => void;
  setShowBusColumn: (show: boolean) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  leave: () => Promise<void>;
  rejoin: (sessionId?: string, sessionName?: string) => Promise<void>;
  reinitialize: (profileId?: string, options?: any) => Promise<void>;

  // Store actions
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  clearBuffer: () => void;
  clearFramePicker: () => void;
  clearAnalysisResults: () => void;
  enableBufferMode: (count: number) => void;
  disableBufferMode: () => void;
  setFrameInfoFromBuffer: (frameInfo: any[]) => void;
  clearSerialBytes: (preserveCount?: boolean) => void;
  resetFraming: () => void;
  setBackendByteCount: (count: number) => void;
  setBackendFrameCount: (count: number) => void;
  addSerialBytes: (entries: { byte: number; timestampUs: number }[]) => void;
  setSerialConfig: (config: any) => void;
  setFramingConfig: (config: any) => void;
  setWatchFrameCount: (count: number | ((prev: number) => number)) => void;
  showError: (title: string, message: string, details?: string) => void;

  // Helpers
  profileNamesMap: Map<string, string>;
  createAndStartMultiSourceSession: (options: any) => Promise<any>;
  joinMultiSourceSession: (options: any) => Promise<any>;
  getBufferMetadata: () => Promise<BufferMetadata | null>;
  getBufferFrameInfo: () => Promise<any[]>;
  getBufferBytesById: (id: string) => Promise<any[]>;
  setActiveBuffer: (id: string) => Promise<void>;
  setBufferMetadata: (meta: BufferMetadata | null) => void;
  setIsDetached: (detached: boolean) => void;

  // Dialog controls
  closeIoReaderPicker: () => void;

  // Constants
  BUFFER_PROFILE_ID: string;
}

export function useDiscoverySessionHandlers({
  multiBusMode: _multiBusMode,
  isStreaming,
  isPaused,
  sessionReady,
  ioProfile,
  sourceProfileId,
  bufferModeEnabled,
  setMultiBusMode,
  setMultiBusProfiles,
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
  setPlaybackSpeed,
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
  setWatchFrameCount,
  showError,
  profileNamesMap,
  createAndStartMultiSourceSession,
  joinMultiSourceSession,
  getBufferMetadata,
  getBufferFrameInfo,
  getBufferBytesById,
  setActiveBuffer,
  setBufferMetadata,
  setIsDetached,
  closeIoReaderPicker,
  BUFFER_PROFILE_ID,
}: UseDiscoverySessionHandlersParams) {
  // Handle IO profile change
  const handleIoProfileChange = useCallback(async (profileId: string | null) => {
    setIoProfile(profileId);
    setIsDetached(false);

    // Clear analysis results when switching readers
    clearAnalysisResults();

    // Clear ALL data when switching readers
    clearBuffer();
    clearFramePicker();
    disableBufferMode();
    clearSerialBytes();
    resetFraming();
    setBackendByteCount(0);

    // Check if switching to the buffer reader
    if (profileId === BUFFER_PROFILE_ID) {
      const meta = await getBufferMetadata();
      setBufferMetadata(meta);

      if (meta && meta.count > 0) {
        if (meta.buffer_type === "bytes") {
          await setActiveBuffer(meta.id);
          try {
            const bytes = await getBufferBytesById(meta.id);
            const entries = bytes.map((b: any) => ({
              byte: b.byte,
              timestampUs: b.timestamp_us,
            }));
            addSerialBytes(entries);
            setBackendByteCount(meta.count);
          } catch (e) {
            console.error("Failed to load bytes from buffer:", e);
          }
        } else {
          await reinitialize(undefined, { useBuffer: true });

          const BUFFER_MODE_THRESHOLD = 100000;

          if (meta.count > BUFFER_MODE_THRESHOLD) {
            enableBufferMode(meta.count);
            try {
              const frameInfoList = await getBufferFrameInfo();
              setFrameInfoFromBuffer(frameInfoList);
            } catch (e) {
              console.error("Failed to load frame info from buffer:", e);
            }
          } else {
            enableBufferMode(meta.count);
            try {
              const frameInfoList = await getBufferFrameInfo();
              setFrameInfoFromBuffer(frameInfoList);
            } catch (e) {
              console.error("Failed to load frame info from buffer:", e);
            }
          }
        }
      }
    }
  }, [
    setIoProfile,
    setIsDetached,
    clearAnalysisResults,
    clearBuffer,
    clearFramePicker,
    disableBufferMode,
    clearSerialBytes,
    resetFraming,
    setBackendByteCount,
    BUFFER_PROFILE_ID,
    getBufferMetadata,
    setBufferMetadata,
    setActiveBuffer,
    getBufferBytesById,
    addSerialBytes,
    reinitialize,
    enableBufferMode,
    getBufferFrameInfo,
    setFrameInfoFromBuffer,
  ]);

  // Handle Watch/Ingest from IoReaderPickerDialog
  const handleDialogStartIngest = useCallback(async (
    profileId: string,
    closeDialog: boolean,
    options: IngestOptions
  ) => {
    const {
      speed,
      startTime: optStartTime,
      endTime: optEndTime,
      maxFrames,
      frameIdStartByte,
      frameIdBytes,
      sourceAddressStartByte,
      sourceAddressBytes,
      sourceAddressEndianness,
      minFrameLength,
      framingEncoding,
      delimiter,
      maxFrameLength,
      emitRawBytes,
      busOverride,
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
      setWatchFrameCount(0);
      clearSerialBytes();
      setBackendFrameCount(0);
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

      await reinitialize(profileId, {
        startTime: optStartTime,
        endTime: optEndTime,
        speed,
        limit: maxFrames,
        frameIdStartByte,
        frameIdBytes,
        sourceAddressStartByte,
        sourceAddressBytes,
        sourceAddressBigEndian: sourceAddressEndianness === "big",
        minFrameLength,
        framingEncoding,
        delimiter,
        maxFrameLength,
        emitRawBytes,
        busOverride,
      });

      setIoProfile(profileId);
      setPlaybackSpeed(speed as PlaybackSpeed);
      setMultiBusMode(false);
      setMultiBusProfiles([]);

      closeIoReaderPicker();
    }
    // Ingest mode is handled by useIngestSession hook via startIngest
  }, [
    setSerialConfig,
    setWatchFrameCount,
    clearSerialBytes,
    setBackendFrameCount,
    setSourceProfileId,
    setFramingConfig,
    reinitialize,
    setIoProfile,
    setPlaybackSpeed,
    setMultiBusMode,
    setMultiBusProfiles,
    closeIoReaderPicker,
  ]);

  // Handle Watch/Ingest for multiple profiles (multi-bus mode)
  const handleDialogStartMultiIngest = useCallback(async (
    profileIds: string[],
    closeDialog: boolean,
    options: IngestOptions
  ) => {
    const { speed, busMappings } = options;

    if (closeDialog) {
      setWatchFrameCount(0);
      clearSerialBytes();
      setBackendFrameCount(0);

      const multiSessionId = "discovery-multi";

      try {
        await createAndStartMultiSourceSession({
          sessionId: multiSessionId,
          listenerId: "discovery",
          profileIds,
          busMappings,
          profileNames: profileNamesMap,
        });

        setMultiBusMode(true);
        setMultiBusProfiles(profileIds);
        setShowBusColumn(true);
        setIoProfile(multiSessionId);
        setPlaybackSpeed(speed as PlaybackSpeed);

        closeIoReaderPicker();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showError("Multi-Bus Error", "Failed to start multi-bus session", msg);
      }
    }
  }, [
    setWatchFrameCount,
    clearSerialBytes,
    setBackendFrameCount,
    createAndStartMultiSourceSession,
    profileNamesMap,
    setMultiBusMode,
    setMultiBusProfiles,
    setShowBusColumn,
    setIoProfile,
    setPlaybackSpeed,
    closeIoReaderPicker,
    showError,
  ]);

  // Handle selecting multiple profiles in multi-bus mode
  const handleSelectMultiple = useCallback((profileIds: string[]) => {
    setMultiBusProfiles(profileIds);
    setIoProfile(null);
  }, [setMultiBusProfiles, setIoProfile]);

  // Handle play/resume button click
  const handlePlay = useCallback(async () => {
    if (isPaused) {
      await resume();
    } else if (isStreaming) {
      console.log("[Discovery] Ignoring play request - already streaming");
    } else if (!sessionReady) {
      console.log("[Discovery] Ignoring play request - session not ready");
    } else {
      setWatchFrameCount(0);
      await start();
    }
  }, [isPaused, isStreaming, sessionReady, resume, start, setWatchFrameCount]);

  // Handle stop button click
  const handleStop = useCallback(async () => {
    await stop();
  }, [stop]);

  // Detach from shared session without stopping it
  const handleDetach = useCallback(async () => {
    await leave();
    setIsDetached(true);
  }, [leave, setIsDetached]);

  // Rejoin a session after detaching
  const handleRejoin = useCallback(async () => {
    const profileToRejoin = (ioProfile === BUFFER_PROFILE_ID && sourceProfileId)
      ? sourceProfileId
      : ioProfile;

    if (bufferModeEnabled) {
      disableBufferMode();
    }
    if (ioProfile === BUFFER_PROFILE_ID && sourceProfileId) {
      setIoProfile(sourceProfileId);
    }

    await rejoin(profileToRejoin || undefined);
    setIsDetached(false);
  }, [ioProfile, sourceProfileId, bufferModeEnabled, BUFFER_PROFILE_ID, disableBufferMode, setIoProfile, rejoin, setIsDetached]);

  // Handle pause button click
  const handlePause = useCallback(async () => {
    await pause();
  }, [pause]);

  // Handle joining an existing session from the IO picker dialog
  const handleJoinSession = useCallback(async (
    profileId: string,
    sourceProfileIds?: string[]
  ) => {
    await joinMultiSourceSession({
      sessionId: profileId,
      listenerId: "discovery",
      sourceProfileIds,
    });

    setIoProfile(profileId);
    setMultiBusProfiles(sourceProfileIds || []);
    setMultiBusMode(false);
    setIsDetached(false);

    if (sourceProfileIds && sourceProfileIds.length > 1) {
      setShowBusColumn(true);
    }

    const sessionName = sourceProfileIds && sourceProfileIds.length > 1
      ? `Multi-Bus (${sourceProfileIds.length} sources)`
      : profileId;
    rejoin(profileId, sessionName);
    closeIoReaderPicker();
  }, [
    joinMultiSourceSession,
    setIoProfile,
    setMultiBusProfiles,
    setMultiBusMode,
    setIsDetached,
    setShowBusColumn,
    rejoin,
    closeIoReaderPicker,
  ]);

  return {
    handleIoProfileChange,
    handleDialogStartIngest,
    handleDialogStartMultiIngest,
    handleSelectMultiple,
    handlePlay,
    handleStop,
    handleDetach,
    handleRejoin,
    handlePause,
    handleJoinSession,
  };
}

export type DiscoverySessionHandlers = ReturnType<typeof useDiscoverySessionHandlers>;
