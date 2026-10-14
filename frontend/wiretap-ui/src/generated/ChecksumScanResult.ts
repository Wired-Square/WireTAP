// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameChecksumFinding } from "./FrameChecksumFinding";

export type ChecksumScanResult = { findings: Array<FrameChecksumFinding>, frameCount: number, uniqueFrameIds: number, 
/**
 * Ids skipped for having fewer than `min_samples` frames.
 */
skippedFrameIds: number, };
