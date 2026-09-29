// ui/src/utils/analysis/payloadAnalysis.ts
// The Changes view's result types, read off the byte profile Rust classifies
// (`api/byteRoles.ts`), with the notes rendered here in en-AU. Mirror detection
// stays here until it gains a protocol-aware frame key.

import type { ByteColumn, FrameByteProfile, MultiBytePattern as LibPattern, MuxCase } from '../../api/byteRoles';

// ============================================================================
// Types
// ============================================================================

export type ByteRole = 'static' | 'counter' | 'sensor' | 'value' | 'unknown';

export type ByteStats = {
  byteIndex: number;
  min: number;
  max: number;
  distinctCount: number;
  /** Payloads long enough to reach this byte. */
  sampleCount: number;
  role: ByteRole;
  counterDirection?: 'up' | 'down';
  counterStep?: number;
  rolloverDetected?: boolean;
  isLoopingCounter?: boolean;
  loopingRange?: { min: number; max: number };
  loopingModulo?: number;
  staticValue?: number;
  sensorTrend?: 'increasing' | 'decreasing' | 'mixed';
  /** 0–1, the share of moving transitions in the trend's direction. */
  trendStrength?: number;
};

export type MultiBytePattern = {
  startByte: number;
  length: number;
  pattern: 'counter16' | 'counter32' | 'sensor16' | 'sensor32' | 'value16' | 'value32' | 'text' | 'unknown';
  endianness?: 'little' | 'big';
  rolloverDetected?: boolean;
  correlatedRollover?: boolean;
  slowUpperBytes?: boolean;
  minValue?: number;
  maxValue?: number;
  sampleText?: string;
};

export type MuxCaseAnalysis = {
  muxValue: number;
  sampleCount: number;
  byteStats: ByteStats[];
  multiBytePatterns: MultiBytePattern[];
  notes: string[];
};

export type MuxInfo = {
  selectorByte: number;      // 0 for byte[0], -1 for two-byte
  selectorValues: number[];
  isTwoByte: boolean;
};

export type PayloadAnalysisResult = {
  protocol?: string;
  frameId: number;
  isExtended: boolean;
  sampleCount: number;
  /** Over every payload; past `lengthRange.min` a byte's `sampleCount` says how many reached it. */
  byteStats: ByteStats[];
  /** A mux frame's are over every payload; its cases carry their own. */
  multiBytePatterns: MultiBytePattern[];
  notes: string[];
  analyzedFromByte: number;
  analyzedToByteExclusive: number;
  isBurstFrame: boolean;
  isMuxFrame: boolean;
  muxInfo?: MuxInfo;
  muxCaseAnalyses?: MuxCaseAnalysis[];
  hasVaryingLength?: boolean;
  lengthRange?: { min: number; max: number };
  isIdentical?: boolean;
  identicalPayload?: number[];
  inferredEndianness?: 'little' | 'big' | 'mixed';
};

// ============================================================================
// From the byte profile
// ============================================================================

function toByteStats(column: ByteColumn): ByteStats {
  const stats: ByteStats = {
    byteIndex: column.position,
    min: column.min,
    max: column.max,
    distinctCount: column.distinctValues,
    sampleCount: column.sampleCount,
    role: column.role,
  };
  switch (column.role) {
    case 'static':
      return { ...stats, staticValue: column.value };
    case 'counter':
      return {
        ...stats,
        counterDirection: column.direction,
        counterStep: column.step,
        rolloverDetected: column.rollover,
        isLoopingCounter: column.looping !== null,
        loopingRange: column.looping ? { min: column.looping.min, max: column.looping.max } : undefined,
        loopingModulo: column.looping?.modulo,
      };
    case 'sensor':
      return { ...stats, sensorTrend: column.trend, trendStrength: column.strength, rolloverDetected: column.rollover };
    default:
      return stats;
  }
}

function toPattern(p: LibPattern): MultiBytePattern {
  return {
    startByte: p.start,
    length: p.len,
    pattern: p.kind,
    endianness: p.endianness ?? undefined,
    rolloverDetected: p.rollover,
    correlatedRollover: p.correlatedRollover,
    slowUpperBytes: p.slowUpperBytes,
    minValue: p.range?.[0],
    maxValue: p.range?.[1],
    sampleText: p.sampleText ?? undefined,
  };
}

