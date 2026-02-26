// ui/src/apps/discovery/views/tools/ChecksumDiscoveryResultView.tsx

import { useState } from "react";
import { ShieldCheck, ChevronDown, ChevronRight, Copy, Check, X } from "lucide-react";
import { iconXs, iconMd, iconSm, flexRowGap2, paddingCardSm } from "../../../../styles/spacing";
import { iconButtonDangerCompact } from "../../../../styles/buttonStyles";
import { cardDefault } from "../../../../styles/cardStyles";
import { caption } from "../../../../styles/typography";
import { borderDivider, hoverLight, bgSurface, textPrimary, textSecondary, textMuted } from "../../../../styles";
import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import { useSettings, getDisplayFrameIdFormat } from "../../../../hooks/useSettings";
import { formatFrameId } from "../../../../utils/frameIds";
import type { ChecksumCandidate } from "../../../../utils/analysis/checksumDiscovery";

type Props = {
  embedded?: boolean;
  onClose?: () => void;
};

export default function ChecksumDiscoveryResultView({ embedded = false, onClose }: Props) {
  const results = useDiscoveryStore((s) => s.toolbox.checksumDiscoveryResults);
  const { settings } = useSettings();

  if (!results) {
    return (
      <div className={`h-full flex flex-col ${embedded ? "" : `${bgSurface} rounded-lg border border-[color:var(--border-default)]`}`}>
        {!embedded && <Header onClose={onClose} />}
        <div className="flex-1 flex flex-col items-center justify-center text-center p-4">
          <ShieldCheck className="w-12 h-12 text-[color:var(--text-muted)] mb-4" />
          <p className={`text-sm ${textSecondary} mb-2`}>
            No results yet
          </p>
          <p className={`text-xs ${textMuted}`}>
            Select frames and click "Run Analysis" to detect checksum patterns.
          </p>
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
            <span className={`font-medium ${textPrimary}`}>{results.frameCount.toLocaleString()}</span> frames
          </span>
          <span className={textMuted}>
            <span className={`font-medium ${textPrimary}`}>{results.uniqueFrameIds}</span> unique IDs
          </span>
          <span className={textMuted}>
            <span className="font-medium text-green-400">{summary.framesWithChecksum}</span> with checksum
          </span>
          <span className={textMuted}>
            <span className="font-medium text-amber-400">{summary.framesWithoutChecksum}</span> unknown
          </span>
          {summary.mostCommonType && (
            <span className={textMuted}>
              Most common: <span className={`font-medium ${textPrimary}`}>{summary.mostCommonType}</span>
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto space-y-4">
        {frameIds.length === 0 ? (
          <div className="text-center py-8">
            <p className={`text-sm ${textSecondary}`}>No checksums detected</p>
            <p className={`text-xs ${textMuted} mt-1`}>
              Try adjusting the match threshold or enable CRC-16 brute-force.
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
  return (
    <div className={`px-4 py-2 ${borderDivider} flex items-center justify-between`}>
      <div className={flexRowGap2}>
        <ShieldCheck className={`${iconMd} text-green-400`} />
        <span className={`font-medium ${textPrimary}`}>Checksum Discovery</span>
      </div>
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

function FrameCard({
  frameId,
  candidates,
  frameIdFormat,
}: {
  frameId: number;
  candidates: ChecksumCandidate[];
  frameIdFormat: "hex" | "decimal";
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const bestCandidate = candidates[0];

  const handleCopy = () => {
    const info = formatCandidateForCopy(bestCandidate);
    navigator.clipboard.writeText(info);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
              {bestCandidate.totalCount} samples
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
              title="Copy checksum info"
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
  return (
    <div className={`py-2 ${isFirst ? "" : `border-t ${borderDivider} mt-2`}`}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div>
          <span className={textMuted}>Type:</span>{" "}
          <span className={textPrimary}>{candidate.algorithmName || candidate.type.toUpperCase()}</span>
        </div>
        <div>
          <span className={textMuted}>Match:</span>{" "}
          <span className={textPrimary}>
            {candidate.matchCount}/{candidate.totalCount} ({Math.round(candidate.matchRate)}%)
          </span>
        </div>
        <div>
          <span className={textMuted}>Position:</span>{" "}
          <span className={`font-mono ${textPrimary}`}>
            byte {candidate.position} ({candidate.length} byte{candidate.length > 1 ? "s" : ""})
          </span>
        </div>
        <div>
          <span className={textMuted}>Endianness:</span>{" "}
          <span className={textPrimary}>{candidate.endianness}</span>
        </div>
        {candidate.polynomial !== undefined && (
          <div>
            <span className={textMuted}>Polynomial:</span>{" "}
            <span className={`font-mono ${textPrimary}`}>
              0x{candidate.polynomial.toString(16).toUpperCase().padStart(candidate.length === 1 ? 2 : 4, "0")}
            </span>
          </div>
        )}
        {candidate.init !== undefined && (
          <div>
            <span className={textMuted}>Init:</span>{" "}
            <span className={`font-mono ${textPrimary}`}>
              0x{candidate.init.toString(16).toUpperCase().padStart(candidate.length === 1 ? 2 : 4, "0")}
            </span>
          </div>
        )}
        {candidate.xorOut !== undefined && (
          <div>
            <span className={textMuted}>XOR Out:</span>{" "}
            <span className={`font-mono ${textPrimary}`}>
              0x{candidate.xorOut.toString(16).toUpperCase().padStart(candidate.length === 1 ? 2 : 4, "0")}
            </span>
          </div>
        )}
        {candidate.reflect !== undefined && (
          <div>
            <span className={textMuted}>Reflected:</span>{" "}
            <span className={textPrimary}>{candidate.reflect ? "Yes" : "No"}</span>
          </div>
        )}
        <div>
          <span className={textMuted}>Frame ID included:</span>{" "}
          <span className={textPrimary}>{candidate.includesFrameId ? "Yes" : "No"}</span>
        </div>
        <div>
          <span className={textMuted}>Data range:</span>{" "}
          <span className={`font-mono ${textPrimary}`}>
            bytes [{candidate.dataRange.start}, {candidate.dataRange.end})
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
