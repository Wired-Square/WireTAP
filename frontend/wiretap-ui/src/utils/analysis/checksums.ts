// ui/src/utils/analysis/checksums.ts
//
// Checksum utilities for frame validation.
// Calculation functions are implemented in Rust and called via Tauri IPC.
// This module provides metadata and re-exports the async API functions.

// Re-export async API functions from Tauri wrappers
export {
  calculateChecksum,
  validateChecksum,
  resolveByteIndex,
  type ChecksumAlgorithm,
  type ChecksumValidationResult,
} from "../../api/checksums";

// ============================================================================
// Types
// ============================================================================

export interface AlgorithmInfo {
  id: import("../../api/checksums").ChecksumAlgorithm;
  name: string;
  description: string;
  outputBytes: number;
}

// ============================================================================
// Algorithm Metadata (kept in TypeScript for UI rendering)
// ============================================================================

export const CHECKSUM_ALGORITHMS: AlgorithmInfo[] = [
  {
    id: "xor",
    name: "XOR",
    description: "XOR of all bytes (8-bit)",
    outputBytes: 1,
  },
  {
    id: "sum8",
    name: "Sum (8-bit)",
    description: "Simple sum of bytes modulo 256",
    outputBytes: 1,
  },
  {
    id: "crc8",
    name: "CRC-8",
    description: "CRC-8 polynomial 0x07 (ITU/SMBUS)",
    outputBytes: 1,
  },
  {
    id: "crc8_sae_j1850",
    name: "CRC-8 SAE-J1850",
    description: "CRC-8 polynomial 0x1D (automotive OBD-II)",
    outputBytes: 1,
  },
  {
    id: "crc8_autosar",
    name: "CRC-8 AUTOSAR",
    description: "CRC-8 polynomial 0x2F (AUTOSAR E2E)",
    outputBytes: 1,
  },
  {
    id: "crc8_maxim",
    name: "CRC-8 Maxim",
    description: "CRC-8 polynomial 0x31 (1-Wire devices)",
    outputBytes: 1,
  },
  {
    id: "crc8_cdma2000",
    name: "CRC-8 CDMA2000",
    description: "CRC-8 polynomial 0x9B (telecom)",
    outputBytes: 1,
  },
  {
    id: "crc8_dvb_s2",
    name: "CRC-8 DVB-S2",
    description: "CRC-8 polynomial 0xD5 (satellite)",
    outputBytes: 1,
  },
  {
    id: "crc8_nissan",
    name: "CRC-8 Nissan",
    description: "CRC-8 polynomial 0x85 (Nissan CAN)",
    outputBytes: 1,
  },
  {
    id: "crc16_modbus",
    name: "CRC-16 Modbus",
    description: "CRC-16 polynomial 0xA001 (Modbus)",
    outputBytes: 2,
  },
  {
    id: "crc16_ccitt",
    name: "CRC-16 CCITT",
    description: "CRC-16 polynomial 0x1021 (CCITT)",
    outputBytes: 2,
  },
];

/**
 * Get algorithm info by ID.
 */
export function getAlgorithmInfo(
  algorithm: import("../../api/checksums").ChecksumAlgorithm
): AlgorithmInfo | undefined {
  return CHECKSUM_ALGORITHMS.find((a) => a.id === algorithm);
}

/**
 * Get the expected output size in bytes for an algorithm.
 */
export function getAlgorithmOutputBytes(
  algorithm: import("../../api/checksums").ChecksumAlgorithm
): number {
  return getAlgorithmInfo(algorithm)?.outputBytes ?? 1;
}

// ============================================================================
// Synchronous Byte Index Utilities (for UI display, no IPC needed)
// ============================================================================

/**
 * Resolve a byte index synchronously, supporting Python-style negative indexing.
 * Negative indices count from the end: -1 = last byte, -2 = second-to-last, etc.
 *
 * Note: This is a synchronous version for UI display. The async version
 * `resolveByteIndex` calls Rust and should be used when precision matters.
 *
 * @param index - The byte index (can be negative)
 * @param frameLength - Total frame length in bytes
 * @returns The resolved absolute byte index
 */
export function resolveByteIndexSync(index: number, frameLength: number): number {
  if (index >= 0) {
    return index;
  }
  // Negative: count from end
  // -1 -> frameLength - 1 (last byte)
  // -2 -> frameLength - 2 (second-to-last)
  return Math.max(0, frameLength + index);
}

/**
 * Format a byte index for display, showing both the value and its meaning.
 * @param index - The byte index (can be negative)
 * @param frameLength - Total frame length in bytes (optional, for resolution)
 */
export function formatByteIndex(index: number, frameLength?: number): string {
  if (index >= 0) {
    return `${index}`;
  }
  if (frameLength !== undefined) {
    const resolved = resolveByteIndexSync(index, frameLength);
    return `${index} (byte ${resolved})`;
  }
  return `${index} (from end)`;
}
