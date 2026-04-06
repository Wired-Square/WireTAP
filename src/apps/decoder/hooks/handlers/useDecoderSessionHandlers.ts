// ui/src/apps/decoder/hooks/handlers/useDecoderSessionHandlers.ts
//
// Session-related handlers for Decoder: stop watch, IO profile change.
// Dialog handlers (start/stop load, join, skip, multi-select) are now
// centralised in useIOSourcePickerHandlers.

import { useCallback } from "react";
import type { PlaybackSpeed } from "../../../../components/TimeController";
import { isCaptureProfileId, type LoadOptions } from "../../../../hooks/useIOSessionManager";
import { useCaptureSession } from "../../../../hooks/useCaptureSession";
import type { CaptureMetadata } from "../../../../api/capture";

export interface UseDecoderSessionHandlersParams {
  // Manager session switching methods
  stopWatch: () => Promise<void>;
  selectProfile: (profileId: string | null) => void;
  watchSource: (profileIds: string[], options: LoadOptions) => Promise<void>;

  // Playback (for buffer session speed)
  playbackSpeed: PlaybackSpeed;

  // Buffer state (for centralized buffer handler)
  setCaptureMetadata: (meta: CaptureMetadata | null) => void;
  updateCurrentTime: (timeSeconds: number) => void;
  setCurrentFrameIndex: (index: number) => void;
}

export function useDecoderSessionHandlers({
  stopWatch,
  selectProfile,
  watchSource,
  playbackSpeed,
  setCaptureMetadata,
  updateCurrentTime,
  setCurrentFrameIndex,
}: UseDecoderSessionHandlersParams) {
  // Centralized buffer session handler
  const { switchToCapture } = useCaptureSession({
    setCaptureMetadata,
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
      if (isCaptureProfileId(profileId)) {
        // Create a proper session for the buffer so it appears in the session manager
        // and has playback controls
        await watchSource([profileId!], { speed: playbackSpeed });
        // Load buffer metadata for the UI
        await switchToCapture(profileId!);
      } else {
        // Manager handles: clear multi-bus, set profile, default speed
        selectProfile(profileId);
      }
    },
    [selectProfile, watchSource, switchToCapture, playbackSpeed]
  );

  return {
    handleStopWatch,
    handleIoProfileChange,
  };
}

export type DecoderSessionHandlers = ReturnType<typeof useDecoderSessionHandlers>;
