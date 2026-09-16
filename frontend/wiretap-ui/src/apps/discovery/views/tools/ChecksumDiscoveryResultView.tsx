// ui/src/apps/discovery/views/tools/ChecksumDiscoveryResultView.tsx
//
// Results of a checksum scan, one card per frame id — including the ids where
// nothing was found, because "no checksum here" is a finding and an id that
// silently vanishes from the list is not.

import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, ChevronDown, ChevronRight, Copy, Check, X } from "lucide-react";
import { iconXs, iconMd, iconSm, flexRowGap2 } from "../../../../styles/spacing";
import { iconButtonDangerCompact } from "../../../../styles/buttonStyles";
import { cardBase, cardDefault } from "../../../../styles/cardStyles";
import { badgeSmallNeutral, badgeSmallSuccess } from "../../../../styles/badgeStyles";
import {
  emptyStateContainer,
  emptyStateText,
  emptyStateHeading,
  emptyStateDescription,
} from "../../../../styles/typography";
import {
  bgSurface,
  borderDivider,
  textDataAmber,
  textDataGreen,
  textMuted,
  textPrimary,
  textSecondary,
} from "../../../../styles/colourTokens";
import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import { useFrameIdFormat } from "../../../../hooks/useFrameIdFormat";
import { formatFrameId } from "../../../../utils/frameIds";
import { COPY_FEEDBACK_TIMEOUT_MS } from "../../../../constants";
import { getAlgorithmInfo } from "../../../../utils/analysis/checksums";
import {
  MatchRateIcon,
  formatMatchRate,
  matchRateTextClass,
  matchRateToneClasses,
} from "../../components/checksumTone";
import type {
  ChecksumEvidence,
  ChecksumSpecification,
  DiscoveredChecksum,
  FrameChecksumFinding,
} from "../../../../api/checksums";

type Props = {
  embedded?: boolean;
  onClose?: () => void;
};

const hex = (value: number, digits: number) =>
  `0x${value.toString(16).toUpperCase().padStart(digits, "0")}`;

/**
 * A one-line identity for a configuration.
 *
 * A solved checksum has no name to show, so it is described by what it does —
 * an offset sum reads `Sum + 0xA5`, a recovered polynomial reads
 * `CRC-8 poly 0x4D`.
 */
function describeSpecification(spec: ChecksumSpecification): string {
  switch (spec.kind) {
    case "named":
      return getAlgorithmInfo(spec.algorithm)?.name ?? spec.algorithm;
    case "additive": {
      const offset = hex(spec.offset, 2);
      if (spec.op === "negatedSum") return `${offset} − Sum`;
      const [name, sign] = spec.op === "xor" ? ["XOR", "^"] : ["Sum", "+"];
      return `${name} ${sign} ${offset}`;
    }
    case "crc":
      return `CRC-${spec.width} poly ${hex(spec.polynomial, spec.width / 4)}`;
  }
}

export default function ChecksumDiscoveryResultView({ embedded = false, onClose }: Props) {
  const { t } = useTranslation("discovery");
  const results = useDiscoveryStore((s) => s.toolbox.checksumDiscoveryResults);

  const shell = `h-full flex flex-col ${embedded ? "" : cardDefault}`;

  if (!results) {
    return (
      <div className={shell}>
        {!embedded && <Header onClose={onClose} />}
        <div className={emptyStateContainer}>
          <ShieldCheck className={`w-12 h-12 ${textMuted} mb-4`} />
          <div className={emptyStateText}>
            <p className={emptyStateHeading}>{t("checksumDiscovery.noResults")}</p>
            <p className={emptyStateDescription}>{t("checksumDiscovery.noResultsDescription")}</p>
          </div>
        </div>
      </div>
    );
  }

  const findings = [...results.findings].sort((a, b) => a.frameId - b.frameId);
  const explained = findings.filter((f) => f.candidates.length > 0);
  const unexplained = findings.filter((f) => f.candidates.length === 0);

  return (
    <div className={shell}>
      {!embedded && <Header onClose={onClose} />}

      <div className={`px-4 py-2 ${borderDivider} ${bgSurface}`}>
        <div className="flex flex-wrap gap-4 text-xs">
          <Stat value={results.frameCount.toLocaleString()} label={t("checksumDiscovery.framesUnit")} />
          <Stat value={results.uniqueFrameIds} label={t("checksumDiscovery.uniqueIdsUnit")} />
          <Stat
            value={explained.length}
            label={t("checksumDiscovery.withChecksum")}
            tone={textDataGreen}
          />
          <Stat
            value={unexplained.length}
            label={t("checksumDiscovery.unknown")}
            tone={textDataAmber}
          />
          {results.skippedFrameIds > 0 && (
            <Stat
              value={results.skippedFrameIds}
              label={t("checksumDiscovery.skippedTooFewFrames")}
            />
          )}
        </div>
      </div>

      <div className="flex-1 p-4 overflow-auto space-y-3">
        {explained.map((finding) => (
          <FrameCard key={`${finding.frameId}-${finding.isExtended}`} finding={finding} />
        ))}

        {explained.length === 0 && (
          <div className="text-center py-8">
            <p className={`text-sm ${textSecondary}`}>{t("checksumDiscovery.noChecksumsTitle")}</p>
            <p className={`text-xs ${textMuted} mt-1`}>{t("checksumDiscovery.noChecksumsHint")}</p>
          </div>
        )}

        {/* Why an id came back empty is worth keeping, but 62 rows of it buries
            the answer on a bus that has no checksums at all. */}
        {unexplained.length > 0 && (
          <UnexplainedSection findings={unexplained} />
        )}
      </div>
    </div>
  );
}

