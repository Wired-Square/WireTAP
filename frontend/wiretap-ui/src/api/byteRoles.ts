// ui/src/api/byteRoles.ts
//
// Byte roles, Payload Changes and serial structure, classified in Rust by
// `wiretap_analysis` over a capture Rust reads itself.

import { invoke } from "@tauri-apps/api/core";
import type { ColumnStats } from "./checksums";
import type { ByteNotes } from "../generated/ByteNotes";
import type { Endianness } from "../generated/Endianness";
import type { MultiBytePattern } from "../generated/MultiBytePattern";
import type { MuxSelector } from "../generated/MuxSelector";
import type { ProtocolMirrors } from "../generated/ProtocolMirrors";
import type { ProtocolFrames } from "../utils/frameKey";
import type { Draft, Drafted } from "./drafting";

export type { Endianness, MultiBytePattern };

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

export interface MuxCase {
  value: number;
  sampleCount: number;
  columns: ByteColumn[];
  patterns: MultiBytePattern[];
}

export interface MuxAnalysis {
  detection: {
    /** `twoByte` keys a case as `byte0 * 256 + byte1`. */
    selector: MuxSelector;
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

/** One frame as Payload Changes reports it. */
export interface ChangesFrame extends FrameByteProfile {
  notes: ByteNotes;
  /** Message order finds it sent in bursts. */
  burst: boolean;
}

export interface PayloadChanges {
  /** The frames read for mirrors and bursts. */
  frameCount: number;
  frames: ChangesFrame[];
  skippedFrames: number;
  mirrors: ProtocolMirrors[];
}

/** Each selected frame profiled over its most recent 5000 payloads; mirrors and
 *  bursts over the newest `newest` frames, or the whole capture; folded into `draft`. */
export async function payloadChanges(
  captureId: string,
  selection: ProtocolFrames[],
  newest?: number,
  draft?: Draft | null,
): Promise<Drafted<PayloadChanges>> {
  return invoke<Drafted<PayloadChanges>>("payload_changes_cmd", { capture_id: captureId, selection, newest, draft });
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
