// ui/src/utils/frameDump.ts
// The exports Rust does not write: JSON frames and the raw byte formats

import type { FrameMessage } from "../types/frame";
import type { SerialBytesEntry } from "../stores/discoverySerialStore";
import { buildCsv } from "./csvBuilder";
import { formatFilenameDate } from "./timeFormat";

export type ExportFormat = "csv" | "json" | "candump" | "hex" | "bin";

/**
 * The CSV columns are SavvyCAN's and carry no protocol, so the file name does:
 * the CSV importer seeds its protocol from the stem's last `-` token.
 */
export function frameExportBasename(protocol: string | undefined, date: Date = new Date()): string {
  return `${formatFilenameDate(date)}-${protocol ?? "frames"}`;
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
  const headers = ["timestamp_us", "byte_hex", "byte_dec"];
  const rows: (string | number)[][] = bytes.map((entry) => [
    entry.timestampUs,
    entry.byte.toString(16).padStart(2, "0").toUpperCase(),
    entry.byte,
  ]);
  return buildCsv(headers, rows);
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
