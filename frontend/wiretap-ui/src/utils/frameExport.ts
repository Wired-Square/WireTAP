// ui/src/utils/frameExport.ts

import type { SerialConfig } from '../types/catalogModel';
import type { FramingMode } from '../generated/FramingMode';

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
export type SerialFrameConfig = {
  /** Default byte order for signal decoding (can be overridden per signal) */
  default_byte_order?: "big" | "little";
  encoding?: FramingMode;
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
};

/** The served serial config in the framing shape sessions and Discovery share. */
export function serialFrameConfigOf(c: SerialConfig): SerialFrameConfig {
  return {
    default_byte_order: c.byteOrder ?? undefined,
    encoding: c.encoding ?? undefined,
    frame_id_start_byte: c.frameIdStartByte ?? undefined,
    frame_id_bytes: c.frameIdBytes ?? undefined,
    frame_id_byte_order: c.frameIdByteOrder ?? undefined,
    frame_id_mask: c.frameIdMask ?? undefined,
    source_address_start_byte: c.sourceAddressStartByte ?? undefined,
    source_address_bytes: c.sourceAddressBytes ?? undefined,
    source_address_byte_order: c.sourceAddressByteOrder ?? undefined,
    min_frame_length: c.minFrameLength ?? undefined,
    header_length: c.headerLength ?? undefined,
    checksum: c.checksum ? {
      algorithm: c.checksum.algorithm,
      start_byte: c.checksum.startByte,
      byte_length: c.checksum.byteLength,
      calc_start_byte: c.checksum.calcStartByte,
      calc_end_byte: c.checksum.calcEndByte ?? -1,
      big_endian: c.checksum.bigEndian,
    } : undefined,
  };
}

/** The framing as the catalogue model holds it. */
export function serialConfigOf(c: SerialFrameConfig): SerialConfig {
  return {
    encoding: c.encoding,
    byteOrder: c.default_byte_order,
    frameIdMask: c.frame_id_mask,
    headerLength: c.header_length,
    minFrameLength: c.min_frame_length,
    checksum: c.checksum && {
      algorithm: c.checksum.algorithm,
      startByte: c.checksum.start_byte,
      byteLength: c.checksum.byte_length,
      calcStartByte: c.checksum.calc_start_byte,
      calcEndByte: c.checksum.calc_end_byte,
      bigEndian: c.checksum.big_endian ?? false,
    },
    frameIdStartByte: c.frame_id_start_byte,
    frameIdBytes: c.frame_id_bytes,
    frameIdByteOrder: c.frame_id_byte_order,
    sourceAddressStartByte: c.source_address_start_byte,
    sourceAddressBytes: c.source_address_bytes,
    sourceAddressByteOrder: c.source_address_byte_order,
  };
}
