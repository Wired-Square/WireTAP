// ui/src/apps/discovery/views/FilteredTabContent.tsx
//
// Content for the "Filtered" tab in Discovery.
// Shows frames whose IDs are in seenIds but NOT in selectedFrames.

import { useState, useEffect, useMemo, useCallback } from "react";
import { Filter, Calculator, Copy, ClipboardCopy } from "lucide-react";
import { useDiscoveryStore } from "../../../stores/discoveryStore";
import { useDiscoveryUIStore } from "../../../stores/discoveryUIStore";
import { getBufferFramesPaginatedFiltered } from "../../../api/buffer";
import { FrameDataTable, FRAME_PAGE_SIZE_OPTIONS } from "../components";
import { PaginationToolbar } from "../components";
import ContextMenu, { type ContextMenuItem } from "../../../components/ContextMenu";
import { bgDataView } from "../../../styles";
import { emptyStateText } from "../../../styles/typography";
import { iconXs } from "../../../styles/spacing";
import { bytesToHex } from "../../../utils/byteUtils";
import { formatFrameId } from "../../../utils/frameIds";
import { sendHexDataToCalculator } from "../../../utils/windowCommunication";
import type { FrameMessage } from "../../../types/frame";
import type { FrameRow } from "../components";
import type { BufferMetadata } from "../../../api/buffer";
import { formatIsoUs, formatHumanUs, renderDeltaNode } from "../../../utils/timeFormat";
import type React from "react";

type Props = {
  displayFrameIdFormat: "hex" | "decimal";
  displayTimeFormat: "delta-last" | "delta-start" | "timestamp" | "human";
  isStreaming: boolean;
  streamStartTimeUs?: number | null;
  bufferMetadata?: BufferMetadata | null;
};

