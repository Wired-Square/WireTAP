// ui/src/apps/discovery/views/DiscoveryFramesView.tsx
import React, { useEffect, useRef, useMemo, memo, useState, useCallback } from "react";
import { FileText, Network, Play, LayoutList } from "lucide-react";
import { iconSm, flexRowGap2 } from "../../../styles/spacing";
import { formatIsoUs, formatHumanUs, renderDeltaNode } from "../../../utils/timeFormat";
import { useDiscoveryStore } from "../../../stores/discoveryStore";
import { useDiscoveryUIStore } from "../../../stores/discoveryUIStore";
import { getBufferFramesPaginatedFiltered, findBufferOffsetForTimestamp, type BufferMetadata } from "../../../api/buffer";
import { FrameDataTable, type TabDefinition, FRAME_PAGE_SIZE_OPTIONS } from "../components";
import AppTabView from "../../../components/AppTabView";
import { PlaybackControls, type PlaybackState } from "../../../components/PlaybackControls";
import type { PlaybackSpeed } from "../../../components/TimeController";
import ChangesResultView from "./tools/ChangesResultView";
import MessageOrderResultView from "./tools/MessageOrderResultView";
import { bgDataView, textDataSecondary, bgSurface, textMuted, textPrimary, textSecondary, borderDefault } from "../../../styles";
import type { FrameMessage } from "../../../types/frame";
import type { IOCapabilities } from "../../../api/io";
import { useBufferFrameView } from "../../../hooks/useBufferFrameView";

type Props = {
  /** @deprecated Use bufferId prop instead for buffer-first mode */
  frames?: FrameMessage[];
  /** Buffer ID for buffer-first mode (recommended) */
  bufferId?: string | null;
  protocol: string;
  displayFrameIdFormat: "hex" | "decimal";
  displayTimeFormat: "delta-last" | "delta-start" | "timestamp" | "human";
  onBookmark?: (frameId: number, timestampUs: number) => void;
  isStreaming?: boolean;

  // Time display
  timestamp?: number | null;
  /** @deprecated Use timestamp instead */
  displayTime?: string | null;

  // Stream start time - for "Delta Since Start" display (persists across buffer rotations)
  streamStartTimeUs?: number | null;

  // Time range
  showTimeRange?: boolean;
  startTime?: string;
  endTime?: string;
  onStartTimeChange?: (time: string) => void;
  onEndTimeChange?: (time: string) => void;

  // History buffer
  maxBuffer: number;
  onMaxBufferChange: (value: number) => void;

  // Timeline scrubber
  currentTimeUs?: number | null;
  onScrub?: (timeUs: number) => void;

  // Buffer metadata (for timeline in buffer mode)
  bufferMetadata?: BufferMetadata | null;

  // Whether the data source is recorded (e.g., PostgreSQL, CSV) vs live
  isRecorded?: boolean;

  // Whether in buffer mode (from session manager - used for timeline controls visibility)
  isBufferMode?: boolean;

  // Playback controls (for buffer replay)
  playbackState?: PlaybackState;
  playbackDirection?: "forward" | "backward";
  capabilities?: IOCapabilities | null;
  playbackSpeed?: PlaybackSpeed;
  currentFrameIndex?: number | null;
  onFrameSelect?: (frameIndex: number, timestampUs: number) => void;
  onPlay?: () => void;
  onPlayBackward?: () => void;
  onPause?: () => void;
  onStepBackward?: () => void;
  onStepForward?: () => void;
  onSpeedChange?: (speed: PlaybackSpeed) => void;
  /** Frame-based seeking (preferred for buffer playback) */
  onFrameChange?: (frameIndex: number) => void;
};

