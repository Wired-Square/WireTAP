// ui/src/apps/discovery/hooks/handlers/useDiscoveryPlaybackHandlers.ts
//
// Playback-related handlers for Discovery: play, pause, stop, speed change, scrub, time range.
// Uses shared usePlaybackHandlers for play/pause/stop/step consistency with Decoder.

import { useCallback } from "react";
import { usePlaybackHandlers } from "../../../../hooks/usePlaybackHandlers";
import type { PlaybackSpeed } from "../../../../stores/discoveryStore";
import { localToUtc } from "../../../../utils/timeFormat";

export interface UseDiscoveryPlaybackHandlersParams {
  // Session ID for direction control
  sessionId: string;

  // Session actions (for shared playback handlers)
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  setTimeRange: (start: string, end: string) => Promise<void>;
  seekByFrame: (frameIndex: number) => Promise<void>;

  // Reader state
  isPaused: boolean;
  isStreaming: boolean;
  sessionReady: boolean;
  isBufferMode?: boolean;

  // Current position (for step operations)
  currentFrameIndex?: number | null;
  currentTimestampUs?: number | null;

  // Selected frame IDs for filtering step operations
  selectedFrameIds?: Set<number>;

  // Time range state
  startTime: string;
  endTime: string;
  pendingSpeed: PlaybackSpeed | null;

  // State setters
  setPendingSpeed: (speed: PlaybackSpeed | null) => void;
  setActiveBookmarkId: (id: string | null) => void;

  // Store actions
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime: (time: number) => void;
  setCurrentFrameIndex?: (index: number) => void;
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;
  clearBuffer: () => void;
  clearFramePicker: () => void;

  // Discovery-specific: reset frame count before starting
  resetWatchFrameCount: () => void;

  // Dialog controls
  closeSpeedChangeDialog: () => void;
}

export function useDiscoveryPlaybackHandlers({
  sessionId,
  start,
  stop,
  pause,
  resume,
  setSpeed,
  setTimeRange,
  seekByFrame,
  isPaused,
  isStreaming,
  sessionReady,
  isBufferMode,
  currentFrameIndex,
  currentTimestampUs,
  selectedFrameIds,
  startTime,
  endTime,
  pendingSpeed,
  setPendingSpeed,
  setActiveBookmarkId,
  setPlaybackSpeed,
  updateCurrentTime,
  setCurrentFrameIndex,
  setStartTime,
  setEndTime,
  clearBuffer,
  clearFramePicker,
  resetWatchFrameCount,
  closeSpeedChangeDialog,
}: UseDiscoveryPlaybackHandlersParams) {
  // Use shared playback handlers for play/pause/stop/step consistency
  const sharedHandlers = usePlaybackHandlers({
    sessionId,
    start,
    stop,
    pause,
    resume,
    setSpeed,
    isPaused,
    isStreaming,
    sessionReady,
    isBufferMode,
    currentFrameIndex,
    currentTimestampUs,
    selectedFrameIds,
    setPlaybackSpeed,
    updateCurrentTime,
    setCurrentFrameIndex,
    onBeforeStart: () => {
      resetWatchFrameCount();
    },
  });

  // Handle speed change (overrides shared handler to match Discovery's implementation)
  const handleSpeedChange = useCallback(async (speed: number) => {
    setPlaybackSpeed(speed as PlaybackSpeed);
    await setSpeed(speed);
  }, [setPlaybackSpeed, setSpeed]);

  // Confirm speed change (clears frames)
  const confirmSpeedChange = useCallback(async () => {
    if (pendingSpeed !== null) {
      clearBuffer();
      clearFramePicker();
      setPlaybackSpeed(pendingSpeed);
      await setSpeed(pendingSpeed);
      setPendingSpeed(null);
    }
    closeSpeedChangeDialog();
  }, [pendingSpeed, clearBuffer, clearFramePicker, setPlaybackSpeed, setSpeed, setPendingSpeed, closeSpeedChangeDialog]);

  // Cancel speed change
  const cancelSpeedChange = useCallback(() => {
    setPendingSpeed(null);
    closeSpeedChangeDialog();
  }, [setPendingSpeed, closeSpeedChangeDialog]);

  // Handle time range changes
  const handleStartTimeChange = useCallback(async (time: string) => {
    setStartTime(time);
    setActiveBookmarkId(null);
    const startUtc = localToUtc(time);
    const endUtc = localToUtc(endTime);
    if (startUtc && endUtc) {
      await setTimeRange(startUtc, endUtc);
    }
  }, [setStartTime, setActiveBookmarkId, setTimeRange, endTime]);

  const handleEndTimeChange = useCallback(async (time: string) => {
    setEndTime(time);
    setActiveBookmarkId(null);
    const startUtc = localToUtc(startTime);
    const endUtc = localToUtc(time);
    if (startUtc && endUtc) {
      await setTimeRange(startUtc, endUtc);
    }
  }, [setEndTime, setActiveBookmarkId, setTimeRange, startTime]);

  // Handle timeline scrubber position change (timestamp-based)
  const handleScrub = useCallback((timeUs: number) => {
    updateCurrentTime(timeUs / 1_000_000);
  }, [updateCurrentTime]);

  // Handle frame-based position change (preferred for buffer playback)
  const handleFrameChange = useCallback(async (frameIndex: number) => {
    // Update local state immediately for responsiveness
    setCurrentFrameIndex?.(frameIndex);
    // Tell the session to seek to this frame
    await seekByFrame(frameIndex);
  }, [setCurrentFrameIndex, seekByFrame]);

  return {
    // From shared handlers
    handlePlay: sharedHandlers.handlePlay,
    handlePlayBackward: sharedHandlers.handlePlayBackward,
    handleStop: sharedHandlers.handleStop,
    handlePause: sharedHandlers.handlePause,
    handleStepBackward: sharedHandlers.handleStepBackward,
    handleStepForward: sharedHandlers.handleStepForward,
    // Discovery-specific handlers
    handleSpeedChange,
    confirmSpeedChange,
    cancelSpeedChange,
    handleStartTimeChange,
    handleEndTimeChange,
    handleScrub,
    handleFrameChange,
  };
}

export type DiscoveryPlaybackHandlers = ReturnType<typeof useDiscoveryPlaybackHandlers>;
