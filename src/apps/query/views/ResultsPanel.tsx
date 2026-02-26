// src/apps/query/views/ResultsPanel.tsx
//
// Results display panel. Shows query results in a timeline view with
// click-to-ingest functionality. Supports grouped results by query.

import { useCallback, useState, useMemo, useEffect } from "react";
import { PlayCircle, Download, AlertCircle, Database, Bookmark, FileDown } from "lucide-react";
import {
  QUERY_TYPE_INFO,
  type ByteChangeResult,
  type FrameChangeResult,
  type MirrorValidationResult,
  type QueuedQuery,
} from "../stores/queryStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import { formatHumanUs } from "../../../utils/timeFormat";
import DataViewPaginationToolbar, { FRAME_PAGE_SIZE_OPTIONS } from "../../../components/DataViewPaginationToolbar";
import { iconButtonBase, buttonBase } from "../../../styles/buttonStyles";
import { monoBody, emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../styles/typography";
import { iconSm, iconMd, iconXl } from "../../../styles/spacing";
import { borderDivider, hoverBg, textPrimary, textSecondary, textMuted, textDataAmber, textDataGreen, textDataPurple, textDanger } from "../../../styles/colourTokens";

interface Props {
  selectedQuery: QueuedQuery | null;
  onIngestEvent: (timestampUs: number) => Promise<void>;
  onIngestAll: () => void;
  onExport: () => void;
  onBookmark: () => void;
}

export default function ResultsPanel({
  selectedQuery,
  onIngestEvent,
  onIngestAll,
  onExport,
  onBookmark,
}: Props) {
  const timezone = useSettingsStore((s) => s.display.timezone);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);

  // Extract data from selected query
  const queryType = selectedQuery?.queryType ?? "byte_changes";
  const results = selectedQuery?.results ?? null;
  const resultCount = results ? (results as unknown[]).length : 0;
  const lastQueryStats = selectedQuery?.stats ?? null;
  const isRunning = selectedQuery?.status === "running";
  const error = selectedQuery?.errorMessage ?? null;

  const queryInfo = QUERY_TYPE_INFO[queryType];

  // Calculate paginated results
  const { paginatedResults, totalPages } = useMemo(() => {
    if (!results || resultCount === 0) {
      return { paginatedResults: [], totalPages: 0 };
    }

    const allResults = results as (ByteChangeResult | FrameChangeResult | MirrorValidationResult)[];

    // If pageSize is -1 (All), show all results
    if (pageSize === -1) {
      return { paginatedResults: allResults, totalPages: 1 };
    }

    const total = Math.ceil(resultCount / pageSize);
    const start = currentPage * pageSize;
    const end = Math.min(start + pageSize, resultCount);
    return {
      paginatedResults: allResults.slice(start, end),
      totalPages: total,
    };
  }, [results, resultCount, currentPage, pageSize]);

  // Reset page when query changes
  const queryId = selectedQuery?.id;
  useEffect(() => {
    setCurrentPage(0);
  }, [queryId]);

  // Format timestamp for display (short form: date + time with milliseconds)
  const formatTimestamp = useCallback((timestampUs: number) => {
    const date = new Date(timestampUs / 1000);
    const ms = Math.floor((timestampUs / 1000) % 1000);

    if (timezone === "utc") {
      // UTC format: MM-DD HH:MM:SS.mmm
      const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
      const day = date.getUTCDate().toString().padStart(2, "0");
      const hours = date.getUTCHours().toString().padStart(2, "0");
      const minutes = date.getUTCMinutes().toString().padStart(2, "0");
      const seconds = date.getUTCSeconds().toString().padStart(2, "0");
      return `${month}-${day} ${hours}:${minutes}:${seconds}.${ms.toString().padStart(3, "0")}`;
    } else {
      // Local format: MM-DD HH:MM:SS.mmm
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      const day = date.getDate().toString().padStart(2, "0");
      const hours = date.getHours().toString().padStart(2, "0");
      const minutes = date.getMinutes().toString().padStart(2, "0");
      const seconds = date.getSeconds().toString().padStart(2, "0");
      return `${month}-${day} ${hours}:${minutes}:${seconds}.${ms.toString().padStart(3, "0")}`;
    }
  }, [timezone]);

  // Format timestamp for hover tooltip (full date/time with microseconds)
  const formatTimestampFull = useCallback((timestampUs: number) => {
    // formatHumanUs gives UTC; for local we need custom formatting
    if (timezone === "utc") {
      return formatHumanUs(timestampUs) + " UTC";
    } else {
      const date = new Date(timestampUs / 1000);
      const usRemainder = timestampUs % 1000;
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      const day = date.getDate().toString().padStart(2, "0");
      const hours = date.getHours().toString().padStart(2, "0");
      const minutes = date.getMinutes().toString().padStart(2, "0");
      const seconds = date.getSeconds().toString().padStart(2, "0");
      const ms = date.getMilliseconds().toString().padStart(3, "0");
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}${usRemainder.toString().padStart(3, "0")} Local`;
    }
  }, [timezone]);

  // Format byte value
  const formatByte = useCallback((value: number) => {
    return `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
  }, []);

  // Render empty state (no query selected)
  if (!selectedQuery) {
    return (
      <div className={`h-full ${emptyStateContainer}`}>
        <Database className={`${iconXl} ${textMuted} mb-4`} />
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>No Query Selected</p>
          <p className={emptyStateDescription}>
            Select a completed query from the Queue tab to view its results.
          </p>
        </div>
      </div>
    );
  }

  // Render empty state (query has no results yet)
  if (!results && !isRunning && !error) {
    return (
      <div className={`h-full ${emptyStateContainer}`}>
        <Database className={`${iconXl} ${textMuted} mb-4`} />
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>No Results</p>
          <p className={emptyStateDescription}>
            This query has not been run yet or returned no data.
          </p>
        </div>
      </div>
    );
  }

  // Render loading state
  if (isRunning) {
    return (
      <div className={`h-full ${emptyStateContainer}`}>
        <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mb-4" />
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>Running Query</p>
          <p className={emptyStateDescription}>
            Searching for {queryInfo.label.toLowerCase()}...
          </p>
        </div>
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className={`h-full ${emptyStateContainer}`}>
        <AlertCircle className={`${iconXl} ${textDanger} mb-4`} />
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>Query Failed</p>
          <p className={`${emptyStateDescription} ${textDanger}`}>{error}</p>
        </div>
      </div>
    );
  }

  // Render empty results
  if (results && resultCount === 0) {
    return (
      <div className={`h-full ${emptyStateContainer}`}>
        <Database className={`${iconXl} ${textMuted} mb-4`} />
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>No Matches Found</p>
          <p className={`${emptyStateDescription} mb-3`}>
            No {queryInfo.label.toLowerCase()} were found matching your criteria.
            Try adjusting the frame ID or time range.
          </p>
          {lastQueryStats && (
            <p className={`text-xs ${textMuted}`}>
              Scanned {lastQueryStats.rows_scanned.toLocaleString()} rows in {lastQueryStats.execution_time_ms.toLocaleString()}ms
            </p>
          )}
        </div>
      </div>
    );
  }

  // Render results
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 ${borderDivider}`}>
        <div className="flex-1 min-w-0">
          <h2 className={`text-sm font-semibold ${textPrimary} truncate`}>
            {selectedQuery.displayName}
          </h2>
          <p className={`text-xs ${textSecondary}`}>
            {resultCount.toLocaleString()} {queryInfo.label.toLowerCase()} found
            {lastQueryStats && (
              <span className={textMuted}>
                {" "}· {lastQueryStats.rows_scanned.toLocaleString()} rows in {lastQueryStats.execution_time_ms.toLocaleString()}ms
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onIngestAll}
            className={`${buttonBase} text-xs`}
            title="Ingest all results"
            disabled={resultCount === 0}
          >
            <Download className={iconSm} />
            <span>Ingest All</span>
          </button>
          <button
            onClick={onBookmark}
            className={iconButtonBase}
            title="Bookmark time range"
            disabled={resultCount === 0}
          >
            <Bookmark className={`${iconMd} ${textDataAmber}`} />
          </button>
          <button
            onClick={onExport}
            className={iconButtonBase}
            title="Export results to CSV"
            disabled={resultCount === 0}
          >
            <FileDown className={iconMd} />
          </button>
        </div>
      </div>

      {/* Pagination toolbar */}
      <DataViewPaginationToolbar
        currentPage={currentPage}
        totalPages={totalPages}
        pageSize={pageSize}
        pageSizeOptions={FRAME_PAGE_SIZE_OPTIONS}
        onPageChange={setCurrentPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setCurrentPage(0);
        }}
      />

      {/* Results list */}
      <div className="flex-1 overflow-auto">
        <div className="divide-y divide-[var(--border-default)]">
          {paginatedResults.map((result, index) => (
            <ResultRow
              key={currentPage * pageSize + index}
              result={result}
              queryType={queryType}
              formatTimestamp={formatTimestamp}
              formatTimestampFull={formatTimestampFull}
              formatByte={formatByte}
              onIngest={onIngestEvent}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Individual result row component
interface ResultRowProps {
  result: ByteChangeResult | FrameChangeResult | MirrorValidationResult;
  queryType: string;
  formatTimestamp: (us: number) => string;
  formatTimestampFull: (us: number) => string;
  formatByte: (value: number) => string;
  onIngest: (timestampUs: number) => Promise<void>;
}

function ResultRow({
  result,
  queryType,
  formatTimestamp,
  formatTimestampFull,
  formatByte,
  onIngest,
}: ResultRowProps) {
  // Get the primary timestamp for ingest (use mirror_timestamp_us for mirror validation)
  const primaryTimestamp = queryType === "mirror_validation"
    ? (result as MirrorValidationResult).mirror_timestamp_us
    : (result as ByteChangeResult | FrameChangeResult).timestamp_us;

  const handleIngestClick = useCallback(() => {
    onIngest(primaryTimestamp);
  }, [primaryTimestamp, onIngest]);

  // Render byte change result
  if (queryType === "byte_changes") {
    const byteResult = result as ByteChangeResult;
    return (
      <div className={`flex items-center gap-3 px-4 py-2 ${hoverBg} group`}>
        {/* Timestamp */}
        <span
          className={`${monoBody} text-xs ${textDataAmber} w-36 flex-shrink-0`}
          title={formatTimestampFull(byteResult.timestamp_us)}
        >
          {formatTimestamp(byteResult.timestamp_us)}
        </span>

        {/* Value change */}
        <span className={`${monoBody} text-xs flex-1`}>
          <span className={textDataPurple}>{formatByte(byteResult.old_value)}</span>
          <span className={textMuted}> → </span>
          <span className={textDataGreen}>{formatByte(byteResult.new_value)}</span>
        </span>

        {/* Ingest button */}
        <button
          onClick={handleIngestClick}
          className={`${buttonBase} opacity-0 group-hover:opacity-100 transition-opacity`}
          title="Ingest frames around this event"
        >
          <PlayCircle className={iconSm} />
          <span className="text-xs">Ingest</span>
        </button>
      </div>
    );
  }

  // Render mirror validation result
  if (queryType === "mirror_validation") {
    const mirrorResult = result as MirrorValidationResult;
    const timeDeltaMs = Math.abs(mirrorResult.mirror_timestamp_us - mirrorResult.source_timestamp_us) / 1000;

    // Format payload with mismatches highlighted
    const formatPayloadWithMismatches = (payload: number[], mismatches: number[]) => {
      return payload.map((byte, idx) => {
        const hex = formatByte(byte);
        const isMismatch = mismatches.includes(idx);
        return (
          <span key={idx} className={isMismatch ? textDanger : textMuted}>
            {hex}{idx < payload.length - 1 ? " " : ""}
          </span>
        );
      });
    };

    return (
      <div className={`flex items-start gap-3 px-4 py-2 ${hoverBg} group`}>
        {/* Timestamps */}
        <div className="flex-shrink-0 w-36">
          <span
            className={`${monoBody} text-xs ${textDataAmber} block`}
            title={formatTimestampFull(mirrorResult.mirror_timestamp_us)}
          >
            {formatTimestamp(mirrorResult.mirror_timestamp_us)}
          </span>
          <span className={`text-xs ${textMuted}`}>
            Δ {timeDeltaMs.toFixed(1)}ms
          </span>
        </div>

        {/* Payload comparison */}
        <div className="flex-1 min-w-0">
          <div className={`${monoBody} text-xs`}>
            <span className={textSecondary}>mirror: </span>
            {formatPayloadWithMismatches(mirrorResult.mirror_payload, mirrorResult.mismatch_indices)}
          </div>
          <div className={`${monoBody} text-xs`}>
            <span className={textSecondary}>source: </span>
            {formatPayloadWithMismatches(mirrorResult.source_payload, mirrorResult.mismatch_indices)}
          </div>
          <span className={`text-xs ${textMuted}`}>
            {mirrorResult.mismatch_indices.length} byte{mirrorResult.mismatch_indices.length !== 1 ? "s" : ""} differ
            {mirrorResult.mismatch_indices.length <= 4 && `: ${mirrorResult.mismatch_indices.join(", ")}`}
          </span>
        </div>

        {/* Ingest button */}
        <button
          onClick={handleIngestClick}
          className={`${buttonBase} opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0`}
          title="Ingest frames around this event"
        >
          <PlayCircle className={iconSm} />
          <span className="text-xs">Ingest</span>
        </button>
      </div>
    );
  }

  // Render frame change result
  const frameResult = result as FrameChangeResult;

  // Format changed byte indices - show up to 4, then "+N more"
  const formatChangedIndices = (indices: number[]) => {
    if (indices.length === 0) return "no bytes changed";
    if (indices.length <= 4) {
      return `byte${indices.length > 1 ? "s" : ""} ${indices.join(", ")}`;
    }
    const shown = indices.slice(0, 4).join(", ");
    return `bytes ${shown}, +${indices.length - 4} more`;
  };

  return (
    <div className={`flex items-center gap-3 px-4 py-2 ${hoverBg} group`}>
      {/* Timestamp */}
      <span
        className={`${monoBody} text-xs ${textDataAmber} w-36 flex-shrink-0`}
        title={formatTimestampFull(frameResult.timestamp_us)}
      >
        {formatTimestamp(frameResult.timestamp_us)}
      </span>

      {/* Changed byte indices */}
      <span
        className={`${monoBody} text-xs ${textSecondary} flex-1`}
        title={`Changed: ${frameResult.changed_indices.join(", ")}`}
      >
        {formatChangedIndices(frameResult.changed_indices)}
      </span>

      {/* Ingest button */}
      <button
        onClick={handleIngestClick}
        className={`${buttonBase} opacity-0 group-hover:opacity-100 transition-opacity`}
        title="Ingest frames around this event"
      >
        <PlayCircle className={iconSm} />
        <span className="text-xs">Ingest</span>
      </button>
    </div>
  );
}
