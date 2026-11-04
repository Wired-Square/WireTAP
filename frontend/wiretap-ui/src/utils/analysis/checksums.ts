// ui/src/utils/analysis/checksums.ts
//
// Checksum utilities for frame validation.
// Calculation functions are implemented in Rust and called via Tauri IPC.
// This module provides metadata and re-exports the async API functions.

// Re-export async API functions from Tauri wrappers
export {
  calculateChecksum,
  validateChecksum,
  type ChecksumAlgorithm,
  type ChecksumValidationResult,
} from "../../api/checksums";

import i18n from "i18next";
import { CHECKSUM_OUTPUT_BYTES } from "../../generated/checksumAlgorithms";
import type { ChecksumAlgorithm } from "../../api/checksums";

export interface AlgorithmInfo {
  id: ChecksumAlgorithm;
  name: string;
  description: string;
  outputBytes: number;
}

export const CHECKSUM_ALGORITHMS: AlgorithmInfo[] = (
  Object.entries(CHECKSUM_OUTPUT_BYTES) as [ChecksumAlgorithm, number][]
).map(([id, outputBytes]) => ({
  id,
  outputBytes,
  get name() {
    return i18n.t(`common:checksumAlgorithms.${id}.name`);
  },
  get description() {
    return i18n.t(`common:checksumAlgorithms.${id}.description`);
  },
}));

/**
 * Get algorithm info by ID.
 */
export function getAlgorithmInfo(
  algorithm: ChecksumAlgorithm
): AlgorithmInfo | undefined {
  return CHECKSUM_ALGORITHMS.find((a) => a.id === algorithm);
}

/**
 * Get the expected output size in bytes for an algorithm.
 */
export function getAlgorithmOutputBytes(
  algorithm: ChecksumAlgorithm
): number {
  return getAlgorithmInfo(algorithm)?.outputBytes ?? 1;
}