export default function FilteredTabContent({
  displayFrameIdFormat,
  displayTimeFormat,
  isStreaming,
  streamStartTimeUs,
  bufferMetadata,
}: Props) {
  const frames = useDiscoveryStore((s) => s.frames);
  const frameVersion = useDiscoveryStore((s) => s.frameVersion);
  const seenIds = useDiscoveryStore((s) => s.seenIds);
  const selectedFrames = useDiscoveryStore((s) => s.selectedFrames);
  const bufferMode = useDiscoveryStore((s) => s.bufferMode);
  const toggleFrameSelection = useDiscoveryStore((s) => s.toggleFrameSelection);

  // Column visibility (for header context menu)
  const showRefColumn = useDiscoveryUIStore((s) => s.showRefColumn);
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const toggleShowRefColumn = useDiscoveryUIStore((s) => s.toggleShowRefColumn);
  const toggleShowAsciiColumn = useDiscoveryUIStore((s) => s.toggleShowAsciiColumn);
  const toggleShowBusColumn = useDiscoveryUIStore((s) => s.toggleShowBusColumn);

  const [currentPage, setCurrentPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

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

  // Compute filtered-out IDs: in seenIds but NOT in selectedFrames
  const filteredOutIds = useMemo(() => {
    const ids: number[] = [];
    for (const id of seenIds) {
      if (!selectedFrames.has(id)) {
        ids.push(id);
      }
    }
    return ids;
  }, [seenIds, selectedFrames]);

  // Effective start time for delta calculations
  const effectiveStartTimeUs = useMemo(() => {
    if (bufferMode.enabled && bufferMetadata?.start_time_us != null) {
      return bufferMetadata.start_time_us;
    }
    return streamStartTimeUs;
  }, [bufferMode.enabled, bufferMetadata?.start_time_us, streamStartTimeUs]);

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
          return formatIsoUs(ts_us);
        case "human":
        default:
          return formatHumanUs(ts_us);
      }
    },
    [displayTimeFormat, effectiveStartTimeUs]
  );

  // Non-buffer mode: filter frames from the in-memory buffer
  const localResult = useMemo(() => {
    if (bufferMode.enabled || filteredOutIds.length === 0) return null;

    const filteredIdSet = new Set(filteredOutIds);
    const matching: FrameMessage[] = [];

    if (isStreaming) {
      // During streaming: show the most recent matching frames (tail)
      const limit = pageSize;
      for (let i = frames.length - 1; i >= 0 && matching.length < limit; i--) {
        if (filteredIdSet.has(frames[i].frame_id)) {
          matching.push(frames[i]);
        }
      }
      matching.reverse();
    } else {
      // Stopped: collect all matching frames for pagination
      for (const f of frames) {
        if (filteredIdSet.has(f.frame_id)) {
          matching.push(f);
        }
      }
    }

    return matching;
  }, [bufferMode.enabled, filteredOutIds, frameVersion, isStreaming, pageSize]);

  // Paginate the local result
  const localPage = useMemo(() => {
    if (!localResult) return { frames: [] as FrameRow[], totalCount: 0 };

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
    if (!bufferMode.enabled || isStreaming || filteredOutIds.length === 0) return;

    let cancelled = false;
    const fetchPage = async () => {
      setBufferLoading(true);
      try {
        const offset = currentPage * pageSize;
        const response = await getBufferFramesPaginatedFiltered(
          offset,
          pageSize,
          filteredOutIds
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
  }, [bufferMode.enabled, isStreaming, filteredOutIds, currentPage, pageSize]);

  // Reset page when selection changes
  useEffect(() => {
    setCurrentPage(0);
  }, [selectedFrames]);

  // Determine which data to display
  const displayFrames = bufferMode.enabled ? bufferFrames : localPage.frames;

  // Close context menus on page change
  useEffect(() => {
    setContextMenu(null);
    setHeaderContextMenu(null);
  }, [currentPage, displayFrames]);
  const totalCount = bufferMode.enabled ? bufferTotalCount : localPage.totalCount;
  const totalPages = totalCount > 0 && pageSize > 0 ? Math.ceil(totalCount / pageSize) : 1;
  const loading = bufferMode.enabled ? bufferLoading : false;

  const handlePageSizeChange = useCallback((size: number) => {
    setPageSize(size);
    setCurrentPage(0);
  }, []);

  // Frame context menu items
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const { frame } = contextMenu;
    const hexData = (frame.hexBytes ?? frame.bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase())).join(' ');
    return [
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
        label: 'Unfilter',
        icon: <Filter className={iconXs} />,
        onClick: () => toggleFrameSelection(frame.frame_id),
      },
      { separator: true, label: '', onClick: () => {} },
      {
        label: 'Inspect',
        icon: <Calculator className={iconXs} />,
        onClick: () => sendHexDataToCalculator(bytesToHex(frame.bytes)),
      },
    ];
  }, [contextMenu, toggleFrameSelection, displayFrameIdFormat]);

  // Header context menu items
  const headerContextMenuItems: ContextMenuItem[] = useMemo(() => [
    { label: '# Column', checked: showRefColumn, onClick: toggleShowRefColumn },
    { label: 'Bus Column', checked: showBusColumn, onClick: toggleShowBusColumn },
    { label: 'ASCII Column', checked: showAsciiColumn, onClick: toggleShowAsciiColumn },
  ], [showRefColumn, showBusColumn, showAsciiColumn, toggleShowRefColumn, toggleShowBusColumn, toggleShowAsciiColumn]);

  if (filteredOutIds.length === 0) {
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
          pageSize={pageSize}
          pageSizeOptions={FRAME_PAGE_SIZE_OPTIONS}
          onPageChange={setCurrentPage}
          onPageSizeChange={handlePageSizeChange}
          isLoading={loading}
          disabled={false}
        />
      )}
      <FrameDataTable
        frames={displayFrames}
        displayFrameIdFormat={displayFrameIdFormat}
        formatTime={formatTime}
        showRef={showRefColumn}
        showAscii={showAsciiColumn}
        showBus={showBusColumn}
        emptyMessage={loading ? "Loading filtered frames..." : "No filtered frames to display"}
        onContextMenu={handleContextMenu}
        onHeaderContextMenu={handleHeaderContextMenu}
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
