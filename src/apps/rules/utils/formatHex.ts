// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

/**
 * Format a numeric ID as a hex string with 0x prefix, uppercase, zero-padded.
 * Padding matches the protocol field width (bytes * 2 hex digits).
 */
export function formatHexId(id: number, bytes: number = 2): string {
  return `0x${id.toString(16).toUpperCase().padStart(bytes * 2, "0")}`;
}
