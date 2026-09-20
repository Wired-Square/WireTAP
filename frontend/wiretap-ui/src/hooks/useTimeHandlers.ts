// src/hooks/useTimeHandlers.ts
//
// Shared time-related handlers for Decoder and Discovery:
// time range changes and frame-based seeking.

import { useCallback } from "react";
import { localToUtc } from "../utils/timeFormat";
import type { IOCapabilities } from "../api/io";

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
  onStartTimeChange,
  onEndTimeChange,
}: UseTimeHandlersParams) {
  // Handle start time change — optionally updates local state,
  // converts to UTC with null-check, then sets range on session
  const handleStartTimeChange = useCallback(
    async (time: string) => {
      onStartTimeChange?.(time);
      const startUtc = localToUtc(time);
      const endUtc = localToUtc(endTime);
      if (startUtc && endUtc) {
        await setTimeRange(startUtc, endUtc);
      }
    },
    [onStartTimeChange, setTimeRange, endTime]
  );

  // Handle end time change — mirror of handleStartTimeChange
  const handleEndTimeChange = useCallback(
    async (time: string) => {
      onEndTimeChange?.(time);
      const startUtc = localToUtc(startTime);
      const endUtc = localToUtc(time);
      if (startUtc && endUtc) {
        await setTimeRange(startUtc, endUtc);
      }
    },
    [onEndTimeChange, setTimeRange, startTime]
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

  return {
    handleStartTimeChange,
    handleEndTimeChange,
    handleFrameChange,
  };
}

export type TimeHandlers = ReturnType<typeof useTimeHandlers>;
