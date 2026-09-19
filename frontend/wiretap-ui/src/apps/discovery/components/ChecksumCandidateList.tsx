// ui/src/apps/discovery/components/ChecksumCandidateList.tsx
//
// Ranked checksum candidates, rendered the same way in both places they appear —
// the Serial Payload result tab and the Configure Checksum dialog. They used to
// disagree: the tab showed cards with match rates and ranges, the dialog showed
// algorithm-name chips, which cannot express the other four fields a candidate
// actually has (position, length, endianness, calculation range).

import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { ChecksumCandidate } from "../../../api/checksums";
import { getAlgorithmInfo } from "../../../utils/analysis/checksums";
import { flexRowGap2, iconXs } from "../../../styles/spacing";
import { textMedium } from "../../../styles/typography";
import { MatchRateIcon, matchRateTextClass, matchRateTone } from "./checksumTone";
import { Button } from "../../../components/Button";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";
interface ChecksumCandidateListProps {
  candidates: ChecksumCandidate[];
  /** Index of the candidate currently in force, if any. */
  appliedIndex: number | null;
  onApply: (candidate: ChecksumCandidate, index: number) => void;
  /** Omit to make Apply one-way (the dialog); supply to allow un-applying (the tool tab). */
  onUnapply?: () => void;
  /** Collapse the list to the applied candidate only. */
  collapseWhenApplied?: boolean;
}

export default function ChecksumCandidateList({
  candidates,
  appliedIndex,
  onApply,
  onUnapply,
  collapseWhenApplied = false,
}: ChecksumCandidateListProps) {
  const { t } = useTranslation("discovery");

  if (candidates.length === 0) return null;

  const visible = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ index }) => !collapseWhenApplied || appliedIndex === null || appliedIndex === index);

  return (
    <div className="space-y-2">
      {visible.map(({ candidate, index }) => {
        const isApplied = appliedIndex === index;
        const algorithmName = getAlgorithmInfo(candidate.algorithm)?.name ?? candidate.algorithm;

        return (
          <Card key={index} tone={matchRateTone(candidate.matchRate, isApplied)}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className={`${flexRowGap2} flex-wrap`}>
                  <span className={`${textMedium} font-mono`}>{algorithmName}</span>
                  {/* Endianness only means something for a multi-byte checksum. */}
                  {candidate.length > 1 && (
                    <Badge mono>
                      {candidate.bigEndian
                        ? t("serial.bigEndianShort")
                        : t("serial.littleEndianShort")}
                    </Badge>
                  )}
                  <span className="text-sm text-[color:var(--text-secondary)]">
                    {t("serialAnalysis.atByte", { position: candidate.position })}
                    {candidate.length > 1
                      ? t("serialAnalysis.ofLength", { count: candidate.length })
                      : ""}
                  </span>
                  {index === 0 && !isApplied && candidate.confidence >= 70 && (
                    <Badge tone="success">{t("serialAnalysis.bestMatch")}</Badge>
                  )}
                  {isApplied && (
                    <Badge tone="primary">
                      <Check className={iconXs} />
                      {t("serialAnalysis.applied")}
                    </Badge>
                  )}
                </div>

                <div className="text-sm text-[color:var(--text-secondary)] mt-1">
                  <span className={matchRateTextClass(candidate.matchRate)}>
                    {t("serialAnalysis.matchPercent", { percent: candidate.matchRate.toFixed(1) })}
                  </span>
                  <span className="mx-2 text-[color:var(--text-muted)]">|</span>
                  {t("serialAnalysis.matchedFrames", {
                    matched: candidate.matchCount.toLocaleString(),
                    total: candidate.totalCount.toLocaleString(),
                  })}
                  <span className="mx-2 text-[color:var(--text-muted)]">|</span>
                  {t("serialAnalysis.confidencePercent", { percent: candidate.confidence })}
                </div>

                <div className="text-xs text-[color:var(--text-muted)] mt-1">
                  {t("serialAnalysis.calcRange", {
                    start: candidate.calcStartByte,
                    end: candidate.calcEndByte,
                  })}
                  {candidate.equivalentRanges.length > 0 && (
                    <>
                      {" "}
                      {t("serial.checksumEquivalentRanges", {
                        ranges: candidate.equivalentRanges
                          .map((r) => `[${r.calcStartByte}:${r.calcEndByte}]`)
                          .join(", "),
                      })}
                    </>
                  )}
                </div>

                {candidate.notes.length > 0 && (
                  <div className="text-xs text-[color:var(--text-muted)] mt-1">
                    {candidate.notes
                      .slice(0, 3)
                      .map((note) => t(`serial.checksumNote.${note.code}`, note.values))
                      .join(" • ")}
                  </div>
                )}
              </div>

              <div className="flex-shrink-0 flex items-center gap-2">
                <Button
                  onClick={() => (isApplied && onUnapply ? onUnapply() : onApply(candidate, index))}
                  size="sm"
                  pressed={isApplied}
                >
                  {isApplied ? t("serialAnalysis.appliedButton") : t("serialAnalysis.applyButton")}
                </Button>
                <MatchRateIcon matchRate={candidate.matchRate} isApplied={isApplied} />
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
