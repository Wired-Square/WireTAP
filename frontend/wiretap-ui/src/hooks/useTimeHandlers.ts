// src/hooks/useTimeHandlers.ts
//
// Shared time-related handlers for Decoder and Discovery:
// time range changes, frame-based seeking, and bookmark loading.

import { useCallback } from "react";
import { localToUtc } from "../utils/timeFormat";
import type { TimeRangeFavorite } from "../utils/favorites";
import type { IOCapabilities } from "../api/io";
import type { LoadOptions } from "./useIOSessionManager";

export interface UseTimeHandlersParams {
  // Session actions
  setTimeRange: (start: string, end: string) => Promise<void>;
  seekByFrame: (frameIndex: number) => Promise<void>;

  // Optional: capabilities for seek guard on handleFrameChange.
  // When omitted, handleFrameChange always seeks (Discovery pattern).
  // When provided, guards with supports_seek (Decoder pattern).
  capabilities?: IOCapabilities | null;

  // Store actions
  setCurrentFrameIndex?: (index: number) => void;

  // Current time range values (for the "other" end of the range)
  startTime: string;
  endTime: string;

  // Bookmark state
  setActiveBookmarkId: (id: string | null) => void;

  // Manager method for jumping to bookmarks
  jumpToBookmark: (
    bookmark: TimeRangeFavorite,
    options?: Omit<LoadOptions, "startTime" | "endTime" | "maxFrames">
  ) => Promise<void>;

  // Optional callbacks for app-specific side effects before the backend call
  onStartTimeChange?: (time: string) => void;
  onEndTimeChange?: (time: string) => void;
}

export function useTimeHandlers({
  setTimeRange,
  seekByFrame,
  capabilities,
  setCurrentFrameIndex,
  startTime,
  endTime,
  setActiveBookmarkId,
  jumpToBookmark,
  onStartTimeChange,
  onEndTimeChange,
}: UseTimeHandlersParams) {
  // Handle start time change — clears bookmark, optionally updates local state,
  // converts to UTC with null-check, then sets range on session
  const handleStartTimeChange = useCallback(
    async (time: string) => {
      onStartTimeChange?.(time);
      setActiveBookmarkId(null);
      const startUtc = localToUtc(time);
      const endUtc = localToUtc(endTime);
      if (startUtc && endUtc) {
        await setTimeRange(startUtc, endUtc);
      }
    },
    [onStartTimeChange, setActiveBookmarkId, setTimeRange, endTime]
  );

  // Handle end time change — mirror of handleStartTimeChange
  const handleEndTimeChange = useCallback(
    async (time: string) => {
      onEndTimeChange?.(time);
      setActiveBookmarkId(null);
      const startUtc = localToUtc(startTime);
      const endUtc = localToUtc(time);
      if (startUtc && endUtc) {
        await setTimeRange(startUtc, endUtc);
      }
    },
    [onEndTimeChange, setActiveBookmarkId, setTimeRange, startTime]
  );

  // Handle frame-based position change (preferred for buffer playback).
  // When capabilities is provided, guards seekByFrame behind supports_seek.
  const handleFrameChange = useCallback(
    async (frameIndex: number) => {
      setCurrentFrameIndex?.(frameIndex);
      if (!capabilities || capabilities.supports_seek) {
        await seekByFrame(frameIndex);
      }
    },
    [setCurrentFrameIndex, capabilities, seekByFrame]
  );

  // Handle loading a bookmark — delegates to manager's jumpToBookmark
  const handleLoadBookmark = useCallback(
    async (bookmark: TimeRangeFavorite) => {
      console.log("[TimeHandlers:handleLoadBookmark] Delegating to manager.jumpToBookmark:", bookmark.name);
      await jumpToBookmark(bookmark);
    },
    [jumpToBookmark]
  );

  return {
    handleStartTimeChange,
    handleEndTimeChange,
    handleFrameChange,
    handleLoadBookmark,
  };
}

export type TimeHandlers = ReturnType<typeof useTimeHandlers>;
