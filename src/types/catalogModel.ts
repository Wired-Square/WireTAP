// src/types/catalogModel.ts
//
// TypeScript mirror of the `wiretap-catalog` crate's unified resolved model
// (src/model.rs). The crate serialises camelCase, so these names track its
// serde output 1:1 — this is the shape returned by the `catalog.parse` WS
// command (see api/catalog.ts `parseCatalog`). Keep in sync with the crate.

export type Protocol = "can" | "serial" | "modbus";
export type Endianness = "big" | "little";
export type RegisterType = "input" | "holding" | "coil" | "discrete";
export type SignalFormat = "ascii" | "utf8" | "hex" | "enum" | "unix_time" | "other";
export type Confidence = "none" | "low" | "medium" | "high";

export interface Signal {
  name?: string;
  startBit?: number;
  bitLength?: number;
  signed?: boolean;
  /** Byte order (the catalogue's `byte_order`/legacy `endianness`, resolved). */
  endianness?: Endianness;
  wordOrder?: Endianness;
  factor?: number;
  offset?: number;
  unit?: string;
  min?: number;
  max?: number;
  format?: SignalFormat;
  /** Value→label map (the crate serialises `enum_map` as `enum`). */
  enum?: Record<string, string>;
  confidence?: Confidence;
  /** True when inherited from a mirror/copy source. Omitted when false. */
  inherited?: boolean;
  /** Modbus-specific: the signal's own register number (synthesised by the crate). */
  modbusRegister?: number;
  /** Modbus-specific: how many registers/coils the signal spans. */
  modbusRegisterCount?: number;
}

export interface MuxCase {
  signals: Signal[];
  mux?: Mux;
  /** Free-text notes on the case. */
  notes?: string[];
}

export interface Mux {
  name?: string;
  startBit: number;
  bitLength: number;
  /** Default case key applied when the selector matches no explicit case. */
  default?: string;
  /** Free-text notes on the multiplexer. */
  notes?: string[];
  /** Case key (`"0"`, `"0-3"`, `"1,2,5"`) → its signals/nested mux. */
  cases: Record<string, MuxCase>;
}

/** A per-frame checksum definition (`[[frame.<proto>.<key>.checksum]]`). */
export interface FrameChecksum {
  name?: string;
  algorithm: string;
  startByte: number;
  byteLength: number;
  endianness?: Endianness;
  calcStartByte: number;
  calcEndByte?: number;
}

export interface Frame {
  /** Authored catalogue table key (CAN: `"0x103"`; serial/modbus: the name) —
   *  the stable identifier for the editor tree path and edits. */
  key: string;
  /** Numeric id: CAN arbitration id, serial frame id, or Modbus register. */
  frameId: number;
  protocol: Protocol;
  /** Catalogue table key when meaningful (e.g. a Modbus frame's `ems_control`). */
  name?: string;
  /** Length in bytes. */
  length: number;
  transmitter?: string;
  interval?: number;
  bus?: number;
  isExtended?: boolean;
  isFd?: boolean;
  signals: Signal[];
  mux?: Mux;
  mirrorOf?: string;
  copyFrom?: string;
  modbusRegisterType?: RegisterType;
  /** Modbus register count (not bytes). */
  modbusRegisterCount?: number;
  /** Serial-specific: explicit frame delimiter bytes (raw encoding). */
  delimiter?: number[];
  /** Free-text notes (normalised from a string or array of strings). */
  notes?: string[];
  /** Per-frame checksums (CAN/serial; absent on Modbus). */
  checksums?: FrameChecksum[];
  /** Fields whose value was inherited rather than set explicitly — drives the
   *  editor's "(inherited)" labels. Entries: `length`, `transmitter`,
   *  `interval`, `extended`, `fd`, `deviceAddress`, `registerBase`. */
  inheritedFields?: string[];
}

export interface HeaderField {
  mask: number;
  shift?: number;
  format?: string;
  endianness?: Endianness;
}

export interface CanConfig {
  defaultByteOrder?: Endianness;
  defaultInterval?: number;
  defaultExtended?: boolean;
  defaultFd?: boolean;
  frameIdMask?: number;
  fields?: Record<string, HeaderField>;
}

export interface ChecksumConfig {
  algorithm: string;
  startByte: number;
  byteLength: number;
  calcStartByte: number;
  calcEndByte?: number;
  bigEndian: boolean;
}

/** A serial header field with its byte position derived from the mask at parse time. */
export interface HeaderFieldPosition {
  name: string;
  mask: number;
  byteOrder: Endianness;
  /** `hex` or `decimal` display. */
  format: string;
  startByte: number;
  bytes: number;
}

export interface SerialConfig {
  encoding?: string;
  byteOrder?: Endianness;
  frameIdMask?: number;
  headerLength?: number;
  minFrameLength?: number;
  checksum?: ChecksumConfig;
  fields?: Record<string, HeaderField>;
  // Derived from `fields` at parse time (byte positions of named fields).
  frameIdStartByte?: number;
  frameIdBytes?: number;
  frameIdByteOrder?: Endianness;
  sourceAddressStartByte?: number;
  sourceAddressBytes?: number;
  sourceAddressByteOrder?: Endianness;
  headerFields?: HeaderFieldPosition[];
}

export interface ModbusConfig {
  deviceAddress?: number;
  /** 0 = IEC (0-based); 1 = traditional 1-based with type prefix. */
  registerBase?: number;
  defaultInterval?: number;
  defaultByteOrder?: Endianness;
  defaultWordOrder?: Endianness;
}

export interface Meta {
  name: string;
  version: number;
  defaultFrame?: Protocol;
}

/** A network node/peer declared under `[node.<name>]`. */
export interface NodeDef {
  name: string;
  notes?: string[];
}

export interface Catalog {
  meta: Meta;
  protocol: Protocol;
  can?: CanConfig;
  serial?: SerialConfig;
  modbus?: ModbusConfig;
  frames: Frame[];
  /** Network nodes/peers from the `[node]` table, in key order. */
  nodes?: NodeDef[];
}
