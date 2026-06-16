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

// ── Canonical catalogue API over the binary WebSocket (wiretap-catalog crate) ──
// These route to the `catalog.*` command surface in src-tauri (dispatch_catalog_command);
// the live decode they enable is pushed as DecodedSignals.

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
 * Apply one comment-/formatting-preserving edit in Rust (the `wiretap-catalog`
 * crate, via `toml_edit`) and return the new TOML. `op` is an `EditOp` payload
 * (see editorOps.ts); only the targeted entry changes, comments survive.
 */
export async function editCatalog(content: string, op: Record<string, unknown>): Promise<string> {
  return await wsTransport.command<string>("catalog.edit", { content, ...op });
}

/** One line of a {@link CatalogDiff}. */
export interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Result of {@link diffCatalog}: a dirty flag plus the unified line diff. */
export interface CatalogDiff {
  dirty: boolean;
  lines: DiffLine[];
}

/**
 * Diff the working buffer against the last-saved baseline in Rust. Drives both
 * the unsaved-changes indicator and the Text-mode diff view from one source.
 */
export async function diffCatalog(current: string, baseline: string): Promise<CatalogDiff> {
  return await wsTransport.command<CatalogDiff>("catalog.diff", { current, baseline });
}

/**
 * Attach a catalogue to a session so the backend decodes its frames in Rust and
 * streams them as `DecodedSignals` (consumed by Decoder/Dashboard/Modbus). Returns
 * the number of frames bound.
 */
export async function attachCatalog(
  sessionId: string,
  content: string,
): Promise<{ attached: boolean; frames: number; catalog: Catalog }> {
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

