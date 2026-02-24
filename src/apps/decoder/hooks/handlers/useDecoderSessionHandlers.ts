// ui/src/apps/decoder/hooks/handlers/useDecoderSessionHandlers.ts
//
// Session-related handlers for Decoder: stop watch, IO profile change.
// Dialog handlers (start/stop ingest, join, skip, multi-select) are now
// centralised in useIOPickerHandlers.

import { useCallback } from "react";
import type { PlaybackSpeed } from "../../../../components/TimeController";
import { isBufferProfileId, type IngestOptions } from "../../../../hooks/useIOSessionManager";
import { useBufferSession } from "../../../../hooks/useBufferSession";
import type { BufferMetadata } from "../../../../api/buffer";

export interface UseDecoderSessionHandlersParams {
  // Manager session switching methods
  stopWatch: () => Promise<void>;
  selectProfile: (profileId: string | null) => void;
  watchSingleSource: (profileId: string, options: IngestOptions) => Promise<void>;

  // Playback (for buffer session speed)
  playbackSpeed: PlaybackSpeed;

  // Buffer state (for centralized buffer handler)
  setBufferMetadata: (meta: BufferMetadata | null) => void;
  updateCurrentTime: (timeSeconds: number) => void;
  setCurrentFrameIndex: (index: number) => void;
}

export function useDecoderSessionHandlers({
  stopWatch,
  selectProfile,
  watchSingleSource,
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

  // Watch mode handlers - uses the decoder session for real-time display while buffering
  const handleStopWatch = useCallback(async () => {
    await stopWatch();
    // The stream-ended event will handle buffer transition
  }, [stopWatch]);

  // Handle IO profile change - manager handles common logic, app handles buffer mode
  const handleIoProfileChange = useCallback(
    async (profileId: string | null) => {
      if (isBufferProfileId(profileId)) {
        // Create a proper session for the buffer so it appears in the session manager
        // and has playback/timeline controls
        await watchSingleSource(profileId!, { speed: playbackSpeed });
        // Load buffer metadata for the UI
        await switchToBuffer(profileId!);
      } else {
        // Manager handles: clear multi-bus, set profile, default speed
        selectProfile(profileId);
      }
    },
    [selectProfile, watchSingleSource, switchToBuffer, playbackSpeed]
  );

  return {
    handleStopWatch,
    handleIoProfileChange,
  };
}

export type DecoderSessionHandlers = ReturnType<typeof useDecoderSessionHandlers>;
