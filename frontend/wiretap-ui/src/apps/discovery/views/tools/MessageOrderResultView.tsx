// ui/src/apps/discovery/views/tools/MessageOrderResultView.tsx

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ListOrdered, Clock, Layers, Play, Shuffle, Zap, GitBranch, Download, X } from "lucide-react";
import { iconXs, iconMd, iconSm, iconLg, flexRowGap2 } from "../../../../styles/spacing";
import { labelSmall, caption, captionMuted, sectionHeaderText, emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../../styles/typography";
import { borderDivider, textMuted } from "../../../../styles";
import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import type { DetectedPattern, IntervalGroup, StartIdCandidate, MultiplexedFrame, BurstFrame, MultiBusFrame } from "../../../../utils/analysis/messageOrderAnalysis";
import { useSettings } from "../../../../hooks/useSettings";
import { formatFrameId } from "../../../../utils/frameIds";
import { formatMs } from "../../../../utils/reportExport";
import ExportReportDialog from "../../../../dialogs/ExportReportDialog";
import { pickFileToSave } from "../../../../api/dialogs";
import { saveCatalog } from "../../../../api/catalog";
import { generateFrameOrderReport } from "../../../../utils/frameOrderReport";
import { getFilterForFormat, type ExportFormat } from "../../../../utils/reportExport";
import { Button, IconButton } from "../../../../components/Button";
import { Badge } from "../../../../components/Badge";
import { Card, cardClass } from "../../../../components/Card";

type Props = {
  embedded?: boolean;
  onClose?: () => void;
};

export default function MessageOrderResultView({ embedded = false, onClose }: Props) {
  const { t } = useTranslation("discovery");
  const results = useDiscoveryStore((s) => s.toolbox.messageOrderResults);
  const updateOptions = useDiscoveryStore((s) => s.updateMessageOrderOptions);
  const runAnalysis = useDiscoveryStore((s) => s.runAnalysis);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const { settings } = useSettings();

  const handleSelectStartId = async (id: number) => {
    updateOptions({ startMessageId: id });
    await runAnalysis();
  };

  const handleExport = async (format: ExportFormat, filename: string) => {
    if (!results) return;
    try {
      const content = generateFrameOrderReport(results, format);
      const path = await pickFileToSave({
        defaultPath: filename,
        filters: getFilterForFormat(format),
      });
      if (path) {
        await saveCatalog(path, content);
      }
    } catch (err) {
      console.error("Failed to export report:", err);
    }
    setShowExportDialog(false);
  };

  const shell = embedded ? "h-full flex flex-col" : cardClass({ padding: "none" }, "h-full flex flex-col");

  if (!results) {
    return (
      <div className={shell}>
        {!embedded && <Header onExport={() => {}} hasResults={false} onClose={onClose} />}
        <div className={emptyStateContainer}>
          <ListOrdered className={`w-12 h-12 ${textMuted} mb-4`} />
          <div className={emptyStateText}>
            <p className={emptyStateHeading}>{t("messageOrder.noResults")}</p>
            <p className={emptyStateDescription}>
              {t("messageOrder.noResultsDescription")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={shell}>
      {!embedded && <Header onExport={() => setShowExportDialog(true)} hasResults={true} onClose={onClose} />}

      {/* Stats Summary */}
      <div className={`px-4 py-2 ${borderDivider} bg-[var(--bg-surface)]`}>
        <div className="flex flex-wrap gap-4 text-xs">
          <span className="text-[color:var(--text-muted)]">
            <span className="font-medium text-[color:var(--text-primary)]">{results.totalFramesAnalyzed.toLocaleString()}</span> {t("messageOrder.framesUnit")}
          </span>
          <span className="text-[color:var(--text-muted)]">
            <span className="font-medium text-[color:var(--text-primary)]">{results.uniqueFrameIds}</span> {t("messageOrder.uniqueIdsUnit")}
          </span>
          <span className="text-[color:var(--text-muted)]">
            <span className="font-medium text-[color:var(--text-primary)]">{formatMs(results.timeSpanMs)}</span> {t("messageOrder.spanUnit")}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto space-y-6">
        {/* Detected Patterns */}
        <PatternSection patterns={results.patterns} />

        {/* Multiplexed Frames */}
        <MultiplexedSection multiplexed={results.multiplexedFrames} />

        {/* Burst/Transaction Frames */}
        <BurstSection bursts={results.burstFrames} />

        {/* Multi-Bus Frames */}
        <MultiBusSection multiBus={results.multiBusFrames} />

        {/* Start ID Candidates */}
        <CandidatesSection
          candidates={results.startIdCandidates}
          onSelect={handleSelectStartId}
        />

        {/* Interval Groups */}
        <IntervalSection
          groups={results.intervalGroups}
          multiplexedIds={new Set(results.multiplexedFrames.map(m => m.frameId))}
          burstIds={new Set(results.burstFrames.map(b => b.frameId))}
        />
      </div>

      <ExportReportDialog
        open={showExportDialog}
        title={t("messageOrder.exportTitle")}
        description={t("messageOrder.exportDescription", {
          ids: results.uniqueFrameIds,
          samples: results.totalFramesAnalyzed.toLocaleString(),
        })}
        defaultFilename="frame-order-report"
        defaultPath={settings?.report_dir}
        onCancel={() => setShowExportDialog(false)}
        onExport={handleExport}
      />
    </div>
  );
}

// ============================================================================
// Header
// ============================================================================

type HeaderProps = {
  onExport: () => void;
  hasResults: boolean;
  onClose?: () => void;
};

function Header({ onExport, hasResults, onClose }: HeaderProps) {
  const { t } = useTranslation("discovery");
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${borderDivider}`}>
      <ListOrdered className={`${iconLg} text-[color:var(--text-purple)]`} />
      <div className="flex-1">
        <h2 className={sectionHeaderText}>
          {t("messageOrder.title")}
        </h2>
        <p className={caption}>
          {t("messageOrder.subtitle")}
        </p>
      </div>
      {hasResults && (
        <Button
          onClick={onExport}
          variant="ghost"
          size="sm"
          title={t("messageOrder.exportButtonTooltip")}
        >
          <Download className={iconSm} />
          <span>{t("messageOrder.exportLabel")}</span>
        </Button>
      )}
      {onClose && (
        <IconButton
          onClick={onClose}
          tone="danger"
          size="sm"
          title={t("messageOrder.close")}
        >
          <X className={iconXs} />
        </IconButton>
      )}
    </div>
  );
}

// ============================================================================
// Pattern Section
// ============================================================================

type PatternSectionProps = {
  patterns: DetectedPattern[];
};

function PatternSection({ patterns }: PatternSectionProps) {
  const { t } = useTranslation("discovery");
  if (patterns.length === 0) {
    return (
      <section>
        <div className="flex items-center gap-2 mb-2">
          <Play className={`${iconMd} text-slate-400`} />
          <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">{t("messageOrder.patterns")}</h3>
        </div>
        <p className={captionMuted}>
          {t("messageOrder.noPatterns")}
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Play className={`${iconMd} text-purple-500`} />
        <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">
          {t("messageOrder.patternsCount", { count: patterns.length })}
        </h3>
      </div>
      <div className="space-y-3">
        {patterns.map((pattern, idx) => (
          <PatternCard key={idx} pattern={pattern} rank={idx + 1} />
        ))}
      </div>
    </section>
  );
}

type PatternCardProps = {
  pattern: DetectedPattern;
  rank: number;
};

function PatternCard({ pattern, rank }: PatternCardProps) {
  const { t } = useTranslation("discovery");
  const confidencePercent = Math.round(pattern.confidence * 100);
  const isHighConfidence = pattern.confidence >= 0.8;

  return (
    <Card>
      <div className="flex items-start justify-between mb-2">
        <div className={flexRowGap2}>
          <span className={labelSmall}>
            {t("messageOrder.patternRank", { rank })}
          </span>
          <span className={captionMuted}>
            {t("messageOrder.patternStartsWith")} <span className="font-mono text-[color:var(--text-purple)]">{formatFrameId(pattern.startId)}</span>
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[color:var(--text-muted)]">
            {t("messageOrder.occurrences", { count: pattern.occurrences })}
          </span>
          <span
            className={`font-medium ${
              isHighConfidence
                ? "text-[color:var(--text-green)]"
                : "text-[color:var(--text-amber)]"
            }`}
          >
            {t("messageOrder.consistent", { percent: confidencePercent })}
          </span>
        </div>
      </div>

      {/* Sequence */}
      <div className="flex flex-wrap gap-1 mb-2">
        {pattern.sequence.map((id, i) => (
          <Badge key={i} tone={i === 0 ? "purple" : "neutral"} mono>
            {formatFrameId(id)}
          </Badge>
        ))}
      </div>

      <div className={captionMuted}>
        {t("messageOrder.framesAvgCycle", { count: pattern.sequence.length, cycle: formatMs(pattern.avgCycleTimeMs) })}
      </div>
    </Card>
  );
}

// ============================================================================
// Candidates Section
// ============================================================================

type CandidatesSectionProps = {
  candidates: StartIdCandidate[];
  onSelect: (id: number) => void;
};

function CandidatesSection({ candidates, onSelect }: CandidatesSectionProps) {
  const { t } = useTranslation("discovery");
  if (candidates.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Clock className={`${iconMd} text-blue-500`} />
        <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">
          {t("messageOrder.candidates")}
        </h3>
        <span className={captionMuted}>
          {t("messageOrder.candidatesSorted")}
        </span>
      </div>
      <Card padding="none" className="overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className={borderDivider}>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableFrameId")}</th>
              <th className="text-right px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableMaxGap")}</th>
              <th className="text-right px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableAvgGap")}</th>
              <th className="text-right px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableMinGap")}</th>
              <th className="text-right px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableCount")}</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate, idx) => (
              <tr
                key={candidate.id}
                className={idx % 2 === 0 ? "" : "bg-[var(--bg-subtle)]"}
              >
                <td className="px-3 py-2 font-mono text-[color:var(--text-purple)]">
                  {formatFrameId(candidate.id)}
                </td>
                <td className="px-3 py-2 text-right text-[color:var(--text-secondary)]">
                  {formatMs(candidate.maxGapBeforeMs)}
                </td>
                <td className="px-3 py-2 text-right text-[color:var(--text-muted)]">
                  {formatMs(candidate.avgGapBeforeMs)}
                </td>
                <td className="px-3 py-2 text-right text-[color:var(--text-muted)]">
                  {formatMs(candidate.minGapBeforeMs)}
                </td>
                <td className="px-3 py-2 text-right text-[color:var(--text-muted)]">
                  {candidate.occurrences}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    onClick={() => onSelect(candidate.id)}
                    variant="link"
                    tone="purple"
                    className="text-xs"
                  >
                    {t("messageOrder.useButton")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

// ============================================================================
// Multiplexed Section
// ============================================================================

type MultiplexedSectionProps = {
  multiplexed: MultiplexedFrame[];
};

function MultiplexedSection({ multiplexed }: MultiplexedSectionProps) {
  const { t } = useTranslation("discovery");
  if (multiplexed.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Shuffle className={`${iconMd} text-orange-500`} />
        <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">
          {t("messageOrder.multiplexedTitle", { count: multiplexed.length })}
        </h3>
        <span className={captionMuted}>
          {t("messageOrder.multiplexedHint")}
        </span>
      </div>
      <Card padding="none" className="overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className={borderDivider}>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableFrameId")}</th>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableSelector")}</th>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableCases")}</th>
              <th className="text-right px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableMuxPeriod")}</th>
              <th className="text-right px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableInterMsg")}</th>
            </tr>
          </thead>
          <tbody>
            {multiplexed.map((mux, idx) => (
              <tr
                key={mux.frameId}
                className={idx % 2 === 0 ? "" : "bg-[var(--bg-subtle)]"}
              >
                <td className="px-3 py-2 font-mono text-[color:var(--text-orange)]">
                  {formatFrameId(mux.frameId)}
                </td>
                <td className="px-3 py-2 text-[color:var(--text-secondary)]">
                  {mux.selectorByte === -1 ? "byte[0:1]" : `byte[${mux.selectorByte}]`}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {mux.selectorByte === -1 ? (
                      // Two-byte mux: show as "b0.b1" format
                      mux.selectorValues.map((val) => {
                        const b0 = Math.floor(val / 256);
                        const b1 = val % 256;
                        return (
                          <Badge key={val} tone="warning" size="sm" mono>
                            {b0}.{b1}
                          </Badge>
                        );
                      })
                    ) : (
                      // Single-byte mux
                      mux.selectorValues.map((val) => (
                        <Badge key={val} tone="warning" size="sm" mono>
                          {val}
                        </Badge>
                      ))
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-right text-[color:var(--text-emerald)] font-medium">
                  {formatMs(mux.muxPeriodMs)}
                </td>
                <td className="px-3 py-2 text-right text-[color:var(--text-tertiary)]">
                  {formatMs(mux.interMessageMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

// ============================================================================
// Burst/Transaction Section
// ============================================================================

type BurstSectionProps = {
  bursts: BurstFrame[];
};

function BurstSection({ bursts }: BurstSectionProps) {
  const { t } = useTranslation("discovery");
  if (bursts.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Zap className={`${iconMd} text-cyan-500`} />
        <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">
          {t("messageOrder.burstTitle", { count: bursts.length })}
        </h3>
        <span className={captionMuted}>
          {t("messageOrder.burstHint")}
        </span>
      </div>
      <Card padding="none" className="overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className={borderDivider}>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableFrameId")}</th>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableDlcs")}</th>
              <th className="text-right px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableBurstSize")}</th>
              <th className="text-right px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableCycle")}</th>
              <th className="text-right px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableIntraBurst")}</th>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableFlags")}</th>
            </tr>
          </thead>
          <tbody>
            {bursts.map((burst, idx) => (
              <tr
                key={burst.frameId}
                className={idx % 2 === 0 ? "" : "bg-[var(--bg-subtle)]"}
              >
                <td className="px-3 py-2 font-mono text-[color:var(--text-cyan)]">
                  {formatFrameId(burst.frameId)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {burst.dlcVariation.map((dlc) => (
                      <Badge key={dlc} tone="cyan" size="sm" mono>
                        {dlc}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-right text-[color:var(--text-secondary)]">
                  {burst.burstCount === 1 ? "—" : `~${burst.burstCount}`}
                </td>
                <td className="px-3 py-2 text-right text-[color:var(--text-emerald)] font-medium">
                  {formatMs(burst.burstPeriodMs)}
                </td>
                <td className="px-3 py-2 text-right text-[color:var(--text-tertiary)]">
                  {burst.burstCount > 1 ? formatMs(burst.interMessageMs) : "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {burst.flags.map((flag) => (
                      <Badge key={flag} size="sm">
                        {flag}
                      </Badge>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

// ============================================================================
// Multi-Bus Section
// ============================================================================

type MultiBusSectionProps = {
  multiBus: MultiBusFrame[];
};

function MultiBusSection({ multiBus }: MultiBusSectionProps) {
  const { t } = useTranslation("discovery");
  if (multiBus.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <GitBranch className={`${iconMd} text-rose-500`} />
        <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">
          {t("messageOrder.multiBusTitle", { count: multiBus.length })}
        </h3>
        <span className={captionMuted}>
          {t("messageOrder.multiBusHint")}
        </span>
      </div>
      <Card padding="none" className="overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className={borderDivider}>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableFrameId")}</th>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableBuses")}</th>
              <th className="text-left px-3 py-2 font-medium text-[color:var(--text-muted)]">{t("messageOrder.tableCountPerBus")}</th>
            </tr>
          </thead>
          <tbody>
            {multiBus.map((frame, idx) => (
              <tr
                key={frame.frameId}
                className={idx % 2 === 0 ? "" : "bg-[var(--bg-subtle)]"}
              >
                <td className="px-3 py-2 font-mono text-[color:var(--text-rose)]">
                  {formatFrameId(frame.frameId)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {frame.buses.map((bus) => (
                      <Badge key={bus} tone="danger" size="sm" mono>
                        {t("messageOrder.busLabel", { bus })}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {frame.buses.map((bus) => (
                      <Badge key={bus} size="sm">
                        {bus}: {frame.countPerBus[bus]}
                      </Badge>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

// ============================================================================
// Interval Section
// ============================================================================

type IntervalSectionProps = {
  groups: IntervalGroup[];
  multiplexedIds: Set<number>;
  burstIds: Set<number>;
};

function IntervalSection({ groups, multiplexedIds, burstIds }: IntervalSectionProps) {
  const { t } = useTranslation("discovery");
  if (groups.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Layers className={`${iconMd} text-emerald-500`} />
        <h3 className="text-xs font-medium text-[color:var(--text-secondary)]">
          {t("messageOrder.intervalGroups")}
        </h3>
        <span className={captionMuted}>
          {t("messageOrder.intervalHint")}
        </span>
      </div>
      <div className="space-y-2">
        {groups.map((group, idx) => (
          <Card key={idx} padding="sm">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-[color:var(--text-emerald)]">
                ~{formatMs(group.intervalMs)}
              </span>
              <span className={captionMuted}>
                {t("messageOrder.frameCount", { count: group.frameIds.length })}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {group.frameIds.map((id) => {
                const isMux = multiplexedIds.has(id);
                const isBurst = burstIds.has(id);
                return (
                  <Badge
                    key={id}
                    tone={isMux ? "warning" : isBurst ? "cyan" : "neutral"}
                    size="sm"
                    mono
                    title={isMux ? t("messageOrder.tooltipMultiplexed") : isBurst ? t("messageOrder.tooltipBurst") : undefined}
                  >
                    {formatFrameId(id)}
                    {(isMux || isBurst) && <span>⚡</span>}
                  </Badge>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
