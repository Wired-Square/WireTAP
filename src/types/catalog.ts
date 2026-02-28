// ui/src/types/catalog.ts

export type Endianness = "little" | "big";
export type Confidence = "none" | "low" | "medium" | "high";
export type SignalFormat = "enum" | "ascii" | "utf8" | "hex" | "unix_time";

export interface CopySub {
  pattern: string;
  repl: string;
  flags?: string; // e.g. "i" for case-insensitive
}

export interface MetaDoc {
  version?: number;
  name?: string;
  default_endianness?: Endianness;
  role?: string;
  default_interval?: number;
}

export interface SignalDoc {
  name: string;
  start_bit: number;
  bit_length: number;
  factor?: number;
  offset?: number;
  unit?: string;
  signed?: boolean;
  endianness?: Endianness;
  word_order?: Endianness;
  min?: number;
  max?: number;
  enum?: Record<number, string>;
  confidence?: Confidence;
  confirmed?: boolean; // alias for confidence
  order?: number;
  format?: SignalFormat;
  notes?: string | string[];
}

export interface MuxCaseDoc {
  signals?: SignalDoc[];
  mux?: MuxDoc;
}

export interface MuxDoc {
  name?: string;
  start_bit: number;
  bit_length: number;
  case?: Record<number, MuxCaseDoc>;
  duplicates?: number[];
}

export interface IdTxDoc {
  interval_ms?: number;
  default_value?: string; // hex string
}

export interface IdBodyDoc {
  name?: string;
  copy?: number | string; // copy_of in Python
  bus?: string;
  length?: number;
  order?: number;
  signals?: SignalDoc[];
  mux?: MuxDoc | MuxDoc[];
  copy_sub?: CopySub[];
  tx?: IdTxDoc;
  transmitter?: string | string[]; // Node(s) that transmit this frame
  tx_interval_ms?: number;
}

export interface IdDoc extends IdBodyDoc {
  id: number | string;
}

export interface SetDoc {
  ids?: (number | string)[];
  signals?: string[]; // wildcard patterns
}

export interface PeerStartupDoc {
  burst?: number;
  ids?: (number | string)[];
}

export interface PeerTxDoc {
  default_interval?: number;
  ids?: (number | string)[];
}

export interface PeerDoc {
  default_interval?: number;
  startup?: PeerStartupDoc;
  tx?: PeerTxDoc;
}

export interface CatalogDoc {
  meta?: MetaDoc;
  sets?: Record<string, SetDoc>;
  peer?: Record<string, PeerDoc>;
  id?: Record<string, IdBodyDoc>; // Keyed style: id["0x123"]
  // Note: list-style [[id]] is less common in practice, keyed is preferred
}

// Helper types for UI state
export interface CatalogFile {
  path: string;
  name: string;
  document: CatalogDoc;
  isDirty: boolean;
  lastSaved?: Date;
}

export interface ValidationError {
  path: string[];
  message: string;
  severity: "error" | "warning";
}

// Decoded signal for preview/testing
export interface DecodedSignal {
  signal: string;
  value: number;
  scaled: number;
  unit?: string;
  enum_label?: string;
  raw_hex: string;
}
