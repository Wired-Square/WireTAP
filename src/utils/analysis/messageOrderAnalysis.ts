// ui/src/utils/analysis/messageOrderAnalysis.ts
// Message Order Analysis - Detects transmission order patterns in CAN frames
//
// Uses shared mux heuristic validation from muxDetection.ts for consistency.
// The timing-specific mux detection (detectMuxSelector) remains here as it needs
// access to FrameMessage timestamps.

import type { FrameMessage } from '../../types/frame';
import { isMuxLikeSequence } from './muxDetection';

// ============================================================================
// Types
// ============================================================================

export type MessageOrderOptions = {
  startMessageId: number | null; // Optional: user can specify or leave for auto-detect
};

export type DetectedPattern = {
  startId: number;
  sequence: number[];
  occurrences: number;
  confidence: number;
  avgCycleTimeMs: number;
};

export type IntervalGroup = {
  intervalMs: number;
  tolerance: number; // +/- range for this group
  frameIds: number[];
};

export type StartIdCandidate = {
  id: number;
  maxGapBeforeMs: number;
  avgGapBeforeMs: number;
  minGapBeforeMs: number;
  occurrences: number;
};

export type MultiplexedFrame = {
  frameId: number;
  selectorByte: number;        // Usually 0, -1 for two-byte mux
  selectorValues: number[];    // e.g., [0, 1, 2]
  occurrencesPerValue: Record<number, number>; // Using Record for JSON serialization
  muxPeriodMs: number;         // True repetition period (time between same mux value)
  interMessageMs: number;      // Inter-message time (time between any occurrence of this frame ID)
};

export type BurstFrame = {
  frameId: number;
  burstCount: number;          // Average frames per burst
  burstPeriodMs: number;       // Time between bursts (cycle time)
  interMessageMs: number;      // Time between frames within a burst
  dlcVariation: number[];      // Different DLCs observed
  flags: string[];             // Descriptive flags: "variable-dlc", "request-response", etc.
};

export type MultiBusFrame = {
  frameId: number;
  buses: number[];             // List of bus numbers where this frame ID was seen
  countPerBus: Record<number, number>; // Count of frames on each bus
};

export type MessageOrderResult = {
  // Detected patterns (may have multiple if different start IDs produce valid patterns)
  patterns: DetectedPattern[];

  // Interval analysis - frames grouped by repetition period
  intervalGroups: IntervalGroup[];

  // Start ID candidates (sorted by max gap before, descending)
  startIdCandidates: StartIdCandidate[];

  // Detected multiplexed frames
  multiplexedFrames: MultiplexedFrame[];

  // Detected burst/transaction frames (request-response patterns, variable DLC)
  burstFrames: BurstFrame[];

  // Frames seen on multiple buses
  multiBusFrames: MultiBusFrame[];

  // Stats
  totalFramesAnalyzed: number;
  uniqueFrameIds: number;
  timeSpanMs: number;
};

// ============================================================================
// Main Analysis Function
// ============================================================================

