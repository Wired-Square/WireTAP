// ui/src/utils/analysis/serialFrameAnalysis.ts
// Serial frame structure: candidate id bytes and source addresses, found in Rust
// by `wiretap_analysis`, and checksum positions from the shared `detectChecksum`.
// Notes are rendered here from the candidates' reason codes.
//
// For framing detection (SLIP, Modbus RTU, delimiter-based), see api/framingDetection.ts;
// that analysis runs in Rust, against the framer that would actually read the line.

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

/** The English note for one of a candidate's reasons, as the TypeScript scorer wrote it. */
export function candidateReasonNote(reason: CandidateReason, len: number): string {
  const wide = len === 2;
  switch (reason.code) {
    case 'protocolMarkers': return 'Contains common protocol markers (0xFB-0xFE)';
    case 'commandIds': return 'Contains small sequential values (likely command IDs)';
    case 'typeSubtype': return `First byte has only ${reason.firstByteValues} values (type + subtype pattern)`;
    case 'deviceCount': return wide
      ? `${reason.count} unique 16-bit addresses (strong pattern)`
      : `${reason.count} unique addresses (typical device count)`;
    case 'addressCount': return wide ? `${reason.count} unique 16-bit addresses` : `${reason.count} unique addresses`;
    case 'twelveBitRange': return '12-bit address range';
    case 'evenDistribution': return wide ? 'Even distribution' : 'Even distribution across addresses';
    case 'smallAddresses': return 'Small address values (0x00-0x20)';
    case 'noZeroAddress': return wide ? 'No zero address' : 'No zero address (typical for device IDs)';
  }
}

function toCandidate(c: FieldCandidate): CandidateIdGroup {
  return {
    startByte: c.start,
    length: c.len,
    uniqueValues: c.values,
    sampleCount: c.sampleCount,
    confidence: c.confidence,
    notes: c.reasons.map((r) => candidateReasonNote(r, c.len)),
  };
}

const byteSpan = (c: CandidateIdGroup) =>
  `byte${c.length > 1 ? 's' : ''} [${c.startByte}${c.length > 1 ? ':' + (c.startByte + c.length - 1) : ''}]`;

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
      notes: ['No frames to analyze'],
    };
  }

  const [structure, checksums] = await Promise.all([serialStructure(frames), detectChecksum(frames)]);
  const candidateIdGroups = structure.ids.map(toCandidate);
  const candidateSourceAddresses = structure.sources.map(toCandidate);
  const candidateChecksums = checksums.candidates;
  const { minLen: minLength, maxLen: maxLength } = structure;
  const hasVaryingLength = minLength !== maxLength;

  const notes = [hasVaryingLength ? `Varying length: ${minLength}–${maxLength} bytes` : `Fixed length: ${minLength} bytes`];
  const [bestId] = candidateIdGroups;
  if (bestId) {
    notes.push(`Best ID candidate: ${byteSpan(bestId)} with ${bestId.uniqueValues.length} distinct values`);
  }
  const [bestSrc] = candidateSourceAddresses;
  if (bestSrc) {
    notes.push(`Best source address candidate: ${byteSpan(bestSrc)} with ${bestSrc.uniqueValues.length} distinct values`);
  }
  const [bestChecksum] = candidateChecksums;
  if (bestChecksum) {
    notes.push(`Best checksum candidate: ${bestChecksum.algorithm} at byte ${bestChecksum.position} (${bestChecksum.matchRate.toFixed(0)}% match rate)`);
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

/**
 * Format an ID group candidate for display
 */
export function formatIdCandidate(candidate: CandidateIdGroup): string {
  const byteRange = candidate.length === 1
    ? `byte[${candidate.startByte}]`
    : `bytes[${candidate.startByte}:${candidate.startByte + candidate.length - 1}]`;

  return `${byteRange}: ${candidate.uniqueValues.length} distinct values (${candidate.confidence.toFixed(0)}% confidence)`;
}
