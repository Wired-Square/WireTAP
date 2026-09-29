// ui/src/api/byteRoles.ts
//
// Byte roles and serial structure, classified in Rust by `wiretap_analysis`.
// Payloads are read oldest first and contiguous: a capture by Rust itself, or
// the frames the frontend holds when nothing has written them to one.

import { invoke } from "@tauri-apps/api/core";
import type { ColumnStats, DiscoveryFrame } from "./checksums";
import type { ProtocolFrames } from "../utils/frameKey";

export type ByteRole =
  | { role: "static"; value: number }
  | {
      role: "counter";
      direction: "up" | "down";
      step: number;
      rollover: boolean;
      looping: { min: number; max: number; modulo: number } | null;
    }
  | { role: "sensor"; trend: "increasing" | "decreasing" | "mixed"; strength: number; rollover: boolean }
  | { role: "value" }
  | { role: "unknown" };

/** A front-addressed column: `position` ≥ 0, and `sampleCount` the payloads that reach it. */
export type ByteColumn = ColumnStats & ByteRole;

export type Endianness = "little" | "big" | "mixed";

export interface MultiBytePattern {
  start: number;
  len: number;
  kind: "counter16" | "sensor16" | "sensor32" | "text";
  endianness: "little" | "big" | null;
  rollover: boolean;
  correlatedRollover: boolean;
  slowUpperBytes: boolean;
  range: [number, number] | null;
  sampleText: string | null;
}

export interface MuxCase {
  value: number;
  sampleCount: number;
  columns: ByteColumn[];
  patterns: MultiBytePattern[];
}

export interface MuxAnalysis {
  detection: {
    /** `twoByte` keys a case as `byte0 * 256 + byte1`. */
    selector: "oneByte" | "twoByte";
    occurrences: Record<string, number>;
  };
  cases: MuxCase[];
}

export interface ByteProfile {
  sampleCount: number;
  minLen: number;
  maxLen: number;
  identical: number[] | null;
  analysedFrom: number;
  /** `analysedFrom..maxLen`, over every payload. */
  columns: ByteColumn[];
  patterns: MultiBytePattern[];
  endianness: Endianness | null;
  mux: MuxAnalysis | null;
}

export interface FrameByteProfile extends ByteProfile {
  protocol?: string;
  frameId: number;
  isExtended: boolean;
  frameIdHex: string;
}

export type ByteProfileSource =
  | { captureId: string; selection: ProtocolFrames[] }
  | { frames: DiscoveryFrame[] };

/** Profile each frame's most recent 5000 payloads. */
export async function profileBytes(source: ByteProfileSource): Promise<FrameByteProfile[]> {
  const wire =
    "captureId" in source ? { capture_id: source.captureId, selection: source.selection } : source;
  return invoke<FrameByteProfile[]>("profile_bytes_cmd", { source: wire });
}

export type CandidateReason =
  | { code: "protocolMarkers" }
  | { code: "commandIds" }
  | { code: "typeSubtype"; firstByteValues: number }
  | { code: "deviceCount"; count: number }
  | { code: "addressCount"; count: number }
  | { code: "twelveBitRange" }
  | { code: "evenDistribution" }
  | { code: "smallAddresses" }
  | { code: "noZeroAddress" };

/** Bytes `start..start + len`, big-endian, as an id or source-address field. */
export interface FieldCandidate {
  start: number;
  len: 1 | 2;
  values: number[];
  sampleCount: number;
  /** 0–100 */
  confidence: number;
  reasons: CandidateReason[];
}

export interface SerialStructure {
  sampleCount: number;
  minLen: number;
  maxLen: number;
  /** Best first. */
  ids: FieldCandidate[];
  sources: FieldCandidate[];
}

export async function serialStructure(payloads: number[][]): Promise<SerialStructure> {
  return invoke<SerialStructure>("serial_structure_cmd", { payloads });
}