export function analyzeMessageOrder(
  frames: FrameMessage[],
  options: MessageOrderOptions
): MessageOrderResult {
  if (frames.length < 2) {
    return emptyResult();
  }

  const timeSpanMs = (frames[frames.length - 1].timestamp_us - frames[0].timestamp_us) / 1000;
  const uniqueIds = new Set(frames.map((f) => f.frame_id));

  // Step 0a: Detect multiplexed frames (same ID with incrementing byte[0])
  const multiplexedFrames = detectMultiplexedFrames(frames);

  // Step 0b: Detect burst/transaction frames (variable DLC, request-response patterns)
  const muxedIds = new Set(multiplexedFrames.map(m => m.frameId));
  const burstFrames = detectBurstFrames(frames, muxedIds);

  // Step 0c: Detect frames that appear on multiple buses
  const multiBusFrames = detectMultiBusFrames(frames);

  // Build a map of special frame IDs to their true period
  const specialPeriodMap = new Map<number, number>();
  for (const mux of multiplexedFrames) {
    specialPeriodMap.set(mux.frameId, mux.muxPeriodMs);
  }
  for (const burst of burstFrames) {
    specialPeriodMap.set(burst.frameId, burst.burstPeriodMs);
  }

  // Step 1: Group frames by repetition period (using special periods for mux/burst frames)
  const intervalGroups = groupByRepetitionPeriod(frames, specialPeriodMap);

  // Step 2: Find candidate start IDs (frames with largest gaps before them)
  const startIdCandidates = findStartIdCandidates(frames);

  // Step 3: Build patterns
  const patterns: DetectedPattern[] = [];

  if (options.startMessageId !== null) {
    // User specified a start ID - build pattern from it
    const pattern = buildPatternFromStartId(frames, options.startMessageId);
    if (pattern) {
      patterns.push(pattern);
    }
  } else {
    // Auto-detect: try top candidates and keep patterns that work
    for (const candidate of startIdCandidates.slice(0, 3)) {
      const pattern = buildPatternFromStartId(frames, candidate.id);
      if (pattern && pattern.occurrences >= 2 && pattern.confidence >= 0.5) {
        patterns.push(pattern);
      }
    }
  }

  // Sort patterns by confidence * sequence length (prefer longer, more consistent)
  patterns.sort((a, b) => {
    const scoreA = a.confidence * a.sequence.length;
    const scoreB = b.confidence * b.sequence.length;
    return scoreB - scoreA;
  });

  return {
    patterns,
    intervalGroups,
    startIdCandidates,
    multiplexedFrames,
    burstFrames,
    multiBusFrames,
    totalFramesAnalyzed: frames.length,
    uniqueFrameIds: uniqueIds.size,
    timeSpanMs,
  };
}

// ============================================================================
// Step 1: Group by Repetition Period
// ============================================================================

function groupByRepetitionPeriod(
  frames: FrameMessage[],
  muxPeriodMap: Map<number, number>
): IntervalGroup[] {
  // Calculate average repetition period for each frame ID
  const idPeriods = new Map<number, number[]>();

  // Build position map
  const positionMap = new Map<number, number[]>();
  for (let i = 0; i < frames.length; i++) {
    const id = frames[i].frame_id;
    if (!positionMap.has(id)) {
      positionMap.set(id, []);
    }
    positionMap.get(id)!.push(i);
  }

  // Calculate periods between occurrences
  for (const [id, positions] of positionMap) {
    if (positions.length < 2) continue;

    const periods: number[] = [];
    for (let i = 1; i < positions.length; i++) {
      const periodUs = frames[positions[i]].timestamp_us - frames[positions[i - 1]].timestamp_us;
      periods.push(periodUs / 1000); // Convert to ms
    }
    idPeriods.set(id, periods);
  }

  // Calculate median period for each ID
  // For muxed frames, use the pre-calculated mux period instead
  const idMedianPeriod = new Map<number, number>();
  for (const [id, periods] of idPeriods) {
    // If this is a muxed frame, use the true mux period
    if (muxPeriodMap.has(id)) {
      idMedianPeriod.set(id, muxPeriodMap.get(id)!);
    } else {
      const sorted = [...periods].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      idMedianPeriod.set(id, median);
    }
  }

  // Cluster IDs by similar periods using logarithmic buckets
  // Buckets: ~10ms, ~20ms, ~50ms, ~100ms, ~200ms, ~500ms, ~1000ms, etc.
  const buckets = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const groups: IntervalGroup[] = [];

  for (const bucket of buckets) {
    const tolerance = bucket * 0.3; // 30% tolerance
    const idsInBucket: number[] = [];

    for (const [id, period] of idMedianPeriod) {
      if (period >= bucket - tolerance && period <= bucket + tolerance) {
        idsInBucket.push(id);
      }
    }

    if (idsInBucket.length > 0) {
      // Remove these IDs from further consideration
      for (const id of idsInBucket) {
        idMedianPeriod.delete(id);
      }

      groups.push({
        intervalMs: bucket,
        tolerance,
        frameIds: idsInBucket.sort((a, b) => a - b),
      });
    }
  }

  // Add remaining IDs that didn't fit standard buckets
  if (idMedianPeriod.size > 0) {
    const remaining: number[] = [];
    let avgPeriod = 0;
    for (const [id, period] of idMedianPeriod) {
      remaining.push(id);
      avgPeriod += period;
    }
    avgPeriod /= remaining.length;

    groups.push({
      intervalMs: Math.round(avgPeriod),
      tolerance: avgPeriod * 0.3,
      frameIds: remaining.sort((a, b) => a - b),
    });
  }

  // Sort groups by interval
  groups.sort((a, b) => a.intervalMs - b.intervalMs);

  return groups;
}

