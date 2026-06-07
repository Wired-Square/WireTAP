// ui/src/apps/catalog/validate.ts

import type { MetaFields, ValidationError, ProtocolType, ProtocolConfig, SerialProtocolConfig, ChecksumAlgorithm } from "./types";
import { protocolRegistry } from "./protocols";
import { CHECKSUM_ALGORITHMS, resolveByteIndexSync } from "./checksums";

export function validateMetaFields(meta: MetaFields): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!meta.name || meta.name.trim() === "") {
    errors.push({ field: "meta.name", message: "Name is required", path: ["meta", "name"] });
  }

  if (!meta.version || meta.version < 1) {
    errors.push({ field: "meta.version", message: "Version must be at least 1", path: ["meta", "version"] });
  }

  // NOTE: Protocol-specific config (endianness, interval, device_address, etc.)
  // is in [meta.<protocol>], not directly in meta

  return errors;
}


// CAN frame validation
export interface CanFrameFields {
  id: string;
  length: number;
  transmitter?: string;
  interval?: number;
  note?: string;
}

export interface ValidateCanFrameOptions {
  /** Existing CAN frame IDs already present in the catalog (e.g. Object.keys(parsed.frame.can)) */
  existingIds?: string[];
  /** If editing an existing ID, provide the old ID so uniqueness checks allow it */
  oldId?: string | null;
  /** Optional list of known peers; if provided and non-empty, transmitter must be in the list */
  availablePeers?: string[];
}

export function validateCanFrameFields(fields: CanFrameFields, opts: ValidateCanFrameOptions = {}): ValidationError[] {
  const errors: ValidationError[] = [];

  const id = (fields.id || "").trim();
  if (!id) {
    errors.push({ field: "frame.can.id", message: "ID is required", path: ["frame", "can"] });
    return errors;
  }

  // Accept 0x-prefixed hex or plain decimal (unsigned)
  const isHex = /^0x[0-9a-fA-F]+$/.test(id);
  const isDec = /^\d+$/.test(id);
  if (!isHex && !isDec) {
    errors.push({
      field: "frame.can.id",
      message: 'ID must be hex like "0x123" or a decimal number',
      path: ["frame", "can", id],
    });
  }

  // length (DLC)
  if (!Number.isFinite(fields.length) || !Number.isInteger(fields.length)) {
    errors.push({
      field: "frame.can.length",
      message: "Length (DLC) must be an integer",
      path: ["frame", "can", id, "length"],
    });
  } else if (fields.length < 0 || fields.length > 64) {
    errors.push({
      field: "frame.can.length",
      message: "Length (DLC) must be between 0 and 64",
      path: ["frame", "can", id, "length"],
    });
  }

  // interval
  if (fields.interval !== undefined) {
    if (!Number.isFinite(fields.interval) || !Number.isInteger(fields.interval)) {
      errors.push({
        field: "frame.can.tx.interval_ms",
        message: "Interval must be an integer (ms)",
        path: ["frame", "can", id, "tx", "interval_ms"],
      });
    } else if (fields.interval < 0) {
      errors.push({
        field: "frame.can.tx.interval_ms",
        message: "Interval must be >= 0",
        path: ["frame", "can", id, "tx", "interval_ms"],
      });
    }
  }

  // transmitter
  if (fields.transmitter) {
    const peers = opts.availablePeers || [];
    if (peers.length > 0 && !peers.includes(fields.transmitter)) {
      errors.push({
        field: "frame.can.transmitter",
        message: `Transmitter must be one of the known peers (${peers.join(", ")})`,
        path: ["frame", "can", id, "transmitter"],
      });
    }
  }

  // uniqueness
  const existing = new Set((opts.existingIds || []).map((x) => String(x)));
  const oldId = opts.oldId ? String(opts.oldId) : null;
  if (existing.has(id) && id !== oldId) {
    errors.push({
      field: "frame.can.id",
      message: `A CAN frame with ID ${id} already exists`,
      path: ["frame", "can", id],
    });
  }

  return errors;
}

