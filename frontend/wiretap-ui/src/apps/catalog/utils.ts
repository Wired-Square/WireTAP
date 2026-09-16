// ui/src/apps/catalog/utils.ts

import type { BitRange } from "../../components/BitPreview";

export type FormattedId = { primary: string; secondary?: string };

/**
 * Extract all mux selector ranges from a signal's path hierarchy.
 * This traverses the TOML structure following the path to find all parent muxes.
 *
 * For a path like ["frame", "can", "0x71F", "mux", "1", "mux", "signals", "0"],
 * this will return ranges for both mux selectors in the hierarchy.
 *
 * @param path - The full path to the signal/element
 * @param parsed - The parsed TOML catalog
 * @returns Array of BitRange objects for all mux selectors in the hierarchy
 */
export function extractMuxRangesFromPath(path: string[], parsed: any): BitRange[] {
  const ranges: BitRange[] = [];

  // Must be inside a frame (any protocol)
  if (path[0] !== "frame" || !path[1] || !path[2]) {
    return ranges;
  }

  const protocol = path[1];
  const frameKey = path[2];
  const frame = parsed?.frame?.[protocol]?.[frameKey];
  if (!frame) return ranges;

  // Traverse the path looking for "mux" segments
  // Each "mux" is followed by a case key (e.g., "1"), and might contain another "mux"
  let currentObj = frame;
  let i = 3; // Start after ["frame", "can", frameId]

  while (i < path.length) {
    const segment = path[i];

    if (segment === "mux") {
      // Found a mux level - extract its selector range
      const mux = currentObj?.mux;
      if (mux) {
        ranges.push({
          name: mux.name || "Mux",
          start_bit: mux.start_bit ?? 0,
          bit_length: mux.bit_length ?? 8,
          type: "mux",
        });

        // Move into the mux object
        currentObj = mux;
        i++;

        // Next segment should be a case key (e.g., "1", "2", etc.) or "cases" container
        if (i < path.length) {
          const caseKey = path[i];
          // Handle both direct case keys and cases container
          const caseObj = currentObj[caseKey] || currentObj.cases?.[caseKey];
          if (caseObj) {
            currentObj = caseObj;
          }
          i++;
        }
      } else {
        i++;
      }
    } else if (segment === "signals" || segment === "signal") {
      // Reached signals array, stop traversing
      break;
    } else {
      // Skip other segments (like case keys that weren't handled above)
      i++;
    }
  }

  return ranges;
}

/**
 * Extract all signal ranges from a frame, including those in mux cases along the path.
 *
 * @param path - The full path to the current element
 * @param parsed - The parsed TOML catalog
 * @param excludeIndex - Optional signal index to exclude (when editing)
 * @returns Array of BitRange objects for signals
 */
export function extractSignalRangesFromPath(
  path: string[],
  parsed: any,
  _excludeIndex?: number
): BitRange[] {
  const ranges: BitRange[] = [];

  // Must be inside a frame (any protocol)
  if (path[0] !== "frame" || !path[1] || !path[2]) {
    return ranges;
  }

  const protocol = path[1];
  const frameKey = path[2];
  const frame = parsed?.frame?.[protocol]?.[frameKey];
  if (!frame) return ranges;

  const addSignalRange = (signal: any, isExcluded: boolean) => {
    if (isExcluded) return;
    const start = signal.start_bit ?? 0;
    const length = signal.bit_length ?? 8;
    // Avoid duplicate entries
    const alreadyPresent = ranges.some(
      (r) =>
        r.type === "signal" &&
        r.start_bit === start &&
        r.bit_length === length &&
        r.name === (signal.name || "Signal")
    );
    if (!alreadyPresent) {
      ranges.push({
        name: signal.name || "Signal",
        start_bit: start,
        bit_length: length,
        type: "signal",
      });
    }
  };

  // Add frame-level signals
  const frameSignals = frame.signals || frame.signal || [];
  frameSignals.forEach((s: any) => addSignalRange(s, false));

  // Traverse the path to collect signals from mux cases along the way
  let currentObj = frame;
  let i = 3;

  // Determine if we're editing a signal and at what level
  const signalsIdx = path.findIndex((seg) => seg === "signals" || seg === "signal");
  const editingSignalIdx = signalsIdx >= 0 ? parseInt(path[signalsIdx + 1], 10) : undefined;

  while (i < path.length) {
    const segment = path[i];

    if (segment === "mux") {
      currentObj = currentObj?.mux;
      i++;

      // Next segment is case key
      if (i < path.length && currentObj) {
        const caseKey = path[i];
        const caseObj = currentObj[caseKey] || currentObj.cases?.[caseKey];
        if (caseObj) {
          // Add signals from this case
          const caseSignals = caseObj.signals || [];
          const isThisLevel = path[signalsIdx - 1] === caseKey;
          caseSignals.forEach((s: any, idx: number) => {
            const shouldExclude = isThisLevel && idx === editingSignalIdx;
            addSignalRange(s, shouldExclude);
          });
          currentObj = caseObj;
        }
        i++;
      }
    } else if (segment === "signals" || segment === "signal") {
      break;
    } else {
      i++;
    }
  }

  return ranges;
}

/**
 * Get the frame byte length from a parsed catalog based on the path.
 * Handles CAN, Modbus, and Serial protocols.
 *
 * For CAN: uses the frame's `length` field (default 8 bytes)
 * For Modbus: calculates from register count (each register = 2 bytes)
 * For Serial: uses the frame's `length` field (default 0)
 *
 * @param path - The path to the frame or element within a frame
 * @param parsed - The parsed TOML catalog
 * @returns The frame length in bytes
 */
export function getFrameByteLengthFromPath(path: string[], parsed: any): number {
  if (path[0] !== "frame" || !path[1] || !path[2]) {
    return 8; // Default fallback
  }

  const protocol = path[1];
  const frameKey = path[2];
  const frame = parsed?.frame?.[protocol]?.[frameKey];

  if (!frame) {
    return 8; // Default fallback
  }

  switch (protocol) {
    case "can":
      return frame.length ?? 8;

    case "modbus":
      // Modbus: length field = number of registers, each register = 2 bytes (16 bits)
      const registerCount = frame.length ?? 1;
      return registerCount * 2;

    case "serial":
      return frame.length ?? 0;

    default:
      return frame.length ?? 8;
  }
}

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
