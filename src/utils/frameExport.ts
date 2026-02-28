// ui/src/utils/frameExport.ts

import {
  type FrameKnowledge,
  type SignalKnowledge,
  type MuxKnowledge,
  type MuxCaseKnowledge,
  createDefaultSignalsForFrame,
  createDefaultHexSignal,
} from './decoderKnowledge';
import type { MultiBytePattern } from './analysis/payloadAnalysis';

export type ExportMeta = {
  name: string;
  version: number;
  default_byte_order: "little" | "big";
  default_interval: number;
  default_frame?: string;
};

/**
 * Checksum configuration for serial frames
 */
export type SerialChecksumConfig = {
  /** Checksum algorithm (e.g., "sum8", "crc16_modbus", "xor") */
  algorithm: string;
  /** Byte position where checksum is stored (supports negative indexing) */
  start_byte: number;
  /** Number of bytes for the checksum value (1 or 2) */
  byte_length: number;
  /** Start of calculation range */
  calc_start_byte: number;
  /** End of calculation range (exclusive, supports negative indexing) */
  calc_end_byte: number;
  /** Whether checksum value is big-endian (default: false = little-endian) */
  big_endian?: boolean;
};

/**
 * Serial frame configuration - stored in [frame.serial.config]
 * Used by Decoder to extract frame IDs and source addresses from serial frames.
 */
/** Header field definition for serial protocols */
export type SerialHeaderFieldDef = {
  /** Field name (e.g., "id", "source_address", "Type", "Command") */
  name: string;
  /** Bitmask over header bytes */
  mask: number;
  /** Byte order for multi-byte fields */
  byte_order?: "big" | "little";
  /** Display format */
  format?: "hex" | "decimal";
  /** Start byte position (computed from mask) */
  start_byte: number;
  /** Number of bytes (computed from mask) */
  bytes: number;
};

export type SerialFrameConfig = {
  /** Default byte order for signal decoding (can be overridden per signal) */
  default_byte_order?: "big" | "little";
  /** Framing encoding type (e.g., "slip", "modbus_rtu", "raw") */
  encoding?: string;
  /** Frame ID extraction: start byte position (0-indexed, can be negative for end-relative) */
  frame_id_start_byte?: number;
  /** Frame ID extraction: number of bytes (1 or 2) */
  frame_id_bytes?: number;
  /** Frame ID extraction: byte order */
  frame_id_byte_order?: "big" | "little";
  /** Mask applied to extracted frame_id before matching catalog entries (e.g., 0xFF00 to match only first byte) */
  frame_id_mask?: number;
  /** Source address extraction: start byte position (0-indexed, can be negative) */
  source_address_start_byte?: number;
  /** Source address extraction: number of bytes (1 or 2) */
  source_address_bytes?: number;
  /** Source address extraction: byte order */
  source_address_byte_order?: "big" | "little";
  /** Minimum frame length to accept (frames shorter are dropped) */
  min_frame_length?: number;
  /** Checksum configuration detected from analysis */
  checksum?: SerialChecksumConfig;
  /** Global header length in bytes (for protocols with fixed header size) */
  header_length?: number;
  /** All header field definitions from [meta.serial.fields] */
  header_fields?: SerialHeaderFieldDef[];
};

export type ExportFrame = {
  id: number;
  len: number;
  isExtended?: boolean;
  /** Protocol type (e.g., "can", "serial", "modbus") - defaults to "can" */
  protocol?: string;
};

export type ExportFrameWithKnowledge = ExportFrame & {
  knowledge?: FrameKnowledge;
};

/**
 * Determine the protocol type from a list of frames.
 * Returns the protocol from the first frame, or "can" as default.
 */
function detectProtocol(frames: ExportFrame[]): string {
  for (const f of frames) {
    if (f.protocol) {
      return f.protocol;
    }
  }
  return "can";
}

/**
 * Build TOML content for a set of frames (basic version without knowledge).
 * `formatId` should return the id string as it should appear in TOML (hex or decimal).
 * Protocol is auto-detected from frames, falling back to "can".
 * For serial protocol, optionally include a [frame.serial.config] section.
 */
