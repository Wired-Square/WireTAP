// ui/src/apps/discovery/views/DiscoveryFramesView.tsx
import React, { useEffect, useRef, useMemo, memo, useState, useCallback } from "react";
import { FileText, Hash, Network, Filter, Calculator, Snowflake, RefreshCw, Copy, ClipboardCopy, Target, Send, BarChart3, Bookmark } from "lucide-react";
import { iconSm, iconXs, flexRowGap2 } from "../../../styles/spacing";
import { formatIsoUs, formatHumanUs, renderDeltaNode } from "../../../utils/timeFormat";
import { useDiscoveryStore, TOOL_TAB_CONFIG } from "../../../stores/discoveryStore";
import { useDiscoveryUIStore } from "../../../stores/discoveryUIStore";
import { type BufferMetadata } from "../../../api/buffer";
import { FrameDataTable, type TabDefinition, FRAME_PAGE_SIZE_OPTIONS } from "../components";
import AppTabView from "../../../components/AppTabView";
import { PlaybackControls, type PlaybackState } from "../../../components/PlaybackControls";
import type { PlaybackSpeed } from "../../../components/TimeController";
import ChangesResultView from "./tools/ChangesResultView";
import MessageOrderResultView from "./tools/MessageOrderResultView";
import ChecksumDiscoveryResultView from "./tools/ChecksumDiscoveryResultView";
import FilteredTabContent from "./FilteredTabContent";
import { bgDataView, bgSurface, textMuted, textPrimary, textSecondary, borderDefault } from "../../../styles";
import type { FrameMessage } from "../../../types/frame";
import type { IOCapabilities } from "../../../api/io";
import { BUFFER_POLL_INTERVAL_MS } from "../../../constants";
import { useBufferFrameView } from "../hooks/useBufferFrameView";
import ContextMenu, { type ContextMenuItem } from "../../../components/ContextMenu";
import { bytesToHex } from "../../../utils/byteUtils";
import { formatFrameId } from "../../../utils/frameIds";
import { sendHexDataToCalculator, openPanel } from "../../../utils/windowCommunication";
import { useTransmitStore } from "../../../stores/transmitStore";
import { useGraphStore } from "../../../stores/graphStore";
import { useSessionStore } from "../../../stores/sessionStore";
import type { FrameRow } from "../components/FrameDataTable";

