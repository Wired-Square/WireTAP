// ui/src/apps/decoder/hooks/handlers/useDecoderSessionHandlers.ts
//
// Session-related handlers for Decoder: start ingest, stop watch, detach, rejoin, multi-bus, IO profile change.

import { useCallback } from "react";
import {
  createAndStartMultiSourceSession,
  joinMultiSourceSession,
} from "../../../../stores/sessionStore";
import type { PlaybackSpeed } from "../../../../components/TimeController";
import type { IngestOptions } from "../../../../dialogs/IoReaderPickerDialog";
import type { SerialFrameConfig } from "../../../../utils/frameExport";

export interface UseDecoderSessionHandlersParams {
  // Session manager actions
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
  stop: () => Promise<void>;
  leave: () => Promise<void>;
  rejoin: (sessionId?: string, sessionName?: string) => Promise<void>;

  // Store actions
  setIoProfile: (profileId: string | null) => void;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;

  // Multi-bus state
  setMultiBusMode: (mode: boolean) => void;
  setMultiBusProfiles: (profiles: string[]) => void;
  profileNamesMap: Map<string, string>;

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

  // Serial/CAN config
  serialConfig: SerialFrameConfig | null;

  // Watch state
  isWatching: boolean;
  setIsWatching: (watching: boolean) => void;
  setWatchFrameCount: (count: number | ((prev: number) => number)) => void;
  streamCompletedRef: React.MutableRefObject<boolean>;

  // Detached state
  setIsDetached: (detached: boolean) => void;

  // Ingest speed
  ingestSpeed: number;
  setIngestSpeed: (speed: number) => void;

  // Dialog controls
  closeIoReaderPicker: () => void;

  // Playback
  playbackSpeed: PlaybackSpeed;

  // Settings for default speeds
  ioProfiles?: Array<{ id: string; connection?: { default_speed?: string } }>;
}