export function buildFramesToml(
  frames: ExportFrame[],
  meta: ExportMeta,
  formatId: (id: number, isExtended?: boolean) => string,
  serialConfig?: SerialFrameConfig
): string {
  const protocol = detectProtocol(frames);
  const lines: string[] = [];
  lines.push("[meta]");
  lines.push(`name = "${meta.name.replace(/"/g, '\\"')}"`);
  lines.push(`version = ${Math.max(1, meta.version)}`);
  lines.push(`default_byte_order = "${meta.default_byte_order}"`);
  lines.push(`default_frame = "${protocol}"`);
  lines.push(`default_interval = ${Math.max(0, meta.default_interval)}`);
  lines.push("");

  // Add serial config section if protocol is serial and config is provided
  if (protocol === "serial" && serialConfig) {
    writeSerialConfigSection(lines, serialConfig);
  }

  frames.forEach((f) => {
    const idStr = formatId(f.id, f.isExtended);
    lines.push(`[frame.${protocol}."${idStr}"]`);
    lines.push(`length = ${f.len}`);
    lines.push("");
  });

  return lines.join("\n");
}

/**
 * Write the [frame.serial.config] section to TOML lines.
 * Only includes fields that have meaningful values.
 */
function writeSerialConfigSection(lines: string[], config: SerialFrameConfig, meta?: ExportMeta): void {
  // Always write [meta.serial] for serial protocol
  lines.push("[meta.serial]");

  // Add default byte order and interval from meta
  if (meta) {
    lines.push(`default_byte_order = "${meta.default_byte_order}"`);
    lines.push(`default_interval = ${Math.max(0, meta.default_interval)}`);
  }

  if (config.encoding) {
    lines.push(`encoding = "${config.encoding}"`);
  }

  if (config.frame_id_start_byte !== undefined && config.frame_id_bytes !== undefined) {
    lines.push(`frame_id_start_byte = ${config.frame_id_start_byte}`);
    lines.push(`frame_id_bytes = ${config.frame_id_bytes}`);
    if (config.frame_id_byte_order) {
      lines.push(`frame_id_byte_order = "${config.frame_id_byte_order}"`);
    }
    if (config.frame_id_mask !== undefined) {
      lines.push(`frame_id_mask = 0x${config.frame_id_mask.toString(16).toUpperCase()}`);
    }
  }

  if (config.source_address_start_byte !== undefined && config.source_address_bytes !== undefined) {
    lines.push(`source_address_start_byte = ${config.source_address_start_byte}`);
    lines.push(`source_address_bytes = ${config.source_address_bytes}`);
    if (config.source_address_byte_order) {
      lines.push(`source_address_byte_order = "${config.source_address_byte_order}"`);
    }
  }

  if (config.min_frame_length !== undefined && config.min_frame_length > 0) {
    lines.push(`min_frame_length = ${config.min_frame_length}`);
  }

  if (config.header_length !== undefined && config.header_length > 0) {
    lines.push(`header_length = ${config.header_length}`);
  }

  // Write checksum configuration if detected
  if (config.checksum) {
    lines.push("");
    lines.push("# Checksum configuration (detected from analysis)");
    lines.push(`checksum_algorithm = "${config.checksum.algorithm}"`);
    lines.push(`checksum_start_byte = ${config.checksum.start_byte}`);
    lines.push(`checksum_byte_length = ${config.checksum.byte_length}`);
    lines.push(`checksum_calc_start_byte = ${config.checksum.calc_start_byte}`);
    lines.push(`checksum_calc_end_byte = ${config.checksum.calc_end_byte}`);
    if (config.checksum.big_endian) {
      lines.push(`checksum_big_endian = true`);
    }
  }

  lines.push("");
}

/**
 * Build TOML content for frames with decoder knowledge (notes, signals, mux).
 * `formatId` should return the id string as it should appear in TOML (hex or decimal).
 * Protocol is auto-detected from frames, falling back to "can".
 * For serial protocol, optionally include a [frame.serial.config] section.
 */