function toMuxCase(c: MuxCase): MuxCaseAnalysis {
  const byteStats = c.columns.map(toByteStats);
  const multiBytePatterns = c.patterns.map(toPattern);
  return {
    muxValue: c.value,
    sampleCount: c.sampleCount,
    byteStats,
    multiBytePatterns,
    notes: renderCaseNotes(byteStats, multiBytePatterns),
  };
}

/** The Changes view's result for one frame, notes rendered from the profile. */
export function toPayloadAnalysisResult(profile: FrameByteProfile, isBurstFrame: boolean): PayloadAnalysisResult {
  const hasVaryingLength = profile.minLen !== profile.maxLen;
  const byteStats = profile.columns.map(toByteStats);
  const multiBytePatterns = profile.patterns.map(toPattern);
  const muxInfo: MuxInfo | undefined = profile.mux
    ? {
        selectorByte: profile.mux.detection.selector === 'twoByte' ? -1 : 0,
        selectorValues: profile.mux.cases.map((c) => c.value),
        isTwoByte: profile.mux.detection.selector === 'twoByte',
      }
    : undefined;
  const muxCaseAnalyses = profile.mux?.cases.map(toMuxCase);

  const result: PayloadAnalysisResult = {
    protocol: profile.protocol,
    frameId: profile.frameId,
    isExtended: profile.isExtended,
    sampleCount: profile.sampleCount,
    byteStats,
    multiBytePatterns,
    notes: [],
    analyzedFromByte: profile.analysedFrom,
    analyzedToByteExclusive: profile.maxLen,
    isBurstFrame,
    isMuxFrame: muxInfo !== undefined,
    muxInfo,
    muxCaseAnalyses,
    hasVaryingLength,
    lengthRange: hasVaryingLength ? { min: profile.minLen, max: profile.maxLen } : undefined,
    isIdentical: profile.identical !== null,
    identicalPayload: profile.identical ?? undefined,
    inferredEndianness: profile.endianness ?? undefined,
  };
  return { ...result, notes: renderNotes(result) };
}

// ============================================================================
// Notes
// ============================================================================

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');

function bytesInPatterns(patterns: MultiBytePattern[]): Set<number> {
  const bytes = new Set<number>();
  for (const p of patterns) {
    for (let i = p.startByte; i < p.startByte + p.length; i++) bytes.add(i);
  }
  return bytes;
}

const trendArrow = (trend: ByteStats['sensorTrend']) =>
  trend === 'increasing' ? '↑' : trend === 'decreasing' ? '↓' : '↕';

const patternRange = (p: MultiBytePattern, sep: string) =>
  p.minValue !== undefined && p.maxValue !== undefined ? `${sep}${p.minValue}–${p.maxValue}` : '';

export function formatMuxValue(value: number, isTwoByte: boolean): string {
  return isTwoByte ? `${Math.floor(value / 256)}:${value % 256}` : String(value);
}

function formatMuxInfo(mux: MuxInfo): string {
  const values = mux.selectorValues;
  if (mux.isTwoByte) return `byte[0:1], ${values.length} cases`;
  return values.length <= 6
    ? `byte[0], cases: ${values.join(', ')}`
    : `byte[0], ${values.length} cases (${values[0]}-${values[values.length - 1]})`;
}

