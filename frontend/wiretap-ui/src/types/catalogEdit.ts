// src/types/catalogEdit.ts
//
// TypeScript mirror of the `wiretap-catalog` crate's typed edit ops (src/edit.rs,
// src/edit/typed.rs), as `catalog.edits` and `catalog.build` deserialise them. The
// op field sets are snake_case; the model types nested in them (a header field, a
// checksum) keep the model's camelCase. Keep in sync with the crate.

import type { Confidence, DisplayHint, Endianness, Protocol, RegisterType } from "./catalogModel";

/** Trimmed and blank ones dropped by the crate; one is written as a string. */
export type Notes = string | string[];

export interface SignalFields {
  name: string;
  start_bit: number;
  bit_length: number;
  factor?: number;
  offset?: number;
  unit?: string;
  signed?: boolean;
  byte_order?: Endianness;
  min?: number;
  max?: number;
  format?: string;
  confidence?: Confidence | "";
  enum?: Record<string, string>;
  notes?: Notes;
  display?: DisplayHint;
}

export interface FrameFields {
  length?: number;
  transmitter?: string;
  interval_ms?: number;
  notes?: Notes;
  extended?: boolean;
  fd?: boolean;
  bus?: number;
  copy?: string;
  mirror_of?: string;
  delimiter?: number[];
  register_number?: number;
  node_address?: number;
  register_type?: RegisterType;
}

/** Blank is named by the crate. */
export interface MuxFields {
  name?: string;
  start_bit: number;
  bit_length: number;
  notes?: Notes;
}

export interface MetaFields {
  name: string;
  version: number;
  default_frame?: Protocol;
}

/** A number, or hex text with or without `0x`; text that is not hex is refused. */
export type Mask = number | string;

export interface HeaderField {
  mask: Mask;
  shift?: number;
  format?: string;
  endianness?: Endianness;
}

export interface ChecksumConfig {
  algorithm: string;
  startByte: number;
  byteLength?: number;
  calcStartByte?: number;
  calcEndByte?: number;
  bigEndian?: boolean;
}

export interface CanConfigFields {
  default_byte_order?: Endianness;
  default_interval?: number;
  default_extended?: boolean;
  default_fd?: boolean;
  frame_id_mask?: Mask;
  fields?: Record<string, HeaderField>;
}

export interface SerialConfigFields {
  encoding?: string;
  byte_order?: Endianness;
  frame_id_mask?: number;
  header_length?: number;
  min_frame_length?: number;
  checksum?: ChecksumConfig;
  fields?: Record<string, HeaderField>;
}

export interface ModbusConfigFields {
  device_address?: number;
  register_base?: number;
  default_interval?: number;
  default_byte_order?: Endianness;
  default_word_order?: Endianness;
}

export type EditOp =
  | { op: "UpsertSignal"; owner_path: string[]; index?: number; signal: SignalFields }
  | { op: "SetFrame"; protocol: Protocol; key: string; rename_from?: string; frame: FrameFields }
  | { op: "AddFrame"; protocol: Protocol; key: string; frame: FrameFields }
  | { op: "SetMux"; owner_path: string[]; mux: MuxFields }
  | { op: "SetMeta"; meta: MetaFields }
  | { op: "SetCanConfig"; config: CanConfigFields }
  | { op: "SetSerialConfig"; config: SerialConfigFields }
  | { op: "SetModbusConfig"; config: ModbusConfigFields }
  | { op: "DeleteAtPath"; path: string[] }
  | { op: "SetTable"; path: string[]; value: Record<string, unknown>; managed_keys?: string[]; sort_parent_numeric?: boolean; skip_if_exists?: boolean };
