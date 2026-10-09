// ui/src/apps/catalog/editorOps.ts
//
// Catalogue edit operations. Each builds an `EditOp` and applies it in Rust (the
// wiretap-catalog crate, via toml_edit) so comments and formatting survive. The
// typed ops (frames, signals, mux, meta, protocol configs) own what is written;
// the generic ones write what they are given.

import type { ProtocolType, ChecksumAlgorithm } from "./types";
import { editCatalog, editCatalogOps } from "../../api/catalog";
import type {
  CanConfigFields,
  EditOp,
  FrameFields,
  MetaFields,
  ModbusConfigFields,
  MuxFields,
  SerialConfigFields,
  SignalFields,
} from "../../types/catalogEdit";

function isNumericSegment(seg: string): boolean {
  return /^-?\d+$/.test(seg);
}

/** Drop only-undefined keys; keep `false`/`0`/`""`. */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function normalizeSignalTarget(targetPath: string[], index: number | null): { ownerPath: string[]; index: number | null } {
  if (
    index === null &&
    targetPath.length >= 2 &&
    targetPath[targetPath.length - 2] === "signals" &&
    isNumericSegment(targetPath[targetPath.length - 1])
  ) {
    const idx = Number(targetPath[targetPath.length - 1]);
    return { ownerPath: targetPath.slice(0, -2), index: idx };
  }
  return { ownerPath: targetPath, index };
}

// ── catalogue scaffolding ─────────────────────────────────────────────────────

export function metaOp(meta: MetaFields): EditOp {
  return { op: "SetMeta", meta: { name: meta.name, version: meta.version, default_frame: meta.default_frame } };
}

export function deleteOp(path: string[]): EditOp {
  return { op: "DeleteAtPath", path };
}

export const canConfigOp = (config: CanConfigFields): EditOp => ({ op: "SetCanConfig", config });

export const serialConfigOp = (config: SerialConfigFields): EditOp => ({ op: "SetSerialConfig", config });

export const modbusConfigOp = (config: ModbusConfigFields): EditOp => ({ op: "SetModbusConfig", config });

// ============================================================================
// Frames
// ============================================================================

/** A new frame (`originalKey` null) or the whole of an existing one's own keys. */
export function saveFrameToml(
  toml: string,
  protocol: ProtocolType,
  key: string,
  frame: FrameFields,
  originalKey: string | null,
): Promise<string> {
  const op: EditOp =
    originalKey === null
      ? { op: "AddFrame", protocol, key, frame }
      : { op: "SetFrame", protocol, key, rename_from: originalKey === key ? undefined : originalKey, frame };
  return editCatalogOps(toml, [op]);
}

export function deleteFrameToml(toml: string, protocol: ProtocolType, key: string): Promise<string> {
  return editCatalog(toml, { op: "DeleteAtPath", path: ["frame", protocol, key] });
}

// ============================================================================
// Signals
// ============================================================================

export function upsertSignalToml(toml: string, targetPath: string[], signal: SignalFields, index: number | null): Promise<string> {
  const { ownerPath, index: idx } = normalizeSignalTarget(targetPath, index);
  return editCatalogOps(toml, [{ op: "UpsertSignal", owner_path: ownerPath, index: idx ?? undefined, signal }]);
}

export function deleteSignalToml(toml: string, signalsParentPath: string[], index: number): Promise<string> {
  const { ownerPath, index: idx } = normalizeSignalTarget(signalsParentPath, index);
  return editCatalog(toml, {
    op: "RemoveArrayItem",
    array_path: [...ownerPath, "signals"],
    index: idx ?? index,
    remove_if_empty: false,
  });
}

// ============================================================================
// Mux
// ============================================================================

/** A blank name is minted by the crate from the owner, start bit and length. */
export function upsertMuxToml(toml: string, muxOwnerPath: string[], mux: MuxFields): Promise<string> {
  return editCatalogOps(toml, [{ op: "SetMux", owner_path: muxOwnerPath, mux }]);
}

export function deleteMuxToml(toml: string, muxPath: string[]): Promise<string> {
  return editCatalog(toml, { op: "DeleteAtPath", path: muxPath });
}

