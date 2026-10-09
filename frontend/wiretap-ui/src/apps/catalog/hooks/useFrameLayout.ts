// ui/src/apps/catalog/hooks/useFrameLayout.ts

import { useEffect, useState } from "react";
import { frameLayout } from "../../../api/catalog";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import type { BitRange } from "../../../components/BitPreview";
import type { FrameLayout, Protocol } from "../../../types/catalogModel";

/** The layout around the item at a tree path `["frame", protocol, key, …]`. */
export function useFrameLayout(path: readonly string[] | null): FrameLayout | null {
  const content = useCatalogEditorStore((s) => s.content.toml);
  const [layout, setLayout] = useState<FrameLayout | null>(null);
  const pathKey = path?.join("\u0000") ?? "";

  useEffect(() => {
    if (!path || path[0] !== "frame" || path.length < 3) {
      setLayout(null);
      return;
    }
    let live = true;
    frameLayout(content, path[1] as Protocol, path[2], path.slice(3))
      .then((next) => live && setLayout(next))
      .catch(() => live && setLayout(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, pathKey]);

  return layout;
}

/** BitPreview's ranges; `omitEdited` when the edited item is drawn as the current one. */
export function previewRanges(layout: FrameLayout | null, omitEdited = false): BitRange[] {
  return (layout?.ranges ?? [])
    .filter((r) => !(omitEdited && r.edited))
    .map((r) => ({
      name: r.name ?? (r.kind === "selector" ? "Mux" : r.kind === "checksum" ? "Checksum" : "Signal"),
      start_bit: r.startBit,
      bit_length: r.bitLength,
      type: r.kind === "selector" ? "mux" : "signal",
    }));
}
