// ui/src/utils/catalogParser.ts
// Catalogue adapter — maps the Rust-parsed `Catalog` (wiretap-catalog crate,
// camelCase) onto the legacy `ParsedCatalog` shape (snake_case + `_inherited`)
// that the Decoder/Graph/Query in-memory models consume. Parsing itself lives
// in Rust (`catalog.parse`); this file only adapts the result and re-derives the
// serial header byte-positions the crate doesn't expose.

import { openCatalogAtPath } from '../apps/catalog/io';
import { parseCatalog } from '../api/catalog';
import type { Confidence, SignalFormat, Endianness } from '../types/catalog';
import type { MuxDef, MuxCaseDef, SignalDef } from '../types/decoder';
import type {
  Catalog,
  Frame,
  Signal,
  Mux,
  CanConfig,
  SerialConfig,
  ModbusConfig,
} from '../types/catalogModel';

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
  /** TOML table name (e.g. a Modbus frame's `ems_control`), when meaningful. */
  name?: string;
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
function maskToBytePosition(mask: number): { startByte: number; bytes: number } | null {
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

// =============================================================================
// Adapter: Rust `Catalog` (camelCase) → legacy `ParsedCatalog` (snake_case)
// =============================================================================

/** Map a Rust `Signal` (camelCase, `inherited`) to the legacy snake-case shape. */
function adaptSignal(s: Signal): ResolvedSignal {
  const out: ResolvedSignal = {
    name: s.name,
    start_bit: s.startBit,
    bit_length: s.bitLength,
    signed: s.signed,
    endianness: s.endianness,
    word_order: s.wordOrder,
    factor: s.factor,
    offset: s.offset,
    unit: s.unit,
    format: s.format as SignalFormat | undefined,
    enum: s.enum as Record<number, string> | undefined,
    confidence: s.confidence as Confidence | undefined,
  };
  // The crate omits `inherited` when false; surface it only when true.
  if (s.inherited) out._inherited = true;
  return out;
}

/** Map a Rust `Mux` to a legacy `MuxDef`, recursing through nested mux/cases. */
function adaptMux(m: Mux): MuxDef {
  const cases: Record<string, MuxCaseDef> = {};
  for (const [key, c] of Object.entries(m.cases)) {
    cases[key] = {
      signals: c.signals.map(adaptSignal) as SignalDef[],
      mux: c.mux ? adaptMux(c.mux) : undefined,
    };
  }
  return { name: m.name, start_bit: m.startBit, bit_length: m.bitLength, cases };
}

function adaptFrame(f: Frame): ResolvedFrame {
  return {
    frameId: f.frameId,
    protocol: f.protocol,
    name: f.name,
    length: f.length,
    transmitter: f.transmitter,
    interval: f.interval,
    bus: f.bus,
    isExtended: f.isExtended,
    isFd: f.isFd,
    signals: f.signals.map(adaptSignal),
    mux: f.mux ? adaptMux(f.mux) : undefined,
    mirrorOf: f.mirrorOf,
    copyFrom: f.copyFrom,
    modbusRegisterType: f.modbusRegisterType,
    modbusRegisterCount: f.modbusRegisterCount,
  };
}

function adaptCanConfig(c?: CanConfig): CanProtocolConfig | null {
  if (!c) return null;
  const out: CanProtocolConfig = {};
  if (c.defaultByteOrder) out.default_byte_order = c.defaultByteOrder;
  if (c.defaultInterval !== undefined) out.default_interval = c.defaultInterval;
  if (c.defaultExtended !== undefined) out.default_extended = c.defaultExtended;
  if (c.defaultFd !== undefined) out.default_fd = c.defaultFd;
  if (c.frameIdMask !== undefined) out.frame_id_mask = c.frameIdMask;
  if (c.fields && Object.keys(c.fields).length > 0) {
    out.fields = Object.fromEntries(
      Object.entries(c.fields).map(([name, f]) => [name, {
        mask: f.mask,
        shift: f.shift,
        format: f.format as HeaderFieldConfig['format'],
      } satisfies HeaderFieldConfig])
    );
  }
  return Object.keys(out).length > 0 ? out : null;
}

function adaptModbusConfig(c?: ModbusConfig): ModbusProtocolConfig | null {
  if (!c) return null;
  const out: ModbusProtocolConfig = {};
  if (c.deviceAddress !== undefined) out.device_address = c.deviceAddress;
  if (c.registerBase === 0 || c.registerBase === 1) out.register_base = c.registerBase;
  if (c.defaultInterval !== undefined) out.default_interval = c.defaultInterval;
  if (c.defaultByteOrder) out.default_byte_order = c.defaultByteOrder;
  if (c.defaultWordOrder) out.default_word_order = c.defaultWordOrder;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Map a Rust `SerialConfig` (raw masks only) to `SerialProtocolConfig`, re-deriving
 * the byte-position convenience fields (`frame_id_*`, `source_address_*`,
 * `header_fields[]`) that consumers read but the crate doesn't expose.
 */
function adaptSerialConfig(c?: SerialConfig): SerialProtocolConfig | null {
  if (!c) return null;
  const out: SerialProtocolConfig = {};

  if (c.encoding) out.encoding = c.encoding as SerialProtocolConfig['encoding'];
  if (c.byteOrder) {
    out.byte_order = c.byteOrder;
    out.default_byte_order = c.byteOrder;
  }
  if (c.frameIdMask !== undefined) out.frame_id_mask = c.frameIdMask;
  if (c.headerLength !== undefined) out.header_length = c.headerLength;
  if (c.minFrameLength !== undefined) out.min_frame_length = c.minFrameLength;
  if (c.checksum) {
    out.checksum = {
      algorithm: c.checksum.algorithm,
      start_byte: c.checksum.startByte,
      byte_length: c.checksum.byteLength,
      calc_start_byte: c.checksum.calcStartByte,
      calc_end_byte: c.checksum.calcEndByte,
      big_endian: c.checksum.bigEndian,
    };
  }

  if (c.fields && Object.keys(c.fields).length > 0) {
    const fields: Record<string, HeaderFieldConfig> = {};
    const headerFields: NonNullable<SerialProtocolConfig['header_fields']> = [];

    for (const [name, f] of Object.entries(c.fields)) {
      fields[name] = {
        mask: f.mask,
        shift: f.shift,
        format: f.format as HeaderFieldConfig['format'],
        endianness: f.endianness,
      };

      const pos = maskToBytePosition(f.mask);
      if (!pos) continue;

      const byteOrder = f.endianness || 'big';
      const format = f.format === 'decimal' ? 'decimal' : 'hex';
      headerFields.push({
        name,
        mask: f.mask,
        byte_order: byteOrder,
        format,
        start_byte: pos.startByte,
        bytes: pos.bytes,
      });

      // Special handling for id and source_address fields
      if (name === 'id') {
        out.frame_id_start_byte = pos.startByte;
        out.frame_id_bytes = pos.bytes;
        out.frame_id_byte_order = byteOrder;
      } else if (name === 'source_address') {
        out.source_address_start_byte = pos.startByte;
        out.source_address_bytes = pos.bytes;
        out.source_address_byte_order = byteOrder;
      }
    }

    out.fields = fields;
    if (headerFields.length > 0) out.header_fields = headerFields;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Adapt the Rust-parsed {@link Catalog} into the legacy {@link ParsedCatalog}
 * the Decoder/Graph/Query models consume. `rawToml` is carried through for callers
 * that re-attach the catalogue content to a session.
 */
export function catalogToResolved(catalog: Catalog, rawToml: string): ParsedCatalog {
  const frames = new Map<number, ResolvedFrame>();
  for (const f of catalog.frames) {
    frames.set(f.frameId, adaptFrame(f));
  }

  return {
    metadata: {
      name: catalog.meta.name,
      version: catalog.meta.version,
      default_frame: catalog.meta.defaultFrame,
    },
    canConfig: adaptCanConfig(catalog.can),
    serialConfig: adaptSerialConfig(catalog.serial),
    modbusConfig: adaptModbusConfig(catalog.modbus),
    frames,
    rawToml,
    protocol: catalog.protocol,
  };
}

/**
 * Load a catalogue from a file path: read the TOML, parse it in Rust
 * (`catalog.parse`), then adapt to the legacy {@link ParsedCatalog} shape.
 */
export async function loadCatalog(path: string): Promise<ParsedCatalog> {
  const content = await openCatalogAtPath(path);
  const catalog = await parseCatalog(content);
  return catalogToResolved(catalog, content);
}