function UnexplainedSection({ findings }: { findings: FrameChecksumFinding[] }) {
  const { t } = useTranslation("discovery");
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cardDefault}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left"
      >
        {expanded ? <ChevronDown className={iconSm} /> : <ChevronRight className={iconSm} />}
        <span className={`text-sm ${textSecondary}`}>
          {t("checksumDiscovery.noneFoundCount", { count: findings.length })}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {findings.map((finding) => (
            <FrameCard key={`${finding.frameId}-${finding.isExtended}`} finding={finding} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, tone }: { value: string | number; label: string; tone?: string }) {
  return (
    <span className={textMuted}>
      <span className={`font-medium ${tone ?? textPrimary}`}>{value}</span> {label}
    </span>
  );
}

function Header({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation("discovery");
  return (
    <div className={`px-4 py-2 ${borderDivider} flex items-center justify-between`}>
      <div className={flexRowGap2}>
        <ShieldCheck className={`${iconMd} ${textDataGreen}`} />
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

function FrameCard({ finding }: { finding: FrameChecksumFinding }) {
  const { t } = useTranslation("discovery");
  const { effective: frameIdFormat } = useFrameIdFormat();
  const best = finding.candidates[0];
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const lines = finding.candidates.map(
      (c) =>
        `${describeSpecification(c.specification)} @ ${c.position} [${c.calcStartByte}:${c.calcEndByte}]` +
        ` — ${formatMatchRate(c.matchRate, c.matchCount, t)}` +
        `${c.matchRate === null ? "" : ` (${c.matchCount}/${c.totalCount})`}` +
        `, confidence ${c.confidence}`,
    );
    void navigator.clipboard.writeText(
      `${formatFrameId(finding.frameId, frameIdFormat, finding.isExtended)}\n${lines.join("\n")}`,
    );
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
  };

  return (
    <div
      className={`${cardBase} ${matchRateToneClasses(best ? best.matchRate : 0)}`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {expanded ? <ChevronDown className={iconSm} /> : <ChevronRight className={iconSm} />}
          <span className={`font-mono font-medium ${textPrimary}`}>
            {formatFrameId(finding.frameId, frameIdFormat, finding.isExtended)}
          </span>
          {best ? (
            <>
              <span className={`text-sm ${textSecondary} font-mono truncate`}>
                {describeSpecification(best.specification)}
              </span>
              <span className={`text-xs ${matchRateTextClass(best.matchRate)}`}>
                {formatMatchRate(best.matchRate, best.matchCount, t)}
              </span>
            </>
          ) : (
            <span className={`text-sm ${textMuted}`}>{t("checksumDiscovery.noneFound")}</span>
          )}
          <span className={`text-xs ${textMuted} ml-auto`}>
            {t("checksumDiscovery.distinctOfFrames", {
              distinct: finding.distinctPayloads,
              frames: finding.frameCount,
            })}
          </span>
        </button>
        {best && <MatchRateIcon matchRate={best.matchRate} />}
        {best && (
          <button type="button" onClick={copy} title={t("checksumDiscovery.copyTooltip")}>
            {copied ? (
              <Check className={`${iconSm} ${textDataGreen}`} />
            ) : (
              <Copy className={`${iconSm} ${textMuted}`} />
            )}
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {finding.candidates.map((candidate, index) => (
            <CandidateRow key={index} candidate={candidate} />
          ))}
          {/* Why nothing was found is the useful half of an empty result: not
              "no checksum" but "byte -1 never changes, byte -2 is a counter". */}
          {!best && (
            <>
              <ColumnVerdicts columns={finding.columns} />
              {finding.notes.length > 0 && (
                <p className={`text-xs ${textMuted}`}>
                  {finding.notes
                    .map((n) => t(`serial.checksumNote.${n.code}`, n.values))
                    .join(" • ")}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: DiscoveredChecksum }) {
  const { t } = useTranslation("discovery");
  const spec = candidate.specification;
  const digits = spec.kind === "crc" ? spec.width / 4 : 2;

  return (
    <div className={`${cardDefault} p-2 space-y-1`}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`font-mono text-sm ${textPrimary}`}>{describeSpecification(spec)}</span>
        {spec.kind === "crc" && spec.wellKnown && (
          <span className={badgeSmallSuccess}>{t("checksumDiscovery.wellKnownPolynomial")}</span>
        )}
        {candidate.length > 1 && (
          <span className={`${badgeSmallNeutral} font-mono`}>
            {candidate.bigEndian ? t("serial.bigEndianShort") : t("serial.littleEndianShort")}
          </span>
        )}
        <span className={`text-xs ${textSecondary}`}>
          {t("serialAnalysis.atByte", { position: candidate.position })}
          {candidate.length > 1 ? t("serialAnalysis.ofLength", { count: candidate.length }) : ""}
        </span>
      </div>

      <div className={`text-xs ${textSecondary}`}>
        <span className={matchRateTextClass(candidate.matchRate)}>
          {formatMatchRate(candidate.matchRate, candidate.matchCount, t)}
        </span>
        {/* A solved configuration's counts are the same number twice — it was
            verified against every sample it saw — so the pair only says
            something for a measured rate. */}
        {candidate.matchRate !== null && (
          <>
            <span className={`mx-2 ${textMuted}`}>|</span>
            {t("serialAnalysis.matchedFrames", {
              matched: candidate.matchCount.toLocaleString(),
              total: candidate.totalCount.toLocaleString(),
            })}
          </>
        )}
        <span className={`mx-2 ${textMuted}`}>|</span>
        {t("serialAnalysis.confidencePercent", { percent: candidate.confidence })}
        {/* Samples the solver could not use, because their calculation range was
            a different length. Silence here would overstate the evidence. */}
        {candidate.excludedCount > 0 && (
          <>
            <span className={`mx-2 ${textMuted}`}>|</span>
            <span className={textMuted}>
              {t("checksumDiscovery.excludedSamples", { count: candidate.excludedCount })}
            </span>
          </>
        )}
      </div>

      <div className={`text-xs ${textMuted}`}>
        {t("serialAnalysis.calcRange", {
          start: candidate.calcStartByte,
          end: candidate.calcEndByte,
        })}
        {candidate.equivalentRanges.length > 0 &&
          ` ${t("serial.checksumEquivalentRanges", {
            ranges: candidate.equivalentRanges
              .map((r) => `[${r.calcStartByte}:${r.calcEndByte}]`)
              .join(", "),
          })}`}
      </div>

      {/* For a fixed payload length init and xorOut are not separately
          identifiable, so the alternatives are part of the answer, not trivia. */}
      {spec.kind === "crc" && (
        <div className={`text-xs ${textMuted} font-mono`}>
          {t("checksumDiscovery.crcParameters", {
            init: hex(spec.init, digits),
            xorOut: hex(spec.xorOut, digits),
            reflect: spec.reflectIn ? t("checksumDiscovery.yes") : t("checksumDiscovery.no"),
          })}
          {spec.alternatives.length > 0 && (
            <span className="block">
              {t("checksumDiscovery.crcEquallyValid", {
                pairs: spec.alternatives
                  .map(
                    (a) =>
                      `init ${hex(a.init, digits)} / xorOut ${hex(a.xorOut, digits)}`,
                  )
                  .join(", "),
              })}
            </span>
          )}
        </div>
      )}

      {candidate.notes.length > 0 && (
        <div className={`text-xs ${textMuted}`}>
          {candidate.notes
            .slice(0, 3)
            .map((note) => t(`serial.checksumNote.${note.code}`, note.values))
            .join(" • ")}
        </div>
      )}
    </div>
  );
}

function ColumnVerdicts({ columns }: { columns: ChecksumEvidence[] }) {
  const { t } = useTranslation("discovery");
  if (columns.length === 0) return null;

  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs font-mono">
      {columns.map((column) => (
        <Fragment key={column.position}>
          <span className={textMuted}>{t("checksumDiscovery.byte", { position: column.position })}</span>
          <span className={column.rejected ? textMuted : textDataGreen}>
            {column.rejected
              ? t(`checksumDiscovery.rejected.${column.rejected}`)
              : t("checksumDiscovery.candidateLikeness", { likeness: column.likeness })}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