export function useDecoderSessionHandlers({
  reinitialize,
  stop,
  leave,
  rejoin,
  setIoProfile,
  setPlaybackSpeed,
  setMultiBusMode,
  setMultiBusProfiles,
  profileNamesMap,
  startIngest,
  stopIngest,
  isIngesting,
  serialConfig,
  isWatching,
  setIsWatching,
  setWatchFrameCount,
  streamCompletedRef,
  setIsDetached,
  ingestSpeed,
  setIngestSpeed,
  closeIoReaderPicker,
  playbackSpeed,
  ioProfiles,
}: UseDecoderSessionHandlersParams) {
  // Handle Watch for multiple profiles (multi-bus mode)
  // Creates a proper Rust-side merged session that other apps can join
  const handleDialogStartMultiIngest = useCallback(
    async (profileIds: string[], closeDialog: boolean, options: IngestOptions) => {
      const { speed, busMappings } = options;

      if (closeDialog) {
        // Watch mode for multiple buses
        setWatchFrameCount(0);

        const multiSessionId = "decoder-multi";

        try {
          // Use centralized helper to create multi-source session
          await createAndStartMultiSourceSession({
            sessionId: multiSessionId,
            listenerId: "decoder",
            profileIds,
            busMappings,
            profileNames: profileNamesMap,
          });

          // Store source profile IDs for UI display
          setMultiBusProfiles(profileIds);
          setMultiBusMode(false); // Use useIOSession to connect to the merged session

          // Set the multi-source session as the active profile
          // This causes singleSession (useIOSession) to connect to the merged session
          setIoProfile(multiSessionId);

          setPlaybackSpeed(speed as PlaybackSpeed);
          setIsDetached(false); // Reset detached state when starting a new session

          setIsWatching(true);
          streamCompletedRef.current = false;
          closeIoReaderPicker();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`Failed to start multi-bus session '${multiSessionId}':`, msg);
        }
      }
      // Ingest mode not supported for multi-bus
    },
    [
      setIoProfile,
      setMultiBusProfiles,
      setMultiBusMode,
      setPlaybackSpeed,
      profileNamesMap,
      setWatchFrameCount,
      setIsWatching,
      setIsDetached,
      streamCompletedRef,
      closeIoReaderPicker,
    ]
  );

  // Handle starting ingest from the dialog - routes to Watch or Ingest mode based on closeDialog flag
  const handleDialogStartIngest = useCallback(
    async (profileId: string, closeDialog: boolean, options: IngestOptions) => {
      const { speed, startTime, endTime, maxFrames } = options;
      if (closeDialog) {
        // Watch mode - uses decoder session for real-time display
        // reinitialize() uses Rust's atomic check - if other listeners exist,
        // it won't destroy and will return the existing session instead
        await reinitialize(profileId, {
          startTime,
          endTime,
          speed,
          limit: maxFrames,
          // Framing configuration from catalog
          framingEncoding: serialConfig?.encoding as
            | "slip"
            | "modbus_rtu"
            | "delimiter"
            | "raw"
            | undefined,
          // Frame ID extraction
          frameIdStartByte: serialConfig?.frame_id_start_byte,
          frameIdBytes: serialConfig?.frame_id_bytes,
          frameIdBigEndian: serialConfig?.frame_id_byte_order === "big",
          // Source address extraction
          sourceAddressStartByte: serialConfig?.source_address_start_byte,
          sourceAddressBytes: serialConfig?.source_address_bytes,
          sourceAddressBigEndian: serialConfig?.source_address_byte_order === "big",
          // Other options
          minFrameLength: serialConfig?.min_frame_length,
          emitRawBytes: true, // Emit raw bytes for debugging
        });

        setIoProfile(profileId);
        setPlaybackSpeed(speed as PlaybackSpeed);
        setIsDetached(false); // Reset detached state when starting a new session

        // Now start watching
        // Note: reinitialize() already auto-starts the session via the backend,
        // so we don't need to call start() here. Calling start() with the old
        // effectiveSessionId (before React re-render) would restart the wrong session.
        setIsWatching(true);
        setWatchFrameCount(0);
        streamCompletedRef.current = false; // Reset flag when starting playback
        closeIoReaderPicker();
      } else {
        // Ingest mode - uses separate session, no real-time display
        // Update the ingest speed state before starting
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
    [
      setIoProfile,
      reinitialize,
      startIngest,
      setPlaybackSpeed,
      serialConfig,
      ingestSpeed,
      setIngestSpeed,
      setIsWatching,
      setWatchFrameCount,
      setIsDetached,
      streamCompletedRef,
      closeIoReaderPicker,
    ]
  );

  // Handle selecting multiple profiles in multi-bus mode
  // Note: We don't set multiBusMode=true here. Instead, multiBusMode stays false
  // and we create a Rust-side merged session in handleDialogStartMultiIngest.
  const handleSelectMultiple = useCallback(
    (profileIds: string[]) => {
      setMultiBusProfiles(profileIds);
      // Don't set multiBusMode here - let handleDialogStartMultiIngest handle it
      setIoProfile(null); // Clear single profile selection
    },
    [setMultiBusProfiles, setIoProfile]
  );

  // Handle stopping from the dialog - routes to Watch or Ingest stop
  const handleDialogStopIngest = useCallback(async () => {
    if (isWatching) {
      await stop();
      setIsWatching(false);
      // The stream-ended event will handle buffer transition
    } else if (isIngesting) {
      await stopIngest();
    }
  }, [isWatching, isIngesting, stop, stopIngest, setIsWatching]);

  // Watch mode handlers - uses the decoder session for real-time display while buffering
  const handleStopWatch = useCallback(async () => {
    await stop();
    setIsWatching(false);
    // The stream-ended event will handle buffer transition
  }, [stop, setIsWatching]);

  // Detach from shared session without stopping it
  // Keep the profile selected so user can rejoin
  const handleDetach = useCallback(async () => {
    await leave();
    setIsDetached(true);
    setIsWatching(false);
  }, [leave, setIsDetached, setIsWatching]);

  // Rejoin a session after detaching
  const handleRejoin = useCallback(async () => {
    await rejoin();
    setIsDetached(false);
    setIsWatching(true);
  }, [rejoin, setIsDetached, setIsWatching]);

  // Handle IO profile change - only reinitializes for buffer mode
  // For regular profiles, reinitialize is called from handleDialogStartIngest when user clicks Watch
  const handleIoProfileChange = useCallback(
    async (profileId: string | null) => {
      setIoProfile(profileId);
      setIsDetached(false); // Reset detached state when changing profile

      // Handle buffer selection - needs special buffer reader
      if (profileId === "buffer") {
        await reinitialize(undefined, { useBuffer: true, speed: playbackSpeed });
      } else if (profileId && ioProfiles) {
        // Set default speed from the selected profile if it has one
        const profile = ioProfiles.find((p) => p.id === profileId);
        if (profile?.connection?.default_speed) {
          const defaultSpeed = parseFloat(profile.connection.default_speed) as PlaybackSpeed;
          setPlaybackSpeed(defaultSpeed);
        }
        // Don't reinitialize here - useIOSession will handle joining
        // and reinitialize is called from handleDialogStartIngest when Watch is clicked
      }
    },
    [setIoProfile, setIsDetached, reinitialize, playbackSpeed, ioProfiles, setPlaybackSpeed]
  );

  // Handle joining an existing session from IO picker dialog
  const handleJoinSession = useCallback(
    async (profileId: string, sourceProfileIds?: string[]) => {
      // Use centralized helper to join multi-source session
      await joinMultiSourceSession({
        sessionId: profileId,
        listenerId: "decoder",
        sourceProfileIds,
      });

      // Update UI state
      setIoProfile(profileId);
      setMultiBusProfiles(sourceProfileIds || []);
      // Always use single-session mode when joining (even for multi-source sessions)
      setMultiBusMode(false);
      setIsDetached(false);
      // Pass profileId explicitly since React state hasn't updated yet
      // (effectiveSessionId would still have the old value)
      const sessionName =
        sourceProfileIds && sourceProfileIds.length > 1
          ? `Multi-Bus (${sourceProfileIds.length} sources)`
          : profileId;
      rejoin(profileId, sessionName);
      closeIoReaderPicker();
    },
    [
      setIoProfile,
      setMultiBusProfiles,
      setMultiBusMode,
      setIsDetached,
      rejoin,
      closeIoReaderPicker,
    ]
  );

  // Handle skipping IO picker (continue without reader)
  const handleSkip = useCallback(async () => {
    // Clear multi-bus state if active
    setMultiBusMode(false);
    setMultiBusProfiles([]);
    // Leave the session if watching
    if (isWatching) {
      await leave();
      setIsWatching(false);
    }
    // Clear the profile selection
    setIoProfile(null);
    closeIoReaderPicker();
  }, [setMultiBusMode, setMultiBusProfiles, isWatching, leave, setIsWatching, setIoProfile, closeIoReaderPicker]);

  return {
    handleDialogStartIngest,
    handleDialogStartMultiIngest,
    handleSelectMultiple,
    handleDialogStopIngest,
    handleStopWatch,
    handleDetach,
    handleRejoin,
    handleIoProfileChange,
    handleJoinSession,
    handleSkip,
  };
}

export type DecoderSessionHandlers = ReturnType<typeof useDecoderSessionHandlers>;
