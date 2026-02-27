// src/api/bufferquery.ts
//
// API wrappers for buffer query commands. These run analytical queries
// against the local SQLite buffer database instead of PostgreSQL.

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
 * Query for byte changes in a specific frame within a buffer.
 *
 * Time bounds are in microseconds (matching buffer timestamp_us).
 */
export async function queryByteChangesBuffer(
  bufferId: string,
  frameId: number,
  byteIndex: number,
  isExtended: boolean | null,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<ByteChangeQueryResult> {
  return invoke("buffer_query_byte_changes", {
    bufferId,
    frameId,
    byteIndex,
    isExtended,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Query for frame payload changes within a buffer.
 *
 * Returns timestamps where any byte in the frame's payload changed.
 */
export async function queryFrameChangesBuffer(
  bufferId: string,
  frameId: number,
  isExtended: boolean | null,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<FrameChangeQueryResult> {
  return invoke("buffer_query_frame_changes", {
    bufferId,
    frameId,
    isExtended,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Query for mirror validation mismatches within a buffer.
 *
 * Tolerance is in microseconds (frontend converts from ms).
 */
export async function queryMirrorValidationBuffer(
  bufferId: string,
  mirrorFrameId: number,
  sourceFrameId: number,
  isExtended: boolean | null,
  toleranceUs: number,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<MirrorValidationQueryResult> {
  return invoke("buffer_query_mirror_validation", {
    bufferId,
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
 * Query mux statistics for a multiplexed frame within a buffer.
 *
 * Groups payloads by mux selector byte and computes per-byte and optional
 * 16-bit word statistics for each mux case.
 */
export async function queryMuxStatisticsBuffer(
  bufferId: string,
  frameId: number,
  muxSelectorByte: number,
  isExtended: boolean | null,
  include16bit: boolean,
  payloadLength: number,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<MuxStatisticsQueryResult> {
  return invoke("buffer_query_mux_statistics", {
    bufferId,
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
 * Query for first and last occurrence of a frame within a buffer.
 */
export async function queryFirstLastBuffer(
  bufferId: string,
  frameId: number,
  isExtended: boolean | null,
  startTimeUs?: number,
  endTimeUs?: number,
): Promise<FirstLastQueryResult> {
  return invoke("buffer_query_first_last", {
    bufferId,
    frameId,
    isExtended,
    startTimeUs,
    endTimeUs,
  });
}

/**
 * Query frame transmission frequency within a buffer.
 */
export async function queryFrequencyBuffer(
  bufferId: string,
  frameId: number,
  isExtended: boolean | null,
  bucketSizeMs: number,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<FrequencyQueryResult> {
  return invoke("buffer_query_frequency", {
    bufferId,
    frameId,
    isExtended,
    bucketSizeMs,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Query byte value distribution within a buffer.
 */
export async function queryDistributionBuffer(
  bufferId: string,
  frameId: number,
  byteIndex: number,
  isExtended: boolean | null,
  startTimeUs?: number,
  endTimeUs?: number,
): Promise<DistributionQueryResult> {
  return invoke("buffer_query_distribution", {
    bufferId,
    frameId,
    byteIndex,
    isExtended,
    startTimeUs,
    endTimeUs,
  });
}

/**
 * Query for transmission gaps within a buffer.
 */
export async function queryGapAnalysisBuffer(
  bufferId: string,
  frameId: number,
  isExtended: boolean | null,
  gapThresholdMs: number,
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<GapAnalysisQueryResult> {
  return invoke("buffer_query_gap_analysis", {
    bufferId,
    frameId,
    isExtended,
    gapThresholdMs,
    startTimeUs,
    endTimeUs,
    limit,
  });
}

/**
 * Search for a byte pattern across all frame IDs within a buffer.
 */
export async function queryPatternSearchBuffer(
  bufferId: string,
  pattern: number[],
  patternMask: number[],
  startTimeUs?: number,
  endTimeUs?: number,
  limit?: number,
): Promise<PatternSearchQueryResult> {
  return invoke("buffer_query_pattern_search", {
    bufferId,
    pattern,
    patternMask,
    startTimeUs,
    endTimeUs,
    limit,
  });
}
