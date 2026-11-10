// ui/src/utils/frameExport.ts

import type { FrameChecksum, SerialConfig } from '../types/catalogModel';
import type { FramingMode } from '../generated/FramingMode';

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
  checksum?: FrameChecksum;
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
    checksum: c.checksum ?? undefined,
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
    checksum: c.checksum,
    frameIdStartByte: c.frame_id_start_byte,
    frameIdBytes: c.frame_id_bytes,
    frameIdByteOrder: c.frame_id_byte_order,
    sourceAddressStartByte: c.source_address_start_byte,
    sourceAddressBytes: c.source_address_bytes,
    sourceAddressByteOrder: c.source_address_byte_order,
  };
}
