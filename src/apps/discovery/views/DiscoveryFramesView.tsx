// ui/src/apps/discovery/views/DiscoveryFramesView.tsx
import React, { useEffect, useRef, useMemo, memo, useState, useCallback } from "react";
import { FileText, Network } from "lucide-react";
import { formatIsoUs, formatHumanUs, renderDeltaNode } from "../../../utils/timeFormat";
import { useDiscoveryStore } from "../../../stores/discoveryStore";
import { useDiscoveryUIStore } from "../../../stores/discoveryUIStore";
import { getBufferFramesPaginatedFiltered, findBufferOffsetForTimestamp, type BufferMetadata } from "../../../api/buffer";
import { DiscoveryViewController, FrameDataTable, type TabDefinition, FRAME_PAGE_SIZE_OPTIONS } from "../components";
import ChangesResultView from "./tools/ChangesResultView";
import MessageOrderResultView from "./tools/MessageOrderResultView";
import { bgDarkView, borderDarkView, textDarkMuted } from "../../../styles";
import type { FrameMessage } from "../../../types/frame";

type Props = {
  frames: FrameMessage[];
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
};

function DiscoveryFramesView({
  frames,
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
}: Props) {

  const renderBuffer = useDiscoveryStore((s) => s.renderBuffer);
  const setRenderBuffer = useDiscoveryStore((s) => s.setRenderBuffer);
  const selectedFrames = useDiscoveryStore((s) => s.selectedFrames);
  const bufferMode = useDiscoveryStore((s) => s.bufferMode);
  const toolboxResults = useDiscoveryStore((s) => s.toolbox);

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
    if (bufferMode.enabled && !isStreaming) {
      const pageSize = renderBuffer === -1 ? 1000 : renderBuffer; // Cap "All" at 1000 in buffer mode
      // Convert Set to Array for the API call (empty array = all frames)
      const selectedIds = Array.from(selectedFrames);
      fetchBufferPage(currentPage, pageSize, selectedIds);
    }
  }, [bufferMode.enabled, bufferMetadata?.id, currentPage, renderBuffer, isStreaming, fetchBufferPage, selectedFrames]);

  // Determine which result to use based on mode
  let visibleFrames: (FrameMessage & { hexBytes: string[] })[];
  let filteredCount: number;

  if (bufferMode.enabled && !isStreaming) {
    // Buffer mode: use frames fetched from backend (filtered by selection)
    visibleFrames = bufferModeFrames;
    filteredCount = bufferModeTotalCount; // This reflects the filtered count from backend
  } else if (isStreaming) {
    // Streaming mode
    const result = streamingResult ?? { visibleFrames: [], filteredCount: -1 };
    visibleFrames = result.visibleFrames;
    filteredCount = result.filteredCount;
  } else {
    // Stopped mode: use deferred result
    const result = deferredResult ?? { visibleFrames: [], filteredCount: 0 };
    visibleFrames = result.visibleFrames;
    filteredCount = result.filteredCount;
  }

  // Calculate pagination values (only meaningful when not streaming)
  const pageSize = renderBuffer === -1 ? Math.max(1, filteredCount) : renderBuffer;
  const totalPages = filteredCount > 0 && pageSize > 0 ? Math.ceil(filteredCount / pageSize) : 1;

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
  const tabs: TabDefinition[] = useMemo(() => [
    { id: 'frames', label: 'Frames', count: frameCount, countColor: 'green' as const },
    { id: 'analysis', label: 'Analysis', hasIndicator: hasAnalysisResults },
  ], [frameCount, hasAnalysisResults]);

  // Handle page size change - reset to page 0
  const handlePageSizeChange = useCallback((size: number) => {
    setRenderBuffer(size);
    setCurrentPage(0);
  }, [setRenderBuffer]);

  // Compute timeline props based on mode
  const timelineProps = useMemo(() => {
    // Buffer mode: use buffer metadata for time range
    if (bufferMode.enabled && !isStreaming && bufferMetadata?.start_time_us != null && bufferMetadata?.end_time_us != null) {
      const currentPos = bufferModeFrames.length > 0
        ? bufferModeFrames[0].timestamp_us
        : bufferMetadata.start_time_us;
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
  }, [bufferMode.enabled, isStreaming, bufferMetadata, bufferModeFrames, frames, currentTimeUs, handleBufferScrub, handleNormalScrub]);

  // Time range inputs for toolbar (optional feature)
  const timeRangeInputs = showTimeRange && onStartTimeChange && onEndTimeChange ? (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-400">Start</label>
      <input
        type="datetime-local"
        value={startTime || ""}
        onChange={(e) => onStartTimeChange(e.target.value)}
        className="px-2 py-1 text-xs rounded border border-gray-600 bg-gray-900 text-gray-200"
      />
      <label className="text-xs text-gray-400 ml-2">End</label>
      <input
        type="datetime-local"
        value={endTime || ""}
        onChange={(e) => onEndTimeChange(e.target.value)}
        className="px-2 py-1 text-xs rounded border border-gray-600 bg-gray-900 text-gray-200"
      />
      <label className="text-xs text-gray-400 ml-2">Buffer</label>
      <select
        value={maxBuffer}
        onChange={(e) => onMaxBufferChange(Number(e.target.value))}
        className="px-2 py-1 text-xs rounded border border-gray-600 bg-gray-900 text-gray-200"
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

  return (
    <div className={`flex flex-col flex-1 min-h-0 overflow-hidden rounded-lg border ${borderDarkView}`}>
      {/* Tab Content */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {activeTab === 'frames' && (
          <>
            {/* View Controller: Tab Bar + Toolbar + Timeline */}
            <DiscoveryViewController
              // Tab bar
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(id) => setActiveTab(id as 'frames' | 'analysis')}
              protocolLabel={protocol.toUpperCase()}
              isStreaming={isStreaming}
              timestamp={timestamp}
              displayTime={displayTime}
              isRecorded={isRecorded}
              tabBarControls={
                <div className="flex items-center gap-1">
                  <button
                    onClick={toggleShowBusColumn}
                    className={`p-1.5 rounded transition-colors ${
                      showBusColumn
                        ? 'bg-cyan-600 text-white hover:bg-cyan-500'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
                    }`}
                    title={showBusColumn ? 'Hide Bus column' : 'Show Bus column'}
                  >
                    <Network className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={toggleShowAsciiColumn}
                    className={`p-1.5 rounded transition-colors ${
                      showAsciiColumn
                        ? 'bg-yellow-600 text-white hover:bg-yellow-500'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
                    }`}
                    title={showAsciiColumn ? 'Hide ASCII column' : 'Show ASCII column'}
                  >
                    <FileText className="w-3.5 h-3.5" />
                  </button>
                </div>
              }

              // Toolbar
              showToolbar={true}
              currentPage={currentPage}
              totalPages={totalPages}
              pageSize={renderBuffer}
              pageSizeOptions={FRAME_PAGE_SIZE_OPTIONS}
              onPageChange={setCurrentPage}
              onPageSizeChange={handlePageSizeChange}
              toolbarLoading={isFiltering || bufferModeLoading}
              toolbarDisabled={isStreaming}
              toolbarLeftContent={timeRangeInputs}
              hidePagination={isStreaming || isFiltering || bufferModeLoading}

              // Timeline
              showTimeline={timelineProps.show}
              minTimeUs={timelineProps.minTimeUs}
              maxTimeUs={timelineProps.maxTimeUs}
              currentTimeUs={timelineProps.currentTimeUs}
              onTimelineScrub={timelineProps.onScrub}
              displayTimeFormat={displayTimeFormat}
              streamStartTimeUs={effectiveStartTimeUs}
              timelineDisabled={timelineProps.disabled}
            />

            {/* Frame Table */}
            <FrameDataTable
              ref={scrollRef}
              frames={visibleFrames}
              displayFrameIdFormat={displayFrameIdFormat}
              formatTime={formatTime}
              onBookmark={onBookmark}
              emptyMessage={isStreaming ? 'Waiting for frames...' : 'No frames to display'}
              showAscii={showAsciiColumn}
              showBus={showBusColumn}
            />
          </>
        )}

        {activeTab === 'analysis' && (
          <>
            {/* Show tab bar for analysis tab too */}
            <DiscoveryViewController
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(id) => setActiveTab(id as 'frames' | 'analysis')}
              protocolLabel={protocol.toUpperCase()}
              isStreaming={isStreaming}
              timestamp={timestamp}
              displayTime={displayTime}
              isRecorded={isRecorded}

              // No toolbar or timeline for analysis tab
              showToolbar={false}
              currentPage={0}
              totalPages={1}
              pageSize={20}
              onPageChange={() => {}}
              onPageSizeChange={() => {}}
              showTimeline={false}
              minTimeUs={0}
              maxTimeUs={0}
              currentTimeUs={0}
              onTimelineScrub={() => {}}
              displayTimeFormat={displayTimeFormat}
            />

            <div className={`flex-1 min-h-0 overflow-auto overscroll-none ${bgDarkView} p-4`}>
              {toolboxResults.changesResults && (
                <ChangesResultView />
              )}
              {toolboxResults.messageOrderResults && (
                <MessageOrderResultView />
              )}
              {!hasAnalysisResults && (
                <div className={`${textDarkMuted} text-center py-8`}>
                  No analysis results. Use the Toolbox to run analysis tools.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Memoize to prevent re-renders when parent re-renders for unrelated reasons
// Note: This component also subscribes to store state (selectedFrames, renderBuffer)
// which will trigger re-renders when those change
export default memo(DiscoveryFramesView);
