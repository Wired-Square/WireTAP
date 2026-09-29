// ui/src/utils/analysis/muxDetection.ts
// The mux-selector heuristic that message-order analysis still runs in TypeScript.
// Payload mux detection is `wiretap_analysis`'s `detect_mux`, whose
// `is_mux_like_sequence` this matches until message-order analysis moves too.

/**
 * Check if a set of values looks like a mux selector sequence.
 *
 * Heuristics:
 * - 2-16 unique values
 * - Values start small (0-2) and stay reasonable (max 31)
 * - At least 50% coverage of the value range (or 4+ values)
 * - Balanced distribution (max 3x ratio between occurrences)
 *
 * @param values - Sorted array of unique byte values
 * @param counts - Map of value to occurrence count
 */
export function isMuxLikeSequence(values: number[], counts: Map<number, number>): boolean {
  // Must have 2-16 unique values
  if (values.length < 2 || values.length > 16) {
    return false;
  }

  const minVal = values[0];
  const maxVal = values[values.length - 1];

  // Mux selectors typically start at 0-2 and stay reasonably small
  const startsSmall = minVal <= 2;
  const maxReasonable = maxVal <= 31;

  if (!startsSmall || !maxReasonable) {
    return false;
  }

  // Check sparseness: how many gaps are there?
  const expectedRange = maxVal - minVal + 1;
  const coverage = values.length / expectedRange;
  if (coverage < 0.5) {
    // Too sparse - exception: if we have at least 4 values, still accept
    if (values.length < 4) {
      return false;
    }
  }

  // Check distribution balance
  const countValues = [...counts.values()];
  const minCount = Math.min(...countValues);
  const maxCount = Math.max(...countValues);

  // All values should appear with reasonable frequency (max 3x ratio)
  if (minCount < 1 || maxCount > minCount * 3) {
    return false;
  }

  return true;
}
