// ui/src/utils/frameExport.ts

import type { SerialConfig } from '../types/catalogModel';

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
