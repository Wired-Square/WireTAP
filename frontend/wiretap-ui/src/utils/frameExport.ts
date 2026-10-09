// ui/src/utils/frameExport.ts

import type { ByteSpan } from '../generated/ByteSpan';
import type { EditOp, HeaderField, SerialConfigFields } from '../types/catalogEdit';
import type { Endianness, Protocol, SerialConfig } from '../types/catalogModel';

export type ExportMeta = {
  name: string;
  version: number;
  default_byte_order: "little" | "big";
  default_interval: number;
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

/** The served serial config in the framing shape sessions and Discovery share. */
export function serialFrameConfigOf(c: SerialConfig): SerialFrameConfig {
  return {
    default_byte_order: c.byteOrder,
    encoding: c.encoding,
    frame_id_start_byte: c.frameIdStartByte,
    frame_id_bytes: c.frameIdBytes,
    frame_id_byte_order: c.frameIdByteOrder,
    frame_id_mask: c.frameIdMask,
    source_address_start_byte: c.sourceAddressStartByte,
    source_address_bytes: c.sourceAddressBytes,
    source_address_byte_order: c.sourceAddressByteOrder,
    min_frame_length: c.minFrameLength,
    header_length: c.headerLength,
    header_fields: c.headerFields?.map((h) => ({
      name: h.name,
      mask: h.mask,
      byte_order: h.byteOrder,
      format: h.format === 'decimal' ? 'decimal' : 'hex',
      start_byte: h.startByte,
      bytes: h.bytes,
    })),
    checksum: c.checksum && {
      algorithm: c.checksum.algorithm,
      start_byte: c.checksum.startByte,
      byte_length: c.checksum.byteLength,
      calc_start_byte: c.checksum.calcStartByte,
      calc_end_byte: c.checksum.calcEndByte ?? -1,
      big_endian: c.checksum.bigEndian,
    },
  };
}

export type ExportFrame = {
  id: number;
  len: number;
  isExtended?: boolean;
  /** Protocol type (e.g., "can", "serial", "modbus") - defaults to "can" */
  protocol?: string;
};

export function catalogProtocol(frames: { protocol?: string }[]): Protocol {
  const protocol = frames.find((f) => f.protocol)?.protocol ?? 'can';
  if (protocol === 'can' || protocol === 'serial' || protocol === 'modbus') return protocol;
  throw new Error(`${protocol} frames cannot be saved as a catalogue`);
}

function setMeta(meta: ExportMeta, protocol: Protocol): EditOp {
  return { op: 'SetMeta', meta: { name: meta.name, version: Math.max(1, meta.version), default_frame: protocol } };
}

function headerFieldMask(startByte: number, bytes: number): number {
  return (2 ** (bytes * 8) - 1) * 2 ** (startByte * 8);
}

function serialConfigFields(config: SerialFrameConfig, meta: ExportMeta): SerialConfigFields {
  const fields: Record<string, HeaderField> = {};
  const addField = (name: string, startByte?: number, bytes?: number, endianness?: Endianness) => {
    if (startByte === undefined || startByte < 0 || bytes === undefined) return;
    fields[name] = { mask: headerFieldMask(startByte, bytes), endianness };
  };
  addField('id', config.frame_id_start_byte, config.frame_id_bytes, config.frame_id_byte_order);
  addField('source_address', config.source_address_start_byte, config.source_address_bytes, config.source_address_byte_order);
  const { checksum } = config;
  return {
    encoding: config.encoding,
    byte_order: meta.default_byte_order,
    frame_id_mask: config.frame_id_mask,
    min_frame_length: config.min_frame_length,
    header_length: config.header_length,
    fields,
    checksum: checksum && {
      algorithm: checksum.algorithm,
      startByte: checksum.start_byte,
      byteLength: checksum.byte_length,
      calcStartByte: checksum.calc_start_byte,
      calcEndByte: checksum.calc_end_byte,
      bigEndian: checksum.big_endian,
    },
  };
}

/** The meta and protocol config a Discovery catalogue opens with. */
export function headOps(protocol: Protocol, meta: ExportMeta, serialConfig: SerialFrameConfig = {}): EditOp[] {
  const ops = [setMeta(meta, protocol)];
  if (protocol === 'can') {
    ops.push({
      op: 'SetCanConfig',
      config: { default_byte_order: meta.default_byte_order, default_interval: Math.max(0, meta.default_interval) },
    });
  } else if (protocol === 'serial') {
    ops.push({ op: 'SetSerialConfig', config: serialConfigFields(serialConfig, meta) });
  }
  return ops;
}

/** A catalogue declaring each frame's id and length. `formatId` spells a frame's key. */
export function framesCatalogOps(
  frames: ExportFrame[],
  meta: ExportMeta,
  formatId: (id: number, isExtended?: boolean) => string,
): EditOp[] {
  const protocol = catalogProtocol(frames);
  return [
    ...headOps(protocol, meta),
    ...frames.map((f): EditOp => ({
      op: 'SetFrame',
      protocol,
      key: formatId(f.id, f.isExtended),
      frame: { length: f.len },
    })),
  ];
}

/** The bytes a serial frame's id, source address and checksum take. */
export function serialReservedSpans(config: SerialFrameConfig = {}): ByteSpan[] {
  const span = (start?: number, len?: number) => (start === undefined || len === undefined ? [] : [{ start, len }]);
  return [
    ...span(config.frame_id_start_byte, config.frame_id_bytes),
    ...span(config.source_address_start_byte, config.source_address_bytes),
    ...span(config.checksum?.start_byte, config.checksum?.byte_length),
  ];
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

/** A catalogue with one frame per discovered register, typed by the scan. */
export function modbusCatalogOps(
  registers: Array<{ frameId: number; dlc: number }>,
  meta: ExportMeta,
  config: ModbusExportConfig,
): EditOp[] {
  const isBitType = config.register_type === 'coil' || config.register_type === 'discrete';
  return [
    setMeta(meta, 'modbus'),
    {
      op: 'SetModbusConfig',
      config: {
        device_address: config.device_address,
        register_base: config.register_base,
        default_interval: config.default_interval,
      },
    },
    ...[...registers]
      .sort((a, b) => a.frameId - b.frameId)
      .map((reg): EditOp => ({
        op: 'SetFrame',
        protocol: 'modbus',
        key: String(reg.frameId),
        frame: {
          register_number: reg.frameId,
          register_type: config.register_type,
          // Two bytes per register; a coil or discrete input is one bit.
          length: isBitType ? 1 : Math.max(1, Math.floor(reg.dlc / 2)),
        },
      })),
  ];
}
