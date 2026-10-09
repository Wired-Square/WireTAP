// ui/src/apps/catalog/model.ts
//
// Lookups into the served `Catalog` by the editor's tree paths. A frame is
// identified by its protocol and key, never its bare id.

import type { Catalog, Endianness, Frame, Protocol } from "../../types/catalogModel";
import { frameByKey } from "../../utils/catalogFrames";
import type { ProtocolType } from "./types";

/** The frame a path `["frame", protocol, key, …]` lies in. */
export function frameAt(catalog: Catalog | null, path: readonly string[]): Frame | undefined {
  const [section, protocol, key] = path;
  return section === "frame" ? frameByKey(catalog, protocol as Protocol, key) : undefined;
}

export function hasFrames(catalog: Catalog | null, protocol: ProtocolType): boolean {
  return catalog?.frames.some((f) => f.protocol === protocol) ?? false;
}

/** The byte order a signal of `protocol` decodes with when it states none. */
export function defaultByteOrder(catalog: Catalog | null, protocol: string): Endianness | undefined {
  const defaults = catalog?.effectiveDefaults;
  if (!defaults) return undefined;
  return protocol === "can" ? defaults.canByteOrder : protocol === "serial" ? defaults.serialByteOrder : defaults.modbusByteOrder;
}