// Signal validation
export interface SignalFields {
  name: string;
  start_bit: number;
  bit_length: number;
  factor?: number;
  offset?: number;
  unit?: string;
  signed?: boolean;
  endianness?: "little" | "big";
  min?: number;
  max?: number;
  format?: string;
  confidence?: string;
  enum?: Record<string, string>;
}

export function validateSignalFields(fields: SignalFields): ValidationError[] {
  const errors: ValidationError[] = [];
  const name = (fields.name || "").trim();

  if (!name) {
    errors.push({ field: "signal.name", message: "Name is required", path: ["signal", "name"] });
  }

  // Coerce to numbers to handle string values from form inputs
  const startBit = typeof fields.start_bit === "string" ? parseInt(fields.start_bit, 10) : fields.start_bit;
  const bitLength = typeof fields.bit_length === "string" ? parseInt(fields.bit_length, 10) : fields.bit_length;

  if (!Number.isInteger(startBit) || startBit < 0) {
    errors.push({
      field: "signal.start_bit",
      message: "Start bit must be a non-negative integer",
      path: ["signal", "start_bit"],
    });
  }

  // String formats (utf8, ascii, hex) can have longer bit lengths for multi-byte strings
  const isStringFormat = fields.format === "utf8" || fields.format === "ascii" || fields.format === "hex";
  const maxBitLength = isStringFormat ? 2048 : 64; // 256 bytes max for strings, 64 bits for numbers

  if (!Number.isInteger(bitLength) || bitLength <= 0 || bitLength > maxBitLength) {
    errors.push({
      field: "signal.bit_length",
      message: isStringFormat
        ? "Bit length must be an integer between 1 and 2048 for string formats"
        : "Bit length must be an integer between 1 and 64",
      path: ["signal", "bit_length"],
    });
  }

  if (fields.endianness && fields.endianness !== "little" && fields.endianness !== "big") {
    errors.push({
      field: "signal.endianness",
      message: 'Endianness must be "little" or "big"',
      path: ["signal", "endianness"],
    });
  }

  if (fields.factor !== undefined && !Number.isFinite(fields.factor)) {
    errors.push({
      field: "signal.factor",
      message: "Factor must be a number",
      path: ["signal", "factor"],
    });
  }

  if (fields.offset !== undefined && !Number.isFinite(fields.offset)) {
    errors.push({
      field: "signal.offset",
      message: "Offset must be a number",
      path: ["signal", "offset"],
    });
  }

  if (fields.min !== undefined && !Number.isFinite(fields.min)) {
    errors.push({
      field: "signal.min",
      message: "Min must be a number",
      path: ["signal", "min"],
    });
  }

  if (fields.max !== undefined && !Number.isFinite(fields.max)) {
    errors.push({
      field: "signal.max",
      message: "Max must be a number",
      path: ["signal", "max"],
    });
  }

  if (fields.min !== undefined && fields.max !== undefined && fields.min > fields.max) {
    errors.push({
      field: "signal.range",
      message: "Min cannot be greater than max",
      path: ["signal", "min"],
    });
  }

  if (fields.enum !== undefined) {
    const isRecord =
      fields.enum && typeof fields.enum === "object" && !Array.isArray(fields.enum) && fields.enum !== null;
    if (!isRecord) {
      errors.push({
        field: "signal.enum",
        message: "Enum must be a map of string keys to string values",
        path: ["signal", "enum"],
      });
    }
  }

  return errors;
}


// ============================================================================
// Checksum Validation
// ============================================================================

export interface ChecksumFields {
  name: string;
  algorithm: ChecksumAlgorithm;
  start_byte: number;
  byte_length: number;
  endianness?: "little" | "big";
  calc_start_byte: number;
  calc_end_byte: number;
  notes?: string;
}

export interface ValidateChecksumOptions {
  /** Frame length in bytes (for range validation) */
  frameLength?: number;
}

