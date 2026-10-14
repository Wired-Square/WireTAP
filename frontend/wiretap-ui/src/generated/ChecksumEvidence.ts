// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Rejection } from "./Rejection";

/**
 * What one column looks like as a checksum candidate.
 */
export type ChecksumEvidence = { 
/**
 * End-relative index: -1 is the last byte.
 */
position: number, 
/**
 * Payload pairs where the rest of the payload changed.
 */
payloadChanged: number, 
/**
 * ...and this column changed with it. A checksum misses only on collision.
 */
changedWithPayload: number, 
/**
 * Payload pairs where the rest held still but this column moved. Any of
 * these at all is disqualifying.
 */
changedAlone: number, 
/**
 * `changed_with_payload / payload_changed`.
 */
responsiveness: number, entropyBits: number, distinctRatio: number, 
/**
 * 0-100. Zero when `rejected` is set.
 */
likeness: number, rejected: Rejection | null, };
