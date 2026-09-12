// ui/src/apps/discovery/hooks/useCaptureFrameView.ts
//
// Hook for capture-first frame display in Discovery app.
// Provides a unified interface for viewing frames from a capture,
// with tail polling during streaming and pagination when stopped.

import { useState, useEffect, useRef, useCallback } from "react";
import {
  getCaptureFramesTail,
  getCaptureFramesPaginatedFiltered,
  findCaptureOffsetForTimestamp,
  getCaptureMetadataById,
  type CaptureFrame,
} from "../../../api/capture";
import { BUFFER_POLL_INTERVAL_MS } from "../../../constants";
import { useSessionStore } from "../../../stores/sessionStore";
import type { FrameMessage } from "../../../types/frame";
import { groupKeysByProtocol, type ProtocolFrames } from "../../../utils/frameKey";
import { pageCount, pageForOffset, type ResolvedPageSize } from "../../../utils/pageSize";

/** Frame with pre-computed hex bytes for display */
export type FrameWithHex = FrameMessage & { hexBytes: string[] };

export interface UseBufferFrameViewOptions {
  /** Buffer ID to read from (null = no buffer) */
  captureId: string | null;
  /** Owning session, used to refetch the live tail when Rust reports new frames. */
  sessionId?: string | null;
  /** Whether currently streaming (determines tail vs pagination mode) */
  isStreaming: boolean;
  /** Selected composite frame keys filter (empty = all) */
  selectedFrames: Set<string>;
  /**
   * The filter to send instead of `selectedFrames` — a protocol tab reads its
   * protocol whole (`wholeProtocol`) whatever the picker says. Pass a stable
   * reference; it is a dependency of the fetch.
   */
  selection?: ProtocolFrames[];
  /** Page size for pagination (when stopped) */
  pageSize: ResolvedPageSize;
  /** Tail size for streaming mode (default: 50); null until an Auto fit lands. */
  tailSize?: ResolvedPageSize;
  /** Poll interval for tail updates in ms (default: 200) */
  pollIntervalMs?: number;
  /** Buffer playback mode - uses pagination even when isStreaming is true */
  isCapturePlayback?: boolean;
  /** Hold the live tail still while frames keep arriving (the freeze toggle). */
  frozen?: boolean;
  /** When set, the hook auto-navigates to the page containing this timestamp during pagination mode.
   *  Used for play/play backward and stepping — the hook owns the page state so it handles navigation internally. */
  followTimeUs?: number | null;
}

export interface UseBufferFrameViewResult {
  /** Frames to display (either tail or current page) */
  frames: FrameWithHex[];
  /** 1-based original buffer position for each frame, parallel to `frames`. */
  captureIndices: number[];
  /** Total filtered frame count (for pagination info) */
  totalCount: number;
  /** Whether loading is in progress */
  isLoading: boolean;
  /** Current page (0-indexed, only meaningful when stopped) */
  currentPage: number;
  /** Row ordinal the current window starts at — the offset actually fetched. */
  pageStartIndex: number;
  /** Set current page */
  setCurrentPage: (page: number) => void;
  /** Put a given row at the top of the window. */
  goToRow: (row: number) => void;
  /** Total pages (only meaningful when stopped) */
  totalPages: number;
  /** Buffer time range for timeline */
  timeRange: { startUs: number; endUs: number } | null;
  /** Navigate to timestamp (for timeline scrub) */
  navigateToTimestamp: (timeUs: number) => Promise<void>;
  /** Pull the tail once while frozen, without unfreezing. */
  refreshOnce: () => void;
}

/** Hold the window inside the data: growing the page past the end would leave it part-empty. */
function clampAnchor(anchorRow: number, totalCount: number, pageSize: ResolvedPageSize): number {
  if (pageSize === null || totalCount <= 0) return Math.max(0, anchorRow);
  return Math.max(0, Math.min(anchorRow, totalCount - pageSize));
}

/** Snap an offset down to the start of the page containing it. */
function pageAlignedAnchor(offset: number, pageSize: ResolvedPageSize): number {
  const size = pageSize ?? 1;
  return Math.max(0, Math.floor(offset / size) * size);
}

