// ui/src/apps/transmit/views/TransmitReplayView.tsx
//
// Replay tab: shows active replay progress banners and the replay lifecycle log.

import { useMemo } from "react";
import { Check, X, Play, StopCircle, Trash2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTransmitStore } from "../../../stores/transmitStore";
import type { ReplayLogEntry } from "../../../stores/transmitStore";
import {
  bgDataToolbar,
  borderDataView,
  textDataSecondary,
  hoverDataRow,
} from "../../../styles/colourTokens";
import { actionChip, badgeColorClass, buttonBase } from "../../../styles/buttonStyles";
import {
  emptyStateContainer,
  emptyStateText,
  emptyStateHeading,
  emptyStateDescription,
} from "../../../styles/typography";
import { formatHumanUs } from "../../../utils/timeFormat";

// ============================================================================
// Component
// ============================================================================

export default function TransmitReplayView() {
  const { t } = useTranslation("transmit");
  const replayProgress = useTransmitStore((s) => s.replayProgress);
  const replayLog = useTransmitStore((s) => s.replayLog);
  const activeReplays = useTransmitStore((s) => s.activeReplays);
  const replayCache = useTransmitStore((s) => s.replayCache);
  const stopReplay = useTransmitStore((s) => s.stopReplay);
  const restartReplay = useTransmitStore((s) => s.restartReplay);
  const clearReplayLog = useTransmitStore((s) => s.clearReplayLog);

  const isEmpty = replayProgress.size === 0 && replayLog.length === 0;
  const replayEntries = useMemo(() => [...replayProgress.entries()], [replayProgress]);

  return (
    <div className="flex flex-col h-full">
      {/* Active replay banners */}
      {replayEntries.length > 0 && (
        <div className={`border-b ${borderDataView}`}>
          {replayEntries.map(([replayId, info]) => {
            const pct =
              info.totalFrames > 0
                ? Math.round((info.framesSent / info.totalFrames) * 100)
                : 0;
            return (
              <div
                key={replayId}
                className={`flex items-center gap-3 px-4 py-2 ${bgDataToolbar}`}
              >
                <Play size={12} className="text-blue-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-xs ${textDataSecondary}`}>
                      {info.profileName && (
                        <span className="mr-1.5">{info.profileName}</span>
                      )}
                      Replaying{info.loopReplay ? " (loop)" : ""}
                      <span className="ml-1.5 font-mono">
                        {info.framesSent} / {info.totalFrames}
                      </span>
                      <span className="ml-1.5 text-[color:var(--text-secondary)]">
                        {info.speed}×
                      </span>
                    </span>
                    <span className={`text-xs font-mono ${textDataSecondary}`}>{pct}%</span>
                  </div>
                  <div className="h-1 rounded-full bg-[var(--bg-surface)] overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all duration-200"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <button
                  onClick={() => restartReplay(replayId)}
                  className={actionChip('blue')}
                  title={t("replay.restartTooltip")}
                >
                  <RefreshCw size={11} />
                  {t("replay.restart")}
                </button>
                <button
                  onClick={() => stopReplay(replayId)}
                  className={actionChip('red')}
                  title={t("replay.stopTooltip")}
                >
                  <StopCircle size={11} />
                  {t("replay.stop")}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className={emptyStateContainer}>
          <div className={emptyStateText}>
            <p className={emptyStateHeading}>{t("replay.emptyHeading")}</p>
            <p className={emptyStateDescription}>{t("replay.emptyDescription")}</p>
          </div>
        </div>
      )}

      {replayLog.length > 0 && (
        <>
          {/* Toolbar */}
          <div
            className={`flex items-center gap-3 px-4 py-2 ${bgDataToolbar} border-b ${borderDataView}`}
          >
            <span className={`${textDataSecondary} text-sm`}>
              {t("replay.eventSummary", { count: replayLog.length })}
            </span>

            <div className="flex-1" />

            {activeReplays.size > 0 && (
              <button
                onClick={() => activeReplays.forEach((id) => stopReplay(id))}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-red-500/50 bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
                title={t("replay.stopAllTooltip")}
              >
                <StopCircle size={13} />
                {activeReplays.size > 1
                  ? t("replay.stopReplaysLabel", { count: activeReplays.size })
                  : t("replay.stopReplayLabel")}
              </button>
            )}

            <button
              onClick={clearReplayLog}
              className={buttonBase}
              title={t("replay.clearLogTooltip")}
            >
              <Trash2 size={14} />
              <span className="text-sm ml-1">{t("replay.clearLabel")}</span>
            </button>
          </div>

          {/* Log table */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead
                className={`${bgDataToolbar} sticky top-0 ${textDataSecondary} text-xs`}
              >
                <tr>
                  <th className="text-left px-4 py-2 w-10"></th>
                  <th className="text-left px-4 py-2">{t("replay.columns.time")}</th>
                  <th className="text-left px-4 py-2">{t("replay.columns.session")}</th>
                  <th className="text-left px-4 py-2">{t("replay.columns.event")}</th>
                  <th className="text-left px-4 py-2">{t("replay.columns.details")}</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {replayLog.map((entry) => {
                  const isTerminal = entry.kind === "completed" || entry.kind === "stoppedByUser" || entry.kind === "deviceError";
                  const canRestart = isTerminal && replayCache.has(entry.replayId);
                  return (
                    <ReplayLogRow
                      key={entry.id}
                      entry={entry}
                      onRestart={canRestart ? () => restartReplay(entry.replayId) : undefined}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Row component
// ============================================================================

function ReplayLogRow({ entry, onRestart }: { entry: ReplayLogEntry; onRestart?: () => void }) {
  const { t, i18n } = useTranslation("transmit");
  const { kind, profileName, totalFrames, speed, loopReplay, framesSent, errorMessage, timestamp, pass } = entry;

  const icon =
    kind === "started" ? <Play size={14} className="text-teal-400" /> :
    kind === "completed" ? <Check size={14} className="text-green-400" /> :
    kind === "loopRestarted" ? <RefreshCw size={14} className="text-blue-400" /> :
    kind === "stoppedByUser" ? <X size={14} className="text-amber-400" /> :
    <X size={14} className="text-red-400" />;

  const kindBadge =
    kind === "started" ? <span className="text-xs px-1.5 py-0.5 rounded bg-teal-600/30 text-teal-400">{t("replay.kindStarted")}</span> :
    kind === "completed" ? <span className={`text-xs px-1.5 py-0.5 rounded ${badgeColorClass('green')}`}>{t("replay.kindCompleted")}</span> :
    kind === "loopRestarted" ? <span className={`text-xs px-1.5 py-0.5 rounded ${badgeColorClass('blue')}`}>{t("replay.kindLoop")}</span> :
    kind === "stoppedByUser" ? <span className={`text-xs px-1.5 py-0.5 rounded ${badgeColorClass('amber')}`}>{t("replay.kindStopped")}</span> :
    <span className={`text-xs px-1.5 py-0.5 rounded ${badgeColorClass('red')}`}>{t("replay.kindError")}</span>;

  const fmt = (n: number) => n.toLocaleString(i18n.language);

  let details: string;
  if (kind === "started") {
    details = loopReplay
      ? t("replay.details.startedLoop", { frames: fmt(totalFrames), speed })
      : t("replay.details.started", { frames: fmt(totalFrames), speed });
  } else if (kind === "completed") {
    details = t("replay.details.completed", { frames: fmt(totalFrames), speed });
  } else if (kind === "loopRestarted") {
    details = t("replay.details.loopRestarted", { pass, framesSent: fmt(framesSent ?? 0), speed });
  } else if (kind === "stoppedByUser") {
    details = t("replay.details.stoppedByUser", { framesSent: fmt(framesSent ?? 0), frames: fmt(totalFrames), speed });
  } else {
    details = errorMessage ?? t("replay.details.deviceError");
  }

  return (
    <tr className={`border-b ${borderDataView} ${hoverDataRow}`}>
      <td className="px-4 py-2">{icon}</td>
      <td className="px-4 py-2">
        <span className={`font-mono text-xs ${textDataSecondary}`}>
          {formatHumanUs(timestamp * 1000)}
        </span>
      </td>
      <td className="px-4 py-2">
        <span className={`${textDataSecondary} text-xs truncate max-w-[120px] block`}>
          {profileName}
        </span>
      </td>
      <td className="px-4 py-2">{kindBadge}</td>
      <td className="px-4 py-2">
        <span className={`font-mono text-xs ${textDataSecondary}`}>{details}</span>
      </td>
      <td className="px-4 py-2">
        {onRestart && (
          <button
            onClick={onRestart}
            className={actionChip('blue')}
            title={t("replay.restartTooltipPast")}
          >
            <RefreshCw size={11} />
            {t("replay.restart")}
          </button>
        )}
      </td>
    </tr>
  );
}
