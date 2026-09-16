// ui/src/apps/catalog/io.ts

import { openCatalog, saveCatalog, pickCatalogToOpen as pickCatalogToOpenApi, pickCatalogToSave } from "../../api";
import { migrateCatalog, type CatalogMigration } from "../../api/catalog";
import { tlog } from "../../api/settings";
import type { AppSettings } from "../../hooks/useSettings";

// Re-export AppSettings for backward compatibility
export type Settings = AppSettings;

export async function openCatalogAtPath(path: string): Promise<string> {
  return await openCatalog(path);
}

/**
 * Read a catalogue from disk and run any schema migration in Rust. Returns the
 * on-disk `original` (the diff baseline) alongside the migration result. The
 * caller loads `migration.toml` as the working buffer when `migration.changed`,
 * so a previously silent in-memory upgrade surfaces as a saveable diff. The
 * migration is best-effort: a backend hiccup falls back to opening the file as-is.
 */
export async function openCatalogWithMigration(
  path: string,
): Promise<{ original: string; migration: CatalogMigration }> {
  const original = await openCatalog(path);
  try {
    return { original, migration: await migrateCatalog(original) };
  } catch (e) {
    tlog.info(`[catalog] migration check failed, opening as-is: ${e}`);
    return { original, migration: { changed: false, toml: original, summary: [] } };
  }
}

export async function saveCatalogAtPath(path: string, content: string): Promise<void> {
  await saveCatalog(path, content);
}

export async function pickCatalogToOpen(defaultDir?: string): Promise<string | null> {
  return await pickCatalogToOpenApi(defaultDir);
}

export async function pickCatalogSavePath(defaultPath?: string): Promise<string | null> {
  return await pickCatalogToSave(defaultPath);
}
