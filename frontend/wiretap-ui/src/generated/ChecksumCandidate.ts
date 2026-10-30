// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CalcRange } from "./CalcRange";
import type { ChecksumAlgorithm } from "./ChecksumAlgorithm";
import type { ChecksumNote } from "./ChecksumNote";

/**
 * A checksum configuration that reproduces some or all of the sampled frames.
 */
export type ChecksumCandidate = { algorithm: ChecksumAlgorithm, position: number, length: number, bigEndian: boolean, calcStartByte: number, calcEndByte: number, matchCount: number, totalCount: number, 
/**
 * 0-100
 */
matchRate: number, 
/**
 * 0-100 composite score.
 */
confidence: number, notes: Array<ChecksumNote>, 
/**
 * Other calculation ranges that scored identically.
 */
equivalentRanges: Array<CalcRange>, };
