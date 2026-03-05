// ui/src/apps/transmit/views/TransmitHistoryView.tsx
//
// Paginated, SQLite-backed transmit history view.
// Fetches rows from the Rust backend on mount and whenever historyDbCount
// changes (signalled by the transmit-history-updated event).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, Check, X, Download, ChevronDown } from "lucide-react";
import { useTransmitStore } from "../../../stores/transmitStore";
import type { BusSourceInfo } from "../../../stores/sessionStore";
import { useSettings } from "../../../hooks/useSettings";
import {
  bgDataToolbar,
  borderDataView,
  textDataSecondary,
  hoverDataRow,
} from "../../../styles/colourTokens";
import { flexRowGap2 } from "../../../styles/spacing";
import { buttonBase } from "../../../styles/buttonStyles";
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
import { formatBusLabel } from "../../../utils/busFormat";
import {
  transmitHistoryQuery,
  transmitHistoryClear,
  type TransmitHistoryRow,
} from "../../../api/transmitHistory";

const PAGE_SIZE = 200;

interface TransmitHistoryViewProps {
  outputBusToSource: Map<number, BusSourceInfo>;
}

export default function TransmitHistoryView({ outputBusToSource }: TransmitHistoryViewProps) {
  const { settings } = useSettings();
  const historyDbCount = useTransmitStore((s) => s.historyDbCount);

  const [rows, setRows] = useState<TransmitHistoryRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const timestampFormat = settings?.display_time_format ?? "human";

  // Fetch the first page (newest PAGE_SIZE rows). Called on mount and when historyDbCount changes.
  const fetchFirstPage = useCallback(async () => {
    setIsLoading(true);
    try {
      const newRows = await transmitHistoryQuery(0, PAGE_SIZE);
      setRows(newRows);
      setOffset(newRows.length);
      setHasMore(newRows.length === PAGE_SIZE);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFirstPage();
  }, [historyDbCount, fetchFirstPage]);

  const handleLoadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;
    setIsLoading(true);
    try {
      const newRows = await transmitHistoryQuery(offset, PAGE_SIZE);
      setRows((prev) => [...prev, ...newRows]);
      setOffset((prev) => prev + newRows.length);
      setHasMore(newRows.length === PAGE_SIZE);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, hasMore, offset]);

  const handleClear = useCallback(async () => {
    await transmitHistoryClear();
    setRows([]);
    setOffset(0);
    setHasMore(false);
    useTransmitStore.setState({ historyDbCount: 0 });
  }, []);

  // Oldest timestamp for delta-start (rows are newest-first, so last row is oldest)
  const oldestTimestampUs = useMemo(() => {
    if (rows.length === 0) return null;
    return rows[rows.length - 1].timestamp_us;
  }, [rows]);

  const formatTimestamp = useCallback(
    (timestampUs: number, prevTimestampUs: number | null): React.ReactNode => {
      switch (timestampFormat) {
        case "timestamp":
          return formatIsoUs(timestampUs);
        case "delta-start":
          if (oldestTimestampUs === null) return "0.000000s";
          return renderDeltaNode(timestampUs - oldestTimestampUs);
        case "delta-last":
          if (prevTimestampUs === null) return "0.000000s";
          return renderDeltaNode(timestampUs - prevTimestampUs);
        case "human":
        default:
          return formatHumanUs(timestampUs);
      }
    },
    [timestampFormat, oldestTimestampUs]
  );

  const formatTimestampString = useCallback(
    (timestampUs: number): string => {
      switch (timestampFormat) {
        case "timestamp":
          return formatIsoUs(timestampUs);
        case "delta-start":
        case "delta-last":
          return `${(timestampUs / 1_000_000).toFixed(6)}`;
        case "human":
        default:
          return formatHumanUs(timestampUs);
      }
    },
    [timestampFormat]
  );

  const handleExport = useCallback(async () => {
    if (rows.length === 0 && historyDbCount === 0) return;
    setIsLoading(true);
    try {
      // Fetch all rows for export (no pagination limit)
      const allRows = await transmitHistoryQuery(0, Math.max(historyDbCount, rows.length) + 1);
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
      setIsLoading(false);
    }
  }, [rows.length, historyDbCount, formatTimestampString]);

  const failedCount = useMemo(() => rows.filter((r) => !r.success).length, [rows]);

  return (
    <div className="flex flex-col h-full">
      {/* Empty state */}
      {rows.length === 0 && !isLoading && (
        <div className={emptyStateContainer}>
          <div className={emptyStateText}>
            <p className={emptyStateHeading}>No History</p>
            <p className={emptyStateDescription}>
              Transmitted packets will appear here.
            </p>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Toolbar */}
          <div
            className={`flex items-center gap-3 px-4 py-2 ${bgDataToolbar} border-b ${borderDataView}`}
          >
            <span className={`${textDataSecondary} text-sm`}>
              {historyDbCount > 0 ? historyDbCount.toLocaleString() : rows.length} packet{historyDbCount !== 1 ? "s" : ""}
              {failedCount > 0 && (
                <span className="text-red-400 ml-2">
                  ({failedCount} failed)
                </span>
              )}
            </span>

            <div className="flex-1" />

            <button
              onClick={handleExport}
              disabled={isLoading}
              className={buttonBase}
              title="Export as CSV"
            >
              <Download size={14} />
              <span className="text-sm ml-1">Export</span>
            </button>

            <button
              onClick={handleClear}
              className={buttonBase}
              title="Clear history"
            >
              <Trash2 size={14} />
              <span className="text-sm ml-1">Clear</span>
            </button>
          </div>

          {/* History table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead
                className={`${bgDataToolbar} sticky top-0 ${textDataSecondary} text-xs`}
              >
                <tr>
                  <th className="text-left px-4 py-2 w-10"></th>
                  <th className="text-left px-4 py-2">Timestamp</th>
                  <th className="text-left px-4 py-2">Bus</th>
                  <th className="text-left px-4 py-2 w-16">Kind</th>
                  <th className="text-left px-4 py-2">Frame / Data</th>
                  <th className="text-left px-4 py-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const prevTimestampUs =
                    index < rows.length - 1 ? rows[index + 1].timestamp_us : null;

                  const isCanRow = row.kind === "can";
                  const frameIdStr = isCanRow && row.frame_id != null
                    ? formatFrameId(row.frame_id, "hex", row.is_extended)
                    : null;
                  const dlcStr = row.dlc != null ? `[${row.dlc}]` : "";
                  const dataStr = row.bytes.slice(0, 8).map(byteToHex).join(" ");
                  const truncated = row.bytes.length > 8 ? " …" : "";
                  const flags = [
                    row.is_extended && "EXT",
                    row.is_fd && "FD",
                  ].filter((f): f is string => Boolean(f));

                  return (
                    <tr
                      key={row.id}
                      className={`border-b ${borderDataView} ${hoverDataRow}`}
                    >
                      {/* Status */}
                      <td className="px-4 py-2">
                        {row.success ? (
                          <Check size={14} className="text-green-400" />
                        ) : (
                          <X size={14} className="text-red-400" />
                        )}
                      </td>

                      {/* Timestamp */}
                      <td className="px-4 py-2">
                        <span className="font-mono text-gray-400 text-xs">
                          {formatTimestamp(row.timestamp_us, prevTimestampUs)}
                        </span>
                      </td>

                      {/* Bus */}
                      <td className="px-4 py-2">
                        <span
                          className={`${textDataSecondary} text-xs truncate max-w-[120px] block`}
                          title={formatBusLabel(row.session_id, isCanRow ? row.bus : null, outputBusToSource)}
                        >
                          {formatBusLabel(row.session_id, isCanRow ? row.bus : null, outputBusToSource)}
                        </span>
                      </td>

                      {/* Kind badge */}
                      <td className="px-4 py-2">
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${
                            isCanRow
                              ? "bg-blue-600/30 text-blue-400"
                              : "bg-purple-600/30 text-purple-400"
                          }`}
                        >
                          {isCanRow ? "CAN" : "Serial"}
                        </span>
                      </td>

                      {/* Frame / Data */}
                      <td className="px-4 py-2">
                        <div className={flexRowGap2}>
                          {frameIdStr && (
                            <code className="font-mono text-green-400">
                              {frameIdStr}
                            </code>
                          )}
                          <code className="font-mono text-gray-400 text-xs">
                            {dlcStr} {dataStr}{truncated}
                          </code>
                          {flags.map((flag) => (
                            <span
                              key={flag}
                              className="text-[10px] text-amber-400 uppercase"
                            >
                              {flag}
                            </span>
                          ))}
                        </div>
                      </td>

                      {/* Error */}
                      <td className="px-4 py-2">
                        {row.error_msg && (
                          <span className="text-red-400 text-xs">{row.error_msg}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Load more / loading indicator */}
            {hasMore && (
              <div className="flex justify-center py-3">
                <button
                  onClick={handleLoadMore}
                  disabled={isLoading}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border ${borderDataView} ${textDataSecondary} hover:brightness-95 transition-colors disabled:opacity-50`}
                >
                  <ChevronDown size={13} />
                  {isLoading ? "Loading…" : `Load more (${Math.max(0, historyDbCount - offset)} remaining)`}
                </button>
              </div>
            )}
            {isLoading && rows.length === 0 && (
              <div className="flex justify-center py-8">
                <span className={`text-sm ${textDataSecondary}`}>Loading…</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