// ============================================================================
// Step 2: Find Start ID Candidates
// ============================================================================

function findStartIdCandidates(frames: FrameMessage[]): StartIdCandidate[] {
  // For each frame ID, calculate gap statistics BEFORE each occurrence
  const idGapStats = new Map<number, { gaps: number[]; positions: number[] }>();

  for (let i = 0; i < frames.length; i++) {
    const id = frames[i].frame_id;
    if (!idGapStats.has(id)) {
      idGapStats.set(id, { gaps: [], positions: [] });
    }

    const stats = idGapStats.get(id)!;
    stats.positions.push(i);

    if (i > 0) {
      const gapUs = frames[i].timestamp_us - frames[i - 1].timestamp_us;
      stats.gaps.push(gapUs / 1000); // Convert to ms
    }
  }

  const candidates: StartIdCandidate[] = [];

  for (const [id, stats] of idGapStats) {
    if (stats.gaps.length === 0) continue;

    const sorted = [...stats.gaps].sort((a, b) => a - b);
    const minGap = sorted[0];
    const maxGap = sorted[sorted.length - 1];
    const avgGap = stats.gaps.reduce((a, b) => a + b, 0) / stats.gaps.length;

    candidates.push({
      id,
      maxGapBeforeMs: maxGap,
      avgGapBeforeMs: avgGap,
      minGapBeforeMs: minGap,
      occurrences: stats.positions.length,
    });
  }

  // Sort by max gap before (descending) - IDs with largest gaps are likely cycle starters
  candidates.sort((a, b) => b.maxGapBeforeMs - a.maxGapBeforeMs);

  // Return top 5
  return candidates.slice(0, 5);
}

// ============================================================================
// Step 3: Build Pattern from Start ID
// ============================================================================