export function buildFramesTomlWithKnowledge(
  frames: ExportFrameWithKnowledge[],
  meta: ExportMeta,
  formatId: (id: number, isExtended?: boolean) => string,
  serialConfig?: SerialFrameConfig
): string {
  const protocol = detectProtocol(frames);
  const lines: string[] = [];

  // [meta] section
  lines.push("[meta]");
  lines.push(`name = "${meta.name.replace(/"/g, '\\"')}"`);
  lines.push(`version = ${Math.max(1, meta.version)}`);
  lines.push(`default_frame = "${protocol}"`);
  lines.push("");

  // Add protocol-specific config section with byte order and interval
  if (protocol === "can") {
    lines.push("[meta.can]");
    lines.push(`default_byte_order = "${meta.default_byte_order}"`);
    lines.push(`default_interval = ${Math.max(0, meta.default_interval)}`);
    lines.push("");
  } else if (protocol === "serial" && serialConfig) {
    // Serial config includes encoding and frame extraction settings
    writeSerialConfigSection(lines, serialConfig, meta);
  } else if (protocol === "serial") {
    // Serial without config - just add basic meta.serial section
    lines.push("[meta.serial]");
    lines.push(`default_byte_order = "${meta.default_byte_order}"`);
    lines.push(`default_interval = ${Math.max(0, meta.default_interval)}`);
    lines.push("");
  }

  // Frame sections
  frames.forEach((f) => {
    const idStr = formatId(f.id, f.isExtended);
    const knowledge = f.knowledge;

    // Frame header
    lines.push(`[frame.${protocol}."${idStr}"]`);
    lines.push(`length = ${f.len}`);

    // Add notes field if present
    if (knowledge?.notes && knowledge.notes.length > 0) {
      if (knowledge.notes.length === 1) {
        // Single note: write as string
        const escaped = knowledge.notes[0].replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.push(`notes = "${escaped}"`);
      } else {
        // Multiple notes: write as array
        lines.push(`notes = [`);
        for (const note of knowledge.notes) {
          const escaped = note.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          lines.push(`    "${escaped}",`);
        }
        lines.push(`]`);
      }
    }

    // Add interval if known and different from default
    if (knowledge?.intervalMs !== undefined && knowledge.intervalMs !== meta.default_interval) {
      lines.push(`interval = ${knowledge.intervalMs}`);
    }

    // Add mux configuration if present
    if (knowledge?.mux) {
      lines.push("");
      writeMuxSection(lines, knowledge.mux, idStr, f.len, meta.default_byte_order, protocol);
      // For mux frames, signals are written inside each case section, not at frame level
    } else {
      // Non-mux frames: add signals at frame level (including default hex signals for unclaimed bytes)
      const existingSignals = knowledge?.signals ?? [];
      const defaultSignals = createDefaultSignalsForFrame(
        f.len,
        knowledge?.mux,
        existingSignals,
        knowledge?.multiBytePatterns,
        meta.default_byte_order,
        serialConfig  // Pass serial config to exclude ID/source/checksum bytes
      );
      const allSignals = [...existingSignals, ...defaultSignals];

      if (allSignals.length > 0) {
        lines.push("");
        for (const signal of allSignals) {
          writeSignalSection(lines, signal, idStr, protocol);
        }
      }
    }

    lines.push("");
  });

  return lines.join("\n");
}

/**
 * Write a mux section to TOML lines.
 * For 2D muxes (byte[0:1]), creates nested mux structure.
 */
function writeMuxSection(
  lines: string[],
  mux: MuxKnowledge,
  frameIdStr: string,
  frameLength: number,
  defaultEndianness: 'little' | 'big',
  protocol: string
): void {
  if (mux.isTwoByte) {
    // 2D mux: byte[0] is outer selector, byte[1] is inner selector
    write2DMuxSection(lines, mux, frameIdStr, frameLength, defaultEndianness, protocol);
  } else {
    // 1D mux: single byte selector
    write1DMuxSection(lines, mux, frameIdStr, frameLength, defaultEndianness, protocol);
  }
}

/**
 * Write a 1D mux section (single byte selector)
 */
