// ui/src/apps/decoder/hooks/handlers/useDecoderTimeHandlers.ts
//
// Time-related handlers for Decoder: scrub, start/end time change, load bookmark.

import { useCallback } from "react";
import { localToUtc } from "../../../../utils/timeFormat";
import { markFavoriteUsed, type TimeRangeFavorite } from "../../../../utils/favorites";
import type { IOCapabilities } from "../../../../api/io";

export interface UseDecoderTimeHandlersParams {
  // Session actions
  setTimeRange: (start?: string, end?: string) => Promise<void>;
  seek: (timeUs: number) => Promise<void>;
  reinitialize: (profileId?: string, options?: { startTime?: string; endTime?: string; limit?: number }) => Promise<void>;

  // Session state
  ioProfile: string | null;

  // Capabilities
  capabilities: IOCapabilities | null;

  // Store actions
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;
  updateCurrentTime: (time: number) => void;
  setCurrentFrameIndex?: (index: number) => void;

  // Current time range values for setTimeRange calls
  startTime: string;
  endTime: string;

  // Buffer bounds for frame index calculation
  minTimeUs?: number | null;
  maxTimeUs?: number | null;
  totalFrames?: number | null;

  // Bookmark state
  setActiveBookmarkId: (id: string | null) => void;
}

export function useDecoderTimeHandlers({
  setTimeRange,
  seek,
  reinitialize,
  ioProfile,
  capabilities,
  setStartTime,
  setEndTime,
  updateCurrentTime,
  setCurrentFrameIndex,
  startTime,
  endTime,
  minTimeUs,
  maxTimeUs,
  totalFrames,
  setActiveBookmarkId,
}: UseDecoderTimeHandlersParams) {
  // Handle time range changes
  const handleStartTimeChange = useCallback(
    async (time: string) => {
      setStartTime(time);
      setActiveBookmarkId(null); // Clear bookmark when time changes
      await setTimeRange(localToUtc(time), localToUtc(endTime));
    },
    [setStartTime, setActiveBookmarkId, setTimeRange, endTime]
  );

  const handleEndTimeChange = useCallback(
    async (time: string) => {
      setEndTime(time);
      setActiveBookmarkId(null); // Clear bookmark when time changes
      await setTimeRange(localToUtc(startTime), localToUtc(time));
    },
    [setEndTime, setActiveBookmarkId, setTimeRange, startTime]
  );

  // Handle timeline scrubber position change
  const handleScrub = useCallback(
    async (timeUs: number) => {
      // Update UI immediately for responsiveness
      updateCurrentTime(timeUs / 1_000_000); // Convert microseconds to seconds

      // Update frame index when seeking to boundaries
      if (setCurrentFrameIndex && minTimeUs != null && maxTimeUs != null && totalFrames != null && totalFrames > 0) {
        if (timeUs <= minTimeUs) {
          // Skip to start - set frame index to 0
          setCurrentFrameIndex(0);
        } else if (timeUs >= maxTimeUs) {
          // Skip to end - set frame index to last frame
          setCurrentFrameIndex(totalFrames - 1);
        }
        // For other positions, frame index will be updated when playback resumes
      }

      // If the reader supports seeking, tell it to jump to this position
      if (capabilities?.supports_seek) {
        await seek(timeUs);
      }
    },
    [updateCurrentTime, setCurrentFrameIndex, minTimeUs, maxTimeUs, totalFrames, capabilities, seek]
  );

  // Handle loading a bookmark (sets time range and marks bookmark as active)
  const handleLoadBookmark = useCallback(
    async (bookmark: TimeRangeFavorite) => {
      setStartTime(bookmark.startTime);
      setEndTime(bookmark.endTime);
      setActiveBookmarkId(bookmark.id);

      const startUtc = localToUtc(bookmark.startTime);
      const endUtc = localToUtc(bookmark.endTime);

      // If bookmark has maxFrames, we need to reinitialize to apply the limit
      if (bookmark.maxFrames && ioProfile) {
        await reinitialize(ioProfile, { startTime: startUtc, endTime: endUtc, limit: bookmark.maxFrames });
      } else {
        await setTimeRange(startUtc, endUtc);
      }

      await markFavoriteUsed(bookmark.id);
    },
    [setStartTime, setEndTime, setActiveBookmarkId, setTimeRange, reinitialize, ioProfile]
  );

  return {
    handleStartTimeChange,
    handleEndTimeChange,
    handleScrub,
    handleLoadBookmark,
  };
}

export type DecoderTimeHandlers = ReturnType<typeof useDecoderTimeHandlers>;
