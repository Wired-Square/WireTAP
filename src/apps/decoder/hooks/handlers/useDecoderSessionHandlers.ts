// ui/src/apps/decoder/hooks/handlers/useDecoderSessionHandlers.ts
//
// Session-related handlers for Decoder: start ingest, stop watch, detach, rejoin, multi-bus, IO profile change.
// Delegates session orchestration to useIOSessionManager methods; only adds Decoder-specific logic
// (serial config merge, buffer reinitialize, ingest routing).

import { useCallback } from "react";
import type { PlaybackSpeed } from "../../../../components/TimeController";
import type { IngestOptions } from "../../../../dialogs/IoReaderPickerDialog";
import type { IngestOptions as ManagerIngestOptions } from "../../../../hooks/useIOSessionManager";
import { isBufferProfileId } from "../../../../hooks/useIOSessionManager";
import { useBufferSession } from "../../../../hooks/useBufferSession";
import type { BufferMetadata } from "../../../../api/buffer";
import { useDecoderStore } from "../../../../stores/decoderStore";
import { useSessionStore } from "../../../../stores/sessionStore";

export interface UseDecoderSessionHandlersParams {
  // Session manager actions (for buffer reinitialize only)
  reinitialize: (
    profileId?: string,
    options?: {
      useBuffer?: boolean;
      speed?: number;
      startTime?: string;
      endTime?: string;
      limit?: number;
      framingEncoding?: "slip" | "modbus_rtu" | "delimiter" | "raw";
      frameIdStartByte?: number;
      frameIdBytes?: number;
      frameIdBigEndian?: boolean;
      sourceAddressStartByte?: number;
      sourceAddressBytes?: number;
      sourceAddressBigEndian?: boolean;
      minFrameLength?: number;
      emitRawBytes?: boolean;
    }
  ) => Promise<void>;

  // Ingest session
  startIngest: (params: {
    profileId: string;
    speed?: number;
    startTime?: string;
    endTime?: string;
    maxFrames?: number;
    frameIdStartByte?: number;
    frameIdBytes?: number;
    sourceAddressStartByte?: number;
    sourceAddressBytes?: number;
    sourceAddressBigEndian?: boolean;
    minFrameLength?: number;
  }) => Promise<void>;
  stopIngest: () => Promise<void>;
  isIngesting: boolean;

  // Watch state (read-only, from manager)
  isWatching: boolean;

  // Manager session switching methods
  watchSingleSource: (profileId: string, options: ManagerIngestOptions, reinitializeOptions?: Record<string, unknown>) => Promise<void>;
  watchMultiSource: (profileIds: string[], options: ManagerIngestOptions) => Promise<void>;
  stopWatch: () => Promise<void>;
  selectProfile: (profileId: string | null) => void;
  selectMultipleProfiles: (profileIds: string[]) => void;
  joinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;
  skipReader: () => Promise<void>;

  // Ingest speed
  ingestSpeed: number;
  setIngestSpeed: (speed: number) => void;

  // Dialog controls
  closeIoReaderPicker: () => void;

  // Playback (for buffer reinitialize)
  playbackSpeed: PlaybackSpeed;

  // Buffer state (for centralized buffer handler)
  setBufferMetadata: (meta: BufferMetadata | null) => void;
  updateCurrentTime: (timeSeconds: number) => void;
  setCurrentFrameIndex: (index: number) => void;
}

