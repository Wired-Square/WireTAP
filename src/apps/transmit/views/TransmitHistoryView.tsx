// ui/src/apps/transmit/views/TransmitHistoryView.tsx
//
// Transmitted packet history view.

import React, { useCallback, useMemo } from "react";
import { Trash2, Check, X, Download } from "lucide-react";
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
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../styles/typography";
import { byteToHex } from "../../../utils/byteUtils";
import { buildCsv } from "../../../utils/csvBuilder";
import { formatIsoUs, formatHumanUs, renderDeltaNode } from "../../../utils/timeFormat";
import { formatBusLabel } from "../../../utils/busFormat";

interface TransmitHistoryViewProps {
  outputBusToSource: Map<number, BusSourceInfo>;
}

export default function TransmitHistoryView({ outputBusToSource }: TransmitHistoryViewProps) {
  const { settings } = useSettings();

  // Store selectors
  const history = useTransmitStore((s) => s.history);

  // Store actions
  const clearHistory = useTransmitStore((s) => s.clearHistory);

  // Get timestamp format from settings
  const timestampFormat = settings?.display_time_format ?? "human";

  // Handle clear history
  const handleClearHistory = useCallback(() => {
    clearHistory();
  }, [clearHistory]);

  // Get the oldest timestamp for delta-start (history is newest-first, so last item is oldest)
  const oldestTimestampUs = useMemo(() => {
    if (history.length === 0) return null;
    return history[history.length - 1].timestamp_us;
  }, [history]);

  // Format timestamp based on settings - returns React node for delta modes
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

  // Format timestamp as string for CSV export
  const formatTimestampString = useCallback(
    (timestampUs: number): string => {
      switch (timestampFormat) {
        case "timestamp":
          return formatIsoUs(timestampUs);
        case "delta-start":
        case "delta-last":
          // For CSV, just use seconds
          return `${(timestampUs / 1_000_000).toFixed(6)}`;
        case "human":
        default:
          return formatHumanUs(timestampUs);
      }
    },
    [timestampFormat]
  );

  // Format frame for display
  const formatHistoryItem = (item: (typeof history)[0]) => {
    if (item.type === "can" && item.frame) {
      const frame = item.frame;
      const idStr = frame.is_extended
        ? `0x${frame.frame_id.toString(16).toUpperCase().padStart(8, "0")}`
        : `0x${frame.frame_id.toString(16).toUpperCase().padStart(3, "0")}`;
      const dataStr = frame.data.map(byteToHex).join(" ");
      return {
        type: "CAN",
        id: idStr,
        details: `[${frame.data.length}] ${dataStr}`,
        flags: [
          frame.is_extended && "EXT",
          frame.is_fd && "FD",
          frame.is_brs && "BRS",
          frame.is_rtr && "RTR",
        ].filter((f): f is string => Boolean(f)),
        bus: frame.bus,
      };
    } else if (item.type === "serial" && item.bytes) {
      const dataStr = item.bytes.slice(0, 8).map(byteToHex).join(" ");
      const truncated = item.bytes.length > 8 ? "..." : "";
      return {
        type: "Serial",
        id: null,
        details: `[${item.bytes.length}] ${dataStr}${truncated}`,
        flags: [],
        bus: null,
      };
    }
    return null;
  };

  // Export history as CSV
  const handleExport = useCallback(() => {
    if (history.length === 0) return;

    const headers = ["Timestamp", "Interface", "Type", "ID", "DLC", "Data", "Flags", "Success", "Error"];
    const rows: (string | number)[][] = [];

    for (const item of history) {
      const formatted = formatHistoryItem(item);
      if (!formatted) continue;

      rows.push([
        formatTimestampString(item.timestamp_us),
        item.profileName,
        formatted.type,
        formatted.id ?? "",
        item.frame?.data.length ?? item.bytes?.length ?? 0,
        item.frame?.data.map(byteToHex).join("") ?? item.bytes?.map(byteToHex).join("") ?? "",
        formatted.flags.join("|"),
        item.success ? "true" : "false",
        item.error ?? "",
      ]);
    }

    const csv = buildCsv(headers, rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transmit-history-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [history, formatTimestampString]);

  // Stats
  const stats = useMemo(() => {
    const total = history.length;
    const success = history.filter((h) => h.success).length;
    const failed = total - success;
    return { total, success, failed };
  }, [history]);

  // Empty state
  if (history.length === 0) {
    return (
      <div className={emptyStateContainer}>
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>No History</p>
          <p className={emptyStateDescription}>
            Transmitted packets will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className={`flex items-center gap-3 px-4 py-2 ${bgDataToolbar} border-b ${borderDataView}`}
      >
        <span className={`${textDataSecondary} text-sm`}>
          {stats.total} packet{stats.total !== 1 ? "s" : ""}
          {stats.failed > 0 && (
            <span className="text-red-400 ml-2">
              ({stats.failed} failed)
            </span>
          )}
        </span>

        <div className="flex-1" />

        <button
          onClick={handleExport}
          className={buttonBase}
          title="Export as CSV"
        >
          <Download size={14} />
          <span className="text-sm ml-1">Export</span>
        </button>

        <button
          onClick={handleClearHistory}
          className={buttonBase}
          title="Clear history"
        >
          <Trash2 size={14} />
          <span className="text-sm ml-1">Clear</span>
        </button>
      </div>

      {/* History Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead
            className={`${bgDataToolbar} sticky top-0 ${textDataSecondary} text-xs`}
          >
            <tr>
              <th className="text-left px-4 py-2 w-12"></th>
              <th className="text-left px-4 py-2">Timestamp</th>
              <th className="text-left px-4 py-2">Bus</th>
              <th className="text-left px-4 py-2 w-16">Type</th>
              <th className="text-left px-4 py-2">Frame / Data</th>
              <th className="text-left px-4 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {history.map((item, index) => {
              const formatted = formatHistoryItem(item);
              if (!formatted) return null;

              // Get previous timestamp for delta-last (history is newest-first)
              // So the "previous" in chronological order is the next item in the array
              const prevTimestampUs = index < history.length - 1
                ? history[index + 1].timestamp_us
                : null;

              return (
                <tr
                  key={item.id}
                  className={`border-b ${borderDataView} ${hoverDataRow}`}
                >
                  {/* Status */}
                  <td className="px-4 py-2">
                    {item.success ? (
                      <Check size={14} className="text-green-400" />
                    ) : (
                      <X size={14} className="text-red-400" />
                    )}
                  </td>

                  {/* Timestamp */}
                  <td className="px-4 py-2">
                    <span className="font-mono text-gray-400 text-xs">
                      {formatTimestamp(item.timestamp_us, prevTimestampUs)}
                    </span>
                  </td>

                  {/* Source */}
                  <td className="px-4 py-2">
                    <span
                      className={`${textDataSecondary} text-xs truncate max-w-[120px] block`}
                      title={formatBusLabel(item.profileName, formatted.bus, outputBusToSource)}
                    >
                      {formatBusLabel(item.profileName, formatted.bus, outputBusToSource)}
                    </span>
                  </td>

                  {/* Type */}
                  <td className="px-4 py-2">
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        formatted.type === "CAN"
                          ? "bg-blue-600/30 text-blue-400"
                          : "bg-purple-600/30 text-purple-400"
                      }`}
                    >
                      {formatted.type}
                    </span>
                  </td>

                  {/* Frame / Data */}
                  <td className="px-4 py-2">
                    <div className={flexRowGap2}>
                      {formatted.id && (
                        <code className="font-mono text-green-400">
                          {formatted.id}
                        </code>
                      )}
                      <code className="font-mono text-gray-400 text-xs">
                        {formatted.details}
                      </code>
                      {formatted.flags.map((flag) => (
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
                    {item.error && (
                      <span className="text-red-400 text-xs">{item.error}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