function write1DMuxSection(
  lines: string[],
  mux: MuxKnowledge,
  frameIdStr: string,
  frameLength: number,
  defaultEndianness: 'little' | 'big',
  protocol: string
): void {
  lines.push(`# Multiplexed frame (selector at byte ${mux.selectorByte})`);
  lines.push(`[frame.${protocol}."${frameIdStr}".mux]`);
  lines.push(`selector_start_bit = ${mux.selectorStartBit}`);
  lines.push(`selector_bit_length = ${mux.selectorBitLength}`);

  // List the mux cases as a comment
  if (mux.cases.length > 0) {
    lines.push(`# Mux cases: ${mux.cases.map(c => `0x${c.toString(16).toUpperCase()}`).join(', ')}`);
  }

  // Write each mux case with its signals
  for (const caseValue of mux.cases) {
    const caseKnowledge = mux.caseKnowledge?.get(caseValue);
    writeMuxCaseSection(
      lines,
      frameIdStr,
      caseValue,
      caseKnowledge,
      mux,
      frameLength,
      defaultEndianness,
      protocol
    );
  }
}

/**
 * Write a 2D mux section (two-byte selector: byte[0] outer, byte[1] inner)
 * Structure:
 *   [frame.{protocol}."ID".mux] - outer mux (byte 0)
 *   [frame.{protocol}."ID".mux."OUTER".mux] - inner mux definition (byte 1)
 *   [[frame.{protocol}."ID".mux."OUTER".mux."INNER".signals]] - signals
 */
function write2DMuxSection(
  lines: string[],
  mux: MuxKnowledge,
  frameIdStr: string,
  frameLength: number,
  defaultEndianness: 'little' | 'big',
  protocol: string
): void {
  // Group cases by outer value (high byte for 16-bit mux values)
  const outerCases = new Map<number, number[]>();
  for (const caseValue of mux.cases) {
    const outerValue = (caseValue >> 8) & 0xFF;  // Byte 0
    const innerValue = caseValue & 0xFF;          // Byte 1
    if (!outerCases.has(outerValue)) {
      outerCases.set(outerValue, []);
    }
    outerCases.get(outerValue)!.push(innerValue);
  }

  // Write outer mux definition
  lines.push(`# 2D Multiplexed frame (selector at byte[0:1])`);
  lines.push(`[frame.${protocol}."${frameIdStr}".mux]`);
  lines.push(`selector_start_bit = 0`);
  lines.push(`selector_bit_length = 8`);

  const outerValues = Array.from(outerCases.keys()).sort((a, b) => a - b);
  lines.push(`# Outer mux cases (byte 0): ${outerValues.map(c => String(c)).join(', ')}`);

  // Write each outer case with its inner mux
  for (const outerValue of outerValues) {
    const innerValues = outerCases.get(outerValue)!.sort((a, b) => a - b);
    const outerStr = String(outerValue);

    lines.push('');
    lines.push(`[frame.${protocol}."${frameIdStr}".mux."${outerStr}".mux]`);
    lines.push(`selector_start_bit = 8`);
    lines.push(`selector_bit_length = 8`);
    lines.push(`# Inner mux cases (byte 1): ${innerValues.map(c => String(c)).join(', ')}`);

    // Write each inner case with its signals
    for (const innerValue of innerValues) {
      const fullCaseValue = (outerValue << 8) | innerValue;
      const caseKnowledge = mux.caseKnowledge?.get(fullCaseValue);
      const innerStr = String(innerValue);

      // Generate signals for this case
      const signals = generateMuxCaseSignals(
        caseKnowledge,
        mux,
        frameLength,
        defaultEndianness
      );

      // Write signals for this inner case
      for (const signal of signals) {
        write2DMuxCaseSignalSection(lines, signal, frameIdStr, outerStr, innerStr, protocol);
      }
    }
  }
}

/**
 * Write a signal section for a 2D mux case
 */
function write2DMuxCaseSignalSection(
  lines: string[],
  signal: SignalKnowledge,
  frameIdStr: string,
  outerCaseStr: string,
  innerCaseStr: string,
  protocol: string
): void {
  const signalName = sanitizeSignalName(signal.name);
  lines.push(`[[frame.${protocol}."${frameIdStr}".mux."${outerCaseStr}".mux."${innerCaseStr}".signals]]`);
  lines.push(`name = "${signalName}"`);
  lines.push(`start_bit = ${signal.startBit}`);
  lines.push(`bit_length = ${signal.bitLength}`);

  if (signal.format) {
    lines.push(`format = "${signal.format}"`);
  }

  if (signal.endianness) {
    lines.push(`byte_order = "${signal.endianness}"`);
  }

  if (signal.source !== 'default') {
    lines.push(`# Source: ${signal.source}, confidence: ${signal.confidence}`);
  }
}

