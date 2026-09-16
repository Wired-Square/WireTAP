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

export type CatalogWithSources = CatalogMetadata & {
  /**
   * Every repository this catalogue came from or is published to — one row per
   * subscription, empty for a purely local file.
   *
   * Plural because a decoder can legitimately live in several: your fork and the
   * upstream it came from, or two collections that both want it. `catalog.syncStatus`
   * is the fold across these, computed in Rust.
   */
  sources: TrackedCatalog[];
};

/**
 * The case fold, with one owner on this side of the wire.
 *
 * Mirrors Rust's `filename_key`, whose own comment is that a second spelling drifts
 * the moment either learns anything — and a drifted key silently reverts a badge to
 * `localOnly`, which reads as a plausible local file rather than as a fault.
 */
const filenameKey = (filename: string) => filename.toLowerCase();

/** Every repository tracking one file — for a surface that has only that file. */
export function sourcesFor(
  tracked: TrackedCatalog[],
  filename: string | null | undefined,
): TrackedCatalog[] {
  if (!filename) return [];
  const key = filenameKey(filename);
  return tracked.filter((tc) => filenameKey(tc.localFilename) === key);
}

/**
 * The whole list joined with its provenance, pure so it can be tested without a
 * renderer. Grouped in one pass rather than `sourcesFor` per row, which would be
 * quadratic over a directory.
 *
 * Grouped rather than keyed one-to-one: with several subscriptions per file a `Map`
 * of single values keeps whichever came last, which reads as a catalogue that lives
 * in one repository chosen at random.
 */
export function joinCatalogSources(
  catalogs: CatalogMetadata[],
  tracked: TrackedCatalog[],
): CatalogWithSources[] {
  const byName = new Map<string, TrackedCatalog[]>();
  for (const tc of tracked) {
    const key = filenameKey(tc.localFilename);
    const group = byName.get(key);
    if (group) group.push(tc);
    else byName.set(key, [tc]);
  }
  return catalogs.map((catalog) => ({
    ...catalog,
    sources: byName.get(filenameKey(catalog.filename)) ?? [],
  }));
}

export function useCatalogSources(): CatalogWithSources[] {
  const catalogs = useCatalogList();
  const tracked = useCatalogShareStore((s) => s.tracked);
  const loadSources = useCatalogShareStore((s) => s.loadSources);

  // Literally the same trigger the list reconciles on, so the two cannot drift.
  useWsResync(MsgType.CatalogListChanged, loadSources);

  return useMemo(() => joinCatalogSources(catalogs, tracked), [catalogs, tracked]);
}
