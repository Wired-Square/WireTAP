// ui/src/apps/decoder/hooks/handlers/useDecoderTimeHandlers.ts
//
// Time-related handlers for Decoder: scrub, start/end time change, load bookmark.

import { useCallback } from "react";
import { localToUtc } from "../../../../utils/timeFormat";
import type { TimeRangeFavorite } from "../../../../utils/favorites";
import type { IOCapabilities } from "../../../../api/io";
import type { IngestOptions } from "../../../../hooks/useIOSessionManager";

export interface UseDecoderTimeHandlersParams {
  // Session actions
  setTimeRange: (start?: string, end?: string) => Promise<void>;
  seek: (timeUs: number) => Promise<void>;
  seekByFrame: (frameIndex: number) => Promise<void>;

  // Capabilities
  capabilities: IOCapabilities | null;

  // Store actions
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

  // Manager method for jumping to bookmarks
  jumpToBookmark: (bookmark: TimeRangeFavorite, options?: Omit<IngestOptions, "startTime" | "endTime" | "maxFrames">) => Promise<void>;
}

export function useDecoderTimeHandlers({
  setTimeRange,
  seek,
  seekByFrame,
  capabilities,
  updateCurrentTime,
  setCurrentFrameIndex,
  startTime,
  endTime,
  minTimeUs,
  maxTimeUs,
  totalFrames,
  setActiveBookmarkId,
  jumpToBookmark,
}: UseDecoderTimeHandlersParams) {
  // Handle time range changes
  const handleStartTimeChange = useCallback(
    async (time: string) => {
      setActiveBookmarkId(null); // Clear bookmark when time changes
      await setTimeRange(localToUtc(time), localToUtc(endTime));
    },
    [setActiveBookmarkId, setTimeRange, endTime]
  );

  const handleEndTimeChange = useCallback(
    async (time: string) => {
      setActiveBookmarkId(null); // Clear bookmark when time changes
      await setTimeRange(localToUtc(startTime), localToUtc(time));
    },
    [setActiveBookmarkId, setTimeRange, startTime]
  );

  // Handle timeline scrubber position change (timestamp-based - legacy)
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

  // Handle frame-based position change (preferred for buffer playback)
  const handleFrameChange = useCallback(
    async (frameIndex: number) => {
      // Update UI immediately for responsiveness
      setCurrentFrameIndex?.(frameIndex);

      // If the reader supports seeking, tell it to jump to this frame
      if (capabilities?.supports_seek) {
        await seekByFrame(frameIndex);
      }
    },
    [setCurrentFrameIndex, capabilities, seekByFrame]
  );

  // Handle loading a bookmark - delegates to manager's jumpToBookmark
  // The manager handles: stopping if streaming, cleanup, reinitialize, notify apps
  const handleLoadBookmark = useCallback(
    async (bookmark: TimeRangeFavorite) => {
      console.log("[Decoder:handleLoadBookmark] Delegating to manager.jumpToBookmark:", bookmark.name);
      await jumpToBookmark(bookmark);
    },
    [jumpToBookmark]
  );

  return {
    handleStartTimeChange,
    handleEndTimeChange,
    handleScrub,
    handleFrameChange,
    handleLoadBookmark,
  };
}

export type DecoderTimeHandlers = ReturnType<typeof useDecoderTimeHandlers>;
