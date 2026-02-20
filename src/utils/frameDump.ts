// ui/src/utils/frameDump.ts
// Frame dump export utilities for various formats

import type { FrameMessage } from "../types/frame";
import type { SerialBytesEntry } from "../stores/discoverySerialStore";
import { CAN_FD_DLC_VALUES } from "../constants";

export type ExportFormat = "csv" | "json" | "candump" | "hex" | "bin";

/**
 * Find the smallest valid CAN FD DLC value that fits the given byte count.
 * For standard CAN (≤8 bytes), returns the exact count.
 * For CAN FD (>8 bytes), returns the smallest valid DLC (12, 16, 20, 24, 32, 48, or 64).
 */
function findSmallestFittingDlc(byteCount: number): number {
  if (byteCount <= 8) return byteCount;
  for (const dlc of CAN_FD_DLC_VALUES) {
    if (dlc >= byteCount) return dlc;
  }
  return CAN_FD_DLC_VALUES[CAN_FD_DLC_VALUES.length - 1]; // 64
}

/**
 * Export frames to CSV format
 * Format: Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,...,Dn
 * Columns use the smallest valid CAN FD DLC that fits the largest frame
 */
export function exportToCsv(frames: FrameMessage[]): string {
  const lines: string[] = [];

  // Find max bytes across all frames, then round up to valid CAN FD DLC
  const maxBytes = frames.reduce((max, f) => Math.max(max, f.dlc, f.bytes.length), 0);
  const maxDataLen = findSmallestFittingDlc(maxBytes);

  // Build header with dynamic number of data columns
  const dataHeaders = Array.from({ length: maxDataLen }, (_, i) => `D${i + 1}`);
  lines.push(["Time Stamp", "ID", "Extended", "Dir", "Bus", "LEN", ...dataHeaders].join(","));

  for (const frame of frames) {
    // Format data bytes as hex (uppercase), pad to maxDataLen columns
    const bytes = Array.from({ length: maxDataLen }, (_, i) =>
      i < frame.dlc && frame.bytes[i] !== undefined
        ? frame.bytes[i].toString(16).padStart(2, "0").toUpperCase()
        : ""
    );

    // Frame ID in hex without 0x prefix
    const idHex = frame.frame_id.toString(16).padStart(8, "0").toUpperCase();

    // Direction: Rx for received, Tx for transmitted
    const dir = frame.direction === "tx" ? "Tx" : "Rx";

    lines.push([
      frame.timestamp_us,
      idHex,
      frame.is_extended ? "true" : "false",
      dir,
      frame.bus,
      frame.dlc,
      ...bytes,
    ].join(","));
  }

  return lines.join("\n");
}

/**
 * Export frames to JSON format
 */
export function exportToJson(frames: FrameMessage[]): string {
  const exportFrames = frames.map((frame) => ({
    timestamp_us: frame.timestamp_us,
    frame_id: frame.frame_id,
    frame_id_hex: `0x${frame.frame_id.toString(16).toUpperCase()}`,
    bus: frame.bus,
    dlc: frame.dlc,
    is_extended: frame.is_extended ?? false,
    is_fd: frame.is_fd ?? false,
    bytes: frame.bytes,
    bytes_hex: frame.bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()),
  }));

  return JSON.stringify(exportFrames, null, 2);
}

/**
 * Export frames to candump log format
 * Format: (timestamp) interface frame_id#data
 * Example: (1234567890.123456) can0 123#DEADBEEF
 */
export function exportToCandump(frames: FrameMessage[]): string {
  const lines: string[] = [];

  for (const frame of frames) {
    const timestampSec = frame.timestamp_us / 1_000_000;
    const interface_ = `can${frame.bus}`;

    // Format frame ID with extended flag if needed
    let idStr = frame.frame_id.toString(16).toUpperCase();
    if (frame.is_extended) {
      idStr = idStr.padStart(8, "0");
    } else {
      idStr = idStr.padStart(3, "0");
    }

    // Format data bytes
    const dataHex = frame.bytes
      .slice(0, frame.dlc)
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join("");

    lines.push(`(${timestampSec.toFixed(6)}) ${interface_} ${idStr}#${dataHex}`);
  }

  return lines.join("\n");
}

/**
 * Export frames to the specified format
 */
export function exportFrames(frames: FrameMessage[], format: ExportFormat): string {
  switch (format) {
    case "csv":
      return exportToCsv(frames);
    case "json":
      return exportToJson(frames);
    case "candump":
      return exportToCandump(frames);
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

/**
 * Export bytes to hex dump format with timestamps
 * Format: timestamp_us: XX XX XX XX ...
 */
export function exportBytesToHex(bytes: SerialBytesEntry[]): string {
  if (bytes.length === 0) return "";

  const lines: string[] = [];
  let currentLine: number[] = [];
  let lineStartTime = bytes[0]?.timestampUs ?? 0;

  for (const entry of bytes) {
    // Start a new line every 16 bytes or when there's a time gap > 1ms
    if (currentLine.length >= 16 || (currentLine.length > 0 && entry.timestampUs - lineStartTime > 1000)) {
      const hexStr = currentLine.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      const asciiStr = currentLine.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
      lines.push(`${lineStartTime}: ${hexStr.padEnd(48)}  |${asciiStr}|`);
      currentLine = [];
      lineStartTime = entry.timestampUs;
    }

    if (currentLine.length === 0) {
      lineStartTime = entry.timestampUs;
    }
    currentLine.push(entry.byte);
  }

  // Flush remaining bytes
  if (currentLine.length > 0) {
    const hexStr = currentLine.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const asciiStr = currentLine.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    lines.push(`${lineStartTime}: ${hexStr.padEnd(48)}  |${asciiStr}|`);
  }

  return lines.join('\n');
}

/**
 * Export bytes to raw binary
 */
export function exportBytesToBinary(bytes: SerialBytesEntry[]): Uint8Array {
  return new Uint8Array(bytes.map(e => e.byte));
}

/**
 * Export bytes to CSV format
 * Format: timestamp_us,byte_hex,byte_dec
 */
export function exportBytesToCsv(bytes: SerialBytesEntry[]): string {
  const lines: string[] = ['timestamp_us,byte_hex,byte_dec'];

  for (const entry of bytes) {
    const hexStr = entry.byte.toString(16).padStart(2, '0').toUpperCase();
    lines.push(`${entry.timestampUs},${hexStr},${entry.byte}`);
  }

  return lines.join('\n');
}

/**
 * Export bytes to the specified format
 */
export function exportBytes(bytes: SerialBytesEntry[], format: ExportFormat): string | Uint8Array {
  switch (format) {
    case "hex":
      return exportBytesToHex(bytes);
    case "bin":
      return exportBytesToBinary(bytes);
    case "csv":
      return exportBytesToCsv(bytes);
    default:
      throw new Error(`Unknown bytes export format: ${format}`);
  }
}