export function validateChecksumFields(
  fields: ChecksumFields,
  options: ValidateChecksumOptions = {}
): ValidationError[] {
  const errors: ValidationError[] = [];
  const frameLength = options.frameLength ?? 256;

  // Name validation
  const name = (fields.name || "").trim();
  if (!name) {
    errors.push({
      field: "checksum.name",
      message: "Name is required",
      path: ["checksum", "name"],
    });
  }

  // Algorithm validation
  const validAlgorithms = CHECKSUM_ALGORITHMS.map((a) => a.id);
  if (!fields.algorithm || !validAlgorithms.includes(fields.algorithm)) {
    errors.push({
      field: "checksum.algorithm",
      message: `Algorithm must be one of: ${validAlgorithms.join(", ")}`,
      path: ["checksum", "algorithm"],
    });
  }

  // Start byte validation - supports negative indexing
  if (!Number.isInteger(fields.start_byte)) {
    errors.push({
      field: "checksum.start_byte",
      message: "Start byte must be an integer",
      path: ["checksum", "start_byte"],
    });
  } else {
    const resolvedStart = resolveByteIndexSync(fields.start_byte, frameLength);
    if (resolvedStart < 0 || resolvedStart >= frameLength) {
      errors.push({
        field: "checksum.start_byte",
        message: fields.start_byte < 0
          ? `Start byte ${fields.start_byte} resolves to ${resolvedStart}, which is out of range [0, ${frameLength - 1}]`
          : `Start byte must be less than frame length (${frameLength})`,
        path: ["checksum", "start_byte"],
      });
    }
  }

  // Byte length validation
  if (!Number.isInteger(fields.byte_length) || fields.byte_length < 1 || fields.byte_length > 4) {
    errors.push({
      field: "checksum.byte_length",
      message: "Byte length must be an integer between 1 and 4",
      path: ["checksum", "byte_length"],
    });
  }

  // Check if checksum fits in frame (using resolved start byte)
  if (Number.isInteger(fields.start_byte)) {
    const resolvedStart = resolveByteIndexSync(fields.start_byte, frameLength);
    if (resolvedStart >= 0 && resolvedStart + fields.byte_length > frameLength) {
      errors.push({
        field: "checksum.start_byte",
        message: `Checksum position (byte ${resolvedStart} + ${fields.byte_length}) exceeds frame length (${frameLength})`,
        path: ["checksum", "start_byte"],
      });
    }
  }

  // Endianness validation
  if (fields.endianness && fields.endianness !== "little" && fields.endianness !== "big") {
    errors.push({
      field: "checksum.endianness",
      message: 'Endianness must be "little" or "big"',
      path: ["checksum", "endianness"],
    });
  }

  // Calculation range validation - supports negative indexing
  if (!Number.isInteger(fields.calc_start_byte)) {
    errors.push({
      field: "checksum.calc_start_byte",
      message: "Calculation start byte must be an integer",
      path: ["checksum", "calc_start_byte"],
    });
  } else {
    const resolvedCalcStart = resolveByteIndexSync(fields.calc_start_byte, frameLength);
    if (resolvedCalcStart < 0 || resolvedCalcStart >= frameLength) {
      errors.push({
        field: "checksum.calc_start_byte",
        message: fields.calc_start_byte < 0
          ? `Calculation start byte ${fields.calc_start_byte} resolves to ${resolvedCalcStart}, which is out of range`
          : "Calculation start byte must be within frame bounds",
        path: ["checksum", "calc_start_byte"],
      });
    }
  }

  if (!Number.isInteger(fields.calc_end_byte)) {
    errors.push({
      field: "checksum.calc_end_byte",
      message: "Calculation end byte must be an integer",
      path: ["checksum", "calc_end_byte"],
    });
  } else {
    const resolvedCalcEnd = resolveByteIndexSync(fields.calc_end_byte, frameLength);
    if (resolvedCalcEnd < 1 || resolvedCalcEnd > frameLength) {
      errors.push({
        field: "checksum.calc_end_byte",
        message: fields.calc_end_byte < 0
          ? `Calculation end byte ${fields.calc_end_byte} resolves to ${resolvedCalcEnd}, which is out of range`
          : `Calculation end byte (${fields.calc_end_byte}) exceeds frame length (${frameLength})`,
        path: ["checksum", "calc_end_byte"],
      });
    }
  }

  // Validate that resolved calc range is valid
  if (Number.isInteger(fields.calc_start_byte) && Number.isInteger(fields.calc_end_byte)) {
    const resolvedCalcStart = resolveByteIndexSync(fields.calc_start_byte, frameLength);
    const resolvedCalcEnd = resolveByteIndexSync(fields.calc_end_byte, frameLength);
    if (resolvedCalcStart >= resolvedCalcEnd) {
      errors.push({
        field: "checksum.calc_range",
        message: `Calculation range is invalid: start (${resolvedCalcStart}) must be less than end (${resolvedCalcEnd})`,
        path: ["checksum", "calc_start_byte"],
      });
    }
  }

  return errors;
}


