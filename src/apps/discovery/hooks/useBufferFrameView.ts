// ui/src/apps/discovery/hooks/useBufferFrameView.ts
//
// Hook for buffer-first frame display in Discovery app.
// Provides a unified interface for viewing frames from a buffer,
// with tail polling during streaming and pagination when stopped.

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  getBufferFramesTail,
  getBufferFramesPaginatedFiltered,
  findBufferOffsetForTimestamp,
  getBufferMetadataById,
  type BufferFrame,
} from "../../../api/buffer";
import type { FrameMessage } from "../../../types/frame";

/** Frame with pre-computed hex bytes for display */
export type FrameWithHex = FrameMessage & { hexBytes: string[] };

export interface UseBufferFrameViewOptions {
  /** Buffer ID to read from (null = no buffer) */
  bufferId: string | null;
  /** Whether currently streaming (determines tail vs pagination mode) */
  isStreaming: boolean;
  /** Selected frame IDs filter (empty = all) */
  selectedFrames: Set<number>;
  /** Page size for pagination (when stopped) */
  pageSize: number;
  /** Tail size for streaming mode (default: 50) */
  tailSize?: number;
  /** Poll interval for tail updates in ms (default: 200) */
  pollIntervalMs?: number;
  /** Buffer playback mode - uses pagination even when isStreaming is true */
  isBufferPlayback?: boolean;
}

export interface UseBufferFrameViewResult {
  /** Frames to display (either tail or current page) */
  frames: FrameWithHex[];
  /** Total filtered frame count (for pagination info) */
  totalCount: number;
  /** Whether loading is in progress */
  isLoading: boolean;
  /** Current page (0-indexed, only meaningful when stopped) */
  currentPage: number;
  /** Set current page */
  setCurrentPage: (page: number) => void;
  /** Total pages (only meaningful when stopped) */
  totalPages: number;
  /** Buffer time range for timeline */
  timeRange: { startUs: number; endUs: number } | null;
  /** Navigate to timestamp (for timeline scrub) */
  navigateToTimestamp: (timeUs: number) => Promise<void>;
}

/** Convert BufferFrame to FrameMessage with hex bytes */
function addHexBytes(frames: BufferFrame[]): FrameWithHex[] {
  return frames.map((f) => ({
    protocol: f.protocol,
    timestamp_us: f.timestamp_us,
    frame_id: f.frame_id,
    bus: f.bus,
    dlc: f.dlc,
    bytes: f.bytes,
    is_extended: f.is_extended,
    is_fd: f.is_fd,
    source_address: f.source_address,
    hexBytes: f.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()),
  }));
}

/**
 * Hook for buffer-first frame display.
 *
 * - During streaming: Polls backend for latest N frames ("tail mode")
 * - When stopped: Standard pagination with page controls
 * - No large frontend frame arrays - all data stays in backend
 */
