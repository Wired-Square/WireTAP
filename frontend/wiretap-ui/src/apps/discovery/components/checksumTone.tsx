// ui/src/apps/discovery/components/checksumTone.tsx
//
// Match rate reads as a colour in both places checksum candidates are shown —
// the serial Apply list and the CAN discovery results. Same thresholds, one
// definition, so a 96% candidate is not green in one view and amber in the
// other.

import { AlertCircle, CheckCircle2 } from "lucide-react";
import { iconLg } from "../../../styles/spacing";
import {
  bgInfo,
  bgSuccess,
  bgSurface,
  bgWarning,
  borderDefault,
  borderInfo,
  borderSuccess,
  borderWarning,
  textDataAmber,
  textDataGreen,
  textInfo,
  textMuted,
  textSuccess,
  textWarning,
} from "../../../styles/colourTokens";

/** Above this, a candidate is presented as the answer. */
export const MATCH_RATE_STRONG = 95;
/** Above this, worth showing but flagged. */
export const MATCH_RATE_WEAK = 80;

/**
 * A rate to tone on.
 *
 * `null` means the configuration was *solved* — it reproduces every sample it
 * was verified against or it would not be reported — so there is no rate to
 * measure and it tones as a full match. Declared once here, beside the
 * thresholds, rather than as a `?? 100` at each call site.
 */
export type MatchRate = number | null;

function toned(matchRate: MatchRate): number {
  return matchRate ?? 100;
}

export function matchRateToneClasses(matchRate: MatchRate, isApplied = false): string {
  if (isApplied) return `${bgInfo} ${borderInfo}`;
  const rate = toned(matchRate);
  if (rate >= MATCH_RATE_STRONG) return `${bgSuccess} ${borderSuccess}`;
  if (rate >= MATCH_RATE_WEAK) return `${bgWarning} ${borderWarning}`;
  return `${bgSurface} ${borderDefault}`;
}

export function matchRateTextClass(matchRate: MatchRate): string {
  const rate = toned(matchRate);
  if (rate >= MATCH_RATE_STRONG) return `${textDataGreen} font-medium`;
  if (rate >= MATCH_RATE_WEAK) return textDataAmber;
  return "";
}

export function MatchRateIcon({
  matchRate,
  isApplied = false,
}: {
  matchRate: MatchRate;
  isApplied?: boolean;
}) {
  const rate = toned(matchRate);
  if (isApplied) return <CheckCircle2 className={`${iconLg} ${textInfo}`} />;
  if (rate >= MATCH_RATE_STRONG) return <CheckCircle2 className={`${iconLg} ${textSuccess}`} />;
  if (rate >= MATCH_RATE_WEAK) return <AlertCircle className={`${iconLg} ${textWarning}`} />;
  return <AlertCircle className={`${iconLg} ${textMuted}`} />;
}

/**
 * How a candidate's match reads: a measured percentage, or that it was exact.
 *
 * One formatter so the header, the candidate row and the clipboard cannot
 * disagree — the clipboard copy had already drifted into an untranslated
 * string of its own.
 */
export function formatMatchRate(
  matchRate: MatchRate,
  matchCount: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return matchRate === null
    ? t("checksumDiscovery.exactOverSamples", { count: matchCount })
    : `${matchRate.toFixed(1)}%`;
}
