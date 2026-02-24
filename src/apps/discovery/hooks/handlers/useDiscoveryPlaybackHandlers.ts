// ui/src/apps/discovery/hooks/handlers/useDiscoveryPlaybackHandlers.ts
//
// Playback-related handlers for Discovery: play, pause, stop, speed change, scrub.
// Time range and frame change handlers are now in shared useTimeHandlers.
// Uses shared usePlaybackHandlers for play/pause/stop/step consistency with Decoder.

import { useCallback } from "react";
import { usePlaybackHandlers } from "../../../../hooks/usePlaybackHandlers";
import type { PlaybackSpeed } from "../../../../stores/discoveryStore";

export interface UseDiscoveryPlaybackHandlersParams {
  // Session ID for direction control
  sessionId: string;

  // Session actions (for shared playback handlers)
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  seek: (timestampUs: number) => Promise<void>;

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

  // Speed change state
  pendingSpeed: PlaybackSpeed | null;

  // State setters
  setPendingSpeed: (speed: PlaybackSpeed | null) => void;

  // Store actions
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime: (time: number) => void;
  setCurrentFrameIndex?: (index: number) => void;
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
  seek,
  isPaused,
  isStreaming,
  sessionReady,
  isStopped,
  currentFrameIndex,
  currentTimestampUs,
  selectedFrameIds,
  pendingSpeed,
  setPendingSpeed,
  setPlaybackSpeed,
  updateCurrentTime,
  setCurrentFrameIndex,
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
    isStopped,
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

  // Discovery-specific: timeline scrubber with try/catch
  const handleScrub = useCallback(async (timeUs: number) => {
    // Update local state immediately for responsiveness
    updateCurrentTime(timeUs / 1_000_000);
    // Tell the session to seek to this timestamp
    try {
      await seek(timeUs);
    } catch (e) {
      console.error('[Discovery] Failed to seek to timestamp:', e);
    }
  }, [updateCurrentTime, seek]);

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
    handleScrub,
  };
}

export type DiscoveryPlaybackHandlers = ReturnType<typeof useDiscoveryPlaybackHandlers>;