/**
 * Write a single mux case section with its signals.
 * Format: [frame.{protocol}."ID".mux."CASE_VALUE"] with [[...signals]] arrays
 */
function writeMuxCaseSection(
  lines: string[],
  frameIdStr: string,
  caseValue: number,
  caseKnowledge: MuxCaseKnowledge | undefined,
  mux: MuxKnowledge,
  frameLength: number,
  defaultEndianness: 'little' | 'big',
  protocol: string
): void {
  // Case values are quoted strings in the TOML path
  const caseStr = String(caseValue);
  lines.push('');
  lines.push(`[frame.${protocol}."${frameIdStr}".mux."${caseStr}"]`);

  // Generate signals for this case
  const signals = generateMuxCaseSignals(
    caseKnowledge,
    mux,
    frameLength,
    defaultEndianness
  );

  // Write signals for this case using array of tables syntax
  for (const signal of signals) {
    writeMuxCaseSignalSection(lines, signal, frameIdStr, caseStr, protocol);
  }
}

/**
 * Generate signals for a mux case, including defaults for unclaimed bytes
 */
function generateMuxCaseSignals(
  caseKnowledge: MuxCaseKnowledge | undefined,
  mux: MuxKnowledge,
  frameLength: number,
  defaultEndianness: 'little' | 'big'
): SignalKnowledge[] {
  const claimedBytes = new Set<number>();
  const generatedSignals: SignalKnowledge[] = [];

  // Mux selector claims bytes
  if (mux.isTwoByte) {
    claimedBytes.add(0);
    claimedBytes.add(1);
  } else {
    claimedBytes.add(mux.selectorByte);
  }

  // Add existing signals from case knowledge
  const existingSignals = caseKnowledge?.signals ?? [];
  for (const signal of existingSignals) {
    generatedSignals.push(signal);
    const startByte = Math.floor(signal.startBit / 8);
    const endByte = Math.ceil((signal.startBit + signal.bitLength) / 8);
    for (let i = startByte; i < endByte; i++) {
      claimedBytes.add(i);
    }
  }

  // Generate signals from multi-byte patterns
  const patterns = caseKnowledge?.multiBytePatterns ?? [];
  for (const pattern of patterns) {
    // Skip if any bytes are already claimed
    let anyByteClaimed = false;
    for (let i = pattern.startByte; i < pattern.startByte + pattern.length; i++) {
      if (claimedBytes.has(i)) {
        anyByteClaimed = true;
        break;
      }
    }
    if (anyByteClaimed) continue;

    const signal: SignalKnowledge = {
      name: generatePatternSignalName(pattern),
      startBit: pattern.startByte * 8,
      bitLength: pattern.length * 8,
      source: 'payload-analysis',
      confidence: pattern.correlatedRollover ? 'high' : 'medium',
    };

    if (pattern.endianness && pattern.endianness !== defaultEndianness) {
      signal.endianness = pattern.endianness;
    }

    generatedSignals.push(signal);
    for (let i = pattern.startByte; i < pattern.startByte + pattern.length; i++) {
      claimedBytes.add(i);
    }
  }

  // Fill unclaimed bytes with default hex signals
  let rangeStart: number | null = null;
  for (let i = 0; i <= frameLength; i++) {
    if (i < frameLength && !claimedBytes.has(i)) {
      if (rangeStart === null) {
        rangeStart = i;
      }
    } else {
      if (rangeStart !== null) {
        const byteLength = i - rangeStart;
        generatedSignals.push(createDefaultHexSignal(rangeStart, byteLength));
        rangeStart = null;
      }
    }
  }

  return generatedSignals;
}

/**
 * Generate a signal name from a multi-byte pattern
 */
function generatePatternSignalName(pattern: MultiBytePattern): string {
  const byteRange = `${pattern.startByte}_${pattern.startByte + pattern.length - 1}`;

  switch (pattern.pattern) {
    case 'counter16':
    case 'counter32':
      return `counter_${byteRange}`;
    case 'sensor16':
      return `sensor_${byteRange}`;
    case 'value16':
    case 'value32':
      return `value_${byteRange}`;
    default:
      return `data_${byteRange}`;
  }
}

