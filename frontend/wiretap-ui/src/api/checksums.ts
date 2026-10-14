// ui/src/api/checksums.ts
//
// Tauri API wrappers for checksum calculation functions.
// These call the Rust backend for checksum calculations.

import { invoke } from "@tauri-apps/api/core";
import type { ProtocolFrames } from "../utils/frameKey";
import type { ChecksumAlgorithm } from "../generated/ChecksumAlgorithm";
import type { ChecksumDetectionOptions } from "../generated/ChecksumDetectionOptions";
import type { ChecksumDetectionResult } from "../generated/ChecksumDetectionResult";
import type { ChecksumScanOptions } from "../generated/ChecksumScanOptions";
import type { ChecksumScanResult } from "../generated/ChecksumScanResult";
import type { ChecksumSpec } from "../generated/ChecksumSpec";
import type { ChecksumSweepResponse } from "../generated/ChecksumSweepResponse";
import type { ChecksumValidationResult } from "../generated/ChecksumValidationResult";
import type { DiscoveryFrame } from "../generated/DiscoveryFrame";

export type { ChecksumAlgorithm, ChecksumDetectionResult, ChecksumScanOptions, ChecksumScanResult, ChecksumValidationResult };
export type { ChecksumCandidate } from "../generated/ChecksumCandidate";
export type { ChecksumEvidence } from "../generated/ChecksumEvidence";
export type { ChecksumSpecification } from "../generated/ChecksumSpecification";
export type { DiscoveredChecksum } from "../generated/DiscoveredChecksum";
export type { FrameChecksumFinding } from "../generated/FrameChecksumFinding";

// ============================================================================
// API Functions
// ============================================================================

/**
 * Calculate checksum using the specified algorithm with byte range.
 *
 * @param algorithm - The checksum algorithm to use
 * @param data - The complete frame data as bytes
 * @param calcStartByte - First byte index to include (supports negative indexing)
 * @param calcEndByte - Last byte index exclusive (supports negative indexing)
 * @returns The calculated checksum value
 */
export async function calculateChecksum(
  algorithm: ChecksumAlgorithm,
  data: number[] | Uint8Array,
  calcStartByte: number,
  calcEndByte: number
): Promise<number> {
  const dataArray = data instanceof Uint8Array ? Array.from(data) : data;
  return invoke<number>("calculate_checksum_cmd", {
    algorithm,
    data: dataArray,
    calcStartByte,
    calcEndByte,
  });
}

/**
 * Validate a checksum in frame data.
 *
 * @param algorithm - The checksum algorithm to use
 * @param data - The complete frame data as bytes
 * @param startByte - Byte offset where checksum is stored (supports negative indexing)
 * @param byteLength - Length of checksum (1 or 2 bytes)
 * @param bigEndian - true for big-endian, false for little-endian
 * @param calcStartByte - First byte to include in calculation (supports negative indexing)
 * @param calcEndByte - Last byte (exclusive) to include (supports negative indexing)
 * @returns Validation result with extracted, calculated, and valid fields
 */
export async function validateChecksum(
  algorithm: ChecksumAlgorithm,
  data: number[] | Uint8Array,
  startByte: number,
  byteLength: number,
  bigEndian: boolean,
  calcStartByte: number,
  calcEndByte: number
): Promise<ChecksumValidationResult> {
  const dataArray = data instanceof Uint8Array ? Array.from(data) : data;
  return invoke<ChecksumValidationResult>("validate_checksum_cmd", {
    algorithm,
    data: dataArray,
    startByte,
    byteLength,
    bigEndian,
    calcStartByte,
    calcEndByte,
  });
}

/** Each index resolved against each frame length, one row per length; a negative index counts from the end. */
export async function resolveByteIndices(indices: number[], frameLengths: number[]): Promise<number[][]> {
  return invoke<number[][]>("resolve_byte_indices", { indices, frame_lengths: frameLengths });
}

/**
 * Rank the checksum configurations that explain a set of frames.
 *
 * The whole engine — candidate space, structural priors, confidence scoring —
 * lives in Rust beside the algorithms, so there is one implementation of each.
 * One IPC call for the whole search.
 */
export async function detectChecksum(
  frames: number[][],
  options: ChecksumDetectionOptions = {}
): Promise<ChecksumDetectionResult> {
  return invoke<ChecksumDetectionResult>("detect_checksum_cmd", { frames, options });
}

/**
 * Check specific checksum configurations against frames.
 *
 * For the live match rate behind a hand-edited configuration, where the caller
 * has one spec rather than a space to search. Unlike `batchTestCrc` above, the
 * response needs no field mapping — the Rust structs are `rename_all = "camelCase"`.
 */
export async function sweepChecksumSpecs(
  frames: number[][],
  specs: ChecksumSpec[]
): Promise<ChecksumSweepResponse> {
  if (specs.length === 0) return { results: [] };
  return invoke<ChecksumSweepResponse>("sweep_checksum_specs_cmd", { frames, specs });
}

// ============================================================================
// Discovery across a capture
// ============================================================================

/**
 * Scan a capture for checksums: group by frame id, then work out what explains
 * each group.
 *
 * **The request is a capture id and a selection, not the frames** — Rust already
 * has the payloads. An empty selection scans every frame the capture holds. Runs
 * the same scan the `frame_checksum_scan` MCP tool does, so an agent and the
 * panel cannot reach different answers about one capture.
 */
export async function discoverChecksumsInCapture(
  captureId: string,
  selection: ProtocolFrames[],
  options: ChecksumScanOptions = {}
): Promise<ChecksumScanResult> {
  return invoke<ChecksumScanResult>("discover_checksums_in_capture_cmd", {
    capture_id: captureId,
    selection,
    options,
  });
}

/**
 * Scan frames the frontend holds and no capture does — client-side serial
 * framing, and a session running without one. Everything capture-backed goes
 * through `discoverChecksumsInCapture`; both land in the same Rust engine.
 */
export async function discoverChecksums(
  frames: DiscoveryFrame[],
  options: ChecksumScanOptions = {}
): Promise<ChecksumScanResult> {
  return invoke<ChecksumScanResult>("discover_checksums_cmd", { frames, options });
}
