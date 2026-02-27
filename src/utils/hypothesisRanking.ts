// ui/src/utils/hypothesisRanking.ts
//
// Candidate generation and interest scoring for the Hypothesis Explorer.
// Uses Discovery payload analysis results to rank signal hypotheses.

import type { HypothesisParams } from '../stores/graphStore';
import type { PayloadAnalysisResult, ByteRole } from './analysis/payloadAnalysis';

/** Configuration for generating hypothesis candidates */
export interface HypothesisConfig {
  frameIds: number[];
  startBitMin: number;
  startBitMax: number;
  /** 8 = byte-aligned only, 1 = every bit offset */
  bitStep: number;
  bitLengths: number[];
  endiannesses: ('little' | 'big')[];
  signed: boolean;
  factor: number;
  offset: number;
}

/** A generated hypothesis candidate with ranking metadata */
export interface RankedCandidate {
  /** Signal name used as the key in panels (hyp_* prefix) */
  signalName: string;
  /** Human-readable label */
  label: string;
  /** The frame ID this candidate targets */
  frameId: number;
  /** Extraction/scaling parameters */
  params: HypothesisParams;
  /** Ranking score (0–100, higher = more interesting) */
  score: number;
  /** Short reason for the ranking */
  reason: string;
}

/** Maximum candidates before we stop generating */
const MAX_CANDIDATES = 500;

/**
 * Build a deterministic signal name from the hypothesis parameters.
 * Format: hyp_<frameIdHex>_b<startBit>_<bitLength><endian>[s]
 */
function buildSignalName(
  frameId: number,
  startBit: number,
  bitLength: number,
  endianness: 'little' | 'big',
  signed: boolean,
): string {
  const idHex = frameId.toString(16).toUpperCase();
  const e = endianness === 'little' ? 'le' : 'be';
  const s = signed ? 's' : '';
  return `hyp_${idHex}_b${startBit}_${bitLength}${e}${s}`;
}

/**
 * Build a human-readable label for a hypothesis candidate.
 */
function buildLabel(
  startBit: number,
  bitLength: number,
  endianness: 'little' | 'big',
  signed: boolean,
): string {
  const byteAligned = startBit % 8 === 0;
  const position = byteAligned
    ? `byte ${startBit / 8}`
    : `bit ${startBit}`;
  const e = bitLength > 8 ? (endianness === 'little' ? ' LE' : ' BE') : '';
  const s = signed ? ' signed' : '';
  return `${position}, ${bitLength}-bit${e}${s}`;
}

/**
 * Score a candidate based on Discovery payload analysis results.
 * Returns a score (0–100) and a short reason string.
 */
