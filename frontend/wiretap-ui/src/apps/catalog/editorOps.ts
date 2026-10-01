// ui/src/apps/catalog/editorOps.ts
//
// Catalogue edit operations. Each builds an `EditOp` payload and applies it in Rust
// (the wiretap-catalog crate, via toml_edit) so comments and formatting survive —
// only the targeted entry changes. The typed ops (signals, mux, meta, protocol
// configs) carry their elision rules in the crate; for the generic ones, which
// fields to write is decided here.

import type { MetaFields, ProtocolType, BaseFrameFields, ProtocolConfig, SerialConfig, CanProtocolConfig, ModbusProtocolConfig, SerialProtocolConfig, ChecksumAlgorithm } from "./types";
import { tomlParse } from "./toml";
import { editCatalog, editCatalogOps } from "../../api/catalog";
import type { Confidence, DisplayHint } from "../../types/catalogModel";
import type { EditOp } from "../../types/catalogEdit";
import { protocolRegistry } from "./protocols";

// ── small pure helpers (path/data shaping stays in TS) ───────────────────────

function isNumericSegment(seg: string): boolean {
  return /^-?\d+$/.test(seg);
}

/** Drop only-undefined keys; keep `false`/`0`/`""`. Mirrors the old "only write
 *  non-default fields" object building (undefined is dropped by JSON anyway, but
 *  being explicit keeps payloads clean). */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function normalizeSignalTarget(targetPath: string[], index: number | null): { ownerPath: string[]; index: number | null } {
  // Allow callers to pass a full signal-node path like [..., "signals", "3"].
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

// ============================================================================
// Protocol configs ([meta.can], [meta.serial], [meta.modbus])
// ============================================================================

export function canConfigOp(config: CanProtocolConfig): EditOp {
  return {
    op: "SetCanConfig",
    config: {
      default_byte_order: config.default_endianness,
      default_interval: config.default_interval,
      default_extended: config.default_extended,
      default_fd: config.default_fd,
      frame_id_mask: config.frame_id_mask,
      fields: config.fields,
    },
  };
}

export function serialConfigOp(config: SerialProtocolConfig): EditOp {
  const { checksum } = config;
  return {
    op: "SetSerialConfig",
    config: {
      encoding: config.encoding,
      byte_order: config.byte_order,
      frame_id_mask: config.frame_id_mask,
      header_length: config.header_length,
      min_frame_length: config.min_frame_length,
      fields: config.fields,
      checksum: checksum && {
        algorithm: checksum.algorithm,
        startByte: checksum.start_byte,
        byteLength: checksum.byte_length,
        calcStartByte: checksum.calc_start_byte,
        calcEndByte: checksum.calc_end_byte,
        bigEndian: checksum.big_endian,
      },
    },
  };
}

/** `device_address` is the legacy default slave; a save passes the file's own through. */
export function modbusConfigOp(config: ModbusProtocolConfig): EditOp {
  return {
    op: "SetModbusConfig",
    config: {
      device_address: config.device_address,
      register_base: config.register_base,
      default_interval: config.default_interval,
      default_byte_order: config.default_byte_order,
      default_word_order: config.default_word_order,
    },
  };
}

// ============================================================================
// CAN Frames (legacy direct editor)
// ============================================================================

export interface UpsertCanFrameParams {
  oldId?: string | null;
  id: string;
  length: number;
  transmitter?: string;
  interval?: number;
  isLengthInherited?: boolean;
  isTransmitterInherited?: boolean;
  isIntervalInherited?: boolean;
  notes?: string | string[];
}

/** Collapse a single-element notes array to a plain string (tidier TOML). */
function normalizeNotes(notes: string | string[] | undefined): string | string[] | undefined {
  if (Array.isArray(notes)) {
    if (notes.length === 0) return undefined;
    if (notes.length === 1) return notes[0];
  }
  return notes || undefined;
}

export function upsertCanFrameToml(toml: string, p: UpsertCanFrameParams): Promise<string> {
  const value: Record<string, unknown> = compact({
    length: p.isLengthInherited ? undefined : p.length,
    notes: normalizeNotes(p.notes),
    transmitter: p.transmitter && !p.isTransmitterInherited ? p.transmitter : undefined,
    tx: p.interval !== undefined && !p.isIntervalInherited ? { interval_ms: p.interval } : undefined,
  });
  return editCatalog(toml, {
    op: "UpsertFrame",
    protocol: "can",
    key: p.id,
    value,
    managed_keys: ["length", "notes", "transmitter", "tx"],
    rename_from: p.oldId ?? undefined,
  });
}

export function deleteCanFrameToml(toml: string, id: string): Promise<string> {
  return editCatalog(toml, { op: "DeleteAtPath", path: ["frame", "can", id] });
}

// ============================================================================
// Generic Frames (CAN/Modbus/Serial via the protocol registry)
// ============================================================================

export interface UpsertFrameParams {
  protocol: ProtocolType;
  base: BaseFrameFields;
  config: ProtocolConfig;
  key?: string;
  originalKey?: string;
  omitInherited?: {
    length?: boolean;
    transmitter?: boolean;
    interval?: boolean;
    registerBase?: boolean;
  };
  initialSignals?: Array<{
    name: string;
    start_bit: number;
    bit_length: number;
    signed?: boolean;
    endianness?: "little" | "big";
  }>;
}

export function upsertFrameToml(toml: string, params: UpsertFrameParams): Promise<string> {
  const { protocol, base, config, key, originalKey, omitInherited, initialSignals } = params;
  const handler = protocolRegistry.get(protocol);
  if (!handler) throw new Error(`Unknown protocol: ${protocol}`);

  const frameKey = (key?.trim() || handler.getFrameKey(config));
  // The handler decides which scalar fields to write; strip sub-tables so the
  // Rust merge preserves any existing signals/mux/checksum on the frame.
  const serialized = handler.serializeFrame(frameKey, base, config, omitInherited);
  const value: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(serialized)) {
    if (k === "signals" || k === "mux" || k === "checksum") continue;
    if (v !== undefined) value[k] = v;
  }

  return editCatalog(toml, {
    op: "UpsertFrame",
    protocol,
    key: frameKey,
    value,
    managed_keys: [], // merge-only (matches the previous Object.assign semantics)
    rename_from: originalKey ?? undefined,
    initial_signals: initialSignals ?? [],
  });
}

