// ui/src/apps/discovery/hooks/handlers/useDiscoveryPlaybackHandlers.ts
//
// Playback-related handlers for Discovery: play, pause, stop, speed change, scrub, time range.

import { useCallback } from "react";
import type { PlaybackSpeed } from "../../../../stores/discoveryStore";
import { localToUtc } from "../../../../utils/timeFormat";

export interface UseDiscoveryPlaybackHandlersParams {
  // State
  startTime: string;
  endTime: string;
  pendingSpeed: PlaybackSpeed | null;

  // State setters
  setPendingSpeed: (speed: PlaybackSpeed | null) => void;
  setActiveBookmarkId: (id: string | null) => void;

  // Store actions
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime: (time: number) => void;
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;
  clearBuffer: () => void;
  clearFramePicker: () => void;

  // Session actions
  setSpeed: (speed: number) => Promise<void>;
  setTimeRange: (start: string, end: string) => Promise<void>;

  // Dialog controls
  closeSpeedChangeDialog: () => void;
}

export function useDiscoveryPlaybackHandlers({
  startTime,
  endTime,
  pendingSpeed,
  setPendingSpeed,
  setActiveBookmarkId,
  setPlaybackSpeed,
  updateCurrentTime,
  setStartTime,
  setEndTime,
  clearBuffer,
  clearFramePicker,
  setSpeed,
  setTimeRange,
  closeSpeedChangeDialog,
}: UseDiscoveryPlaybackHandlersParams) {
  // Handle speed change
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

  // Handle timeline scrubber position change
  const handleScrub = useCallback((timeUs: number) => {
    updateCurrentTime(timeUs / 1_000_000);
  }, [updateCurrentTime]);

  return {
    handleSpeedChange,
    confirmSpeedChange,
    cancelSpeedChange,
    handleStartTimeChange,
    handleEndTimeChange,
    handleScrub,
  };
}

export type DiscoveryPlaybackHandlers = ReturnType<typeof useDiscoveryPlaybackHandlers>;
