// ui/src/apps/discovery/views/DiscoveryFramesView.tsx
import React, { useEffect, useRef, useMemo, memo, useState, useCallback } from "react";
import { FileText, Hash, Network, Filter, Snowflake, RefreshCw, Target, Send, Gauge, Bookmark, Search, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconSm, iconXs, flexRowGap2 } from "../../../styles/spacing";
import { formatIsoUs, formatHumanUs, renderDeltaNode } from "../../../utils/timeFormat";
import { TOOL_TAB_CONFIG } from "../../../stores/discoveryStore";
import { protocolForToolTab } from "../../../stores/discoveryToolboxStore";
import { useDiscoveryFrameStore } from "../../../stores/discoveryFrameStore";
import { useDiscoveryUIStore } from "../../../stores/discoveryUIStore";
import { useDiscoveryToolboxStore } from "../../../stores/discoveryToolboxStore";
import { type CaptureMetadata, searchCaptureFrames } from "../../../api/capture";
import { FrameDataTable, type TabDefinition, FRAME_PAGE_SIZE_OPTIONS } from "../components";
import { pageForOffset, resolvePageSize, type PageSize } from "../../../utils/pageSize";
import DiscoveryFindBar, { type FindSearchMode } from "../components/DiscoveryFindBar";
import AppTabView from "../../../components/AppTabView";
import { PlaybackControls, type PlaybackState } from "../../../components/PlaybackControls";
import type { PlaybackSpeed } from "../../../components/TimeController";
import ChangesResultView from "./tools/ChangesResultView";
import MessageOrderResultView from "./tools/MessageOrderResultView";
import ChecksumDiscoveryResultView from "./tools/ChecksumDiscoveryResultView";
import ModbusScanResultView from "./tools/ModbusScanResultView";
import ModbusFcProbeResultView from "./tools/ModbusFcProbeResultView";
import FilteredTabContent from "./FilteredTabContent";
import { bgDataView, bgSurface, tabBarIconToggle, textDataSecondary, textMuted, textPrimary, textSecondary, borderDefault } from "../../../styles";
import type { FrameMessage } from "../../../types/frame";
import { keyOf, groupKeysByProtocol, wholeProtocol } from "../../../utils/frameKey";
import DiscoveryModbusView from "./DiscoveryModbusView";
import type { IOCapabilities } from "../../../api/io";
import { BUFFER_POLL_INTERVAL_MS } from "../../../constants";
import { useCaptureFrameView } from "../hooks/useCaptureFrameView";
import ContextMenu, { type ContextMenuItem } from "../../../components/ContextMenu";
import { formatFrameId } from "../../../utils/frameIds";
import { protocolLabel } from "../../../utils/profileTraits";
import { openPanel } from "../../../utils/windowCommunication";
import { frameCopyMenuItems, frameInspectMenuItem, menuSeparator } from "../components/frameContextMenuItems";
import { useTransmitStore } from "../../../stores/transmitStore";
import { useDashboardStore } from "../../../stores/dashboardStore";
import { useSessionStore } from "../../../stores/sessionStore";
import type { FrameRow } from "../components/FrameDataTable";
import BulkAddToTransmitDialog from "../../../dialogs/BulkAddToTransmitDialog";
import ReplayDialog from "../../../dialogs/ReplayDialog";
import type { TimeDisplayFormat } from "../../../types/common";

const DEFAULT_SPEED_OPTIONS: PlaybackSpeed[] = [0.125, 0.25, 0.5, 1, 2, 10, 30, 60];

// Stable references: both are fetch dependencies of the Modbus tab's view.
const MODBUS_SELECTION = wholeProtocol("modbus_rtu");
const NO_FRAMES = new Set<string>();

type Props = {
  /** Capture the rows come from. Rust owns a capture for every session. */
  captureId?: string | null;
  /** Owning session — lets the frame view refetch its live tail when Rust reports new frames. */
  sessionId?: string | null;
  /** What the frames are, when anything says so. Absent is a real answer: with no
   *  source and nothing captured, the badge shows a dash rather than guessing. */
  protocol?: string;
  /** Every protocol the session carries — one tab each. A stream may hold several. */
  protocols?: string[];
  displayFrameIdFormat: "hex" | "decimal";
  displayTimeFormat: TimeDisplayFormat;
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

  // History size
  maxBuffer: number;
  onMaxBufferChange: (value: number) => void;

  // Timeline scrubber
  currentTimeUs?: number | null;
  onScrub?: (timeUs: number) => void;

  // Capture metadata (for timeline in capture mode)
  captureMetadata?: CaptureMetadata | null;

  // Whether the data source is recorded (e.g., WireTAP backend, CSV) vs live
  isRecorded?: boolean;

  // Playback controls (for capture replay)
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
  /** Frame-based seeking (preferred for capture playback) */
  onFrameChange?: (frameIndex: number) => void;
  /** Whether a recorded source is actively streaming (e.g., a WireTAP backend fetching) */
  isLiveStreaming?: boolean;
  /** Whether the timeline stream is paused (separate from capture playback pause) */
  isStreamPaused?: boolean;
  /** Called to resume a paused timeline stream */
  onResumeStream?: () => void;

  /** Called to cancel a running modbus scan */
  onCancelScan?: () => void;

  /** Whether to use local timezone for time display */
  useLocalTimezone?: boolean;
};