export async function addMuxCaseToml(toml: string, muxPath: string[], caseValue: string, notes?: string): Promise<{ toml: string; didAdd: boolean }> {
  try {
    const next = await editCatalog(toml, {
      op: "SetTable",
      path: [...muxPath, caseValue],
      value: compact({ notes: notes || undefined }),
      managed_keys: ["notes"],
      error_if_exists: true,
    });
    return { toml: next, didAdd: true };
  } catch {
    return { toml, didAdd: false };
  }
}

export function deleteMuxCaseToml(toml: string, muxPath: string[], caseValue: string): Promise<string> {
  return editCatalog(toml, { op: "DeleteAtPath", path: [...muxPath, caseValue] });
}

export async function editMuxCaseToml(
  toml: string,
  muxPath: string[],
  oldCaseValue: string,
  newCaseValue: string,
  notes?: string
): Promise<{ toml: string; success: boolean; error?: string }> {
  try {
    const next = await editCatalog(toml, {
      op: "RenameKey",
      parent_path: muxPath,
      old: oldCaseValue,
      new: newCaseValue,
      set_value: compact({ notes: notes || undefined }),
      managed_keys: ["notes"],
      error_if_exists: true,
    });
    return { toml: next, success: true };
  } catch (e) {
    return { toml, success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================================
// Nodes
// ============================================================================

export function addNodeToml(
  toml: string,
  nodeName: string,
  notes?: string,
  deviceAddress?: number,
): Promise<string> {
  return editCatalog(toml, {
    op: "SetTable",
    path: ["node", nodeName],
    value: compact({ device_address: deviceAddress, notes: notes || undefined }),
    managed_keys: ["device_address", "notes"],
    sort_parent_numeric: true,
    skip_if_exists: true,
  });
}

export function deleteNodeToml(toml: string, nodeName: string): Promise<string> {
  return editCatalog(toml, { op: "DeleteAtPath", path: ["node", nodeName] });
}

export async function editNodeToml(
  toml: string,
  oldName: string,
  newName: string,
  notes?: string,
  deviceAddress?: number,
): Promise<{ toml: string; success: boolean; error?: string }> {
  try {
    const next = await editCatalog(toml, {
      op: "RenameKey",
      parent_path: ["node"],
      old: oldName,
      new: newName,
      set_value: compact({ device_address: deviceAddress, notes: notes || undefined }),
      managed_keys: ["device_address", "notes"],
      sort_numeric: true,
      update_transmitter_refs: true,
      error_if_exists: true,
    });
    return { toml: next, success: true };
  } catch (e) {
    return { toml, success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Generic delete: removes the final path segment from its parent. */
export function deleteTomlAtPath(toml: string, path: string[]): Promise<string> {
  return editCatalog(toml, { op: "DeleteAtPath", path });
}

// ============================================================================
// Checksums
// ============================================================================

export interface ChecksumData {
  name: string;
  algorithm: ChecksumAlgorithm;
  start_byte: number;
  byte_length: number;
  endianness?: "little" | "big";
  calc_start_byte: number;
  calc_end_byte: number;
  notes?: string;
}

const CHECKSUM_SORT_KEYS = ["start_byte", "name"];

export function upsertChecksumToml(
  toml: string,
  checksumParentPath: string[],
  checksum: ChecksumData,
  index: number | null
): Promise<string> {
  const value = compact({
    name: checksum.name,
    algorithm: checksum.algorithm,
    start_byte: checksum.start_byte,
    byte_length: checksum.byte_length,
    calc_start_byte: checksum.calc_start_byte,
    calc_end_byte: checksum.calc_end_byte,
    endianness: checksum.endianness && checksum.byte_length > 1 ? checksum.endianness : undefined,
    notes: checksum.notes || undefined,
  });
  return editCatalog(toml, {
    op: "UpsertArrayItem",
    array_path: [...checksumParentPath, "checksum"],
    value,
    index: index ?? undefined,
    sort_keys: CHECKSUM_SORT_KEYS,
  });
}

export function deleteChecksumToml(toml: string, checksumParentPath: string[], index: number): Promise<string> {
  return editCatalog(toml, {
    op: "RemoveArrayItem",
    array_path: [...checksumParentPath, "checksum"],
    index,
    remove_if_empty: true,
  });
}
