// ui/src/apps/transmit/views/TransmitHistoryView.tsx
//
// SQLite-backed transmit history view with pagination.
// Reuses FrameDataTable for visual consistency with Discovery Frames.

import React, { useCallback, useMemo, useState, type ReactNode } from "react";
import { Trash2, Download, Radio, Check, X } from "lucide-react";

import type { BusSourceInfo } from "../../../stores/sessionStore";
import { useSettings } from "../../../hooks/useSettings";
import { textDataSecondary, textDataGreen } from "../../../styles/colourTokens";
import { textDanger } from "../../../styles";
import { badgeColorClass, buttonBase } from "../../../styles/buttonStyles";
import {
  emptyStateContainer,
  emptyStateText,
  emptyStateHeading,
  emptyStateDescription,
} from "../../../styles/typography";
import { byteToHex } from "../../../utils/byteUtils";
import { buildCsv } from "../../../utils/csvBuilder";
import { formatFrameId } from "../../../utils/frameIds";
import { formatIsoUs, formatHumanUs, renderDeltaNode } from "../../../utils/timeFormat";
import { transmitHistoryQuery, type TransmitHistoryRow } from "../../../api/transmitHistory";
import { useTransmitHistoryView } from "../hooks/useTransmitHistoryView";
import { FrameDataTable, type FrameRow, FRAME_PAGE_SIZE_OPTIONS } from "../../discovery/components";
import DataViewPaginationToolbar from "../../../components/DataViewPaginationToolbar";
import TimelineScrubber from "../../../components/TimelineScrubber";

interface TransmitHistoryViewProps {
  outputBusToSource?: Map<number, BusSourceInfo>;
  sessionId?: string | null;
}

function historyRowToFrameRow(row: TransmitHistoryRow): FrameRow {
  return {
    timestamp_us: row.timestamp_us,
    frame_id: row.frame_id ?? 0,
    protocol: 'can',
    is_extended: row.is_extended,
    dlc: row.dlc ?? 0,
    bytes: row.bytes,
    bus: row.bus,
  };
}