function DiscoveryFramesView({
  captureId,
  sessionId,
  protocol,
  protocols = [],
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
  captureMetadata,
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
  onCancelScan,
  useLocalTimezone = false,
}: Props) {
  const { t } = useTranslation("discovery");

  // The frame table's scroll container — the element the auto page size is measured from.
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ── UI store ──
  const renderBuffer = useDiscoveryUIStore((s) => s.renderBuffer);
  const setRenderBuffer = useDiscoveryUIStore((s) => s.setRenderBuffer);

  // ── Frame store ──
  const selectedFrames = useDiscoveryFrameStore((s) => s.selectedFrames);
  const seenIds = useDiscoveryFrameStore((s) => s.seenIds);
  const captureMode = useDiscoveryFrameStore((s) => s.captureMode);
  const renderFrozen = useDiscoveryFrameStore((s) => s.renderFrozen);
  const setRenderFrozen = useDiscoveryFrameStore((s) => s.setRenderFrozen);
  const refreshFrozenView = useDiscoveryFrameStore((s) => s.refreshFrozenView);

  // ── Toolbox store ──
  const toolboxResults = useDiscoveryToolboxStore((s) => s.toolbox);

  // ── Coordinated actions (cross-store wrappers) ──
  const toggleFrameSelection = useCallback((id: string) => {
    const { activeSelectionSetId, setSelectionSetDirty } = useDiscoveryUIStore.getState();
    useDiscoveryFrameStore.getState().toggleFrameSelection(id, activeSelectionSetId, setSelectionSetDirty);
  }, []);

  const deselectAllFrames = useCallback(() => {
    const { activeSelectionSetId, setSelectionSetDirty } = useDiscoveryUIStore.getState();
    useDiscoveryFrameStore.getState().deselectAllFrames(activeSelectionSetId, setSelectionSetDirty);
  }, []);

  // Find bar state
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMode, setFindMode] = useState<FindSearchMode>('both');
  const [findResults, setFindResults] = useState<number[]>([]);   // filteredOffsets in the entire capture
  const [findCurrentIndex, setFindCurrentIndex] = useState(-1);
  const [isFindSearching, setIsFindSearching] = useState(false);

  // Bulk-add / replay dialog state
  const [showBulkAddDialog, setShowBulkAddDialog] = useState(false);
  const [showReplayDialog, setShowReplayDialog] = useState(false);

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

  // The capture backing this view. One hook serves the live tail, a stopped page and
  // capture playback alike.
  // Use || to treat empty string IDs as absent (stale effectiveCaptureMetadata can produce id: "")
  const effectiveBufferId = captureId || captureMetadata?.id || null;

  // Capture playback = pagination mode (not tail-follow). True for: recorded source, paused stream, or store-level capture mode (after ingest)
  const isCapturePlayback = isRecorded || isStreamPaused || captureMode.enabled;

  // Rows per page. Everything below uses the resolved count, and every site must use the
  // same one — they used to disagree, so a row click and the playback highlight resolved
  // different frame indices.
  // The table measures its own geometry and reports the fit; null until it has.
  const [autoRows, setAutoRows] = useState<number | null>(null);
  const pageSize = resolvePageSize(renderBuffer, autoRows);

  const captureFrameView = useCaptureFrameView({
    captureId: effectiveBufferId,
    sessionId,
    isStreaming,
    selectedFrames,
    pageSize,
    tailSize: pageSize === null ? null : Math.min(pageSize, 200),
    pollIntervalMs: BUFFER_POLL_INTERVAL_MS,
    isCapturePlayback,
    frozen: renderFrozen,
    // During capture playback, the hook follows the playback position and auto-navigates pages
    followTimeUs: isCapturePlayback ? currentTimeUs : null,
  });

  // One tab per protocol the session carries. Whole Modbus RTU messages get their
  // own list; everything else shares the frames table, which is the CAN tab when
  // that is all it holds.
  const hasModbusTab = protocols.includes("modbus_rtu");
  const tableProtocols = useMemo(
    () => [...new Set(protocols.filter((p) => p !== "modbus_rtu").map((p) => (p === "canfd" ? "can" : p)))],
    [protocols],
  );
  const hasFramesTab = tableProtocols.length > 0 || !hasModbusTab;
  const homeTab = hasFramesTab ? "frames" : "modbus";

  // The Modbus tab is a raw view: its protocol whole, whatever the picker says, and
  // the live tail while streaming rather than the playback-following page.
  const modbusView = useCaptureFrameView({
    captureId: hasModbusTab ? effectiveBufferId : null,
    sessionId,
    isStreaming,
    selectedFrames: NO_FRAMES,
    selection: MODBUS_SELECTION,
    pageSize,
    tailSize: pageSize === null ? null : Math.min(pageSize, 200),
    pollIntervalMs: BUFFER_POLL_INTERVAL_MS,
    isCapturePlayback: isStreamPaused || captureMode.enabled,
    frozen: renderFrozen,
    followTimeUs: null,
  });

  // Tab state for CAN frames view - stored in UI store so analysis can switch to it
  const activeTab = useDiscoveryUIStore((s) => s.framesViewActiveTab);
  const setActiveTab = useDiscoveryUIStore((s) => s.setFramesViewActiveTab);

  // A tab that is not on offer cannot stay active: a Modbus-only session opens on
  // Modbus, and losing the protocol sends the view home.
  useEffect(() => {
    if ((activeTab === "frames" && !hasFramesTab) || (activeTab === "modbus" && !hasModbusTab)) {
      setActiveTab(homeTab);
    }
  }, [activeTab, hasFramesTab, hasModbusTab, homeTab, setActiveTab]);

  // Ref column toggle
  const showRefColumn = useDiscoveryUIStore((s) => s.showRefColumn);
  const toggleShowRefColumn = useDiscoveryUIStore((s) => s.toggleShowRefColumn);

  // ASCII column toggle
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  const toggleShowAsciiColumn = useDiscoveryUIStore((s) => s.toggleShowAsciiColumn);

  // Bus column toggle
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const toggleShowBusColumn = useDiscoveryUIStore((s) => s.toggleShowBusColumn);

  // Source address column toggle (J1939 and similar embed a sender ID in the frame)
  const showSourceColumn = useDiscoveryUIStore((s) => s.showSourceColumn);
  const toggleShowSourceColumn = useDiscoveryUIStore((s) => s.toggleShowSourceColumn);

  // Auto-unfreeze when streaming stops
  React.useEffect(() => {
    if (!isStreaming && renderFrozen) {
      setRenderFrozen(false);
    }
  }, [isStreaming, renderFrozen, setRenderFrozen]);

  // Keep stable references for scrub handler to avoid callback identity changes
  const effectiveTotalFramesRef = useRef<number | undefined>(undefined);
  const currentFrameIndexRef = useRef<number | null>(currentFrameIndex ?? null);

  useEffect(() => {
    currentFrameIndexRef.current = currentFrameIndex ?? null;
  }, [currentFrameIndex]);


  // Determine the effective start time for delta calculations
  // In capture mode, use capture metadata; otherwise use streamStartTimeUs from props
  const effectiveStartTimeUs = useMemo(() => {
    if (captureMode.enabled && captureMetadata?.start_time_us != null) {
      return captureMetadata.start_time_us;
    }
    return streamStartTimeUs;
  }, [captureMode.enabled, captureMetadata?.start_time_us, streamStartTimeUs]);

  const formatTime = (
    ts_us: number,
    prevTs_us: number | null
  ): React.ReactNode => {
    switch (displayTimeFormat) {
      case "delta-last":
        if (prevTs_us === null) return "0.000000s";
        return renderDelta(ts_us - prevTs_us);
      case "delta-start":
        // Use effectiveStartTimeUs - capture metadata in capture mode, streamStartTimeUs otherwise
        if (effectiveStartTimeUs == null) return "0.000000s";
        return renderDelta(ts_us - effectiveStartTimeUs);
      case "timestamp":
        return formatIsoUs(ts_us, useLocalTimezone);
      case "human":
      default:
        return formatHumanUs(ts_us, useLocalTimezone);
    }
  };

  const renderDelta = (deltaUs: number) => {
    return renderDeltaNode(deltaUs);
  };

  // ── The rows on screen ───────────────────────────────────────────────────────
  //
  // One source. Rust owns a frame capture for every session and writes each batch to it
  // before signalling, so the capture is authoritative from the first frame — for the
  // live tail, for a stopped page, and for capture playback alike. This view used to
  // carry two more paths beside it (a synchronous backwards scan of the in-memory buffer
  // while streaming, and a chunked setTimeout filter over the same buffer when stopped),
  // which is how the rows, the tab label and the toolbar counter could each disagree.
  const visibleFrames = captureFrameView.frames;
  const filteredCount = captureFrameView.totalCount;
  const effectiveCurrentPage = captureFrameView.currentPage;
  const isCaptureFirstLoading = captureFrameView.isLoading;

  const effectivePageStartIndex = captureFrameView.pageStartIndex;



  // Frames arrive chronological from Rust (ORDER BY rowid, and the tail query reverses
  // its DESC result), so this view no longer sorts, reverses or index-maps them.

  // The hook owns page state — there is no second copy to keep in sync any more, and the
  // useState setter it returns is already stable across renders.
  const setCurrentPageStable = captureFrameView.setCurrentPage;
  const goToRowStable = captureFrameView.goToRow;

  // Timeline scrub / stepping by frame index: seek the backend when it can, and move to
  // the page holding that frame either way.
  const handleFrameScrub = useCallback((frameIndex: number) => {
    // Clamp to avoid out-of-bounds seeks from stale totals
    const maxIdx = Math.max(0, (effectiveTotalFramesRef.current ?? 1) - 1);
    const clampedIndex = Math.max(0, Math.min(frameIndex, maxIdx));
    if (onFrameChange) {
      onFrameChange(clampedIndex);
    }
    goToRowStable(clampedIndex);
  }, [onFrameChange, goToRowStable]);

  const handleStepForwardLocal = useCallback(() => {
    const maxIdx = (effectiveTotalFramesRef.current ?? 1) - 1;
    handleFrameScrub(Math.min((currentFrameIndexRef.current ?? -1) + 1, maxIdx));
  }, [handleFrameScrub]);

  const handleStepBackwardLocal = useCallback(() => {
    handleFrameScrub(Math.max((currentFrameIndexRef.current ?? 1) - 1, 0));
  }, [handleFrameScrub]);


  // Close context menu when page or visible frames change
  useEffect(() => {
    setContextMenu(null);
  }, [effectiveCurrentPage, visibleFrames]);

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const { frame } = contextMenu;
    const formatId = (id: number, isExtended?: boolean) =>
      formatFrameId(id, displayFrameIdFormat, isExtended);
    const items: ContextMenuItem[] = [
      ...frameCopyMenuItems({ frame, t, formatId }),
      menuSeparator,
      {
        label: 'Filter',
        icon: <Filter className={iconXs} />,
        onClick: () => toggleFrameSelection(keyOf(frame as FrameMessage)),
      },
      {
        label: 'Solo',
        icon: <Target className={iconXs} />,
        onClick: () => { deselectAllFrames(); toggleFrameSelection(keyOf(frame as FrameMessage)); },
      },
      menuSeparator,
      frameInspectMenuItem(frame, t),
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
          useTransmitStore.getState().setActiveTab("frame");
          openPanel("transmit");
        },
      },
      {
        label: 'Add to Transmit queue',
        icon: <Send className={iconXs} />,
        onClick: () => setShowBulkAddDialog(true),
      },
      {
        label: 'Replay frames',
        icon: <Play className={iconXs} />,
        onClick: () => setShowReplayDialog(true),
      },
      {
        label: 'Dashboard',
        icon: <Gauge className={iconXs} />,
        onClick: () => {
          const sourceSessionId = useDiscoveryUIStore.getState().ioProfile;
          const store = useDashboardStore.getState();
          const panelId = store.addPanel('flow');
          store.updatePanel(panelId, { targetFrameId: frame.frame_id, title: formatFrameId(frame.frame_id, displayFrameIdFormat, frame.is_extended) });
          if (sourceSessionId) useSessionStore.getState().requestSessionJoin("dashboard", sourceSessionId);
          openPanel("dashboard");
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
  }, [contextMenu, toggleFrameSelection, deselectAllFrames, displayFrameIdFormat, onBookmark, t]);

  const headerContextMenuItems: ContextMenuItem[] = useMemo(() => [
    { label: '# Column', checked: showRefColumn, onClick: toggleShowRefColumn },
    { label: 'Bus Column', checked: showBusColumn, onClick: toggleShowBusColumn },
    { label: 'ASCII Column', checked: showAsciiColumn, onClick: toggleShowAsciiColumn },
    { label: 'Source Column', checked: showSourceColumn, onClick: toggleShowSourceColumn },
  ], [showRefColumn, showBusColumn, showAsciiColumn, showSourceColumn, toggleShowRefColumn, toggleShowBusColumn, toggleShowAsciiColumn, toggleShowSourceColumn]);

  // Compute count of filtered-out frame IDs (seen but not selected)
  const filteredOutCount = useMemo(() => {
    let count = 0;
    for (const id of seenIds) {
      if (!selectedFrames.has(id)) count++;
    }
    return count;
  }, [seenIds, selectedFrames]);

  // Build tab definitions: static tabs + dynamic tool output tabs
  // Every count on screen resolves to the same Rust-reported total, so the tab label,
  // the toolbar counter and the rows cannot disagree.
  const frameCount = filteredCount;
  const modbusCount = modbusView.totalCount;
  const tabs: TabDefinition[] = useMemo(() => {
    const result: TabDefinition[] = [];
    if (hasFramesTab) {
      // Named for its one protocol; "Frames" when it holds several or nothing has said.
      const label = tableProtocols.length === 1 ? protocolLabel(tableProtocols[0]) : 'Frames';
      result.push({ id: 'frames', label, count: frameCount, countColor: 'green' as const });
    }
    if (hasModbusTab) {
      result.push({ id: 'modbus', label: t("modbusView.tab"), count: modbusCount, countColor: 'green' as const });
    }
    result.push({ id: 'filtered', label: 'Filtered', count: filteredOutCount, countColor: 'orange' as const });
    if (toolboxResults.messageOrderResults) {
      result.push({ id: TOOL_TAB_CONFIG['message-order'].tabId, label: TOOL_TAB_CONFIG['message-order'].label, closeable: true });
    }
    if (toolboxResults.changesResults) {
      result.push({ id: TOOL_TAB_CONFIG['changes'].tabId, label: TOOL_TAB_CONFIG['changes'].label, closeable: true });
    }
    if (toolboxResults.checksumDiscoveryResults) {
      result.push({ id: TOOL_TAB_CONFIG['checksum-discovery'].tabId, label: TOOL_TAB_CONFIG['checksum-discovery'].label, closeable: true });
    }
    // Scan tabs count what the sweep found, which the progress payload reports —
    // the frames themselves live in the scan session's capture, not here.
    for (const key of ['modbus-register-scan', 'modbus-unit-scan'] as const) {
      const scan = key === 'modbus-register-scan'
        ? toolboxResults.modbusRegisterScanResults
        : toolboxResults.modbusUnitIdScanResults;
      if (!scan) continue;
      result.push({
        id: TOOL_TAB_CONFIG[key].tabId,
        label: TOOL_TAB_CONFIG[key].label,
        count: scan.isScanning ? undefined : scan.progress?.found_count,
        countColor: 'purple' as const,
        closeable: !scan.isScanning,
      });
    }
    if (toolboxResults.modbusFcProbeResults) {
      const probe = toolboxResults.modbusFcProbeResults;
      result.push({
        id: TOOL_TAB_CONFIG['modbus-function-codes'].tabId,
        label: TOOL_TAB_CONFIG['modbus-function-codes'].label,
        count: probe.isProbing ? undefined : probe.entries.filter((e) => e.responded).length,
        countColor: 'purple' as const,
        closeable: !probe.isProbing,
      });
    }
    return result;
  }, [hasFramesTab, hasModbusTab, tableProtocols, frameCount, modbusCount, filteredOutCount, t, toolboxResults.messageOrderResults, toolboxResults.changesResults, toolboxResults.checksumDiscoveryResults, toolboxResults.modbusRegisterScanResults, toolboxResults.modbusUnitIdScanResults, toolboxResults.modbusFcProbeResults]);

  // Handle closing a tool output tab
  const clearToolResult = useDiscoveryToolboxStore((s) => s.clearToolResult);
  const handleTabClose = useCallback((tabId: string) => {
    clearToolResult(tabId);
    if (activeTab === tabId) {
      setActiveTab(homeTab);
    }
  }, [clearToolResult, activeTab, setActiveTab, homeTab]);

  // Safety: fall back to the home tab if active tab is a tool tab that no longer exists
  useEffect(() => {
    if (activeTab.startsWith('tool:') && !tabs.some(t => t.id === activeTab)) {
      setActiveTab(homeTab);
    }
  }, [activeTab, tabs, setActiveTab, homeTab]);

  // Handle page size change - reset to page 0
  const handlePageSizeChange = useCallback((size: PageSize) => {
    setRenderBuffer(size);
    // Reset page using the stable callback
    setCurrentPageStable(0);
  }, [setRenderBuffer, setCurrentPageStable]);

  // Keep stable reference to hook's navigateToTimestamp
  const hookNavigateToTimestampRef = useRef(captureFrameView.navigateToTimestamp);
  useEffect(() => {
    hookNavigateToTimestampRef.current = captureFrameView.navigateToTimestamp;
  }, [captureFrameView.navigateToTimestamp]);

  // Handle timeline scrub - use hook's navigateToTimestamp in capture-first mode
  const handleCaptureFirstScrub = useCallback(async (timeUs: number) => {
    await hookNavigateToTimestampRef.current(timeUs);
    onScrub?.(timeUs);
  }, [onScrub]);

  // Timeline bounds come from the capture's own time range — Rust reports it alongside
  // the frames, so there is no frames array to measure here.
  const timelineProps = useMemo(() => {
    if (!captureFrameView.timeRange) {
      return { show: false, minTimeUs: 0, maxTimeUs: 0, currentTimeUs: 0, onScrub: () => {}, disabled: true };
    }
    return {
      show: true,
      minTimeUs: captureFrameView.timeRange.startUs,
      maxTimeUs: captureFrameView.timeRange.endUs,
      currentTimeUs: currentTimeUs ?? captureFrameView.timeRange.startUs,
      onScrub: handleCaptureFirstScrub,
      disabled: false,
    };
  }, [captureFrameView.timeRange, currentTimeUs, handleCaptureFirstScrub]);

  // Calculate which row to highlight based on current frame index or timestamp
  // Returns the index within visibleFrames, or null if current frame is not visible
  const highlightedRowIndex = useMemo(() => {
    if (visibleFrames.length === 0) return null;

    // Prefer frame-index-based highlighting (exact row positioning after scrubber seeks)
    if (currentFrameIndex != null) {
      const rowInPage = currentFrameIndex - effectivePageStartIndex;
      if (rowInPage >= 0 && rowInPage < visibleFrames.length) {
        return rowInPage;
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
  }, [currentFrameIndex, currentTimeUs, visibleFrames, pageSize, effectiveCurrentPage]);

  // Find bar: search the entire capture (in-memory or via Tauri for capture-first)
  // Debounce ref for capture-first async search
  const findDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!findOpen) {
      setFindResults([]);
      setFindCurrentIndex(-1);
      setIsFindSearching(false);
      return;
    }

    const q = findQuery.replace(/\s/g, '').toLowerCase();
    if (!q) {
      setFindResults([]);
      setFindCurrentIndex(-1);
      setIsFindSearching(false);
      return;
    }

    if (effectiveBufferId) {
      // Capture-first: async Tauri search with 300ms debounce
      if (findDebounceRef.current) clearTimeout(findDebounceRef.current);
      setIsFindSearching(true);
      findDebounceRef.current = setTimeout(async () => {
        try {
          const results = await searchCaptureFrames(
            effectiveBufferId,
            q,
            findMode !== 'data',
            findMode !== 'id',
            groupKeysByProtocol(selectedFrames),
          );
          setFindResults(results);
          setFindCurrentIndex(results.length > 0 ? 0 : -1);
        } finally {
          setIsFindSearching(false);
        }
      }, 300);
      return () => {
        if (findDebounceRef.current) clearTimeout(findDebounceRef.current);
      };
    }

    // No capture, nothing to search.
    setFindResults([]);
    setFindCurrentIndex(-1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, findMode, selectedFrames, effectiveBufferId]);

  // Navigate to match when findCurrentIndex changes (e.g. after results load)
  const navigateToMatch = useCallback((idx: number) => {
    if (findResults.length === 0 || idx < 0) return;
    const filteredOffset = findResults[idx];
    goToRowStable(filteredOffset);
    setFindCurrentIndex(idx);
  }, [findResults, goToRowStable]);

  // Auto-navigate when results first arrive
  useEffect(() => {
    if (findCurrentIndex === 0 && findResults.length > 0) {
      navigateToMatch(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findResults]);

  // Cmd/Ctrl+F to open find bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Resolve highlighted row: find bar takes priority over playback highlight
  const currentMatchOffset = (findOpen && findCurrentIndex >= 0 && findResults.length > 0)
    ? findResults[findCurrentIndex]
    : null;
  // Unmeasured page size means no page to compare against, so no match highlight yet.
  const currentMatch = currentMatchOffset != null && pageSize !== null
    ? { page: pageForOffset(currentMatchOffset, pageSize), row: currentMatchOffset % pageSize }
    : null;
  const effectiveHighlightedRow =
    currentMatch?.page === effectiveCurrentPage ? currentMatch.row : highlightedRowIndex;

  // Handle row click - convert row index to global frame index and get timestamp
  const handleRowClick = useCallback((rowIndex: number) => {
    if (!onFrameSelect || rowIndex >= visibleFrames.length) return;
    const globalFrameIndex = effectivePageStartIndex + rowIndex;
    const timestampUs = visibleFrames[rowIndex].timestamp_us;
    onFrameSelect(globalFrameIndex, timestampUs);
  }, [onFrameSelect, effectiveCurrentPage, pageSize, visibleFrames]);

  // Time range inputs for toolbar (optional feature)
  const timeRangeInputs = showTimeRange && onStartTimeChange && onEndTimeChange ? (
    <div className={flexRowGap2}>
      <label className={`text-xs ${textMuted}`}>{t("framesView.timeRange.start")}</label>
      <input
        type="datetime-local"
        value={startTime || ""}
        onChange={(e) => onStartTimeChange(e.target.value)}
        className={`px-2 py-1 text-xs rounded ${borderDefault} ${bgSurface} ${textPrimary}`}
      />
      <label className={`text-xs ${textMuted} ml-2`}>{t("framesView.timeRange.end")}</label>
      <input
        type="datetime-local"
        value={endTime || ""}
        onChange={(e) => onEndTimeChange(e.target.value)}
        className={`px-2 py-1 text-xs rounded ${borderDefault} ${bgSurface} ${textPrimary}`}
      />
      <label className={`text-xs ${textMuted} ml-2`}>{t("framesView.timeRange.buffer")}</label>
      <select
        value={maxBuffer}
        onChange={(e) => onMaxBufferChange(Number(e.target.value))}
        className={`px-2 py-1 text-xs rounded ${borderDefault} ${bgSurface} ${textPrimary}`}
        title={t("framesView.timeRange.historySize")}
      >
        <option value={10000}>10k</option>
        <option value={100000}>100k</option>
        <option value={500000}>500k</option>
        <option value={1000000}>1M</option>
        <option value={3000000}>3M</option>
      </select>
    </div>
  ) : null;

  // Toolbar on the protocol tabs, paging whichever view is on screen; timeline on frames only
  const isProtocolTab = activeTab === 'frames' || activeTab === 'modbus';
  const showToolbar = isProtocolTab;
  const showTimeline = activeTab === 'frames' && timelineProps.show;
  const activeView = activeTab === 'modbus' ? modbusView : captureFrameView;

  // Tab bar controls on the protocol tabs. Find, transmit and replay are the
  // frames table's; the column toggles and the freeze serve both.
  const tabBarControls = isProtocolTab ? (
    <div className="flex items-center gap-1">
      <button
        onClick={toggleShowRefColumn}
        aria-pressed={showRefColumn}
        className={tabBarIconToggle(showRefColumn)}
        title={showRefColumn ? 'Hide # column' : 'Show # column'}
      >
        <Hash className={iconSm} />
      </button>
      <button
        onClick={toggleShowBusColumn}
        aria-pressed={showBusColumn}
        className={tabBarIconToggle(showBusColumn, "cyan")}
        title={showBusColumn ? 'Hide Bus column' : 'Show Bus column'}
      >
        <Network className={iconSm} />
      </button>
      <button
        onClick={toggleShowAsciiColumn}
        aria-pressed={showAsciiColumn}
        className={tabBarIconToggle(showAsciiColumn, "yellow")}
        title={showAsciiColumn ? 'Hide ASCII column' : 'Show ASCII column'}
      >
        <FileText className={iconSm} />
      </button>
      {activeTab === 'frames' && (
        <>
          <button
            onClick={() => {
              if (findOpen) {
                setFindOpen(false);
                setFindQuery('');
                setFindResults([]);
                setFindCurrentIndex(-1);
              } else {
                setFindOpen(true);
              }
            }}
            aria-pressed={findOpen}
            className={tabBarIconToggle(findOpen)}
            title={findOpen ? 'Close find (Escape)' : 'Find in frames (⌘F)'}
          >
            <Search className={iconSm} />
          </button>
          <button
            onClick={() => setShowBulkAddDialog(true)}
            className={`p-1.5 rounded transition-colors ${bgSurface} ${textSecondary} hover:brightness-95`}
            title={t("framesView.actions.addToTransmit")}
          >
            <Send className={iconSm} />
          </button>
          <button
            onClick={() => setShowReplayDialog(true)}
            className={`p-1.5 rounded transition-colors ${bgSurface} ${textSecondary} hover:brightness-95`}
            title={t("framesView.actions.replay")}
          >
            <Play className={iconSm} />
          </button>
        </>
      )}
      {isStreaming && (
        <>
          <button
            onClick={() => setRenderFrozen(!renderFrozen)}
            aria-pressed={renderFrozen}
            className={tabBarIconToggle(renderFrozen, "blue")}
            title={renderFrozen ? t("framesView.actions.unfreezeDisplay") : t("framesView.actions.freezeDisplay")}
          >
            <Snowflake className={iconSm} />
          </button>
          {renderFrozen && (
            <button
              onClick={() => { activeView.refreshOnce(); refreshFrozenView(); }}
              className={`p-1.5 rounded transition-colors ${bgSurface} ${textSecondary} hover:brightness-95`}
              title={t("framesView.actions.refreshLatest")}
            >
              <RefreshCw className={iconSm} />
            </button>
          )}
        </>
      )}
    </div>
  ) : undefined;

  // Playback controls for toolbar center
  // Show playback controls for recorded sources (including captures), live streaming, or after ingest
  const showPlaybackControls = isRecorded || isLiveStreaming || (!isStreaming && captureMode.enabled);
  const effectiveTotalFrames = captureFrameView.totalCount || captureMetadata?.count || captureMode.totalFrames || undefined;
  effectiveTotalFramesRef.current = effectiveTotalFrames;

  // Wrapped play handlers: auto-seek to start/end when at boundary so playback has
  // frames to traverse (the capture reader re-pauses immediately at the boundary otherwise)
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
      isReady={isRecorded || isLiveStreaming || (!isStreaming && captureMode.enabled)}
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
          className={`px-1.5 text-xs font-mono tabular-nums text-center ${textDataSecondary}`}
          style={{ minWidth: `${maxChars}ch` }}
        >
          {currentStr} of {totalStr}
        </span>
      );
    }
    // During live streaming: show total frame count
    if (isStreaming && !isStreamPaused) {
      const count = filteredCount;
      if (count > 0) {
        return (
          <span className={`px-1.5 text-xs font-mono tabular-nums text-center ${textDataSecondary}`}>
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
      className={`px-2 py-0.5 text-xs rounded border ${borderDefault} ${bgSurface} ${textPrimary}`}
      title={t("framesView.actions.playbackSpeed")}
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
      protocolLabel={protocolLabel(protocol ?? protocolForToolTab(activeTab) ?? "—").toUpperCase()}
      isStreaming={isStreaming}
      timestamp={timestamp}
      displayTime={displayTime}
      isRecorded={isRecorded}
      tabBarControls={tabBarControls}
      // Toolbar - on the protocol tabs, paging the view on screen
      toolbar={
        showToolbar
          ? {
              currentPage: activeView.currentPage,
              totalPages: activeView.totalPages,
              pageSize: renderBuffer,
              pageSizeOptions: FRAME_PAGE_SIZE_OPTIONS,
              allowAuto: true,
              onPageChange: activeView.setCurrentPage,
              onPageSizeChange: handlePageSizeChange,
              loading: activeView.isLoading,
              // The Modbus tab tails a live stream; the frames table pages a recorded one.
              disabled: isStreaming && !isStreamPaused && (activeTab === 'modbus' || !isRecorded),
              leftContent: timeRangeInputs,
              centerContent: playbackControls,
              infoContent: activeTab === 'frames' ? frameCounterInfo : undefined,
              rightContent: speedSelector,
              hidePagination: activeView.isLoading,
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
              useLocalTimezone,
            }
          : undefined
      }
      // Content area - no wrapper since FrameDataTable handles its own scroll
      contentArea={{ wrap: false }}
    >
      {activeTab === 'frames' && (
        <>
          {findOpen && (
            <DiscoveryFindBar
              query={findQuery}
              onQueryChange={setFindQuery}
              matchCount={findResults.length}
              currentIndex={findCurrentIndex}
              onNext={() => navigateToMatch((findCurrentIndex + 1) % Math.max(1, findResults.length))}
              onPrev={() => navigateToMatch((findCurrentIndex - 1 + Math.max(1, findResults.length)) % Math.max(1, findResults.length))}
              onClose={() => { setFindOpen(false); setFindQuery(''); setFindResults([]); setFindCurrentIndex(-1); }}
              searchMode={findMode}
              onSearchModeChange={setFindMode}
              isSearching={isFindSearching}
            />
          )}
          <FrameDataTable
            displayTimeFormat={displayTimeFormat}
            ref={scrollRef}
            frames={visibleFrames}
            formatTime={formatTime}
            onBookmark={onBookmark}
            emptyMessage={
              // Reached only when the same fetch that produced the rows returned none,
              // so this can no longer appear beside rows.
              isCaptureFirstLoading
                ? 'Loading frames...'
                : isStreamPaused
                  ? 'No frames in capture'
                  : isStreaming ? 'Waiting for frames...' : 'No frames to display'
            }
            showRef={showRefColumn}
            showAscii={showAsciiColumn}
            showBus={showBusColumn}
            showSourceAddress={showSourceColumn}
            highlightedRowIndex={effectiveHighlightedRow}
            onRowClick={onFrameSelect ? handleRowClick : undefined}
            pageStartIndex={effectivePageStartIndex}
            captureIndices={captureFrameView.captureIndices}
            autoScroll={isStreaming && !isCapturePlayback}
            autoFit={renderBuffer === "auto"}
            onFitChange={setAutoRows}
            onContextMenu={handleContextMenu}
            onHeaderContextMenu={handleHeaderContextMenu}
            useLocalTimezone={useLocalTimezone}
          />
        </>
      )}

      {activeTab === 'modbus' && (
        <DiscoveryModbusView
          view={modbusView}
          formatTime={formatTime}
          displayFrameIdFormat={displayFrameIdFormat}
          displayTimeFormat={displayTimeFormat}
          isStreaming={isStreaming}
          isStreamPaused={isStreamPaused}
          showRef={showRefColumn}
          showBus={showBusColumn}
          showAscii={showAsciiColumn}
          autoFit={renderBuffer === "auto"}
          onFitChange={setAutoRows}
          useLocalTimezone={useLocalTimezone}
        />
      )}

      {activeTab === 'filtered' && (
        <FilteredTabContent
          displayFrameIdFormat={displayFrameIdFormat}
          displayTimeFormat={displayTimeFormat}
          isStreaming={isStreaming}
          streamStartTimeUs={effectiveStartTimeUs}
          captureMetadata={captureMetadata}
          useLocalTimezone={useLocalTimezone}
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

      {activeTab === TOOL_TAB_CONFIG['modbus-register-scan'].tabId && toolboxResults.modbusRegisterScanResults && (
        <ModbusScanResultView
          results={toolboxResults.modbusRegisterScanResults}
          currentSessionId={sessionId ?? ""}
          onClose={() => handleTabClose(TOOL_TAB_CONFIG['modbus-register-scan'].tabId)}
          onCancel={onCancelScan}
        />
      )}

      {activeTab === TOOL_TAB_CONFIG['modbus-function-codes'].tabId && toolboxResults.modbusFcProbeResults && (
        <div className="flex-1 min-h-0">
          <ModbusFcProbeResultView
            results={toolboxResults.modbusFcProbeResults}
            onClose={() => handleTabClose(TOOL_TAB_CONFIG['modbus-function-codes'].tabId)}
          />
        </div>
      )}

      {activeTab === TOOL_TAB_CONFIG['modbus-unit-scan'].tabId && toolboxResults.modbusUnitIdScanResults && (
        <ModbusScanResultView
          results={toolboxResults.modbusUnitIdScanResults}
          currentSessionId={sessionId ?? ""}
          onClose={() => handleTabClose(TOOL_TAB_CONFIG['modbus-unit-scan'].tabId)}
          onCancel={onCancelScan}
        />
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

    <BulkAddToTransmitDialog
      isOpen={showBulkAddDialog}
      onClose={() => setShowBulkAddDialog(false)}
    />
    <ReplayDialog
      isOpen={showReplayDialog}
      onClose={() => setShowReplayDialog(false)}
      captureId={captureId ?? null}
    />
    </>
  );
}

// Memoize to prevent re-renders when parent re-renders for unrelated reasons
// Note: This component also subscribes to store state (selectedFrames, renderBuffer)
// which will trigger re-renders when those change
export default memo(DiscoveryFramesView);
