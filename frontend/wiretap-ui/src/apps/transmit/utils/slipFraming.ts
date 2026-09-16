// src/apps/transmit/utils/slipFraming.ts
//
// SLIP (Serial Line Internet Protocol) framing utilities.
// RFC 1055: https://datatracker.ietf.org/doc/html/rfc1055

/** SLIP special characters */
export const SLIP = {
  /** End of frame marker */
  END: 0xc0,
  /** Escape character */
  ESC: 0xdb,
  /** Escaped END (ESC + ESC_END = END in data) */
  ESC_END: 0xdc,
  /** Escaped ESC (ESC + ESC_ESC = ESC in data) */
  ESC_ESC: 0xdd,
} as const;

/**
 * Encode data using SLIP framing.
 *
 * Wraps the data with END characters and escapes any END or ESC
 * characters within the data.
 *
 * @param data - Raw bytes to encode
 * @returns SLIP-framed bytes
 */
export function slipEncode(data: number[]): number[] {
  const framed: number[] = [SLIP.END];

  for (const byte of data) {
    if (byte === SLIP.END) {
      framed.push(SLIP.ESC, SLIP.ESC_END);
    } else if (byte === SLIP.ESC) {
      framed.push(SLIP.ESC, SLIP.ESC_ESC);
    } else {
      framed.push(byte);
    }
  }

  framed.push(SLIP.END);
  return framed;
}

/**
 * Decode SLIP-framed data.
 *
 * Removes framing and unescapes special characters.
 *
 * @param data - SLIP-framed bytes
 * @returns Decoded bytes
 */
export function slipDecode(data: number[]): number[] {
  const decoded: number[] = [];
  let i = 0;

  // Skip leading END if present
  if (data[i] === SLIP.END) {
    i++;
  }

  while (i < data.length) {
    const byte = data[i];

    if (byte === SLIP.END) {
      // End of frame
      break;
    } else if (byte === SLIP.ESC) {
      // Escape sequence
      i++;
      if (i >= data.length) break;

      const escaped = data[i];
      if (escaped === SLIP.ESC_END) {
        decoded.push(SLIP.END);
      } else if (escaped === SLIP.ESC_ESC) {
        decoded.push(SLIP.ESC);
      } else {
        // Invalid escape, include as-is
        decoded.push(escaped);
      }
    } else {
      decoded.push(byte);
    }

    i++;
  }

  return decoded;
}

/**
 * Apply framing to bytes based on the framing mode.
 *
 * @param bytes - Raw bytes to frame
 * @param mode - Framing mode: "raw", "slip", or "delimiter"
 * @param delimiter - Delimiter bytes (used when mode is "delimiter")
 * @returns Framed bytes
 */
export function applyFraming(
  bytes: number[],
  mode: "raw" | "slip" | "delimiter",
  delimiter: number[] = [0x0d, 0x0a]
): number[] {
  switch (mode) {
    case "slip":
      return slipEncode(bytes);
    case "delimiter":
      return [...bytes, ...delimiter];
    case "raw":
    default:
      return bytes;
  }
}
