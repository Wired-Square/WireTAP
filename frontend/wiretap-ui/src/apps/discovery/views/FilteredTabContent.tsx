// ui/src/apps/discovery/views/FilteredTabContent.tsx
//
// Content for the "Filtered" tab in Discovery.
// Shows frames whose IDs are in seenIds but NOT in selectedFrames.

import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Filter } from "lucide-react";
import { useDiscoveryStore } from "../../../stores/discoveryStore";
import { useDiscoveryUIStore } from "../../../stores/discoveryUIStore";
import { keyOf, groupKeysByProtocol } from "../../../utils/frameKey";
import { getCaptureFramesPaginatedFiltered } from "../../../api/capture";
import { FrameDataTable, FRAME_PAGE_SIZE_OPTIONS } from "../components";
import { PaginationToolbar } from "../components";
import ContextMenu, { type ContextMenuItem } from "../../../components/ContextMenu";
import { bgDataView } from "../../../styles";
import { emptyStateText } from "../../../styles/typography";
import { iconXs } from "../../../styles/spacing";
import { formatFrameId } from "../../../utils/frameIds";
import { frameCopyMenuItems, frameInspectMenuItem, menuSeparator } from "../components/frameContextMenuItems";
import type { FrameMessage } from "../../../types/frame";
import type { FrameRow } from "../components";
import type { CaptureMetadata } from "../../../api/capture";
import { formatIsoUs, formatHumanUs, renderDeltaNode } from "../../../utils/timeFormat";
import type React from "react";
import { pageCount, resolvePageSize, type PageSize } from "../../../utils/pageSize";
import type { TimeDisplayFormat } from "../../../types/common";

type Props = {
  displayFrameIdFormat: "hex" | "decimal";
  displayTimeFormat: TimeDisplayFormat;
  isStreaming: boolean;
  streamStartTimeUs?: number | null;
  captureMetadata?: CaptureMetadata | null;
  useLocalTimezone?: boolean;
};

