// src/hooks/usePlaybackHandlers.ts
//
// Shared playback handlers for Discovery and Decoder.
// Handles play/pause/stop/speed/direction control for timeline readers.

import { useCallback } from "react";
import type { PlaybackSpeed } from "../components/TimeController";
import { stepBufferFrame, updateReaderDirection } from "../api/io";
import { tlog } from "../api/settings";

export interface UsePlaybackHandlersParams {
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

  // Current position (for step operations) - need either frame index or timestamp
  currentFrameIndex?: number | null;
  currentTimestampUs?: number | null;

  // Selected frame IDs for filtering step operations
  selectedFrameIds?: Set<number>;

  // Store actions
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime?: (timeSeconds: number) => void;
  setCurrentFrameIndex?: (index: number) => void;

  // Optional: callback before starting playback
  onBeforeStart?: () => void;
}

export function usePlaybackHandlers({
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
  onBeforeStart,
}: UsePlaybackHandlersParams) {
  // Handle play forward button click
  const handlePlay = useCallback(async () => {
    // Set direction to forward
    try {
      await updateReaderDirection(sessionId, false);
    } catch (e) {
      // Continue anyway - forward is the default
    }

    if (isPaused) {
      await resume();
    } else if (!isStreaming && sessionReady) {
      // In buffer mode, start() begins buffer playback (reader is stopped, not paused)
      // In live mode, start() begins live capture
      // Either way, we call start() when not streaming
      onBeforeStart?.();
      await start();
    }
  }, [sessionId, isPaused, isStreaming, sessionReady, resume, start, onBeforeStart]);

  // Handle play backward button click
  const handlePlayBackward = useCallback(async () => {
    // Set direction to reverse
    try {
      await updateReaderDirection(sessionId, true);
    } catch (e) {
      tlog.debug(`[PlaybackHandlers] Failed to set direction: ${e}`);
      return;
    }

    if (isPaused) {
      await resume();
    } else if (!isStreaming && sessionReady) {
      // In buffer mode, start() begins buffer playback (reader is stopped, not paused)
      // In live mode, start() begins live capture
      // Either way, we call start() when not streaming
      onBeforeStart?.();
      await start();
    }
  }, [sessionId, isPaused, isStreaming, sessionReady, resume, start, onBeforeStart]);

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

  // Handle step backward (one frame earlier, respecting filter)
  const handleStepBackward = useCallback(async () => {
    tlog.debug(`[PlaybackHandlers] handleStepBackward called ${JSON.stringify({ isPaused, currentFrameIndex, currentTimestampUs, sessionId })}`);

    // Allow stepping when paused, or when stopped (before first play / after completion)
    const canStep = isPaused || isStopped;
    if (!canStep || (currentFrameIndex == null && currentTimestampUs == null)) {
      tlog.debug('[PlaybackHandlers] handleStepBackward early return - guard condition met');
      return;
    }
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
      tlog.debug(`[PlaybackHandlers] Failed to step backward: ${e}`);
    }
  }, [sessionId, isPaused, isStopped, currentFrameIndex, currentTimestampUs, selectedFrameIds, setCurrentFrameIndex, updateCurrentTime]);

  // Handle step forward (one frame later, respecting filter)
  const handleStepForward = useCallback(async () => {
    tlog.debug(`[PlaybackHandlers] handleStepForward called ${JSON.stringify({ isPaused, currentFrameIndex, currentTimestampUs, sessionId })}`);

    // Allow stepping when paused, or when stopped (before first play / after completion)
    const canStep = isPaused || isStopped;
    if (!canStep || (currentFrameIndex == null && currentTimestampUs == null)) {
      tlog.debug('[PlaybackHandlers] handleStepForward early return - guard condition met');
      return;
    }
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
      tlog.debug(`[PlaybackHandlers] Failed to step forward: ${e}`);
    }
  }, [sessionId, isPaused, isStopped, currentFrameIndex, currentTimestampUs, selectedFrameIds, setCurrentFrameIndex, updateCurrentTime]);

  return {
    handlePlay,
    handlePlayBackward,
    handleStop,
    handlePause,
    handleSpeedChange,
    handleStepBackward,
    handleStepForward,
  };
}

export type PlaybackHandlers = ReturnType<typeof usePlaybackHandlers>;
