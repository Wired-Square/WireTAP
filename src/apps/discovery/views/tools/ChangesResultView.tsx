// ui/src/apps/discovery/views/tools/ChangesResultView.tsx

import { useState, useMemo } from "react";
import { GitCompare, RefreshCw, Minus, Activity, ChevronDown, ChevronRight, Layers, Thermometer, Type, Ruler, Copy, GitMerge, Download, X } from "lucide-react";
import { iconSm, iconXs, iconLg, flexRowGap2, paddingCardSm } from "../../../../styles/spacing";
import { iconButtonDangerCompact } from "../../../../styles/buttonStyles";
import { cardDefault } from "../../../../styles/cardStyles";
import { caption, captionMuted, emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription, borderDivider, bgSurface, sectionHeaderText, textMuted } from "../../../../styles";
import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import type { PayloadAnalysisResult, ByteStats, MuxCaseAnalysis, MultiBytePattern, MirrorGroup } from "../../../../utils/analysis/payloadAnalysis";
import { formatMuxValue } from "../../../../utils/analysis/muxDetection";
import { formatFrameId } from "../../../../utils/frameIds";
import ExportAnalysisDialog from "../../../../dialogs/ExportAnalysisDialog";
import { pickFileToSave } from "../../../../api/dialogs";
import { saveCatalog } from "../../../../api/catalog";
import { useSettings } from "../../../../hooks/useSettings";
import { getFilterForFormat, type ExportFormat } from "../../../../utils/reportExport";

// Helper to build a set of byte indices that are part of multi-byte patterns
function getBytesInMultiBytePatterns(patterns: MultiBytePattern[]): Set<number> {
  const bytes = new Set<number>();
  for (const pattern of patterns) {
    for (let i = pattern.startByte; i < pattern.startByte + pattern.length; i++) {
      bytes.add(i);
    }
  }
  return bytes;
}

// Helper to count bytes by role, excluding those in multi-byte patterns
function countByteRoles(byteStats: ByteStats[], multiBytePatterns: MultiBytePattern[]) {
  const bytesInPatterns = getBytesInMultiBytePatterns(multiBytePatterns);
  return {
    staticCount: byteStats.filter(s => s.role === 'static').length,
    counterCount: byteStats.filter(s => s.role === 'counter' && !bytesInPatterns.has(s.byteIndex)).length,
    sensorCount: byteStats.filter(s => s.role === 'sensor' && !bytesInPatterns.has(s.byteIndex)).length,
    valueCount: byteStats.filter(s => s.role === 'value' && !bytesInPatterns.has(s.byteIndex)).length,
    sensor16Count: multiBytePatterns.filter(p => p.pattern === 'sensor16').length,
    counter16Count: multiBytePatterns.filter(p => p.pattern === 'counter16').length,
    counter32Count: multiBytePatterns.filter(p => p.pattern === 'counter32').length,
    textCount: multiBytePatterns.filter(p => p.pattern === 'text').length,
  };
}

type Props = {
  embedded?: boolean;
  onClose?: () => void;
};

