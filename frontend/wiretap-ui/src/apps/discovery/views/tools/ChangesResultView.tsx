// ui/src/apps/discovery/views/tools/ChangesResultView.tsx

import { Fragment, useState, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { GitCompare, RefreshCw, Minus, Activity, ChevronDown, ChevronRight, Layers, Thermometer, Type, Ruler, Copy, GitMerge, Download, X } from "lucide-react";
import { iconSm, iconXs, iconLg, flexRowGap2 } from "../../../../styles/spacing";
import { caption, captionMuted, emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription, borderDivider, sectionHeaderText, textMuted } from "../../../../styles";
import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import type { ByteColumn, ChangesFrame, MultiBytePattern, MuxCase } from "../../../../api/byteRoles";
import type { ByteNote } from "../../../../generated/ByteNote";
import type { MirrorGroup } from "../../../../generated/MirrorGroup";
import type { MuxSelector } from "../../../../generated/MuxSelector";
import { caseNoteLines, formatMuxValue, frameNoteLines } from "../../../../utils/analysis/byteNoteText";
import { formatFrameKey } from "../../../../utils/frameIds";
import ExportAnalysisDialog from "../../../../dialogs/ExportAnalysisDialog";
import { pickFileToSave } from "../../../../api/dialogs";
import { saveCatalog } from "../../../../api/catalog";
import { useSettings } from "../../../../hooks/useSettings";
import { getFilterForFormat, type ExportFormat } from "../../../../utils/reportExport";
import { Button, IconButton } from "../../../../components/Button";
import { Badge, type BadgeStyleProps, type BadgeTone } from "../../../../components/Badge";
import { Card } from "../../../../components/Card";

// A text run is a reading of the bytes, not a numeric field, so the roles under it stay visible.
function getBytesInMultiBytePatterns(patterns: MultiBytePattern[]): Set<number> {
  const bytes = new Set<number>();
  for (const pattern of patterns) {
    if (pattern.kind === 'text') continue;
    for (let i = pattern.start; i < pattern.start + pattern.len; i++) {
      bytes.add(i);
    }
  }
  return bytes;
}

// Helper to count bytes by role, excluding those in multi-byte patterns
function countByteRoles(columns: ByteColumn[], patterns: MultiBytePattern[]) {
  const bytesInPatterns = getBytesInMultiBytePatterns(patterns);
  const outside = (role: ByteColumn['role']) => columns.filter(c => c.role === role && !bytesInPatterns.has(c.position)).length;
  return {
    staticCount: columns.filter(c => c.role === 'static').length,
    counterCount: outside('counter') + patterns.filter(p => p.kind === 'counter16').length,
    sensorCount: outside('sensor') + patterns.filter(p => p.kind === 'sensor16').length,
    valueCount: outside('value'),
    textCount: patterns.filter(p => p.kind === 'text').length,
  };
}

type Props = {
  embedded?: boolean;
  onClose?: () => void;
};

export default function ChangesResultView({ embedded = false, onClose }: Props) {
  const { t } = useTranslation("discovery");
  const results = useDiscoveryStore((s) => s.toolbox.changesResults);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const { settings } = useSettings();

  const handleExport = async (content: string, filename: string, format: ExportFormat) => {
    try {
      const path = await pickFileToSave({
        defaultPath: filename,
        filters: getFilterForFormat(format),
      });

      if (path) {
        await saveCatalog(path, content);
      }
    } catch (error) {
      console.error("Export failed:", error);
    }
    setShowExportDialog(false);
  };

  const { sortedFrames, summary, mirrors } = useMemo(() => {
    if (!results) {
      return { sortedFrames: [], summary: null, mirrors: [] };
    }

    const sorted = [...results.frames].sort((a, b) => a.frameId - b.frameId);
    const mirrors = results.mirrors.flatMap(({ protocol, groups }) => groups.map((group) => ({ protocol, group })));

    return {
      sortedFrames: sorted,
      mirrors,
      summary: {
        identicalCount: sorted.filter(f => f.identical !== null).length,
        varyingLengthCount: sorted.filter(f => f.minLen !== f.maxLen).length,
        muxCount: sorted.filter(f => f.mux !== null).length,
        burstCount: sorted.filter(f => f.burst).length,
        mirrorGroupCount: mirrors.length,
      },
    };
  }, [results]);

  if (!results) {
    const content = (
      <div className={emptyStateContainer}>
        <GitCompare className={`w-12 h-12 ${textMuted} mb-4`} />
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>{t("changes.noResults")}</p>
          <p className={emptyStateDescription}>
            {t("changes.noResultsDescription")}
          </p>
        </div>
      </div>
    );

    if (embedded) {
      return <div className="h-full flex flex-col">{content}</div>;
    }

    return (
      <Card padding="none" className="h-full flex flex-col">
        <Header onExport={() => {}} hasResults={false} onClose={onClose} />
        {content}
      </Card>
    );
  }

  const mainContent = (
    <>
      {/* Summary Section */}
      <div className={`px-4 py-3 ${borderDivider} bg-surface`}>
        <div className="flex flex-wrap gap-4 text-xs mb-2">
          <span className="text-muted">
            <span className="font-medium text-primary">{results.frameCount.toLocaleString()}</span> {t("changes.framesUnit")}
          </span>
          <span className="text-muted">
            <span className="font-medium text-primary">{results.frames.length}</span> {t("changes.uniqueAnalyzed")}
          </span>
        </div>

        {/* Summary badges row */}
        {summary && (summary.identicalCount > 0 || summary.varyingLengthCount > 0 || summary.muxCount > 0 || summary.burstCount > 0 || summary.mirrorGroupCount > 0) && (
          <div className="flex flex-wrap gap-2">
            {summary.mirrorGroupCount > 0 && (
              <Badge tone="purple" size="sm">
                <GitMerge className={iconXs} />
                {t("changes.mirrorGroup", { count: summary.mirrorGroupCount })}
              </Badge>
            )}
            {summary.identicalCount > 0 && (
              <Badge size="sm">
                <Copy className={iconXs} />
                {t("changes.identical", { count: summary.identicalCount })}
              </Badge>
            )}
            {summary.varyingLengthCount > 0 && (
              <Badge tone="warning" size="sm">
                <Ruler className={iconXs} />
                {t("changes.varyingLength", { count: summary.varyingLengthCount })}
              </Badge>
            )}
            {summary.muxCount > 0 && (
              <Badge tone="warning" size="sm">
                <Layers className={iconXs} />
                {t("changes.multiplexed", { count: summary.muxCount })}
              </Badge>
            )}
            {summary.burstCount > 0 && (
              <Badge tone="cyan" size="sm">{t("changes.burst", { count: summary.burstCount })}</Badge>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto space-y-4">
        {/* Mirror Groups Section */}
        {mirrors.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-pink flex items-center gap-1.5">
              <GitMerge className={iconSm} />
              {t("changes.mirrorFrames")}
            </div>
            {mirrors.map(({ protocol, group }, idx) => (
              <MirrorGroupCard key={idx} protocol={protocol} group={group} />
            ))}
          </div>
        )}

        {/* Individual Frame Cards */}
        {sortedFrames.map((frame) => (
          <FrameAnalysisCard key={`${frame.protocol}:${frame.frameId}:${frame.isExtended}`} frame={frame} />
        ))}
      </div>

      <ExportAnalysisDialog
        open={showExportDialog}
        results={results}
        defaultPath={settings?.report_dir}
        onCancel={() => setShowExportDialog(false)}
        onExport={handleExport}
      />
    </>
  );

  if (embedded) {
    return <div className="h-full flex flex-col">{mainContent}</div>;
  }

  return (
    <Card padding="none" className="h-full flex flex-col">
      <Header onExport={() => setShowExportDialog(true)} hasResults={true} onClose={onClose} />
      {mainContent}
    </Card>
  );
}

// ============================================================================
// Header
// ============================================================================

type HeaderProps = {
  onExport: () => void;
  hasResults?: boolean;
  onClose?: () => void;
};

function Header({ onExport, hasResults = false, onClose }: HeaderProps) {
  const { t } = useTranslation("discovery");
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${borderDivider}`}>
      <GitCompare className={`${iconLg} text-purple`} />
      <div className="flex-1">
        <h2 className={sectionHeaderText}>
          {t("changes.title")}
        </h2>
        <p className={caption}>
          {t("changes.subtitle")}
        </p>
      </div>
      {hasResults && (
        <Button
          onClick={onExport}
          variant="tonal"
          tone="purple"
          size="sm"
          title={t("changes.exportTooltip")}
        >
          <Download className={iconSm} />
          {t("changes.exportLabel")}
        </Button>
      )}
      {onClose && (
        <IconButton
          onClick={onClose}
          tone="danger"
          size="sm"
          title={t("changes.close")}
        >
          <X className={iconXs} />
        </IconButton>
      )}
    </div>
  );
}

// ============================================================================
// Mirror Group Card
// ============================================================================

type MirrorGroupCardProps = {
  protocol: string;
  group: MirrorGroup;
};

function MirrorGroupCard({ protocol, group }: MirrorGroupCardProps) {
  const { t } = useTranslation("discovery");
  return (
    <Card tone="purple">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            {group.keys.map((key, idx) => (
              <span key={`${key.frameId}:${key.isExtended}`}>
                <span className="font-mono font-semibold text-sm text-purple">
                  {formatFrameKey(protocol, key)}
                </span>
                {idx < group.keys.length - 1 && (
                  <span className="text-purple mx-1">↔</span>
                )}
              </span>
            ))}
          </div>
          <span className="text-xs text-purple">
            {t("changes.matchPercent", { percent: group.matchPercentage })}
          </span>
        </div>
        <span className="text-2xs text-purple">
          {t("changes.matchingPairs", { count: group.sampleCount })}
        </span>
      </div>

      <div className="mt-2 text-2xs text-purple">
        <span className="text-purple">{t("changes.samplePrefix")} </span>
        <span className="font-mono">
          {group.samplePayload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}
        </span>
      </div>

      <div className="mt-1.5 text-2xs text-purple">
        {t("changes.mirrorDescription")}
      </div>
    </Card>
  );
}

// ============================================================================
// Frame Analysis Card
// ============================================================================

type FrameAnalysisCardProps = {
  frame: ChangesFrame;
};

function FrameAnalysisCard({ frame }: FrameAnalysisCardProps) {
  const { t } = useTranslation("discovery");
  const counts = countByteRoles(frame.columns, frame.patterns);
  const selector = frame.mux?.detection.selector;
  const varyingLength = frame.minLen !== frame.maxLen;
  const notes = frameNoteLines(t, frame.notes.frame, selector);

  return (
    <Card>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-semibold text-sm text-primary">
            {formatFrameKey(frame.protocol ?? "can", frame)}
          </span>
          <span className={captionMuted}>
            {t("changes.samples", { count: frame.sampleCount })}
          </span>
          {frame.burst && (
            <Badge tone="cyan" size="sm">{t("changes.burstBadge")}</Badge>
          )}
          {frame.mux && (
            <Badge tone="warning" size="sm">
              <Layers className={iconXs} />
              {t("changes.muxBadge")}
            </Badge>
          )}
          {varyingLength && (
            <Badge
              tone="warning"
              size="sm"
              title={t("changes.lengthRangeTooltip", { min: frame.minLen, max: frame.maxLen })}
            >
              <Ruler className={iconXs} />
              {t("changes.lengthRangeBadge", { min: frame.minLen, max: frame.maxLen })}
            </Badge>
          )}
          {frame.identical && (
            <Badge size="sm" title={t("changes.identicalTooltip")}>
              <Copy className={iconXs} />
              {t("changes.identicalBadge")}
            </Badge>
          )}
        </div>
        <RoleCounts counts={counts} withIcons />
      </div>

      {frame.mux && selector ? (
        <>
          <div className="mb-3 text-2xs text-orange">
            <span className="font-medium">{t("changes.muxLabelPrefix")}</span>{" "}
            {selector === "twoByte" ? "byte[0:1]" : "byte[0]"}
            , {t("changes.muxCases")} {frame.mux.cases.map(c => formatMuxValue(c.value, selector)).join(", ")}
          </div>
          <div className="space-y-2">
            {frame.mux.cases.map((muxCase) => (
              <MuxCaseSection
                key={muxCase.value}
                muxCase={muxCase}
                notes={frame.notes.cases.find((c) => c.value === muxCase.value)?.notes ?? []}
                selector={selector}
                analysedFrom={frame.analysedFrom}
                analysedTo={frame.maxLen}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mb-3">
            <div className="text-2xs text-muted mb-1">
              {t("changes.byteRange", { from: frame.analysedFrom, to: frame.maxLen - 1 })}
            </div>
            <ByteVisualization
              columns={frame.columns}
              patterns={frame.patterns}
              sampleCount={frame.sampleCount}
            />
          </div>

          {notes.length > 0 && (
            <div className="border-t border-default pt-2">
              <div className="text-2xs font-medium text-muted mb-1">
                {t("changes.notes")}
              </div>
              <NoteList notes={notes} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function NoteList({ notes }: { notes: string[] }) {
  return (
    <ul className="space-y-0.5">
      {notes.map((note, idx) => (
        <li key={idx} className="text-2xs text-secondary">
          • {note}
        </li>
      ))}
    </ul>
  );
}

function RoleCounts({ counts, withIcons = false }: { counts: ReturnType<typeof countByteRoles>; withIcons?: boolean }) {
  const { t } = useTranslation("discovery");
  const entries = [
    { n: counts.staticCount, key: "changes.static", tone: "text-muted", Icon: Minus },
    { n: counts.counterCount, key: "changes.counter", tone: "text-green", Icon: RefreshCw },
    { n: counts.sensorCount, key: "changes.sensor", tone: "text-purple", Icon: Thermometer },
    { n: counts.valueCount, key: "changes.value", tone: "text-info", Icon: Activity },
    { n: counts.textCount, key: "changes.text", tone: "text-amber", Icon: Type },
  ];
  return (
    <div className="flex items-center gap-2 text-2xs">
      {entries.filter((e) => e.n > 0).map(({ n, key, tone, Icon }) => (
        <span key={key} className={`flex items-center gap-1 ${tone}`}>
          {withIcons && <Icon className={iconXs} />}
          {t(key, { count: n })}
        </span>
      ))}
    </div>
  );
}

// ============================================================================
// Mux Case Section (expandable per-case analysis)
// ============================================================================

type MuxCaseSectionProps = {
  muxCase: MuxCase;
  notes: ByteNote[];
  selector: MuxSelector;
  analysedFrom: number;
  analysedTo: number;
};

function MuxCaseSection({ muxCase, notes, selector, analysedFrom, analysedTo }: MuxCaseSectionProps) {
  const { t } = useTranslation("discovery");
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = caseNoteLines(t, notes, selector);

  return (
    <Card padding="none">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-hover transition-colors"
      >
        <div className={flexRowGap2}>
          {isExpanded ? (
            <ChevronDown className={`${iconXs} text-muted`} />
          ) : (
            <ChevronRight className={`${iconXs} text-muted`} />
          )}
          <span className="text-2xs font-medium text-orange">
            {t("changes.case", { value: formatMuxValue(muxCase.value, selector) })}
          </span>
          <span className="text-2xs text-muted">
            {t("changes.casesSamples", { count: muxCase.sampleCount })}
          </span>
        </div>
        <RoleCounts counts={countByteRoles(muxCase.columns, muxCase.patterns)} />
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-2 pb-2 pt-1 border-t border-default">
          <div className="mb-2">
            <div className="text-2xs text-muted mb-1">
              {t("changes.byteRange", { from: analysedFrom, to: analysedTo - 1 })}
            </div>
            <ByteVisualization
              columns={muxCase.columns}
              patterns={muxCase.patterns}
              sampleCount={muxCase.sampleCount}
            />
          </div>

          {lines.length > 0 && (
            <div className="border-t border-default pt-1.5 mt-1.5">
              <NoteList notes={lines} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// Byte Chip
// ============================================================================

type ByteChipProps = {
  byte: ByteColumn;
  /** The frame's or case's sample count; a byte reached by fewer is past the shortest payload. */
  sampleCount: number;
};

const TREND_ARROWS = { increasing: '↑', decreasing: '↓', mixed: '↕' } as const;

function ByteChip({ byte, sampleCount }: ByteChipProps) {
  const { t } = useTranslation("discovery");
  const idx = byte.position;
  let style: BadgeStyleProps = {};
  let title = t("changes.byteTooltipUnknown", { idx });
  let mark: ReactNode = null;

  switch (byte.role) {
    case 'static': {
      const value = byte.value.toString(16).toUpperCase().padStart(2, '0');
      style = { variant: 'outline' };
      title = t("changes.byteTooltipStatic", { idx, value });
      mark = <span className="ml-0.5 opacity-60">={value}</span>;
      break;
    }
    case 'counter': {
      style = { tone: 'success' };
      const dir = byte.direction === 'up' ? '↑' : '↓';
      title = byte.looping
        ? t("changes.byteTooltipLoopingCounter", { idx, dir, step: byte.step, min: byte.looping.min, max: byte.looping.max, mod: byte.looping.modulo })
        : t("changes.byteTooltipCounter", { idx, dir, step: byte.step, rollover: byte.rollover ? t("changes.byteTooltipCounterRollover") : '' });
      mark = (
        <span className="ml-0.5">
          {dir}
          {byte.looping ? <span className="opacity-70 text-2xs">%{byte.looping.modulo}</span> : byte.rollover && '↻'}
        </span>
      );
      break;
    }
    case 'sensor': {
      style = { tone: 'warning' };
      const trend = TREND_ARROWS[byte.trend];
      const strength = byte.strength ? t("changes.byteTooltipSensorStrength", { percent: Math.round(byte.strength * 100) }) : '';
      title = t("changes.byteTooltipSensor", { idx, trend, min: byte.min, max: byte.max, strength });
      mark = <span className="ml-0.5">{trend}{byte.rollover && '↻'}</span>;
      break;
    }
    case 'value':
      style = { tone: 'primary' };
      title = t("changes.byteTooltipValue", { idx, min: byte.min, max: byte.max, count: byte.distinctValues });
      mark = <span className="ml-0.5 opacity-60">~</span>;
      break;
  }

  const partial = byte.sampleCount < sampleCount;
  if (partial) {
    title += ` · ${t("changes.partialSamples", { count: byte.sampleCount, total: sampleCount })}`;
  }

  return (
    <Badge size="sm" mono {...style} title={title} className={partial ? "opacity-50" : ""}>
      {idx}
      {mark}
      {partial && (
        <span className="ml-0.5 text-2xs">{byte.sampleCount}/{sampleCount}</span>
      )}
    </Badge>
  );
}

// ============================================================================
// Multi-byte Pattern Chip
// ============================================================================

type MultiByteChipProps = {
  pattern: MultiBytePattern;
};

const PATTERN_CHIPS: Record<MultiBytePattern['kind'], { tone: BadgeTone; icon: string }> = {
  sensor16: { tone: 'purple', icon: '⚡' },
  sensor32: { tone: 'purple', icon: '⚡' },
  counter16: { tone: 'success', icon: '↻' },
  text: { tone: 'warning', icon: 'Aa' },
};

function MultiByteChip({ pattern }: MultiByteChipProps) {
  const { tone, icon } = PATTERN_CHIPS[pattern.kind];
  const end = pattern.start + pattern.len - 1;
  const endianChar = pattern.endianness === 'little' ? 'LE' : pattern.endianness === 'big' ? 'BE' : '';
  const rangeStr = pattern.range ? ` ${pattern.range[0]}–${pattern.range[1]}` : '';
  const textSample = pattern.sampleText ? ` "${pattern.sampleText}"` : '';
  const title = `${pattern.kind} @ byte[${pattern.start}:${end}]${endianChar ? ` ${endianChar}` : ''}${rangeStr}${textSample}${pattern.correlatedRollover ? ' (rollover correlation)' : ''}`;

  return (
    <Badge tone={tone} size="sm" mono title={title}>
      {pattern.start}–{end}
      <span className="ml-0.5">{icon}</span>
      {endianChar && <span className="ml-0.5 opacity-60 text-2xs">{endianChar}</span>}
      {pattern.kind === 'text' && textSample && <span className="ml-1 opacity-80">{textSample}</span>}
    </Badge>
  );
}

// ============================================================================
// Byte Visualization (combines single bytes and multi-byte patterns)
// ============================================================================

type ByteVisualizationProps = {
  columns: ByteColumn[];
  patterns: MultiBytePattern[];
  sampleCount: number;
};

function ByteVisualization({ columns, patterns, sampleCount }: ByteVisualizationProps) {
  const patternByStart = new Map(patterns.map((p) => [p.start, p]));
  const bytesInPatterns = getBytesInMultiBytePatterns(patterns);

  return (
    <div className="flex flex-wrap gap-1">
      {columns.map((byte) => {
        const pattern = patternByStart.get(byte.position);
        return (
          <Fragment key={byte.position}>
            {pattern && <MultiByteChip pattern={pattern} />}
            {!bytesInPatterns.has(byte.position) && <ByteChip byte={byte} sampleCount={sampleCount} />}
          </Fragment>
        );
      })}
    </div>
  );
}
