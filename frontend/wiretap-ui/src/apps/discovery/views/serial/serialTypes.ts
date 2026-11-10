// ui/src/apps/discovery/views/serial/serialTypes.ts
//
// Shared types and utilities for serial discovery components.

import {
  type ChecksumAlgorithm,
  CHECKSUM_ALGORITHMS as SHARED_CHECKSUM_ALGORITHMS,
  calculateChecksum as calculateChecksumAsync,
  getAlgorithmOutputBytes,
} from '../../../../utils/analysis/checksums';
import { formatClockTime } from '../../../../utils/timeFormat';
import type { TFunction } from 'i18next';

// ============================================================================
// Types
// ============================================================================

export interface ExtractionConfig {
  startByte: number;  // Can be negative for end-relative indexing (e.g., -2 = 2 bytes from end)
  numBytes: number;
  endianness: 'big' | 'little';
}

// Extended checksum type for discovery (includes 'unknown' for unidentified checksums)
export type DiscoveryChecksumAlgorithm = ChecksumAlgorithm | 'unknown';

export interface ChecksumConfig extends ExtractionConfig {
  algorithm: DiscoveryChecksumAlgorithm;
  calcStartByte: number;  // Start of data to calculate checksum over (usually 0)
  calcEndByte: number;    // End of data (negative = relative to checksum position)
}

// ============================================================================
// Constants
// ============================================================================

export function checksumAlgorithmOptions(t: TFunction): { value: DiscoveryChecksumAlgorithm; label: string }[] {
  return [
    ...SHARED_CHECKSUM_ALGORITHMS.map(a => ({ value: a.id, label: a.name })),
    { value: 'unknown', label: t('discovery:serial.checksumUnknown') },
  ];
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Calculate checksum using Rust backend via Tauri IPC.
 * Returns 0 for 'unknown' algorithm.
 *
 * @param algorithm - The checksum algorithm to use
 * @param data - The data to calculate checksum over
 * @returns Promise resolving to the calculated checksum value
 */
export async function calculateChecksum(algorithm: DiscoveryChecksumAlgorithm, data: number[]): Promise<number> {
  if (algorithm === 'unknown') return 0;
  // Use the full data range (0 to data.length)
  return calculateChecksumAsync(algorithm, data, 0, data.length);
}

/**
 * Get the byte count for a checksum algorithm.
 * Returns 1 for 'unknown' algorithm.
 */
export function getChecksumByteCount(algorithm: DiscoveryChecksumAlgorithm): number {
  if (algorithm === 'unknown') return 1;
  return getAlgorithmOutputBytes(algorithm);
}

/** Format timestamp with microsecond precision */
export function formatTimestampUs(timestampUs: number): string {
  const date = new Date(timestampUs / 1000);
  const time = formatClockTime(date);
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const us = String(Math.floor(timestampUs % 1000)).padStart(3, '0');
  return `${time}.${ms}.${us}`;
}
