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

  // Capabilities
  capabilities: IOCapabilities | null;

  // Store actions
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;
  updateCurrentTime: (time: number) => void;

  // Current time range values for setTimeRange calls
  startTime: string;
  endTime: string;

  // Bookmark state
  setActiveBookmarkId: (id: string | null) => void;
}

export function useDecoderTimeHandlers({
  setTimeRange,
  seek,
  capabilities,
  setStartTime,
  setEndTime,
  updateCurrentTime,
  startTime,
  endTime,
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

      // If the reader supports seeking, tell it to jump to this position
      if (capabilities?.supports_seek) {
        await seek(timeUs);
      }
    },
    [updateCurrentTime, capabilities, seek]
  );

  // Handle loading a bookmark (sets time range and marks bookmark as active)
  const handleLoadBookmark = useCallback(
    async (bookmark: TimeRangeFavorite) => {
      setStartTime(bookmark.startTime);
      setEndTime(bookmark.endTime);
      setActiveBookmarkId(bookmark.id);
      await setTimeRange(localToUtc(bookmark.startTime), localToUtc(bookmark.endTime));
      await markFavoriteUsed(bookmark.id);
    },
    [setStartTime, setEndTime, setActiveBookmarkId, setTimeRange]
  );

  return {
    handleStartTimeChange,
    handleEndTimeChange,
    handleScrub,
    handleLoadBookmark,
  };
}

export type DecoderTimeHandlers = ReturnType<typeof useDecoderTimeHandlers>;