/**
 * Write a signal section for a mux case
 */
function writeMuxCaseSignalSection(
  lines: string[],
  signal: SignalKnowledge,
  frameIdStr: string,
  caseStr: string,
  protocol: string
): void {
  const signalName = sanitizeSignalName(signal.name);
  lines.push(`[[frame.${protocol}."${frameIdStr}".mux."${caseStr}".signals]]`);
  lines.push(`name = "${signalName}"`);
  lines.push(`start_bit = ${signal.startBit}`);
  lines.push(`bit_length = ${signal.bitLength}`);

  if (signal.format) {
    lines.push(`format = "${signal.format}"`);
  }

  if (signal.endianness) {
    lines.push(`byte_order = "${signal.endianness}"`);
  }

  if (signal.source !== 'default') {
    lines.push(`# Source: ${signal.source}, confidence: ${signal.confidence}`);
  }
}

/**
 * Write a signal section to TOML lines (using array of tables syntax)
 */
function writeSignalSection(
  lines: string[],
  signal: SignalKnowledge,
  frameIdStr: string,
  protocol: string
): void {
  const signalName = sanitizeSignalName(signal.name);
  // Use [[...]] array of tables syntax with plural "signals"
  lines.push(`[[frame.${protocol}."${frameIdStr}".signals]]`);
  lines.push(`name = "${signalName}"`);
  lines.push(`start_bit = ${signal.startBit}`);
  lines.push(`bit_length = ${signal.bitLength}`);

  // Add format if specified (default is "number")
  if (signal.format) {
    lines.push(`format = "${signal.format}"`);
  }

  // Add byte_order if specified (overrides default)
  if (signal.endianness) {
    lines.push(`byte_order = "${signal.endianness}"`);
  }

  // Add comment about source and confidence if not default
  if (signal.source !== 'default') {
    lines.push(`# Source: ${signal.source}, confidence: ${signal.confidence}`);
  }
}

/**
 * Sanitize signal name for use in TOML
 */
function sanitizeSignalName(name: string): string {
  // Replace spaces and special characters with underscores
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
}

// ============================================================================
// Modbus Discovery Export
// ============================================================================

export type ModbusExportConfig = {
  device_address: number;
  register_base: 0 | 1;
  register_type: 'holding' | 'input' | 'coil' | 'discrete';
  default_interval: number;
};

/**
 * Build a TOML catalog from discovered Modbus registers.
 *
 * Each discovered register (frame_id) becomes a [frame.modbus."N"] section.
 * The register_type and register_number are set from the scan configuration.
 */
export function buildModbusDiscoveryToml(
  registers: Array<{ frameId: number; dlc: number }>,
  meta: ExportMeta,
  modbusConfig: ModbusExportConfig,
): string {
  const lines: string[] = [];

  // [meta] section
  lines.push('[meta]');
  lines.push(`name = "${meta.name}"`);
  lines.push(`version = ${meta.version}`);
  lines.push('default_frame = "modbus"');
  lines.push(`default_interval = ${modbusConfig.default_interval}`);
  lines.push('');

  // [meta.modbus] section
  lines.push('[meta.modbus]');
  lines.push(`device_address = ${modbusConfig.device_address}`);
  lines.push(`register_base = ${modbusConfig.register_base}`);
  lines.push(`default_interval = ${modbusConfig.default_interval}`);
  lines.push('');

  // Sort registers by frameId
  const sorted = [...registers].sort((a, b) => a.frameId - b.frameId);

  for (const reg of sorted) {
    const regType = modbusConfig.register_type;
    const isCoilType = regType === 'coil' || regType === 'discrete';
    // For holding/input registers: dlc is 2 bytes per register, so length = dlc / 2
    // For coils/discrete: length is 1 (single bit)
    const length = isCoilType ? 1 : Math.max(1, Math.floor(reg.dlc / 2));

    lines.push(`[frame.modbus."${reg.frameId}"]`);
    lines.push(`register_number = ${reg.frameId}`);
    lines.push(`register_type = "${regType}"`);
    lines.push(`length = ${length}`);
    lines.push('');
  }

  return lines.join('\n');
}
