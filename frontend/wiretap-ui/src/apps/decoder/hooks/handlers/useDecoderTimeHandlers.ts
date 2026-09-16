// ui/src/apps/decoder/hooks/handlers/useDecoderTimeHandlers.ts
//
// Time-related handlers for Decoder: wraps shared useTimeHandlers + keeps handleScrub.

import { useCallback } from "react";
import { useTimeHandlers } from "../../../../hooks/useTimeHandlers";
import type { IOCapabilities } from "../../../../api/io";
import type { TimeRangeFavorite } from "../../../../utils/favorites";
import type { LoadOptions } from "../../../../hooks/useIOSessionManager";

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
  jumpToBookmark: (bookmark: TimeRangeFavorite, options?: Omit<LoadOptions, "startTime" | "endTime" | "maxFrames">) => Promise<void>;
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
  // Shared handlers: time range, frame change, bookmark load
  const shared = useTimeHandlers({
    setTimeRange,
    seekByFrame,
    capabilities,
    setCurrentFrameIndex,
    startTime,
    endTime,
    setActiveBookmarkId,
    jumpToBookmark,
  });

  // Decoder-specific: timeline scrubber with boundary frame index calculation
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

  return {
    ...shared,
    handleScrub,
  };
}

export type DecoderTimeHandlers = ReturnType<typeof useDecoderTimeHandlers>;
