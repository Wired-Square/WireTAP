// ui/src/apps/discovery/views/tools/ChecksumDiscoveryResultView.tsx

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, ChevronDown, ChevronRight, Copy, Check, X } from "lucide-react";
import { iconXs, iconMd, iconSm, flexRowGap2, paddingCardSm } from "../../../../styles/spacing";
import { iconButtonDangerCompact } from "../../../../styles/buttonStyles";
import { cardDefault } from "../../../../styles/cardStyles";
import { caption, emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../../styles/typography";
import { borderDivider, hoverLight, bgSurface, textPrimary, textSecondary, textMuted } from "../../../../styles";
import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import { useSettings, getDisplayFrameIdFormat } from "../../../../hooks/useSettings";
import { formatFrameId } from "../../../../utils/frameIds";
import { COPY_FEEDBACK_TIMEOUT_MS } from "../../../../constants";
import type { ChecksumCandidate } from "../../../../utils/analysis/checksumDiscovery";

type Props = {
  embedded?: boolean;
  onClose?: () => void;
};

export default function ChecksumDiscoveryResultView({ embedded = false, onClose }: Props) {
  const { t } = useTranslation("discovery");
  const results = useDiscoveryStore((s) => s.toolbox.checksumDiscoveryResults);
  const { settings } = useSettings();

  if (!results) {
    return (
      <div className={`h-full flex flex-col ${embedded ? "" : `${bgSurface} rounded-lg border border-[color:var(--border-default)]`}`}>
        {!embedded && <Header onClose={onClose} />}
        <div className={emptyStateContainer}>
          <ShieldCheck className={`w-12 h-12 ${textMuted} mb-4`} />
          <div className={emptyStateText}>
            <p className={emptyStateHeading}>{t("checksumDiscovery.noResults")}</p>
            <p className={emptyStateDescription}>
              {t("checksumDiscovery.noResultsDescription")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const { candidatesByFrameId, summary } = results;
  const frameIds = Array.from(candidatesByFrameId.keys()).sort((a, b) => a - b);

  return (
    <div className={`h-full flex flex-col ${embedded ? "" : `${bgSurface} rounded-lg border border-[color:var(--border-default)]`}`}>
      {!embedded && <Header onClose={onClose} />}

      {/* Stats Summary */}
      <div className={`px-4 py-2 ${borderDivider} bg-[var(--bg-surface)]`}>
        <div className="flex flex-wrap gap-4 text-xs">
          <span className={textMuted}>
            <span className={`font-medium ${textPrimary}`}>{results.frameCount.toLocaleString()}</span> {t("checksumDiscovery.framesUnit")}
          </span>
          <span className={textMuted}>
            <span className={`font-medium ${textPrimary}`}>{results.uniqueFrameIds}</span> {t("checksumDiscovery.uniqueIdsUnit")}
          </span>
          <span className={textMuted}>
            <span className="font-medium text-green-400">{summary.framesWithChecksum}</span> {t("checksumDiscovery.withChecksum")}
          </span>
          <span className={textMuted}>
            <span className="font-medium text-amber-400">{summary.framesWithoutChecksum}</span> {t("checksumDiscovery.unknown")}
          </span>
          {summary.mostCommonType && (
            <span className={textMuted}>
              {t("checksumDiscovery.mostCommon")} <span className={`font-medium ${textPrimary}`}>{summary.mostCommonType}</span>
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto space-y-4">
        {frameIds.length === 0 ? (
          <div className="text-center py-8">
            <p className={`text-sm ${textSecondary}`}>{t("checksumDiscovery.noChecksumsTitle")}</p>
            <p className={`text-xs ${textMuted} mt-1`}>
              {t("checksumDiscovery.noChecksumsHint")}
            </p>
          </div>
        ) : (
          frameIds.map((frameId) => {
            const candidates = candidatesByFrameId.get(frameId)!;
            return (
              <FrameCard
                key={frameId}
                frameId={frameId}
                candidates={candidates}
                frameIdFormat={getDisplayFrameIdFormat(settings)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function Header({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation("discovery");
  return (
    <div className={`px-4 py-2 ${borderDivider} flex items-center justify-between`}>
      <div className={flexRowGap2}>
        <ShieldCheck className={`${iconMd} text-green-400`} />
        <span className={`font-medium ${textPrimary}`}>{t("checksumDiscovery.title")}</span>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className={iconButtonDangerCompact}
          title={t("checksumDiscovery.close")}
        >
          <X className={iconXs} />
        </button>
      )}
    </div>
  );
}

function FrameCard({
  frameId,
  candidates,
  frameIdFormat,
}: {
  frameId: number;
  candidates: ChecksumCandidate[];
  frameIdFormat: "hex" | "decimal";
}) {
  const { t } = useTranslation("discovery");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const bestCandidate = candidates[0];

  const handleCopy = () => {
    const info = formatCandidateForCopy(bestCandidate);
    navigator.clipboard.writeText(info);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
  };

  return (
    <div className={cardDefault}>
      <div
        className={`${paddingCardSm} cursor-pointer ${hoverLight}`}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between">
          <div className={flexRowGap2}>
            {expanded ? (
              <ChevronDown className={`${iconSm} ${textMuted}`} />
            ) : (
              <ChevronRight className={`${iconSm} ${textMuted}`} />
            )}
            <span className={`font-mono font-medium ${textPrimary}`}>
              {formatFrameId(frameId, frameIdFormat)}
            </span>
            <span className={`${caption} ${textMuted}`}>
              {t("checksumDiscovery.samples", { count: bestCandidate.totalCount })}
            </span>
          </div>

          <div className={flexRowGap2}>
            <CandidateBadge candidate={bestCandidate} />
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCopy();
              }}
              className={`p-1 rounded ${hoverLight}`}
              title={t("checksumDiscovery.copyTooltip")}
            >
              {copied ? (
                <Check className={`${iconSm} text-green-400`} />
              ) : (
                <Copy className={`${iconSm} ${textMuted}`} />
              )}
            </button>
          </div>
        </div>

        {/* Quick summary when collapsed */}
        {!expanded && (
          <div className={`mt-1 text-xs ${textMuted}`}>
            {formatCandidateSummary(bestCandidate)}
          </div>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className={`px-4 pb-3 pt-1 border-t ${borderDivider}`}>
          {candidates.map((candidate, idx) => (
            <CandidateDetails key={idx} candidate={candidate} isFirst={idx === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function CandidateBadge({ candidate }: { candidate: ChecksumCandidate }) {
  const matchPercent = Math.round(candidate.matchRate);
  const bgColour =
    matchPercent >= 99 ? "bg-green-600" : matchPercent >= 95 ? "bg-green-700" : "bg-amber-600";

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium text-white ${bgColour}`}>
      {candidate.algorithmName || candidate.type.toUpperCase()} {matchPercent}%
    </span>
  );
}

function CandidateDetails({ candidate, isFirst }: { candidate: ChecksumCandidate; isFirst: boolean }) {
  const { t } = useTranslation("discovery");
  return (
    <div className={`py-2 ${isFirst ? "" : `border-t ${borderDivider} mt-2`}`}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className={textMuted}>{t("checksumDiscovery.type")}</span>{" "}
          <span className={textPrimary}>{candidate.algorithmName || candidate.type.toUpperCase()}</span>
        </div>
        <div>
          <span className={textMuted}>{t("checksumDiscovery.match")}</span>{" "}
          <span className={textPrimary}>
            {t("checksumDiscovery.matchValue", { matched: candidate.matchCount, total: candidate.totalCount, percent: Math.round(candidate.matchRate) })}
          </span>
        </div>
        <div>
          <span className={textMuted}>{t("checksumDiscovery.position")}</span>{" "}
          <span className={`font-mono ${textPrimary}`}>
            {t("checksumDiscovery.positionValue", { pos: candidate.position, count: candidate.length })}
          </span>
        </div>
        <div>
          <span className={textMuted}>{t("checksumDiscovery.endianness")}</span>{" "}
          <span className={textPrimary}>{candidate.endianness}</span>
        </div>
        {candidate.polynomial !== undefined && (
          <div>
            <span className={textMuted}>{t("checksumDiscovery.polynomial")}</span>{" "}
            <span className={`font-mono ${textPrimary}`}>
              0x{candidate.polynomial.toString(16).toUpperCase().padStart(candidate.length === 1 ? 2 : 4, "0")}
            </span>
          </div>
        )}
        {candidate.init !== undefined && (
          <div>
            <span className={textMuted}>{t("checksumDiscovery.init")}</span>{" "}
            <span className={`font-mono ${textPrimary}`}>
              0x{candidate.init.toString(16).toUpperCase().padStart(candidate.length === 1 ? 2 : 4, "0")}
            </span>
          </div>
        )}
        {candidate.xorOut !== undefined && (
          <div>
            <span className={textMuted}>{t("checksumDiscovery.xorOut")}</span>{" "}
            <span className={`font-mono ${textPrimary}`}>
              0x{candidate.xorOut.toString(16).toUpperCase().padStart(candidate.length === 1 ? 2 : 4, "0")}
            </span>
          </div>
        )}
        {candidate.reflect !== undefined && (
          <div>
            <span className={textMuted}>{t("checksumDiscovery.reflected")}</span>{" "}
            <span className={textPrimary}>{candidate.reflect ? t("checksumDiscovery.yes") : t("checksumDiscovery.no")}</span>
          </div>
        )}
        <div>
          <span className={textMuted}>{t("checksumDiscovery.frameIdIncluded")}</span>{" "}
          <span className={textPrimary}>{candidate.includesFrameId ? t("checksumDiscovery.yes") : t("checksumDiscovery.no")}</span>
        </div>
        <div>
          <span className={textMuted}>{t("checksumDiscovery.dataRange")}</span>{" "}
          <span className={`font-mono ${textPrimary}`}>
            {t("checksumDiscovery.dataRangeValue", { start: candidate.dataRange.start, end: candidate.dataRange.end })}
          </span>
        </div>
      </div>
    </div>
  );
}

function formatCandidateSummary(candidate: ChecksumCandidate): string {
  const parts: string[] = [];

  if (candidate.polynomial !== undefined) {
    parts.push(`poly=0x${candidate.polynomial.toString(16).toUpperCase()}`);
  }
  if (candidate.init !== undefined && candidate.init !== 0) {
    parts.push(`init=0x${candidate.init.toString(16).toUpperCase()}`);
  }
  if (candidate.xorOut !== undefined && candidate.xorOut !== 0) {
    parts.push(`xor=0x${candidate.xorOut.toString(16).toUpperCase()}`);
  }
  if (candidate.reflect) {
    parts.push("reflected");
  }
  if (candidate.includesFrameId) {
    parts.push("includes frame ID");
  }

  parts.push(`pos=${candidate.position}`);

  return parts.join(", ");
}

function formatCandidateForCopy(candidate: ChecksumCandidate): string {
  const lines: string[] = [
    `Frame ID: 0x${candidate.frameId.toString(16).toUpperCase()}`,
    `Type: ${candidate.algorithmName || candidate.type.toUpperCase()}`,
    `Position: byte ${candidate.position} (${candidate.length} byte${candidate.length > 1 ? "s" : ""})`,
    `Match Rate: ${Math.round(candidate.matchRate)}% (${candidate.matchCount}/${candidate.totalCount})`,
  ];

  if (candidate.polynomial !== undefined) {
    lines.push(`Polynomial: 0x${candidate.polynomial.toString(16).toUpperCase()}`);
  }
  if (candidate.init !== undefined) {
    lines.push(`Init: 0x${candidate.init.toString(16).toUpperCase()}`);
  }
  if (candidate.xorOut !== undefined) {
    lines.push(`XOR Out: 0x${candidate.xorOut.toString(16).toUpperCase()}`);
  }
  if (candidate.reflect !== undefined) {
    lines.push(`Reflected: ${candidate.reflect ? "Yes" : "No"}`);
  }
  lines.push(`Frame ID Included: ${candidate.includesFrameId ? "Yes" : "No"}`);
  lines.push(`Endianness: ${candidate.endianness}`);

  return lines.join("\n");
}
