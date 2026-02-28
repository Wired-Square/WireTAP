// ui/src/apps/catalog/types.ts

import type { ChecksumAlgorithm as CA } from "../../utils/analysis/checksums";

// Re-export checksum type for consumers
export type ChecksumAlgorithm = CA;

export type EditMode = "text" | "ui";

export type TomlNodeType =
  | "section"
  | "array"
  | "value"
  | "table-array"
  | "signal"
  | "checksum"
  | "inline-table"
  | "meta"
  | "can-frame"
  | "can-config"
  | "modbus-frame"
  | "modbus-config"
  | "serial-frame"
  | "serial-config"
  | "node"
  | "mux"
  | "mux-case";

// ============================================================================
// Protocol Types - Generic frame architecture
// ============================================================================

/** Supported protocol types */
export type ProtocolType = "can" | "modbus" | "serial";

/** Signal definition - protocol-agnostic */
export interface SignalDefinition {
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
  notes?: string;
}

/** Mux definition - protocol-agnostic */
export interface MuxDefinition {
  name?: string;
  start_bit: number;
  bit_length: number;
  default?: string;
  [caseKey: string]: any; // Case values contain signals and nested mux
}

/** Checksum definition - protocol-agnostic */
export interface ChecksumDefinition {
  name: string;
  algorithm: ChecksumAlgorithm;
  start_byte: number;           // Byte offset where checksum value is stored
  byte_length: number;          // Length of checksum value (1 or 2 bytes)
  endianness?: "little" | "big"; // Byte order for multi-byte checksums (default: big)
  calc_start_byte: number;      // First byte included in calculation
  calc_end_byte: number;        // Last byte (exclusive) included in calculation
  notes?: string;
}

/** Common frame fields shared by ALL protocols */
export interface BaseFrameFields {
  length: number;
  transmitter?: string;
  interval?: number;
  notes?: string | string[];
  signals?: SignalDefinition[];
  mux?: MuxDefinition;
  checksums?: ChecksumDefinition[];
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
  register_number: number;       // Starting register address
  device_address: number;        // Modbus slave address (1-247)
  register_type?: "holding" | "input" | "coil" | "discrete";
  register_base?: 0 | 1;         // 0-based or 1-based addressing (some manufacturers differ)
}

/** Header field format for display */
export type HeaderFieldFormat = "hex" | "decimal";

/** CAN header field - extracts value from CAN ID using bitmask */
export interface CanHeaderField {
  mask: number;                    // Bitmask to apply to CAN ID
  shift?: number;                  // Right-shift after masking (default: 0)
  format?: HeaderFieldFormat;      // Display format (default: hex)
}

/** Serial header field - named mask over header bytes */
export interface SerialHeaderField {
  mask: number;                    // Bitmask over header bytes (e.g., 0xFF00 for first byte of 2-byte header)
  endianness?: "big" | "little";   // Byte order (default: big)
  format?: HeaderFieldFormat;      // Display format (default: hex)
  // Legacy fields (for backward compatibility during parsing)
  start_byte?: number;             // DEPRECATED: Use mask instead
  bytes?: number;                  // DEPRECATED: Use mask instead
}

/** CAN protocol config - stored in [frame.can.config] */
export interface CanProtocolConfig {
  default_endianness: "little" | "big";  // Endianness for signal decoding
  default_interval?: number;              // Default transmit interval in ms
  /** Default to 29-bit extended IDs (default: false = 11-bit standard) */
  default_extended?: boolean;
  /** Default to CAN FD frames (default: false = classic CAN) */
  default_fd?: boolean;
  /** Mask applied to frame_id before matching catalog entries (e.g., 0x1FFFFF00 for J1939 to mask off source) */
  frame_id_mask?: number;
  /** Named header fields extracted from CAN ID */
  fields?: Record<string, CanHeaderField>;
}

/** Modbus protocol config - stored in [meta.modbus] */
export interface ModbusProtocolConfig {
  device_address: number;      // Default slave address (1-247)
  register_base: 0 | 1;        // 0-based or 1-based register addressing
  default_interval?: number;   // Default poll interval in milliseconds
  default_byte_order?: "big" | "little";  // Default byte order for multi-register values
  default_word_order?: "big" | "little";  // Default word order for multi-register values (word swap)
}

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
  /** End of calculation range (exclusive, supports negative indexing) */
  calc_end_byte: number;
  /** Whether checksum value is big-endian (default: false = little-endian) */
  big_endian?: boolean;
}

