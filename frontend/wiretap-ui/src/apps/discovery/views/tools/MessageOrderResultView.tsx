// ui/src/apps/discovery/views/tools/MessageOrderResultView.tsx

import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListOrdered, Clock, Layers, Play, Shuffle, Zap, GitBranch, Download, X } from "lucide-react";
import { iconXs, iconMd, iconSm, iconLg, flexRowGap2 } from "../../../../styles/spacing";
import { labelSmall, caption, captionMuted, sectionHeaderText, emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../../styles/typography";
import { borderDivider, textDanger, textDataCyan, textDataGreen, textDataOrange, textDataPurple, textMuted, textSecondary } from "../../../../styles";
import { Table } from "../../../../components/Table";
import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import type { BurstTiming } from "../../../../generated/BurstTiming";
import type { BusOrder } from "../../../../generated/BusOrder";
import type { CyclePattern } from "../../../../generated/CyclePattern";
import type { FrameKey } from "../../../../generated/FrameKey";
import type { IntervalGroup } from "../../../../generated/IntervalGroup";
import type { MultiBusFrame } from "../../../../generated/MultiBusFrame";
import type { MuxTiming } from "../../../../generated/MuxTiming";
import type { StartCandidate } from "../../../../generated/StartCandidate";
import { useSettings } from "../../../../hooks/useSettings";
import { formatFrameKey } from "../../../../utils/frameIds";
import { protocolLabel } from "../../../../utils/profileTraits";
import { formatMs, formatOptionalMs } from "../../../../utils/reportExport";
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

  const handleSelectStart = async (protocol: string, key: FrameKey) => {
    updateOptions({ start: { protocol, frameId: key.frameId, isExtended: key.isExtended } });
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

  const totalFrames = results.reduce((n, o) => n + o.order.totalFrames, 0);
  const uniqueKeys = results.reduce((n, o) => n + o.order.uniqueKeys, 0);
  const timeSpanMs = Math.max(0, ...results.map((o) => o.order.timeSpanMs));

  return (
    <div className={shell}>
      {!embedded && <Header onExport={() => setShowExportDialog(true)} hasResults={true} onClose={onClose} />}

      {/* Stats Summary */}
      <div className={`px-4 py-2 ${borderDivider} bg-surface`}>
        <div className="flex flex-wrap gap-4 text-xs">
          <span className="text-muted">
            <span className="font-medium text-primary">{totalFrames.toLocaleString()}</span> {t("messageOrder.framesUnit")}
          </span>
          <span className="text-muted">
            <span className="font-medium text-primary">{uniqueKeys}</span> {t("messageOrder.uniqueIdsUnit")}
          </span>
          <span className="text-muted">
            <span className="font-medium text-primary">{formatMs(timeSpanMs)}</span> {t("messageOrder.spanUnit")}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto space-y-6">
        {results.map(({ protocol, order }) => {
          const format = (key: FrameKey) => formatFrameKey(protocol, key);
          return (
            <Fragment key={protocol}>
              {order.buses.map((bus) => (
                <BusSection
                  key={bus.bus}
                  protocol={protocol}
                  bus={bus}
                  format={format}
                  onSelectStart={(key) => handleSelectStart(protocol, key)}
                />
              ))}
              <MultiBusSection multiBus={order.multiBus} format={format} />
            </Fragment>
          );
        })}
      </div>

      <ExportReportDialog
        open={showExportDialog}
        title={t("messageOrder.exportTitle")}
        description={t("messageOrder.exportDescription", {
          ids: uniqueKeys,
          samples: totalFrames.toLocaleString(),
        })}
        defaultFilename="frame-order-report"
        defaultPath={settings?.report_dir}
        onCancel={() => setShowExportDialog(false)}
        onExport={handleExport}
      />
    </div>
  );
}

type Format = (key: FrameKey) => string;

const keyId = (key: FrameKey) => `${key.frameId}:${key.isExtended}`;

// ============================================================================
// One bus
// ============================================================================

type BusSectionProps = {
  protocol: string;
  bus: BusOrder;
  format: Format;
  onSelectStart: (key: FrameKey) => void;
};

function BusSection({ protocol, bus, format, onSelectStart }: BusSectionProps) {
  const { t } = useTranslation("discovery");
  return (
    <section className="space-y-6">
      <div className="flex items-baseline gap-2 border-b border-default pb-1">
        <h3 className="text-sm font-medium text-primary">
          {t("messageOrder.busHeading", { protocol: protocolLabel(protocol), bus: bus.bus })}
        </h3>
        <span className={captionMuted}>{t("messageOrder.busFrames", { count: bus.frameCount })}</span>
      </div>
      <PatternSection patterns={bus.patterns} format={format} />
      <MultiplexedSection multiplexed={bus.mux} format={format} />
      <BurstSection bursts={bus.bursts} format={format} />
      <CandidatesSection candidates={bus.startCandidates} format={format} onSelect={onSelectStart} />
      <IntervalSection
        groups={bus.intervalGroups}
        format={format}
        multiplexedIds={new Set(bus.mux.map(keyId))}
        burstIds={new Set(bus.bursts.map(keyId))}
      />
    </section>
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
      <ListOrdered className={`${iconLg} text-purple`} />
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
  patterns: CyclePattern[];
  format: Format;
};

function PatternSection({ patterns, format }: PatternSectionProps) {
  const { t } = useTranslation("discovery");
  if (patterns.length === 0) {
    return (
      <section>
        <div className="flex items-center gap-2 mb-2">
          <Play className={`${iconMd} text-muted`} />
          <h3 className="text-xs font-medium text-secondary">{t("messageOrder.patterns")}</h3>
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
        <Play className={`${iconMd} text-purple`} />
        <h3 className="text-xs font-medium text-secondary">
          {t("messageOrder.patternsCount", { count: patterns.length })}
        </h3>
      </div>
      <div className="space-y-3">
        {patterns.map((pattern, idx) => (
          <PatternCard key={idx} pattern={pattern} rank={idx + 1} format={format} />
        ))}
      </div>
    </section>
  );
}

type PatternCardProps = {
  pattern: CyclePattern;
  rank: number;
  format: Format;
};

function PatternCard({ pattern, rank, format }: PatternCardProps) {
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
            {t("messageOrder.patternStartsWith")} <span className="font-mono text-purple">{format(pattern.start)}</span>
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted">
            {t("messageOrder.occurrences", { count: pattern.occurrences })}
          </span>
          <span
            className={`font-medium ${
              isHighConfidence
                ? "text-green"
                : "text-amber"
            }`}
          >
            {t("messageOrder.consistent", { percent: confidencePercent })}
          </span>
        </div>
      </div>

      {/* Sequence */}
      <div className="flex flex-wrap gap-1 mb-2">
        {pattern.sequence.map((key, i) => (
          <Badge key={i} tone={i === 0 ? "purple" : "neutral"} mono>
            {format(key)}
          </Badge>
        ))}
      </div>

      <div className={captionMuted}>
        {t("messageOrder.framesAvgCycle", { count: pattern.sequence.length, cycle: formatOptionalMs(pattern.cycleMs) })}
      </div>
    </Card>
  );
}

// ============================================================================
// Candidates Section
// ============================================================================

type CandidatesSectionProps = {
  candidates: StartCandidate[];
  format: Format;
  onSelect: (key: FrameKey) => void;
};

function CandidatesSection({ candidates, format, onSelect }: CandidatesSectionProps) {
  const { t } = useTranslation("discovery");
  if (candidates.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Clock className={`${iconMd} text-blue`} />
        <h3 className="text-xs font-medium text-secondary">
          {t("messageOrder.candidates")}
        </h3>
        <span className={captionMuted}>
          {t("messageOrder.candidatesSorted")}
        </span>
      </div>
      <Card padding="none" className="overflow-hidden">
        <Table>
          <thead>
            <tr>
              <th>{t("messageOrder.tableFrameId")}</th>
              <th className="text-right">{t("messageOrder.tableMaxGap")}</th>
              <th className="text-right">{t("messageOrder.tableAvgGap")}</th>
              <th className="text-right">{t("messageOrder.tableMinGap")}</th>
              <th className="text-right">{t("messageOrder.tableCount")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => (
              <tr key={keyId(candidate)}>
                <td className={`font-mono ${textDataPurple}`}>
                  {format(candidate)}
                </td>
                <td className={`text-right ${textSecondary}`}>
                  {formatMs(candidate.maxGapBeforeMs)}
                </td>
                <td className={`text-right ${textMuted}`}>
                  {formatMs(candidate.avgGapBeforeMs)}
                </td>
                <td className={`text-right ${textMuted}`}>
                  {formatMs(candidate.minGapBeforeMs)}
                </td>
                <td className={`text-right ${textMuted}`}>
                  {candidate.occurrences}
                </td>
                <td className="text-right">
                  <Button
                    onClick={() => onSelect(candidate)}
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
        </Table>
      </Card>
    </section>
  );
}

// ============================================================================
// Multiplexed Section
// ============================================================================

type MultiplexedSectionProps = {
  multiplexed: MuxTiming[];
  format: Format;
};

function MultiplexedSection({ multiplexed, format }: MultiplexedSectionProps) {
  const { t } = useTranslation("discovery");
  if (multiplexed.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Shuffle className={`${iconMd} text-orange`} />
        <h3 className="text-xs font-medium text-secondary">
          {t("messageOrder.multiplexedTitle", { count: multiplexed.length })}
        </h3>
        <span className={captionMuted}>
          {t("messageOrder.multiplexedHint")}
        </span>
      </div>
      <Card padding="none" className="overflow-hidden">
        <Table>
          <thead>
            <tr>
              <th>{t("messageOrder.tableFrameId")}</th>
              <th>{t("messageOrder.tableSelector")}</th>
              <th>{t("messageOrder.tableCases")}</th>
              <th className="text-right">{t("messageOrder.tableMuxPeriod")}</th>
              <th className="text-right">{t("messageOrder.tableInterMsg")}</th>
            </tr>
          </thead>
          <tbody>
            {multiplexed.map((mux) => {
              const twoByte = mux.selector === "twoByte";
              return (
                <tr key={keyId(mux)}>
                  <td className={`font-mono ${textDataOrange}`}>
                    {format(mux)}
                  </td>
                  <td className={textSecondary}>
                    {twoByte ? "byte[0:1]" : "byte[0]"}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {Object.keys(mux.occurrences).map(Number).map((val) => (
                        <Badge key={val} tone="warning" size="sm" mono>
                          {twoByte ? `${Math.floor(val / 256)}.${val % 256}` : val}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className={`text-right font-medium ${textDataGreen}`}>
                    {formatOptionalMs(mux.muxPeriodMs)}
                  </td>
                  <td className={`text-right ${textMuted}`}>
                    {formatMs(mux.interMessageMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </section>
  );
}

// ============================================================================
// Burst/Transaction Section
// ============================================================================

type BurstSectionProps = {
  bursts: BurstTiming[];
  format: Format;
};

function BurstSection({ bursts, format }: BurstSectionProps) {
  const { t } = useTranslation("discovery");
  if (bursts.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Zap className={`${iconMd} text-cyan`} />
        <h3 className="text-xs font-medium text-secondary">
          {t("messageOrder.burstTitle", { count: bursts.length })}
        </h3>
        <span className={captionMuted}>
          {t("messageOrder.burstHint")}
        </span>
      </div>
      <Card padding="none" className="overflow-hidden">
        <Table>
          <thead>
            <tr>
              <th>{t("messageOrder.tableFrameId")}</th>
              <th>{t("messageOrder.tableDlcs")}</th>
              <th className="text-right">{t("messageOrder.tableBurstSize")}</th>
              <th className="text-right">{t("messageOrder.tableCycle")}</th>
              <th className="text-right">{t("messageOrder.tableIntraBurst")}</th>
              <th>{t("messageOrder.tableFlags")}</th>
            </tr>
          </thead>
          <tbody>
            {bursts.map((burst) => (
              <tr key={keyId(burst)}>
                <td className={`font-mono ${textDataCyan}`}>
                  {format(burst)}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {burst.lengths.map((len) => (
                      <Badge key={len} tone="cyan" size="sm" mono>
                        {len}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className={`text-right ${textSecondary}`}>
                  {burst.framesPerBurst === 1 ? "—" : `~${burst.framesPerBurst.toFixed(1)}`}
                </td>
                <td className={`text-right font-medium ${textDataGreen}`}>
                  {formatMs(burst.burstPeriodMs)}
                </td>
                <td className={`text-right ${textMuted}`}>
                  {burst.framesPerBurst > 1 ? formatMs(burst.interMessageMs) : "—"}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {burst.flags.map((flag) => (
                      <Badge key={flag} size="sm">
                        {t(`messageOrder.flags.${flag}`)}
                      </Badge>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </section>
  );
}

// ============================================================================
// Multi-Bus Section
// ============================================================================

type MultiBusSectionProps = {
  multiBus: MultiBusFrame[];
  format: Format;
};

function MultiBusSection({ multiBus, format }: MultiBusSectionProps) {
  const { t } = useTranslation("discovery");
  if (multiBus.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <GitBranch className={`${iconMd} text-pink`} />
        <h3 className="text-xs font-medium text-secondary">
          {t("messageOrder.multiBusTitle", { count: multiBus.length })}
        </h3>
        <span className={captionMuted}>
          {t("messageOrder.multiBusHint")}
        </span>
      </div>
      <Card padding="none" className="overflow-hidden">
        <Table>
          <thead>
            <tr>
              <th>{t("messageOrder.tableFrameId")}</th>
              <th>{t("messageOrder.tableBuses")}</th>
              <th>{t("messageOrder.tableCountPerBus")}</th>
            </tr>
          </thead>
          <tbody>
            {multiBus.map((frame) => {
              const counts = Object.entries(frame.framesPerBus);
              return (
                <tr key={keyId(frame)}>
                  <td className={`font-mono ${textDanger}`}>
                    {format(frame)}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {counts.map(([bus]) => (
                        <Badge key={bus} tone="danger" size="sm" mono>
                          {t("messageOrder.busLabel", { bus })}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {counts.map(([bus, count]) => (
                        <Badge key={bus} size="sm">
                          {bus}: {count}
                        </Badge>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </section>
  );
}

// ============================================================================
// Interval Section
// ============================================================================

type IntervalSectionProps = {
  groups: IntervalGroup[];
  format: Format;
  multiplexedIds: Set<string>;
  burstIds: Set<string>;
};

function IntervalSection({ groups, format, multiplexedIds, burstIds }: IntervalSectionProps) {
  const { t } = useTranslation("discovery");
  if (groups.length === 0) {
    return null;
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Layers className={`${iconMd} text-emerald`} />
        <h3 className="text-xs font-medium text-secondary">
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
              <span className={`text-xs font-medium ${textDataGreen}`}>
                ~{formatMs(group.intervalMs)}
              </span>
              <span className={captionMuted}>
                {t("messageOrder.frameCount", { count: group.keys.length })}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {group.keys.map((key) => {
                const isMux = multiplexedIds.has(keyId(key));
                const isBurst = burstIds.has(keyId(key));
                return (
                  <Badge
                    key={keyId(key)}
                    tone={isMux ? "warning" : isBurst ? "cyan" : "neutral"}
                    size="sm"
                    mono
                    title={isMux ? t("messageOrder.tooltipMultiplexed") : isBurst ? t("messageOrder.tooltipBurst") : undefined}
                  >
                    {format(key)}
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
