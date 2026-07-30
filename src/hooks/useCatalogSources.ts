// Shared hook: the catalogue list joined with its Git provenance.
//
// Two independent facts about the same directory, from two owners:
//
//   * the catalogue list — backend-owned, warm-cached, pushed on
//     `CatalogListChanged` (see useCatalogList)
//   * the provenance/sync state — the sharing registry, fetched on demand
//
// Reconciling both off the *same* signal is what stops them disagreeing. Before
// this hook, Settings refreshed the two separately, so a catalogue imported from
// Settings appeared with no provenance badge until the panel remounted.
//
// The join is by filename because that is the registry's key — see
// `catalog_share/registry.rs` on why it is not an absolute path.

import { useMemo } from "react";
import { useCatalogList } from "./useCatalogList";
import { useWsResync } from "./useWsResync";
import { MsgType } from "../services/wsProtocol";
import type { CatalogMetadata } from "../api/catalog";
import type { TrackedCatalog } from "../api/catalogShare";
import { useCatalogShareStore } from "../stores/catalogShareStore";

export type CatalogWithSource = CatalogMetadata & {
  /** Present when this catalogue came from, or is published to, a repository. */
  source?: TrackedCatalog;
};

export function useCatalogSources(): CatalogWithSource[] {
  const catalogs = useCatalogList();
  const tracked = useCatalogShareStore((s) => s.tracked);
  const loadSources = useCatalogShareStore((s) => s.loadSources);

  // Literally the same trigger the list reconciles on, so the two cannot drift.
  useWsResync(MsgType.CatalogListChanged, loadSources);

  return useMemo(() => {
    const byName = new Map(tracked.map((tc) => [tc.localFilename.toLowerCase(), tc]));
    return catalogs.map((catalog) => {
      const source = byName.get(catalog.filename.toLowerCase());
      return source ? { ...catalog, source } : catalog;
    });
  }, [catalogs, tracked]);
}