/** Serial protocol config - stored in [meta.serial] */
export interface SerialProtocolConfig {
  encoding: SerialEncoding;
  /** Default byte order for signal decoding (inherited by all signals unless overridden) */
  byte_order?: "little" | "big";
  /** Global header length in bytes (required when header fields are defined) */
  header_length?: number;
  /** Maximum frame length in bytes (default: 64). Safety limit for malformed framing. */
  max_frame_length?: number;
  /** Named header fields - masks over header bytes (ID field is used for frame matching) */
  fields?: Record<string, SerialHeaderField>;
  /** Protocol-level checksum configuration (applies to all frames) */
  checksum?: SerialChecksumConfig;
  /** @deprecated Use 'id' header field instead. Kept for backward compatibility. */
  frame_id_mask?: number;
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

/** Helper to get protocol type from config */
export function getProtocolType(config: ProtocolConfig): ProtocolType {
  return config.protocol;
}

export interface TomlNode {
  key: string;
  type: TomlNodeType;
  value?: any;
  children?: TomlNode[];
  path: string[];
  rawContent?: string;
  metadata?: {
    frameType?: ProtocolType;
    isCopy?: boolean;
    copyFrom?: string;
    isMirror?: boolean;
    mirrorOf?: string;
    isArray?: boolean;
    arrayItems?: any[];
    properties?: Record<string, any>;
    isMeta?: boolean;
    isId?: boolean;
    isNode?: boolean;
    idValue?: string;
    // CAN-specific
    extended?: boolean;
    extendedInherited?: boolean;
    fd?: boolean;
    fdInherited?: boolean;
    bus?: number;
    // Modbus-specific
    registerNumber?: number;
    deviceAddress?: number;
    deviceAddressInherited?: boolean;
    registerType?: "holding" | "input" | "coil" | "discrete";
    registerBase?: 0 | 1;
    registerBaseInherited?: boolean;
    // Serial-specific
    encoding?: "slip" | "cobs" | "raw" | "length_prefixed";
    frameId?: string;
    delimiter?: number[];
    maxLength?: number;
    // Common frame fields
    length?: number;
    lengthInherited?: boolean;
    transmitter?: string;
    transmitterInherited?: boolean;
    interval?: number;
    intervalInherited?: boolean;
    notes?: string | string[];
    signals?: any[];
    /** Bit keys (start_bit:bit_length) of signals inherited from mirror primary */
    inheritedSignalBitKeys?: Set<string>;
    hasMux?: boolean;
    muxSignalCount?: number;
    // Mux-specific
    muxCase?: string;
    muxName?: string;
    muxStartBit?: number;
    muxBitLength?: number;
    muxDefaultCase?: string;
    caseValue?: string;
    // Signal-specific
    signalStartBit?: number;
    signalBitLength?: number;
    signalIndex?: number;
    // Checksum-specific
    checksumAlgorithm?: ChecksumAlgorithm;
    checksumStartByte?: number;
    checksumByteLength?: number;
    checksumEndianness?: "little" | "big";
    checksumCalcStartByte?: number;
    checksumCalcEndByte?: number;
    checksumIndex?: number;
    checksums?: ChecksumDefinition[];
  };
}

export type TreeNode = TomlNode;

export interface MetaFields {
  name: string;
  version: number;
  // NOTE: Protocol-specific config is in [meta.<protocol>], not here
  // - CAN: default_endianness, default_interval in [meta.can]
  // - Modbus: device_address, register_base in [meta.modbus]
  // - Serial: encoding in [meta.serial]
}

export interface CanidFields {
  id: string;
  length: number;
  transmitter?: string;
  interval?: number;
  isIntervalInherited?: boolean;
  isLengthInherited?: boolean;
  isTransmitterInherited?: boolean;
  notes?: string | string[];
}

export interface ParsedCatalogTree {
  tree: TomlNode[];
  meta: MetaFields | null;
  peers: string[];
  canConfig?: CanProtocolConfig;        // From [frame.can.config] section
  modbusConfig?: ModbusProtocolConfig;  // From [frame.modbus.config] section
  serialConfig?: SerialProtocolConfig;  // From [frame.serial.config] section
  hasCanFrames?: boolean;               // True if [frame.can] section has frames (excluding config)
  hasModbusFrames?: boolean;            // True if [frame.modbus] section has frames (excluding config)
  hasSerialFrames?: boolean;            // True if [frame.serial] section has frames (excluding config)
}

export interface ValidationError {
  field: string;
  message: string;
  path?: string[];
}