// ============================================================================
// Generic Frame Validation (Protocol-Agnostic)
// ============================================================================

export interface ValidateFrameOptions {
  /** Existing frame keys for this protocol (for duplicate detection) */
  existingKeys?: string[];
  /** If editing, provide the original key so uniqueness checks allow it */
  originalKey?: string;
  /** Optional list of known peers; if provided, transmitter must be in the list */
  availablePeers?: string[];
}

/**
 * Validate a frame config using the protocol registry.
 * Delegates to the protocol handler's validateConfig method.
 */
export function validateFrameConfig(
  protocol: ProtocolType,
  config: ProtocolConfig,
  options: ValidateFrameOptions = {}
): ValidationError[] {
  const handler = protocolRegistry.get(protocol);
  if (!handler) {
    return [{ field: "protocol", message: `Unknown protocol: ${protocol}` }];
  }

  // Use the handler's validation
  return handler.validateConfig(config, options.existingKeys, options.originalKey);
}

/**
 * Validate common frame fields (length, transmitter, interval).
 * Used by UI components before saving.
 */
export interface CommonFrameFields {
  length?: number;
  transmitter?: string;
  interval?: number;
}

export function validateCommonFrameFields(
  fields: CommonFrameFields,
  options: { availablePeers?: string[]; maxLength?: number } = {}
): ValidationError[] {
  const errors: ValidationError[] = [];
  const maxLen = options.maxLength ?? 64;

  // Length validation
  if (fields.length !== undefined) {
    if (!Number.isFinite(fields.length) || !Number.isInteger(fields.length)) {
      errors.push({
        field: "length",
        message: "Length must be an integer",
      });
    } else if (fields.length < 0 || fields.length > maxLen) {
      errors.push({
        field: "length",
        message: `Length must be between 0 and ${maxLen}`,
      });
    }
  }

  // Interval validation
  if (fields.interval !== undefined) {
    if (!Number.isFinite(fields.interval) || !Number.isInteger(fields.interval)) {
      errors.push({
        field: "interval",
        message: "Interval must be an integer (ms)",
      });
    } else if (fields.interval < 0) {
      errors.push({
        field: "interval",
        message: "Interval must be >= 0",
      });
    }
  }

  // Transmitter validation
  if (fields.transmitter) {
    const peers = options.availablePeers ?? [];
    if (peers.length > 0 && !peers.includes(fields.transmitter)) {
      errors.push({
        field: "transmitter",
        message: `Transmitter must be one of the known peers (${peers.join(", ")})`,
      });
    }
  }

  return errors;
}

// ============================================================================
// Serial Protocol Config Validation
// ============================================================================

/**
 * Validate that serial config is present when serial frames exist.
 * This is a catalog-level validation that should run after parsing.
 *
 * @param hasSerialFrames - Whether the catalog has any frames under [frame.serial.*]
 * @param serialConfig - The parsed [frame.serial.config] section, if present
 */
export function validateSerialConfig(
  hasSerialFrames: boolean,
  serialConfig: SerialProtocolConfig | undefined
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (hasSerialFrames && !serialConfig?.encoding) {
    errors.push({
      field: "frame.serial.config.encoding",
      message: "Encoding is required when serial frames exist. Add [frame.serial.config] with encoding = \"slip\", \"cobs\", \"raw\", or \"length_prefixed\".",
      path: ["frame", "serial", "config", "encoding"],
    });
  }

  return errors;
}

export type { ValidationResult } from "../../api/catalog";