const DEFAULT_SPEED_OPTIONS: PlaybackSpeed[] = [0.125, 0.25, 0.5, 1, 2, 10, 30, 60];

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
  /** Whether a timeline source is actively streaming (e.g., PostgreSQL fetching) */
  isLiveStreaming?: boolean;
  /** Whether the timeline stream is paused (separate from buffer playback pause) */
  isStreamPaused?: boolean;
  /** Called to resume a paused timeline stream */
  onResumeStream?: () => void;
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
  playbackState = "paused",
  playbackDirection = "forward",
  capabilities,
  playbackSpeed = 1,
  currentFrameIndex,
  onFrameSelect,
  onPlay,
  onPlayBackward,
  onPause,
  onStepBackward: _onStepBackward,
  onStepForward: _onStepForward,
  onSpeedChange,
  onFrameChange,
  isLiveStreaming = false,
  isStreamPaused = false,
  onResumeStream,
}: Props) {

  const renderBuffer = useDiscoveryStore((s) => s.renderBuffer);
  const setRenderBuffer = useDiscoveryStore((s) => s.setRenderBuffer);
  const selectedFrames = useDiscoveryStore((s) => s.selectedFrames);
  // frameVersion triggers re-renders when the mutable frame buffer changes
  const frameVersion = useDiscoveryStore((s) => s.frameVersion);
  const seenIds = useDiscoveryStore((s) => s.seenIds);
  const bufferMode = useDiscoveryStore((s) => s.bufferMode);
  const toolboxResults = useDiscoveryStore((s) => s.toolbox);
  const toggleFrameSelection = useDiscoveryStore((s) => s.toggleFrameSelection);
  const deselectAllFrames = useDiscoveryStore((s) => s.deselectAllFrames);
  const renderFrozen = useDiscoveryStore((s) => s.renderFrozen);
  const setRenderFrozen = useDiscoveryStore((s) => s.setRenderFrozen);
  const refreshFrozenView = useDiscoveryStore((s) => s.refreshFrozenView);

  // Context menu state (frame rows)
  const [contextMenu, setContextMenu] = useState<{
    frame: FrameRow;
    position: { x: number; y: number };
  } | null>(null);

  const handleContextMenu = useCallback((frame: FrameRow, position: { x: number; y: number }) => {
    setHeaderContextMenu(null);
    setContextMenu({ frame, position });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Context menu state (header columns)
  const [headerContextMenu, setHeaderContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleHeaderContextMenu = useCallback((position: { x: number; y: number }) => {
    setContextMenu(null);
    setHeaderContextMenu(position);
  }, []);

  const closeHeaderContextMenu = useCallback(() => {
    setHeaderContextMenu(null);
  }, []);

  // Use buffer-first hook when bufferId is available
  // This provides a unified interface for streaming (tail poll) and stopped (pagination)
  const effectiveBufferId = bufferId ?? bufferMetadata?.id ?? null;
  const useBufferFirstMode = effectiveBufferId !== null;

  // Buffer playback = pagination mode (not tail-follow). True for: recorded source, paused stream, or store-level buffer mode (after ingest)
  const isBufferPlayback = isRecorded || isStreamPaused || bufferMode.enabled;

  const bufferFrameView = useBufferFrameView({
    bufferId: effectiveBufferId,
    isStreaming,
    selectedFrames,
    pageSize: renderBuffer === -1 ? 1000 : renderBuffer,
    tailSize: renderBuffer === -1 ? 100 : renderBuffer,
    pollIntervalMs: BUFFER_POLL_INTERVAL_MS,
    isBufferPlayback,
    // During buffer playback, the hook follows the playback position and auto-navigates pages
    followTimeUs: isBufferPlayback ? currentTimeUs : null,
  });

  // Tab state for CAN frames view - stored in UI store so analysis can switch to it
  const activeTab = useDiscoveryUIStore((s) => s.framesViewActiveTab);
  const setActiveTab = useDiscoveryUIStore((s) => s.setFramesViewActiveTab);

  // Ref column toggle
  const showRefColumn = useDiscoveryUIStore((s) => s.showRefColumn);
  const toggleShowRefColumn = useDiscoveryUIStore((s) => s.toggleShowRefColumn);

  // ASCII column toggle
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  const toggleShowAsciiColumn = useDiscoveryUIStore((s) => s.toggleShowAsciiColumn);

  // Bus column toggle
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const toggleShowBusColumn = useDiscoveryUIStore((s) => s.toggleShowBusColumn);

  // Pagination state (only used when not streaming)
  const [currentPage, setCurrentPage] = useState(0);

  // Reset to minimum value and page 0 when streaming starts
  React.useEffect(() => {
    if (isStreaming) {
      setRenderBuffer(20);
      setCurrentPage(0);
    }
  }, [isStreaming, setRenderBuffer]);

  // Auto-unfreeze when streaming stops
  React.useEffect(() => {
    if (!isStreaming && renderFrozen) {
      setRenderFrozen(false);
    }
  }, [isStreaming, renderFrozen, setRenderFrozen]);

  // Keep stable references for scrub handler to avoid callback identity changes
  const selectedFramesRef = useRef(selectedFrames);
  const renderBufferRef = useRef(renderBuffer);
  const effectiveTotalFramesRef = useRef<number | undefined>(undefined);
  const currentFrameIndexRef = useRef<number | null>(currentFrameIndex ?? null);

  useEffect(() => {
    selectedFramesRef.current = selectedFrames;
    renderBufferRef.current = renderBuffer;
  }, [selectedFrames, renderBuffer]);

  useEffect(() => {
    currentFrameIndexRef.current = currentFrameIndex ?? null;
  }, [currentFrameIndex]);

  // Keep ref to frames for normal mode scrubbing
  const framesRef = useRef(frames);
  useEffect(() => {
    framesRef.current = frames;
  }, [frameVersion]);

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
    const indices: number[] = [];

    for (let i = frames.length - 1; i >= 0 && result.length < limit; i--) {
      const frame = frames[i];
      if (selectedFrames.has(frame.frame_id)) {
        result.push(frame);
        indices.push(i + 1); // 1-based position in the in-memory buffer
      }
    }

    // Reverse to get chronological order
    result.reverse();
    indices.reverse();

    // Pre-compute hex bytes for visible frames only
    const withHex = result.map(frame => ({
      ...frame,
      hexBytes: frame.bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()),
    }));

    return { visibleFrames: withHex, filteredCount: -1, indices };
  }, [frameVersion, selectedFrames, renderBuffer, isStreaming]);

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
  }, [isStreaming, frameVersion, selectedFrames, renderBuffer, currentPage]);

  // Determine which result to use based on mode
  let visibleFrames: (FrameMessage & { hexBytes: string[] })[];
  let filteredCount: number;
  let effectiveCurrentPage: number;
  let effectiveTotalPages: number;
  let isBufferFirstLoading = false;
  let streamingIndices: number[] | undefined;

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

  // Handle frame-index-based scrubbing from the timeline scrubber
  // Navigates to the correct page and optionally seeks the backend session
  const handleFrameScrub = useCallback((frameIndex: number) => {
    // Clamp to valid range to avoid out-of-bounds seeks from stale totals
    const maxIdx = Math.max(0, (effectiveTotalFramesRef.current ?? 1) - 1);
    const clampedIndex = Math.max(0, Math.min(frameIndex, maxIdx));
    // If in buffer playback mode with an active session, seek via backend
    if (onFrameChange) {
      onFrameChange(clampedIndex);
    }
    // Navigate to the page containing this frame index
    const pageSize = renderBufferRef.current === -1 ? 1000 : renderBufferRef.current;
    const targetPage = Math.floor(clampedIndex / pageSize);
    setCurrentPageStable(targetPage);
  }, [onFrameChange, setCurrentPageStable]);

  // Local step handlers that work in pagination mode without requiring a backend session.
  // Falls back to the backend handler when available, but always does frontend page navigation.
  const handleStepForwardLocal = useCallback(() => {
    const maxIdx = (effectiveTotalFramesRef.current ?? 1) - 1;
    const newIdx = Math.min((currentFrameIndexRef.current ?? -1) + 1, maxIdx);
    handleFrameScrub(newIdx);
  }, [handleFrameScrub]);

  const handleStepBackwardLocal = useCallback(() => {
    const newIdx = Math.max((currentFrameIndexRef.current ?? 1) - 1, 0);
    handleFrameScrub(newIdx);
  }, [handleFrameScrub]);

  if (useBufferFirstMode) {
    // Buffer-first mode: useBufferFrameView provides everything
    // Covers: CSV import, buffer replay, paused stream, recorded sources
    visibleFrames = bufferFrameView.frames;
    filteredCount = bufferFrameView.totalCount;
    effectiveCurrentPage = bufferFrameView.currentPage;
    effectiveTotalPages = bufferFrameView.totalPages;
    isBufferFirstLoading = bufferFrameView.isLoading;
  } else if (isStreaming) {
    // Active streaming (no buffer) - show tail of in-memory frames
    const result = streamingResult ?? { visibleFrames: [], filteredCount: -1, indices: [] };
    visibleFrames = result.visibleFrames;
    filteredCount = result.filteredCount;
    effectiveCurrentPage = currentPage;
    effectiveTotalPages = 1;
    streamingIndices = result.indices;
  } else {
    // Stopped without buffer - deferred filtered in-memory frames
    const result = deferredResult ?? { visibleFrames: [], filteredCount: 0 };
    visibleFrames = result.visibleFrames;
    filteredCount = result.filteredCount;
    effectiveCurrentPage = currentPage;
    const pageSize = renderBuffer === -1 ? Math.max(1, filteredCount) : renderBuffer;
    effectiveTotalPages = filteredCount > 0 && pageSize > 0 ? Math.ceil(filteredCount / pageSize) : 1;
  }

  // Calculate the actual start index for frame tooltips
  // Now all modes use proper pagination, so this is always effectiveCurrentPage * pageSize
  const effectivePageSize = renderBuffer === -1 ? 1000 : renderBuffer;
  const effectivePageStartIndex = effectiveCurrentPage * effectivePageSize;




  // Ensure frames are always sorted by timestamp ascending (oldest at top)
  // regardless of playback direction. Track if we reversed for index mapping.
  let framesWereReversed = false;
  if (visibleFrames.length > 1) {
    const firstTs = visibleFrames[0].timestamp_us;
    const lastTs = visibleFrames[visibleFrames.length - 1].timestamp_us;
    if (firstTs > lastTs) {
      // Frames are in descending order, reverse to get ascending
      visibleFrames = [...visibleFrames].reverse();
      if (streamingIndices) streamingIndices = [...streamingIndices].reverse();
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

  // Close context menu when page or visible frames change
  useEffect(() => {
    setContextMenu(null);
  }, [effectiveCurrentPage, visibleFrames]);

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const { frame } = contextMenu;
    const hexData = (frame.hexBytes ?? frame.bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase())).join(' ');
    const items: ContextMenuItem[] = [
      {
        label: 'Copy ID',
        icon: <Copy className={iconXs} />,
        onClick: () => navigator.clipboard.writeText(formatFrameId(frame.frame_id, displayFrameIdFormat, frame.is_extended)),
      },
      {
        label: 'Copy Data',
        icon: <ClipboardCopy className={iconXs} />,
        onClick: () => navigator.clipboard.writeText(hexData),
      },
      { separator: true, label: '', onClick: () => {} },
      {
        label: 'Filter',
        icon: <Filter className={iconXs} />,
        onClick: () => toggleFrameSelection(frame.frame_id),
      },
      {
        label: 'Solo',
        icon: <Target className={iconXs} />,
        onClick: () => { deselectAllFrames(); toggleFrameSelection(frame.frame_id); },
      },
      { separator: true, label: '', onClick: () => {} },
      {
        label: 'Inspect',
        icon: <Calculator className={iconXs} />,
        onClick: () => sendHexDataToCalculator(bytesToHex(frame.bytes)),
      },
      {
        label: 'Send to Transmit',
        icon: <Send className={iconXs} />,
        onClick: () => {
          const sourceSessionId = useDiscoveryUIStore.getState().ioProfile;
          useTransmitStore.getState().updateCanEditor({
            frameId: frame.frame_id.toString(16).toUpperCase(),
            dlc: frame.dlc,
            data: [...frame.bytes],
            isExtended: frame.is_extended ?? false,
            bus: frame.bus ?? 0,
          });
          if (sourceSessionId) useSessionStore.getState().requestSessionJoin("transmit", sourceSessionId);
          openPanel("transmit");
        },
      },
      {
        label: 'Graph',
        icon: <BarChart3 className={iconXs} />,
        onClick: () => {
          const sourceSessionId = useDiscoveryUIStore.getState().ioProfile;
          const store = useGraphStore.getState();
          const panelId = store.addPanel('flow');
          store.updatePanel(panelId, { targetFrameId: frame.frame_id, title: formatFrameId(frame.frame_id, displayFrameIdFormat, frame.is_extended) });
          if (sourceSessionId) useSessionStore.getState().requestSessionJoin("graph", sourceSessionId);
          openPanel("graph");
        },
      },
    ];
    if (onBookmark) {
      items.push(
        { separator: true, label: '', onClick: () => {} },
        {
          label: 'Bookmark',
          icon: <Bookmark className={iconXs} />,
          onClick: () => onBookmark(frame.frame_id, frame.timestamp_us),
        },
      );
    }
    return items;
  }, [contextMenu, toggleFrameSelection, deselectAllFrames, displayFrameIdFormat, onBookmark]);

  const headerContextMenuItems: ContextMenuItem[] = useMemo(() => [
    { label: '# Column', checked: showRefColumn, onClick: toggleShowRefColumn },
    { label: 'Bus Column', checked: showBusColumn, onClick: toggleShowBusColumn },
    { label: 'ASCII Column', checked: showAsciiColumn, onClick: toggleShowAsciiColumn },
  ], [showRefColumn, showBusColumn, showAsciiColumn, toggleShowRefColumn, toggleShowBusColumn, toggleShowAsciiColumn]);

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
  }, [frameVersion]);

  // Compute count of filtered-out frame IDs (seen but not selected)
  const filteredOutCount = useMemo(() => {
    let count = 0;
    for (const id of seenIds) {
      if (!selectedFrames.has(id)) count++;
    }
    return count;
  }, [seenIds, selectedFrames]);

  // Build tab definitions: static tabs + dynamic tool output tabs
  const frameCount = filteredCount > 0 ? filteredCount : frames.length;
  const tabs: TabDefinition[] = useMemo(() => {
    const result: TabDefinition[] = [
      { id: 'frames', label: 'Frames', count: frameCount, countColor: 'green' as const },
      { id: 'filtered', label: 'Filtered', count: filteredOutCount, countColor: 'orange' as const },
    ];
    if (toolboxResults.messageOrderResults) {
      result.push({ id: TOOL_TAB_CONFIG['message-order'].tabId, label: TOOL_TAB_CONFIG['message-order'].label, closeable: true });
    }
    if (toolboxResults.changesResults) {
      result.push({ id: TOOL_TAB_CONFIG['changes'].tabId, label: TOOL_TAB_CONFIG['changes'].label, closeable: true });
    }
    if (toolboxResults.checksumDiscoveryResults) {
      result.push({ id: TOOL_TAB_CONFIG['checksum-discovery'].tabId, label: TOOL_TAB_CONFIG['checksum-discovery'].label, closeable: true });
    }
    return result;
  }, [frameCount, filteredOutCount, toolboxResults.messageOrderResults, toolboxResults.changesResults, toolboxResults.checksumDiscoveryResults]);

  // Handle closing a tool output tab
  const clearToolResult = useDiscoveryStore((s) => s.clearToolResult);
  const handleTabClose = useCallback((tabId: string) => {
    clearToolResult(tabId);
    if (activeTab === tabId) {
      setActiveTab('frames');
    }
  }, [clearToolResult, activeTab, setActiveTab]);

  // Safety: fall back to 'frames' if active tab is a tool tab that no longer exists
  useEffect(() => {
    if (activeTab.startsWith('tool:') && !tabs.some(t => t.id === activeTab)) {
      setActiveTab('frames');
    }
  }, [activeTab, tabs, setActiveTab]);

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
    // Buffer-first mode: use hook's time range, session's currentTimeUs for position
    if (useBufferFirstMode && bufferFrameView.timeRange) {
      return {
        show: true,
        minTimeUs: bufferFrameView.timeRange.startUs,
        maxTimeUs: bufferFrameView.timeRange.endUs,
        currentTimeUs: currentTimeUs ?? bufferFrameView.timeRange.startUs,
        onScrub: handleBufferFirstScrub,
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
  }, [useBufferFirstMode, bufferFrameView.timeRange, isStreaming, frameVersion, currentTimeUs, handleBufferFirstScrub, handleNormalScrub]);

  // Calculate which row to highlight based on current frame index or timestamp
  // Returns the index within visibleFrames, or null if current frame is not visible
  const highlightedRowIndex = useMemo(() => {
    if (visibleFrames.length === 0) return null;

    // Prefer frame-index-based highlighting (exact row positioning after scrubber seeks)
    if (currentFrameIndex != null) {
      const pageSize = renderBuffer === -1 ? 1000 : renderBuffer;
      const rowInPage = currentFrameIndex - effectiveCurrentPage * pageSize;
      if (rowInPage >= 0 && rowInPage < visibleFrames.length) {
        return framesWereReversed ? visibleFrames.length - 1 - rowInPage : rowInPage;
      }
    }

    // Fall back to timestamp-based matching
    if (currentTimeUs == null) return null;

    // Find the frame in visibleFrames that matches the current timestamp
    // Use exact match first, then fall back to closest match
    let matchIndex = visibleFrames.findIndex(f => f.timestamp_us === currentTimeUs);

    // If no exact match, find the closest frame (for scrubbing between frames)
    if (matchIndex === -1) {
      let closestDistance = Infinity;
      visibleFrames.forEach((f, idx) => {
        const distance = Math.abs(f.timestamp_us - currentTimeUs);
        if (distance < closestDistance) {
          closestDistance = distance;
          matchIndex = idx;
        }
      });
      // Only use closest match if it's within 1ms (1000us)
      if (closestDistance > 1000) {
        matchIndex = -1;
      }
    }

    return matchIndex >= 0 ? matchIndex : null;
  }, [currentFrameIndex, currentTimeUs, visibleFrames, renderBuffer, effectiveCurrentPage, framesWereReversed]);

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
      <button
        onClick={toggleShowRefColumn}
        className={`p-1.5 rounded transition-colors ${
          showRefColumn
            ? 'bg-gray-600 text-white hover:bg-gray-500'
            : `${bgSurface} ${textSecondary} hover:brightness-95`
        }`}
        title={showRefColumn ? 'Hide # column' : 'Show # column'}
      >
        <Hash className={iconSm} />
      </button>
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
      {isStreaming && (
        <>
          <button
            onClick={() => setRenderFrozen(!renderFrozen)}
            className={`p-1.5 rounded transition-colors ${
              renderFrozen
                ? 'bg-blue-600 text-white hover:bg-blue-500'
                : `${bgSurface} ${textSecondary} hover:brightness-95`
            }`}
            title={renderFrozen ? 'Unfreeze display' : 'Freeze display'}
          >
            <Snowflake className={iconSm} />
          </button>
          {renderFrozen && (
            <button
              onClick={refreshFrozenView}
              className={`p-1.5 rounded transition-colors ${bgSurface} ${textSecondary} hover:brightness-95`}
              title="Refresh to latest frames"
            >
              <RefreshCw className={iconSm} />
            </button>
          )}
        </>
      )}
    </div>
  ) : undefined;

  // Playback controls for toolbar center
  // Show playback controls for recorded sources (including buffers), live streaming, or after ingest
  const showPlaybackControls = isRecorded || isLiveStreaming || (!isStreaming && bufferMode.enabled);
  // In buffer-first mode, never fall back to frameCount (frames.length) which may be stale
  // from the streaming array and differ from the actual buffer count.
  const effectiveTotalFrames = bufferFrameView.totalCount || bufferMetadata?.count || bufferMode.totalFrames || (!useBufferFirstMode ? frameCount : undefined) || undefined;
  effectiveTotalFramesRef.current = effectiveTotalFrames;

  // Wrapped play handlers: auto-seek to start/end when at boundary so playback has
  // frames to traverse (the buffer reader re-pauses immediately at the boundary otherwise)
  const handlePlayWrapped = useCallback(async () => {
    const idx = currentFrameIndexRef.current;
    const total = effectiveTotalFramesRef.current;
    if (idx != null && total != null && idx >= total - 1 && onFrameChange) {
      await onFrameChange(0);
    }
    onPlay?.();
  }, [onPlay, onFrameChange]);

  const handlePlayBackwardWrapped = useCallback(async () => {
    const idx = currentFrameIndexRef.current;
    const total = effectiveTotalFramesRef.current;
    if (idx != null && total != null && idx <= 0 && onFrameChange) {
      await onFrameChange(total - 1);
    }
    onPlayBackward?.();
  }, [onPlayBackward, onFrameChange]);

  const playbackControls = showPlaybackControls && onPlay && onPause ? (
    <PlaybackControls
      playbackState={playbackState}
      playbackDirection={playbackDirection}
      isReady={isRecorded || isLiveStreaming || (!isStreaming && bufferMode.enabled)}
      canPause={capabilities?.can_pause ?? false}
      supportsSeek={capabilities?.supports_seek ?? false}
      supportsSpeedControl={capabilities?.supports_speed_control ?? false}
      supportsReverse={capabilities?.supports_reverse ?? false}
      isLiveStreaming={isLiveStreaming}
      isStreamPaused={isStreamPaused}
      playbackSpeed={playbackSpeed}
      minTimeUs={timelineProps.minTimeUs}
      maxTimeUs={timelineProps.maxTimeUs}
      currentTimeUs={timelineProps.currentTimeUs}
      currentFrameIndex={currentFrameIndex}
      totalFrames={effectiveTotalFrames}
      onPlay={handlePlayWrapped}
      onPlayBackward={handlePlayBackwardWrapped}
      onPause={onPause}
      onStepBackward={handleStepBackwardLocal}
      onStepForward={handleStepForwardLocal}
      onScrub={timelineProps.onScrub}
      onFrameChange={onFrameChange}
      onSpeedChange={onSpeedChange}
      onResumeStream={onResumeStream}
    />
  ) : null;

  // Frame counter for the toolbar center info zone
  const frameCounterInfo = (() => {
    // During playback: show "X of Y" with current position
    if (showPlaybackControls && currentFrameIndex != null && effectiveTotalFrames) {
      const totalStr = effectiveTotalFrames.toLocaleString();
      const currentStr = (Math.max(0, Math.min(currentFrameIndex, effectiveTotalFrames - 1)) + 1).toLocaleString();
      // Stable min-width based on widest possible text to prevent layout shift
      const maxChars = totalStr.length * 2 + 4;
      return (
        <span
          className="px-1.5 text-xs font-mono text-gray-400 tabular-nums text-center"
          style={{ minWidth: `${maxChars}ch` }}
        >
          {currentStr} of {totalStr}
        </span>
      );
    }
    // During live streaming: show total frame count
    if (isStreaming && !isStreamPaused) {
      const count = useBufferFirstMode ? bufferFrameView.totalCount : frames.length;
      if (count > 0) {
        return (
          <span className="px-1.5 text-xs font-mono text-gray-400 tabular-nums text-center">
            {count.toLocaleString()}
          </span>
        );
      }
    }
    return null;
  })();

  // Speed selector for the toolbar right zone
  const speedSelector = showPlaybackControls && (capabilities?.supports_speed_control ?? false) && onSpeedChange ? (
    <select
      value={playbackSpeed}
      onChange={(e) => onSpeedChange(parseFloat(e.target.value) as PlaybackSpeed)}
      className="px-2 py-0.5 text-xs rounded border border-gray-600 bg-gray-700 text-gray-200"
      title="Playback speed"
    >
      {DEFAULT_SPEED_OPTIONS.map((s) => (
        <option key={s} value={s}>
          {s === 1 ? "1x (realtime)" : `${s}x`}
        </option>
      ))}
    </select>
  ) : null;

  return (
    <>
    <AppTabView
      // Tab bar
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id)}
      onTabClose={handleTabClose}
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
              loading: (!useBufferFirstMode && isFiltering) || isBufferFirstLoading,
              disabled: isStreaming && !isStreamPaused && !isRecorded,
              leftContent: timeRangeInputs,
              centerContent: playbackControls,
              infoContent: frameCounterInfo,
              rightContent: speedSelector,
              hidePagination: (!useBufferFirstMode && isFiltering) || isBufferFirstLoading,
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
              totalFrames: effectiveTotalFrames,
              currentFrameIndex: currentFrameIndex ?? undefined,
              onFrameChange: handleFrameScrub,
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
          emptyMessage={
            isStreamPaused
              ? (isBufferFirstLoading ? 'Loading frames...' : 'No frames in buffer')
              : (isStreaming ? 'Waiting for frames...' : 'No frames to display')
          }
          showCalculator={false}
          showRef={showRefColumn}
          showAscii={showAsciiColumn}
          showBus={showBusColumn}
          highlightedRowIndex={highlightedRowIndex}
          onRowClick={onFrameSelect ? handleRowClick : undefined}
          pageStartIndex={effectivePageStartIndex}
          framesReversed={framesWereReversed}
          pageFrameCount={visibleFrames.length}
          bufferIndices={useBufferFirstMode ? bufferFrameView.bufferIndices : streamingIndices}
          onContextMenu={handleContextMenu}
          onHeaderContextMenu={handleHeaderContextMenu}
        />
      )}

      {activeTab === 'filtered' && (
        <FilteredTabContent
          displayFrameIdFormat={displayFrameIdFormat}
          displayTimeFormat={displayTimeFormat}
          isStreaming={isStreaming}
          streamStartTimeUs={effectiveStartTimeUs}
          bufferMetadata={bufferMetadata}
        />
      )}

      {activeTab === TOOL_TAB_CONFIG['message-order'].tabId && toolboxResults.messageOrderResults && (
        <div className={`flex-1 min-h-0 overflow-auto overscroll-none ${bgDataView} p-4`}>
          <MessageOrderResultView onClose={() => handleTabClose(TOOL_TAB_CONFIG['message-order'].tabId)} />
        </div>
      )}

      {activeTab === TOOL_TAB_CONFIG['changes'].tabId && toolboxResults.changesResults && (
        <div className={`flex-1 min-h-0 overflow-auto overscroll-none ${bgDataView} p-4`}>
          <ChangesResultView onClose={() => handleTabClose(TOOL_TAB_CONFIG['changes'].tabId)} />
        </div>
      )}

      {activeTab === TOOL_TAB_CONFIG['checksum-discovery'].tabId && toolboxResults.checksumDiscoveryResults && (
        <div className={`flex-1 min-h-0 overflow-auto overscroll-none ${bgDataView} p-4`}>
          <ChecksumDiscoveryResultView onClose={() => handleTabClose(TOOL_TAB_CONFIG['checksum-discovery'].tabId)} />
        </div>
      )}
    </AppTabView>

    {contextMenu && (
      <ContextMenu
        items={contextMenuItems}
        position={contextMenu.position}
        onClose={closeContextMenu}
      />
    )}

    {headerContextMenu && (
      <ContextMenu
        items={headerContextMenuItems}
        position={headerContextMenu}
        onClose={closeHeaderContextMenu}
      />
    )}
    </>
  );
}

// Memoize to prevent re-renders when parent re-renders for unrelated reasons
// Note: This component also subscribes to store state (selectedFrames, renderBuffer)
// which will trigger re-renders when those change
export default memo(DiscoveryFramesView);
