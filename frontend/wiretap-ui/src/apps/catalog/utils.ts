// ui/src/apps/catalog/utils.ts

export type FormattedId = { primary: string; secondary?: string };

export function parseCanIdToNumber(id: string | number | null | undefined): number | null {
  if (id === null || id === undefined) return null;
  const str = String(id).trim();
  if (/^0x[0-9a-fA-F]+$/.test(str)) return parseInt(str, 16);
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  return null;
}

export function formatFrameId(id: string, display: "hex" | "decimal"): FormattedId {
  const numeric = parseCanIdToNumber(id);

  // Format hex: uppercase, no 0x prefix, padded (3 chars for 11-bit, 8 for 29-bit)
  let hex: string;
  if (numeric !== null) {
    // 11-bit standard IDs are 0x000-0x7FF, 29-bit extended are larger
    const isExtended = numeric > 0x7FF;
    const padLength = isExtended ? 8 : 3;
    hex = numeric.toString(16).toUpperCase().padStart(padLength, '0');
  } else {
    hex = id;
  }

  const dec = numeric !== null ? String(numeric) : id;

  return display === "hex"
    ? { primary: hex, secondary: numeric !== null ? dec : undefined }
    : { primary: dec, secondary: numeric !== null ? hex : undefined };
}
