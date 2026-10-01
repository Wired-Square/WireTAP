// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CaptureMetadata } from "./CaptureMetadata";
import type { SequenceGap } from "./SequenceGap";

/**
 * Result of a CSV import, including capture metadata and any sequence gap diagnostics.
 */
export type CsvImportResult = { metadata: CaptureMetadata, sequence_gaps: Array<SequenceGap>, 
/**
 * Total number of dropped frames estimated from sequence gaps
 */
total_dropped: number, 
/**
 * Detected sequence wraparound points (raw sequence value at each wrap)
 */
wrap_points: Array<number>, };