function buildPatternFromStartId(
  frames: FrameMessage[],
  startId: number
): DetectedPattern | null {
  // Find all positions where startId occurs
  const startPositions: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].frame_id === startId) {
      startPositions.push(i);
    }
  }

  if (startPositions.length < 2) {
    return null; // Need at least 2 occurrences to detect a pattern
  }

  // Build patterns starting from each occurrence
  const extractedPatterns: number[][] = [];
  const cycleTimes: number[] = [];

  for (let s = 0; s < startPositions.length; s++) {
    const startPos = startPositions[s];
    const pattern: number[] = [];
    const seenInPattern = new Set<number>();

    // Collect frames until we see a duplicate
    for (let i = startPos; i < frames.length; i++) {
      const id = frames[i].frame_id;

      if (seenInPattern.has(id)) {
        // Pattern complete - we've seen this ID before
        break;
      }

      pattern.push(id);
      seenInPattern.add(id);
    }

    if (pattern.length >= 2) {
      extractedPatterns.push(pattern);

      // Calculate cycle time if we have a next start position
      if (s < startPositions.length - 1) {
        const nextStartPos = startPositions[s + 1];
        const cycleTimeUs = frames[nextStartPos].timestamp_us - frames[startPos].timestamp_us;
        cycleTimes.push(cycleTimeUs / 1000);
      }
    }
  }

  if (extractedPatterns.length === 0) {
    return null;
  }

  // Find the most common pattern (mode)
  const patternCounts = new Map<string, { pattern: number[]; count: number }>();
  for (const pattern of extractedPatterns) {
    const key = pattern.join(',');
    if (!patternCounts.has(key)) {
      patternCounts.set(key, { pattern, count: 0 });
    }
    patternCounts.get(key)!.count++;
  }

  // Find the pattern with highest count
  let bestPattern: number[] = [];
  let bestCount = 0;
  for (const { pattern, count } of patternCounts.values()) {
    if (count > bestCount) {
      bestCount = count;
      bestPattern = pattern;
    }
  }

  const confidence = bestCount / extractedPatterns.length;
  const avgCycleTimeMs = cycleTimes.length > 0
    ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length
    : 0;

  return {
    startId,
    sequence: bestPattern,
    occurrences: extractedPatterns.length,
    confidence,
    avgCycleTimeMs,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function emptyResult(): MessageOrderResult {
  return {
    patterns: [],
    intervalGroups: [],
    startIdCandidates: [],
    multiplexedFrames: [],
    burstFrames: [],
    multiBusFrames: [],
    totalFramesAnalyzed: 0,
    uniqueFrameIds: 0,
    timeSpanMs: 0,
  };
}

// ============================================================================
// Multiplexed Frame Detection
// ============================================================================

function detectMultiplexedFrames(frames: FrameMessage[]): MultiplexedFrame[] {
  // Group frames by ID, preserving order
  const framesByIdMap = new Map<number, FrameMessage[]>();
  for (const frame of frames) {
    if (!framesByIdMap.has(frame.frame_id)) {
      framesByIdMap.set(frame.frame_id, []);
    }
    framesByIdMap.get(frame.frame_id)!.push(frame);
  }

  const multiplexed: MultiplexedFrame[] = [];

  for (const [frameId, idFrames] of framesByIdMap) {
    if (idFrames.length < 4) continue; // Need enough frames to see a pattern

    // Try to detect mux - first try byte[0], then check for two-byte mux
    const muxResult = detectMuxSelector(idFrames);
    if (!muxResult) continue;

    // Calculate inter-message time (time between any consecutive frames of this ID)
    let interMessageMs = 0;
    if (idFrames.length >= 2) {
      const interMessagePeriods: number[] = [];
      for (let i = 1; i < idFrames.length; i++) {
        const periodUs = idFrames[i].timestamp_us - idFrames[i - 1].timestamp_us;
        interMessagePeriods.push(periodUs / 1000);
      }
      // Use median for robustness
      interMessagePeriods.sort((a, b) => a - b);
      interMessageMs = interMessagePeriods[Math.floor(interMessagePeriods.length / 2)];
    }

    // Calculate true mux period (time between same mux key occurrences)
    const muxPeriods: number[] = [];
    for (const muxKey of muxResult.uniqueKeys) {
      const muxFrames = idFrames.filter(f => muxResult.getKey(f) === muxKey);
      if (muxFrames.length >= 2) {
        for (let i = 1; i < muxFrames.length; i++) {
          const periodUs = muxFrames[i].timestamp_us - muxFrames[i - 1].timestamp_us;
          muxPeriods.push(periodUs / 1000);
        }
      }
    }

    let muxPeriodMs = 0;
    if (muxPeriods.length > 0) {
      // Use median for robustness
      muxPeriods.sort((a, b) => a - b);
      muxPeriodMs = muxPeriods[Math.floor(muxPeriods.length / 2)];
    }

    multiplexed.push({
      frameId,
      selectorByte: muxResult.selectorByte,
      selectorValues: muxResult.selectorValues,
      occurrencesPerValue: muxResult.occurrencesPerValue,
      muxPeriodMs,
      interMessageMs,
    });
  }

  return multiplexed;
}

// Helper type for mux detection result
type MuxDetectionResult = {
  selectorByte: number;           // 0 for byte[0], -1 for byte[0:1] (two-byte)
  selectorValues: number[];       // Unique selector values (or combined for two-byte)
  occurrencesPerValue: Record<number, number>;
  uniqueKeys: number[];           // Keys used for period calculation
  getKey: (frame: FrameMessage) => number; // Function to extract mux key from frame
};

function detectMuxSelector(idFrames: FrameMessage[]): MuxDetectionResult | null {
  // First, try single-byte mux detection (byte[0])
  const byte0Counts = new Map<number, number>();
  for (const frame of idFrames) {
    const val = frame.bytes[0];
    byte0Counts.set(val, (byte0Counts.get(val) || 0) + 1);
  }

  const uniqueByte0 = [...byte0Counts.keys()].sort((a, b) => a - b);

  // Check if byte[0] looks like a mux selector
  if (!isMuxLikeSequence(uniqueByte0, byte0Counts)) {
    return null;
  }

  // Check for two-byte mux: does byte[1] also cycle for each byte[0] value?
  // This handles cases like 0x71F where byte[0]=1,2,3 and byte[1]=1,2,3 for each
  const twoByteResult = detectTwoByteMux(idFrames, uniqueByte0);
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
    occurrencesPerValue,
    uniqueKeys: uniqueByte0,
    getKey: (f) => f.bytes[0],
  };
}

