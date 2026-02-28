// ui/src/utils/catalogParser.ts
// Common Catalog Parser - unified parsing utilities for all apps

import { openCatalogAtPath } from '../apps/catalog/io';
import TOML from 'smol-toml';
import type { Confidence, SignalFormat, Endianness } from '../types/catalog';
import type { MuxDef, MuxCaseDef, SignalDef } from '../types/decoder';
import { isMuxCaseKey } from './muxCaseMatch';

// =============================================================================
// Core Types
// =============================================================================

export interface CatalogMetadata {
  name: string;
  version: number;
  default_frame?: 'can' | 'serial' | 'modbus';
}

export interface HeaderFieldConfig {
  mask: number;
  shift?: number;
  format?: 'hex' | 'decimal';
  endianness?: 'big' | 'little';
}

export interface CanProtocolConfig {
  default_byte_order?: 'big' | 'little';
  default_interval?: number;
  /** Default to 29-bit extended IDs (default: false = 11-bit standard) */
  default_extended?: boolean;
  /** Default to CAN FD frames (default: false = classic CAN) */
  default_fd?: boolean;
  frame_id_mask?: number;
  fields?: Record<string, HeaderFieldConfig>;
}

export interface ChecksumConfig {
  algorithm: string;
  start_byte: number;
  byte_length: number;
  calc_start_byte: number;
  calc_end_byte?: number;
  big_endian?: boolean;
}

export interface SerialProtocolConfig {
  encoding?: 'slip' | 'cobs' | 'raw' | 'length_prefixed';
  byte_order?: 'big' | 'little';
  default_byte_order?: 'big' | 'little';
  frame_id_mask?: number;
  header_length?: number;
  min_frame_length?: number;
  checksum?: ChecksumConfig;
  fields?: Record<string, HeaderFieldConfig>;
  // Derived from fields for convenience
  frame_id_start_byte?: number;
  frame_id_bytes?: number;
  frame_id_byte_order?: 'big' | 'little';
  source_address_start_byte?: number;
  source_address_bytes?: number;
  source_address_byte_order?: 'big' | 'little';
  header_fields?: Array<{
    name: string;
    mask: number;
    byte_order: 'big' | 'little';
    format: 'hex' | 'decimal';
    start_byte: number;
    bytes: number;
  }>;
}

export interface ResolvedSignal {
  name?: string;
  start_bit?: number;
  bit_length?: number;
  signed?: boolean;
  endianness?: Endianness;
  word_order?: Endianness;
  factor?: number;
  offset?: number;
  unit?: string;
  format?: SignalFormat;
  enum?: Record<number, string>;
  confidence?: Confidence;
  _inherited?: boolean;
}

export interface ResolvedFrame {
  frameId: number;
  protocol: 'can' | 'serial' | 'modbus';
  length: number;
  transmitter?: string;
  interval?: number;
  bus?: number;
  isExtended?: boolean;
  isFd?: boolean;
  signals: ResolvedSignal[];
  mux?: MuxDef;
  mirrorOf?: string;
  copyFrom?: string;
  /** Modbus-specific: register type (holding, input, coil, discrete) */
  modbusRegisterType?: 'holding' | 'input' | 'coil' | 'discrete';
  /** Modbus-specific: number of registers (not bytes) */
  modbusRegisterCount?: number;
}

export interface ModbusProtocolConfig {
  /** Default Modbus device/slave address (1-247) */
  device_address?: number;
  /** Register addressing base: 0 = IEC (0-based), 1 = traditional (1-based with type prefix) */
  register_base?: 0 | 1;
  /** Default poll interval in milliseconds */
  default_interval?: number;
  /** Default byte order for multi-register values */
  default_byte_order?: 'big' | 'little';
  /** Default word order for multi-register values: 'big' = standard (high word first), 'little' = word-swapped (low word first) */
  default_word_order?: 'big' | 'little';
}

