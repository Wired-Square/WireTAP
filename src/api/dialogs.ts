// ui/src/api/dialogs.ts
// File dialog utilities using Tauri dialog plugin

import { open, save } from "@tauri-apps/plugin-dialog";

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  defaultPath?: string;
  filters?: DialogFilter[];
  directory?: boolean;
  multiple?: boolean;
}

export interface SaveDialogOptions {
  defaultPath?: string;
  filters?: DialogFilter[];
}

/**
 * Open a file picker dialog
 * @returns Selected file path or null if cancelled
 */
export async function pickFileToOpen(options: OpenDialogOptions = {}): Promise<string | null> {
  const selected = await open({
    directory: options.directory ?? false,
    multiple: options.multiple ?? false,
    defaultPath: options.defaultPath,
    filters: options.filters,
  });

  return selected && typeof selected === "string" ? selected : null;
}

/**
 * Open a directory picker dialog
 * @returns Selected directory path or null if cancelled
 */
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  return pickFileToOpen({ directory: true, defaultPath });
}

/**
 * Open a save file dialog
 * @returns Selected save path or null if cancelled
 */
export async function pickFileToSave(options: SaveDialogOptions = {}): Promise<string | null> {
  const selected = await save({
    defaultPath: options.defaultPath,
    filters: options.filters,
  });

  if (!selected) return null;

  let path = String(selected);

  // macOS save dialog sometimes appends wrong extensions (e.g., .txt instead of .html)
  // If a filter is provided, ensure the path has the correct extension
  if (options.filters && options.filters.length > 0) {
    const expectedExtensions = options.filters[0].extensions;
    const hasValidExtension = expectedExtensions.some(ext =>
      path.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
    );

    if (!hasValidExtension && expectedExtensions.length > 0) {
      // Strip any incorrect extension that was appended (e.g., .txt)
      // This handles cases like "report.html.txt" -> "report.html"
      const incorrectExtMatch = path.match(/^(.+\.[a-zA-Z0-9]+)\.[a-zA-Z0-9]+$/);
      if (incorrectExtMatch) {
        const baseWithCorrectExt = incorrectExtMatch[1];
        // Check if the base already has the correct extension
        const baseHasValidExt = expectedExtensions.some(ext =>
          baseWithCorrectExt.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
        );
        if (baseHasValidExt) {
          path = baseWithCorrectExt;
        } else {
          // Just append the correct extension
          path = `${path.replace(/\.[^/.]+$/, '')}.${expectedExtensions[0]}`;
        }
      } else {
        // No extension or single extension - append the correct one
        path = `${path}.${expectedExtensions[0]}`;
      }
    }
  }

  return path;
}

/**
 * Common dialog filters for catalog files
 */
export const CATALOG_FILTERS: DialogFilter[] = [
  {
    name: "TOML Catalog Files",
    extensions: ["toml"],
  },
];

/**
 * Dialog filter for DBC files
 */
export const DBC_FILTERS: DialogFilter[] = [
  {
    name: "DBC Files",
    extensions: ["dbc"],
  },
];

/**
 * Dialog filter for HTML files
 */
export const HTML_FILTERS: DialogFilter[] = [
  {
    name: "HTML Files",
    extensions: ["html", "htm"],
  },
];

/**
 * Dialog filter for Markdown files
 */
export const MARKDOWN_FILTERS: DialogFilter[] = [
  {
    name: "Markdown Files",
    extensions: ["md"],
  },
];

/**
 * Dialog filter for Text files
 */
export const TEXT_FILTERS: DialogFilter[] = [
  {
    name: "Text Files",
    extensions: ["txt"],
  },
];

/**
 * Dialog filter for JSON files
 */
export const JSON_FILTERS: DialogFilter[] = [
  {
    name: "JSON Files",
    extensions: ["json"],
  },
];

/**
 * Dialog filter for data files (CSV, CAN dump, log)
 */
export const CSV_FILTERS: DialogFilter[] = [
  {
    name: "Data Files (CSV, CAN Dump)",
    extensions: ["csv", "log", "dump"],
  },
];

/**
 * Dialog filter for PNG image files
 */
export const PNG_FILTERS: DialogFilter[] = [
  {
    name: "PNG Images",
    extensions: ["png"],
  },
];

/**
 * Dialog filter for SVG image files
 */
export const SVG_FILTERS: DialogFilter[] = [
  {
    name: "SVG Images",
    extensions: ["svg"],
  },
];

/**
 * Pick a catalog file to open
 */
export async function pickCatalogToOpen(defaultDir?: string): Promise<string | null> {
  return pickFileToOpen({
    directory: false,
    multiple: false,
    defaultPath: defaultDir,
    filters: CATALOG_FILTERS,
  });
}

/**
 * Pick a catalog file save location
 */
export async function pickCatalogToSave(defaultPath?: string): Promise<string | null> {
  return pickFileToSave({
    defaultPath,
    filters: CATALOG_FILTERS,
  });
}

/**
 * Pick a CSV file to open (GVRET/SavvyCAN format)
 */
export async function pickCsvToOpen(defaultDir?: string): Promise<string | null> {
  return pickFileToOpen({
    directory: false,
    multiple: false,
    defaultPath: defaultDir,
    filters: CSV_FILTERS,
  });
}

/**
 * Pick one or more CSV/data files to open.
 * Returns an array of file paths, or null if cancelled.
 */
export async function pickCsvFilesToOpen(defaultDir?: string): Promise<string[] | null> {
  const selected = await open({
    directory: false,
    multiple: true,
    defaultPath: defaultDir,
    filters: CSV_FILTERS,
  });

  if (!selected) return null;
  if (typeof selected === "string") return [selected];
  return selected.length > 0 ? selected : null;
}