export default function TransmitHistoryView({ sessionId }: TransmitHistoryViewProps) {
  const { settings } = useSettings();
  const [pageSize, setPageSize] = useState(20);
  const {
    rows, totalCount, isLive, isLoading, currentPage, totalPages,
    setCurrentPage, setIsLive, clear, timeRange, navigateToTimestamp,
  } = useTransmitHistoryView({ pageSize, sessionId });
  const [isExporting, setIsExporting] = useState(false);

  const handlePageSizeChange = useCallback((size: number) => {
    setPageSize(size);
    setCurrentPage(0);
  }, [setCurrentPage]);

  const timestampFormat = settings?.display_time_format ?? "human";
  const useLocalTimezone = settings?.display_timezone === "local";

  // Oldest timestamp in the visible window (rows are newest-first, so last row is oldest)
  const oldestTimestampUs = useMemo(() => {
    if (rows.length === 0) return null;
    return rows[rows.length - 1].timestamp_us;
  }, [rows]);

  const formatTimestamp = useCallback(
    (timestampUs: number, prevTimestampUs: number | null): React.ReactNode => {
      switch (timestampFormat) {
        case "timestamp":
          return formatIsoUs(timestampUs, useLocalTimezone);
        case "delta-start":
          if (oldestTimestampUs === null) return "0.000000s";
          return renderDeltaNode(timestampUs - oldestTimestampUs);
        case "delta-last":
          if (prevTimestampUs === null) return "0.000000s";
          return renderDeltaNode(timestampUs - prevTimestampUs);
        case "human":
        default:
          return formatHumanUs(timestampUs, useLocalTimezone);
      }
    },
    [timestampFormat, oldestTimestampUs, useLocalTimezone]
  );

  const formatTimestampString = useCallback(
    (timestampUs: number): string => {
      switch (timestampFormat) {
        case "timestamp":
          return formatIsoUs(timestampUs, useLocalTimezone);
        case "delta-start":
        case "delta-last":
          return `${(timestampUs / 1_000_000).toFixed(6)}`;
        case "human":
        default:
          return formatHumanUs(timestampUs, useLocalTimezone);
      }
    },
    [timestampFormat, useLocalTimezone]
  );

  // Map history rows → FrameRow for FrameDataTable
  const frameRows: FrameRow[] = useMemo(
    () => rows.map(historyRowToFrameRow),
    [rows]
  );

  // Render status indicator per row (success/error)
  const renderRowStatus = useCallback((_frame: FrameRow, index: number): ReactNode => {
    const row = rows[index];
    if (!row) return null;
    if (row.success) {
      return <Check size={12} className={textDataGreen} />;
    }
    return (
      <span title={row.error_msg ?? "Transmit failed"}>
        <X size={12} className={textDanger} />
      </span>
    );
  }, [rows]);

  const displayFrameIdFormat = settings?.display_frame_id_format === "decimal" ? "decimal" : "hex";

  const handleExport = useCallback(async () => {
    if (totalCount === 0) return;
    setIsExporting(true);
    try {
      const allRows = await transmitHistoryQuery(0, totalCount + 1);
      const headers = ["Timestamp", "Session", "Kind", "Frame ID", "DLC", "Data", "Bus", "Flags", "Success", "Error"];
      const csvRows: (string | number)[][] = allRows.map((row) => {
        const frameIdStr = row.kind === "can" && row.frame_id != null
          ? formatFrameId(row.frame_id, "hex", row.is_extended)
          : "";
        const dataStr = row.bytes.map(byteToHex).join("");
        const flags = [
          row.is_extended && "EXT",
          row.is_fd && "FD",
        ].filter((f): f is string => Boolean(f)).join("|");
        return [
          formatTimestampString(row.timestamp_us),
          row.session_id,
          row.kind.toUpperCase(),
          frameIdStr,
          row.dlc ?? "",
          dataStr,
          row.bus,
          flags,
          row.success ? "true" : "false",
          row.error_msg ?? "",
        ];
      });
      const csv = buildCsv(headers, csvRows);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transmit-history-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  }, [totalCount, formatTimestampString]);

  // Current time for timeline scrubber (midpoint of visible rows)
  const currentTimeUs = useMemo(() => {
    if (rows.length === 0) return timeRange?.startUs ?? 0;
    return rows[0].timestamp_us;
  }, [rows, timeRange]);

  return (
    <div className="flex flex-col h-full">
      {/* Empty state */}
      {totalCount === 0 && !isLoading && (
        <div className={emptyStateContainer}>
          <div className={emptyStateText}>
            <p className={emptyStateHeading}>No History</p>
            <p className={emptyStateDescription}>
              Transmitted frames will appear here.
            </p>
          </div>
        </div>
      )}

      {totalCount > 0 && (
        <>
          {/* Toolbar */}
          <DataViewPaginationToolbar
            currentPage={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            pageSizeOptions={FRAME_PAGE_SIZE_OPTIONS}
            onPageChange={setCurrentPage}
            onPageSizeChange={handlePageSizeChange}
            disabled={isLive}
            hidePagination={isLive}
            leftContent={
              <div className="flex items-center gap-3">
                <span className={`${textDataSecondary} text-sm`}>
                  {totalCount.toLocaleString()} frame{totalCount !== 1 ? "s" : ""}
                </span>
                <button
                  onClick={() => setIsLive(!isLive)}
                  className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded ${
                    isLive
                      ? badgeColorClass('green')
                      : badgeColorClass('amber')
                  }`}
                  title={isLive ? "Showing latest frames (click to browse)" : "Browsing history (click for live)"}
                >
                  <Radio size={10} />
                  {isLive ? "Live" : "Browsing"}
                </button>
              </div>
            }
            rightContent={
              <div className="flex items-center gap-2">
                <button
                  onClick={handleExport}
                  disabled={isExporting}
                  className={buttonBase}
                  title="Export as CSV"
                >
                  <Download size={14} />
                  <span className="text-sm ml-1">{isExporting ? "Exporting…" : "Export"}</span>
                </button>
                <button
                  onClick={clear}
                  className={buttonBase}
                  title="Clear history"
                >
                  <Trash2 size={14} />
                  <span className="text-sm ml-1">Clear</span>
                </button>
              </div>
            }
          />

          {/* Timeline scrubber — always visible when there's a time range, disabled in live mode */}
          {timeRange && (
            <TimelineScrubber
              minTimeUs={timeRange.startUs}
              maxTimeUs={timeRange.endUs}
              currentTimeUs={currentTimeUs}
              onPositionChange={navigateToTimestamp}
              displayTimeFormat={timestampFormat}
              disabled={isLive}
              useLocalTimezone={useLocalTimezone}
            />
          )}

          {/* Frame table — matches Discovery Frames styling */}
          <FrameDataTable
            frames={frameRows}
            displayFrameIdFormat={displayFrameIdFormat}
            formatTime={formatTimestamp}
            showCalculator={false}
            showRef={false}
            showBus={true}
            autoScroll={isLive}
            emptyMessage={isLoading ? "Loading…" : "No frames to display"}
            renderRowStatus={renderRowStatus}
            useLocalTimezone={useLocalTimezone}
          />
        </>
      )}
    </div>
  );
}
