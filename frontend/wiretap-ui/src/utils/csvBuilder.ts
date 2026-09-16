// src/utils/csvBuilder.ts
//
// Shared CSV builder utility. Centralises CSV construction with proper
// field escaping so callers don't need to hand-roll quoting logic.

/**
 * Escape a CSV field value.
 * Wraps in double-quotes if the value contains commas, quotes, or newlines.
 */
export function escapeCsvField(value: string | number): string {
  if (typeof value === "number") return String(value);
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a CSV string from headers and rows.
 * Each cell is escaped via `escapeCsvField`.
 */
export function buildCsv(
  headers: string[],
  rows: (string | number)[][],
): string {
  const lines: string[] = [headers.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * Format a byte array as a space-separated hex string ("AA BB CC").
 */
export function formatPayloadHex(payload: number[]): string {
  return payload
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}