/** A frame's notes, worded as the TypeScript classifier wrote them. */
export function renderNotes(result: PayloadAnalysisResult): string[] {
  if (result.sampleCount === 0) return ['No frames to analyze'];

  const notes: string[] = [];
  if (result.lengthRange) {
    notes.push(`Varying length: ${result.lengthRange.min}–${result.lengthRange.max} bytes`);
  }
  if (result.isBurstFrame) {
    notes.push(result.isMuxFrame
      ? 'Burst frame with mux: analyzing stable payload portion only'
      : 'Burst frame: analyzing stable payload portion only');
  }
  if (result.identicalPayload) {
    notes.push(`Identical payload across all ${result.sampleCount} samples: ${result.identicalPayload.map(hex2).join(' ')}`);
  }

  let endianPatterns = result.multiBytePatterns;
  if (result.muxInfo && result.muxCaseAnalyses) {
    notes.push(`Multiplexed frame: ${formatMuxInfo(result.muxInfo)}`);
    const summaries = result.muxCaseAnalyses.flatMap((c) => {
      const counters = c.byteStats.filter((s) => s.role === 'counter').length;
      const statics = c.byteStats.filter((s) => s.role === 'static').length;
      return counters > 0 || statics > 0
        ? [`Case ${formatMuxValue(c.muxValue, result.muxInfo!.isTwoByte)}: ${counters} counter, ${statics} static`]
        : [];
    });
    if (summaries.length > 0 && summaries.length <= 4) notes.push(...summaries);
    endianPatterns = [...endianPatterns, ...result.muxCaseAnalyses.flatMap((c) => c.multiBytePatterns)];
  } else {
    notes.push(...renderByteNotes(result.byteStats, result.multiBytePatterns));
  }

  if (result.inferredEndianness) {
    const label = result.inferredEndianness === 'mixed' ? 'Mixed endianness'
      : result.inferredEndianness === 'little' ? 'Little-endian' : 'Big-endian';
    notes.unshift(`${label} (inferred from ${endianPatterns.filter((p) => p.endianness).length} multi-byte pattern(s))`);
  }
  return notes;
}

function renderByteNotes(byteStats: ByteStats[], patterns: MultiBytePattern[]): string[] {
  const notes: string[] = [];
  const inPatterns = bytesInPatterns(patterns);
  const outside = (role: ByteRole) => byteStats.filter((s) => s.role === role && !inPatterns.has(s.byteIndex));
  const statics = byteStats.filter((s) => s.role === 'static');
  const counters = outside('counter');
  const sensors = outside('sensor');
  const values = outside('value');

  if (statics.length > 0) {
    notes.push(`Static bytes: ${statics.map((s) => `byte[${s.byteIndex}]=0x${hex2(s.staticValue!)}`).join(', ')}`);
  }
  for (const c of counters) {
    const direction = c.counterDirection === 'up' ? 'incrementing' : 'decrementing';
    notes.push(c.isLoopingCounter && c.loopingRange && c.loopingModulo
      ? `Looping counter at byte[${c.byteIndex}]: ${direction}, step=${c.counterStep}, range ${c.loopingRange.min}–${c.loopingRange.max} (mod ${c.loopingModulo})`
      : `Counter at byte[${c.byteIndex}]: ${direction}, step=${c.counterStep}${c.rolloverDetected ? ' (rollover detected)' : ''}`);
  }
  for (const s of sensors) {
    const strength = s.trendStrength ? ` (${Math.round(s.trendStrength * 100)}% trend)` : '';
    notes.push(`Sensor at byte[${s.byteIndex}]: ${trendArrow(s.sensorTrend)} range ${s.min}–${s.max}${strength}`);
  }
  for (const p of patterns) {
    const end = p.startByte + p.length - 1;
    if (p.pattern === 'counter16' || p.pattern === 'counter32') {
      notes.push(`${p.pattern === 'counter16' ? 16 : 32}-bit counter at byte[${p.startByte}:${end}], ${p.endianness} endian${p.rolloverDetected ? ' (rollover detected)' : ''}`);
    } else if (p.pattern === 'sensor16' || p.pattern === 'sensor32') {
      const bits = p.pattern === 'sensor16' ? 16 : 32;
      const slowUpper = p.slowUpperBytes ? ' (slow-changing upper bytes)' : '';
      const correlation = p.correlatedRollover ? ' (rollover correlation detected)' : '';
      notes.push(`${bits}-bit sensor at byte[${p.startByte}:${end}], ${p.endianness} endian${patternRange(p, ', range ')}${slowUpper}${correlation}`);
    } else if (p.pattern === 'text') {
      notes.push(`Text at byte[${p.startByte}:${end}]${p.sampleText ? ` "${p.sampleText}"` : ''}`);
    }
  }
  if (values.length > 0 && counters.length === 0 && sensors.length === 0 && patterns.length === 0) {
    notes.push(`${values.length} byte(s) with varying values detected`);
  }
  return notes;
}

