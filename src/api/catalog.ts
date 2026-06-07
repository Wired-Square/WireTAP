// ui/src/api/catalog.ts
// Catalog-related Tauri commands

import { invoke } from "@tauri-apps/api/core";
import { wsTransport } from "../services/wsTransport";
import type { Catalog } from "../types/catalogModel";

export interface CatalogMetadata {
  name: string;
  filename: string;
  path: string;
}

/**
 * Open a catalog file at the given path
 */
export async function openCatalog(path: string): Promise<string> {
  return await invoke<string>("open_catalog", { path });
}

/**
 * Save catalog content to a file
 */
export async function saveCatalog(path: string, content: string): Promise<void> {
  await invoke("save_catalog", { path, content });
}

/**
 * Validation error from the backend
 */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validation result from the backend
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ── Modbus catalogue parsing (via the shared wiretap-catalog Rust crate) ──
// Field names match the crate's serde output; Option fields serialise as null.

export type ModbusEndianness = "big" | "little";
export type ModbusSignalFormat = "ascii" | "utf8" | "hex" | "enum" | "unix_time" | "other";

export interface ModbusManifestSignal {
  name: string;
  start_bit: number;
  bit_length: number;
  factor?: number | null;
  offset?: number | null;
  unit?: string | null;
  signed: boolean;
  format?: ModbusSignalFormat | null;
  /** Byte order (the crate's field; maps to the frontend's `endianness`). */
  byte_order?: ModbusEndianness | null;
  word_order?: ModbusEndianness | null;
  /** Value→label map (the crate serialises `enum_map` as `enum`). */
  enum?: Record<string, string> | null;
}

export interface ModbusManifestFrame {
  name: string;
  register_number: number;
  register_type: "input" | "holding" | "coil" | "discrete";
  /** Register count (not bytes). */
  length: number;
  interval_ms: number;
  disabled: boolean;
  signals: ModbusManifestSignal[];
}

export interface ModbusManifestMeta {
  device_address: number;
  register_base: number;
  default_interval?: number | null;
  default_byte_order?: ModbusEndianness | null;
  default_word_order?: ModbusEndianness | null;
}

export interface ModbusManifest {
  meta: ModbusManifestMeta;
  frames: ModbusManifestFrame[];
}

/**
 * Parse a Modbus catalogue via the shared `wiretap-catalog` crate. The two
 * authoring shorthands — register-from-key (`[frame.modbus.0x32F9]`) and
 * signal-less register (frame-level `format`/`factor`/…) — are resolved in
 * Rust, so frames arrive with explicit register numbers and synthesised signals.
 */
export async function parseModbusCatalog(content: string): Promise<ModbusManifest> {
  return await invoke<ModbusManifest>("parse_modbus_catalog", { content });
}

// ── Canonical catalogue API over the binary WebSocket (wiretap-catalog crate) ──
// These route to the `catalog.*` command surface in src-tauri (dispatch_catalog_command).
// They supersede the per-protocol TS parser/validator and the invoke-based DBC
// commands above; the live decode they enable is pushed as DecodedSignals.

/**
 * Parse any-protocol catalogue TOML into the resolved {@link Catalog} model
 * (CAN/Serial/Modbus; shorthands + mirror/copy inheritance resolved in Rust).
 */
export async function parseCatalog(content: string): Promise<Catalog> {
  return await wsTransport.command<Catalog>("catalog.parse", { content });
}

/** Validate catalogue TOML, returning field-path + message findings. */
export async function validateCatalogWs(content: string): Promise<ValidationResult> {
  return await wsTransport.command<ValidationResult>("catalog.validate", { content });
}

/**
 * Attach a catalogue to a session so the backend decodes its frames in Rust and
 * streams them as `DecodedSignals` (consumed by Decoder/Graph/Modbus). Returns
 * the number of frames bound.
 */
export async function attachCatalog(
  sessionId: string,
  content: string,
): Promise<{ attached: boolean; frames: number }> {
  return await wsTransport.command("catalog.attach", { session_id: sessionId, content });
}

/** Detach a session's catalogue (the decoded stream stops). */
export async function detachCatalog(sessionId: string): Promise<void> {
  await wsTransport.command("catalog.detach", { session_id: sessionId });
}

/** Import a DBC file to catalogue TOML via the crate (over the WebSocket). */
export async function importDbcWs(content: string): Promise<string> {
  return await wsTransport.command<string>("catalog.import_dbc", { content });
}

/** Export catalogue TOML to DBC text via the crate (over the WebSocket). */
export async function exportDbcWs(
  content: string,
  receiver = "WireTAP",
  muxMode: DbcMuxMode = "extended",
): Promise<string> {
  return await wsTransport.command<string>("catalog.export_dbc", { content, receiver, muxMode });
}

/**
 * Test decode a frame using catalog definitions
 */
export async function testDecodeFrame(
  catalog: string,
  frameId: number,
  data: number[]
): Promise<{ signals: Array<{ name: string; value: string; unit?: string }> }> {
  return await invoke("test_decode_frame", { catalog, frameId, data });
}

/**
 * List all catalogs in the decoder directory
 */
export async function listCatalogs(decoderDir: string): Promise<CatalogMetadata[]> {
  return await invoke<CatalogMetadata[]>("list_catalogs", { decoderDir });
}

/**
 * Duplicate a catalog with a new name
 */
export async function duplicateCatalog(sourcePath: string, newName: string, newFilename: string): Promise<void> {
  await invoke("duplicate_catalog", {
    sourcePath,
    newName,
    newFilename,
  });
}

/**
 * Rename a catalog
 */
export async function renameCatalog(oldPath: string, newName: string, newFilename: string): Promise<void> {
  await invoke("rename_catalog", {
    oldPath,
    newName,
    newFilename,
  });
}

/**
 * Delete a catalog file
 */
export async function deleteCatalog(path: string): Promise<void> {
  await invoke("delete_catalog", { path });
}

/**
 * Write raw bytes to a file (used for image export)
 */
export async function saveBinaryFile(path: string, data: number[]): Promise<void> {
  await invoke("save_binary_file", { path, data });
}

/**
 * DBC multiplexing export mode
 * - "extended": Uses SG_MUL_VAL_ with proper mNM notation for nested mux (default)
 * - "flattened": Legacy mode that flattens nested mux into composite values
 */
export type DbcMuxMode = "extended" | "flattened";

