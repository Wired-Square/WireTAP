// ui/src/utils/catalogMeta.ts

export type CatalogMeta = {
  name?: string;
  version?: number;
  default_byte_order?: "little" | "big";
  default_frame?: string;
  default_interval?: number;
};

/**
 * Normalize meta values with sane defaults for export/serialization.
 */
export function normalizeMeta(meta: CatalogMeta): Required<CatalogMeta> {
  return {
    name: meta.name || "Untitled",
    version: typeof meta.version === "number" && meta.version > 0 ? meta.version : 1,
    default_byte_order: meta.default_byte_order === "big" ? "big" : "little",
    default_frame: meta.default_frame || "can",
    default_interval: typeof meta.default_interval === "number" && meta.default_interval >= 0 ? meta.default_interval : 0,
  };
}
