// ui/src/types/decoder.ts

import type { Confidence, Endianness, SignalFormat } from "./catalog";

export type SignalDef = {
  name?: string;
  start_bit?: number;
  bit_length?: number;
  signed?: boolean;
  endianness?: Endianness;
  word_order?: Endianness;
  factor?: number;
  offset?: number;
  unit?: string;
  format?: SignalFormat;
  enum?: Record<number, string>;
  confidence?: Confidence;
  /** True if this signal is inherited from a mirror source frame */
  _inherited?: boolean;
};

export type MuxCaseDef = {
  signals: SignalDef[];
  mux?: MuxDef;
};

export type MuxDef = {
  name?: string;
  start_bit: number;
  bit_length: number;
  /** Case keys can be single values ("0"), ranges ("0-3"), or comma-separated ("1,2,5") */
  cases: Record<string, MuxCaseDef>;
};

export type FrameDetail = {
  id: number;
  len: number;
  isExtended?: boolean;
  bus?: number;
  lenMismatch?: boolean;
  signals: SignalDef[];
  mux?: MuxDef;
  /** Expected transmission interval in milliseconds */
  interval?: number;
  /** Frame ID this frame mirrors (inherits signals from) */
  mirrorOf?: string;
  /** Frame ID this frame copies metadata from */
  copyFrom?: string;
};

export type CatalogSettings = {
  decoder_dir?: string;
  default_read_profile?: string | null;
  io_profiles?: { id: string; name: string }[];
  display_frame_id_format?: "hex" | "decimal";
  save_frame_id_format?: "hex" | "decimal";
  signal_colour_none?: string;
  signal_colour_low?: string;
  signal_colour_medium?: string;
  signal_colour_high?: string;
};
