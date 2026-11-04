// ui/src/utils/analysis/serialFrameAnalysis.ts
// Serial frame structure: candidate id bytes and source addresses, found in Rust
// by `wiretap_analysis`, and checksum positions from the shared `detectChecksum`.
// Notes are rendered here from the candidates' reason codes.
//
// For framing detection (SLIP, Modbus RTU, delimiter-based), see api/framingDetection.ts;
// that analysis runs in Rust, against the framer that would actually read the line.

import i18n, { type TFunction } from 'i18next';
import { detectChecksum, type ChecksumCandidate } from '../../api/checksums';
import { serialStructure, type CandidateReason, type FieldCandidate } from '../../api/byteRoles';

// ============================================================================
// Types
// ============================================================================

/**
 * Candidate ID byte group - a sequence of bytes that could identify frame types
 */
export type CandidateIdGroup = {
  startByte: number;
  length: number;           // 1 or 2 bytes typically
  uniqueValues: number[];   // The distinct ID values found
  sampleCount: number;      // How many frames had this pattern
  confidence: number;       // 0-100 confidence score
  notes: string[];          // Explanatory notes
};

/** Candidate source address position - bytes that could identify the sender */
export type CandidateSourceAddress = CandidateIdGroup;

/**
 * Candidate checksum position.
 *
 * An alias rather than a parallel shape: detection is shared with the Configure
 * Checksum dialog via the Rust `detectChecksum`, and two structs for one
 * concept is how the endianness field went missing here in the first place.
 */
export type CandidateChecksum = ChecksumCandidate;

/**
 * Result of serial frame structure analysis
 */
export type SerialFrameAnalysisResult = {
  frameCount: number;
  minLength: number;
  maxLength: number;
  hasVaryingLength: boolean;
  candidateIdGroups: CandidateIdGroup[];
  candidateSourceAddresses: CandidateSourceAddress[];
  candidateChecksums: CandidateChecksum[];
  notes: string[];
};

// ============================================================================
// Analysis
// ============================================================================

/** The note for one of a candidate's reasons; a two-byte candidate has its own wording. */
export function candidateReasonNote(t: TFunction, reason: CandidateReason, len: number): string {
  const wide = len === 2 ? "Wide" : "";
  const say = (key: string, options?: Record<string, unknown>) => t(`discovery:serialAnalysis.reasons.${key}`, options);
  switch (reason.code) {
    case 'protocolMarkers':
    case 'commandIds':
    case 'twelveBitRange':
    case 'smallAddresses':
      return say(reason.code);
    case 'typeSubtype': return say('typeSubtype', { count: reason.firstByteValues });
    case 'deviceCount':
    case 'addressCount':
      return say(`${reason.code}${wide}`, { count: reason.count });
    case 'evenDistribution':
    case 'noZeroAddress':
      return say(`${reason.code}${wide}`);
  }
}

function toCandidate(c: FieldCandidate): CandidateIdGroup {
  return {
    startByte: c.start,
    length: c.len,
    uniqueValues: c.values,
    sampleCount: c.sampleCount,
    confidence: c.confidence,
    notes: c.reasons.map((r) => candidateReasonNote(i18n.t.bind(i18n), r, c.len)),
  };
}

const byteSpan = (c: CandidateIdGroup) =>
  c.length > 1
    ? i18n.t('discovery:serialAnalysis.byteRangeMulti', { start: c.startByte, end: c.startByte + c.length - 1 })
    : i18n.t('discovery:serialAnalysis.byteRangeSingle', { start: c.startByte });

const note = (key: string, options?: Record<string, unknown>) => i18n.t(`discovery:serialAnalysis.notes.${key}`, options);

/**
 * Find candidate id bytes, source addresses and checksums in a link's framed
 * payloads.
 */
export async function analyzeSerialFrameStructure(
  frames: number[][]
): Promise<SerialFrameAnalysisResult> {
  if (frames.length === 0) {
    return {
      frameCount: 0,
      minLength: 0,
      maxLength: 0,
      hasVaryingLength: false,
      candidateIdGroups: [],
      candidateSourceAddresses: [],
      candidateChecksums: [],
      notes: [note('noFrames')],
    };
  }

  const [structure, checksums] = await Promise.all([serialStructure(frames), detectChecksum(frames)]);
  const candidateIdGroups = structure.ids.map(toCandidate);
  const candidateSourceAddresses = structure.sources.map(toCandidate);
  const candidateChecksums = checksums.candidates;
  const { minLen: minLength, maxLen: maxLength } = structure;
  const hasVaryingLength = minLength !== maxLength;

  const notes = [hasVaryingLength ? note('varyingLength', { min: minLength, max: maxLength }) : note('fixedLength', { count: minLength })];
  const [bestId] = candidateIdGroups;
  if (bestId) {
    notes.push(note('bestId', { span: byteSpan(bestId), count: bestId.uniqueValues.length }));
  }
  const [bestSrc] = candidateSourceAddresses;
  if (bestSrc) {
    notes.push(note('bestSource', { span: byteSpan(bestSrc), count: bestSrc.uniqueValues.length }));
  }
  const [bestChecksum] = candidateChecksums;
  if (bestChecksum) {
    notes.push(note('bestChecksum', { algorithm: bestChecksum.algorithm, position: bestChecksum.position, percent: bestChecksum.matchRate.toFixed(0) }));
  }

  return {
    frameCount: frames.length,
    minLength,
    maxLength,
    hasVaryingLength,
    candidateIdGroups,
    candidateSourceAddresses,
    candidateChecksums,
    notes,
  };
}
