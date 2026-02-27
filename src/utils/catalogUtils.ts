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
