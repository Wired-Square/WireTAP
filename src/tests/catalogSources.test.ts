import { describe, it, expect } from "vitest";

import { joinCatalogSources } from "../hooks/useCatalogSources";
import type { CatalogMetadata } from "../api/catalog";
import type { TrackedCatalog } from "../api/catalogShare";

// The join was one-to-one, and one catalogue can now be tracked against several
// repositories — so a `Map` of single values kept whichever row came last and showed
// a decoder living in one repository picked at random.

const catalog = (filename: string): CatalogMetadata => ({
  name: filename.replace(/\.toml$/, ""),
  filename,
  path: `/decoders/${filename}`,
  syncStatus: "localAhead",
  trackedRepoCount: 0,
});

const source = (localFilename: string, repoId: string): TrackedCatalog => ({
  id: `cs_${repoId}_${localFilename}`,
  localFilename,
  repoId,
  repoLabel: repoId.replace(/^gh:/, ""),
  remotePath: `catalogs/${localFilename}`,
  gitRef: "main",
  syncStatus: "inSync",
  prMerged: false,
});

describe("joining catalogues with their provenance", () => {
  it("keeps every repository a catalogue is tracked against", () => {
    const joined = joinCatalogSources(
      [catalog("sbrxxx.toml")],
      [source("sbrxxx.toml", "gh:owner/repo"), source("sbrxxx.toml", "gh:other/fork")],
    );
    expect(joined[0].sources.map((s) => s.repoId)).toEqual([
      "gh:owner/repo",
      "gh:other/fork",
    ]);
  });

  it("folds case, because the registry's own key does", () => {
    const joined = joinCatalogSources(
      [catalog("Sbrxxx.toml")],
      [source("sbrxxx.toml", "gh:owner/repo")],
    );
    expect(joined[0].sources).toHaveLength(1);
  });

  it("gives a purely local catalogue an empty list, not undefined", () => {
    const joined = joinCatalogSources([catalog("local.toml")], []);
    expect(joined[0].sources).toEqual([]);
  });

  it("does not invent rows for provenance whose file is not in the list", () => {
    // A tracked file that is gone reports `missing` in Settings, but the picker walks
    // the directory — it cannot show a row for a file it never saw.
    const joined = joinCatalogSources([catalog("here.toml")], [source("gone.toml", "gh:o/r")]);
    expect(joined).toHaveLength(1);
    expect(joined[0].sources).toEqual([]);
  });
});