// isMuxLikeSequence is imported from muxDetection.ts for consistency

function detectTwoByteMux(
  idFrames: FrameMessage[],
  _byte0Values: number[]
): MuxDetectionResult | null {
  // For two-byte mux, check if byte[1] also cycles consistently for each byte[0] value
  // Group frames by byte[0], then check byte[1] distribution within each group

  const byte1ValuesPerByte0 = new Map<number, Set<number>>();
  for (const frame of idFrames) {
    const b0 = frame.bytes[0];
    const b1 = frame.bytes[1];
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
  for (const frame of idFrames) {
    const key = frame.bytes[0] * 256 + frame.bytes[1];
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

  // Build occurrences per combined key for display
  const occurrencesPerValue: Record<number, number> = {};
  for (const [key, count] of combinedCounts) {
    occurrencesPerValue[key] = count;
  }

  return {
    selectorByte: -1, // Indicate two-byte mux (byte[0:1])
    selectorValues: uniqueKeys, // Combined keys for display
    occurrencesPerValue,
    uniqueKeys,
    getKey: (f) => f.bytes[0] * 256 + f.bytes[1],
  };
}

// ============================================================================
// Burst/Transaction Frame Detection
// ============================================================================

const BURST_THRESHOLD_MS = 50; // Frames within 50ms are considered part of same burst

function detectBurstFrames(
  frames: FrameMessage[],
  excludeIds: Set<number>
): BurstFrame[] {
  // Group frames by ID
  const framesByIdMap = new Map<number, FrameMessage[]>();
  for (const frame of frames) {
    if (excludeIds.has(frame.frame_id)) continue; // Skip already-detected muxes
    if (!framesByIdMap.has(frame.frame_id)) {
      framesByIdMap.set(frame.frame_id, []);
    }
    framesByIdMap.get(frame.frame_id)!.push(frame);
  }

  const burstFrames: BurstFrame[] = [];

  for (const [frameId, idFrames] of framesByIdMap) {
    if (idFrames.length < 4) continue;

    // Check for variable DLC
    const dlcSet = new Set(idFrames.map(f => f.dlc));
    const hasVariableDlc = dlcSet.size > 1;

    // Detect bursts: group frames that are close together in time
    const bursts: FrameMessage[][] = [];
    let currentBurst: FrameMessage[] = [idFrames[0]];

    for (let i = 1; i < idFrames.length; i++) {
      const gapMs = (idFrames[i].timestamp_us - idFrames[i - 1].timestamp_us) / 1000;
      if (gapMs < BURST_THRESHOLD_MS) {
        // Part of same burst
        currentBurst.push(idFrames[i]);
      } else {
        // New burst
        if (currentBurst.length > 0) {
          bursts.push(currentBurst);
        }
        currentBurst = [idFrames[i]];
      }
    }
    if (currentBurst.length > 0) {
      bursts.push(currentBurst);
    }

    // Calculate burst statistics
    const burstSizes = bursts.map(b => b.length);
    const avgBurstSize = burstSizes.reduce((a, b) => a + b, 0) / burstSizes.length;
    const minBurstSize = Math.min(...burstSizes);
    const maxBurstSize = Math.max(...burstSizes);

    // Check if this looks like a burst pattern:
    // - Multiple bursts detected
    // - Bursts have consistent size (or variable DLC which indicates transaction pattern)
    // - Average burst size > 1 (otherwise it's just regular frames)
    const hasBurstPattern = bursts.length >= 2 && avgBurstSize > 1.5;
    const hasConsistentBursts = maxBurstSize <= minBurstSize * 2;

    if (!hasBurstPattern && !hasVariableDlc) {
      continue; // Not interesting
    }

    // If we have variable DLC but no clear burst pattern, still flag it
    if (!hasBurstPattern && hasVariableDlc) {
      // Calculate simple inter-message timing
      const periods: number[] = [];
      for (let i = 1; i < idFrames.length; i++) {
        periods.push((idFrames[i].timestamp_us - idFrames[i - 1].timestamp_us) / 1000);
      }
      periods.sort((a, b) => a - b);
      const medianPeriod = periods[Math.floor(periods.length / 2)];

      burstFrames.push({
        frameId,
        burstCount: 1,
        burstPeriodMs: medianPeriod,
        interMessageMs: medianPeriod,
        dlcVariation: [...dlcSet].sort((a, b) => a - b),
        flags: ['variable-dlc'],
      });
      continue;
    }

    // Calculate burst-to-burst period (time from start of one burst to start of next)
    const burstPeriods: number[] = [];
    for (let i = 1; i < bursts.length; i++) {
      const periodMs = (bursts[i][0].timestamp_us - bursts[i - 1][0].timestamp_us) / 1000;
      burstPeriods.push(periodMs);
    }

    let burstPeriodMs = 0;
    if (burstPeriods.length > 0) {
      burstPeriods.sort((a, b) => a - b);
      burstPeriodMs = burstPeriods[Math.floor(burstPeriods.length / 2)];
    }

    // Calculate inter-message time within bursts
    const intraburstGaps: number[] = [];
    for (const burst of bursts) {
      for (let i = 1; i < burst.length; i++) {
        intraburstGaps.push((burst[i].timestamp_us - burst[i - 1].timestamp_us) / 1000);
      }
    }
    let interMessageMs = 0;
    if (intraburstGaps.length > 0) {
      intraburstGaps.sort((a, b) => a - b);
      interMessageMs = intraburstGaps[Math.floor(intraburstGaps.length / 2)];
    }

    // Build flags
    const flags: string[] = [];
    if (hasVariableDlc) {
      flags.push('variable-dlc');
    }
    if (hasBurstPattern && hasConsistentBursts) {
      flags.push('burst-pattern');
    }
    if (avgBurstSize >= 2 && avgBurstSize <= 4) {
      flags.push('request-response');
    }

    burstFrames.push({
      frameId,
      burstCount: Math.round(avgBurstSize * 10) / 10, // Round to 1 decimal
      burstPeriodMs,
      interMessageMs,
      dlcVariation: [...dlcSet].sort((a, b) => a - b),
      flags,
    });
  }

  return burstFrames;
}

// ============================================================================
// Multi-Bus Frame Detection
// ============================================================================

function detectMultiBusFrames(frames: FrameMessage[]): MultiBusFrame[] {
  // Group frames by frame_id and track which buses they appear on
  const busesPerFrame = new Map<number, Map<number, number>>();

  for (const frame of frames) {
    const bus = frame.bus ?? 0; // Default to bus 0 if not specified

    if (!busesPerFrame.has(frame.frame_id)) {
      busesPerFrame.set(frame.frame_id, new Map());
    }

    const busCounts = busesPerFrame.get(frame.frame_id)!;
    busCounts.set(bus, (busCounts.get(bus) || 0) + 1);
  }

  // Find frames that appear on more than one bus
  const multiBusFrames: MultiBusFrame[] = [];

  for (const [frameId, busCounts] of busesPerFrame) {
    if (busCounts.size > 1) {
      const buses = [...busCounts.keys()].sort((a, b) => a - b);
      const countPerBus: Record<number, number> = {};
      for (const [bus, count] of busCounts) {
        countPerBus[bus] = count;
      }

      multiBusFrames.push({
        frameId,
        buses,
        countPerBus,
      });
    }
  }

  // Sort by frame ID for consistent display
  multiBusFrames.sort((a, b) => a.frameId - b.frameId);

  return multiBusFrames;
}