function DiscoveryFramesView({
  frames = [],
  bufferId,
  protocol,
  displayFrameIdFormat,
  displayTimeFormat,
  onBookmark,
  isStreaming = false,
  timestamp,
  displayTime,
  streamStartTimeUs,
  showTimeRange,
  startTime,
  endTime,
  onStartTimeChange,
  onEndTimeChange,
  maxBuffer,
  onMaxBufferChange,
  currentTimeUs,
  onScrub,
  bufferMetadata,
  isRecorded = false,
  isBufferMode = false,
  playbackState = "paused",
  playbackDirection = "forward",
  capabilities,
  playbackSpeed = 1,
  currentFrameIndex,
  onFrameSelect,
  onPlay,
  onPlayBackward,
  onPause,
  onStepBackward,
  onStepForward,
  onSpeedChange,
  onFrameChange,
}: Props) {

  const renderBuffer = useDiscoveryStore((s) => s.renderBuffer);
  const setRenderBuffer = useDiscoveryStore((s) => s.setRenderBuffer);
  const selectedFrames = useDiscoveryStore((s) => s.selectedFrames);
  const bufferMode = useDiscoveryStore((s) => s.bufferMode);
  const setBufferViewMode = useDiscoveryStore((s) => s.setBufferViewMode);
  const toolboxResults = useDiscoveryStore((s) => s.toolbox);

  // Store previous page size and page when switching to playback mode
  const prevRenderBufferRef = useRef<number | null>(null);
  const prevPageRef = useRef<number>(0);

  // Use buffer-first hook when bufferId is available
  // This provides a unified interface for streaming (tail poll) and stopped (pagination)
  const effectiveBufferId = bufferId ?? bufferMetadata?.id ?? null;
  const useBufferFirstMode = effectiveBufferId !== null;

  const bufferFrameView = useBufferFrameView({
    bufferId: effectiveBufferId,
    isStreaming,
    selectedFrames,
    pageSize: renderBuffer === -1 ? 1000 : renderBuffer,
    tailSize: renderBuffer === -1 ? 100 : renderBuffer,
    pollIntervalMs: 200,
    isBufferPlayback: isBufferMode,
  });

  // Tab state for CAN frames view - stored in UI store so analysis can switch to it
  const activeTab = useDiscoveryUIStore((s) => s.framesViewActiveTab);
  const setActiveTab = useDiscoveryUIStore((s) => s.setFramesViewActiveTab);

  // ASCII column toggle
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  const toggleShowAsciiColumn = useDiscoveryUIStore((s) => s.toggleShowAsciiColumn);

  // Bus column toggle
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const toggleShowBusColumn = useDiscoveryUIStore((s) => s.toggleShowBusColumn);

  // Pagination state (only used when not streaming)
  const [currentPage, setCurrentPage] = useState(0);

  // Handle view mode toggle (pagination vs playback)
  const handleViewModeToggle = useCallback(() => {
    if (bufferMode.viewMode === 'pagination') {
      // Switching to playback: save current state, show all frames from start
      prevRenderBufferRef.current = renderBuffer;
      prevPageRef.current = currentPage;
      setRenderBuffer(-1);
      setCurrentPage(0);
      setBufferViewMode('playback');
    } else {
      // Switching to pagination: restore previous page size and page
      if (prevRenderBufferRef.current !== null && prevRenderBufferRef.current !== -1) {
        setRenderBuffer(prevRenderBufferRef.current);
      } else {
        setRenderBuffer(50); // Default page size
      }
      setCurrentPage(prevPageRef.current);
      setBufferViewMode('pagination');
    }
  }, [bufferMode.viewMode, renderBuffer, currentPage, setRenderBuffer, setBufferViewMode]);

  // Buffer mode state - frames fetched from backend on demand
  const [bufferModeFrames, setBufferModeFrames] = useState<(FrameMessage & { hexBytes: string[] })[]>([]);
  const [bufferModeLoading, setBufferModeLoading] = useState(false);
  const [bufferModeTotalCount, setBufferModeTotalCount] = useState(0);

  // Track buffer metadata ID to detect buffer switches
  const prevBufferIdRef = useRef<string | null>(null);

  // Reset buffer mode state when switching buffers
  useEffect(() => {
    const currentBufferId = bufferMetadata?.id ?? null;
    if (prevBufferIdRef.current !== currentBufferId) {
      // Buffer changed - reset local state
      setBufferModeFrames([]);
      setBufferModeTotalCount(0);
      setCurrentPage(0);
      prevBufferIdRef.current = currentBufferId;
    }
  }, [bufferMetadata?.id]);

  // Reset to minimum value and page 0 when streaming starts
  React.useEffect(() => {
    if (isStreaming) {
      setRenderBuffer(20);
      setCurrentPage(0);
    }
  }, [isStreaming, setRenderBuffer]);

  // Track pending scrub request to avoid stale updates
  const scrubRequestRef = useRef(0);

  // Keep stable references for scrub handler to avoid callback identity changes
  const selectedFramesRef = useRef(selectedFrames);
  const renderBufferRef = useRef(renderBuffer);
  const bufferModeRef = useRef(bufferMode);

  useEffect(() => {
    selectedFramesRef.current = selectedFrames;
    renderBufferRef.current = renderBuffer;
    bufferModeRef.current = bufferMode;
  }, [selectedFrames, renderBuffer, bufferMode]);

  // Handle timeline scrub in buffer mode - navigate to the page containing the target timestamp
  // Using refs to keep callback identity stable and avoid stale closure issues
  const handleBufferScrub = useCallback(async (timeUs: number) => {
    // Ensure we pass an integer to the backend (timestamps are u64)
    const timeUsInt = Math.round(timeUs);

    if (!bufferModeRef.current.enabled) {
      return;
    }

    const pageSize = renderBufferRef.current === -1 ? 1000 : renderBufferRef.current;
    const selectedIds = Array.from(selectedFramesRef.current);

    // Track this request to ignore stale responses
    const requestId = ++scrubRequestRef.current;

    try {
      const offset = await findBufferOffsetForTimestamp(timeUsInt, selectedIds);
      const targetPage = Math.floor(offset / pageSize);

      // Only update if this is still the latest request
      if (requestId === scrubRequestRef.current) {
        setCurrentPage(targetPage);
      }
    } catch (e) {
      console.error("[handleBufferScrub] Failed to find offset for timestamp:", e);
    }
  }, []); // Empty deps - uses refs for all state

  // Keep ref to frames for normal mode scrubbing
  const framesRef = useRef(frames);
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  // Handle timeline scrub in normal mode (frontend frames) - navigate to the page containing the target timestamp
  const handleNormalScrub = useCallback((timeUs: number) => {
    const targetTimeUs = Math.round(timeUs);
    const pageSize = renderBufferRef.current === -1 ? 1000 : renderBufferRef.current;
    const selectedIds = selectedFramesRef.current;
    const allFrames = framesRef.current;

    // Find offset in filtered frames - binary search since frames are time-ordered
    let offset = 0;
    for (let i = 0; i < allFrames.length; i++) {
      const frame = allFrames[i];
      // Only count frames that match the selection
      if (selectedIds.has(frame.frame_id)) {
        if (frame.timestamp_us >= targetTimeUs) {
          break;
        }
        offset++;
      }
    }

    const targetPage = Math.floor(offset / pageSize);
    setCurrentPage(targetPage);

    // Also call the parent's onScrub to update the clock
    if (onScrub) {
      onScrub(timeUs);
    }
  }, [onScrub]); // Only depends on onScrub

  // Determine the effective start time for delta calculations
  // In buffer mode, use buffer metadata; otherwise use streamStartTimeUs from props
  const effectiveStartTimeUs = useMemo(() => {
    if (bufferMode.enabled && bufferMetadata?.start_time_us != null) {
      return bufferMetadata.start_time_us;
    }
    return streamStartTimeUs;
  }, [bufferMode.enabled, bufferMetadata?.start_time_us, streamStartTimeUs]);

  const formatTime = (
    ts_us: number,
    prevTs_us: number | null
  ): React.ReactNode => {
    switch (displayTimeFormat) {
      case "delta-last":
        if (prevTs_us === null) return "0.000000s";
        return renderDelta(ts_us - prevTs_us);
      case "delta-start":
        // Use effectiveStartTimeUs - buffer metadata in buffer mode, streamStartTimeUs otherwise
        if (effectiveStartTimeUs == null) return "0.000000s";
        return renderDelta(ts_us - effectiveStartTimeUs);
      case "timestamp":
        return formatIsoUs(ts_us);
      case "human":
      default:
        return formatHumanUs(ts_us);
    }
  };

  const renderDelta = (deltaUs: number) => {
    return renderDeltaNode(deltaUs);
  };

  // State for deferred filtering when stopped (to avoid blocking UI with 3M+ frames)
  const [deferredResult, setDeferredResult] = useState<{
    visibleFrames: (FrameMessage & { hexBytes: string[] })[];
    filteredCount: number;
  } | null>(null);
  const [isFiltering, setIsFiltering] = useState(false);

  // During streaming: synchronous O(k) computation (fast)
  const streamingResult = useMemo(() => {
    if (!isStreaming) return null;

    // During streaming: iterate backwards, collect up to renderBuffer matching frames
    const limit = renderBuffer === -1 ? frames.length : renderBuffer;
    const result: FrameMessage[] = [];

    for (let i = frames.length - 1; i >= 0 && result.length < limit; i--) {
      const frame = frames[i];
      if (selectedFrames.has(frame.frame_id)) {
        result.push(frame);
      }
    }

    // Reverse to get chronological order
    result.reverse();

    // Pre-compute hex bytes for visible frames only
    const withHex = result.map(frame => ({
      ...frame,
      hexBytes: frame.bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()),
    }));

    return { visibleFrames: withHex, filteredCount: -1 };
  }, [frames, selectedFrames, renderBuffer, isStreaming]);

  // When stopped: defer heavy filtering to avoid blocking UI
  useEffect(() => {
    if (isStreaming) {
      // Clear deferred result when streaming starts
      setDeferredResult(null);
      setIsFiltering(false);
      return;
    }

    // When streaming stops, defer the heavy computation
    setIsFiltering(true);

    // Use setTimeout to allow UI to update first (show loading state)
    const timeoutId = setTimeout(() => {
      // Do the filtering in chunks to avoid blocking UI completely
      const CHUNK_SIZE = 100000;
      let filtered: FrameMessage[] = [];
      let currentIndex = 0;

      const processChunk = () => {
        const endIndex = Math.min(currentIndex + CHUNK_SIZE, frames.length);

        for (let i = currentIndex; i < endIndex; i++) {
          const frame = frames[i];
          if (selectedFrames.has(frame.frame_id)) {
            filtered.push(frame);
          }
        }

        currentIndex = endIndex;

        if (currentIndex < frames.length) {
          // More chunks to process - yield to UI
          setTimeout(processChunk, 0);
        } else {
          // Done filtering, compute final result
          let slice: FrameMessage[];
          if (renderBuffer === -1) {
            slice = filtered;
          } else {
            const start = currentPage * renderBuffer;
            const end = start + renderBuffer;
            slice = filtered.slice(start, end);
          }

          const withHex = slice.map(frame => ({
            ...frame,
            hexBytes: frame.bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()),
          }));

          setDeferredResult({ visibleFrames: withHex, filteredCount: filtered.length });
          setIsFiltering(false);
        }
      };

      processChunk();
    }, 50); // Small delay to let React render the loading state

    return () => {
      clearTimeout(timeoutId);
    };
  }, [isStreaming, frames, selectedFrames, renderBuffer, currentPage]);

  // Buffer mode: fetch frames from backend on page change, filtered by selected frame IDs
  const fetchBufferPage = useCallback(async (page: number, pageSize: number, selectedIds: number[]) => {
    if (!bufferMode.enabled) return;

    setBufferModeLoading(true);
    try {
      const offset = page * pageSize;
      const response = await getBufferFramesPaginatedFiltered(offset, pageSize, selectedIds);

      const withHex = response.frames.map((frame: FrameMessage) => ({
        ...frame,
        hexBytes: frame.bytes.map((b: number) => b.toString(16).padStart(2, '0').toUpperCase()),
      }));

      setBufferModeFrames(withHex as (FrameMessage & { hexBytes: string[] })[]);
      // Update total count from the filtered response
      setBufferModeTotalCount(response.total_count);
    } catch (e) {
      console.error("Failed to fetch buffer page:", e);
    } finally {
      setBufferModeLoading(false);
    }
  }, [bufferMode.enabled]);

  // Fetch initial page when buffer mode becomes enabled, buffer changes, or when page/pageSize/selection changes
  useEffect(() => {
    // Only fetch when buffer mode is enabled AND we have a valid buffer to fetch from
    if (bufferMode.enabled && !isStreaming && bufferMetadata?.id) {
      const pageSize = renderBuffer === -1 ? 1000 : renderBuffer; // Cap "All" at 1000 in buffer mode
      // Convert Set to Array for the API call (empty array = all frames)
      const selectedIds = Array.from(selectedFrames);
      fetchBufferPage(currentPage, pageSize, selectedIds);
    }
  }, [bufferMode.enabled, bufferMetadata?.id, currentPage, renderBuffer, isStreaming, fetchBufferPage, selectedFrames]);

  // Determine which result to use based on mode
  let visibleFrames: (FrameMessage & { hexBytes: string[] })[];
  let filteredCount: number;
  let effectiveCurrentPage: number;
  let effectiveTotalPages: number;
  let isBufferFirstLoading = false;

  // Keep stable reference to hook's setCurrentPage
  const hookSetCurrentPageRef = useRef(bufferFrameView.setCurrentPage);
  useEffect(() => {
    hookSetCurrentPageRef.current = bufferFrameView.setCurrentPage;
  }, [bufferFrameView.setCurrentPage]);

  // Use stable callbacks for page changes to avoid infinite loops in useEffect dependencies
  const setCurrentPageStable = useCallback((page: number) => {
    if (useBufferFirstMode) {
      hookSetCurrentPageRef.current(page);
    } else {
      setCurrentPage(page);
    }
  }, [useBufferFirstMode]);

  if (useBufferFirstMode) {
    // Buffer-first mode: use the hook for everything
    visibleFrames = bufferFrameView.frames;
    filteredCount = bufferFrameView.totalCount;
    effectiveCurrentPage = bufferFrameView.currentPage;
    effectiveTotalPages = bufferFrameView.totalPages;
    isBufferFirstLoading = bufferFrameView.isLoading;
  } else if (bufferMode.enabled && !isStreaming) {
    // Legacy buffer mode: use frames fetched from backend (filtered by selection)
    visibleFrames = bufferModeFrames;
    filteredCount = bufferModeTotalCount;
    effectiveCurrentPage = currentPage;
    const pageSize = renderBuffer === -1 ? Math.max(1, filteredCount) : renderBuffer;
    effectiveTotalPages = filteredCount > 0 && pageSize > 0 ? Math.ceil(filteredCount / pageSize) : 1;
  } else if (isStreaming) {
    // Streaming mode
    const result = streamingResult ?? { visibleFrames: [], filteredCount: -1 };
    visibleFrames = result.visibleFrames;
    filteredCount = result.filteredCount;
    effectiveCurrentPage = currentPage;
    effectiveTotalPages = 1;
  } else {
    // Stopped mode: use deferred result
    const result = deferredResult ?? { visibleFrames: [], filteredCount: 0 };
    visibleFrames = result.visibleFrames;
    filteredCount = result.filteredCount;
    effectiveCurrentPage = currentPage;
    const pageSize = renderBuffer === -1 ? Math.max(1, filteredCount) : renderBuffer;
    effectiveTotalPages = filteredCount > 0 && pageSize > 0 ? Math.ceil(filteredCount / pageSize) : 1;
  }

  // Use refs to avoid infinite loops in useEffect when using effectiveCurrentPage
  const effectiveCurrentPageRef = useRef(effectiveCurrentPage);
  useEffect(() => {
    effectiveCurrentPageRef.current = effectiveCurrentPage;
  }, [effectiveCurrentPage]);

  // Ensure frames are always sorted by timestamp ascending (oldest at top)
  // regardless of playback direction. Track if we reversed for index mapping.
  let framesWereReversed = false;
  if (visibleFrames.length > 1) {
    const firstTs = visibleFrames[0].timestamp_us;
    const lastTs = visibleFrames[visibleFrames.length - 1].timestamp_us;
    if (firstTs > lastTs) {
      // Frames are in descending order, reverse to get ascending
      visibleFrames = [...visibleFrames].reverse();
      framesWereReversed = true;
    }
  }

  // Calculate pagination values (only meaningful when not streaming)
  const pageSize = renderBuffer === -1 ? Math.max(1, filteredCount) : renderBuffer;
  const totalPages = useBufferFirstMode ? effectiveTotalPages : (filteredCount > 0 && pageSize > 0 ? Math.ceil(filteredCount / pageSize) : 1);

  // Clamp current page to valid range when frames change
  const validPage = Math.min(currentPage, Math.max(0, totalPages - 1));
  React.useEffect(() => {
    if (validPage !== currentPage && !isStreaming) {
      setCurrentPage(validPage);
    }
  }, [validPage, currentPage, isStreaming]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollPending = useRef(false);

  // Throttle auto-scroll with requestAnimationFrame
  useEffect(() => {
    if (scrollPending.current) return;
    scrollPending.current = true;

    requestAnimationFrame(() => {
      scrollPending.current = false;
      const el = scrollRef.current;
      if (!el) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
      if (nearBottom) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, [frames]);

  // Check if we have any analysis results
  const hasAnalysisResults = toolboxResults.changesResults !== null || toolboxResults.messageOrderResults !== null;

  // Build tab definitions for shared tab bar
  const frameCount = filteredCount > 0 ? filteredCount : frames.length;
  const tabs: TabDefinition[] = useMemo(() => {
    const result: TabDefinition[] = [
      { id: 'frames', label: 'Frames', count: frameCount, countColor: 'green' as const },
    ];
    // Filtered tab is a placeholder for now - will be implemented in a future update
    // result.push({ id: 'filtered', label: 'Filtered', count: 0, countColor: 'amber' as const });
    result.push({ id: 'analysis', label: 'Analysis', hasIndicator: hasAnalysisResults });
    return result;
  }, [frameCount, hasAnalysisResults]);

  // Handle page size change - reset to page 0
  const handlePageSizeChange = useCallback((size: number) => {
    setRenderBuffer(size);
    // Reset page using the stable callback
    setCurrentPageStable(0);
  }, [setRenderBuffer, setCurrentPageStable]);

  // Keep stable reference to hook's navigateToTimestamp
  const hookNavigateToTimestampRef = useRef(bufferFrameView.navigateToTimestamp);
  useEffect(() => {
    hookNavigateToTimestampRef.current = bufferFrameView.navigateToTimestamp;
  }, [bufferFrameView.navigateToTimestamp]);

  // Handle timeline scrub - use hook's navigateToTimestamp in buffer-first mode
  const handleBufferFirstScrub = useCallback(async (timeUs: number) => {
    await hookNavigateToTimestampRef.current(timeUs);
    onScrub?.(timeUs);
  }, [onScrub]);

  // Compute timeline props based on mode
  const timelineProps = useMemo(() => {
    // Buffer-first mode: use hook's time range
    if (useBufferFirstMode && bufferFrameView.timeRange) {
      const currentPos = isStreaming
        ? (currentTimeUs ?? bufferFrameView.timeRange.startUs)
        : (visibleFrames.length > 0 ? visibleFrames[0].timestamp_us : bufferFrameView.timeRange.startUs);
      return {
        show: true,
        minTimeUs: bufferFrameView.timeRange.startUs,
        maxTimeUs: bufferFrameView.timeRange.endUs,
        currentTimeUs: currentPos,
        onScrub: handleBufferFirstScrub,
        disabled: false,
      };
    }
    // Buffer mode: use buffer metadata for time range
    // Check both local bufferMode.enabled AND isBufferMode from session (for cross-app stops)
    // Show buffer timeline in buffer mode regardless of streaming state (buffer reader can be running or paused)
    if ((bufferMode.enabled || isBufferMode) && bufferMetadata?.start_time_us != null && bufferMetadata?.end_time_us != null) {
      // Use currentTimeUs from session for playback position tracking
      const currentPos = currentTimeUs ?? bufferMetadata.start_time_us;
      return {
        show: true,
        minTimeUs: bufferMetadata.start_time_us,
        maxTimeUs: bufferMetadata.end_time_us,
        currentTimeUs: currentPos,
        onScrub: handleBufferScrub,
        disabled: false,
      };
    }
    // Normal mode: use frames array
    if (frames.length > 1) {
      return {
        show: true,
        minTimeUs: frames[0].timestamp_us,
        maxTimeUs: frames[frames.length - 1].timestamp_us,
        currentTimeUs: currentTimeUs ?? frames[0].timestamp_us,
        onScrub: handleNormalScrub,
        disabled: isStreaming,
      };
    }
    return { show: false, minTimeUs: 0, maxTimeUs: 0, currentTimeUs: 0, onScrub: () => {}, disabled: true };
  }, [useBufferFirstMode, bufferFrameView.timeRange, bufferMode.enabled, isBufferMode, isStreaming, bufferMetadata, frames, currentTimeUs, visibleFrames, handleBufferFirstScrub, handleBufferScrub, handleNormalScrub]);

  // Auto-navigate to the page containing the current frame during playback
  // This works for buffer playback (where currentFrameIndex is set from session playback position)
  // During live streaming, currentFrameIndex is null so this effect doesn't run
  useEffect(() => {
    if (currentFrameIndex == null) return;

    // In playback mode (renderBuffer === -1), use the hook's page size (1000), otherwise use renderBuffer
    const pageSizeForCalc = renderBuffer === -1 ? 1000 : renderBuffer;
    const pageStart = effectiveCurrentPageRef.current * pageSizeForCalc;
    const pageEnd = pageStart + pageSizeForCalc - 1;

    // If current frame is not on this page, navigate to the correct page
    if (currentFrameIndex < pageStart || currentFrameIndex > pageEnd) {
      const targetPage = Math.floor(currentFrameIndex / pageSizeForCalc);
      setCurrentPageStable(targetPage);
    }
  }, [currentFrameIndex, setCurrentPageStable, renderBuffer]);

  // Calculate which row to highlight based on current frame index
  // Returns the index within visibleFrames, or null if current frame is not visible
  const highlightedRowIndex = useMemo(() => {
    if (currentFrameIndex == null || visibleFrames.length === 0) return null;

    // In playback mode (renderBuffer === -1), use the hook's page size (1000) to match auto-navigate
    const pageSizeForCalc = renderBuffer === -1 ? 1000 : renderBuffer;
    const pageStart = effectiveCurrentPage * pageSizeForCalc;
    const pageEnd = pageStart + visibleFrames.length - 1;

    // Check if current frame is on this page
    if (currentFrameIndex >= pageStart && currentFrameIndex <= pageEnd) {
      let rowIndex = currentFrameIndex - pageStart;
      // If frames were reversed for display, flip the index
      if (framesWereReversed) {
        rowIndex = visibleFrames.length - 1 - rowIndex;
      }
      return rowIndex;
    }
    return null;
  }, [currentFrameIndex, effectiveCurrentPage, renderBuffer, visibleFrames.length, framesWereReversed]);

  // Handle row click - convert row index to global frame index and get timestamp
  const handleRowClick = useCallback((rowIndex: number) => {
    if (!onFrameSelect || rowIndex >= visibleFrames.length) return;
    const effectivePageSize = renderBuffer === -1 ? visibleFrames.length : renderBuffer;
    // If frames were reversed for display, convert the visual row index back to the original index
    const originalRowIndex = framesWereReversed ? visibleFrames.length - 1 - rowIndex : rowIndex;
    // Use effectiveCurrentPage to match highlightedRowIndex calculation
    const globalFrameIndex = effectiveCurrentPage * effectivePageSize + originalRowIndex;
    const timestampUs = visibleFrames[rowIndex].timestamp_us;
    onFrameSelect(globalFrameIndex, timestampUs);
  }, [onFrameSelect, effectiveCurrentPage, renderBuffer, visibleFrames, framesWereReversed]);

  // Time range inputs for toolbar (optional feature)
  const timeRangeInputs = showTimeRange && onStartTimeChange && onEndTimeChange ? (
    <div className={flexRowGap2}>
      <label className={`text-xs ${textMuted}`}>Start</label>
      <input
        type="datetime-local"
        value={startTime || ""}
        onChange={(e) => onStartTimeChange(e.target.value)}
        className={`px-2 py-1 text-xs rounded ${borderDefault} ${bgSurface} ${textPrimary}`}
      />
      <label className={`text-xs ${textMuted} ml-2`}>End</label>
      <input
        type="datetime-local"
        value={endTime || ""}
        onChange={(e) => onEndTimeChange(e.target.value)}
        className={`px-2 py-1 text-xs rounded ${borderDefault} ${bgSurface} ${textPrimary}`}
      />
      <label className={`text-xs ${textMuted} ml-2`}>Buffer</label>
      <select
        value={maxBuffer}
        onChange={(e) => onMaxBufferChange(Number(e.target.value))}
        className={`px-2 py-1 text-xs rounded ${borderDefault} ${bgSurface} ${textPrimary}`}
        title="History buffer size"
      >
        <option value={10000}>10k</option>
        <option value={100000}>100k</option>
        <option value={500000}>500k</option>
        <option value={1000000}>1M</option>
        <option value={3000000}>3M</option>
      </select>
    </div>
  ) : null;

  // Toolbar and timeline only shown on frames tab
  const showToolbar = activeTab === 'frames';
  const showTimeline = activeTab === 'frames' && timelineProps.show;

  // Tab bar controls only shown on frames tab
  const tabBarControls = activeTab === 'frames' ? (
    <div className="flex items-center gap-1">
      {/* View mode toggle (pagination vs playback) - only shown when buffer is available */}
      {(isBufferMode || bufferMode.enabled) && (
        <button
          onClick={handleViewModeToggle}
          className={`p-1.5 rounded transition-colors ${
            bufferMode.viewMode === 'playback'
              ? 'bg-green-600 text-white hover:bg-green-500'
              : `${bgSurface} ${textSecondary} hover:brightness-95`
          }`}
          title={bufferMode.viewMode === 'playback' ? 'Switch to pagination mode' : 'Switch to playback mode'}
        >
          {bufferMode.viewMode === 'playback' ? <Play className={iconSm} /> : <LayoutList className={iconSm} />}
        </button>
      )}
      <button
        onClick={toggleShowBusColumn}
        className={`p-1.5 rounded transition-colors ${
          showBusColumn
            ? 'bg-cyan-600 text-white hover:bg-cyan-500'
            : `${bgSurface} ${textSecondary} hover:brightness-95`
        }`}
        title={showBusColumn ? 'Hide Bus column' : 'Show Bus column'}
      >
        <Network className={iconSm} />
      </button>
      <button
        onClick={toggleShowAsciiColumn}
        className={`p-1.5 rounded transition-colors ${
          showAsciiColumn
            ? 'bg-yellow-600 text-white hover:bg-yellow-500'
            : `${bgSurface} ${textSecondary} hover:brightness-95`
        }`}
        title={showAsciiColumn ? 'Hide ASCII column' : 'Show ASCII column'}
      >
        <FileText className={iconSm} />
      </button>
    </div>
  ) : undefined;

  // Playback controls for toolbar center
  // In buffer mode, buffer reader always supports seek, speed control, pause, and reverse
  // Only show when: in buffer mode (from session), recorded source, or buffer mode enabled when NOT streaming
  // The `bufferMode.enabled` check only applies when not streaming to avoid stale state during live streams
  const inBufferPlaybackMode = isBufferMode || (!isStreaming && bufferMode.enabled);
  const showPlaybackControls = inBufferPlaybackMode || isRecorded;
  const playbackControls = showPlaybackControls && onPlay && onPause ? (
    <PlaybackControls
      playbackState={playbackState}
      playbackDirection={playbackDirection}
      isReady={inBufferPlaybackMode || isRecorded}
      canPause={inBufferPlaybackMode || (capabilities?.can_pause ?? false)}
      supportsSeek={inBufferPlaybackMode || (capabilities?.supports_seek ?? false)}
      supportsSpeedControl={inBufferPlaybackMode || (capabilities?.supports_speed_control ?? false)}
      supportsReverse={inBufferPlaybackMode || (capabilities?.supports_reverse ?? false)}
      playbackSpeed={playbackSpeed}
      minTimeUs={timelineProps.minTimeUs}
      maxTimeUs={timelineProps.maxTimeUs}
      currentTimeUs={timelineProps.currentTimeUs}
      currentFrameIndex={currentFrameIndex}
      totalFrames={(isBufferMode || bufferMode.enabled) ? (bufferMetadata?.count || bufferMode.totalFrames || bufferFrameView.totalCount || undefined) : undefined}
      onPlay={onPlay}
      onPlayBackward={onPlayBackward}
      onPause={onPause}
      onStepBackward={onStepBackward}
      onStepForward={onStepForward}
      onScrub={timelineProps.onScrub}
      onFrameChange={onFrameChange}
      onSpeedChange={onSpeedChange}
    />
  ) : null;

  return (
    <AppTabView
      // Tab bar
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as 'frames' | 'filtered' | 'analysis')}
      protocolLabel={protocol.toUpperCase()}
      isStreaming={isStreaming}
      timestamp={timestamp}
      displayTime={displayTime}
      isRecorded={isRecorded}
      tabBarControls={tabBarControls}
      // Toolbar - only for frames tab
      toolbar={
        showToolbar
          ? {
              currentPage: effectiveCurrentPage,
              totalPages: effectiveTotalPages,
              pageSize: renderBuffer,
              pageSizeOptions: FRAME_PAGE_SIZE_OPTIONS,
              onPageChange: setCurrentPageStable,
              onPageSizeChange: handlePageSizeChange,
              loading: isFiltering || bufferModeLoading || isBufferFirstLoading,
              disabled: isStreaming,
              leftContent: timeRangeInputs,
              centerContent: playbackControls,
              hidePagination: isStreaming || isFiltering || bufferModeLoading || isBufferFirstLoading || bufferMode.viewMode === 'playback',
            }
          : undefined
      }
      // Timeline - only for frames tab
      timeline={
        showTimeline
          ? {
              minTimeUs: timelineProps.minTimeUs,
              maxTimeUs: timelineProps.maxTimeUs,
              currentTimeUs: timelineProps.currentTimeUs,
              onScrub: timelineProps.onScrub,
              displayTimeFormat,
              streamStartTimeUs: effectiveStartTimeUs,
              disabled: timelineProps.disabled,
            }
          : undefined
      }
      // Content area - no wrapper since FrameDataTable handles its own scroll
      contentArea={{ wrap: false }}
    >
      {activeTab === 'frames' && (
        <FrameDataTable
          ref={scrollRef}
          frames={visibleFrames}
          displayFrameIdFormat={displayFrameIdFormat}
          formatTime={formatTime}
          onBookmark={onBookmark}
          emptyMessage={isStreaming ? 'Waiting for frames...' : 'No frames to display'}
          showAscii={showAsciiColumn}
          showBus={showBusColumn}
          highlightedRowIndex={highlightedRowIndex}
          onRowClick={onFrameSelect ? handleRowClick : undefined}
          pageStartIndex={renderBuffer === -1 ? 0 : effectiveCurrentPage * renderBuffer}
          framesReversed={framesWereReversed}
          pageFrameCount={visibleFrames.length}
        />
      )}

      {activeTab === 'analysis' && (
        <div className={`flex-1 min-h-0 overflow-auto overscroll-none ${bgDataView} p-4`}>
          {toolboxResults.changesResults && <ChangesResultView />}
          {toolboxResults.messageOrderResults && <MessageOrderResultView />}
          {!hasAnalysisResults && (
            <div className={`${textDataSecondary} text-center py-8`}>
              No analysis results. Use the Toolbox to run analysis tools.
            </div>
          )}
        </div>
      )}
    </AppTabView>
  );
}

// Memoize to prevent re-renders when parent re-renders for unrelated reasons
// Note: This component also subscribes to store state (selectedFrames, renderBuffer)
// which will trigger re-renders when those change
export default memo(DiscoveryFramesView);
