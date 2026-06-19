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

// ── Granular, save-time form validation (single source of truth in the crate) ──
// Each returns the findings array (empty = valid); the edit handlers block save
// when non-empty, exactly as the former TS validators did.

/** Validate `[meta]` fields. `meta` = `{ name, version }`. */
export async function validateMetaWs(meta: { name: string; version: number }): Promise<ValidationError[]> {
  return (await wsTransport.command<ValidationResult>("catalog.validateMeta", meta)).errors;
}

/** Validate a frame's identity + common + protocol-config fields. */
export interface FrameValidationInput {
  protocol: "can" | "modbus" | "serial";
  /** CAN id, serial frame_id, or the Modbus table key. */
  key: string;
  length?: number;
  transmitter?: string;
  interval?: number;
  maxLength?: number;
  extended?: boolean;
  registerNumber?: number | null;
  /** The device (slave) address a register is read from (matched to a node). */
  nodeAddress?: number;
  registerType?: string;
  registerBase?: number;
  delimiter?: number[];
  existingKeys?: string[];
  originalKey?: string;
  availablePeers?: string[];
}
export async function validateFrameWs(input: FrameValidationInput): Promise<ValidationError[]> {
  return (await wsTransport.command<ValidationResult>("catalog.validateFrame", input)).errors;
}

/** Validate signal form fields (snake_case keys, matching the editor form). */
export async function validateSignalWs(signal: object): Promise<ValidationError[]> {
  return (await wsTransport.command<ValidationResult>("catalog.validateSignal", signal)).errors;
}

/** Validate checksum form fields (snake_case keys; optional `frame_length`, default 256). */
export async function validateChecksumWs(checksum: object): Promise<ValidationError[]> {
  return (await wsTransport.command<ValidationResult>("catalog.validateChecksum", checksum)).errors;
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

/** Result of {@link migrateCatalog}: whether the text was upgraded, the upgraded
 * TOML (equal to the input when unchanged), and a human-readable summary. */
export interface CatalogMigration {
  changed: boolean;
  toml: string;
  summary: string[];
}

/**
 * Upgrade a catalogue's text to the current schema in Rust (comment-preserving).
 * The editor loads the result as the working buffer while keeping the on-disk
 * text as the diff baseline, so a previously silent in-memory migration surfaces
 * as a real, saveable diff.
 */
export async function migrateCatalog(content: string): Promise<CatalogMigration> {
  return await wsTransport.command<CatalogMigration>("catalog.migrate", { content });
}

/** A Modbus poll group sent to the Rust reader as JSON (mirrors the backend
 *  `PollGroup`). Built in Rust from the catalogue's `[frame.modbus.*]` entries. */
export interface ModbusPollGroup {
  register_type: "holding" | "input" | "coil" | "discrete";
  /** Protocol-level start address (0-based, 0-65535). */
  start_register: number;
  /** Number of registers (or coils) to read. */
  count: number;
  /** Poll interval in milliseconds. */
  interval_ms: number;
  /** frame_id to emit (= catalog register_number). */
  frame_id: number;
  /** Device (slave) address to poll — resolved from the register's slave node. */
  device_address: number;
}

/**
 * Build Modbus poll groups from catalogue TOML in Rust (the single source of
 * truth for the catalogue → polls mapping, shared with the MCP/headless open
 * flow). Empty for a non-Modbus catalogue.
 */
export async function catalogPolls(content: string): Promise<ModbusPollGroup[]> {
  return await wsTransport.command<ModbusPollGroup[]>("catalog.polls", { content });
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
 * List all catalogs in the decoder directory.
 *
 * The directory is resolved in Rust (from settings), so callers must NOT gate
 * this on having a decoder dir — it works before settings resolve. Gating on it
 * left the catalog list empty when settings loaded late at startup.
 */
export async function listCatalogs(): Promise<CatalogMetadata[]> {
  return await invoke<CatalogMetadata[]>("list_catalogs");
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