function renderCaseNotes(byteStats: ByteStats[], patterns: MultiBytePattern[]): string[] {
  const notes: string[] = [];
  const inPatterns = bytesInPatterns(patterns);
  const statics = byteStats.filter((s) => s.role === 'static');

  if (statics.length > 0) {
    notes.push(`Static: ${statics.map((s) => `byte[${s.byteIndex}]=0x${hex2(s.staticValue!)}`).join(', ')}`);
  }
  for (const c of byteStats.filter((s) => s.role === 'counter' && !inPatterns.has(s.byteIndex))) {
    const direction = c.counterDirection === 'up' ? 'inc' : 'dec';
    notes.push(c.isLoopingCounter && c.loopingRange && c.loopingModulo
      ? `Loop counter byte[${c.byteIndex}]: ${direction}, step=${c.counterStep}, ${c.loopingRange.min}–${c.loopingRange.max} (mod ${c.loopingModulo})`
      : `Counter byte[${c.byteIndex}]: ${direction}, step=${c.counterStep}${c.rolloverDetected ? ' +rollover' : ''}`);
  }
  for (const s of byteStats.filter((s) => s.role === 'sensor' && !inPatterns.has(s.byteIndex))) {
    notes.push(`Sensor byte[${s.byteIndex}]: ${trendArrow(s.sensorTrend)} range ${s.min}–${s.max}`);
  }
  for (const p of patterns) {
    const end = p.startByte + p.length - 1;
    if (p.pattern === 'counter16' || p.pattern === 'counter32') {
      notes.push(`${p.pattern === 'counter16' ? 16 : 32}b counter byte[${p.startByte}:${end}] ${p.endianness}${p.rolloverDetected ? ' +rollover' : ''}`);
    } else if (p.pattern === 'sensor16' || p.pattern === 'sensor32') {
      const bits = p.pattern === 'sensor16' ? 16 : 32;
      const slowUpper = p.slowUpperBytes ? ' +slow-upper' : '';
      const correlation = p.correlatedRollover ? ' +correlated' : '';
      notes.push(`${bits}b sensor byte[${p.startByte}:${end}] ${p.endianness}${patternRange(p, ' ')}${slowUpper}${correlation}`);
    } else if (p.pattern === 'text') {
      notes.push(`Text byte[${p.startByte}:${end}]${p.sampleText ? ` "${p.sampleText}"` : ''}`);
    }
  }
  return notes;
}

// ============================================================================
// Mirror Frame Detection
// ============================================================================

/**
 * A group of frame IDs that have identical payloads that change in unison.
 * This detects when multiple different frame IDs are transmitting the same data.
 */
export type MirrorGroup = {
  frameIds: number[];          // The frame IDs in this mirror group (sorted)
  sampleCount: number;         // Number of matching payload pairs found
  matchPercentage: number;     // What percentage of payloads matched (0-100)
  samplePayload?: number[];    // An example payload from the group
};

/**
 * Input type for mirror detection - maps frame ID to its timestamped payloads
 */
export type TimestampedPayload = {
  timestamp: number;  // Microseconds
  payload: number[];
};

/**
 * Detect mirror frames - different frame IDs that contain identical payloads
 * and change together over time.
 *
 * Algorithm:
 * 1. For each pair of frame IDs, compare their payloads at similar timestamps
 * 2. If payloads match frequently (>80% of the time), they're mirrors
 * 3. Group transitive mirrors together (if A mirrors B and B mirrors C, group all three)
 *
 * @param framePayloads - Map of frame ID to array of timestamped payloads (sorted by time)
 * @param toleranceUs - How close timestamps need to be to compare payloads (default 50ms)
 * @returns Array of mirror groups found
 */