/** Convert CaptureFrame to FrameMessage with hex bytes */
function addHexBytes(frames: CaptureFrame[]): FrameWithHex[] {
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
export function useCaptureFrameView(
  options: UseBufferFrameViewOptions
): UseBufferFrameViewResult {
  const {
    captureId,
    sessionId,
    isStreaming,
    selectedFrames,
    selection,
    pageSize,
    tailSize = 50,
    pollIntervalMs = BUFFER_POLL_INTERVAL_MS,
    isCapturePlayback = false,
    frozen = false,
    followTimeUs,
  } = options;

  const [frames, setFrames] = useState<FrameWithHex[]>([]);
  const [captureIndices, setBufferIndices] = useState<number[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  // The 0-based ordinal, within the filtered result set, of the row at the top of the
  // viewport. Pages used to be a grid of multiples of pageSize, which meant a page-size
  // change could only land on a grid line — so growing the page pushed the row you were
  // looking at up to a page away. Storing the anchor instead makes a resize keep it.
  const [anchorRow, setAnchorRow] = useState(0);
  const [timeRange, setTimeRange] = useState<{
    startUs: number;
    endUs: number;
  } | null>(null);
  // Pull the tail once without disturbing the subscription or the frozen flag.
  const fetchTailRef = useRef<() => void>(() => {});
  const refreshOnce = useCallback(() => fetchTailRef.current(), []);

  // Refs to avoid stale closures in intervals
  const selectionRef = useRef<ProtocolFrames[]>(selection ?? groupKeysByProtocol(selectedFrames));
  const pageSizeRef = useRef(pageSize);

  // Update refs when values change
  useEffect(() => {
    selectionRef.current = selection ?? groupKeysByProtocol(selectedFrames);
  }, [selection, selectedFrames]);

  useEffect(() => {
    pageSizeRef.current = pageSize;
  }, [pageSize]);

  // Track buffer ID to detect switches
  const prevBufferIdRef = useRef<string | null>(null);

  // Reset state when buffer changes
  useEffect(() => {
    if (prevBufferIdRef.current !== captureId) {
      setFrames([]);
      setBufferIndices([]);
      setTotalCount(0);
      setAnchorRow(0);
      setTimeRange(null);
      prevBufferIdRef.current = captureId;
    }
  }, [captureId]);

  // Fetch buffer metadata for time range
  useEffect(() => {
    if (!captureId) {
      setTimeRange(null);
      return;
    }

    const fetchMetadata = async () => {
      try {
        const meta = await getCaptureMetadataById(captureId);
        if (meta && meta.start_time_us != null && meta.end_time_us != null) {
          setTimeRange({
            startUs: meta.start_time_us,
            endUs: meta.end_time_us,
          });
        }
      } catch (e) {
        console.error("[useCaptureFrameView] metadata fetch error:", e);
      }
    };

    fetchMetadata();
  }, [captureId]);

  // Read inside the fetch loop rather than through the effect deps, so toggling freeze
  // holds the rows that are on screen instead of tearing the subscription down and
  // pulling a fresh tail first.
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  useEffect(() => {
    // tailSize is null until an auto fit has been measured; re-running when it lands is
    // what arms the subscription.
    if (!captureId || !isStreaming || isCapturePlayback || tailSize === null) return;

    let isMounted = true;
    // A tail fetch can outlast the 500ms signal interval on a large capture. Skip while
    // one is in flight and run once more on completion, so fetches can neither queue up
    // on the DB mutex nor land out of order and overwrite newer rows with older ones.
    let inFlight = false;
    let missed = false;

    const fetchTail = async () => {
      if (inFlight) { missed = true; return; }
      inFlight = true;
      try {
        const response = await getCaptureFramesTail(captureId, tailSize, selectionRef.current);
        if (!isMounted) return;
        setFrames(addHexBytes(response.frames));
        setBufferIndices(response.capture_indices);
        setTotalCount(response.total_filtered_count);
        if (response.capture_end_time_us != null) {
          setTimeRange((prev) => prev ? { ...prev, endUs: response.capture_end_time_us! } : null);
        }
      } catch (e) {
        console.error("[useCaptureFrameView] tail fetch error:", e);
      } finally {
        inFlight = false;
        if (missed && isMounted) { missed = false; void fetchTail(); }
      }
    };
    fetchTailRef.current = fetchTail;
    void fetchTail();

    // Rust writes frames into the capture before it signals, and it owns the frame count
    // it pushes over WS — so refetching whenever that count moves keeps the view in step
    // with the backend at the backend's own throttle, with no timer on this side.
    if (sessionId) {
      const unsubscribe = useSessionStore.subscribe((state, prevState) => {
        if (frozenRef.current) return;
        if (state.sessions[sessionId]?.frameCount !== prevState.sessions[sessionId]?.frameCount) {
          void fetchTail();
        }
      });
      return () => {
        isMounted = false;
        unsubscribe();
      };
    }

    // No session to follow — fall back to polling.
    const intervalId = setInterval(() => { if (!frozenRef.current) void fetchTail(); }, pollIntervalMs);
    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [captureId, isStreaming, isCapturePlayback, tailSize, pollIntervalMs, sessionId]);

  // PAGINATION MODE: Fetch page when stopped or during buffer playback
  useEffect(() => {
    // Run pagination when stopped, OR when in buffer playback mode
    if (!captureId || (isStreaming && !isCapturePlayback)) return;
    if (pageSize === null) return; // auto size not measured yet

    let isMounted = true;

    const fetchPage = async () => {
      setIsLoading(true);
      try {
        const offset = clampAnchor(anchorRow, totalCount, pageSize);
        const response = await getCaptureFramesPaginatedFiltered(
          captureId,
          offset,
          pageSize,
          selectionRef.current
        );
        if (!isMounted) return;

        const withHex = addHexBytes(response.frames);
        setFrames(withHex);
        setBufferIndices(response.capture_indices);
        setTotalCount(response.total_count);
      } catch (e) {
        console.error("[useCaptureFrameView] page fetch error:", e);
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
  }, [captureId, isStreaming, isCapturePlayback, anchorRow, pageSize, selection, selectedFrames, totalCount]);

  // Navigate to timestamp (for timeline scrub and step following)
  const navigateToTimestamp = useCallback(
    async (timeUs: number) => {
      // Only require a valid captureId - let callers decide when navigation is appropriate
      // This allows navigation when paused (isStreaming=true but stepping through frames)
      if (!captureId) return;

      try {
        // Ensure integer timestamp (backend expects u64)
        const timeUsInt = Math.round(timeUs);
        const offset = await findCaptureOffsetForTimestamp(
          captureId,
          timeUsInt,
          selectionRef.current
        );
        setAnchorRow(pageAlignedAnchor(offset, pageSizeRef.current));
      } catch (e) {
        console.error("[useCaptureFrameView] timestamp navigation error:", e);
      }
    },
    [captureId]
  );

  // FOLLOW MODE: Auto-navigate to page containing followTimeUs during buffer playback
  // The hook owns the page state, so follow logic lives here (not in external effects)
  const followPendingRef = useRef(false);
  // Track the latest followTimeUs that was skipped while a navigation was pending.
  // When the pending navigation resolves, we re-check with this value so the page
  // catches up even if React already processed the latest followTimeUs change.
  const lastSkippedFollowRef = useRef<number | null>(null);
  // Use a ref for the "already on page" check so that manual page navigation
  // (which changes frames) doesn't re-trigger follow and snap the page back.
  const framesRef = useRef(frames);
  useEffect(() => { framesRef.current = frames; }, [frames]);

  // Shared follow-navigate helper used by both the effect and the catchup path.
  // `captureId` must be in the dep array — with an empty array the callback
  // would close over the initial `null` captureId and pass '' to the backend.
  const doFollowNavigate = useCallback((timeUs: number) => {
    if (!captureId) return;
    const timeUsInt = Math.round(timeUs);
    findCaptureOffsetForTimestamp(captureId, timeUsInt, selectionRef.current)
      .then((offset) => {
        setAnchorRow(pageAlignedAnchor(offset, pageSizeRef.current));
      })
      .catch((e) => console.error("[useCaptureFrameView] follow navigation error:", e))
      .finally(() => {
        followPendingRef.current = false;
        // If timestamps were skipped while this navigation was pending, catch up
        const skipped = lastSkippedFollowRef.current;
        if (skipped != null) {
          lastSkippedFollowRef.current = null;
          followPendingRef.current = true;
          doFollowNavigate(skipped);
        }
      });
  }, [captureId]);

  useEffect(() => {
    if (followTimeUs == null || !captureId || !isCapturePlayback) return;
    if (followPendingRef.current) {
      // A navigation is in flight — record the latest timestamp so we can catch up
      lastSkippedFollowRef.current = followTimeUs;
      return;
    }

    // If we have frames, check whether the timestamp is already on the current page
    const currentFrames = framesRef.current;
    if (currentFrames.length > 0) {
      const firstTs = currentFrames[0].timestamp_us;
      const lastTs = currentFrames[currentFrames.length - 1].timestamp_us;
      if (followTimeUs >= firstTs && followTimeUs <= lastTs) return;
    }

    // Timestamp is outside the current page (or no frames loaded yet) — navigate
    followPendingRef.current = true;
    lastSkippedFollowRef.current = null;
    doFollowNavigate(followTimeUs);
  }, [followTimeUs, captureId, isCapturePlayback, doFollowNavigate]);

  // Track previous selection to detect actual changes
  const prevSelectedFramesRef = useRef<Set<string>>(selectedFrames);

  // Reset to page 0 when selection actually changes (not when streaming state changes)
  useEffect(() => {
    const prevSet = prevSelectedFramesRef.current;
    const changed =
      prevSet.size !== selectedFrames.size ||
      [...selectedFrames].some((fk) => !prevSet.has(fk));

    if (changed && captureId) {
      setAnchorRow(0);
      prevSelectedFramesRef.current = selectedFrames;
    }
  }, [selectedFrames, captureId]);

  const totalPages = pageCount(totalCount, pageSize);

  // The row this window starts at. Callers must use this rather than page * pageSize:
  // the clamp above lands on totalCount - pageSize, which is not page-aligned, so the
  // two disagree exactly when a resize has done its job.
  const pageStartIndex = clampAnchor(anchorRow, totalCount, pageSize);
  // Page buttons still move in whole pages; the anchor is what a resize preserves.
  const currentPage = pageForOffset(pageStartIndex, pageSize);
  const setCurrentPage = useCallback((page: number) => {
    setAnchorRow(Math.max(0, page) * (pageSizeRef.current ?? 1));
  }, []);
  /** Put `row` at the top of the window. */
  const goToRow = useCallback((row: number) => setAnchorRow(Math.max(0, row)), []);

  return {
    frames,
    captureIndices,
    totalCount,
    isLoading,
    currentPage,
    setCurrentPage,
    pageStartIndex,
    goToRow,
    totalPages,
    timeRange,
    navigateToTimestamp,
    refreshOnce,
  };
}
