// ui/src/apps/decoder/hooks/handlers/useDecoderPlaybackHandlers.ts
//
// Playback-related handlers for Decoder, using shared playback handlers.

import { usePlaybackHandlers } from "../../../../hooks/usePlaybackHandlers";
import type { PlaybackSpeed } from "../../../../components/TimeController";

export interface UseDecoderPlaybackHandlersParams {
  // Session ID for direction control
  sessionId: string;

  // Session actions
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;

  // Reader state
  isPaused: boolean;
  isStreaming: boolean;
  sessionReady: boolean;
  isStopped?: boolean;

  // Current position (for step operations)
  currentFrameIndex?: number | null;
  currentTimestampUs?: number | null;

  // Selected frame IDs for filtering step operations
  selectedFrameIds?: Set<number>;

  // Store actions
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime?: (timeSeconds: number) => void;
  setCurrentFrameIndex?: (index: number) => void;

  // Stream completed ref
  streamCompletedRef: React.MutableRefObject<boolean>;
}

export function useDecoderPlaybackHandlers({
  sessionId,
  start,
  stop,
  pause,
  resume,
  setSpeed,
  isPaused,
  isStreaming,
  sessionReady,
  isStopped,
  currentFrameIndex,
  currentTimestampUs,
  selectedFrameIds,
  setPlaybackSpeed,
  updateCurrentTime,
  setCurrentFrameIndex,
  streamCompletedRef,
}: UseDecoderPlaybackHandlersParams) {
  return usePlaybackHandlers({
    sessionId,
    start,
    stop,
    pause,
    resume,
    setSpeed,
    isPaused,
    isStreaming,
    sessionReady,
    isStopped,
    currentFrameIndex,
    currentTimestampUs,
    selectedFrameIds,
    setPlaybackSpeed,
    updateCurrentTime,
    setCurrentFrameIndex,
    onBeforeStart: () => {
      streamCompletedRef.current = false;
    },
  });
}

export type DecoderPlaybackHandlers = ReturnType<typeof useDecoderPlaybackHandlers>;