export interface ParsedCatalog {
  metadata: CatalogMetadata;
  canConfig: CanProtocolConfig | null;
  serialConfig: SerialProtocolConfig | null;
  modbusConfig: ModbusProtocolConfig | null;
  frames: Map<number, ResolvedFrame>;
  rawToml: string;
  protocol: 'can' | 'serial' | 'modbus';
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse a CAN ID string (hex or decimal) to a number.
 */
export function parseCanId(id: string): number | null {
  const trimmed = id.trim();
  const isHex = /^0x[0-9a-fA-F]+$/i.test(trimmed);
  const isDec = /^\d+$/.test(trimmed);
  if (isHex) return parseInt(trimmed, 16);
  if (isDec) return parseInt(trimmed, 10);
  return null;
}

/**
 * Find a frame in allFrames by its numeric ID value (case-insensitive for hex).
 */
export function findFrameByNumericId(
  targetId: string,
  allFrames: Record<string, any>
): any | undefined {
  const targetNum = parseCanId(targetId);
  if (targetNum === null) return undefined;

  for (const key of Object.keys(allFrames)) {
    const keyNum = parseCanId(key);
    if (keyNum === targetNum) {
      return allFrames[key];
    }
  }
  return undefined;
}

/**
 * Convert mask to byte position and length.
 * Mask is a bitmask over header bytes, e.g., 0xFFFF means first 2 bytes.
 */
export function maskToBytePosition(mask: number): { startByte: number; bytes: number } | null {
  if (!mask || mask === 0) return null;

  let firstBit = -1;
  let lastBit = -1;
  for (let i = 0; i < 32; i++) {
    if ((mask >> i) & 1) {
      if (firstBit === -1) firstBit = i;
      lastBit = i;
    }
  }

  if (firstBit === -1) return null;

  const startByte = Math.floor(firstBit / 8);
  const endByte = Math.floor(lastBit / 8);
  const bytes = endByte - startByte + 1;

  return { startByte, bytes };
}

/**
 * Normalise a signal definition from TOML, mapping byte_order to endianness.
 * Handles the transition from old 'endianness' key to new 'byte_order' key.
 * Preserves the _inherited flag if present.
 */
export function normaliseSignal(raw: any): ResolvedSignal {
  return {
    name: raw.name,
    start_bit: raw.start_bit,
    bit_length: raw.bit_length,
    signed: raw.signed,
    endianness: raw.byte_order ?? raw.endianness,
    word_order: raw.word_order,
    factor: raw.factor,
    offset: raw.offset,
    unit: raw.unit,
    format: raw.format,
    enum: raw.enum,
    confidence: raw.confidence,
    _inherited: raw._inherited,
  };
}

/**
 * Normalise an array of signal definitions from TOML.
 */
export function normaliseSignals(rawSignals: any[]): ResolvedSignal[] {
  return rawSignals.map(normaliseSignal);
}

/**
 * Parse a raw mux object from TOML into a structured MuxDef.
 * Supports case keys as single values ("0"), ranges ("0-3"), or comma-separated ("1,2,5").
 */
export function parseMux(mux: any): MuxDef | undefined {
  if (!mux || typeof mux !== 'object') return undefined;

  const startBit = mux.start_bit ?? 0;
  const bitLength = mux.bit_length ?? 8;
  const name = mux.name;
  const cases: Record<string, MuxCaseDef> = {};

  for (const [key, caseData] of Object.entries<any>(mux)) {
    if (!isMuxCaseKey(key)) continue;

    const caseSignals = Array.isArray(caseData?.signals) ? normaliseSignals(caseData.signals) : [];
    const nestedMux = caseData?.mux ? parseMux(caseData.mux) : undefined;

    cases[key] = {
      signals: caseSignals as SignalDef[],
      mux: nestedMux,
    };
  }

  return {
    name,
    start_bit: startBit,
    bit_length: bitLength,
    cases,
  };
}

// =============================================================================
// Config Parsers
// =============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse CAN header fields from [meta.can.fields] section.
 */
export function parseCanHeaderFields(fieldsSection: any): Record<string, HeaderFieldConfig> | undefined {
  if (!isPlainObject(fieldsSection)) return undefined;

  const fields: Record<string, HeaderFieldConfig> = {};
  const validFormats = ['hex', 'decimal'] as const;

  for (const [name, fieldDef] of Object.entries(fieldsSection)) {
    if (!isPlainObject(fieldDef)) continue;

    const mask = (fieldDef as any).mask;
    if (typeof mask !== 'number') continue;

    const field: HeaderFieldConfig = { mask };

    const shift = (fieldDef as any).shift;
    if (typeof shift === 'number') {
      field.shift = shift;
    }

    const format = (fieldDef as any).format;
    if (validFormats.includes(format)) {
      field.format = format;
    }

    fields[name] = field;
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Parse [meta.can] section if present.
 */
export function parseCanConfig(parsed: any): CanProtocolConfig | null {
  const configSection = parsed?.meta?.can || parsed?.frame?.can?.config;
  if (!configSection || typeof configSection !== 'object') return null;

  // Support both new key (default_byte_order) and old key (default_endianness)
  const byteOrderValue = configSection.default_byte_order ?? configSection.default_endianness;
  const defaultByteOrder = byteOrderValue === 'big' ? 'big' as const
    : byteOrderValue === 'little' ? 'little' as const
    : undefined;

  const config: CanProtocolConfig = {};

  if (defaultByteOrder) {
    config.default_byte_order = defaultByteOrder;
  }

  if (typeof configSection.default_interval === 'number') {
    config.default_interval = configSection.default_interval;
  }

  if (typeof configSection.frame_id_mask === 'number') {
    config.frame_id_mask = configSection.frame_id_mask;
  }

  const fields = parseCanHeaderFields(configSection.fields);
  if (fields) {
    config.fields = fields;
  }

  // Parse default_extended (default: false = 11-bit standard)
  if (typeof configSection.default_extended === 'boolean') {
    config.default_extended = configSection.default_extended;
  }

  // Parse default_fd (default: false = classic CAN)
  if (typeof configSection.default_fd === 'boolean') {
    config.default_fd = configSection.default_fd;
  }

  return Object.keys(config).length > 0 ? config : null;
}

/**
 * Parse serial header fields from [meta.serial.fields] section.
 */
export function parseSerialHeaderFields(fieldsSection: any): Record<string, HeaderFieldConfig> | undefined {
  if (!isPlainObject(fieldsSection)) return undefined;

  const fields: Record<string, HeaderFieldConfig> = {};
  const validFormats = ['hex', 'decimal'] as const;

  for (const [name, fieldDef] of Object.entries(fieldsSection)) {
    if (!isPlainObject(fieldDef)) continue;

    let mask: number;

    // New format: mask is directly specified
    if (typeof (fieldDef as any).mask === 'number') {
      mask = (fieldDef as any).mask;
    }
    // Legacy format: convert start_byte + bytes to mask
    else if (typeof (fieldDef as any).start_byte === 'number') {
      const startByte = (fieldDef as any).start_byte;
      const bytes = typeof (fieldDef as any).bytes === 'number' ? (fieldDef as any).bytes : 1;
      // Create mask: numBytes worth of 1s shifted to correct position
      const numBits = bytes * 8;
      const baseMask = ((1 << numBits) - 1) >>> 0;
      mask = (baseMask << (startByte * 8)) >>> 0;
    } else {
      continue;
    }

    const field: HeaderFieldConfig = { mask };

    const endianness = (fieldDef as any).endianness ?? (fieldDef as any).byte_order;
    if (endianness === 'big' || endianness === 'little') {
      field.endianness = endianness;
    }

    const format = (fieldDef as any).format;
    if (validFormats.includes(format)) {
      field.format = format;
    }

    fields[name] = field;
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Parse [meta.serial.checksum] section if present.
 */
function parseSerialChecksumConfig(checksumSection: any): ChecksumConfig | undefined {
  if (!isPlainObject(checksumSection)) return undefined;

  const algorithm = checksumSection.algorithm as string;
  const startByte = checksumSection.start_byte;
  if (typeof algorithm !== 'string' || typeof startByte !== 'number') return undefined;

  return {
    algorithm,
    start_byte: startByte,
    byte_length: typeof checksumSection.byte_length === 'number' ? checksumSection.byte_length : 1,
    calc_start_byte: typeof checksumSection.calc_start_byte === 'number' ? checksumSection.calc_start_byte : 0,
    calc_end_byte: typeof checksumSection.calc_end_byte === 'number' ? checksumSection.calc_end_byte : undefined,
    big_endian: typeof checksumSection.big_endian === 'boolean' ? checksumSection.big_endian : false,
  };
}

/**
 * Parse [meta.serial] section if present.
 */
export function parseSerialConfig(parsed: any): SerialProtocolConfig | null {
  const configSection = parsed?.meta?.serial;
  if (!configSection || typeof configSection !== 'object') return null;

  const validEncodings = ['slip', 'cobs', 'raw', 'length_prefixed'] as const;
  const encoding = validEncodings.includes(configSection.encoding)
    ? configSection.encoding as SerialProtocolConfig['encoding']
    : undefined;

  const config: SerialProtocolConfig = {};

  if (encoding) {
    config.encoding = encoding;
  }

  if (configSection.byte_order === 'little' || configSection.byte_order === 'big') {
    config.byte_order = configSection.byte_order;
    config.default_byte_order = configSection.byte_order;
  }

  if (typeof configSection.frame_id_mask === 'number') {
    config.frame_id_mask = configSection.frame_id_mask;
  }

  if (typeof configSection.header_length === 'number') {
    config.header_length = configSection.header_length;
  }

  if (typeof configSection.min_frame_length === 'number') {
    config.min_frame_length = configSection.min_frame_length;
  }

  const checksum = parseSerialChecksumConfig(configSection.checksum);
  if (checksum) {
    config.checksum = checksum;
  }

  const fields = parseSerialHeaderFields(configSection.fields);
  if (fields) {
    config.fields = fields;

    // Derive convenience fields from mask-based fields
    const headerFields: SerialProtocolConfig['header_fields'] = [];

    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      const pos = maskToBytePosition(fieldDef.mask);
      if (!pos) continue;

      headerFields.push({
        name: fieldName,
        mask: fieldDef.mask,
        byte_order: fieldDef.endianness || 'big',
        format: fieldDef.format || 'hex',
        start_byte: pos.startByte,
        bytes: pos.bytes,
      });

      // Special handling for id and source_address fields
      if (fieldName === 'id') {
        config.frame_id_start_byte = pos.startByte;
        config.frame_id_bytes = pos.bytes;
        config.frame_id_byte_order = fieldDef.endianness || 'big';
      } else if (fieldName === 'source_address') {
        config.source_address_start_byte = pos.startByte;
        config.source_address_bytes = pos.bytes;
        config.source_address_byte_order = fieldDef.endianness || 'big';
      }
    }

    if (headerFields.length > 0) {
      config.header_fields = headerFields;
    }
  }

  return Object.keys(config).length > 0 ? config : null;
}

/**
 * Parse [meta.modbus] section if present.
 */
export function parseModbusConfig(parsed: any): ModbusProtocolConfig | null {
  const configSection = parsed?.meta?.modbus;
  if (!configSection || typeof configSection !== 'object') return null;

  const config: ModbusProtocolConfig = {};

  if (typeof configSection.device_address === 'number') {
    config.device_address = configSection.device_address;
  }

  if (configSection.register_base === 0 || configSection.register_base === 1) {
    config.register_base = configSection.register_base;
  }

  if (typeof configSection.default_interval === 'number') {
    config.default_interval = configSection.default_interval;
  }

  const byteOrder = configSection.default_byte_order ?? configSection.byte_order;
  if (byteOrder === 'big' || byteOrder === 'little') {
    config.default_byte_order = byteOrder;
  }

  const wordOrder = configSection.default_word_order;
  if (wordOrder === 'big' || wordOrder === 'little') {
    config.default_word_order = wordOrder;
  }

  return Object.keys(config).length > 0 ? config : null;
}

// =============================================================================
// Mirror/Copy Resolution
// =============================================================================

export interface MirrorResolutionResult {
  signals: ResolvedSignal[];
  mux?: MuxDef;
  mirrorOf?: string;
  copyFrom?: string;
  inheritedMetadata: {
    length?: number;
    lengthInherited?: boolean;
    transmitter?: string;
    transmitterInherited?: boolean;
    interval?: number;
    intervalInherited?: boolean;
  };
}

/**
 * Resolve mirror/copy inheritance for a frame.
 * Returns signals with _inherited flag and metadata inheritance info.
 */
export function resolveMirrorInheritance(
  frameData: any,
  allFrames: Record<string, any>
): MirrorResolutionResult {
  const isCopy = !!frameData.copy;
  const copyFrom = frameData.copy;
  const isMirror = !!frameData.mirror_of;
  const mirrorOf = frameData.mirror_of;

  let signals = frameData.signals || frameData.signal || [];
  let mux = frameData.mux;
  const inheritedMetadata: MirrorResolutionResult['inheritedMetadata'] = {};

  // Handle copy inheritance (metadata only)
  const copySource = isCopy && copyFrom ? findFrameByNumericId(copyFrom, allFrames) : undefined;
  if (copySource) {
    if (frameData.length === undefined && copySource.length !== undefined) {
      inheritedMetadata.length = copySource.length;
      inheritedMetadata.lengthInherited = true;
    }
    if (frameData.transmitter === undefined && copySource.transmitter !== undefined) {
      inheritedMetadata.transmitter = copySource.transmitter;
      inheritedMetadata.transmitterInherited = true;
    }
    const srcInterval = copySource.tx?.interval ?? copySource.tx?.interval_ms;
    if ((frameData.tx?.interval ?? frameData.tx?.interval_ms) === undefined && srcInterval !== undefined) {
      inheritedMetadata.interval = srcInterval;
      inheritedMetadata.intervalInherited = true;
    }
  }

  // Handle mirror inheritance (signals + metadata)
  const mirrorSource = isMirror && mirrorOf ? findFrameByNumericId(mirrorOf, allFrames) : undefined;
  if (mirrorSource) {
    const primarySignals = mirrorSource.signals || mirrorSource.signal || [];
    const mirrorSignals = signals;

    // Build a map of mirror signals by bit position for override lookup
    const bitKey = (s: any) => `${s.start_bit}:${s.bit_length}`;
    const mirrorByPosition = new Map(mirrorSignals.map((s: any) => [bitKey(s), s]));

    // Start with primary signals, override by bit position
    // Mark inherited signals with _inherited: true
    signals = primarySignals.map((ps: any) => {
      const override = mirrorByPosition.get(bitKey(ps));
      if (override) {
        return override; // Overridden by mirror - not inherited
      }
      return { ...ps, _inherited: true }; // Inherited from primary
    });

    // Add any mirror signals at new positions (not inherited)
    const primaryPositions = new Set(primarySignals.map(bitKey));
    for (const ms of mirrorSignals) {
      if (!primaryPositions.has(bitKey(ms))) {
        signals.push(ms);
      }
    }

    // Inherit mux if not locally defined
    if (!mux && mirrorSource.mux) {
      mux = mirrorSource.mux;
    }

    // Inherit metadata if not using copy
    if (!isCopy) {
      if (frameData.length === undefined && mirrorSource.length !== undefined) {
        inheritedMetadata.length = mirrorSource.length;
        inheritedMetadata.lengthInherited = true;
      }
      if (frameData.transmitter === undefined && mirrorSource.transmitter !== undefined) {
        inheritedMetadata.transmitter = mirrorSource.transmitter;
        inheritedMetadata.transmitterInherited = true;
      }
      const srcInterval = mirrorSource.tx?.interval ?? mirrorSource.tx?.interval_ms;
      if ((frameData.tx?.interval ?? frameData.tx?.interval_ms) === undefined && srcInterval !== undefined) {
        inheritedMetadata.interval = srcInterval;
        inheritedMetadata.intervalInherited = true;
      }
    }
  }

  return {
    signals: normaliseSignals(signals),
    mux: mux ? parseMux(mux) : undefined,
    mirrorOf: isMirror ? mirrorOf : undefined,
    copyFrom: isCopy ? copyFrom : undefined,
    inheritedMetadata,
  };
}

// =============================================================================
// Main API Functions
// =============================================================================

/**
 * Parse catalog from TOML text string.
 */
export function parseCatalogText(toml: string): ParsedCatalog {
  const parsed = TOML.parse(toml) as any;
  const frameMap = new Map<number, ResolvedFrame>();

  // Extract metadata
  const metadata: CatalogMetadata = {
    name: parsed?.meta?.name || '',
    version: parsed?.meta?.version || 1,
    default_frame: parsed?.meta?.default_frame,
  };

  // Parse protocol configs
  const canConfig = parseCanConfig(parsed);
  const serialConfig = parseSerialConfig(parsed);
  const modbusConfig = parseModbusConfig(parsed);

  // Parse CAN frames
  const canFrames = parsed?.frame?.can || {};
  for (const [idKey, body] of Object.entries<any>(canFrames)) {
    if (idKey === 'config') continue;

    const numId = parseCanId(idKey);
    if (numId === null || !Number.isFinite(numId)) continue;

    // Resolve mirror/copy inheritance
    const resolved = resolveMirrorInheritance(body, canFrames);

    const len = body?.length ?? resolved.inheritedMetadata.length ?? 8;

    // Resolve isExtended: frame explicit > catalog default > auto-detect from ID
    let isExtended: boolean;
    if (typeof body?.extended === 'boolean') {
      isExtended = body.extended;
    } else if (typeof canConfig?.default_extended === 'boolean') {
      isExtended = canConfig.default_extended;
    } else {
      isExtended = numId > 0x7ff;
    }

    // Resolve isFd: frame explicit > catalog default > false
    let isFd: boolean;
    if (typeof body?.fd === 'boolean') {
      isFd = body.fd;
    } else if (typeof canConfig?.default_fd === 'boolean') {
      isFd = canConfig.default_fd;
    } else {
      isFd = false;
    }

    frameMap.set(numId, {
      frameId: numId,
      protocol: 'can',
      length: len,
      transmitter: body?.transmitter ?? resolved.inheritedMetadata.transmitter,
      interval: body?.tx?.interval ?? body?.tx?.interval_ms ?? resolved.inheritedMetadata.interval,
      bus: body?.bus,
      isExtended,
      isFd,
      signals: resolved.signals as SignalDef[],
      mux: resolved.mux,
      mirrorOf: resolved.mirrorOf,
      copyFrom: resolved.copyFrom,
    });
  }

  // Parse Serial frames
  const serialFrames = parsed?.frame?.serial || {};
  for (const [idKey, body] of Object.entries<any>(serialFrames)) {
    if (idKey === 'config') continue;

    const numId = parseCanId(idKey);
    if (numId === null || !Number.isFinite(numId)) continue;

    const len = body?.length ?? 0;
    const plainSignals = Array.isArray(body?.signals) ? normaliseSignals(body.signals) : [];
    const mux = body?.mux ? parseMux(body.mux) : undefined;

    frameMap.set(numId, {
      frameId: numId,
      protocol: 'serial',
      length: len,
      transmitter: body?.transmitter,
      bus: body?.bus,
      signals: plainSignals as SignalDef[],
      mux,
    });
  }

  // Parse Modbus frames
  const modbusFrames = parsed?.frame?.modbus || {};
  for (const [key, body] of Object.entries<any>(modbusFrames)) {
    if (key === 'config') continue;

    const registerNumber = body?.register_number;
    if (typeof registerNumber !== 'number') continue;

    const registerCount = body?.length ?? 1;
    // Length in bytes: registers are 16-bit (2 bytes each)
    // Coils/discrete are packed into bytes by the driver
    const registerType = body?.register_type ?? 'holding';
    const isCoilType = registerType === 'coil' || registerType === 'discrete';
    const lengthBytes = isCoilType ? Math.ceil(registerCount / 8) : registerCount * 2;

    const interval = body?.tx?.interval ?? body?.tx?.interval_ms
      ?? modbusConfig?.default_interval;

    const plainSignals = Array.isArray(body?.signals) ? normaliseSignals(body.signals) : [];
    const mux = body?.mux ? parseMux(body.mux) : undefined;

    frameMap.set(registerNumber, {
      frameId: registerNumber,
      protocol: 'modbus',
      length: lengthBytes,
      transmitter: body?.transmitter,
      interval,
      signals: plainSignals as SignalDef[],
      mux,
      modbusRegisterType: registerType,
      modbusRegisterCount: registerCount,
    });
  }

  // Determine protocol
  const hasSerialFrames = Object.keys(serialFrames).filter(k => k !== 'config').length > 0;
  const hasCanFrames = Object.keys(canFrames).filter(k => k !== 'config').length > 0;
  const hasModbusFrames = Object.keys(modbusFrames).filter(k => k !== 'config').length > 0;
  let protocol: 'can' | 'serial' | 'modbus';
  if (metadata.default_frame === 'modbus' || metadata.default_frame === 'serial' || metadata.default_frame === 'can') {
    protocol = metadata.default_frame;
  } else if (hasModbusFrames && !hasCanFrames && !hasSerialFrames) {
    protocol = 'modbus';
  } else if (hasSerialFrames && !hasCanFrames) {
    protocol = 'serial';
  } else {
    protocol = 'can';
  }

  return {
    metadata,
    canConfig,
    serialConfig,
    modbusConfig,
    frames: frameMap,
    rawToml: toml,
    protocol,
  };
}

/**
 * Load and parse catalog from file path.
 */
export async function loadCatalog(path: string): Promise<ParsedCatalog> {
  const content = await openCatalogAtPath(path);
  return parseCatalogText(content);
}

/**
 * Get byte indices covered by a signal (for mirror validation).
 */
export function getSignalByteIndices(startBit: number, bitLength: number): number[] {
  const indices: number[] = [];
  const startByte = Math.floor(startBit / 8);
  const endByte = Math.floor((startBit + bitLength - 1) / 8);
  for (let i = startByte; i <= endByte; i++) {
    indices.push(i);
  }
  return indices;
}

/**
 * Get all byte indices for inherited signals in a frame (for mirror validation).
 */
export function getInheritedSignalBytes(frame: ResolvedFrame): Set<number> {
  const indices = new Set<number>();
  for (const signal of frame.signals) {
    if (signal._inherited && signal.start_bit !== undefined && signal.bit_length !== undefined) {
      for (const idx of getSignalByteIndices(signal.start_bit, signal.bit_length)) {
        indices.add(idx);
      }
    }
  }
  return indices;
}
