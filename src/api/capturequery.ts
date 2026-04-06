// src/api/capturequery.ts
//
// API wrappers for capture query commands. These run analytical queries
// against the local SQLite capture database instead of PostgreSQL.

import { invoke } from "@tauri-apps/api/core";
import type {
  ByteChangeQueryResult,
  FrameChangeQueryResult,
  MirrorValidationQueryResult,
  MuxStatisticsQueryResult,
  FirstLastQueryResult,
  FrequencyQueryResult,
  DistributionQueryResult,
  GapAnalysisQueryResult,
  PatternSearchQueryResult,
} from "./dbquery";

/**
 * Query for byte changes in a specific frame within a capture.
 *
 * Time bounds are in microseconds (matching capture timestamp_us).
 */
export async function queryByteChangesCapture(
  captureId: string,
  frameId: number,
  byteIndex: number,
  isExtended: boolean | null,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<ByteChangeQueryResult> {
  return invoke("capture_query_byte_changes", {
    captureId: captureId,
    frameId,
    byteIndex,
    isExtended,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Query for frame payload changes within a capture.
 *
 * Returns timestamps where any byte in the frame's payload changed.
 */
export async function queryFrameChangesCapture(
  captureId: string,
  frameId: number,
  isExtended: boolean | null,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<FrameChangeQueryResult> {
  return invoke("capture_query_frame_changes", {
    captureId: captureId,
    frameId,
    isExtended,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Query for mirror validation mismatches within a capture.
 *
 * Tolerance is in microseconds (frontend converts from ms).
 */
export async function queryMirrorValidationCapture(
  captureId: string,
  mirrorFrameId: number,
  sourceFrameId: number,
  isExtended: boolean | null,
  toleranceUs: number,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<MirrorValidationQueryResult> {
  return invoke("capture_query_mirror_validation", {
    captureId: captureId,
    mirrorFrameId,
    sourceFrameId,
    isExtended,
    toleranceUs,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Query mux statistics for a multiplexed frame within a capture.
 *
 * Groups payloads by mux selector byte and computes per-byte and optional
 * 16-bit word statistics for each mux case.
 */
export async function queryMuxStatisticsCapture(
  captureId: string,
  frameId: number,
  muxSelectorByte: number,
  isExtended: boolean | null,
  include16bit: boolean,
  payloadLength: number,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<MuxStatisticsQueryResult> {
  return invoke("capture_query_mux_statistics", {
    captureId: captureId,
    frameId,
    muxSelectorByte,
    isExtended,
    include16bit: include16bit,
    payloadLength,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Query for first and last occurrence of a frame within a capture.
 */
export async function queryFirstLastCapture(
  captureId: string,
  frameId: number,
  isExtended: boolean | null,
  startTimeUs?: number,
  endTimeUs?: number,
): Promise<FirstLastQueryResult> {
  return invoke("capture_query_first_last", {
    captureId: captureId,
    frameId,
    isExtended,
    startTimeUs,
    endTimeUs,
  });
}

/**
 * Query frame transmission frequency within a capture.
 */
export async function queryFrequencyCapture(
  captureId: string,
  frameId: number,
  isExtended: boolean | null,
  bucketSizeMs: number,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<FrequencyQueryResult> {
  return invoke("capture_query_frequency", {
    captureId: captureId,
    frameId,
    isExtended,
    bucketSizeMs,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Query byte value distribution within a capture.
 */
export async function queryDistributionCapture(
  captureId: string,
  frameId: number,
  byteIndex: number,
  isExtended: boolean | null,
  startTimeUs?: number,
  endTimeUs?: number,
): Promise<DistributionQueryResult> {
  return invoke("capture_query_distribution", {
    captureId: captureId,
    frameId,
    byteIndex,
    isExtended,
    startTimeUs,
    endTimeUs,
  });
}

/**
 * Query for transmission gaps within a capture.
 */
export async function queryGapAnalysisCapture(
  captureId: string,
  frameId: number,
  isExtended: boolean | null,
  gapThresholdMs: number,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<GapAnalysisQueryResult> {
  return invoke("capture_query_gap_analysis", {
    captureId: captureId,
    frameId,
    isExtended,
    gapThresholdMs,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Search for a byte pattern across all frame IDs within a capture.
 */
export async function queryPatternSearchCapture(
  captureId: string,
  pattern: number[],
  patternMask: number[],
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<PatternSearchQueryResult> {
  return invoke("capture_query_pattern_search", {
    captureId: captureId,
    pattern,
    patternMask,
    startTimeUs,
    endTimeUs,
    limit,
  });
}
