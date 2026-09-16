// ui/src/utils/analysis/muxDetection.ts
// Shared mux (multiplexed frame) detection utilities

// ============================================================================
// Types
// ============================================================================

/**
 * Result of mux detection for a set of payloads
 */
export type MuxDetectionResult = {
  selectorByte: number;           // 0 for byte[0], -1 for byte[0:1] (two-byte)
  selectorValues: number[];       // Unique selector values (or combined for two-byte)
  isTwoByte: boolean;             // True if this is a two-byte mux
  occurrencesPerValue: Record<number, number>;
  getKey: (payload: number[]) => number; // Function to extract mux key from payload
};

// ============================================================================
// Main Detection Function
// ============================================================================

/**
 * Detect mux pattern in a set of payloads for a single frame ID.
 *
 * @param payloads Array of byte arrays (all from the same frame ID)
 * @returns MuxDetectionResult if mux pattern detected, null otherwise
 */
export function detectMuxInPayloads(payloads: number[][]): MuxDetectionResult | null {
  if (payloads.length < 4) {
    return null; // Need enough frames to see a pattern
  }

  // First, try single-byte mux detection (byte[0])
  const byte0Counts = new Map<number, number>();
  for (const payload of payloads) {
    if (payload.length === 0) continue;
    const val = payload[0];
    byte0Counts.set(val, (byte0Counts.get(val) || 0) + 1);
  }

  const uniqueByte0 = [...byte0Counts.keys()].sort((a, b) => a - b);

  // Check if byte[0] looks like a mux selector
  if (!isMuxLikeSequence(uniqueByte0, byte0Counts)) {
    return null;
  }

  // Check for two-byte mux: does byte[1] also cycle for each byte[0] value?
  const twoByteResult = detectTwoByteMux(payloads, uniqueByte0);
  if (twoByteResult) {
    return twoByteResult;
  }

  // Single-byte mux
  const occurrencesPerValue: Record<number, number> = {};
  for (const [val, count] of byte0Counts) {
    occurrencesPerValue[val] = count;
  }

  return {
    selectorByte: 0,
    selectorValues: uniqueByte0,
    isTwoByte: false,
    occurrencesPerValue,
    getKey: (payload) => payload[0],
  };
}

// ============================================================================
// Heuristic Validation (Exported for reuse)
// ============================================================================

/**
 * Check if a set of values looks like a mux selector sequence.
 * This is exported to allow reuse by other analysis modules (e.g., messageOrderAnalysis).
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

/**
 * Detect two-byte mux pattern where both byte[0] and byte[1] form selectors.
 */
function detectTwoByteMux(
  payloads: number[][],
  _byte0Values: number[]
): MuxDetectionResult | null {
  // For two-byte mux, check if byte[1] cycles consistently for each byte[0] value
  const byte1ValuesPerByte0 = new Map<number, Set<number>>();

  for (const payload of payloads) {
    if (payload.length < 2) continue;
    const b0 = payload[0];
    const b1 = payload[1];
    if (!byte1ValuesPerByte0.has(b0)) {
      byte1ValuesPerByte0.set(b0, new Set());
    }
    byte1ValuesPerByte0.get(b0)!.add(b1);
  }

  // Check if each byte[0] value has the same set of byte[1] values
  let commonByte1Values: number[] | null = null;
  for (const [_b0, b1Set] of byte1ValuesPerByte0) {
    const b1Values = [...b1Set].sort((a, b) => a - b);
    if (commonByte1Values === null) {
      commonByte1Values = b1Values;
    } else {
      // Check if same set
      if (b1Values.length !== commonByte1Values.length ||
          !b1Values.every((v, i) => v === commonByte1Values![i])) {
        return null; // Different byte[1] sets - not a two-byte mux
      }
    }
  }

  if (!commonByte1Values || commonByte1Values.length < 2) {
    return null;
  }

  // Check if byte[1] values look like a mux sequence
  const b1Min = commonByte1Values[0];
  const b1Max = commonByte1Values[commonByte1Values.length - 1];
  const b1StartsSmall = b1Min <= 2;
  const b1MaxReasonable = b1Max <= 31;

  // Check coverage (allow up to 50% gaps)
  const b1ExpectedRange = b1Max - b1Min + 1;
  const b1Coverage = commonByte1Values.length / b1ExpectedRange;

  if (!b1StartsSmall || !b1MaxReasonable) {
    return null;
  }

  // If too sparse and not enough values, reject
  if (b1Coverage < 0.5 && commonByte1Values.length < 4) {
    return null;
  }

  // This is a two-byte mux! Build combined keys
  // Key = byte[0] * 256 + byte[1] for uniqueness
  const combinedCounts = new Map<number, number>();
  for (const payload of payloads) {
    if (payload.length < 2) continue;
    const key = payload[0] * 256 + payload[1];
    combinedCounts.set(key, (combinedCounts.get(key) || 0) + 1);
  }

  // Check distribution of combined keys
  const combCounts = [...combinedCounts.values()];
  const combMin = Math.min(...combCounts);
  const combMax = Math.max(...combCounts);
  if (combMin < 1 || combMax > combMin * 2) {
    return null;
  }

  const uniqueKeys = [...combinedCounts.keys()].sort((a, b) => a - b);

  // Build occurrences per combined key
  const occurrencesPerValue: Record<number, number> = {};
  for (const [key, count] of combinedCounts) {
    occurrencesPerValue[key] = count;
  }

  return {
    selectorByte: -1, // Indicate two-byte mux (byte[0:1])
    selectorValues: uniqueKeys, // Combined keys
    isTwoByte: true,
    occurrencesPerValue,
    getKey: (payload) => payload[0] * 256 + payload[1],
  };
}

/**
 * Get the starting byte for payload analysis (skips mux selector bytes)
 */
export function getMuxPayloadStartByte(muxResult: MuxDetectionResult): number {
  return muxResult.isTwoByte ? 2 : 1;
}

/**
 * Format mux info for display
 */
export function formatMuxInfo(muxResult: MuxDetectionResult): string {
  if (muxResult.isTwoByte) {
    return `byte[0:1], ${muxResult.selectorValues.length} cases`;
  } else {
    const values = muxResult.selectorValues;
    if (values.length <= 6) {
      return `byte[0], cases: ${values.join(', ')}`;
    } else {
      return `byte[0], ${values.length} cases (${values[0]}-${values[values.length - 1]})`;
    }
  }
}

/**
 * Format a single mux value for display
 */
export function formatMuxValue(value: number, isTwoByte: boolean): string {
  if (isTwoByte) {
    const b0 = Math.floor(value / 256);
    const b1 = value % 256;
    return `${b0}:${b1}`;
  }
  return String(value);
}
