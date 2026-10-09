// ui/src/apps/catalog/types.ts

import type { ChecksumAlgorithm as CA } from "../../utils/analysis/checksums";
import type { Frame, FrameChecksum, Mux, MuxCase, NodeDef, Signal } from "../../types/catalogModel";

// Re-export checksum type for consumers
export type ChecksumAlgorithm = CA;

export type EditMode = "text" | "ui";

export type TomlNodeType =
  | "section"
  | "signal"
  | "checksum"
  | "meta"
  | "can-frame"
  | "modbus-frame"
  | "serial-frame"
  | "node"
  | "mux"
  | "mux-case";

// ============================================================================
// Protocol Types - Generic frame architecture
// ============================================================================

/** Supported protocol types */
export type ProtocolType = "can" | "modbus" | "serial";

/** The frame editor's fields common to every protocol. Modbus length is in registers. */
export interface FrameBaseFields {
  length: number;
  transmitter?: string;
  interval?: number;
  notes?: string | string[];
}

/** CAN protocol configuration */
export interface CANConfig {
  protocol: "can";
  id: string;                    // "0x123" or decimal
  extended?: boolean;            // 29-bit extended ID
  fd?: boolean;                  // CAN FD frame (64-byte payload, BRS)
  bus?: number;                  // CAN bus index
  copy?: string;                 // Inherit metadata from another frame
  mirror_of?: string;            // Inherit ALL signals from another frame (by bit position)
}

/** Modbus protocol configuration */
export interface ModbusConfig {
  protocol: "modbus";
  /** Starting register address. Optional: when omitted, it's derived from a
   *  numeric frame key (`[frame.modbus.2581]` / `[frame.modbus.0x32F9]`). */
  register_number?: number;
  /** The device (slave) address this register is read from, matched to a slave
   *  node by its `device_address`. */
  node_address?: number;
  register_type?: "holding" | "input" | "coil" | "discrete";
}

/** Header field format for display */
export type HeaderFieldFormat = "hex" | "decimal";

/** Serial encoding types */
export type SerialEncoding = "slip" | "cobs" | "raw" | "length_prefixed";

/** Serial checksum config - protocol-level defaults stored in [meta.serial.checksum] */
export interface SerialChecksumConfig {
  /** Checksum algorithm (e.g., "sum8", "crc8_sae_j1850", "xor") */
  algorithm: ChecksumAlgorithm;
  /** Byte position where checksum is stored (supports negative indexing: -1 = last byte) */
  start_byte: number;
  /** Number of bytes for the checksum value (1 or 2) */
  byte_length: number;
  /** Start of calculation range (0-indexed) */
  calc_start_byte: number;
  /** End of calculation range (exclusive, supports negative indexing); absent is the frame's end */
  calc_end_byte?: number;
  /** Whether checksum value is big-endian (default: false = little-endian) */
  big_endian?: boolean;
}

/** Serial/RS-485 frame configuration - per-frame settings only */
export interface SerialConfig {
  protocol: "serial";
  frame_id?: string;             // Unique identifier for this frame
  delimiter?: number[];          // Byte sequence for raw framing (only when encoding=raw)
  // NOTE: encoding comes from SerialProtocolConfig ([frame.serial.config]), not here
}

/** Union of all protocol configs (discriminated by 'protocol' field) */
export type ProtocolConfig = CANConfig | ModbusConfig | SerialConfig;

/** A node of the editor's tree: a path into the document and the part of the
 *  served model it shows. */
export interface TomlNode {
  key: string;
  type: TomlNodeType;
  children?: TomlNode[];
  path: string[];
  metadata?: {
    frame?: Frame;
    signal?: Signal;
    signalIndex?: number;
    mux?: Mux;
    muxCase?: MuxCase;
    caseValue?: string;
    checksum?: FrameChecksum;
    checksumIndex?: number;
    nodeDef?: NodeDef;
    /** Comes from the frame's `mirror_of` source, so it is edited there. */
    inherited?: boolean;
  };
}

export interface MetaFields {
  name: string;
  version: number;
  default_frame?: ProtocolType;
  // NOTE: Protocol-specific config is in [meta.<protocol>], not here
  // - CAN: default_endianness, default_interval in [meta.can]
  // - Modbus: device_address, register_base in [meta.modbus]
  // - Serial: encoding in [meta.serial]
}

/** A selectable slave for the Modbus register editor: a node's display name and
 *  the `device_address` a register references it by. */
export interface SlaveOption {
  name: string;
  address: number;
}

export interface ValidationError {
  field: string;
  message: string;
  path?: string[];
}
