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

import { CHECKSUM_OUTPUT_BYTES } from "../../generated/checksumAlgorithms";
import type { ChecksumAlgorithm } from "../../api/checksums";

export interface AlgorithmInfo {
  id: ChecksumAlgorithm;
  name: string;
  description: string;
  outputBytes: number;
}

const ALGORITHM_LABELS: Record<ChecksumAlgorithm, Pick<AlgorithmInfo, "name" | "description">> = {
  xor: { name: "XOR", description: "XOR of all bytes (8-bit)" },
  sum8: { name: "Sum (8-bit)", description: "Simple sum of bytes modulo 256" },
  crc8: { name: "CRC-8", description: "CRC-8 polynomial 0x07 (ITU/SMBUS)" },
  crc8_sae_j1850: { name: "CRC-8 SAE-J1850", description: "CRC-8 polynomial 0x1D (automotive OBD-II)" },
  crc8_autosar: { name: "CRC-8 AUTOSAR", description: "CRC-8 polynomial 0x2F (AUTOSAR E2E)" },
  crc8_maxim: { name: "CRC-8 Maxim", description: "CRC-8 polynomial 0x31 (1-Wire devices)" },
  crc8_cdma2000: { name: "CRC-8 CDMA2000", description: "CRC-8 polynomial 0x9B (telecom)" },
  crc8_dvb_s2: { name: "CRC-8 DVB-S2", description: "CRC-8 polynomial 0xD5 (satellite)" },
  crc8_nissan: { name: "CRC-8 Nissan", description: "CRC-8 polynomial 0x85 (Nissan CAN)" },
  crc16_modbus: { name: "CRC-16 Modbus", description: "CRC-16 polynomial 0xA001 (Modbus)" },
  crc16_ccitt: { name: "CRC-16 CCITT", description: "CRC-16 polynomial 0x1021 (CCITT)" },
};

export const CHECKSUM_ALGORITHMS: AlgorithmInfo[] = (
  Object.entries(CHECKSUM_OUTPUT_BYTES) as [ChecksumAlgorithm, number][]
).map(([id, outputBytes]) => ({ id, outputBytes, ...ALGORITHM_LABELS[id] }));

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
