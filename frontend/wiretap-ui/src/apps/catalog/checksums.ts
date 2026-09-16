// ui/src/apps/catalog/checksums.ts
//
// Re-exports checksum utilities from shared module for backwards compatibility.
// Checksum calculations are now handled by Rust via Tauri IPC.
// This module provides metadata and async API functions.

export {
  // Types
  type ChecksumAlgorithm,
  type AlgorithmInfo,
  type ChecksumValidationResult,

  // Algorithm metadata
  CHECKSUM_ALGORITHMS,
  getAlgorithmInfo,
  getAlgorithmOutputBytes,

  // Byte index utilities (sync for UI, async via IPC available too)
  resolveByteIndex,
  resolveByteIndexSync,
  formatByteIndex,

  // Async checksum functions (call Rust via Tauri IPC)
  calculateChecksum,
  validateChecksum,
} from "../../utils/analysis/checksums";