export function useBufferFrameView(
  options: UseBufferFrameViewOptions
): UseBufferFrameViewResult {
  const {
    bufferId,
    isStreaming,
    selectedFrames,
    pageSize,
    tailSize = 50,
    pollIntervalMs = 200,
    isBufferPlayback = false,
  } = options;

  const [frames, setFrames] = useState<FrameWithHex[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [timeRange, setTimeRange] = useState<{
    startUs: number;
    endUs: number;
  } | null>(null);

  // Refs to avoid stale closures in intervals
  const selectedIdsRef = useRef<number[]>(Array.from(selectedFrames));
  const pageSizeRef = useRef(pageSize);

  // Update refs when values change
  useEffect(() => {
    selectedIdsRef.current = Array.from(selectedFrames);
  }, [selectedFrames]);

  useEffect(() => {
    pageSizeRef.current = pageSize;
  }, [pageSize]);

  // Track buffer ID to detect switches
  const prevBufferIdRef = useRef<string | null>(null);

  // Reset state when buffer changes
  useEffect(() => {
    if (prevBufferIdRef.current !== bufferId) {
      setFrames([]);
      setTotalCount(0);
      setCurrentPage(0);
      setTimeRange(null);
      prevBufferIdRef.current = bufferId;
    }
  }, [bufferId]);

  // Fetch buffer metadata for time range
  useEffect(() => {
    if (!bufferId) {
      setTimeRange(null);
      return;
    }

    const fetchMetadata = async () => {
      try {
        const meta = await getBufferMetadataById(bufferId);
        if (meta && meta.start_time_us != null && meta.end_time_us != null) {
          setTimeRange({
            startUs: meta.start_time_us,
            endUs: meta.end_time_us,
          });
        }
      } catch (e) {
        console.error("[useBufferFrameView] metadata fetch error:", e);
      }
    };

    fetchMetadata();
  }, [bufferId]);

  // TAIL MODE: Poll for latest frames during live streaming (not buffer playback)
  useEffect(() => {
    // Only use tail mode for live streaming, not buffer playback
    if (!bufferId || !isStreaming || isBufferPlayback) return;

    let isMounted = true;

    const fetchTail = async () => {
      try {
        const response = await getBufferFramesTail(
          tailSize,
          selectedIdsRef.current
        );
        if (!isMounted) return;

        const withHex = addHexBytes(response.frames);
        setFrames(withHex);
        setTotalCount(response.total_filtered_count);

        // Update time range end if we have new data
        if (response.buffer_end_time_us != null) {
          setTimeRange((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              endUs: response.buffer_end_time_us!,
            };
          });
        }
      } catch (e) {
        console.error("[useBufferFrameView] tail fetch error:", e);
      }
    };

    // Initial fetch
    fetchTail();

    // Poll interval
    const intervalId = setInterval(fetchTail, pollIntervalMs);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [bufferId, isStreaming, isBufferPlayback, tailSize, pollIntervalMs]);

  // PAGINATION MODE: Fetch page when stopped or during buffer playback
  useEffect(() => {
    // Run pagination when stopped, OR when in buffer playback mode
    if (!bufferId || (isStreaming && !isBufferPlayback)) return;

    let isMounted = true;

    const fetchPage = async () => {
      setIsLoading(true);
      try {
        const offset = currentPage * pageSize;
        const response = await getBufferFramesPaginatedFiltered(
          offset,
          pageSize,
          selectedIdsRef.current
        );
        if (!isMounted) return;

        const withHex = addHexBytes(response.frames);
        console.log('[useBufferFrameView] fetchPage result', {
          currentPage,
          pageSize,
          offset,
          responseFrameCount: response.frames.length,
          responseTotalCount: response.total_count,
          firstFrame: response.frames[0] ? { frameId: response.frames[0].frame_id, ts: response.frames[0].timestamp_us } : null,
          lastFrame: response.frames[response.frames.length - 1] ? { frameId: response.frames[response.frames.length - 1].frame_id, ts: response.frames[response.frames.length - 1].timestamp_us } : null,
        });
        setFrames(withHex);
        setTotalCount(response.total_count);
      } catch (e) {
        console.error("[useBufferFrameView] page fetch error:", e);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    fetchPage();

    return () => {
      isMounted = false;
    };
  }, [bufferId, isStreaming, isBufferPlayback, currentPage, pageSize, selectedFrames]);

  // Navigate to timestamp (for timeline scrub and step following)
  const navigateToTimestamp = useCallback(
    async (timeUs: number) => {
      // Only require a valid bufferId - let callers decide when navigation is appropriate
      // This allows navigation when paused (isStreaming=true but stepping through frames)
      if (!bufferId) return;

      try {
        // Ensure integer timestamp (backend expects u64)
        const timeUsInt = Math.round(timeUs);
        const offset = await findBufferOffsetForTimestamp(
          timeUsInt,
          selectedIdsRef.current
        );
        const targetPage = Math.floor(offset / pageSizeRef.current);
        console.log('[useBufferFrameView] navigateToTimestamp', { timeUs: timeUsInt, offset, targetPage, pageSize: pageSizeRef.current });
        setCurrentPage(targetPage);
      } catch (e) {
        console.error("[useBufferFrameView] timestamp navigation error:", e);
      }
    },
    [bufferId]
  );

  // Track previous selection to detect actual changes
  const prevSelectedFramesRef = useRef<Set<number>>(selectedFrames);

  // Reset to page 0 when selection actually changes (not when streaming state changes)
  useEffect(() => {
    const prevSet = prevSelectedFramesRef.current;
    const changed =
      prevSet.size !== selectedFrames.size ||
      [...selectedFrames].some((id) => !prevSet.has(id));

    if (changed && bufferId) {
      setCurrentPage(0);
      prevSelectedFramesRef.current = selectedFrames;
    }
  }, [selectedFrames, bufferId]);

  // Calculate total pages
  const totalPages = useMemo(() => {
    if (pageSize <= 0) return 1;
    return Math.max(1, Math.ceil(totalCount / pageSize));
  }, [totalCount, pageSize]);

  return {
    frames,
    totalCount,
    isLoading,
    currentPage,
    setCurrentPage,
    totalPages,
    timeRange,
    navigateToTimestamp,
  };
}