export function useDecoderSessionHandlers({
  reinitialize,
  startIngest,
  stopIngest,
  isIngesting,
  isWatching,
  watchSingleSource,
  watchMultiSource,
  stopWatch,
  selectProfile,
  selectMultipleProfiles,
  joinSession,
  skipReader,
  ingestSpeed,
  setIngestSpeed,
  closeIoReaderPicker,
  playbackSpeed,
  setBufferMetadata,
  updateCurrentTime,
  setCurrentFrameIndex,
}: UseDecoderSessionHandlersParams) {
  // Centralized buffer session handler
  const { switchToBuffer } = useBufferSession({
    setBufferMetadata,
    updateCurrentTime,
    setCurrentFrameIndex,
  });

  // Handle Watch for multiple profiles (multi-bus mode)
  const handleDialogStartMultiIngest = useCallback(
    async (profileIds: string[], closeDialog: boolean, options: IngestOptions) => {
      if (closeDialog) {
        // Watch mode for multiple buses
        // Note: clearFrames is handled by manager's onBeforeMultiWatch callback
        try {
          // Read serialConfig directly from store to avoid stale closure issues
          // (catalog may have been loaded after this callback was created)
          const serialConfig = useDecoderStore.getState().serialConfig;

          // Merge catalog serial config with options (catalog config takes precedence for frame ID)
          const mergedOptions: ManagerIngestOptions = {
            ...options,
            // Frame ID extraction from catalog
            frameIdStartByte: serialConfig?.frame_id_start_byte,
            frameIdBytes: serialConfig?.frame_id_bytes,
            // Source address extraction from catalog
            sourceAddressStartByte: serialConfig?.source_address_start_byte,
            sourceAddressBytes: serialConfig?.source_address_bytes,
            sourceAddressEndianness: serialConfig?.source_address_byte_order,
            // Min frame length from catalog
            minFrameLength: options.minFrameLength ?? serialConfig?.min_frame_length,
            // Framing encoding from catalog (if not overridden by options)
            framingEncoding: options.framingEncoding ?? serialConfig?.encoding as ManagerIngestOptions["framingEncoding"],
          };

          // Manager handles: startMultiBusSession, speed, watch state, streamCompletedRef
          await watchMultiSource(profileIds, mergedOptions);
          closeIoReaderPicker();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`Failed to start multi-bus session:`, msg);
          useSessionStore.getState().showAppError("Multi-Bus Error", "Failed to start multi-bus session.", msg);
        }
      }
      // Ingest mode not supported for multi-bus
    },
    [watchMultiSource, closeIoReaderPicker]
  );

  // Handle starting ingest from the dialog - routes to Watch or Ingest mode based on closeDialog flag
  const handleDialogStartIngest = useCallback(
    async (profileId: string, closeDialog: boolean, options: IngestOptions) => {
      const { speed, startTime, endTime, maxFrames } = options;

      // Read serialConfig directly from store to avoid stale closure issues
      // (catalog may have been loaded after this callback was created)
      const serialConfig = useDecoderStore.getState().serialConfig;

      if (closeDialog) {
        // Watch mode - uses decoder session for real-time display
        // Note: clearFrames is handled by manager's onBeforeWatch callback

        // Merge catalog serial config with dialog options
        const mergedOptions: ManagerIngestOptions = {
          ...options,
          // Frame ID extraction from catalog
          frameIdStartByte: serialConfig?.frame_id_start_byte,
          frameIdBytes: serialConfig?.frame_id_bytes,
          // Source address extraction from catalog
          sourceAddressStartByte: serialConfig?.source_address_start_byte,
          sourceAddressBytes: serialConfig?.source_address_bytes,
          sourceAddressEndianness: serialConfig?.source_address_byte_order,
          // Other options from catalog
          minFrameLength: serialConfig?.min_frame_length,
          framingEncoding: serialConfig?.encoding as ManagerIngestOptions["framingEncoding"],
          emitRawBytes: true, // Emit raw bytes for debugging
        };

        // Manager handles: reinitialize, multi-bus clear, profile set, speed, watch state
        // Pass frameIdBigEndian via reinitializeOptions since it needs boolean conversion
        await watchSingleSource(profileId, mergedOptions, {
          frameIdBigEndian: serialConfig?.frame_id_byte_order === "big",
        });

        closeIoReaderPicker();
      } else {
        // Ingest mode - uses separate session, no real-time display
        setIngestSpeed(speed);
        await startIngest({
          profileId,
          speed: speed ?? ingestSpeed,
          startTime,
          endTime,
          maxFrames,
          frameIdStartByte: serialConfig?.frame_id_start_byte,
          frameIdBytes: serialConfig?.frame_id_bytes,
          sourceAddressStartByte: serialConfig?.source_address_start_byte,
          sourceAddressBytes: serialConfig?.source_address_bytes,
          sourceAddressBigEndian: serialConfig?.source_address_byte_order === "big",
          minFrameLength: serialConfig?.min_frame_length,
        });
      }
    },
    [watchSingleSource, closeIoReaderPicker, setIngestSpeed, startIngest, ingestSpeed]
  );

  // Handle selecting multiple profiles in multi-bus mode
  const handleSelectMultiple = useCallback(
    (profileIds: string[]) => {
      selectMultipleProfiles(profileIds);
    },
    [selectMultipleProfiles]
  );

  // Handle stopping from the dialog - routes to Watch or Ingest stop
  const handleDialogStopIngest = useCallback(async () => {
    if (isWatching) {
      await stopWatch();
      // The stream-ended event will handle buffer transition
    } else if (isIngesting) {
      await stopIngest();
    }
  }, [isWatching, isIngesting, stopWatch, stopIngest]);

  // Watch mode handlers - uses the decoder session for real-time display while buffering
  const handleStopWatch = useCallback(async () => {
    await stopWatch();
    // The stream-ended event will handle buffer transition
  }, [stopWatch]);

  // Handle IO profile change - manager handles common logic, app handles buffer mode
  const handleIoProfileChange = useCallback(
    async (profileId: string | null) => {
      // Manager handles: clear multi-bus, set profile, default speed
      selectProfile(profileId);

      // Buffer profiles need additional setup for playback
      if (isBufferProfileId(profileId)) {
        // Use centralized handler to fetch metadata and reset playback state
        await switchToBuffer(profileId!);
        // Create BufferReader session for playback
        await reinitialize(profileId!, { useBuffer: true, speed: playbackSpeed });
      }
    },
    [selectProfile, switchToBuffer, reinitialize, playbackSpeed]
  );

  // Handle joining an existing session from IO picker dialog
  const handleJoinSession = useCallback(
    async (profileId: string, sourceProfileIds?: string[]) => {
      await joinSession(profileId, sourceProfileIds);
      closeIoReaderPicker();
    },
    [joinSession, closeIoReaderPicker]
  );

  // Handle skipping IO picker (continue without reader)
  const handleSkip = useCallback(async () => {
    await skipReader();
    closeIoReaderPicker();
  }, [skipReader, closeIoReaderPicker]);

  return {
    handleDialogStartIngest,
    handleDialogStartMultiIngest,
    handleSelectMultiple,
    handleDialogStopIngest,
    handleStopWatch,
    handleIoProfileChange,
    handleJoinSession,
    handleSkip,
  };
}

export type DecoderSessionHandlers = ReturnType<typeof useDecoderSessionHandlers>;
