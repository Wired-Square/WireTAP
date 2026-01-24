// ui/src/apps/decoder/hooks/handlers/useDecoderPlaybackHandlers.ts
//
// Playback-related handlers for Decoder: play, pause, stop, speed change.

import { useCallback } from "react";
import type { PlaybackSpeed } from "../../../../components/TimeController";

export interface UseDecoderPlaybackHandlersParams {
  // Session actions
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;

  // Reader state
  isPaused: boolean;

  // Store actions
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;

  // Stream completed ref
  streamCompletedRef: React.MutableRefObject<boolean>;
}

export function useDecoderPlaybackHandlers({
  start,
  stop,
  pause,
  resume,
  setSpeed,
  isPaused,
  setPlaybackSpeed,
  streamCompletedRef,
}: UseDecoderPlaybackHandlersParams) {
  // Handle play/resume button click
  const handlePlay = useCallback(async () => {
    if (isPaused) {
      await resume();
    } else {
      streamCompletedRef.current = false; // Reset flag when starting playback
      await start();
    }
  }, [isPaused, resume, start, streamCompletedRef]);

  // Handle stop button click
  const handleStop = useCallback(async () => {
    await stop();
  }, [stop]);

  // Handle pause button click
  const handlePause = useCallback(async () => {
    await pause();
  }, [pause]);

  // Handle speed change
  const handleSpeedChange = useCallback(
    async (speed: number) => {
      setPlaybackSpeed(speed as PlaybackSpeed);
      await setSpeed(speed);
    },
    [setPlaybackSpeed, setSpeed]
  );

  return {
    handlePlay,
    handleStop,
    handlePause,
    handleSpeedChange,
  };
}

export type DecoderPlaybackHandlers = ReturnType<typeof useDecoderPlaybackHandlers>;
