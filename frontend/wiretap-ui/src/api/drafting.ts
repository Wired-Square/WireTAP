// ui/src/api/drafting.ts
//
// Discovery's catalogue draft, grown, previewed and written by
// `wiretap_analysis::draft` in Rust; the frontend only carries it between calls.

import { invoke } from "@tauri-apps/api/core";
import type { Endianness } from "../generated/Endianness";
import type { CandidateSignal } from "../generated/CandidateSignal";
import type { Draft } from "../generated/Draft";
import type { DraftFrame } from "../generated/DraftFrame";
import type { DraftPreview } from "../generated/DraftPreview";
import type { DraftWrite } from "../generated/DraftWrite";
import type { ExportedCatalog } from "../generated/ExportedCatalog";
import type { ExportFinding } from "../generated/ExportFinding";
import type { ExportFrame } from "../generated/ExportFrame";
import type { ExportMeta } from "../generated/ExportMeta";
import type { ModbusExportConfig } from "../generated/ModbusExportConfig";
import type { ModbusRegister } from "../generated/ModbusRegister";
import type { SerialConfig } from "../types/catalogModel";

export type { Draft, DraftFrame, ExportFinding, ExportFrame, ExportMeta, ModbusExportConfig };

/** An analysis' answer, and the draft it was folded into. */
export type Drafted<T> = { result: T; draft: Draft };

/** The draft with Discovery's frames in it, and each frame's signals as written. */
export async function draftPreview(draft: Draft | null, frames: DraftFrame[]): Promise<DraftPreview> {
  return invoke<DraftPreview>("draft_preview_cmd", { draft, frames });
}

/** A catalogue of `write.frames` under `meta`, a serial one framed by `serial`, refused unless it validates. */
export async function draftCatalog(
  draft: Draft | null,
  meta: ExportMeta,
  serial: SerialConfig | null,
  write: DraftWrite,
): Promise<ExportedCatalog> {
  return invoke<ExportedCatalog>("draft_catalog_cmd", { draft, meta, serial, write });
}

/** A catalogue declaring each frame's id and length, keyed in hex or decimal. */
export async function exportFramesCatalog(frames: ExportFrame[], meta: ExportMeta, decimalIds: boolean): Promise<string> {
  return invoke<string>("export_frames_catalog_cmd", { frames, meta, decimal_ids: decimalIds });
}

/** A catalogue with one frame per register a Modbus scan found. */
export async function exportModbusCatalog(
  registers: ModbusRegister[],
  meta: ExportMeta,
  config: ModbusExportConfig,
): Promise<string> {
  return invoke<string>("export_modbus_catalog_cmd", { registers, meta, config });
}

/** The `byte_*` signals over bytes `start..=end`; `hints` skip a static or counter byte. */
export async function candidateSignals(
  start: number,
  end: number,
  widths: number[],
  orders: Endianness[],
  hints?: { position: number; role: string }[],
): Promise<CandidateSignal[]> {
  return invoke<CandidateSignal[]>("candidate_signals_cmd", { start, end, widths, orders, hints });
}
