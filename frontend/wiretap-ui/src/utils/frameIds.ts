// ui/src/utils/frameIds.ts

/**
 * Format a CAN frame id as hex or decimal with appropriate padding for extended IDs.
 */
export function formatFrameId(
  id: number,
  mode: "hex" | "decimal" = "hex",
  isExtended?: boolean
): string {
  if (mode === "decimal") return id.toString(10);
  const pad = isExtended ? 8 : 3;
  return `0x${id.toString(16).toUpperCase().padStart(pad, "0")}`;
}

/** Split a Modbus RTU frame id (`unit << 8 | function`) into its two bytes. */
export function splitModbusRtuId(id: number): { unit: number; func: number } {
  return { unit: (id >> 8) & 0xff, func: id & 0xff };
}

/**
 * Format a Modbus RTU frame id as `unit/function`. The unit is an address and
 * reads as decimal in either mode; the function code follows the id format.
 */
export function formatModbusRtuId(id: number, mode: "hex" | "decimal" = "hex"): string {
  const { unit, func } = splitModbusRtuId(id);
  const fn = mode === "decimal" ? String(func) : `0x${func.toString(16).toUpperCase().padStart(2, "0")}`;
  return `${unit}/${fn}`;
}

/** Format a frame id the way its protocol reads it. */
export function formatProtocolFrameId(
  protocol: string | undefined,
  id: number,
  mode: "hex" | "decimal" = "hex",
  isExtended?: boolean
): string {
  return protocol === "modbus_rtu" ? formatModbusRtuId(id, mode) : formatFrameId(id, mode, isExtended);
}

/**
 * Format a frame id for an editable text field: bare value with no "0x" prefix
 * or padding (the field's label already states the radix). Hex is upper-cased.
 */
export function formatFrameIdInput(id: number, mode: "hex" | "decimal" = "hex"): string {
  return mode === "decimal" ? id.toString(10) : id.toString(16).toUpperCase();
}

/**
 * Parse a user-typed frame id string into a number, honouring the active format
 * mode. In "auto" mode a leading "0x" forces hex, otherwise decimal. Returns
 * null when the text isn't a valid non-negative integer.
 */
export function parseFrameId(
  text: string,
  mode: "hex" | "decimal" | "auto" = "auto"
): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const hasHexPrefix = /^0x/i.test(trimmed);
  const radix = mode === "hex" || (mode === "auto" && hasHexPrefix) ? 16 : 10;
  // parseInt tolerates the "0x" prefix for base 16; strip it for decimal safety.
  const id = parseInt(radix === 16 ? trimmed.replace(/^0x/i, "") : trimmed, radix);
  return !isNaN(id) && id >= 0 ? id : null;
}
