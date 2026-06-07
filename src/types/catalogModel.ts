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
}

export interface MuxCase {
  signals: Signal[];
  mux?: Mux;
}

export interface Mux {
  name?: string;
  startBit: number;
  bitLength: number;
  /** Case key (`"0"`, `"0-3"`, `"1,2,5"`) → its signals/nested mux. */
  cases: Record<string, MuxCase>;
}

export interface Frame {
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

export interface Catalog {
  meta: Meta;
  protocol: Protocol;
  can?: CanConfig;
  serial?: SerialConfig;
  modbus?: ModbusConfig;
  frames: Frame[];
}
