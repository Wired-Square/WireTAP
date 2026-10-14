// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CandidateReason } from "./CandidateReason";

/**
 * Bytes `start..start + len`, read big-endian, as a candidate field.
 */
export type FieldCandidate = { start: number, 
/**
 * 1 or 2.
 */
len: number, 
/**
 * Sorted.
 */
values: Array<number>, sampleCount: number, 
/**
 * 0–100.
 */
confidence: number, reasons: Array<CandidateReason>, };