export default function ChangesResultView({ embedded = false, onClose }: Props) {
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

  // Sort results by frameId and compute summary statistics
  const { sortedResults, summary, mirrorGroups } = useMemo(() => {
    if (!results) {
      return { sortedResults: [], summary: null, mirrorGroups: [] };
    }

    const sorted = [...results.analysisResults].sort((a, b) => a.frameId - b.frameId);

    const identicalCount = sorted.filter(r => r.isIdentical).length;
    const varyingLengthCount = sorted.filter(r => r.hasVaryingLength).length;
    const muxCount = sorted.filter(r => r.isMuxFrame).length;
    const burstCount = sorted.filter(r => r.isBurstFrame).length;
    const mirrorGroupCount = results.mirrorGroups?.length ?? 0;

    return {
      sortedResults: sorted,
      mirrorGroups: results.mirrorGroups ?? [],
      summary: {
        identicalCount,
        varyingLengthCount,
        muxCount,
        burstCount,
        mirrorGroupCount,
      },
    };
  }, [results]);

  if (!results) {
    const content = (
      <div className={emptyStateContainer}>
        <GitCompare className={`w-12 h-12 ${textMuted} mb-4`} />
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>No results yet</p>
          <p className={emptyStateDescription}>
            Select frames in the sidebar and click "Run Analysis" to detect payload patterns.
          </p>
        </div>
      </div>
    );

    if (embedded) {
      return <div className="h-full flex flex-col">{content}</div>;
    }

    return (
      <div className={`h-full flex flex-col ${bgSurface} rounded-lg border border-[color:var(--border-default)]`}>
        <Header onExport={() => {}} hasResults={false} onClose={onClose} />
        {content}
      </div>
    );
  }

  const mainContent = (
    <>
      {/* Summary Section */}
      <div className={`px-4 py-3 ${borderDivider} bg-[var(--bg-surface)]`}>
        <div className="flex flex-wrap gap-4 text-xs mb-2">
          <span className="text-[color:var(--text-muted)]">
            <span className="font-medium text-[color:var(--text-primary)]">{results.frameCount.toLocaleString()}</span> frames
          </span>
          <span className="text-[color:var(--text-muted)]">
            <span className="font-medium text-[color:var(--text-primary)]">{results.uniqueFrameIds}</span> unique IDs analyzed
          </span>
        </div>

        {/* Summary badges row */}
        {summary && (summary.identicalCount > 0 || summary.varyingLengthCount > 0 || summary.muxCount > 0 || summary.burstCount > 0 || summary.mirrorGroupCount > 0) && (
          <div className="flex flex-wrap gap-2 text-[10px]">
            {summary.mirrorGroupCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-pink-100/50 text-pink-600">
                <GitMerge className={iconXs} />
                {summary.mirrorGroupCount} mirror group{summary.mirrorGroupCount > 1 ? 's' : ''}
              </span>
            )}
            {summary.identicalCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--hover-bg)] text-[color:var(--text-secondary)]">
                <Copy className={iconXs} />
                {summary.identicalCount} identical
              </span>
            )}
            {summary.varyingLengthCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--status-warning-bg)] text-[color:var(--text-yellow)]">
                <Ruler className={iconXs} />
                {summary.varyingLengthCount} varying length
              </span>
            )}
            {summary.muxCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-orange-100/50 text-[color:var(--text-orange)]">
                <Layers className={iconXs} />
                {summary.muxCount} multiplexed
              </span>
            )}
            {summary.burstCount > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-100/50 text-[color:var(--text-cyan)]">
                {summary.burstCount} burst
              </span>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto space-y-4">
        {/* Mirror Groups Section */}
        {mirrorGroups.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-pink-600 flex items-center gap-1.5">
              <GitMerge className={iconSm} />
              Mirror Frames
            </div>
            {mirrorGroups.map((group, idx) => (
              <MirrorGroupCard key={idx} group={group} />
            ))}
          </div>
        )}

        {/* Individual Frame Cards */}
        {sortedResults.map((result) => (
          <FrameAnalysisCard key={result.frameId} result={result} />
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
    <div className={`h-full flex flex-col ${bgSurface} rounded-lg border border-[color:var(--border-default)]`}>
      <Header onExport={() => setShowExportDialog(true)} hasResults={true} onClose={onClose} />
      {mainContent}
    </div>
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
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${borderDivider}`}>
      <GitCompare className={`${iconLg} text-[color:var(--text-purple)]`} />
      <div className="flex-1">
        <h2 className={sectionHeaderText}>
          Payload Changes Analysis
        </h2>
        <p className={caption}>
          Detected byte patterns and characteristics
        </p>
      </div>
      {hasResults && (
        <button
          type="button"
          onClick={onExport}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs bg-[var(--status-purple-bg)] text-[color:var(--text-purple)] hover:brightness-95 transition-colors"
          title="Export analysis results"
        >
          <Download className={iconSm} />
          Export
        </button>
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className={iconButtonDangerCompact}
          title="Close"
        >
          <X className={iconXs} />
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Mirror Group Card
// ============================================================================

type MirrorGroupCardProps = {
  group: MirrorGroup;
};

function MirrorGroupCard({ group }: MirrorGroupCardProps) {
  return (
    <div className="p-3 bg-pink-50/50 rounded-lg border border-pink-300">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            {group.frameIds.map((id, idx) => (
              <span key={id}>
                <span className="font-mono font-semibold text-sm text-pink-600">
                  {formatFrameId(id)}
                </span>
                {idx < group.frameIds.length - 1 && (
                  <span className="text-pink-500 mx-1">↔</span>
                )}
              </span>
            ))}
          </div>
          <span className="text-xs text-pink-500">
            {group.matchPercentage}% match
          </span>
        </div>
        <span className="text-[10px] text-pink-500">
          {group.sampleCount} matching pairs
        </span>
      </div>

      {/* Sample payload */}
      {group.samplePayload && (
        <div className="mt-2 text-[10px] text-pink-600">
          <span className="text-pink-500">Sample: </span>
          <span className="font-mono">
            {group.samplePayload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}
          </span>
        </div>
      )}

      <div className="mt-1.5 text-[10px] text-pink-500">
        These frame IDs transmit identical payloads that change together
      </div>
    </div>
  );
}

// ============================================================================
// Frame Analysis Card
// ============================================================================

type FrameAnalysisCardProps = {
  result: PayloadAnalysisResult;
};

function FrameAnalysisCard({ result }: FrameAnalysisCardProps) {
  const counts = countByteRoles(result.byteStats, result.multiBytePatterns);

  return (
    <div className={`${paddingCardSm} ${cardDefault}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-semibold text-sm text-[color:var(--text-primary)]">
            {formatFrameId(result.frameId)}
          </span>
          <span className={captionMuted}>
            {result.sampleCount} samples
          </span>
          {result.isBurstFrame && (
            <span className="px-1.5 py-0.5 text-[10px] bg-cyan-100/50 text-[color:var(--text-cyan)] rounded">
              Burst
            </span>
          )}
          {result.isMuxFrame && (
            <span className="px-1.5 py-0.5 text-[10px] bg-orange-100/50 text-[color:var(--text-orange)] rounded flex items-center gap-0.5">
              <Layers className={iconXs} />
              Mux
            </span>
          )}
          {result.hasVaryingLength && result.lengthRange && (
            <span
              className="px-1.5 py-0.5 text-[10px] bg-[var(--status-warning-bg)] text-[color:var(--text-yellow)] rounded flex items-center gap-0.5"
              title={`Frame length varies from ${result.lengthRange.min} to ${result.lengthRange.max} bytes`}
            >
              <Ruler className={iconXs} />
              {result.lengthRange.min}–{result.lengthRange.max} bytes
            </span>
          )}
          {result.isIdentical && (
            <span
              className="px-1.5 py-0.5 text-[10px] bg-[var(--hover-bg)] text-[color:var(--text-secondary)] rounded flex items-center gap-0.5"
              title="All payloads in this frame are identical"
            >
              <Copy className={iconXs} />
              Identical
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {counts.staticCount > 0 && (
            <span className="flex items-center gap-1 text-[color:var(--text-muted)]">
              <Minus className={iconXs} />
              {counts.staticCount} static
            </span>
          )}
          {(counts.counterCount > 0 || counts.counter16Count > 0 || counts.counter32Count > 0) && (
            <span className="flex items-center gap-1 text-[color:var(--text-green)]">
              <RefreshCw className={iconXs} />
              {counts.counterCount + counts.counter16Count + counts.counter32Count} counter
            </span>
          )}
          {(counts.sensorCount > 0 || counts.sensor16Count > 0) && (
            <span className="flex items-center gap-1 text-[color:var(--text-purple)]">
              <Thermometer className={iconXs} />
              {counts.sensorCount + counts.sensor16Count} sensor
            </span>
          )}
          {counts.valueCount > 0 && (
            <span className="flex items-center gap-1 text-[color:var(--status-info-text)]">
              <Activity className={iconXs} />
              {counts.valueCount} value
            </span>
          )}
          {counts.textCount > 0 && (
            <span className="flex items-center gap-1 text-[color:var(--text-amber)]">
              <Type className={iconXs} />
              {counts.textCount} text
            </span>
          )}
        </div>
      </div>

      {/* Mux info line */}
      {result.isMuxFrame && result.muxInfo && (
        <div className="mb-3 text-[10px] text-[color:var(--text-orange)]">
          <span className="font-medium">Mux:</span>{" "}
          {result.muxInfo.isTwoByte ? "byte[0:1]" : `byte[${result.muxInfo.selectorByte}]`}
          , cases: {result.muxInfo.selectorValues.map(v => formatMuxValue(v, result.muxInfo!.isTwoByte)).join(", ")}
        </div>
      )}

      {/* Per-case analysis for mux frames */}
      {result.isMuxFrame && result.muxCaseAnalyses && result.muxCaseAnalyses.length > 0 ? (
        <div className="space-y-2">
          {result.muxCaseAnalyses.map((caseAnalysis) => (
            <MuxCaseSection
              key={caseAnalysis.muxValue}
              caseAnalysis={caseAnalysis}
              isTwoByte={result.muxInfo?.isTwoByte ?? false}
              analyzedFromByte={result.analyzedFromByte}
              analyzedToByteExclusive={result.analyzedToByteExclusive}
            />
          ))}
        </div>
      ) : (
        <>
          {/* Byte visualization (non-mux frames) - with multi-byte patterns inline */}
          <div className="mb-3">
            <div className="text-[10px] text-[color:var(--text-muted)] mb-1">
              Bytes {result.analyzedFromByte}–{result.analyzedToByteExclusive - 1}
            </div>
            <ByteVisualization
              byteStats={result.byteStats}
              multiBytePatterns={result.multiBytePatterns}
            />
          </div>

          {/* Notes */}
          {result.notes.length > 0 && (
            <div className="border-t border-[color:var(--border-default)] pt-2">
              <div className="text-[10px] font-medium text-[color:var(--text-muted)] mb-1">
                Notes
              </div>
              <ul className="space-y-0.5">
                {result.notes.map((note, idx) => (
                  <li key={idx} className="text-[10px] text-[color:var(--text-secondary)]">
                    • {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
// Mux Case Section (expandable per-case analysis)
// ============================================================================

type MuxCaseSectionProps = {
  caseAnalysis: MuxCaseAnalysis;
  isTwoByte: boolean;
  analyzedFromByte: number;
  analyzedToByteExclusive: number;
};

function MuxCaseSection({ caseAnalysis, isTwoByte, analyzedFromByte, analyzedToByteExclusive }: MuxCaseSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const counts = countByteRoles(caseAnalysis.byteStats, caseAnalysis.multiBytePatterns);

  return (
    <div className={`${bgSurface} rounded border border-[color:var(--border-default)]`}>
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-[var(--hover-bg)] transition-colors"
      >
        <div className={flexRowGap2}>
          {isExpanded ? (
            <ChevronDown className={`${iconXs} text-slate-400`} />
          ) : (
            <ChevronRight className={`${iconXs} text-slate-400`} />
          )}
          <span className="text-[10px] font-medium text-[color:var(--text-orange)]">
            Case {formatMuxValue(caseAnalysis.muxValue, isTwoByte)}
          </span>
          <span className="text-[10px] text-[color:var(--text-muted)]">
            ({caseAnalysis.sampleCount} samples)
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {counts.staticCount > 0 && (
            <span className="text-[color:var(--text-muted)]">{counts.staticCount} static</span>
          )}
          {(counts.counterCount > 0 || counts.counter16Count > 0 || counts.counter32Count > 0) && (
            <span className="text-[color:var(--text-green)]">{counts.counterCount + counts.counter16Count + counts.counter32Count} counter</span>
          )}
          {(counts.sensorCount > 0 || counts.sensor16Count > 0) && (
            <span className="text-[color:var(--text-purple)]">{counts.sensorCount + counts.sensor16Count} sensor</span>
          )}
          {counts.valueCount > 0 && (
            <span className="text-[color:var(--status-info-text)]">{counts.valueCount} value</span>
          )}
          {counts.textCount > 0 && (
            <span className="text-[color:var(--text-amber)]">{counts.textCount} text</span>
          )}
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-2 pb-2 pt-1 border-t border-[color:var(--border-default)]">
          {/* Byte visualization */}
          <div className="mb-2">
            <div className="text-[10px] text-[color:var(--text-muted)] mb-1">
              Bytes {analyzedFromByte}–{analyzedToByteExclusive - 1}
            </div>
            <ByteVisualization
              byteStats={caseAnalysis.byteStats}
              multiBytePatterns={caseAnalysis.multiBytePatterns}
            />
          </div>

          {/* Notes */}
          {caseAnalysis.notes.length > 0 && (
            <div className="border-t border-[color:var(--border-default)] pt-1.5 mt-1.5">
              <ul className="space-y-0.5">
                {caseAnalysis.notes.map((note, idx) => (
                  <li key={idx} className="text-[10px] text-[color:var(--text-secondary)]">
                    • {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Byte Chip
// ============================================================================

type ByteChipProps = {
  byte: ByteStats;
};

function ByteChip({ byte }: ByteChipProps) {
  let bgClass = "bg-[var(--hover-bg)]";
  let textClass = "text-[color:var(--text-secondary)]";
  let title = `byte[${byte.byteIndex}]: unknown`;

  if (byte.role === 'static') {
    bgClass = "bg-[var(--border-default)]";
    textClass = "text-[color:var(--text-primary)]";
    title = `byte[${byte.byteIndex}]: static = 0x${byte.staticValue!.toString(16).toUpperCase().padStart(2, '0')}`;
  } else if (byte.role === 'counter') {
    bgClass = "bg-[var(--status-success-bg)]";
    textClass = "text-[color:var(--status-success-text)]";
    const dir = byte.counterDirection === 'up' ? '↑' : '↓';
    if (byte.isLoopingCounter && byte.loopingRange && byte.loopingModulo) {
      title = `byte[${byte.byteIndex}]: looping counter ${dir} step=${byte.counterStep}, range ${byte.loopingRange.min}–${byte.loopingRange.max} (mod ${byte.loopingModulo})`;
    } else {
      const rollover = byte.rolloverDetected ? ' (rollover)' : '';
      title = `byte[${byte.byteIndex}]: counter ${dir} step=${byte.counterStep}${rollover}`;
    }
  } else if (byte.role === 'sensor') {
    bgClass = "bg-orange-100/50";
    textClass = "text-[color:var(--text-orange)]";
    const trend = byte.sensorTrend === 'increasing' ? '↑' : byte.sensorTrend === 'decreasing' ? '↓' : '↕';
    const strength = byte.trendStrength ? ` (${Math.round(byte.trendStrength * 100)}% trend)` : '';
    title = `byte[${byte.byteIndex}]: sensor ${trend} range ${byte.min}–${byte.max}${strength}`;
  } else if (byte.role === 'value') {
    bgClass = "bg-[var(--status-info-bg)]";
    textClass = "text-[color:var(--status-info-text)]";
    title = `byte[${byte.byteIndex}]: value range ${byte.min}–${byte.max} (${byte.uniqueValues.size} unique)`;
  }

  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${bgClass} ${textClass}`}
      title={title}
    >
      {byte.byteIndex}
      {byte.role === 'static' && (
        <span className="ml-0.5 opacity-60">
          ={byte.staticValue!.toString(16).toUpperCase().padStart(2, '0')}
        </span>
      )}
      {byte.role === 'counter' && (
        <span className="ml-0.5">
          {byte.counterDirection === 'up' ? '↑' : '↓'}
          {byte.isLoopingCounter && byte.loopingModulo ? (
            <span className="opacity-70 text-[8px]">%{byte.loopingModulo}</span>
          ) : (
            byte.rolloverDetected && '↻'
          )}
        </span>
      )}
      {byte.role === 'sensor' && (
        <span className="ml-0.5">
          {byte.sensorTrend === 'increasing' ? '↑' : byte.sensorTrend === 'decreasing' ? '↓' : '↕'}
          {byte.rolloverDetected && '↻'}
        </span>
      )}
      {byte.role === 'value' && (
        <span className="ml-0.5 opacity-60">~</span>
      )}
    </span>
  );
}

// ============================================================================
// Multi-byte Pattern Chip
// ============================================================================

type MultiByteChipProps = {
  pattern: MultiBytePattern;
};

function MultiByteChip({ pattern }: MultiByteChipProps) {
  let bgClass = "bg-[var(--status-purple-bg)]";
  let textClass = "text-[color:var(--text-purple)]";
  let label = '';
  let icon = '';
  let displayText = '';

  if (pattern.pattern === 'sensor16') {
    bgClass = "bg-[var(--status-purple-bg)]";
    textClass = "text-[color:var(--text-purple)]";
    label = 'sensor16';
    icon = '⚡';
  } else if (pattern.pattern === 'counter16') {
    bgClass = "bg-[var(--status-success-bg)]";
    textClass = "text-[color:var(--status-success-text)]";
    label = 'counter16';
    icon = '↻';
  } else if (pattern.pattern === 'counter32') {
    bgClass = "bg-[var(--status-success-bg)]";
    textClass = "text-[color:var(--status-success-text)]";
    label = 'counter32';
    icon = '↻';
  } else if (pattern.pattern === 'text') {
    bgClass = "bg-[var(--status-warning-bg)]";
    textClass = "text-[color:var(--text-amber)]";
    label = 'text';
    icon = 'Aa';
    displayText = pattern.sampleText ? ` "${pattern.sampleText}"` : '';
  } else {
    label = pattern.pattern;
  }

  const endianChar = pattern.endianness === 'little' ? 'LE' : pattern.endianness === 'big' ? 'BE' : '';
  const rangeStr = (pattern.minValue !== undefined && pattern.maxValue !== undefined)
    ? ` ${pattern.minValue}–${pattern.maxValue}`
    : '';
  const textSample = pattern.sampleText ? ` "${pattern.sampleText}"` : '';
  const title = `${label} @ byte[${pattern.startByte}:${pattern.startByte + pattern.length - 1}]${endianChar ? ` ${endianChar}` : ''}${rangeStr}${textSample}${pattern.correlatedRollover ? ' (rollover correlation)' : ''}`;

  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${bgClass} ${textClass}`}
      title={title}
    >
      {pattern.startByte}–{pattern.startByte + pattern.length - 1}
      <span className="ml-0.5">{icon}</span>
      {endianChar && <span className="ml-0.5 opacity-60 text-[8px]">{endianChar}</span>}
      {displayText && <span className="ml-1 opacity-80">{displayText}</span>}
    </span>
  );
}

// ============================================================================
// Byte Visualization (combines single bytes and multi-byte patterns)
// ============================================================================

type ByteVisualizationProps = {
  byteStats: ByteStats[];
  multiBytePatterns: MultiBytePattern[];
};

function ByteVisualization({ byteStats, multiBytePatterns }: ByteVisualizationProps) {
  // Build a map of byte index -> pattern for quick lookup
  const patternByStartByte = new Map<number, MultiBytePattern>();
  const bytesInPatterns = new Set<number>();

  for (const pattern of multiBytePatterns) {
    patternByStartByte.set(pattern.startByte, pattern);
    for (let i = pattern.startByte; i < pattern.startByte + pattern.length; i++) {
      bytesInPatterns.add(i);
    }
  }

  // Build visualization elements in byte order
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < byteStats.length) {
    const byte = byteStats[i];
    const pattern = patternByStartByte.get(byte.byteIndex);

    if (pattern) {
      // Render multi-byte pattern chip
      elements.push(
        <MultiByteChip key={`pattern-${pattern.startByte}`} pattern={pattern} />
      );
      // Skip the bytes covered by this pattern
      i += pattern.length;
    } else if (bytesInPatterns.has(byte.byteIndex)) {
      // This byte is part of a pattern but not the start - skip it
      i++;
    } else {
      // Render single byte chip
      elements.push(
        <ByteChip key={`byte-${byte.byteIndex}`} byte={byte} />
      );
      i++;
    }
  }

  return (
    <div className="flex flex-wrap gap-1">
      {elements}
    </div>
  );
}
