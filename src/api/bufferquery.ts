// src/api/bufferquery.ts
//
// API wrappers for buffer query commands. These run analytical queries
// against the local SQLite buffer database instead of PostgreSQL.

import { invoke } from "@tauri-apps/api/core";
import type {
  ByteChangeQueryResult,
  FrameChangeQueryResult,
  MirrorValidationQueryResult,
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
