// ui/src/api/drafting.ts
//
// Discovery's catalogue draft, grown, previewed and written by
// `wiretap_analysis::draft` in Rust; the frontend only carries it between calls.

import { invoke } from "@tauri-apps/api/core";
import type { ByteOrder } from "../generated/ByteOrder";
import type { CandidateSignal } from "../generated/CandidateSignal";
import type { Draft } from "../generated/Draft";
import type { DraftFrame } from "../generated/DraftFrame";
import type { DraftPreview } from "../generated/DraftPreview";
import type { DraftWrite } from "../generated/DraftWrite";
import type { EditOp } from "../types/catalogEdit";

export type { Draft, DraftFrame };

/** An analysis' answer, and the draft it was folded into. */
export type Drafted<T> = { result: T; draft: Draft };

/** The draft with Discovery's frames in it, and each frame's signals as written. */
export async function draftPreview(draft: Draft | null, frames: DraftFrame[]): Promise<DraftPreview> {
  return invoke<DraftPreview>("draft_preview_cmd", { draft, frames });
}

/** A catalogue of `write.frames` after the meta and config ops `head`, refused unless it validates. */
export async function draftCatalog(draft: Draft | null, head: EditOp[], write: DraftWrite): Promise<string> {
  return invoke<string>("draft_catalog_cmd", { draft, head, write });
}

/** The `byte_*` signals over bytes `start..=end`; `hints` skip a static or counter byte. */
export async function candidateSignals(
  start: number,
  end: number,
  widths: number[],
  orders: ByteOrder[],
  hints?: { position: number; role: string }[],
): Promise<CandidateSignal[]> {
  return invoke<CandidateSignal[]>("candidate_signals_cmd", { start, end, widths, orders, hints });
}