export default function FilteredTabContent({
  displayFrameIdFormat,
  displayTimeFormat,
  isStreaming,
  streamStartTimeUs,
  captureMetadata,
  useLocalTimezone = false,
}: Props) {
  const frames = useDiscoveryStore((s) => s.frames);
  const frameVersion = useDiscoveryStore((s) => s.frameVersion);
  const seenIds = useDiscoveryStore((s) => s.seenIds);
  const selectedFrames = useDiscoveryStore((s) => s.selectedFrames);
  const captureMode = useDiscoveryStore((s) => s.captureMode);
  const toggleFrameSelection = useDiscoveryStore((s) => s.toggleFrameSelection);

  // Column visibility (for header context menu)
  const { t } = useTranslation("discovery");
  const showRefColumn = useDiscoveryUIStore((s) => s.showRefColumn);
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const showSourceColumn = useDiscoveryUIStore((s) => s.showSourceColumn);
  const toggleShowRefColumn = useDiscoveryUIStore((s) => s.toggleShowRefColumn);
  const toggleShowAsciiColumn = useDiscoveryUIStore((s) => s.toggleShowAsciiColumn);
  const toggleShowSourceColumn = useDiscoveryUIStore((s) => s.toggleShowSourceColumn);
  const toggleShowBusColumn = useDiscoveryUIStore((s) => s.toggleShowBusColumn);

  const [currentPage, setCurrentPage] = useState(0);
  // Auto by default; the table measures itself and reports how many rows fit.
  const [pageSizeSetting, setPageSizeSetting] = useState<PageSize>("auto");
  const [autoRows, setAutoRows] = useState<number | null>(null);
  const pageSize = resolvePageSize(pageSizeSetting, autoRows);

  // Buffer mode state
  const [bufferFrames, setBufferFrames] = useState<FrameRow[]>([]);
  const [bufferTotalCount, setBufferTotalCount] = useState(0);
  const [bufferLoading, setBufferLoading] = useState(false);

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

  // The complement: seen but not selected. Keys stay composite — matching on the bare
  // numeric id would pull in the same id under another protocol.
  const filteredOutKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const fk of seenIds) {
      if (!selectedFrames.has(fk)) keys.add(fk);
    }
    return keys;
  }, [seenIds, selectedFrames]);

  const filteredOutSelection = useMemo(
    () => groupKeysByProtocol(filteredOutKeys),
    [filteredOutKeys]
  );

  // Effective start time for delta calculations
  const effectiveStartTimeUs = useMemo(() => {
    if (captureMode.enabled && captureMetadata?.start_time_us != null) {
      return captureMetadata.start_time_us;
    }
    return streamStartTimeUs;
  }, [captureMode.enabled, captureMetadata?.start_time_us, streamStartTimeUs]);

  const formatTime = useCallback(
    (ts_us: number, prevTs_us: number | null): React.ReactNode => {
      switch (displayTimeFormat) {
        case "delta-last":
          if (prevTs_us === null) return "0.000000s";
          return renderDeltaNode(ts_us - prevTs_us);
        case "delta-start":
          if (effectiveStartTimeUs == null) return "0.000000s";
          return renderDeltaNode(ts_us - effectiveStartTimeUs);
        case "timestamp":
          return formatIsoUs(ts_us, useLocalTimezone);
        case "human":
        default:
          return formatHumanUs(ts_us, useLocalTimezone);
      }
    },
    [displayTimeFormat, effectiveStartTimeUs, useLocalTimezone]
  );

  // Non-buffer mode: filter frames from the in-memory buffer
  const localResult = useMemo(() => {
    if (captureMode.enabled || filteredOutKeys.size === 0) return null;
    // Auto fit not measured yet — the tail limit and the slice below both come back empty.
    if (pageSize === null) return null;

    const matching: FrameMessage[] = [];

    if (isStreaming) {
      // During streaming: show the most recent matching frames (tail)
      const limit = pageSize;
      for (let i = frames.length - 1; i >= 0 && matching.length < limit; i--) {
        if (filteredOutKeys.has(keyOf(frames[i]))) {
          matching.push(frames[i]);
        }
      }
      matching.reverse();
    } else {
      // Stopped: collect all matching frames for pagination
      for (const f of frames) {
        if (filteredOutKeys.has(keyOf(f))) {
          matching.push(f);
        }
      }
    }

    return matching;
  }, [captureMode.enabled, filteredOutKeys, frameVersion, isStreaming, pageSize]);

  // Paginate the local result
  const localPage = useMemo(() => {
    if (!localResult || pageSize === null) return { frames: [] as FrameRow[], totalCount: 0 };

    const totalCount = localResult.length;
    let slice: FrameMessage[];
    if (isStreaming) {
      slice = localResult; // Already limited during streaming
    } else {
      const start = currentPage * pageSize;
      slice = localResult.slice(start, start + pageSize);
    }

    const withHex: FrameRow[] = slice.map((f) => ({
      ...f,
      hexBytes: f.bytes.map((b) =>
        b.toString(16).padStart(2, "0").toUpperCase()
      ),
    }));

    return { frames: withHex, totalCount };
  }, [localResult, currentPage, pageSize, isStreaming]);

  // Buffer mode: fetch filtered-out frames from backend
  useEffect(() => {
    if (!captureMode.enabled || isStreaming || filteredOutKeys.size === 0) return;
    if (pageSize === null) return; // auto size not measured yet

    let cancelled = false;
    const fetchPage = async () => {
      setBufferLoading(true);
      try {
        const offset = currentPage * pageSize;
        const response = await getCaptureFramesPaginatedFiltered(
          captureMetadata?.id ?? '',
          offset,
          pageSize,
          filteredOutSelection
        );
        if (cancelled) return;
        const withHex: FrameRow[] = response.frames.map((f: FrameMessage) => ({
          ...f,
          hexBytes: f.bytes.map((b: number) =>
            b.toString(16).padStart(2, "0").toUpperCase()
          ),
        }));
        setBufferFrames(withHex);
        setBufferTotalCount(response.total_count);
      } catch (e) {
        console.error("[FilteredTabContent] Failed to fetch buffer page:", e);
      } finally {
        if (!cancelled) setBufferLoading(false);
      }
    };

    fetchPage();
    return () => {
      cancelled = true;
    };
  }, [captureMode.enabled, isStreaming, filteredOutKeys, filteredOutSelection, currentPage, pageSize]);

  // Reset page when selection changes
  useEffect(() => {
    setCurrentPage(0);
  }, [selectedFrames]);

  // Determine which data to display
  const displayFrames = captureMode.enabled ? bufferFrames : localPage.frames;

  // Close context menus on page change
  useEffect(() => {
    setContextMenu(null);
    setHeaderContextMenu(null);
  }, [currentPage, displayFrames]);
  const totalCount = captureMode.enabled ? bufferTotalCount : localPage.totalCount;
  const totalPages = pageCount(totalCount, pageSize);
  const loading = captureMode.enabled ? bufferLoading : false;

  const handlePageSizeChange = useCallback((size: PageSize) => {
    setPageSizeSetting(size);
    setCurrentPage(0);
  }, []);

  // Frame context menu items
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const { frame } = contextMenu;
    const formatId = (id: number, isExtended?: boolean) =>
      formatFrameId(id, displayFrameIdFormat, isExtended);
    return [
      ...frameCopyMenuItems({ frame, t, formatId }),
      menuSeparator,
      {
        label: 'Unfilter',
        icon: <Filter className={iconXs} />,
        onClick: () => toggleFrameSelection(keyOf(frame)),
      },
      menuSeparator,
      frameInspectMenuItem(frame, t),
    ];
  }, [contextMenu, toggleFrameSelection, displayFrameIdFormat, t]);

  // Header context menu items
  const headerContextMenuItems: ContextMenuItem[] = useMemo(() => [
    { label: '# Column', checked: showRefColumn, onClick: toggleShowRefColumn },
    { label: 'Bus Column', checked: showBusColumn, onClick: toggleShowBusColumn },
    { label: 'ASCII Column', checked: showAsciiColumn, onClick: toggleShowAsciiColumn },
    { label: 'Source Column', checked: showSourceColumn, onClick: toggleShowSourceColumn },
  ], [showRefColumn, showBusColumn, showAsciiColumn, showSourceColumn, toggleShowRefColumn, toggleShowBusColumn, toggleShowAsciiColumn]);

  if (filteredOutKeys.size === 0) {
    return (
      <div className={`flex-1 min-h-0 flex items-center justify-center ${bgDataView}`}>
        <p className={`${emptyStateText} py-8`}>
          No filtered frames. All discovered frame IDs are currently selected.
        </p>
      </div>
    );
  }

  return (
    <>
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Toolbar - only show when not streaming */}
      {!isStreaming && (
        <PaginationToolbar
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSizeSetting}
          pageSizeOptions={FRAME_PAGE_SIZE_OPTIONS}
          allowAuto
          onPageChange={setCurrentPage}
          onPageSizeChange={handlePageSizeChange}
          isLoading={loading}
          disabled={false}
        />
      )}
      <FrameDataTable
        displayTimeFormat={displayTimeFormat}
        frames={displayFrames}
        formatTime={formatTime}
        showRef={showRefColumn}
        showAscii={showAsciiColumn}
        showBus={showBusColumn}
        showSourceAddress={showSourceColumn}
        autoFit={pageSizeSetting === "auto"}
        onFitChange={setAutoRows}
        emptyMessage={loading ? "Loading filtered frames..." : "No filtered frames to display"}
        onContextMenu={handleContextMenu}
        onHeaderContextMenu={handleHeaderContextMenu}
        useLocalTimezone={useLocalTimezone}
      />
    </div>

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
