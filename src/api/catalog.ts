// ui/src/api/catalog.ts
// Catalog-related Tauri commands

import { invoke } from "@tauri-apps/api/core";

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

/**
 * Validate catalog TOML syntax and structure
 */
export async function validateCatalog(content: string): Promise<ValidationResult> {
  return await invoke("validate_catalog", { content });
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
 * Import a DBC file and convert to TOML catalog format
 * @param content - Raw DBC file content
 * @returns TOML catalog content string
 */
export async function importDbc(content: string): Promise<string> {
  return await invoke<string>("import_dbc", { content });
}

/**
 * DBC multiplexing export mode
 * - "extended": Uses SG_MUL_VAL_ with proper mNM notation for nested mux (default)
 * - "flattened": Legacy mode that flattens nested mux into composite values
 */
export type DbcMuxMode = "extended" | "flattened";

/**
 * Export catalog to a file in specified format
 * @param path - Destination file path
 * @param content - TOML catalog content
 * @param format - Export format: "toml" or "dbc"
 * @param muxMode - For DBC export: "extended" (default) or "flattened"
 */
export async function exportCatalog(
  path: string,
  content: string,
  format: "toml" | "dbc",
  muxMode?: DbcMuxMode
): Promise<void> {
  await invoke("export_catalog", { path, content, format, muxMode });
}
