// src/apps/query/views/QueuePanel.tsx
//
// Queue panel showing queued queries with status indicators.
// Allows selection of completed queries to view results.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Loader2, CheckCircle2, XCircle, Trash2, ListX } from "lucide-react";
import { useQueryStore, type QueuedQuery, type QueryStatus } from "../stores/queryStore";
import { iconButtonBase } from "../../../styles/buttonStyles";
import { monoBody } from "../../../styles/typography";
import { iconSm, iconMd, iconXl } from "../../../styles/spacing";
import {
  borderDivider,
  hoverBg,
  textPrimary,
  textSecondary,
  textMuted,
  textDataGreen,
  textDataAmber,
} from "../../../styles/colourTokens";

interface Props {
  onSelectQuery: (id: string) => void;
  onRemoveQuery: (id: string) => void;
}

export default function QueuePanel({ onSelectQuery, onRemoveQuery }: Props) {
  const { t } = useTranslation("query");
  const queue = useQueryStore((s) => s.queue);
  const selectedQueryId = useQueryStore((s) => s.selectedQueryId);

  // Format timestamp for display
  const formatTime = useCallback((timestamp: number) => {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const seconds = date.getSeconds().toString().padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  }, []);

  // Render empty state
  if (queue.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <ListX className={`${iconXl} ${textMuted} mb-4`} />
        <h3 className={`text-sm font-medium ${textPrimary} mb-2`}>{t("queue.emptyHeading")}</h3>
        <p className={`text-xs ${textSecondary} max-w-xs`}>
          {t("queue.emptyDescription")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 ${borderDivider}`}>
        <div>
          <h2 className={`text-sm font-semibold ${textPrimary}`}>{t("queue.title")}</h2>
          <p className={`text-xs ${textSecondary}`}>
            {t("queue.summary", { count: queue.length })}
            {queue.filter((q) => q.status === "pending").length > 0 && (
              <span className={textMuted}>
                {t("queue.pendingSuffix", { count: queue.filter((q) => q.status === "pending").length })}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Queue list */}
      <div className="flex-1 overflow-auto">
        <div className="divide-y divide-[var(--border-default)]">
          {queue.map((query) => (
            <QueueItem
              key={query.id}
              query={query}
              isSelected={query.id === selectedQueryId}
              onSelect={onSelectQuery}
              onRemove={onRemoveQuery}
              formatTime={formatTime}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Status icon component
function StatusIcon({ status }: { status: QueryStatus }) {
  switch (status) {
    case "pending":
      return <Clock className={`${iconSm} ${textMuted}`} />;
    case "running":
      return <Loader2 className={`${iconSm} ${textDataAmber} animate-spin`} />;
    case "completed":
      return <CheckCircle2 className={`${iconSm} ${textDataGreen}`} />;
    case "error":
      return <XCircle className={`${iconSm} text-red-400`} />;
  }
}

// Individual queue item component
interface QueueItemProps {
  query: QueuedQuery;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  formatTime: (timestamp: number) => string;
}

function QueueItem({ query, isSelected, onSelect, onRemove, formatTime }: QueueItemProps) {
  const { t } = useTranslation("query");
  const handleClick = useCallback(() => {
    onSelect(query.id);
  }, [query.id, onSelect]);

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onRemove(query.id);
    },
    [query.id, onRemove]
  );

  const isRunning = query.status === "running";
  const resultCount = query.results
    ? Array.isArray(query.results)
      ? query.results.length
      : (query.results as { cases: unknown[] }).cases?.length ?? 0
    : 0;

  return (
    <div
      onClick={handleClick}
      className={`group flex items-center gap-3 px-4 py-3 cursor-pointer ${hoverBg} transition-colors ${
        isSelected ? "ring-2 ring-inset ring-blue-500/50 bg-blue-500/5" : ""
      }`}
    >
      {/* Status icon */}
      <StatusIcon status={query.status} />

      {/* Query info */}
      <div className="flex-1 min-w-0">
        <div className={`${monoBody} text-xs ${textPrimary} truncate`}>
          {query.displayName}
        </div>
        <div className={`text-xs ${textMuted} mt-0.5`}>
          {query.status === "completed" && (
            <span className={textDataGreen}>{t("queue.results", { count: resultCount })}</span>
          )}
          {query.status === "error" && (
            <span className="text-red-400 truncate">{query.errorMessage}</span>
          )}
          {query.status === "running" && <span className={textDataAmber}>{t("queue.running")}</span>}
          {query.status === "pending" && <span>{t("queue.queuedAt", { time: formatTime(query.submittedAt) })}</span>}
          {query.stats && query.status === "completed" && (
            <span className={textMuted}>{t("queue.executionMs", { ms: query.stats.execution_time_ms.toLocaleString() })}</span>
          )}
        </div>
        {query.timeBounds && (
          <div className={`text-xs ${textMuted} mt-0.5 truncate`}>
            {t("queue.boundedBy", { name: query.timeBounds.favouriteName })}
          </div>
        )}
      </div>

      {/* Remove button */}
      <button
        onClick={handleRemove}
        className={`${iconButtonBase} opacity-0 group-hover:opacity-100 transition-opacity`}
        title={isRunning ? t("queue.cancelTooltip") : t("queue.removeTooltip")}
      >
        <Trash2 className={iconMd} />
      </button>
    </div>
  );
}
