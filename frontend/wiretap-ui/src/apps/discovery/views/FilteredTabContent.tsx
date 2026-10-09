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
import { useCaptureFrameView } from "../hooks/useCaptureFrameView";
import { FrameDataTable, FRAME_PAGE_SIZE_OPTIONS } from "../components";
import { PaginationToolbar } from "../components";
import ContextMenu, { type ContextMenuItem } from "../../../components/ContextMenu";
import { bgDataView } from "../../../styles";
import { emptyStateText } from "../../../styles/typography";
import { formatFrameId } from "../../../utils/frameIds";
import { frameCopyMenuItems, frameInspectMenuItem, menuSeparator } from "../components/frameContextMenuItems";
import type { FrameRow } from "../components";
import type { CaptureMetadata } from "../../../api/capture";
import { formatIsoUs, formatHumanUs, renderDeltaNode } from "../../../utils/timeFormat";
import type React from "react";
import { resolvePageSize, type PageSize } from "../../../utils/pageSize";
import type { TimeDisplayFormat } from "../../../types/common";

type Props = {
  /** The capture the Frames tab reads; this tab reads the same one. */
  captureId: string | null;
  sessionId?: string | null;
  displayFrameIdFormat: "hex" | "decimal";
  displayTimeFormat: TimeDisplayFormat;
  isStreaming: boolean;
  streamStartTimeUs?: number | null;
  captureMetadata?: CaptureMetadata | null;
  useLocalTimezone?: boolean;
};

export default function FilteredTabContent({
  captureId,
  sessionId,
  displayFrameIdFormat,
  displayTimeFormat,
  isStreaming,
  streamStartTimeUs,
  captureMetadata,
  useLocalTimezone = false,
}: Props) {
  const frameVersion = useDiscoveryStore((s) => s.frameVersion);
  const seenIds = useDiscoveryStore((s) => s.seenIds);
  const selectedFrames = useDiscoveryStore((s) => s.selectedFrames);
  const captureMode = useDiscoveryStore((s) => s.captureMode);
  const renderFrozen = useDiscoveryStore((s) => s.renderFrozen);
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

  // Auto by default; the table measures itself and reports how many rows fit.
  const [pageSizeSetting, setPageSizeSetting] = useState<PageSize>("auto");
  const [autoRows, setAutoRows] = useState<number | null>(null);
  const pageSize = resolvePageSize(pageSizeSetting, autoRows);

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

  const view = useCaptureFrameView({
    captureId: filteredOutKeys.size > 0 ? captureId : null,
    sessionId,
    isStreaming,
    selectedFrames: filteredOutSelection,
    pageSize,
    tailSize: pageSize === null ? null : Math.min(pageSize, 200),
    isCapturePlayback: captureMode.enabled,
    frozen: renderFrozen,
    revision: frameVersion,
  });
  const { currentPage, setCurrentPage } = view;

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

  // Reset page when selection changes
  useEffect(() => {
    setCurrentPage(0);
  }, [selectedFrames, setCurrentPage]);

  const displayFrames: FrameRow[] = view.frames;

  // Close context menus on page change
  useEffect(() => {
    setContextMenu(null);
    setHeaderContextMenu(null);
  }, [currentPage, displayFrames]);
  const loading = view.isLoading;

  const handlePageSizeChange = useCallback((size: PageSize) => {
    setPageSizeSetting(size);
    setCurrentPage(0);
  }, [setCurrentPage]);

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
        icon: <Filter />,
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
          totalPages={view.totalPages}
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
        captureIndices={view.captureIndices}
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
