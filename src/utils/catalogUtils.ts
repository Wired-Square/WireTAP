import type { CatalogMetadata } from "../api/catalog";

/** Normalise path separators for cross-platform comparison (Windows uses backslashes). */
export function normalisePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Find the catalogue whose path matches `catalogPath` (cross-platform comparison). */
export function findCatalogByPath(
  catalogs: CatalogMetadata[],
  catalogPath: string | null | undefined,
): CatalogMetadata | undefined {
  if (!catalogPath) return undefined;
  const target = normalisePath(catalogPath);
  return catalogs.find((c) => normalisePath(c.path) === target);
}

/**
 * Build a catalog path from decoder_dir and filename.
 * Handles both absolute paths and relative paths.
 * Used when catalogs list isn't available (e.g., decoderStore.initFromSettings).
 */
export function buildCatalogPath(
  catalog: string,
  decoderDir?: string
): string {
  // If already an absolute path, return as-is
  if (catalog.startsWith("/") || catalog.includes("\\")) {
    return catalog;
  }

  // Combine with decoder_dir
  if (decoderDir) {
    const baseDir = decoderDir.replace(/[\\/]+$/, "");
    return `${baseDir}/${catalog}`;
  }

  return catalog;
}