export function detectMirrorFrames(
  framePayloads: Map<number, TimestampedPayload[]>,
  toleranceUs: number = 50000  // 50ms default
): MirrorGroup[] {
  const frameIds = Array.from(framePayloads.keys()).sort((a, b) => a - b);

  if (frameIds.length < 2) return [];

  // Track which frame ID pairs are mirrors
  // Key format: "smallerId-largerId"
  const mirrorPairs = new Map<string, { matchCount: number; totalCount: number; samplePayload?: number[] }>();

  // Compare each pair of frame IDs
  for (let i = 0; i < frameIds.length; i++) {
    for (let j = i + 1; j < frameIds.length; j++) {
      const idA = frameIds[i];
      const idB = frameIds[j];
      const payloadsA = framePayloads.get(idA)!;
      const payloadsB = framePayloads.get(idB)!;

      // Skip if either has too few samples
      if (payloadsA.length < 3 || payloadsB.length < 3) continue;

      const result = comparePayloadSequences(payloadsA, payloadsB, toleranceUs);

      if (result.matchCount > 0) {
        const pairKey = `${idA}-${idB}`;
        mirrorPairs.set(pairKey, {
          matchCount: result.matchCount,
          totalCount: result.totalCount,
          samplePayload: result.samplePayload,
        });
      }
    }
  }

  // Filter to only pairs with >80% match rate
  const confirmedMirrors = new Map<string, { matchCount: number; totalCount: number; samplePayload?: number[] }>();
  for (const [pairKey, stats] of mirrorPairs) {
    const matchPercentage = (stats.matchCount / stats.totalCount) * 100;
    if (matchPercentage >= 80) {
      confirmedMirrors.set(pairKey, stats);
    }
  }

  if (confirmedMirrors.size === 0) return [];

  // Build groups using union-find for transitive relationships
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  };
  const union = (x: number, y: number) => {
    const px = find(x);
    const py = find(y);
    if (px !== py) {
      parent.set(px, py);
    }
  };

  // Union all confirmed mirror pairs
  for (const pairKey of confirmedMirrors.keys()) {
    const [idA, idB] = pairKey.split('-').map(Number);
    union(idA, idB);
  }

  // Group frame IDs by their root parent
  const groups = new Map<number, number[]>();
  for (const pairKey of confirmedMirrors.keys()) {
    const [idA, idB] = pairKey.split('-').map(Number);
    const root = find(idA);  // Both have same root after union
    if (!groups.has(root)) groups.set(root, []);
    const group = groups.get(root)!;
    if (!group.includes(idA)) group.push(idA);
    if (!group.includes(idB)) group.push(idB);
  }

  // Build result with statistics
  const result: MirrorGroup[] = [];
  for (const [_root, memberIds] of groups) {
    memberIds.sort((a, b) => a - b);

    // Calculate aggregate stats from all pairs in this group
    let totalMatchCount = 0;
    let totalTotalCount = 0;
    let samplePayload: number[] | undefined;

    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        const pairKey = `${memberIds[i]}-${memberIds[j]}`;
        const stats = confirmedMirrors.get(pairKey);
        if (stats) {
          totalMatchCount += stats.matchCount;
          totalTotalCount += stats.totalCount;
          if (!samplePayload && stats.samplePayload) {
            samplePayload = stats.samplePayload;
          }
        }
      }
    }

    result.push({
      frameIds: memberIds,
      sampleCount: totalMatchCount,
      matchPercentage: totalTotalCount > 0 ? Math.round((totalMatchCount / totalTotalCount) * 100) : 0,
      samplePayload,
    });
  }

  // Sort by number of members (largest groups first)
  result.sort((a, b) => b.frameIds.length - a.frameIds.length);

  return result;
}

/**
 * Compare two payload sequences to see if they match at similar timestamps.
 * Uses a sliding window approach to find temporally close payloads.
 */
function comparePayloadSequences(
  payloadsA: TimestampedPayload[],
  payloadsB: TimestampedPayload[],
  toleranceUs: number
): { matchCount: number; totalCount: number; samplePayload?: number[] } {
  let matchCount = 0;
  let totalCount = 0;
  let samplePayload: number[] | undefined;

  // For each payload in A, find the closest payload in B within tolerance
  let bIndex = 0;
  for (const a of payloadsA) {
    // Advance bIndex to find payloads close in time
    while (bIndex < payloadsB.length && payloadsB[bIndex].timestamp < a.timestamp - toleranceUs) {
      bIndex++;
    }

    // Check payloads within the tolerance window
    for (let i = bIndex; i < payloadsB.length && payloadsB[i].timestamp <= a.timestamp + toleranceUs; i++) {
      const b = payloadsB[i];

      // Compare payloads
      totalCount++;
      if (payloadsMatch(a.payload, b.payload)) {
        matchCount++;
        if (!samplePayload) {
          samplePayload = [...a.payload];
        }
      }
    }
  }

  return { matchCount, totalCount, samplePayload };
}

/**
 * Check if two payloads are identical
 */
function payloadsMatch(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