export function deleteFrameToml(toml: string, protocol: ProtocolType, key: string): Promise<string> {
  return editCatalog(toml, { op: "DeleteAtPath", path: ["frame", protocol, key] });
}

/** Existing frame keys for a protocol (duplicate detection; read-only). */
export function getFrameKeys(toml: string, protocol: ProtocolType): string[] {
  const parsed = tomlParse(toml) as any;
  const section = parsed?.frame?.[protocol];
  return section && typeof section === "object" ? Object.keys(section) : [];
}

export function deleteModbusFrameToml(toml: string, key: string): Promise<string> {
  return deleteFrameToml(toml, "modbus", key);
}

export interface UpsertSerialFrameParams {
  oldKey?: string | null;
  frameId: string;
  length?: number;
  delimiter?: number[];
  transmitter?: string;
  interval?: number;
  notes?: string | string[];
  isIntervalInherited?: boolean;
}

export function upsertSerialFrameToml(toml: string, p: UpsertSerialFrameParams): Promise<string> {
  const base: BaseFrameFields = { length: p.length ?? 0, transmitter: p.transmitter, interval: p.interval, notes: p.notes };
  const config: SerialConfig = { protocol: "serial", frame_id: p.frameId, delimiter: p.delimiter };
  return upsertFrameToml(toml, {
    protocol: "serial",
    base,
    config,
    originalKey: p.oldKey ?? undefined,
    omitInherited: { interval: p.isIntervalInherited },
  });
}

export function deleteSerialFrameToml(toml: string, key: string): Promise<string> {
  return deleteFrameToml(toml, "serial", key);
}

// ============================================================================
// Signals
// ============================================================================

export interface SignalData {
  name: string;
  start_bit: number;
  bit_length: number;
  factor?: number;
  offset?: number;
  unit?: string;
  signed?: boolean;
  endianness?: "little" | "big";
  min?: number;
  max?: number;
  format?: string;
  confidence?: string;
  enum?: Record<string, string>;
  display?: DisplayHint;
  notes?: string;
}

export function upsertSignalToml(toml: string, targetPath: string[], signal: SignalData, index: number | null): Promise<string> {
  const { ownerPath, index: idx } = normalizeSignalTarget(targetPath, index);
  const { endianness, confidence, notes, ...fields } = signal;
  return editCatalogOps(toml, [
    {
      op: "UpsertSignal",
      owner_path: ownerPath,
      index: idx ?? undefined,
      signal: {
        ...fields,
        byte_order: endianness,
        confidence: (confidence || undefined) as Confidence | undefined,
        notes: notes ? [notes] : undefined,
      },
    },
  ]);
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

export interface MuxData {
  name: string;
  start_bit: number;
  bit_length: number;
  notes?: string;
}

export function upsertMuxToml(toml: string, muxOwnerPath: string[], mux: MuxData): Promise<string> {
  return editCatalogOps(toml, [
    { op: "SetMux", owner_path: muxOwnerPath, mux: { ...mux, notes: mux.notes ? [mux.notes] : undefined } },
  ]);
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