function scoreCandidate(
  params: HypothesisParams,
  analysis: PayloadAnalysisResult | undefined,
): { score: number; reason: string } {
  if (!analysis) {
    return { score: 50, reason: 'no analysis data' };
  }

  let score = 0;
  const reasons: string[] = [];

  const startByte = Math.floor(params.startBit / 8);
  const endByte = Math.floor((params.startBit + params.bitLength - 1) / 8);

  // ── Byte role bonus (0–30 pts) ──
  const roleScores: Record<ByteRole, number> = {
    sensor: 30,
    value: 20,
    unknown: 10,
    counter: 2,
    static: 0,
  };
  let bestRoleScore = 0;
  let bestRole: string | null = null;
  for (let b = startByte; b <= endByte; b++) {
    const stat = analysis.byteStats.find((s) => s.byteIndex === b);
    if (stat) {
      const rs = roleScores[stat.role];
      if (rs > bestRoleScore) {
        bestRoleScore = rs;
        bestRole = stat.role;
      }
    }
  }
  score += bestRoleScore;
  if (bestRole && bestRoleScore > 0) reasons.push(`${bestRole} byte`);

  // ── Multi-byte pattern match (0–30 pts) ──
  const patternScores: Record<string, number> = {
    sensor16: 30, sensor32: 30,
    value16: 20, value32: 20,
    counter16: 5, counter32: 5,
    text: 3, unknown: 5,
  };
  for (const mbp of analysis.multiBytePatterns) {
    const mbpEnd = mbp.startByte + mbp.length - 1;
    // Check overlap between candidate byte range and multi-byte pattern
    if (startByte <= mbpEnd && endByte >= mbp.startByte) {
      const byteLen = params.bitLength / 8;
      const exactMatch = mbp.startByte === startByte && mbp.length === byteLen;
      const ps = patternScores[mbp.pattern] ?? 0;
      const bonus = exactMatch ? ps : Math.floor(ps * 0.5);
      if (bonus > 0) {
        score += bonus;
        reasons.push(mbp.pattern);
        break;
      }
    }
  }

  // ── Endianness agreement (0–15 pts) ──
  if (params.bitLength > 8 && analysis.inferredEndianness) {
    if (analysis.inferredEndianness === params.endianness) {
      score += 15;
    } else if (analysis.inferredEndianness === 'mixed') {
      score += 7;
    }
  }

  // ── Variance proxy (0–15 pts) ──
  let totalUnique = 0;
  let bytesChecked = 0;
  for (let b = startByte; b <= endByte; b++) {
    const stat = analysis.byteStats.find((s) => s.byteIndex === b);
    if (stat) {
      totalUnique += stat.uniqueValues.size;
      bytesChecked++;
    }
  }
  if (bytesChecked > 0) {
    const avgUnique = totalUnique / bytesChecked;
    if (avgUnique > 50) {
      score += 15;
      reasons.push('high variance');
    } else if (avgUnique > 20) {
      score += 10;
    } else if (avgUnique > 5) {
      score += 5;
    } else {
      score += 2;
    }
  }

  // ── Trend strength (0–10 pts) ──
  for (let b = startByte; b <= endByte; b++) {
    const stat = analysis.byteStats.find((s) => s.byteIndex === b);
    if (stat?.trendStrength && stat.trendStrength > 0.6) {
      const bonus = Math.round(stat.trendStrength * 10);
      score += bonus;
      if (stat.trendStrength > 0.8) reasons.push('strong trend');
      break;
    }
  }

  return {
    score: Math.min(100, score),
    reason: reasons.length > 0 ? reasons.join(', ') : 'low interest',
  };
}

/**
 * Generate ranked hypothesis candidates from a configuration.
 * Returns candidates sorted by score (highest first), capped at MAX_CANDIDATES.
 */
export function generateHypotheses(
  config: HypothesisConfig,
  analysisResults: Map<number, PayloadAnalysisResult>,
): RankedCandidate[] {
  const candidates: RankedCandidate[] = [];

  for (const frameId of config.frameIds) {
    const analysis = analysisResults.get(frameId);

    for (let startBit = config.startBitMin; startBit <= config.startBitMax; startBit += config.bitStep) {
      for (const bitLength of config.bitLengths) {
        // Check the signal fits within 8 bytes (64 bits)
        if (startBit + bitLength > 64) continue;

        for (const endianness of config.endiannesses) {
          // 8-bit signals are endianness-agnostic — skip BE duplicate
          if (bitLength === 8 && endianness === 'big') continue;

          const params: HypothesisParams = {
            startBit,
            bitLength,
            endianness,
            signed: config.signed,
            factor: config.factor,
            offset: config.offset,
          };

          const signalName = buildSignalName(frameId, startBit, bitLength, endianness, config.signed);
          const label = buildLabel(startBit, bitLength, endianness, config.signed);
          const { score, reason } = scoreCandidate(params, analysis);

          candidates.push({
            signalName,
            label,
            frameId,
            params,
            score,
            reason,
          });

          if (candidates.length >= MAX_CANDIDATES) break;
        }
        if (candidates.length >= MAX_CANDIDATES) break;
      }
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  // Sort by score descending, then by startBit ascending for ties
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.params.startBit - b.params.startBit;
  });

  return candidates;
}

