// ui/src/apps/transmit/views/TransmitReplayView.tsx
//
// Replay tab: shows active replay progress banners and the replay lifecycle log.

import { useMemo } from "react";
import { Check, X, Play, StopCircle, Trash2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTransmitStore } from "../../../stores/transmitStore";
import type { ReplayLogEntry } from "../../../stores/transmitStore";
import {
  bgSurface,
  bgDataView,
  borderDefault,
  textDanger,
  textDataCyan,
  textSecondary,
  textInfo,
  textSuccess,
  textWarning,
} from "../../../styles/colourTokens";
import { Badge } from "../../../components/Badge";
import {
  emptyStateContainer,
  emptyStateText,
  emptyStateHeading,
  emptyStateDescription,
} from "../../../styles/typography";
import { formatHumanUs } from "../../../utils/timeFormat";
import { Button } from "../../../components/Button";
import { Table } from "../../../components/Table";

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
        <div className={`border-b ${borderDefault}`}>
          {replayEntries.map(([replayId, info]) => {
            const pct =
              info.totalFrames > 0
                ? Math.round((info.framesSent / info.totalFrames) * 100)
                : 0;
            return (
              <div
                key={replayId}
                className={`flex items-center gap-3 px-4 py-2 ${bgSurface}`}
              >
                <Play size={12} className={`shrink-0 ${textInfo}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className={`text-xs ${textSecondary}`}>
                      {info.profileName && (
                        <span className="mr-1.5">{info.profileName}</span>
                      )}
                      Replaying{info.loopReplay ? " (loop)" : ""}
                      <span className="ml-1.5 font-mono">
                        {info.framesSent} / {info.totalFrames}
                      </span>
                      <span className="ml-1.5 text-secondary">
                        {info.speed}×
                      </span>
                    </span>
                    <span className={`text-xs font-mono ${textSecondary}`}>{pct}%</span>
                  </div>
                  <div className="h-1 rounded-full bg-surface overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all duration-200"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <Button
                  onClick={() => restartReplay(replayId)}
                  variant="tonal"
                  tone="primary"
                  size="sm"
                  title={t("replay.restartTooltip")}
                >
                  <RefreshCw size={11} />
                  {t("replay.restart")}
                </Button>
                <Button
                  onClick={() => stopReplay(replayId)}
                  variant="tonal"
                  tone="danger"
                  size="sm"
                  title={t("replay.stopTooltip")}
                >
                  <StopCircle size={11} />
                  {t("replay.stop")}
                </Button>
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
            className={`flex items-center gap-3 px-4 py-2 ${bgSurface} border-b ${borderDefault}`}
          >
            <span className={`${textSecondary} text-sm`}>
              {t("replay.eventSummary", { count: replayLog.length })}
            </span>

            <div className="flex-1" />

            {activeReplays.size > 0 && (
              <Button
                onClick={() => activeReplays.forEach((id) => stopReplay(id))}
                variant="tonal"
                tone="danger"
                size="sm"
                title={t("replay.stopAllTooltip")}
              >
                <StopCircle size={13} />
                {activeReplays.size > 1
                  ? t("replay.stopReplaysLabel", { count: activeReplays.size })
                  : t("replay.stopReplayLabel")}
              </Button>
            )}

            <Button
              onClick={clearReplayLog}
              title={t("replay.clearLogTooltip")}
            >
              <Trash2 size={14} />
              <span className="text-sm ml-1">{t("replay.clearLabel")}</span>
            </Button>
          </div>

          {/* Log table */}
          <div className={`flex-1 overflow-auto ${bgDataView}`}>
            <Table sticky hover>
              <thead>
                <tr>
                  <th className="w-10" />
                  <th>{t("replay.columns.time")}</th>
                  <th>{t("replay.columns.session")}</th>
                  <th>{t("replay.columns.event")}</th>
                  <th>{t("replay.columns.details")}</th>
                  <th />
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
            </Table>
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
    kind === "started" ? <Play size={14} className={textDataCyan} /> :
    kind === "completed" ? <Check size={14} className={textSuccess} /> :
    kind === "loopRestarted" ? <RefreshCw size={14} className={textInfo} /> :
    kind === "stoppedByUser" ? <X size={14} className={textWarning} /> :
    <X size={14} className={textDanger} />;

  const kindBadge =
    kind === "started" ? <Badge tone="cyan">{t("replay.kindStarted")}</Badge> :
    kind === "completed" ? <Badge tone="success">{t("replay.kindCompleted")}</Badge> :
    kind === "loopRestarted" ? <Badge tone="primary">{t("replay.kindLoop")}</Badge> :
    kind === "stoppedByUser" ? <Badge tone="warning">{t("replay.kindStopped")}</Badge> :
    <Badge tone="danger">{t("replay.kindError")}</Badge>;

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
    <tr>
      <td>{icon}</td>
      <td className={`font-mono ${textSecondary}`}>{formatHumanUs(timestamp * 1000)}</td>
      <td className={textSecondary}>
        <span className="truncate max-w-30 block">{profileName}</span>
      </td>
      <td>{kindBadge}</td>
      <td className={`font-mono ${textSecondary}`}>{details}</td>
      <td>
        {onRestart && (
          <Button
            onClick={onRestart}
            variant="tonal"
            tone="primary"
            size="sm"
            title={t("replay.restartTooltipPast")}
          >
            <RefreshCw size={11} />
            {t("replay.restart")}
          </Button>
        )}
      </td>
    </tr>
  );
}
