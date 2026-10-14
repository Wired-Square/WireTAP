// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CalcRange } from "./CalcRange";
import type { ChecksumNote } from "./ChecksumNote";
import type { ChecksumSpecification } from "./ChecksumSpecification";

/**
 * One configuration that explains a frame id, with the evidence for it.
 */
export type DiscoveredChecksum = { specification: ChecksumSpecification, position: number, length: number, bigEndian: boolean, calcStartByte: number, calcEndByte: number, 
/**
 * Samples the configuration reproduced.
 */
matchCount: number, 
/**
 * Samples it was measured against.
 */
totalCount: number, 
/**
 * 0-100, and `None` for a solved configuration.
 *
 * A solve reproduces every sample it was verified against or is not
 * reported at all, so there is no rate to state — this used to be a
 * hard-coded 100 rendered as `100.0% (40/40)` beside genuinely measured
 * rates, which reads as a measurement and is not one.
 */
matchRate: number | null, 
/**
 * Samples left out because their calculation range was a different length.
 */
excludedCount: number, 
/**
 * 0-100 composite score.
 */
confidence: number, notes: Array<ChecksumNote>, equivalentRanges: Array<CalcRange>, };
