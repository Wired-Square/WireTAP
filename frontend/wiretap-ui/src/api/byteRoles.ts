// ui/src/api/byteRoles.ts
//
// Byte roles, Payload Changes and serial structure, classified in Rust by
// `wiretap_analysis` over a capture Rust reads itself.

import { invoke } from "@tauri-apps/api/core";
import type { PayloadChanges } from "../generated/PayloadChanges";
import type { SerialStructure } from "../generated/SerialStructure";
import type { ProtocolFrames } from "../utils/frameKey";
import type { Draft, Drafted } from "./drafting";

export type { ByteColumn } from "../generated/ByteColumn";
export type { CandidateReason } from "../generated/CandidateReason";
export type { ChangesFrame } from "../generated/ChangesFrame";
export type { FieldCandidate } from "../generated/FieldCandidate";
export type { MultiBytePattern } from "../generated/MultiBytePattern";
export type { MuxCaseProfile } from "../generated/MuxCaseProfile";

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

export async function serialStructure(payloads: number[][]): Promise<SerialStructure> {
  return invoke<SerialStructure>("serial_structure_cmd", { payloads });
}
